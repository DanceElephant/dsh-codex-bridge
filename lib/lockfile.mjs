/**
 * 锁文件 `<targetDir>/.bridge.json` 的读写。
 *
 * 写入必须原子：先写同目录临时文件并 fsync，再 rename 覆盖；
 * 失败时清理临时文件，绝不留下半截锁文件。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = '.bridge.json'
export const LOCK_VERSION = 1

/** `<targetDir>/.bridge.json` */
export function lockPath(targetDir) {
  return join(targetDir, LOCK_FILE)
}

/** 空锁。 */
export function emptyLock() {
  return { version: LOCK_VERSION, imports: [], rewrites: [] }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 规范化单条 import，缺字段的补默认值。 */
export function normalizeImport(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.name !== 'string' || value.name.trim() === '') return null
  return {
    name: value.name.trim(),
    sourceName: typeof value.sourceName === 'string' ? value.sourceName : value.name,
    sourcePath: typeof value.sourcePath === 'string' ? value.sourcePath : '',
    sourceKind: typeof value.sourceKind === 'string' ? value.sourceKind : 'standalone',
    sourceVersion: typeof value.sourceVersion === 'string' ? value.sourceVersion : null,
    hash: typeof value.hash === 'string' ? value.hash : '',
    mode: value.mode === 'snapshot' ? 'snapshot' : 'reference',
    description: typeof value.description === 'string' ? value.description : '',
    longDescription: typeof value.longDescription === 'string' ? value.longDescription : '',
    files: asArray(value.files).filter((item) => typeof item === 'string'),
    importedAt: typeof value.importedAt === 'string' ? value.importedAt : '',
    ...(typeof value.pluginName === 'string' ? { pluginName: value.pluginName } : {}),
    ...(Array.isArray(value.rewrites) ? { rewrites: value.rewrites } : {}),
  }
}

/**
 * 读锁文件。缺失 = 空锁；损坏 = 空锁 + problems（调用方决定是否告警）。
 * @returns {{ lock: { version: number, imports: object[] }, problems: string[] }}
 */
export function readLock(targetDir) {
  const path = lockPath(targetDir)
  if (!existsSync(path)) {
    return { lock: emptyLock(), problems: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { lock: emptyLock(), problems: ['LOCK_UNREADABLE'] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { lock: emptyLock(), problems: ['LOCK_INVALID'] }
  }
  const imports = asArray(parsed.imports).map(normalizeImport).filter((item) => item !== null)
  const deduped = []
  const seen = new Set()
  for (const item of imports) {
    if (seen.has(item.name)) continue
    seen.add(item.name)
    deduped.push(item)
  }
  return { lock: { version: LOCK_VERSION, imports: deduped, rewrites: asArray(parsed.rewrites) }, problems: [] }
}

/** 原子写锁文件。 */
export function writeLock(targetDir, lock) {
  mkdirSync(targetDir, { recursive: true })
  const path = lockPath(targetDir)
  const temp = join(targetDir, `${LOCK_FILE}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`)
  const payload = JSON.stringify(
    {
      version: LOCK_VERSION,
      imports: asArray(lock?.imports).map(normalizeImport).filter((item) => item !== null),
      ...(Array.isArray(lock?.rewrites) && lock.rewrites.length > 0 ? { rewrites: lock.rewrites } : {}),
    },
    null,
    2,
  ) + '\n'
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
    try { unlinkSync(temp) } catch { /* 临时文件可能不存在 */ }
    throw error
  }
  return path
}

/** 插入或替换一条 import（同名覆盖），返回新锁。 */
export function upsertImport(lock, entry) {
  const items = asArray(lock?.imports).filter((item) => item.name !== entry.name)
  items.push(entry)
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { version: LOCK_VERSION, imports: items, rewrites: asArray(lock?.rewrites) }
}

/** 删除若干条 import，返回新锁与删除项。 */
export function removeImports(lock, names) {
  const wanted = new Set(asArray(names).map((name) => String(name)))
  const removed = asArray(lock?.imports).filter((item) => wanted.has(item.name))
  const imports = asArray(lock?.imports).filter((item) => !wanted.has(item.name))
  return { lock: { version: LOCK_VERSION, imports, rewrites: asArray(lock?.rewrites) }, removed }
}

/** 按名字查一条 import。 */
export function findImport(lock, name) {
  return asArray(lock?.imports).find((item) => item.name === name) ?? null
}
