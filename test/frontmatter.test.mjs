import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeText,
  parseBlockScalar,
  parseInlineScalar,
  parseMappingBlock,
  parseSkillFile,
  splitFrontmatter,
} from '../lib/frontmatter.mjs'

const FOLDED = `---
name: folded-skill
description: >
  Use when the user asks for social-media research on 小红书 and 抖音,
  and you need to collect posts before answering.
  The collector call burns quota, so route carefully.
  Prefer the bundled CLI over ad-hoc scripts.
  Report sample size and platform mix.
license: MIT
metadata:
  homepage: https://example.invalid/x
  author: fixture
---

# Body

Real content starts here.
`

test('>` 折叠标量：5 行折成 1 行，长度 > 200', () => {
  const long = `---
name: big
description: >
${Array.from({ length: 5 }, (_, index) => `  line ${index} ${'x'.repeat(60)}`).join('\n')}
---

body
`
  const parsed = parseSkillFile(long)
  assert.equal(parsed.problems.includes('PARSE_ERROR'), false)
  assert.ok([...parsed.description].length > 200, `长度 ${[...parsed.description].length} 应 > 200`)
  assert.equal(parsed.description.includes('\n'), false)
  assert.ok(parsed.description.startsWith('line 0'))
})

test('>` 折叠标量：空行保留为换行，普通换行变成空格', () => {
  const text = FOLDED
  const parsed = parseSkillFile(text)
  assert.ok(parsed.description.includes('小红书'))
  assert.ok(parsed.description.includes('抖音'))
  assert.ok(parsed.description.includes('quota, so route carefully.'))
  assert.equal(parsed.description.includes('\n'), false)
  assert.equal(parsed.name, 'folded-skill')
  assert.equal(parsed.license, 'MIT')
  assert.equal(parsed.metadata.homepage, 'https://example.invalid/x')
  assert.equal(parsed.metadata.author, 'fixture')
})

test('`>` 里的空行折成换行', () => {
  const text = ['---', 'name: p', 'description: >', '  first part', '', '  second part', '---', '', 'body'].join('\n')
  const parsed = parseSkillFile(text)
  assert.equal(parsed.description, 'first part\nsecond part')
})

test('|` 字面标量保留换行', () => {
  const text = ['---', 'name: p', 'description: |', '  line one', '  line two', '---', '', 'body'].join('\n')
  const parsed = parseSkillFile(text)
  assert.ok(parsed.description.includes('line one\nline two'))
})

test('块标量 chomping：>- 去尾换行、|+ 保留多余空行', () => {
  assert.equal(parseBlockScalar('>', '-', 0, ['  a', '  b', '']), 'a b')
  assert.ok(parseBlockScalar('|', '+', 0, ['  a', '', '']).endsWith('\n\n'))
  assert.equal(parseBlockScalar('>', '', 0, []), '\n')
  assert.equal(parseBlockScalar('>', '-', 0, []), '')
})

test('引号标量：双引号转义、单引号双写', () => {
  assert.equal(parseInlineScalar('"a \\"b\\" c"'), 'a "b" c')
  assert.equal(parseInlineScalar("'it''s ok'"), "it's ok")
  assert.equal(parseInlineScalar('  plain value  '), 'plain value')
})

test('CRLF 与 BOM 不影响解析', () => {
  const lf = '---\nname: crlf\ndescription: Use when CRLF matters.\n---\n\nbody\n'
  const crlf = '\uFEFF' + lf.replace(/\n/g, '\r\n')
  const a = parseSkillFile(lf)
  const b = parseSkillFile(crlf)
  const { raw: _rawA, ...restA } = a
  const { raw: _rawB, ...restB } = b
  assert.deepEqual(restB, restA, '除 raw（原样保留）外解析结果应一致')
  assert.equal(b.raw, crlf, 'raw 保留原始字节以便溯源')
  assert.equal(normalizeText(crlf).includes('\r'), false)
})

test('key 后跟缩进多行（无块标量）折成一行', () => {
  const text = ['---', 'name: p', 'description:', '  first sentence.', '  second sentence.', '---', '', 'body'].join('\n')
  const parsed = parseSkillFile(text)
  assert.equal(parsed.description, 'first sentence. second sentence.')
})

test('metadata 嵌套对象与序列', () => {
  const text = ['---', 'name: p', 'description: Use when x.', 'metadata:', '  homepage: https://e.invalid', '  tags:', '    - alpha', '    - beta', '---', '', 'body'].join('\n')
  const parsed = parseSkillFile(text)
  assert.deepEqual(parsed.metadata.tags, ['alpha', 'beta'])
})

test('无 frontmatter：不抛，content 为全文，problems 含 NO_FRONTMATTER', () => {
  const parsed = parseSkillFile('# Title\n\nbody only\n')
  assert.equal(parsed.name, '')
  assert.equal(parsed.description, '')
  assert.ok(parsed.problems.includes('NO_FRONTMATTER'))
  assert.equal(parsed.content, '# Title\n\nbody only\n')
})

test('缺少 description：problems 含 EMPTY_DESCRIPTION，名仍可用', () => {
  const parsed = parseSkillFile('---\nname: only-name\n---\n\nbody\n')
  assert.equal(parsed.name, 'only-name')
  assert.ok(parsed.problems.includes('EMPTY_DESCRIPTION'))
})

test('缺少 name：problems 含 NO_NAME', () => {
  const parsed = parseSkillFile('---\ndescription: Use when x.\n---\n\nbody\n')
  assert.equal(parsed.name, '')
  assert.ok(parsed.problems.includes('NO_NAME'))
})

test('只有开头没有结尾的 ---：按无 frontmatter 处理', () => {
  const { frontmatter, problems } = splitFrontmatter('---\nname: x\nbody\n')
  assert.equal(frontmatter, null)
  assert.ok(problems.includes('NO_FRONTMATTER'))
})

test('content 去掉 frontmatter 并 trimStart', () => {
  const parsed = parseSkillFile(FOLDED)
  assert.equal(parsed.content.startsWith('# Body'), true)
  assert.equal(parsed.content.startsWith('\n'), false)
  assert.equal(parsed.content.includes('name: folded-skill'), false)
})

test('畸形 frontmatter 不抛异常', () => {
  for (const text of ['---\n:::\n---\n\nbody', '---\n\t\tbad: [unclosed\n---\n\nbody', '---\n\n---\n', '']) {
    const parsed = parseSkillFile(text)
    assert.equal(typeof parsed.description, 'string')
    assert.equal(Array.isArray(parsed.problems), true)
  }
})

test('parseMappingBlock 忽略注释与无法识别的行', () => {
  const map = parseMappingBlock(['# comment', 'name: x', 'nonsense line', 'description: y'])
  assert.equal(map.name, 'x')
  assert.equal(map.description, 'y')
})
