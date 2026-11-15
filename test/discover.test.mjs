import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { compareVersions, discover, listFiles, pickVersion } from '../lib/discover.mjs'
import { fixtureRoot, tempDir } from './helpers/harness.mjs'

const REAL = process.env.CODEX_BRIDGE_REAL === '1'

function byName(result, name) {
  return result.items.find((item) => item.name === name)
}

test('5 种形态都能扫出来，且跳过 .plugin-appserver', (t) => {
  const root = fixtureRoot(t)
  const result = discover({ codexRoot: root })

  const names = result.items.map((item) => item.name).sort()
  assert.deepEqual(names, ['agent-reach-like', 'alpha', 'beta', 'dup', 'dup', 'new-skill', 'playwright-like'])
  assert.equal(result.total, 7)

  const standalone = result.items.filter((item) => item.kind === 'standalone')
  const plugin = result.items.filter((item) => item.kind === 'plugin')
  assert.equal(standalone.length, 4)
  assert.equal(plugin.length, 3)

  // .plugin-appserver 必须被跳过
  assert.equal(result.items.some((item) => item.name === 'ghost'), false)
  assert.equal(existsSync(join(root, 'plugins/cache/m/.plugin-appserver/1.0.0/skills/ghost/SKILL.md')), true)
})

test('agent-reach-like：折叠描述 ~1.5k、7 个 references、无问题', (t) => {
  const result = discover({ codexRoot: fixtureRoot(t) })
  const item = byName(result, 'agent-reach-like')
  assert.ok(item !== undefined)
  assert.equal(item.kind, 'standalone')
  assert.ok(item.descriptionLength > 1200, `描述长度 ${item.descriptionLength}`)
  assert.ok(item.descriptionLength < 2000)
  assert.equal(item.fileCount, 8)
  assert.deepEqual(item.problems, [])
  assert.equal(item.hasScripts, false)
  assert.equal(item.sha256.startsWith('sha256:'), true)
})

test('playwright-like：识别脚本、资产与 LICENSE', (t) => {
  const result = discover({ codexRoot: fixtureRoot(t) })
  const item = byName(result, 'playwright-like')
  assert.equal(item.hasScripts, true)
  assert.ok(item.scriptFiles.includes('scripts/run.sh'))
  assert.equal(item.license, 'Apache-2.0')
  assert.equal(item.fileCount, 9)
})

test('版本选择：1.10.0 胜过 1.2.3（数字比较，不是字典序）', (t) => {
  const result = discover({ codexRoot: fixtureRoot(t) })
  const versioned = result.items.filter((item) => item.pluginName === 'versioned')
  assert.equal(versioned.length, 1)
  assert.equal(versioned[0].name, 'new-skill')
  assert.equal(versioned[0].pluginVersion, '1.10.0')

  assert.ok(compareVersions('1.10.0', '1.2.3') > 0)
  assert.ok(compareVersions('26.1112.11217', '26.1026.10807') > 0)
  assert.ok(compareVersions('0722921d', '26.1026.10807') < 0, 'hash 目录排在数字版本之后')
  assert.equal(pickVersion(['1.2.3', '1.10.0']), '1.10.0')
  assert.equal(pickVersion(['1.10.0', '1.2.3'], '1.2.3'), '1.2.3')
  assert.equal(pickVersion([]), null)
})

test('MCP_ONLY：不产技能条目，只记到 problems', (t) => {
  const result = discover({ codexRoot: fixtureRoot(t) })
  assert.equal(result.items.some((item) => item.sourceName === 'mcponly'), false)
  const problem = result.problems.find((entry) => entry.name === 'mcponly')
  assert.ok(problem !== undefined)
  assert.equal(problem.code, 'MCP_ONLY')
  assert.ok(problem.problems.includes('MCP_ONLY'))
})

test('重名：两个目录同名会被标 NAME_COLLISION', (t) => {
  const result = discover({ codexRoot: fixtureRoot(t) })
  const dups = result.items.filter((item) => item.name === 'dup')
  assert.equal(dups.length, 2)
  for (const item of dups) assert.ok(item.problems.includes('NAME_COLLISION'))
})

test('include / exclude 过滤', (t) => {
  const root = fixtureRoot(t)
  const only = discover({ codexRoot: root, include: ['playwright*'] })
  assert.deepEqual(only.items.map((item) => item.name), ['playwright-like'])

  const excluded = discover({ codexRoot: root, exclude: ['dup*', 'alpha', 'beta', 'new-skill'] })
  assert.deepEqual(excluded.items.map((item) => item.name).sort(), ['agent-reach-like', 'playwright-like'])

  const skippedFiltered = discover({ codexRoot: root, include: ['multi'] })
  assert.deepEqual(skippedFiltered.items.map((item) => item.name).sort(), ['alpha', 'beta'])
  assert.equal(skippedFiltered.problems.length, 0)
})

test('codexRoot 不存在：ROOT_MISSING，不抛', (t) => {
  const missing = join(tempDir(t), 'nope')
  const result = discover({ codexRoot: missing })
  assert.equal(result.total, 0)
  assert.deepEqual(result.items, [])
  assert.equal(result.problems[0].code, 'ROOT_MISSING')
})

test('listFiles 返回相对 posix 路径且已排序', (t) => {
  const root = fixtureRoot(t)
  const files = listFiles(join(root, 'skills/playwright-like'))
  assert.deepEqual(files, [...files].sort())
  assert.ok(files.includes('scripts/run.sh'))
  assert.equal(files.some((file) => file.includes('\\')), false)
  assert.ok(files.includes('assets/huge.bin'), '>1MB 文件仍计入扫描清单')
})

test('真实 ~/.codex：agent-reach / playwright / spreadsheets 可扫出，github 标 MCP_ONLY', { skip: REAL ? false : '未设 CODEX_BRIDGE_REAL=1' }, () => {
  const result = discover({})
  assert.ok(result.total >= 3, `真实扫描 total=${result.total} 应 >= 3`)
  const sources = result.items.map((item) => item.sourceName)
  for (const expected of ['agent-reach', 'playwright']) {
    assert.ok(sources.includes(expected), `缺少 ${expected}`)
  }
  assert.ok(
    result.items.some((item) => item.pluginName === 'spreadsheets'),
    '应扫出 openai-primary-runtime/spreadsheets 的子技能',
  )
  const github = result.problems.find((problem) => problem.name === 'github')
  assert.ok(github !== undefined, 'github 应出现在 problems 里')
  assert.equal(github.code, 'MCP_ONLY')
  const agentReach = result.items.find((item) => item.sourceName === 'agent-reach')
  assert.ok(agentReach.descriptionLength > 800, 'agent-reach 的折叠描述应被完整展开')
})
