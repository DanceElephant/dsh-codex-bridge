/**
 * 描述压缩：Codex 技能的 description 可达 1.5k 字符，直接塞进系统提示会撑爆预算。
 *
 * 压缩策略（提示词 3.3）：
 *   1. 去 Markdown 标记、URL、代码围栏、多余空白；
 *   2. 优先抽取含 `Use when` / `使用时机` / `用于` / `当…时` 的句子；
 *   3. 补入关键词：反引号 token、CJK 平台名、大写开头的产品名；
 *   4. 用 `；` 拼接，硬上限 max（按 Unicode 码点计数，不切断代理对）。
 *
 * 压缩必须保留原文的核心触发词；完整原文另存锁文件 longDescription。
 */

/** 常见 CJK / 平台名，用于补关键词。 */
export const PLATFORM_WORDS = [
  '小红书', '抖音', '微博', '知乎', 'B站', 'bilibili', '快手', '微信公众号', '视频号',
  '豆瓣', '贴吧', '抖音小店', '淘宝', '京东', '推特', 'Twitter', 'YouTube', 'Reddit',
  'Facebook', 'Instagram', 'V2EX', 'LinkedIn', '雪球', '小宇宙', '播客', 'RSS', 'GitHub',
]

const TRIGGER_PATTERNS = [
  /use when/i,
  /must use/i,
  /使用时机/,
  /用于/,
  /当[^，。；]{0,20}时/,
  /适合[^，。；]{0,20}(?:场景|情况)/,
  /triggers? on/i,
]

const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'if', 'for', 'and', 'or', 'but', 'not',
  'use', 'when', 'must', 'also', 'you', 'your', 'it', 'is', 'are', 'in', 'on', 'at', 'to', 'of',
  'do', 'does', 'did', 'with', 'from', 'by', 'as', 'all', 'any', 'can', 'may', 'should', 'will',
  'would', 'run', 'see', 'note', 'only', 'whenever', 'after', 'before', 'then', 'than', 'into',
  'step', 'steps', 'example', 'examples', 'required', 'optional', 'true', 'false', 'null',
])

/** 按 Unicode 码点计长度。 */
export function codepointLength(text) {
  return [...String(text ?? '')].length
}

/** 硬截断到 max 个码点，绝不切断代理对。 */
export function hardCap(text, max) {
  const codepoints = [...String(text ?? '')]
  if (max <= 0) return ''
  if (codepoints.length <= max) return String(text ?? '')
  return codepoints.slice(0, max).join('')
}

/** 去 Markdown / URL / 围栏 / 多余空白，保留正文文字。 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, ' ')
    .replace(/```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]{1,200}>/g, ' ')
    .replace(/\bhttps?:\/\/[^\s，。；、)）\]】]+/gi, ' ')
    .replace(/\bwww\.[^\s，。；、)）\]】]+/gi, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/\s+/g, ' ')
}

/** 抽取反引号包裹的 token（取第一个"像命令"的词）。 */
export function extractBackticked(text) {
  const out = []
  const re = /`([^`\n]{1,80})`/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const token = match[1].trim()
    if (token === '') continue
    const head = token.split(/\s+/)[0].replace(/[.),;:]+$/, '')
    if (head === '' || head.startsWith('-') || head.startsWith('$')) continue
    out.push(head)
  }
  return out
}

function extractCapitalized(text) {
  const out = []
  const re = /\b[A-Z][A-Za-z0-9.+-]{1,24}\b/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const token = match[0].replace(/[.+-]+$/, '')
    if (STOPWORDS.has(token.toLowerCase())) continue
    if (/^[A-Z]$/.test(token)) continue
    out.push(token)
  }
  return out
}

/** 去重（大小写不敏感），保留第一次出现的写法。 */
export function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = normalizeForCompare(item)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 收集关键词：CJK 平台名 → 反引号 token → 大写产品名。 */
export function collectKeywords(raw, max = 6) {
  const source = String(raw ?? '')
  const lower = source.toLowerCase()
  const platforms = PLATFORM_WORDS.filter((word) => lower.includes(word.toLowerCase()))
  const backticked = extractBackticked(source)
  const capitalized = extractCapitalized(stripMarkdown(source).replace(/`[^`\n]*`/g, ' '))
  return dedupe([...platforms, ...backticked, ...capitalized]).slice(0, max)
}

function isTrigger(sentence) {
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(sentence))
}

/** 切句：中文句号/问号/叹号/换行；分号在正文里统一降级为逗号以保持幂等。 */
export function splitSentences(text) {
  return String(text ?? '')
    .replace(/[；;]/g, '，')
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** 清理句尾多余标点与连接符。 */
function tidy(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[，、,;；:：\-—/|]+$/u, '')
    .replace(/\s+$/u, '')
    .trim()
}

function alreadyContains(haystack, needle) {
  return normalizeForCompare(haystack).includes(normalizeForCompare(needle))
}

/** 把一段文本按子句切开（分隔符留在子句尾部，拼回去即原文）。 */
function clauseSegments(text) {
  return String(text ?? '')
    .split(/(?<=[，、,：:；;—])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** 在预算内取尽可能多的完整子句。 */
function clausePrefix(text, budget) {
  const segments = clauseSegments(text)
  let out = ''
  for (const segment of segments) {
    const candidate = out === '' ? segment : out + segment
    if (codepointLength(candidate) > budget) break
    out = candidate
  }
  return tidy(out)
}

/** 实在放不下时按词/子句边界截断，并加省略号。 */
function cutAtBoundary(text, budget) {
  const codepoints = [...String(text ?? '')]
  if (codepoints.length <= budget) return String(text ?? '')
  if (budget <= 1) return ''
  const slice = codepoints.slice(0, budget - 1).join('')
  let cut = slice
  const lastBreak = Math.max(
    slice.lastIndexOf(' '),
    slice.lastIndexOf('，'),
    slice.lastIndexOf('、'),
    slice.lastIndexOf('/'),
    slice.lastIndexOf('—'),
  )
  if (lastBreak > Math.floor(budget * 0.4)) cut = slice.slice(0, lastBreak)
  return tidy(cut) + '…'
}

/**
 * 压缩描述。
 *
 * 幂等性来自一条早退：清洗后的文本如果本来就不超预算，原样返回。
 * 这样 `compressDescription(compressDescription(x)) === compressDescription(x)` 恒成立。
 *
 * @param {string} text 原始 description
 * @param {number} max 硬上限（Unicode 码点），默认 220
 * @returns {string}
 */
export function compressDescription(text, max = 220) {
  const source = String(text ?? '')
  if (source.trim() === '' || max <= 0) return ''

  const cleaned = tidy(stripMarkdown(source).replace(/\s*\n+\s*/g, ' '))
  if (codepointLength(cleaned) <= max) return cleaned

  const sentences = splitSentences(cleaned)
  const keywords = collectKeywords(source, 6)
  const keywordTail = keywords.join('；')
  const reserved = Math.min(codepointLength(keywordTail), Math.floor(max * 0.45))
  const headBudget = Math.max(0, max - reserved - (keywordTail === '' ? 0 : 1))

  // 触发句优先，其余句子按原文顺序补位
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, priority: isTrigger(sentence) ? 0 : 1 }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)

  const selected = []
  let used = 0
  for (const candidate of ranked) {
    if (headBudget - used < 12) break
    const remaining = headBudget - used - (selected.length > 0 ? 1 : 0)
    const piece =
      codepointLength(candidate.sentence) <= remaining ? tidy(candidate.sentence) : clausePrefix(candidate.sentence, remaining)
    if (piece === '' || codepointLength(piece) < 4) continue
    if (alreadyContains(selected.map((item) => item.sentence).join('；'), piece)) continue
    selected.push({ ...candidate, piece })
    used += codepointLength(piece) + (selected.length > 1 ? 1 : 0)
  }

  let head = selected
    .sort((a, b) => a.index - b.index)
    .map((item) => item.piece)
    .join('；')
  head = tidy(head)
  if (head !== '' && codepointLength(head) > headBudget) head = cutAtBoundary(head, headBudget)

  const keywordParts = []
  let total = codepointLength(head)
  for (const keyword of keywords) {
    if (alreadyContains(head, keyword) || alreadyContains(keywordParts.join('；'), keyword)) continue
    const cost = codepointLength(keyword) + (total > 0 ? 1 : 0)
    if (total + cost > max) continue
    keywordParts.push(keyword)
    total += cost
  }

  let output = [head, keywordParts.join('；')].filter((part) => part !== '').join('；')
  if (output === '') output = cutAtBoundary(cleaned, max)
  if (codepointLength(output) > max) output = cutAtBoundary(output, max)
  return output
}
