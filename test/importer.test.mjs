import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { codepointLength } from '../lib/describe.mjs'
import {
  importSkills,
  inspectEntry,
  listImports,
  normalizeSkillName,
  removeSkills,
  resolveTargetName,
} from '../lib/importer.mjs'
import { lockPath, readLock } from '../lib/lockfile.mjs'
import { fixtureRoot, tempDir } from './helpers/harness.mjs'

function setup(t, label = 'import') {
  const root = fixtureRoot(t, label)
  const targetDir = join(tempDir(t, label + '-target'), 'bridge')
  return { root, targetDir }
}

test('normalizeSkillName：lower + kebab，去掉非法字符', () => {
  assert.equal(normalizeSkillName('Presentations'), 'presentations')
  assert.equal(normalizeSkillName('Agent_Reach!!'), 'agent-reach')
  assert.equal(normalizeSkillName('a---b'), 'a-b')
  assert.equal(normalizeSkillName('---'), 'codex-skill')
  assert.equal(normalizeSkillName(''), 'codex-skill')
  assert.equal(normalizeSkillName('中文名'), 'codex-skill')
})

test('resolveTargetName：prefix / skip / overwrite', () => {
  const taken = new Set(['dup'])
  assert.deepEqual(resolveTargetName('dup', taken, 'prefix'), { name: 'codex-dup', action: 'create' })
  assert.deepEqual(resolveTargetName('dup', taken, 'skip'), { name: 'dup', action: 'skip' })
  assert.deepEqual(resolveTargetName('dup', taken, 'overwrite'), { name: 'dup', action: 'overwrite' })
  assert.deepEqual(resolveTargetName('fresh', taken, 'prefix'), { name: 'fresh', action: 'create' })
  const twice = new Set(['dup', 'codex-dup'])
  assert.equal(resolveTargetName('dup', twice, 'prefix').name, 'codex-dup-2')
})

test('dryRun：只返回计划，目标目录完全不存在', (t) => {
  const { root, targetDir } = setup(t, 'dry')
  const result = importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.data.dryRun, true)
  assert.equal(result.data.wrote, false)
  assert.equal(existsSync(targetDir), false, 'dry-run 不应创建目标目录')
  const plan = result.data.planned[0]
  assert.equal(plan.willImport, true)
  assert.equal(plan.name, 'playwright-like')
  assert.equal(plan.action, 'create')
  assert.ok(codepointLength(plan.description) <= 220)
  assert.ok(plan.files.includes('SKILL.md'))
  assert.ok(codepointLength(plan.longDescription) > codepointLength(plan.description))
})

test('reference 模式：不复制文件，锁文件记录 1 条', (t) => {
  const { root, targetDir } = setup(t, 'ref')
  const result = importSkills({
    codexRoot: root,
    targetDir,
    names: ['playwright-like', 'agent-reach-like'],
    confirm: true,
    dryRun: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.wrote, true)

  const { lock, problems } = readLock(targetDir)
  assert.deepEqual(problems, [])
  assert.equal(lock.imports.length, 2)
  const entry = lock.imports.find((item) => item.name === 'playwright-like')
  assert.equal(entry.name, 'playwright-like')
  assert.equal(entry.mode, 'reference')
  assert.equal(entry.sourcePath, join(root, 'skills/playwright-like'))
  assert.ok(entry.hash.startsWith('sha256:'))
  assert.ok(codepointLength(entry.description) <= 220)
  assert.ok(entry.importedAt.endsWith('Z'))

  const long = lock.imports.find((item) => item.name === 'agent-reach-like')
  assert.ok(codepointLength(long.longDescription) > 800, '原始长描述必须完整保存以便重放')
  assert.ok(codepointLength(long.description) <= 220)

  // reference 不复制：目标目录只有锁文件
  assert.deepEqual(readdirSync(targetDir), ['.bridge.json'])
  assert.equal(existsSync(join(targetDir, 'playwright-like')), false)
})

test('锁文件原子写：不残留临时文件', (t) => {
  const { root, targetDir } = setup(t, 'atomic')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  const leftovers = readdirSync(targetDir).filter((name) => name !== '.bridge.json')
  assert.deepEqual(leftovers, [])
  const text = readFileSync(lockPath(targetDir), 'utf8')
  assert.ok(text.trimEnd().endsWith('}'), '写入的是完整 JSON')
  assert.equal(text.endsWith('\n'), true)
})

test('snapshot 模式：复制文件、跳过 >1MB 资产、改写 CODEX_HOME', (t) => {
  const { root, targetDir } = setup(t, 'snap')
  const result = importSkills({
    codexRoot: root,
    targetDir,
    names: ['playwright-like'],
    mode: 'snapshot',
    confirm: true,
    dryRun: false,
  })
  assert.equal(result.ok, true)
  const entry = readLock(targetDir).lock.imports[0]
  assert.equal(entry.mode, 'snapshot')
  const dest = join(targetDir, 'playwright-like')
  assert.equal(existsSync(join(dest, 'SKILL.md')), true)
  assert.equal(existsSync(join(dest, 'LICENSE.txt')), true, '必须保留 LICENSE')
  assert.equal(existsSync(join(dest, 'NOTICE.txt')), true, '必须保留 NOTICE')
  assert.equal(existsSync(join(dest, 'assets/huge.bin')), false, '>1MB 资产应跳过')

  const body = readFileSync(join(dest, 'SKILL.md'), 'utf8')
  assert.equal(body.includes('${CODEX_HOME:-$HOME/.codex}/skills/playwright-like'), false, 'CODEX_HOME 应被改写')
  assert.ok(body.includes(dest), '正文应指向新目录')
  assert.ok(entry.rewrites.length > 0, '改写必须记入锁文件')
  assert.equal(entry.rewrites.some((item) => item.file === 'SKILL.md'), true)

  const script = readFileSync(join(dest, 'scripts/run.sh'), 'utf8')
  assert.ok(script.includes('CODEX_HOME'), '脚本仍保留 CODEX_HOME 前缀（只替换 skills 路径）')
})

test('重名：prefix 生成 codex-<name>', (t) => {
  const { root, targetDir } = setup(t, 'dup-prefix')
  const first = importSkills({ codexRoot: root, targetDir, names: [join(root, 'skills/dup-a')], confirm: true, dryRun: false })
  assert.equal(first.data.planned[0].name, 'dup')

  const second = importSkills({ codexRoot: root, targetDir, names: [join(root, 'skills/dup-b')], confirm: true, dryRun: false })
  assert.equal(second.ok, true)
  const plan = second.data.planned[0]
  assert.equal(plan.name, 'codex-dup')
  assert.equal(plan.action, 'create')
  assert.equal(readLock(targetDir).lock.imports.length, 2)
})

test('重名：skip 策略跳过且不写第二条', (t) => {
  const { root, targetDir } = setup(t, 'dup-skip')
  importSkills({ codexRoot: root, targetDir, names: [join(root, 'skills/dup-a')], confirm: true, dryRun: false })
  const second = importSkills({
    codexRoot: root,
    targetDir,
    names: [join(root, 'skills/dup-b')],
    onConflict: 'skip',
    confirm: true,
    dryRun: false,
  })
  assert.equal(second.ok, true)
  assert.equal(second.data.planned[0].action, 'skip')
  assert.equal(second.data.planned[0].willImport, false)
  assert.equal(second.data.applied.length, 0)
  assert.equal(readLock(targetDir).lock.imports.length, 1)
})

test('重名：overwrite 策略替换原条目', (t) => {
  const { root, targetDir } = setup(t, 'dup-overwrite')
  importSkills({ codexRoot: root, targetDir, names: [join(root, 'skills/dup-a')], confirm: true, dryRun: false })
  const second = importSkills({
    codexRoot: root,
    targetDir,
    names: [join(root, 'skills/dup-b')],
    onConflict: 'overwrite',
    confirm: true,
    dryRun: false,
  })
  assert.equal(second.ok, true)
  assert.equal(second.data.planned[0].action, 'overwrite')
  const imports = readLock(targetDir).lock.imports
  assert.equal(imports.length, 1)
  assert.equal(imports[0].sourcePath, join(root, 'skills/dup-b'))
})

test('重复导入同一技能：noop，不重复写', (t) => {
  const { root, targetDir } = setup(t, 'noop')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  const again = importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  assert.equal(again.ok, true)
  assert.equal(again.data.planned[0].action, 'noop')
  assert.equal(again.data.planned[0].willImport, false)
  assert.equal(readLock(targetDir).lock.imports.length, 1)
})

test('拒绝：NOT_FOUND 与 MCP_ONLY', (t) => {
  const { root, targetDir } = setup(t, 'reject')
  const result = importSkills({ codexRoot: root, targetDir, names: ['nope', 'mcponly'], dryRun: true })
  assert.equal(result.ok, false)
  const codes = result.data.failed.map((item) => item.code)
  assert.deepEqual(codes.sort(), ['MCP_ONLY', 'NOT_FOUND'])
  assert.equal(result.data.planned.length, 0)
  assert.equal(existsSync(targetDir), false)
})

test('listImports：upstreamChanged / upstreamMissing', (t) => {
  const { root, targetDir } = setup(t, 'list')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like', 'agent-reach-like'], confirm: true, dryRun: false })

  const before = listImports({ codexRoot: root, targetDir })
  assert.equal(before.ok, true)
  assert.equal(before.data.total, 2)
  assert.equal(before.data.items.every((item) => item.upstreamChanged === false), true)
  assert.equal(before.data.items.every((item) => item.upstreamMissing === false), true)

  // 改上游 → changed
  const skillFile = join(root, 'skills/playwright-like/SKILL.md')
  writeFileSync(skillFile, readFileSync(skillFile, 'utf8') + '\n新加一行。\n')
  const after = listImports({ codexRoot: root, targetDir })
  const changed = after.data.items.find((item) => item.name === 'playwright-like')
  assert.equal(changed.upstreamChanged, true)

  // 删上游目录 → missing
  rmSync(join(root, 'skills/agent-reach-like'), { recursive: true, force: true })
  const missing = listImports({ codexRoot: root, targetDir })
  const gone = missing.data.items.find((item) => item.name === 'agent-reach-like')
  assert.equal(gone.upstreamMissing, true)
})

test('remove：reference 模式绝不删除上游', (t) => {
  const { root, targetDir } = setup(t, 'remove-ref')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  const removed = removeSkills({ targetDir, names: ['playwright-like'], purge: true })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.data.removed, ['playwright-like'])
  assert.deepEqual(removed.data.purged, [])
  assert.equal(existsSync(join(root, 'skills/playwright-like/SKILL.md')), true, '上游必须保留')
  assert.equal(readLock(targetDir).lock.imports.length, 0)
})

test('remove：purge 删除 snapshot 副本但不删上游', (t) => {
  const { root, targetDir } = setup(t, 'remove-snap')
  importSkills({
    codexRoot: root,
    targetDir,
    names: ['playwright-like'],
    mode: 'snapshot',
    confirm: true,
    dryRun: false,
  })
  assert.equal(existsSync(join(targetDir, 'playwright-like/SKILL.md')), true)
  const removed = removeSkills({ targetDir, names: ['playwright-like'], purge: true })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.data.purged, ['playwright-like'])
  assert.equal(existsSync(join(targetDir, 'playwright-like')), false)
  assert.equal(existsSync(join(root, 'skills/playwright-like/SKILL.md')), true)
})

test('remove：未导入的名字记为 failed', (t) => {
  const { root, targetDir } = setup(t, 'remove-missing')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  const removed = removeSkills({ targetDir, names: ['nope'], purge: false })
  assert.equal(removed.ok, false)
  assert.equal(removed.data.failed[0].code, 'NOT_IMPORTED')
  assert.equal(readLock(targetDir).lock.imports.length, 1)
})

test('inspectEntry：按 name 与按 path 都可用，willInject ≤ 500', (t) => {
  const { root } = setup(t, 'inspect')
  const byName = inspectEntry({ codexRoot: root, name: 'playwright-like' })
  assert.equal(byName.ok, true)
  assert.equal(byName.data.name, 'playwright-like')
  assert.ok(codepointLength(byName.data.willInject) <= 500)
  assert.ok(byName.data.scriptFiles.includes('scripts/run.sh'))
  assert.equal(byName.data.importable, true)

  const byPath = inspectEntry({ codexRoot: root, path: join(root, 'skills/agent-reach-like') })
  assert.equal(byPath.ok, true)
  assert.equal(byPath.data.name, 'agent-reach-like')

  assert.equal(inspectEntry({ codexRoot: root, name: 'nope' }).code, 'NOT_FOUND')
  assert.equal(inspectEntry({ codexRoot: root }).code, 'NO_TARGET')
})
