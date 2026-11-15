/**
 * 冒烟测试：对着**真实** ~/.codex 跑一遍完整生命周期。
 *
 * 六步：scan → import --dry-run → import --yes → 重放注册 → remove → 再跑一遍确认幂等。
 * 全部检查都是硬断言：任何一步失败即以非零退出码结束，不做"失败也算过"的处理。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.mjs'
import { lockPath, readLock } from '../lib/lockfile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'bridge.mjs')
const SKILL = 'playwright'

let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function runBridge(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

function runJson(args, env) {
  const result = runBridge([...args, '--json'], env)
  let json = null
  try {
    json = JSON.parse(result.stdout.trim().split('\n').pop())
  } catch {
    json = null
  }
  return { ...result, json }
}

function mockContext() {
  const skills = new Map()
  const tools = new Map()
  const context = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: {
      register: (spec) => {
        skills.set(spec.name, spec)
        return () => skills.delete(spec.name)
      },
    },
    on: () => () => {},
  }
  return { context, skills, tools }
}

function stepScan() {
  console.log('\n[1/6] scan 真实 ~/.codex')
  const result = runJson(['scan'])
  check('退出码为 0', result.code === 0, `实际 ${result.code}：${result.stderr.trim()}`)
  check('返回合法 JSON', result.json !== null)
  if (result.json === null) return
  check(`total ≥ 3（实际 ${result.json.total}）`, result.json.total >= 3)
  check(
    'item 带 name/kind/sha256',
    result.json.items.every((item) => item.name && item.kind && String(item.sha256 ?? '').startsWith('sha256:')),
  )
  console.log(`    可导入技能：${result.json.items.map((item) => item.name).join(', ')}`)
}

function stepDryRun(targetDir) {
  console.log('\n[2/6] import --dry-run：不得写盘')
  const result = runJson(['import', SKILL, '--target', targetDir, '--dry-run'])
  check('退出码为 0', result.code === 0, result.stderr.trim())
  check('计划 willImport=true', result.json?.planned?.[0]?.willImport === true)
  check('描述 ≤ 220 字符', (result.json?.planned?.[0]?.description?.length ?? 999) <= 220)
  check('目标目录仍不存在', !existsSync(targetDir))
}

function stepImport(targetDir) {
  console.log('\n[3/6] import --yes：写锁文件')
  const result = runJson(['import', SKILL, '--target', targetDir, '--yes'])
  check('退出码为 0', result.code === 0, result.stderr.trim())
  const { lock, problems } = readLock(targetDir)
  check('锁文件无问题', problems.length === 0, problems.join(','))
  check(`锁文件恰好 1 条（实际 ${lock.imports.length}）`, lock.imports.length === 1)
  const entry = lock.imports[0] ?? {}
  check('条目名字正确', entry.name === SKILL, entry.name)
  check('SKILL.md 可读', typeof entry.sourcePath === 'string' && existsSync(join(entry.sourcePath, 'SKILL.md')))
  const body = readFileSync(join(entry.sourcePath, 'SKILL.md'), 'utf8')
  check('正文非空且含 Markdown 标题', body.trim().length > 0 && body.includes('#'))
}

function stepReplay(targetDir) {
  console.log('\n[4/6] mock ctx 重放：注册 1 个技能')
  const { context, skills, tools } = mockContext()
  let summary
  try {
    summary = apply(context, { targetDir })
  } catch (error) {
    check('apply 不抛异常', false, error instanceof Error ? error.message : String(error))
    return
  }
  check('注册技能数 == 锁文件条目数 (1)', skills.size === 1, `实际 ${skills.size}`)
  check('注册了 6 个工具', tools.size === 6, `实际 ${tools.size}`)
  check('summary.skills == 1', summary.skills === 1)
  const spec = skills.get(SKILL)
  check('注入的 description 来自锁文件（≤220）', typeof spec?.description === 'string' && spec.description.length <= 220)
  check('resourceBase 指向上游目录', spec?.resourceBase?.kind === 'directory' && existsSync(spec.resourceBase.path))
}

function stepRemove(targetDir) {
  console.log('\n[5/6] remove：锁文件清空')
  const result = runJson(['remove', SKILL, '--target', targetDir])
  check('退出码为 0', result.code === 0, result.stderr.trim())
  check('锁文件 0 条', readLock(targetDir).lock.imports.length === 0)
}

function cycle(targetDir) {
  stepScan()
  stepDryRun(targetDir)
  stepImport(targetDir)
  stepReplay(targetDir)
  stepRemove(targetDir)
}

function main() {
  console.log('dsh-codex-bridge 冒烟测试（真实 ~/.codex）')
  const base = mkdtempSync(join(tmpdir(), 'codex-bridge-smoke-'))
  // 每轮用全新的 targetDir：这样才能验证"dry-run 不创建目录"
  const targets = [join(base, 'bridge-1'), join(base, 'bridge-2')]
  try {
    cycle(targets[0])
    console.log('\n[6/6] 再跑一遍：幂等、无残留')
    cycle(targets[1])
    for (const targetDir of targets) {
      check(`${targetDir} 只剩锁文件`, readdirSync(targetDir).every((name) => name === '.bridge.json'))
      check(`${targetDir} 锁文件已清空`, readLock(targetDir).lock.imports.length === 0)
    }
    check('上游 skills/playwright 未被删除', existsSync(join(process.env.HOME ?? '', '.codex/skills', SKILL, 'SKILL.md')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\n✗ 冒烟测试失败：${failures} 项`)
    process.exit(1)
  }
  console.log('\n✓ 冒烟测试全部通过')
}

mkdirSync(tmpdir(), { recursive: true })
main()
