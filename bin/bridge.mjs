#!/usr/bin/env node
/**
 * dsh-codex-skill-bridge CLI —— 核心逻辑都在 lib/，这里只做参数解析与输出。
 *
 * 退出码：0 全成功 / 1 用法错误 / 2 执行失败或部分失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discover } from '../lib/discover.mjs'
import { doctor } from '../lib/doctor.mjs'
import { codepointLength } from '../lib/describe.mjs'
import { importSkills, inspectEntry, listImports, removeSkills } from '../lib/importer.mjs'
import { readLock } from '../lib/lockfile.mjs'
import { resolveTargetDir } from '../lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const USAGE = `dsh-codex-skill-bridge —— 把本机 Codex 技能导入 DSH 技能体系

用法：
  bridge scan    [--root DIR] [--target DIR] [--json]
  bridge inspect <name|path> [--root DIR] [--json]
  bridge import  <name...> [--mode reference|snapshot] [--on-conflict prefix|skip|overwrite]
                           [--dry-run] [--yes] [--root DIR] [--target DIR] [--json]
  bridge list    [--target DIR] [--json]
  bridge remove  <name...> [--purge] [--target DIR] [--json]
  bridge doctor  [--fix] [--root DIR] [--target DIR] [--json]
  bridge help | --help
  bridge version | --version

选项：
  --root DIR       Codex 根目录，默认 ~/.codex
  --target DIR     导入目标目录，默认 ~/.dsh/codex-skill-bridge
  --mode MODE      reference（默认，不复制文件）| snapshot（复制并改写 CODEX_HOME）
  --on-conflict    重名策略：prefix（默认）| skip | overwrite
  --dry-run        只打印计划，不写任何文件
  --yes            确认写入（等价于 import 的 confirm）
  --purge          remove 时删除 targetDir 内的 snapshot 副本（不动上游）
  --fix            doctor 时清理失效的锁条目
  --json           单行 JSON 输出，便于脚本断言

退出码：0 成功 · 1 用法错误 · 2 执行失败或部分失败
安全：只读 --root 内文件；从不执行被导入的脚本；无网络访问。
`

const VALUE_FLAGS = new Set(['root', 'target', 'mode', 'on-conflict'])

function parseArgv(argv) {
  const flags = new Map()
  const positionals = []
  const errors = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h') {
      flags.set('help', true)
      continue
    }
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const key = (eq === -1 ? body : body.slice(0, eq)).toLowerCase()
      if (VALUE_FLAGS.has(key)) {
        if (eq !== -1) {
          flags.set(key, body.slice(eq + 1))
        } else {
          const next = argv[index + 1]
          if (next === undefined || next.startsWith('--')) {
            errors.push(`--${key} 缺少取值`)
          } else {
            flags.set(key, next)
            index += 1
          }
        }
      } else if (eq === -1) {
        flags.set(key, true)
      } else {
        flags.set(key, body.slice(eq + 1))
      }
      continue
    }
    positionals.push(token)
  }
  return { flags, positionals, errors }
}

function version() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function option(flags, key, fallback) {
  const value = flags.get(key)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function emit(json, payload, text) {
  if (json) {
    process.stdout.write(JSON.stringify(payload) + '\n')
  } else {
    process.stdout.write(text)
  }
}

function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const cp = char.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    width += wide ? 2 : 1
  }
  return width
}

function pad(text, width) {
  const value = String(text)
  const current = displayWidth(value)
  return current >= width ? value : value + ' '.repeat(width - current)
}

function describeLength(item) {
  return item.descriptionLength > 0 ? `${item.descriptionLength} 字` : '-'
}

function cmdScan(flags) {
  const scan = discover({ codexRoot: option(flags, 'root', undefined) })
  const targetDir = resolveTargetDir(option(flags, 'target', undefined))
  const { lock } = readLock(targetDir)
  const imported = new Map(lock.imports.map((entry) => [entry.sourcePath, entry.name]))
  const items = scan.items.map((item) => ({
    name: item.name,
    sourceName: item.sourceName,
    kind: item.kind,
    pluginName: item.pluginName ?? '',
    pluginVersion: item.pluginVersion ?? '',
    dir: item.dir,
    hasScripts: item.hasScripts,
    scriptFiles: item.scriptFiles,
    mcpOnly: item.mcpOnly,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    descriptionLength: item.descriptionLength,
    descriptionPreview: item.descriptionPreview,
    license: item.license ?? '',
    fileCount: item.fileCount,
    alreadyImported: imported.has(item.dir),
    importedAs: imported.get(item.dir) ?? '',
    problems: item.problems,
  }))
  const payload = { ok: true, root: scan.root, total: items.length, items, problems: scan.problems }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return 0
  }
  const widths = [22, 24, 6]
  const lines = [`codex-skill-bridge scan`, `root: ${scan.root}`, `target: ${targetDir}`, '']
  lines.push(`${pad('技能', widths[0])} ${pad('类型', widths[1])} ${pad('文件', widths[2])} 描述`)
  for (const item of items) {
    const kind = item.kind === 'plugin' ? `plugin/${item.pluginName}` : 'standalone'
    const mark = item.alreadyImported ? `  [已导入: ${item.importedAs}]` : ''
    lines.push(
      `${pad(item.name, widths[0])} ${pad(kind, widths[1])} ${pad(item.fileCount, widths[2])} ${describeLength(item)}${mark}`,
    )
  }
  lines.push('', `合计 ${items.length} 个可导入技能`)
  if (scan.problems.length > 0) {
    lines.push('', '跳过（不产技能条目）：')
    for (const problem of scan.problems) lines.push(`  ${pad(problem.name, 24)} ${pad(problem.code, 10)} ${problem.message}`)
  }
  const collided = items.filter((item) => item.problems.includes('NAME_COLLISION'))
  if (collided.length > 0) {
    lines.push('', '重名（导入时会按 onConflict 处理）：')
    for (const item of collided) lines.push(`  ${item.name}`)
  }
  emit(false, payload, lines.join('\n') + '\n')
  return 0
}

function cmdInspect(flags, positionals) {
  const target = positionals[0]
  if (target === undefined) {
    process.stderr.write('用法：bridge inspect <name|path>\n')
    return 1
  }
  const isPath = target.includes('/') || target.startsWith('~') || target.startsWith('.')
  const result = inspectEntry({
    codexRoot: option(flags, 'root', undefined),
    name: isPath ? undefined : target,
    path: isPath ? target : undefined,
  })
  if (result.ok !== true) {
    emit(flags.has('json') === true, { ok: false, code: result.code, message: result.message }, `${result.code}: ${result.message}\n`)
    return 2
  }
  const data = result.data
  const payload = { ok: true, ...data }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return 0
  }
  const lines = [
    `name: ${data.name}`,
    `kind: ${data.kind}${data.pluginName ? '/' + data.pluginName : ''}${data.pluginVersion ? '@' + data.pluginVersion : ''}`,
    `dir: ${data.dir}`,
    `可导入: ${data.importable ? 'yes' : 'no'}`,
    `描述长度: ${codepointLength(data.description)} 字`,
    `脚本: ${data.scriptFiles.length > 0 ? data.scriptFiles.join(', ') : '(无)'}`,
    `问题: ${data.problems.length > 0 ? data.problems.join(', ') : '(无)'}`,
    '',
    `描述：`,
    data.description,
    '',
    `将注入的正文（前 500 字符）：`,
    data.willInject,
  ]
  emit(false, payload, lines.join('\n') + '\n')
  return 0
}

function cmdImport(flags, positionals) {
  if (positionals.length === 0) {
    process.stderr.write('用法：bridge import <name...> [--mode reference|snapshot] [--dry-run] [--yes]\n')
    return 1
  }
  const dryRun = flags.has('dry-run') === true || flags.has('yes') !== true
  const result = importSkills({
    codexRoot: option(flags, 'root', undefined),
    targetDir: option(flags, 'target', undefined),
    names: positionals,
    mode: option(flags, 'mode', 'reference'),
    onConflict: option(flags, 'on-conflict', 'prefix'),
    dryRun,
    confirm: flags.has('yes') === true,
  })
  if (result.ok !== true && result.data === undefined) {
    emit(flags.has('json') === true, { ok: false, code: result.code, message: result.message }, `${result.code}: ${result.message}\n`)
    return 2
  }
  const data = result.data
  const payload = { ok: result.ok === true, ...data }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return result.ok === true ? 0 : 2
  }
  const lines = [
    `${data.dryRun ? '导入计划（dry-run，不写盘）' : '导入结果'}`,
    `target: ${data.targetDir}  mode: ${data.mode}  onConflict: ${data.onConflict}`,
    '',
  ]
  for (const plan of data.planned) {
    lines.push(
      `  ${pad(plan.name, 24)}${plan.action.padEnd(10)}willImport=${plan.willImport}  files=${plan.files.length}  desc=${plan.descriptionLength ?? codepointLength(plan.description)}`,
    )
    if (plan.name !== plan.sourceName) lines.push(`    ${plan.sourceName} → ${plan.name}`)
    if (plan.message !== undefined) lines.push(`    ${plan.message}`)
  }
  for (const item of data.failed) {
    lines.push(`  ${pad(item.request ?? '?', 24)}REJECT    ${item.code}: ${item.message}`)
  }
  if (data.dryRun) {
    lines.push('', `未写入任何文件。执行写入请加 --yes。`)
  } else {
    lines.push('', `已写入 ${data.applied.length} 项 → ${data.lockPath}`)
  }
  emit(false, payload, lines.join('\n') + '\n')
  return result.ok === true ? 0 : 2
}

function cmdList(flags) {
  const result = listImports({
    codexRoot: option(flags, 'root', undefined),
    targetDir: option(flags, 'target', undefined),
  })
  const data = result.data
  const payload = { ok: true, ...data }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return 0
  }
  const lines = [`已导入 ${data.total} 个技能`, `target: ${data.targetDir}`, '']
  for (const item of data.items) {
    const state = item.upstreamMissing ? 'upstream=missing' : item.upstreamChanged ? 'upstream=changed' : 'upstream=ok'
    lines.push(`  ${pad(item.name, 24)}${pad(item.mode, 10)}${pad(state, 20)}desc=${codepointLength(item.description)}`)
  }
  if (data.problems.length > 0) lines.push('', `锁文件问题：${data.problems.join(', ')}`)
  emit(false, payload, lines.join('\n') + '\n')
  return 0
}

function cmdRemove(flags, positionals) {
  if (positionals.length === 0) {
    process.stderr.write('用法：bridge remove <name...> [--purge]\n')
    return 1
  }
  const result = removeSkills({
    targetDir: option(flags, 'target', undefined),
    names: positionals,
    purge: flags.has('purge') === true,
  })
  const payload = { ok: result.ok === true, ...result.data }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return result.ok === true ? 0 : 2
  }
  const lines = []
  for (const name of result.data.removed) lines.push(`已注销 ${name}`)
  for (const name of result.data.purged) lines.push(`已删除快照 ${name}`)
  for (const item of result.data.failed) lines.push(`失败 ${item.name}: ${item.code} ${item.message}`)
  lines.push('', result.data.purgedNote)
  emit(false, payload, lines.join('\n') + '\n')
  return result.ok === true ? 0 : 2
}

function cmdDoctor(flags) {
  const result = doctor({
    codexRoot: option(flags, 'root', undefined),
    targetDir: option(flags, 'target', undefined),
    fix: flags.has('fix') === true,
  })
  const data = result.data
  const payload = { ok: true, ...data }
  if (flags.has('json') === true) {
    emit(true, payload, '')
    return 0
  }
  const list = (values) => (values.length === 0 ? '(无)' : values.join(', '))
  const lines = [
    'codex-skill-bridge doctor',
    `root: ${data.root}`,
    `target: ${data.targetDir}`,
    `node: ${data.nodeVersion}  platform: ${data.platform}`,
    `healthy: ${data.healthy}`,
    `已导入: ${data.entries.length}`,
    `missingBinaries: ${list(data.missingBinaries)}`,
    `stalePaths: ${list(data.stalePaths.map((item) => item.name))}`,
    `overBudget: ${list(data.overBudget.map((item) => `${item.name}(${item.length}>${item.max})`))}`,
  ]
  if (data.problems.length > 0) {
    lines.push('', '问题：')
    for (const problem of data.problems) lines.push(`  ${problem.code}  ${problem.message}`)
  }
  if (data.fixed.length > 0) lines.push('', `已清理锁条目：${data.fixed.join(', ')}`)
  emit(false, payload, lines.join('\n') + '\n')
  return 0
}

export function run(argv) {
  const { flags, positionals, errors } = parseArgv(argv)
  if (flags.has('help') === true) {
    process.stdout.write(USAGE)
    return 0
  }
  if (flags.has('version') === true) {
    process.stdout.write(version() + '\n')
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`错误：${error}\n`)
    process.stderr.write(USAGE)
    return 1
  }
  const command = positionals[0]
  if (command === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  const rest = positionals.slice(1)
  try {
    switch (command) {
      case 'scan':
        return cmdScan(flags)
      case 'inspect':
        return cmdInspect(flags, rest)
      case 'import':
        return cmdImport(flags, rest)
      case 'list':
        return cmdList(flags)
      case 'remove':
        return cmdRemove(flags, rest)
      case 'doctor':
        return cmdDoctor(flags)
      case 'help':
        process.stdout.write(USAGE)
        return 0
      case 'version':
        process.stdout.write(version() + '\n')
        return 0
      default:
        process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
        return 1
    }
  } catch (error) {
    process.stderr.write(`执行失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain || process.argv[1]?.endsWith('bridge.mjs') === true) {
  process.exitCode = run(process.argv.slice(2))
}
