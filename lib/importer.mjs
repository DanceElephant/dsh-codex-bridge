/**
 * 导入 / 卸载 / 检视。
 *
 * 两种模式：
 *   reference（默认）：不复制文件，resourceBase.path 直接指向 ~/.codex/skills/<name>。
 *     理由：playwright/SKILL.md 里写死 `$CODEX_HOME`，复制会让脚本路径失效。
 *   snapshot：复制到 <targetDir>/<name>/，保留 LICENSE/NOTICE，跳过 assets/ 里 >1MB 的
 *     二进制，并把正文里的 CODEX_HOME 路径改写成新路径（改写记录进锁文件 rewrites）。
 *
 * 导入的脚本一律只登记路径，绝不执行。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { compressDescription, codepointLength } from './describe.mjs'
import { digestDirectory, discover, listFiles } from './discover.mjs'
import { parseSkillFile } from './frontmatter.mjs'
import {
  assertInside,
  isInside,
  isInsideReal,
  resolveCodexRoot,
  resolveTargetDir,
} from './paths.mjs'
import { findImport, lockPath, readLock, removeImports, upsertImport, writeLock } from './lockfile.mjs'

export const DEFAULT_MAX_DESCRIPTION = 220
export const CONFLICT_POLICIES = ['prefix', 'skip', 'overwrite']
export const IMPORT_MODES = ['reference', 'snapshot']

const TEXT_EXT = /\.(?:md|markdown|txt|sh|bash|zsh|fish|py|ps1|cmd|bat|mjs|cjs|js|ts|json|yaml|yml|toml|ini|cfg|conf|html|css|xml|csv|svg)$/i
const SKIP_SEGMENTS = new Set(['.git', 'node_modules', '.DS_Store'])
const MAX_ASSET_BYTES = 1024 * 1024

/** 名称规范化：lower + kebab-case；空则 `codex-skill`。 */
export function normalizeSkillName(raw) {
  const collapsed = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return collapsed === '' ? 'codex-skill' : collapsed
}

/** 冲突裁决：prefix（默认）/ skip / overwrite。 */
export function resolveTargetName(base, taken, onConflict = 'prefix') {
  if (!taken.has(base)) return { name: base, action: 'create' }
  if (onConflict === 'skip') return { name: base, action: 'skip' }
  if (onConflict === 'overwrite') return { name: base, action: 'overwrite' }
  let candidate = 'codex-' + base
  let counter = 2
  while (taken.has(candidate)) {
    candidate = `codex-${base}-${counter}`
    counter += 1
  }
  return { name: candidate, action: 'create' }
}

function isTextFile(relPath, size) {
  return TEXT_EXT.test(relPath) && size <= 512 * 1024
}

function shouldCopy(relPath, size) {
  if (relPath.split('/').some((segment) => SKIP_SEGMENTS.has(segment))) return false
  if (relPath.startsWith('assets/') && size > MAX_ASSET_BYTES) return false
  if (relPath.startsWith('assets/') && /\.(?:png|jpe?g|gif|webp|ico|zip|tgz|gz|tar|pdf|woff2?)$/i.test(relPath)) {
    if (size > MAX_ASSET_BYTES) return false
  }
  return true
}

/** 把 snapshot 副本里的 CODEX_HOME 路径改写成新路径。 */
function rewriteSnapshot(destDir, sourceDir, sourceName) {
  const rewrites = []
  const patterns = [
    { from: '${CODEX_HOME:-$HOME/.codex}/skills/' + sourceName, to: destDir },
    { from: '$CODEX_HOME/skills/' + sourceName, to: destDir },
    { from: '$HOME/.codex/skills/' + sourceName, to: destDir },
    { from: '~/.codex/skills/' + sourceName, to: destDir },
    { from: sourceDir, to: destDir },
  ]
  for (const rel of listFiles(destDir)) {
    const abs = join(destDir, rel.split('/').join('/'))
    let size
    try {
      size = statSync(abs).size
    } catch {
      continue
    }
    if (!isTextFile(rel, size)) continue
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    let next = text
    for (const pattern of patterns) {
      if (!next.includes(pattern.from)) continue
      const count = next.split(pattern.from).length - 1
      next = next.split(pattern.from).join(pattern.to)
      if (!rewrites.some((item) => item.file === rel && item.from === pattern.from)) {
        rewrites.push({ file: rel, from: pattern.from, to: pattern.to, count })
      }
    }
    if (next !== text) writeFileSync(abs, next)
  }
  return rewrites
}

/** 复制一份 snapshot，返回文件清单与改写记录。 */
export function createSnapshot(sourceDir, destDir, sourceName, targetDir) {
  assertInside(targetDir, destDir, 'snapshot')
  if (isInside(destDir, targetDir) && resolve(destDir) === resolve(targetDir)) {
    throw new Error('snapshot 目标不能是 targetDir 自身')
  }
  if (existsSync(destDir)) {
    if (!isInsideReal(targetDir, destDir)) {
      throw new Error('snapshot 目标越界：' + destDir)
    }
    rmSync(destDir, { recursive: true, force: true })
  }
  mkdirSync(destDir, { recursive: true })
  const copied = []
  for (const rel of listFiles(sourceDir)) {
    const from = join(sourceDir, rel)
    let size = 0
    try {
      size = statSync(from).size
    } catch {
      continue
    }
    if (!shouldCopy(rel, size)) continue
    const to = join(destDir, rel)
    mkdirSync(join(to, '..'), { recursive: true })
    copyFileSync(from, to)
    copied.push(rel)
  }
  const rewrites = rewriteSnapshot(destDir, sourceDir, sourceName)
  return { files: copied, rewrites }
}

function fail(request, code, message) {
  return { request, ok: false, code, message, willImport: false, action: 'reject' }
}

/** 在被跳过的插件（只有 MCP、没有 skills）里找请求项，用于给出准确拒绝原因。 */
function findSkipped(problems, request) {
  const wanted = String(request ?? '').trim().toLowerCase()
  if (wanted === '') return null
  for (const problem of problems) {
    const candidates = [problem.name, problem.dir ? basename(problem.dir) : '']
    if (candidates.some((value) => String(value ?? '').toLowerCase() === wanted)) return problem
  }
  for (const problem of problems) {
    if (String(problem.dir ?? '') !== '' && resolve(problem.dir) === resolve(wanted)) return problem
  }
  return null
}

function findEntry(items, request) {
  const wanted = String(request ?? '').trim()
  if (wanted === '') return null
  const lower = wanted.toLowerCase()
  const byPath = wanted.includes('/') || wanted.startsWith('~') || wanted.startsWith('.')
  if (byPath) {
    const absolute = resolve(wanted.startsWith('~') ? wanted.replace('~', process.env.HOME ?? '') : wanted)
    const found = items.find((item) => resolve(item.dir) === absolute)
    if (found !== undefined) return found
  }
  return (
    items.find((item) => item.name.toLowerCase() === lower) ??
    items.find((item) => item.sourceName.toLowerCase() === lower) ??
    items.find((item) => `${item.pluginName ?? ''}/${item.sourceName}`.toLowerCase() === lower) ??
    null
  )
}

function rejectReason(item) {
  if (item.mcpOnly) return { code: 'MCP_ONLY', message: `${item.sourceName} 只有 MCP 配置，没有可导入的技能` }
  if (item.problems.includes('PATH_ESCAPE')) return { code: 'PATH_ESCAPE', message: `${item.dir} 在 codexRoot 之外` }
  if (item.problems.includes('UNREADABLE_SKILL')) return { code: 'UNREADABLE_SKILL', message: `${item.dir}/SKILL.md 不可读` }
  if (item.problems.includes('NO_FRONTMATTER')) return { code: 'NO_FRONTMATTER', message: `${item.sourceName} 缺少 frontmatter` }
  if (item.problems.includes('EMPTY_DESCRIPTION')) return { code: 'EMPTY_DESCRIPTION', message: `${item.sourceName} 的 description 为空` }
  return null
}

/**
 * 规划并（可选）执行导入。
 * @returns {{ ok: boolean, code?: string, message?: string, data?: object }}
 */
export function importSkills(options = {}) {
  const root = resolveCodexRoot(options.codexRoot)
  const targetDir = resolveTargetDir(options.targetDir)
  const mode = IMPORT_MODES.includes(options.mode) ? options.mode : 'reference'
  const onConflict = CONFLICT_POLICIES.includes(options.onConflict) ? options.onConflict : 'prefix'
  const confirm = options.confirm === true
  const dryRun = typeof options.dryRun === 'boolean' ? options.dryRun : !confirm
  const write = confirm && !dryRun
  const maxDescription = Number.isFinite(options.maxDescription) ? Number(options.maxDescription) : DEFAULT_MAX_DESCRIPTION
  const now = typeof options.now === 'string' ? options.now : new Date().toISOString()
  const requests = Array.isArray(options.names) ? options.names.map((name) => String(name).trim()).filter((name) => name !== '') : []
  if (requests.length === 0) {
    return { ok: false, code: 'NO_NAMES', message: '至少需要一个技能名（name / sourceName / 路径）' }
  }

  const scan = discover({ codexRoot: root })
  const { lock: current } = readLock(targetDir)
  const taken = new Set([...current.imports.map((item) => item.name), ...(Array.isArray(options.reserved) ? options.reserved : [])])

  const planned = []
  const failed = []
  for (const request of requests) {
    const item = findEntry(scan.items, request)
    if (item === null) {
      const skippedEntry = findSkipped(scan.problems, request)
      if (skippedEntry !== null) {
        failed.push(fail(request, skippedEntry.code, skippedEntry.message))
      } else {
        failed.push(fail(request, 'NOT_FOUND', `未找到技能：${request}`))
      }
      continue
    }
    const rejected = rejectReason(item)
    if (rejected !== null) {
      failed.push(fail(request, rejected.code, rejected.message))
      continue
    }
    let parsed
    try {
      parsed = parseSkillFile(readFileSync(join(item.dir, 'SKILL.md'), 'utf8'))
    } catch {
      failed.push(fail(request, 'UNREADABLE_SKILL', `${item.dir}/SKILL.md 不可读`))
      continue
    }
    if (parsed.content.trim() === '') {
      failed.push(fail(request, 'EMPTY_CONTENT', `${item.sourceName} 的正文为空`))
      continue
    }
    const base = normalizeSkillName(item.name)
    // 同一个上游、同一个 hash、同一种模式：无论冲突策略如何都应判 noop，
    // 否则 prefix 策略会把"重复导入自己"误判成新冲突并改名。
    const existing = findImport(current, base)
    const sameSource = existing !== null && existing.hash === item.sha256 && existing.sourcePath === item.dir
    if (sameSource && existing.mode === mode) {
      planned.push({
        request,
        ok: true,
        name: existing.name,
        sourceName: item.sourceName,
        sourcePath: item.dir,
        sourceKind: item.kind,
        sourceVersion: item.pluginVersion,
        mode,
        hash: item.sha256,
        description: existing.description,
        longDescription: existing.longDescription,
        files: existing.files,
        rewrites: existing.rewrites ?? [],
        action: 'noop',
        willImport: false,
        message: '已导入且上游未变化',
      })
      continue
    }
    const resolvedName = resolveTargetName(base, taken, onConflict)
    if (resolvedName.action === 'skip') {
      planned.push({
        request,
        ok: true,
        name: resolvedName.name,
        sourceName: item.sourceName,
        sourcePath: item.dir,
        sourceKind: item.kind,
        sourceVersion: item.pluginVersion,
        mode,
        hash: item.sha256,
        description: '',
        longDescription: '',
        files: [],
        rewrites: [],
        action: 'skip',
        willImport: false,
        message: '同名已存在，按 onConflict=skip 跳过',
      })
      continue
    }
    const description = compressDescription(parsed.description, maxDescription)
    if (description === '') {
      failed.push(fail(request, 'EMPTY_DESCRIPTION', `${item.sourceName} 的 description 压缩后为空`))
      continue
    }
    taken.add(resolvedName.name)
    planned.push({
      request,
      ok: true,
      name: resolvedName.name,
      sourceName: item.sourceName,
      sourcePath: item.dir,
      sourceKind: item.kind,
      sourceVersion: item.pluginVersion,
      pluginName: item.pluginName,
      mode,
      hash: item.sha256,
      description,
      descriptionLength: codepointLength(description),
      longDescription: parsed.description,
      files: mode === 'snapshot' ? [] : listFiles(item.dir),
      rewrites: [],
      action: resolvedName.action,
      willImport: true,
    })
  }

  const result = {
    targetDir,
    root,
    mode,
    onConflict,
    dryRun,
    wrote: write,
    lockPath: lockPath(targetDir),
    planned,
    applied: [],
    failed,
  }

  if (!write) {
    return { ok: failed.length === 0, data: result }
  }

  let lock = current
  for (const plan of planned) {
    if (plan.willImport !== true) continue
    try {
      if (plan.action === 'overwrite') {
        const previous = findImport(lock, plan.name)
        if (previous !== null && previous.mode === 'snapshot') {
          const stale = join(targetDir, plan.name)
          if (isInsideReal(targetDir, stale) && resolve(stale) !== resolve(targetDir)) {
            rmSync(stale, { recursive: true, force: true })
          }
        }
      }
      if (mode === 'snapshot') {
        const dest = join(targetDir, plan.name)
        const snapshot = createSnapshot(plan.sourcePath, dest, plan.sourceName, targetDir)
        plan.files = snapshot.files
        plan.rewrites = snapshot.rewrites
      }
      const entry = {
        name: plan.name,
        sourceName: plan.sourceName,
        sourcePath: plan.sourcePath,
        sourceKind: plan.sourceKind,
        sourceVersion: plan.sourceVersion ?? null,
        hash: plan.hash,
        mode: plan.mode,
        description: plan.description,
        longDescription: plan.longDescription,
        files: plan.files,
        importedAt: now,
        ...(plan.pluginName !== undefined ? { pluginName: plan.pluginName } : {}),
        ...(plan.rewrites.length > 0 ? { rewrites: plan.rewrites } : {}),
      }
      lock = upsertImport(lock, entry)
      writeLock(targetDir, lock)
      result.applied.push({ name: plan.name, mode: plan.mode, files: plan.files.length, rewrites: plan.rewrites.length })
    } catch (error) {
      failed.push({
        request: plan.request,
        ok: false,
        code: 'IMPORT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        willImport: false,
        action: 'reject',
      })
    }
  }

  return { ok: failed.length === 0, data: result }
}

/**
 * 检视单个技能（不落库）。
 * @returns {{ ok: boolean, code?: string, message?: string, data?: object }}
 */
export function inspectEntry(options = {}) {
  const root = resolveCodexRoot(options.codexRoot)
  const request = String(options.name ?? options.path ?? '').trim()
  if (request === '') {
    return { ok: false, code: 'NO_TARGET', message: '需要 name 或 path' }
  }
  const scan = discover({ codexRoot: root })
  const item = findEntry(scan.items, request)
  if (item === null) {
    const skippedEntry = findSkipped(scan.problems, request)
    if (skippedEntry !== null) {
      return {
        ok: true,
        data: {
          name: request,
          sourceName: request,
          kind: 'plugin',
          dir: skippedEntry.dir,
          importable: false,
          reason: skippedEntry.code,
          problems: skippedEntry.problems ?? [skippedEntry.code],
          description: '',
          content: '',
          willInject: '',
          scriptFiles: [],
          message: skippedEntry.message,
        },
      }
    }
    return { ok: false, code: 'NOT_FOUND', message: `未找到技能：${request}` }
  }
  if (item.mcpOnly) {
    return {
      ok: true,
      data: {
        ...item,
        description: '',
        content: '',
        willInject: '',
        contentLength: 0,
        importable: false,
        rejectCode: 'MCP_ONLY',
      },
    }
  }
  let parsed = { name: '', description: '', license: '', metadata: {}, content: '', problems: [] }
  try {
    parsed = parseSkillFile(readFileSync(join(item.dir, 'SKILL.md'), 'utf8'))
  } catch {
    return { ok: false, code: 'UNREADABLE_SKILL', message: `${item.dir}/SKILL.md 不可读` }
  }
  return {
    ok: true,
    data: {
      ...item,
      name: parsed.name !== '' ? parsed.name : item.name,
      description: parsed.description,
      license: parsed.license || item.license,
      metadata: parsed.metadata,
      contentLength: [...parsed.content].length,
      content: parsed.content,
      willInject: [...parsed.content].slice(0, 500).join(''),
      importable: !item.mcpOnly && parsed.content.trim() !== '',
    },
  }
}

/** 已导入清单 + 上游变化比对。 */
export function listImports(options = {}) {
  const targetDir = resolveTargetDir(options.targetDir)
  const root = resolveCodexRoot(options.codexRoot)
  const { lock, problems } = readLock(targetDir)
  const items = lock.imports.map((entry) => {
    const sourceExists = entry.sourcePath !== '' && existsSync(entry.sourcePath)
    let upstreamChanged = false
    let currentHash = ''
    if (sourceExists) {
      try {
        currentHash = digestDirectory(entry.sourcePath, listFiles(entry.sourcePath)).sha256
        upstreamChanged = currentHash !== entry.hash
      } catch {
        upstreamChanged = true
      }
    }
    return {
      ...entry,
      sourceExists,
      upstreamChanged,
      upstreamMissing: !sourceExists,
      descriptionLength: codepointLength(entry.description),
    }
  })
  return {
    ok: true,
    data: { targetDir, root, lockPath: lockPath(targetDir), total: items.length, items, problems },
  }
}

/** 卸载（可选清理 snapshot 副本；reference 模式绝不删除上游）。 */
export function removeSkills(options = {}) {
  const targetDir = resolveTargetDir(options.targetDir)
  const names = Array.isArray(options.names) ? options.names.map((name) => String(name).trim()).filter((name) => name !== '') : []
  if (names.length === 0) {
    return { ok: false, code: 'NO_NAMES', message: '至少需要一个技能名' }
  }
  const { lock: current, problems } = readLock(targetDir)
  const removed = []
  const purged = []
  const failed = []
  for (const name of names) {
    const entry = findImport(current, name)
    if (entry === null) {
      failed.push({ name, ok: false, code: 'NOT_IMPORTED', message: `锁文件里没有 ${name}` })
      continue
    }
    if (options.purge === true && entry.mode === 'snapshot') {
      const dest = join(targetDir, name)
      if (!isInsideReal(targetDir, dest) || resolve(dest) === resolve(targetDir)) {
        failed.push({ name, ok: false, code: 'PATH_ESCAPE', message: `拒绝删除 ${dest}` })
        continue
      }
      rmSync(dest, { recursive: true, force: true })
      purged.push(name)
    }
    removed.push(name)
  }
  if (removed.length > 0) {
    const next = removeImports(current, removed).lock
    writeLock(targetDir, next)
  }
  return {
    ok: failed.length === 0,
    data: {
      targetDir,
      lockPath: lockPath(targetDir),
      removed,
      purged,
      failed,
      purgedNote:
        options.purge === true
          ? 'reference 模式的源目录不会被删除（只清理 snapshot 副本）'
          : '未启用 purge：只注销，不删除任何文件',
      problems,
    },
  }
}

/** 相对路径（用于报告）。 */
export function relativeTo(root, target) {
  return relative(root, target)
}
