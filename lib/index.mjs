/**
 * dsh-codex-skill-bridge —— 把本机 Codex 的技能导入 DSH 技能体系。
 *
 * 启动时重放锁文件里的导入项：description 用锁文件里已压缩的值（不再受上游改动影响），
 * 正文从磁盘上的 SKILL.md 现读（上游修正正文能即时生效）。任何单条失败只 warn。
 *
 * config.autoReplay === false 时只注册工具、不重放技能：工具在，`codex_list` 还能查，
 * 但本次启动不往会话里注入技能（调试「这条技能到底影响了我什么」时很有用）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codepointLength } from './describe.mjs'
import { DEFAULT_MAX_DESCRIPTION } from './importer.mjs'
import { parseSkillFile } from './frontmatter.mjs'
import { lockPath, readLock } from './lockfile.mjs'
import { resolveTargetDir } from './paths.mjs'
import { createTools, TOOL_NAMES } from './tools.mjs'

export const name = 'dsh-codex-skill-bridge'
export const inject = ['tools', 'skills']
export { TOOL_NAMES }

/** 同一个 ctx 上重复 apply 时先撤销上一轮，避免重复注册。 */
const applied = new WeakMap()

function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`[codex-skill-bridge] ${message}`)
  } catch {
    /* 日志本身不该拖垮启动 */
  }
}

/** 读锁文件并注册技能，返回 { registered, skipped, total, disposers }。 */
export function replaySkills(ctx, config = {}) {
  const summary = { total: 0, registered: 0, skipped: 0, lockPath: '', disposers: [] }
  const targetDir = resolveTargetDir(config.targetDir)
  summary.lockPath = lockPath(targetDir)
  if (!existsSync(summary.lockPath)) return summary

  const { lock, problems } = readLock(targetDir)
  for (const problem of problems) warn(ctx, `锁文件问题：${problem}`)
  summary.total = lock.imports.length
  if (lock.imports.length === 0) return summary

  const maxDescription = Number.isFinite(config.maxDescription) ? Number(config.maxDescription) : DEFAULT_MAX_DESCRIPTION
  const skills = ctx?.skills
  if (typeof skills?.register !== 'function') {
    warn(ctx, 'skills 服务不可用，跳过技能重放')
    summary.skipped = lock.imports.length
    return summary
  }

  for (const entry of lock.imports) {
    try {
      const entryName = typeof entry.name === 'string' ? entry.name : ''
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath : ''
      if (entryName === '' || description === '') {
        warn(ctx, `条目缺少 name/description，跳过：${entryName || '(unnamed)'}`)
        summary.skipped += 1
        continue
      }
      const length = codepointLength(description)
      if (length > maxDescription) {
        warn(ctx, `描述超出注入预算（${length} > ${maxDescription}），跳过 ${entryName}；可跑 codex_doctor 查看或重新导入`)
        summary.skipped += 1
        continue
      }
      const skillFile = join(sourcePath, 'SKILL.md')
      if (sourcePath === '' || !existsSync(skillFile)) {
        warn(ctx, `上游已不存在，跳过 ${entryName}：${skillFile}`)
        summary.skipped += 1
        continue
      }
      const parsed = parseSkillFile(readFileSync(skillFile, 'utf8'))
      if (parsed.content.trim() === '') {
        warn(ctx, `正文为空，跳过 ${entryName}`)
        summary.skipped += 1
        continue
      }
      const disposer = skills.register({
        name: entryName,
        description,
        content: parsed.content,
        resourceBase: { kind: 'directory', path: sourcePath },
        source: 'runtime',
      })
      if (typeof disposer === 'function') summary.disposers.push(disposer)
      summary.registered += 1
    } catch (error) {
      warn(ctx, `重放 ${String(entry?.name ?? '?')} 失败：${error instanceof Error ? error.message : String(error)}`)
      summary.skipped += 1
    }
  }
  return summary
}

/** 注册 6 个工具，返回 disposer 列表。 */
export function registerTools(ctx, config = {}) {
  const disposers = []
  const tools = ctx?.tools
  if (typeof tools?.register !== 'function') {
    warn(ctx, 'tools 服务不可用，跳过工具注册')
    return disposers
  }
  for (const definition of createTools(config)) {
    try {
      const disposer = tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      warn(ctx, `注册工具 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return disposers
}

/**
 * 插件入口。绝不 throw：任何异常都降级成 warn。
 * @returns {{ tools: number, skills: number, skipped: number }}
 */
export function apply(ctx, config = {}) {
  const disposers = []
  const previous = applied.get(ctx)
  if (Array.isArray(previous)) {
    for (const dispose of previous) {
      try {
        dispose()
      } catch {
        /* 忽略撤销失败 */
      }
    }
  }
  let summary = { total: 0, registered: 0, skipped: 0 }
  try {
    disposers.push(...registerTools(ctx, config))
  } catch (error) {
    warn(ctx, `注册工具异常：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    if (config?.autoReplay === false) {
      summary = { total: 0, registered: 0, skipped: 0 }
    } else {
      const replay = replaySkills(ctx, config)
      disposers.push(...replay.disposers)
      summary = replay
    }
  } catch (error) {
    warn(ctx, `重放技能异常：${error instanceof Error ? error.message : String(error)}`)
  }
  applied.set(ctx, disposers)
  try {
    ctx?.on?.('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
      applied.set(ctx, [])
    })
  } catch {
    /* 没有 on() 的宿主也无所谓 */
  }
  return { tools: TOOL_NAMES.length, skills: summary.registered, skipped: summary.skipped }
}
