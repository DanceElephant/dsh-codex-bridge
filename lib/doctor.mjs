/**
 * 体检：不执行任何被导入的脚本，只做只读探测。
 *
 * `which` 用纯 JS 扫 PATH 实现（语义等价、不 spawn、跨平台一致）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { codepointLength } from './describe.mjs'
import { DEFAULT_MAX_DESCRIPTION } from './importer.mjs'
import { lockPath, readLock, removeImports, writeLock } from './lockfile.mjs'
import { resolveCodexRoot, resolveTargetDir } from './paths.mjs'

/** 从 SKILL.md 正文里提取可能需要的命令行工具名。 */
const BINARY_PATTERN = /\b(playwright-cli|pandoc|ffmpeg|magick|pdftotext|jq|rg|python3|node|npx|git)\b/g

export function collectBinaryHints(text) {
  const found = new Set()
  for (const match of String(text ?? '').matchAll(BINARY_PATTERN)) found.add(match[1])
  return [...found].sort()
}

/** 纯 JS 版 which：扫 PATH，返回绝对路径或 null。 */
export function which(bin, env = process.env) {
  const name = String(bin ?? '').trim()
  if (name === '') return null
  if (name.includes('/') || name.includes('\\')) {
    try {
      return statSync(name).isFile() ? name : null
    } catch {
      return null
    }
  }
  const pathValue = env.PATH ?? ''
  const suffixes = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* 继续下一个目录 */
      }
    }
  }
  return null
}

function probeWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.codex-skill-bridge-probe-${process.pid}`)
    writeFileSync(probe, 'ok', { flag: 'wx' })
    unlinkSync(probe)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 校验单个锁条目是否还能重放。 */
function checkEntry(entry, targetDir, maxDescription) {
  const problems = []
  const skillFile = entry.sourcePath === '' ? '' : join(entry.sourcePath, 'SKILL.md')
  if (entry.sourcePath === '' || !existsSync(entry.sourcePath)) {
    problems.push({ code: 'STALE_PATH', message: `源目录不存在：${entry.sourcePath}` })
  } else if (!existsSync(skillFile)) {
    problems.push({ code: 'STALE_PATH', message: `SKILL.md 不存在：${skillFile}` })
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
    problems.push({ code: 'BAD_ENTRY_NAME', message: `技能名不合法：${entry.name}` })
  }
  if (entry.mode === 'snapshot' && !existsSync(join(targetDir, entry.name))) {
    problems.push({ code: 'SNAPSHOT_MISSING', message: `快照目录不存在：${join(targetDir, entry.name)}` })
  }
  const length = codepointLength(entry.description)
  if (length > maxDescription) {
    problems.push({ code: 'OVER_BUDGET', message: `${entry.name} 的描述 ${length} > ${maxDescription}` })
  }
  return problems
}

/**
 * @returns {{ ok: boolean, data: object }}
 */
export function doctor(options = {}) {
  const root = resolveCodexRoot(options.codexRoot)
  const targetDir = resolveTargetDir(options.targetDir)
  const fix = options.fix === true
  const maxDescription = Number.isFinite(options.maxDescription) ? Number(options.maxDescription) : DEFAULT_MAX_DESCRIPTION

  const problems = []
  const missingBinaries = []
  const stalePaths = []
  const overBudget = []

  if (!existsSync(root)) {
    problems.push({ code: 'CODEX_ROOT_MISSING', message: `codexRoot 不存在：${root}`, fixable: false })
  }
  const { lock, problems: lockProblems } = readLock(targetDir)
  for (const problem of lockProblems) {
    problems.push({ code: problem, message: `锁文件异常：${problem}`, fixable: false })
  }
  const writeError = probeWritable(targetDir)
  if (writeError !== null) {
    problems.push({ code: 'TARGET_NOT_WRITABLE', message: `targetDir 不可写：${writeError}`, fixable: false })
  }

  const entries = []
  for (const entry of lock.imports) {
    const entryProblems = checkEntry(entry, targetDir, maxDescription)
    for (const problem of entryProblems) {
      problems.push({ ...problem, name: entry.name, fixable: problem.code === 'STALE_PATH' })
      if (problem.code === 'STALE_PATH') stalePaths.push({ name: entry.name, path: entry.sourcePath, reason: problem.message })
      if (problem.code === 'OVER_BUDGET') {
        overBudget.push({ name: entry.name, length: codepointLength(entry.description), max: maxDescription })
      }
    }
    entries.push({
      name: entry.name,
      mode: entry.mode,
      sourcePath: entry.sourcePath,
      descriptionLength: codepointLength(entry.description),
      problems: entryProblems.map((problem) => problem.code),
      replayable: !entryProblems.some((problem) => problem.code === 'STALE_PATH'),
    })
  }

  const hints = new Set(
    (Array.isArray(options.binaries) ? options.binaries : []).map((item) => String(item)),
  )
  for (const entry of lock.imports) {
    const skillFile = join(entry.sourcePath, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      for (const hint of collectBinaryHints(readFileSync(skillFile, 'utf8'))) hints.add(hint)
    } catch {
      /* 读不到就跳过 */
    }
  }
  for (const binary of [...hints].sort()) {
    if (which(binary) === null) missingBinaries.push(binary)
  }

  const fixed = []
  if (fix && stalePaths.length > 0) {
    const names = [...new Set(stalePaths.map((item) => item.name))]
    const next = removeImports(lock, names).lock
    writeLock(targetDir, next)
    fixed.push(...names)
  }

  return {
    ok: true,
    data: {
      root,
      targetDir,
      lockPath: lockPath(targetDir),
      healthy: problems.length === 0,
      entries,
      problems,
      missingBinaries,
      stalePaths,
      overBudget,
      fixed,
      fixApplied: fix && fixed.length > 0,
      nodeVersion: process.version,
      platform: process.platform,
    },
  }
}
