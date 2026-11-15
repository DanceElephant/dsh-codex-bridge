/**
 * 扫描 ~/.codex，产出可导入条目。
 *
 * 两类来源：
 *   1. `<root>/skills/<dir>/SKILL.md`            → kind: 'standalone'
 *   2. `<root>/plugins/cache/<market>/<plugin>/<version>/` → kind: 'plugin'
 *      读 `.codex-plugin/plugin.json`，再扫其 skills/<名称>/SKILL.md。
 *
 * 版本选择：优先 manifest.version 与目录名一致者；否则按数字段比较取最大，
 * `0722921d` 这类 hash 目录排在数字版本之后。任何以 `.` 开头的目录都跳过。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { parseSkillFile } from './frontmatter.mjs'
import { readPluginManifest } from './manifest.mjs'
import { isInsideReal, resolveCodexRoot } from './paths.mjs'

const SKILL_FILE = 'SKILL.md'
const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|py|ps1|cmd|bat|mjs|cjs|js|ts|rb|pl)$/i
const PREVIEW_LENGTH = 160

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 递归列出目录内文件（相对 posix 路径，已排序）。 */
export function listFiles(root, { maxDepth = 8 } = {}) {
  const out = []
  const walk = (dir, prefix, depth) => {
    if (depth > maxDepth) return
    for (const entry of listDir(dir)) {
      const abs = join(dir, entry.name)
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        walk(abs, rel, depth + 1)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  walk(root, '', 0)
  return out.sort()
}

/** 目录内容摘要：sha256 + 总字节数（跳过超大文件的完整内容，只计入元数据）。 */
export function digestDirectory(dir, files = listFiles(dir)) {
  const hash = createHash('sha256')
  let sizeBytes = 0
  for (const rel of files) {
    const abs = join(dir, rel.split('/').join(sep))
    let size = 0
    try {
      size = statSync(abs).size
    } catch {
      continue
    }
    sizeBytes += size
    hash.update('f\0' + rel + '\0' + size + '\0')
    if (size <= 4 * 1024 * 1024) {
      try {
        hash.update(readFileSync(abs))
      } catch {
        hash.update('unreadable')
      }
    }
  }
  return { sha256: 'sha256:' + hash.digest('hex'), sizeBytes }
}

function scriptFilesOf(files) {
  return files.filter((rel) => SCRIPT_EXT.test(rel))
}

/** 版本比较：纯数字段按数值，hash 目录排后。 */
export function compareVersions(a, b) {
  const numeric = /^\d+(?:\.\d+)*$/
  const aNumeric = numeric.test(a)
  const bNumeric = numeric.test(b)
  if (aNumeric && !bNumeric) return 1
  if (!aNumeric && bNumeric) return -1
  if (aNumeric && bNumeric) {
    const left = a.split('.').map((part) => Number.parseInt(part, 10))
    const right = b.split('.').map((part) => Number.parseInt(part, 10))
    const length = Math.max(left.length, right.length)
    for (let i = 0; i < length; i += 1) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 在同一插件的多个版本目录中选一个。
 * @param {string[]} versions 目录名
 * @param {string} manifestVersion 首选（与目录名一致者优先）
 */
export function pickVersion(versions, manifestVersion = '') {
  const candidates = versions.filter((name) => !name.startsWith('.')).slice().sort(compareVersions)
  if (candidates.length === 0) return null
  const exact = candidates.find((name) => name === manifestVersion)
  if (exact !== undefined) return exact
  return candidates[candidates.length - 1]
}

/** 简单 glob：只支持 `*`。 */
function globMatch(text, pattern) {
  const haystack = String(text ?? '')
  if (!pattern.includes('*')) return haystack.toLowerCase().includes(pattern.toLowerCase())
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp('^' + source + '$', 'i').test(haystack)
}

function matchesAny(entry, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') return false
    const needles = [entry.name, entry.sourceName, entry.pluginName, entry.dir]
    return needles.some((value) => typeof value === 'string' && value !== '' && globMatch(value, pattern.trim()))
  })
}

/** 把一个原始来源补全成对外条目。 */
function finalizeEntry(entry, root) {
  const problems = [...entry.problems]
  const dir = entry.dir
  let name = entry.sourceName
  let description = ''
  let license = ''

  if (!entry.mcpOnly) {
    let text = ''
    try {
      text = readFileSync(join(dir, SKILL_FILE), 'utf8')
    } catch {
      problems.push('UNREADABLE_SKILL')
    }
    if (text !== '') {
      const parsed = parseSkillFile(text)
      name = parsed.name !== '' ? parsed.name : entry.sourceName
      description = parsed.description
      license = parsed.license
      for (const problem of parsed.problems) {
        if (problem === 'NO_NAME') continue
        if (!problems.includes(problem)) problems.push(problem)
      }
    }
    if (!isInsideReal(root, dir)) {
      problems.push('PATH_ESCAPE')
    }
  }

  const files = entry.mcpOnly ? [] : listFiles(dir)
  const digest = digestDirectory(dir, files)
  return {
    name,
    sourceName: entry.sourceName,
    kind: entry.kind,
    pluginName: entry.pluginName ?? null,
    pluginVersion: entry.pluginVersion ?? null,
    dir,
    hasScripts: scriptFilesOf(files).length > 0,
    scriptFiles: scriptFilesOf(files),
    mcpOnly: entry.mcpOnly === true,
    sizeBytes: digest.sizeBytes,
    sha256: digest.sha256,
    descriptionLength: [...description].length,
    descriptionPreview: [...description].slice(0, PREVIEW_LENGTH).join(''),
    license,
    fileCount: files.length,
    problems,
  }
}

function markCollisions(items) {
  const byName = new Map()
  for (const item of items) {
    if (item.mcpOnly) continue
    const bucket = byName.get(item.name) ?? []
    bucket.push(item)
    byName.set(item.name, bucket)
  }
  for (const bucket of byName.values()) {
    if (bucket.length < 2) continue
    for (const item of bucket) {
      if (!item.problems.includes('NAME_COLLISION')) item.problems.push('NAME_COLLISION')
    }
  }
}

function scanStandalone(root, entries) {
  const skillsDir = join(root, 'skills')
  if (!isDir(skillsDir)) return
  for (const dirent of listDir(skillsDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const dir = join(skillsDir, dirent.name)
    if (!existsSync(join(dir, SKILL_FILE))) continue
    entries.push({ kind: 'standalone', sourceName: dirent.name, dir, mcpOnly: false, problems: [] })
  }
}

function scanPlugins(root, entries, skipped) {
  const cacheDir = join(root, 'plugins', 'cache')
  if (!isDir(cacheDir)) return
  for (const market of listDir(cacheDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!market.isDirectory() || market.name.startsWith('.')) continue
    const marketDir = join(cacheDir, market.name)
    for (const plugin of listDir(marketDir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue
      const pluginDir = join(marketDir, plugin.name)
      const versions = listDir(pluginDir)
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => item.name)
      if (versions.length === 0) continue
      // 先读每个版本 manifest，用于"version 与目录名一致"优先与报错信息
      const manifests = new Map()
      for (const version of versions) {
        manifests.set(version, readPluginManifest(join(pluginDir, version)))
      }
      // 优先"目录名 == manifest.version"的版本；其中再取数字最大的那个
      const exactVersions = versions.filter((version) => manifests.get(version)?.manifest?.version === version)
      const chosen = pickVersion(exactVersions.length > 0 ? exactVersions : versions, undefined)
      if (chosen === null) continue
      const versionDir = join(pluginDir, chosen)
      const read = manifests.get(chosen) ?? readPluginManifest(versionDir)
      const manifest = read.manifest
      const pluginName = manifest?.name !== undefined && manifest.name !== '' ? manifest.name : plugin.name
      const skillsDir = join(versionDir, (manifest?.skills ?? './skills/').replace(/^\.\//, ''))
      const skillDirs = isDir(skillsDir)
        ? listDir(skillsDir)
            .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
            .map((item) => item.name)
            .filter((name) => existsSync(join(skillsDir, name, SKILL_FILE)))
            .sort()
        : []

      if (skillDirs.length === 0) {
        const hasMcp =
          existsSync(join(versionDir, '.mcp.json')) ||
          (manifest?.mcpServers !== undefined && manifest.mcpServers !== '')
        const problems = [...read.problems]
        // 不产技能条目：只记到顶层 problems，说明为什么跳过
        if (hasMcp) {
          problems.push('MCP_ONLY')
          skipped.push({
            name: plugin.name,
            code: 'MCP_ONLY',
            dir: versionDir,
            problems,
            message: `${plugin.name}@${chosen} 只有 MCP 配置，没有 skills/`,
          })
        } else if (problems.length === 0) {
          problems.push('NO_SKILLS')
          skipped.push({
            name: plugin.name,
            code: 'NO_SKILLS',
            dir: versionDir,
            problems,
            message: `${plugin.name}@${chosen} 没有 skills/ 目录`,
          })
        } else {
          skipped.push({
            name: plugin.name,
            code: problems[0],
            dir: versionDir,
            problems,
            message: `${plugin.name}@${chosen} 的 manifest 有问题：${problems.join(', ')}`,
          })
        }
        continue
      }

      for (const skillDirName of skillDirs) {
        const dir = join(skillsDir, skillDirName)
        entries.push({
          kind: 'plugin',
          sourceName: skillDirName,
          pluginName,
          pluginVersion: chosen,
          dir,
          mcpOnly: false,
          problems: [...read.problems],
        })
      }
    }
  }
}

/**
 * 扫描 Codex 根目录。
 * @param {{ codexRoot?: string, include?: string[], exclude?: string[] }} options
 * @returns {{ root: string, total: number, items: object[], problems: object[] }}
 */
export function discover(options = {}) {
  const root = resolveCodexRoot(options.codexRoot)
  if (!isDir(root)) {
    return { root, total: 0, items: [], problems: [{ name: '', code: 'ROOT_MISSING', dir: root, message: `codexRoot 不存在：${root}` }] }
  }
  const entries = []
  const skipped = []
  scanStandalone(root, entries)
  scanPlugins(root, entries, skipped)

  const hasExclude = Array.isArray(options.exclude) && options.exclude.length > 0
  const keep = (entry) => matchesAny(entry, options.include) && !(hasExclude && matchesAny(entry, options.exclude))
  const filtered = entries.filter(keep)
  const items = filtered.map((entry) => finalizeEntry(entry, root))
  markCollisions(items)
  const problems = skipped
    .filter(keep)
    .map((entry) => ({ name: entry.name, code: entry.code, dir: entry.dir, message: entry.message, problems: entry.problems }))
  return { root, total: items.length, items, problems }
}

/** 相对 root 的展示路径（用于报告）。 */
export function displayPath(root, target) {
  const rel = relative(root, target)
  return rel === '' ? basename(root) : rel
}
