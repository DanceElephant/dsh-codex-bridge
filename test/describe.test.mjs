import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectKeywords,
  codepointLength,
  compressDescription,
  dedupe,
  extractBackticked,
  hardCap,
  splitSentences,
  stripMarkdown,
} from '../lib/describe.mjs'
import { fixtureRoot, tempDir } from './helpers/harness.mjs'

const MAX = 220

function fixtureDescription(t) {
  const root = fixtureRoot(t, 'describe')
  const text = readFileSync(join(root, 'skills/agent-reach-like/SKILL.md'), 'utf8')
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  assert.ok(match !== null)
  return match[1]
}

test('1.5k 描述压到 ≤220，且保留平台触发词', (t) => {
  const source = fixtureDescription(t)
  const raw = source
    .split('\n')
    .filter((line) => !line.startsWith('name:') && !line.startsWith('license:') && !line.includes('metadata'))
    .join(' ')
  const compressed = compressDescription(raw, MAX)
  assert.ok(codepointLength(compressed) <= MAX, `长度 ${codepointLength(compressed)} 应 ≤ ${MAX}`)
  assert.ok(codepointLength(compressed) > 60)
  for (const keyword of ['小红书', '抖音']) {
    assert.ok(compressed.includes(keyword), `压缩结果应包含 ${keyword}：${compressed}`)
  }
  assert.ok(/use when|使用时机/i.test(compressed), '应保留触发句式')
})

test('压缩幂等：跑两次结果完全相同', (t) => {
  const source = fixtureDescription(t)
  const once = compressDescription(source, MAX)
  const twice = compressDescription(once, MAX)
  assert.equal(twice, once)

  // 短描述只做 Markdown 清洗，不再压缩
  const short = 'Use when the task needs `playwright-cli`.'
  assert.equal(compressDescription(short, MAX), 'Use when the task needs playwright-cli.')
  assert.equal(compressDescription(compressDescription(short, MAX), MAX), compressDescription(short, MAX))
})

test('更小的 max 也被严格遵守', (t) => {
  const source = fixtureDescription(t)
  for (const max of [40, 60, 120]) {
    const out = compressDescription(source, max)
    assert.ok(codepointLength(out) <= max, `max=${max} 时输出 ${codepointLength(out)} 超限`)
    assert.ok(out.length > 0)
  }
})

test('不切断 emoji（按码点截断）', () => {
  const text = '🎯🎯🎯🎯🎯'
  const cut = hardCap(text, 2)
  assert.deepEqual([...cut], ['🎯', '🎯'])
  assert.equal(cut.length, 4)
  assert.equal(cut.isWellFormed(), true)
  assert.equal(hardCap('abc', 10), 'abc')
  assert.equal(hardCap('abc', 0), '')

  const mixed = compressDescription('🎯 '.repeat(300), 50)
  assert.equal(mixed.isWellFormed(), true, '压缩结果不能出现孤立代理项')
  assert.ok(codepointLength(mixed) <= 50)
})

test('关键词抽取：CJK 平台名优先，其次反引号 token', () => {
  const keywords = collectKeywords(
    'Use when user mentions 小红书 or 抖音, run `reach-cli` and then `export`.',
    6,
  )
  assert.ok(keywords.includes('小红书'))
  assert.ok(keywords.includes('抖音'))
  assert.ok(keywords.includes('reach-cli'))
  assert.ok(keywords.length <= 6)
})

test('stripMarkdown 去围栏、链接、加粗与 URL', () => {
  const dirty = [
    '# 标题',
    '',
    '请 **注意** 这个 [链接](https://example.invalid/x) 和 `inline` 代码。',
    '```bash',
    'reach collect --limit 20',
    '```',
    '见 https://example.invalid/y 。',
  ].join('\n')
  const clean = stripMarkdown(dirty)
  assert.equal(clean.includes('```'), false)
  assert.equal(clean.includes('https://'), false)
  assert.equal(clean.includes('**'), false)
  assert.ok(clean.includes('注意'))
  assert.ok(clean.includes('inline'))
})

test('边界输入', () => {
  assert.equal(compressDescription(''), '')
  assert.equal(compressDescription('   '), '')
  assert.equal(compressDescription('x', 0), '')
  assert.equal(codepointLength('😀a'), 2)
  assert.equal(codepointLength(undefined), 0)
})

test('splitSentences 把分号降级成逗号以保持幂等', () => {
  const sentences = splitSentences('第一句。第二句！第三句；第四句\n第五句')
  assert.equal(sentences.length >= 3, true)
  assert.equal(sentences.some((sentence) => sentence.includes('；')), false)
})

test('extractBackticked 与 dedupe', () => {
  assert.deepEqual(extractBackticked('run `a-b --flag` or `c`'), ['a-b', 'c'])
  assert.deepEqual(dedupe(['A', 'a', 'b']), ['A', 'b'])
})

test('长描述兜底：没有触发句也不超限、不为空', () => {
  const prose = 'This skill collects posts from social platforms and summarises them. '.repeat(40)
  const out = compressDescription(prose, 100)
  assert.ok(codepointLength(out) <= 100)
  assert.ok(out.length > 20)
})

test('异常短预算下仍不崩', (t) => {
  const source = fixtureDescription(t)
  const out = compressDescription(source, 12)
  assert.ok(codepointLength(out) <= 12)
  // 临时目录只是为了让夹具存在
  assert.ok(tempDir(t, 'describe-tmp').length > 0)
})
