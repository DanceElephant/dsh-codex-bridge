/**
 * 路径工具：codexRoot 展开与"越界即拒绝"校验。
 *
 * 安全约束（提示词第 1 节第 5 条）：插件只读 codexRoot 之内的内容。
 * 任何由外部输入拼出的路径，在 fs 操作之前都必须经过 assertInside 校验。
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 带稳定错误码的插件错误。 */
export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/** 把 `~` / `~/x` 展开为绝对路径；其他写法原样返回。 */
export function expandHome(input) {
  if (typeof input !== 'string') {
    throw new BridgeError('INVALID_PATH', '路径必须是字符串')
  }
  const raw = input.trim()
  if (raw === '') {
    throw new BridgeError('INVALID_PATH', '路径不能为空')
  }
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/** 解析 Codex 根目录（默认 ~/.codex），返回绝对路径。 */
export function resolveCodexRoot(input) {
  return resolve(expandHome(input ?? '~/.codex'))
}

/** 解析写入目录（默认 ~/.dsh/codex-bridge），返回绝对路径。 */
export function resolveTargetDir(input) {
  return resolve(expandHome(input ?? '~/.dsh/codex-bridge'))
}

/** 词法判定 target 是否位于 root 之内（含 root 自身）。 */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 真实路径判定：存在时用 realpath 再比一次，挡住符号链接逃逸。 */
export function isInsideReal(root, target) {
  if (!isInside(root, target)) return false
  try {
    const realRoot = realpathSync(resolve(root))
    const realTarget = realpathSync(resolve(target))
    return isInside(realRoot, realTarget)
  } catch {
    // 目标不存在时退回词法结论
    return true
  }
}

/** 越界即抛 PATH_ESCAPE。 */
export function assertInside(root, target, label = 'path') {
  const abs = resolve(target)
  if (!isInside(root, abs)) {
    throw new BridgeError('PATH_ESCAPE', `${label} 越界：${abs} 不在 ${resolve(root)} 之内`)
  }
  return abs
}

/** 在 root 下安全拼接子路径。 */
export function safeJoin(root, ...parts) {
  return assertInside(root, resolve(root, ...parts), parts.join('/'))
}
