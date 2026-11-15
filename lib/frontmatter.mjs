/**
 * SKILL.md frontmatter 解析（零依赖，只实现 Codex 技能实际用到的 YAML 子集）。
 *
 * 支持：单行标量、单双引号、`>` 折叠标量、`|` 字面标量（含 +/- 与缩进指示符）、
 * `key:` 后跟缩进多行、一层以上嵌套对象、`- ` 序列、CRLF、BOM。
 *
 * 解析失败绝不抛异常：返回空 name/description 并把原因写进 problems。
 */

const FRONTMATTER_OPEN = '---'
const FRONTMATTER_CLOSE = '---'

/** 统一换行符并去掉 BOM。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
}

/**
 * 切出 frontmatter 与正文。
 * @returns {{ frontmatter: string|null, body: string, problems: string[] }}
 */
export function splitFrontmatter(text) {
  const normalized = normalizeText(text)
  const lines = normalized.split('\n')
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_OPEN) {
    return { frontmatter: null, body: normalized, problems: ['NO_FRONTMATTER'] }
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FRONTMATTER_CLOSE) {
      end = i
      break
    }
  }
  if (end < 0) {
    // 只有开头的 --- 没有结尾：整篇当正文，按"无 frontmatter"处理
    return { frontmatter: null, body: normalized, problems: ['NO_FRONTMATTER'] }
  }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
    problems: [],
  }
}

function indentOf(line) {
  let i = 0
  while (i < line.length && line[i] === ' ') i += 1
  return i
}

function stripIndent(lines, count) {
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(Math.min(count, indentOf(line)))))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 双引号标量反转义（YAML 双引号允许的常用转义）。 */
function unescapeDoubleQuoted(value) {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value[i + 1]
    i += 1
    switch (next) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case '0': out += '\0'; break
      case 'u': {
        const hex = value.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16))
          i += 4
        } else {
          out += '\\u'
        }
        break
      }
      case undefined: out += '\\'; break
      default: out += next
    }
  }
  return out
}

/** 行内标量：引号 / 纯量。 */
export function parseInlineScalar(raw) {
  const value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1))
  }
  return value
}

/** 折叠标量 `>`：普通换行变空格，空行变换行。 */
function foldLines(lines) {
  const out = []
  let pendingBlank = 0
  for (const line of lines) {
    if (line.trim() === '') {
      pendingBlank += 1
      continue
    }
    if (out.length === 0) {
      out.push(line)
    } else if (pendingBlank > 0) {
      out.push('\n'.repeat(pendingBlank) + line)
    } else {
      out.push(' ' + line)
    }
    pendingBlank = 0
  }
  return out.join('')
}

function applyChomp(body, style, chomp, trailingBlanks) {
  const stripped = body.replace(/[ \t]+$/u, (m) => (style === '|' ? m : ''))
  if (chomp === '-') return stripped.replace(/\n+$/u, '')
  if (chomp === '+') return stripped + '\n'.repeat(trailingBlanks + 1)
  return stripped.replace(/\n+$/u, '') + '\n'
}

/** 块标量：`>` / `|`。 */
export function parseBlockScalar(style, chomp, explicitIndent, rawLines) {
  const lines = rawLines.slice()
  let trailingBlanks = 0
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
    trailingBlanks += 1
  }
  const firstContent = lines.find((line) => line.trim() !== '')
  if (firstContent === undefined) {
    return chomp === '-' ? '' : '\n'
  }
  const baseIndent = explicitIndent > 0 ? explicitIndent : indentOf(firstContent)
  const stripped = stripIndent(lines, baseIndent)
  const body = style === '|' ? stripped.join('\n') : foldLines(stripped)
  return applyChomp(body, style, chomp, trailingBlanks)
}

function looksLikeMappingLine(line) {
  return /^[^\s:#][^:]*:(?:[ \t].*)?$/.test(line)
}

function looksLikeSequenceLine(line) {
  return /^\s*-[ \t]/.test(line)
}

function parseSequence(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i += 1; continue }
    const match = /^\s*-[ \t]*(.*)$/.exec(line)
    if (!match) { i += 1; continue }
    const itemIndent = indentOf(line)
    const itemText = match[1].trim()
    const nested = []
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (next.trim() === '') { nested.push(next); j += 1; continue }
      if (indentOf(next) <= itemIndent) break
      nested.push(next)
      j += 1
    }
    if (itemText === '' && nested.length > 0) {
      out.push(parseMappingBlock(stripIndent(nested, itemIndent + 2)))
    } else if (looksLikeMappingLine(itemText)) {
      const mapLines = [itemText, ...nested.map((line) => line.slice(Math.min(indentOf(line), itemIndent + 2)))]
      out.push(parseMappingBlock(mapLines))
    } else if (itemText === '') {
      out.push('')
    } else {
      out.push(parseInlineScalar(itemText))
    }
    i = j
  }
  return out
}

/**
 * 解析一段缩进已规范化的映射行。
 * 返回值是普通对象；无法识别的行被忽略（YAML 子集策略，绝不抛）。
 */
export function parseMappingBlock(lines) {
  const result = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i += 1; continue }
    if (indentOf(line) > 0) { i += 1; continue }
    const match = /^([^\s:#][^:]*?):(?:[ \t]+(.*))?$/.exec(line.trimEnd())
    if (match === null) { i += 1; continue }
    const key = match[1].trim()
    const rest = (match[2] ?? '').trim()

    if (rest !== '') {
      const block = /^([>|])([+-]?)(\d?)$/.exec(rest)
      if (block !== null) {
        const start = i + 1
        let end = start
        while (end < lines.length) {
          const candidate = lines[end]
          if (candidate.trim() === '') { end += 1; continue }
          if (indentOf(candidate) === 0) break
          end += 1
        }
        result[key] = parseBlockScalar(block[1], block[2] ?? '', Number(block[3] || 0), lines.slice(start, end))
        i = end
        continue
      }
      result[key] = parseInlineScalar(rest)
      i += 1
      continue
    }

    // `key:` 后跟缩进块
    const start = i + 1
    let end = start
    while (end < lines.length) {
      const candidate = lines[end]
      if (candidate.trim() === '') { end += 1; continue }
      if (indentOf(candidate) === 0) break
      end += 1
    }
    const childLines = lines.slice(start, end)
    const firstNonBlank = childLines.find((line) => line.trim() !== '')
    if (firstNonBlank === undefined) {
      result[key] = ''
    } else {
      const childIndent = indentOf(firstNonBlank)
      const normalized = stripIndent(childLines, childIndent)
      if (looksLikeSequenceLine(normalized[0])) {
        result[key] = parseSequence(normalized)
      } else if (looksLikeMappingLine(normalized[0])) {
        result[key] = parseMappingBlock(normalized)
      } else {
        const body = foldLines(normalized).replace(/[ \t]+$/u, '')
        result[key] = body.trim()
      }
    }
    i = end
  }
  return result
}

function scalarString(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * 解析 SKILL.md。
 * @returns {{ name: string, description: string, license: string, metadata: object, content: string, raw: string, problems: string[] }}
 */
export function parseSkillFile(text) {
  const raw = String(text ?? '')
  const { frontmatter, body, problems } = splitFrontmatter(raw)
  const content = body.trimStart()
  if (frontmatter === null) {
    return { name: '', description: '', license: '', metadata: {}, content, raw, problems: [...problems] }
  }
  let data
  try {
    data = parseMappingBlock(normalizeText(frontmatter).split('\n'))
  } catch {
    return {
      name: '',
      description: '',
      license: '',
      metadata: {},
      content,
      raw,
      problems: [...problems, 'PARSE_ERROR'],
    }
  }
  const name = scalarString(data.name)
  const description = scalarString(data.description)
  const license = scalarString(data.license)
  const metadata = isPlainObject(data.metadata) ? data.metadata : {}
  if (name === '') problems.push('NO_NAME')
  if (description === '') problems.push('EMPTY_DESCRIPTION')
  return { name, description, license, metadata, content, raw, problems }
}
