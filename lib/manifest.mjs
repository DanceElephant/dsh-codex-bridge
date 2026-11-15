/**
 * `.codex-plugin/plugin.json` 读取与规范化。
 *
 * manifest 位置固定为 `<version>/.codex-plugin/plugin.json`（提示词 0 节已核实）。
 * 读取失败绝不抛异常：返回 ok:false + problems。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_DIR = '.codex-plugin'
export const MANIFEST_FILE = 'plugin.json'

/** `<pluginDir>/.codex-plugin/plugin.json` */
export function manifestPath(pluginDir) {
  return join(pluginDir, MANIFEST_DIR, MANIFEST_FILE)
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()) : []
}

/**
 * 规范化 manifest 里插件真正需要的字段。
 * `skills` 缺省为 './skills/'（Codex 默认布局）。
 */
export function normalizeManifest(value) {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const face = raw.interface !== null && typeof raw.interface === 'object' ? raw.interface : {}
  return {
    name: asString(raw.name),
    version: asString(raw.version),
    description: asString(raw.description),
    license: asString(raw.license),
    homepage: asString(raw.homepage),
    keywords: asStringArray(raw.keywords),
    skills: typeof raw.skills === 'string' && raw.skills.trim() !== '' ? raw.skills.trim() : './skills/',
    mcpServers: asString(raw.mcpServers),
    displayName: asString(face.displayName),
    category: asString(face.category),
  }
}

/**
 * 读取插件 manifest。
 * @returns {{ ok: boolean, path: string, manifest: object|null, problems: string[] }}
 */
export function readPluginManifest(pluginDir) {
  const path = manifestPath(pluginDir)
  if (!existsSync(path)) {
    return { ok: false, path, manifest: null, problems: ['NO_MANIFEST'] }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ok: false, path, manifest: null, problems: ['INVALID_MANIFEST'] }
  }
  return { ok: true, path, manifest: normalizeManifest(parsed), problems: [] }
}
