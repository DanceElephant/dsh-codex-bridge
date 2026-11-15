/**
 * 6 个 DSH 工具的定义。全部是 lib/ 核心的薄包装。
 *
 * 返回形状：`{ ok, code?, message?, data }`——`data` 是同一份负载，
 * 同时把规格表点名的字段（total/items/missingBinaries/…）提到顶层，
 * 这样两种消费方式都成立。schema 里两者都声明，保持严格一致。
 */
import { discover } from './discover.mjs'
import { doctor } from './doctor.mjs'
import { importSkills, inspectEntry, listImports, normalizeSkillName, removeSkills } from './importer.mjs'
import { readLock } from './lockfile.mjs'
import { resolveTargetDir } from './paths.mjs'

const STRING = { type: 'string' }
const BOOLEAN = { type: 'boolean' }
const NUMBER = { type: 'number' }
const STRING_ARRAY = { type: 'array', items: { type: 'string' } }

function envelope(props, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: BOOLEAN,
      code: STRING,
      message: STRING,
      ...props,
      data: { type: 'object' },
    },
    required: ['ok', ...required],
  }
}

/**
 * 去掉 null/undefined 键。
 *
 * 核心层用 null 表示"不适用"（独立技能没有 pluginName、锁条目可能没有 sourceVersion），
 * 但工具 schema 声明的是纯 string：null 会让宿主校验失败（真实踩过）。
 * 这些字段都不是 required，直接省略即可。
 */
function pruneNulls(value) {
  if (Array.isArray(value)) return value.map(pruneNulls)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner === null || inner === undefined) continue
      out[key] = pruneNulls(inner)
    }
    return out
  }
  return value
}

/** 把核心返回的 {ok, code?, message?, data} 摊平成工具返回。 */
function flatten(result, requiredKeys = [], defaults = {}) {
  if (result.ok !== true) {
    const payload = { ok: false, code: result.code ?? 'FAILED', message: result.message ?? '失败' }
    for (const key of requiredKeys) payload[key] = defaults[key] ?? (key === 'total' ? 0 : [])
    // data 是同一负载的副本（不能指向 payload 自身：pruneNulls 会无限递归）
    return { ...payload, data: { ...payload } }
  }
  const pruned = pruneNulls(result.data)
  return { ok: true, ...pruned, data: pruned }
}

const problemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { code: STRING, message: STRING },
}

export function createTools(config = {}) {
  return [
    {
      name: 'codex_scan',
      description:
        '扫描本机 Codex 的 ~/.codex/skills 与 ~/.codex/plugins/cache，列出可导入的 DSH 技能。' +
        '只读；不改任何文件。用于导入前先看清有哪些技能、是否只有 MCP 配置、是否已导入过。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { ...STRING, description: 'codexRoot，默认 ~/.codex' },
          include: { ...STRING_ARRAY, description: '只保留名字匹配这些子串的条目' },
          exclude: { ...STRING_ARRAY, description: '排除名字匹配这些子串的条目' },
        },
      },
      output: {
        schema: envelope(
          {
            root: STRING,
            total: NUMBER,
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: STRING,
                  sourceName: STRING,
                  kind: { type: 'string', enum: ['standalone', 'plugin'] },
                  pluginName: STRING,
                  pluginVersion: STRING,
                  dir: STRING,
                  hasScripts: BOOLEAN,
                  scriptFiles: STRING_ARRAY,
                  mcpOnly: BOOLEAN,
                  sizeBytes: NUMBER,
                  sha256: STRING,
                  descriptionLength: NUMBER,
                  descriptionPreview: STRING,
                  license: STRING,
                  fileCount: NUMBER,
                  alreadyImported: BOOLEAN,
                  importedAs: STRING,
                  problems: STRING_ARRAY,
                },
                required: ['name', 'kind', 'dir', 'problems'],
              },
            },
            problems: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: STRING,
                  code: STRING,
                  dir: STRING,
                  message: STRING,
                  problems: STRING_ARRAY,
                },
              },
            },
          },
          ['total', 'items'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const scan = discover({ codexRoot: args.root ?? config.codexRoot, include: args.include, exclude: args.exclude })
        const targetDir = resolveTargetDir(config.targetDir)
        const { lock } = readLock(targetDir)
        const bySource = new Map(lock.imports.map((entry) => [entry.sourcePath, entry.name]))
        const items = scan.items.map((item) => {
          const importedAs = bySource.get(item.dir) ?? (lock.imports.some((entry) => entry.name === normalizeSkillName(item.name)) ? normalizeSkillName(item.name) : '')
          return { ...item, alreadyImported: importedAs !== '', importedAs }
        })
        return flatten({ ok: true, data: { root: scan.root, total: items.length, items, problems: scan.problems } }, [
          'total',
          'items',
          'problems',
        ])
      },
    },

    {
      name: 'codex_inspect',
      description:
        '检视单个 Codex 技能的解析结果：description 原文、将注入 DSH 的正文前 500 字符、脚本清单、问题码。' +
        '只读，不落库。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { ...STRING, description: '技能 name / sourceName / plugin/skill，或目录路径' },
          path: { ...STRING, description: '技能目录绝对路径（与 name 二选一）' },
        },
      },
      output: {
        schema: envelope(
          {
            name: STRING,
            sourceName: STRING,
            kind: STRING,
            pluginName: STRING,
            pluginVersion: STRING,
            dir: STRING,
            description: STRING,
            longDescription: STRING,
            content: STRING,
            contentLength: NUMBER,
            willInject: STRING,
            license: STRING,
            hasScripts: BOOLEAN,
            scriptFiles: STRING_ARRAY,
            fileCount: NUMBER,
            sha256: STRING,
            importable: BOOLEAN,
            rejectCode: STRING,
            problems: STRING_ARRAY,
          },
          ['name'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const inspected = inspectEntry({
          codexRoot: args.root ?? config.codexRoot,
          name: args.name,
          path: args.path,
          maxDescription: config.maxDescription,
        })
        if (inspected.ok !== true) return flatten(inspected, ['name', 'problems'], { name: '' })
        const data = inspected.data
        return flatten(
          {
            ok: true,
            data: {
              name: data.name,
              sourceName: data.sourceName,
              kind: data.kind,
              pluginName: data.pluginName ?? '',
              pluginVersion: data.pluginVersion ?? '',
              dir: data.dir,
              description: data.description,
              longDescription: data.description,
              content: data.content,
              contentLength: data.contentLength,
              willInject: data.willInject,
              license: data.license ?? '',
              hasScripts: data.hasScripts,
              scriptFiles: data.scriptFiles,
              fileCount: data.fileCount,
              sha256: data.sha256,
              importable: data.importable,
              rejectCode: data.rejectCode ?? '',
              problems: data.problems,
            },
          },
          ['name', 'problems'],
          { name: '' },
        )
      },
    },

    {
      name: 'codex_import',
      description:
        '把 Codex 技能导入 DSH 技能体系并登记到锁文件。默认 dryRun=true 只返回计划、不写盘；' +
        'confirm=true 才真正写。mode=reference 不复制文件（指向 ~/.codex），snapshot 复制到 targetDir。' +
        '从不执行被导入的脚本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          names: { ...STRING_ARRAY, description: '技能名列表（name / sourceName / plugin/skill / 路径）' },
          mode: { type: 'string', enum: ['reference', 'snapshot'], description: '默认 reference' },
          onConflict: { type: 'string', enum: ['prefix', 'skip', 'overwrite'], description: '默认 prefix' },
          dryRun: { ...BOOLEAN, description: '默认 true；显式 false 且 confirm=true 才写' },
          confirm: { ...BOOLEAN, description: 'true 才落库' },
        },
        required: ['names'],
      },
      output: {
        schema: envelope(
          {
            targetDir: STRING,
            root: STRING,
            mode: STRING,
            onConflict: STRING,
            dryRun: BOOLEAN,
            wrote: BOOLEAN,
            lockPath: STRING,
            planned: { type: 'array', items: { type: 'object' } },
            applied: { type: 'array', items: { type: 'object' } },
            failed: { type: 'array', items: problemSchema },
          },
          ['planned'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const names = Array.isArray(args.names) ? args.names : []
        if (names.length === 0) {
          return flatten({ ok: false, code: 'NO_NAMES', message: 'names 不能为空' }, ['planned'])
        }
        const confirm = args.confirm === true
        const dryRun = args.dryRun === true || !confirm
        const result = importSkills({
          codexRoot: args.root ?? config.codexRoot,
          targetDir: config.targetDir,
          names,
          mode: args.mode ?? 'reference',
          onConflict: args.onConflict ?? 'prefix',
          dryRun,
          confirm,
          maxDescription: config.maxDescription,
          reserved: Array.isArray(config.reserved) ? config.reserved : [],
        })
        return flatten(result, ['planned'])
      },
    },

    {
      name: 'codex_list',
      description: '列出已导入 DSH 的 Codex 技能，并与上游目录的 hash 比对，标出 upstreamChanged / upstreamMissing。只读。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: envelope(
          {
            targetDir: STRING,
            root: STRING,
            lockPath: STRING,
            total: NUMBER,
            items: { type: 'array', items: { type: 'object' } },
            problems: STRING_ARRAY,
          },
          ['total', 'items'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        const result = listImports({ codexRoot: config.codexRoot, targetDir: config.targetDir })
        return flatten(result, ['total', 'items'])
      },
    },

    {
      name: 'codex_remove',
      description:
        '注销已导入的技能。purge=true 时只删除 targetDir 内的 snapshot 副本；' +
        'reference 模式的源目录永远不会被删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          names: { ...STRING_ARRAY, description: '要注销的技能名' },
          purge: { ...BOOLEAN, description: '是否删除 snapshot 副本，默认 false' },
        },
        required: ['names'],
      },
      output: {
        schema: envelope(
          {
            targetDir: STRING,
            lockPath: STRING,
            removed: STRING_ARRAY,
            purged: STRING_ARRAY,
            failed: { type: 'array', items: problemSchema },
            purgedNote: STRING,
          },
          ['removed'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const names = Array.isArray(args.names) ? args.names : []
        if (names.length === 0) {
          return flatten({ ok: false, code: 'NO_NAMES', message: 'names 不能为空' }, ['removed'])
        }
        const result = removeSkills({ targetDir: config.targetDir, names, purge: args.purge === true })
        return flatten(result, ['removed'])
      },
    },

    {
      name: 'codex_doctor',
      description:
        '体检：codexRoot 是否存在、targetDir 是否可写、锁条目是否失效、描述是否超预算、依赖的命令行工具是否在 PATH。' +
        'fix=true 只清理失效条目的锁记录，不动上游文件。不执行任何脚本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { ...STRING, description: 'codexRoot，默认 ~/.codex' },
          fix: { ...BOOLEAN, description: '清理失效锁条目，默认 false' },
        },
      },
      output: {
        schema: envelope(
          {
            root: STRING,
            targetDir: STRING,
            lockPath: STRING,
            healthy: BOOLEAN,
            entries: { type: 'array', items: { type: 'object' } },
            problems: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { code: STRING, message: STRING, name: STRING, fixable: BOOLEAN },
              },
            },
            missingBinaries: STRING_ARRAY,
            stalePaths: { type: 'array', items: { type: 'object' } },
            overBudget: { type: 'array', items: { type: 'object' } },
            fixed: STRING_ARRAY,
            fixApplied: BOOLEAN,
            nodeVersion: STRING,
            platform: STRING,
          },
          ['healthy', 'missingBinaries', 'stalePaths', 'overBudget'],
        ),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const result = doctor({
          codexRoot: args.root ?? config.codexRoot,
          targetDir: config.targetDir,
          maxDescription: config.maxDescription,
          fix: args.fix === true,
        })
        return flatten(result, ['healthy', 'missingBinaries', 'stalePaths', 'overBudget'])
      },
    },
  ]
}

export const TOOL_NAMES = ['codex_scan', 'codex_inspect', 'codex_import', 'codex_list', 'codex_remove', 'codex_doctor']
