import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import * as bridge from '../lib/index.mjs'
import { importSkills } from '../lib/importer.mjs'
import { lockPath, readLock, writeLock } from '../lib/lockfile.mjs'
import { createMockContext, fixtureRoot, tempDir } from './helpers/harness.mjs'
import { validate } from './helpers/schema.mjs'

function setup(t, label = 'apply') {
  const root = fixtureRoot(t, label)
  const targetDir = join(tempDir(t, label + '-target'), 'bridge')
  return { root, targetDir }
}

function imported(t, label, names = ['agent-reach-like']) {
  const { root, targetDir } = setup(t, label)
  const result = importSkills({ codexRoot: root, targetDir, names, confirm: true, dryRun: false })
  assert.equal(result.ok, true)
  return { root, targetDir }
}

test('apply：注册 6 个工具 + 锁文件里的每个技能', (t) => {
  const { root, targetDir } = imported(t, 'apply-basic', ['agent-reach-like', 'playwright-like'])
  const { ctx, tools, skills, warnings } = createMockContext()

  const summary = bridge.apply(ctx, { codexRoot: root, targetDir })

  assert.equal(tools.size, 6)
  assert.deepEqual([...tools.keys()].sort(), [...bridge.TOOL_NAMES].sort())
  assert.equal(skills.size, 2)
  assert.deepEqual(summary.skills, 2)
  assert.equal(summary.tools, 6)
  assert.deepEqual(warnings, [])

  const skill = skills.get('agent-reach-like')
  assert.equal(skill.source, 'runtime')
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.equal(skill.resourceBase.path, join(root, 'skills/agent-reach-like'))
  assert.ok(skill.content.includes('#'))
  assert.ok(skill.description.length <= 220)

  // 注入的 description 用锁文件里的压缩值，而不是上游 921 字的原文
  const entry = readLock(targetDir).lock.imports.find((item) => item.name === 'agent-reach-like')
  assert.equal(skill.description, entry.description)
})

test('apply 两次：同名不翻倍，先撤销上一轮', (t) => {
  const { root, targetDir } = imported(t, 'apply-twice')
  const { ctx, tools, skills } = createMockContext()

  bridge.apply(ctx, { codexRoot: root, targetDir })
  bridge.apply(ctx, { codexRoot: root, targetDir })

  assert.equal(tools.size, 6)
  assert.equal(skills.size, 1)
})

test('工具注册形状：output.schema + render 返回 [{type,text}]', (t) => {
  const { root, targetDir } = imported(t, 'apply-shape')
  const { ctx, tools } = createMockContext()
  bridge.apply(ctx, { codexRoot: root, targetDir })

  for (const [name, definition] of tools) {
    assert.equal(definition.name, name)
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.ok(definition.output.schema.type === 'object')
    const rendered = definition.output.render({}, { ok: true })
    assert.equal(Array.isArray(rendered), true)
    assert.equal(rendered[0].type, 'text')
    assert.equal(JSON.parse(rendered[0].text).ok, true)
  }
})

test('六个工具都能通过 mock ctx 执行', async (t) => {
  const { root, targetDir } = imported(t, 'tools-run', ['playwright-like'])
  const { ctx, tools } = createMockContext()
  bridge.apply(ctx, { codexRoot: root, targetDir })

  const scan = await tools.get('codex_scan').execute({})
  assert.equal(scan.ok, true)
  assert.ok(scan.total >= 3)
  assert.ok(Array.isArray(scan.items))
  const importedItem = scan.items.find((item) => item.name === 'playwright-like')
  assert.equal(importedItem.alreadyImported, true)
  assert.equal(importedItem.importedAs, 'playwright-like')

  const inspect = await tools.get('codex_inspect').execute({ name: 'agent-reach-like' })
  assert.equal(inspect.ok, true)
  assert.equal(inspect.name, 'agent-reach-like')
  assert.ok(inspect.willInject.length > 0)

  const dry = await tools.get('codex_import').execute({ names: ['agent-reach-like'] })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)

  const written = await tools.get('codex_import').execute({ names: ['agent-reach-like'], confirm: true })
  assert.equal(written.ok, true)
  assert.equal(written.wrote, true)

  const list = await tools.get('codex_list').execute()
  assert.equal(list.ok, true)
  assert.equal(list.total, 2)

  const doctor = await tools.get('codex_doctor').execute({})
  assert.equal(doctor.ok, true)
  assert.equal(Array.isArray(doctor.missingBinaries), true)
  assert.equal(Array.isArray(doctor.stalePaths), true)
  assert.equal(Array.isArray(doctor.overBudget), true)

  const removed = await tools.get('codex_remove').execute({ names: ['agent-reach-like'] })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.removed, ['agent-reach-like'])

  const noNames = await tools.get('codex_import').execute({ names: [] })
  assert.equal(noNames.ok, false)
  assert.equal(noNames.code, 'NO_NAMES')
})

test('工具输出不含 null（宿主 schema 只接受 string，真实踩坑回归）', async (t) => {
  const { root, targetDir } = imported(t, 'null-free', ['playwright-like'])

  function assertNoNulls(value, path = '$') {
    if (value === null) assert.fail(`${path} 不应为 null`)
    if (Array.isArray(value)) return value.forEach((item, index) => assertNoNulls(item, `${path}[${index}]`))
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) assertNoNulls(inner, `${path}.${key}`)
    }
  }

  const { ctx, tools } = createMockContext()
  bridge.apply(ctx, { codexRoot: root, targetDir })

  const scan = await tools.get('codex_scan').execute({})
  assertNoNulls(scan)
  // 独立技能没有 pluginName：字段应被省略而不是 null
  const standalone = scan.items.find((item) => item.name === 'playwright-like')
  assert.equal('pluginName' in standalone, false)
  assert.equal(standalone.alreadyImported, true)

  for (const [name, definition] of tools) {
    const args = name === 'codex_import' || name === 'codex_remove' ? { names: ['playwright-like'], dryRun: true } : {}
    const value = await definition.execute(args)
    assertNoNulls(value)
  }
})

test('全部工具的成功与失败输出都符合自己的 output.schema', async (t) => {
  const { root, targetDir } = imported(t, 'schema', ['playwright-like', 'agent-reach-like'])
  const { ctx, tools } = createMockContext()
  bridge.apply(ctx, { codexRoot: root, targetDir })

  // [工具名, 成功入参, 失败入参]
  const cases = [
    ['codex_scan', {}, { root: join(root, 'does-not-exist') }],
    ['codex_inspect', { name: 'playwright-like' }, { name: 'no-such-skill' }],
    ['codex_import', { names: ['playwright-like'] }, { names: [] }],
    ['codex_list', {}, {}],
    ['codex_remove', { names: ['nope'] }, { names: [] }],
    ['codex_doctor', {}, {}],
  ]

  for (const [name, okArgs, failArgs] of cases) {
    const definition = tools.get(name)
    const okValue = await definition.execute(okArgs)
    const okErrors = validate(okValue, definition.output.schema)
    assert.deepEqual(okErrors, [], `${name} 成功输出不符合 schema：${okErrors.join('；')}`)

    const failValue = await definition.execute(failArgs)
    const failErrors = validate(failValue, definition.output.schema)
    assert.deepEqual(failErrors, [], `${name} 失败输出不符合 schema：${failErrors.join('；')}`)
  }
})

test('上游被删：跳过并在 warnings 里说明，不阻塞启动', (t) => {
  const { root, targetDir } = imported(t, 'upstream-gone', ['agent-reach-like', 'playwright-like'])
  rmSync(join(root, 'skills/agent-reach-like'), { recursive: true, force: true })
  const { ctx, skills, warnings } = createMockContext()

  assert.doesNotThrow(() => bridge.apply(ctx, { codexRoot: root, targetDir }))
  assert.equal(skills.size, 1)
  assert.equal(warnings.some((message) => message.includes('上游')), true)
})

test('描述超预算：不注入该技能，只 warn', (t) => {
  const { root, targetDir } = imported(t, 'budget-apply')
  const { lock } = readLock(targetDir)
  lock.imports[0].description = 'y'.repeat(500)
  writeLock(targetDir, lock)
  const { ctx, skills, warnings } = createMockContext()

  bridge.apply(ctx, { codexRoot: root, targetDir })
  assert.equal(skills.size, 0)
  assert.equal(warnings.some((message) => message.includes('预算')), true)
})

test('锁文件缺失 / 服务不存在 / register 抛错：都不崩', (t) => {
  const { root, targetDir } = setup(t, 'robust')
  const empty = createMockContext()
  assert.doesNotThrow(() => bridge.apply(empty.ctx, { codexRoot: root, targetDir }))
  assert.equal(empty.skills.size, 0)
  assert.equal(empty.tools.size, 6)
  assert.equal(existsSync(lockPath(targetDir)), false, 'apply 不得创建锁文件')

  const noSkills = createMockContext({ skills: false })
  assert.doesNotThrow(() => bridge.apply(noSkills.ctx, { codexRoot: root, targetDir }))
  assert.equal(noSkills.tools.size, 6)

  const noTools = createMockContext({ tools: false })
  assert.doesNotThrow(() => bridge.apply(noTools.ctx, { codexRoot: root, targetDir }))

  const { targetDir: importedDir } = imported(t, 'robust-import')
  const throwing = createMockContext({
    onRegister() {
      throw new Error('boom')
    },
  })
  assert.doesNotThrow(() => bridge.apply(throwing.ctx, { codexRoot: root, targetDir: importedDir }))
  assert.equal(throwing.warnings.length >= 1, true)
})

test('apply 返回的 skipped 反映无法重放的条目', (t) => {
  const { root, targetDir } = imported(t, 'skipped-count', ['agent-reach-like', 'playwright-like'])
  const { lock } = readLock(targetDir)
  lock.imports.push({ ...lock.imports[0], name: 'ghost', sourcePath: join(root, 'skills/ghost') })
  writeLock(targetDir, lock)
  const { ctx } = createMockContext()
  const summary = bridge.apply(ctx, { codexRoot: root, targetDir })
  assert.equal(summary.skills, 2)
  assert.equal(summary.skipped, 1)
})

test('同一 ctx 上 dispose 事件注册不抛', (t) => {
  const { root, targetDir } = setup(t, 'dispose')
  const { ctx, handlers } = createMockContext()
  bridge.apply(ctx, { codexRoot: root, targetDir })
  assert.equal(handlers.has('dispose'), true)
  assert.doesNotThrow(() => {
    for (const handler of handlers.get('dispose')) handler()
  })
})

test('autoReplay: false —— 只注册工具，不注入锁文件里的技能', async (t) => {
  const { root, targetDir } = imported(t, 'no-replay', ['agent-reach-like'])
  const { ctx, tools, skills } = createMockContext()

  const summary = bridge.apply(ctx, { codexRoot: root, targetDir, autoReplay: false })

  assert.equal(tools.size, 6)
  assert.equal(skills.size, 0)
  assert.equal(summary.skills, 0)
  // 锁文件保持原样，工具仍能看到这条导入（关掉的是「注入」，不是「记录」）
  assert.equal(readLock(targetDir).lock.imports.length, 1)
  const list = await tools.get('codex_list').execute({})
  assert.equal(list.total, 1)
})

test('autoReplay 默认开启，显式 true 同样重放', (t) => {
  const { root, targetDir } = imported(t, 'replay-default', ['agent-reach-like'])
  const configs = [
    { codexRoot: root, targetDir },
    { codexRoot: root, targetDir, autoReplay: true },
  ]
  for (const config of configs) {
    const { ctx, skills } = createMockContext()
    const summary = bridge.apply(ctx, config)
    assert.equal(skills.size, 1)
    assert.equal(summary.skills, 1)
  }
})

test('cordis.patch.yml 指向本包且 id 正确', () => {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(text.includes('id: dsh-codex-bridge'))
  assert.ok(text.includes('name: dsh-codex-bridge'))
  assert.ok(text.includes('- insert:'))
})
