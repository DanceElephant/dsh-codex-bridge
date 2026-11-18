#!/usr/bin/env node
/**
 * 生成合成 fixtures（绝不复制 /Users/huil/.codex 的真实内容）。
 *
 * 覆盖 5 种形态：
 *   1. agent-reach-like  —— `description: >` 折叠 5 行、约 1.5k 字符、7 个 references/*.md
 *   2. playwright-like   —— scripts/run.sh + agents/openai.yaml + LICENSE/NOTICE + 正文写死 CODEX_HOME
 *   3. plugin-multi      —— plugins/cache/m/multi/1.2.3 + skills/{alpha,beta}
 *   4. plugin-multi-version —— 1.2.3 与 1.10.0 并存（字符串序会把 1.2.3 排后面）
 *   5. plugin-mcp-only   —— 只有 .mcp.json
 *
 * 另加：重名（dup-a/dup-b 同 name: dup）、`.plugin-appserver` 干扰目录、>1MB 二进制资产。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function write(root, rel, content) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function longDescription() {
  // 5 个物理行 + 1 个空行：验证 `>` 的"普通换行折叠成空格、空行折叠成换行"
  const lines = [
    'Use when the user asks for social-media research, 小红书 / 抖音 / 微博 内容调研, or 多平台口碑对比, and you need to collect posts, comments and engagement metrics before answering; skip it when the request never touches a social platform, because the bundled collector burns quota on every call and a wrong route is worse than no route at all.',
    'Use when the task mentions any of 小红书, 抖音, 微博, 知乎, B站, Twitter, Reddit, YouTube, or when the user shares a profile/post URL and asks what people think about it; the trigger list is measured against real requests, so treat a single mention as enough and do not wait for an explicit "research" verb before starting the collection pass.',
    '使用时机：用户说"帮我调研一下 X"、"看看大家怎么评价 X"、"X 上有什么讨论" 时，先跑 `agent-reach` 的采集流程，再汇总成结构化报告；报告需要给出样本量、时间窗与平台分布，缺失的部分要明确标注为"未采集"，不要用模型记忆补全数字。',
    '',
    'Also use when a workflow needs creator discovery on 抖音 or 小红书, hashtag trend extraction on 微博, or comment sentiment clustering across platforms; the bundled `reach` CLI wraps every platform behind one command, and `reach export --format jsonl` is the only supported hand-off format for downstream steps.',
    'Do not use for pure translation, image generation, or tasks that never touch social platforms; those belong to other skills and will waste quota if routed here, which is why the trigger list above is intentionally narrow and why this description repeats the platform names instead of relying on a generic "web research" phrasing.',
  ]
  return lines
    .map((line) => (line === '' ? '' : '  ' + line))
    .join('\n')
}

export function buildFixtures(destDir) {
  const root = resolve(destDir)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  // 1) agent-reach-like：折叠标量 + 7 个 references
  const agentDir = join(root, 'skills', 'agent-reach-like')
  write(
    root,
    'skills/agent-reach-like/SKILL.md',
    [
      '---',
      'name: agent-reach-like',
      'description: >',
      ...longDescription().split('\n'),
      'license: MIT',
      'metadata:',
      '  homepage: https://example.invalid/agent-reach',
      '  author: fixture',
      '---',
      '',
      '# Agent Reach (fixture)',
      '',
      'Collect posts from social platforms, then summarise.',
      'Scripts are never executed by dsh-codex-skill-bridge.',
      '',
      '```bash',
      'reach collect --platform xiaohongshu --limit 20',
      '```',
      '',
    ].join('\n'),
  )
  for (let index = 1; index <= 7; index += 1) {
    write(root, `skills/agent-reach-like/references/ref-${index}.md`, `# Reference ${index}\n\nfixture body ${index}\n`)
  }

  // 2) playwright-like：脚本 + 资产 + 正文写死 CODEX_HOME
  write(
    root,
    'skills/playwright-like/SKILL.md',
    [
      '---',
      'name: playwright-like',
      'description: "Use when the task needs `playwright-cli` to drive a real browser from the terminal: navigation, form filling, snapshots."',
      'license: Apache-2.0',
      '---',
      '',
      '# Playwright CLI (fixture)',
      '',
      '```bash',
      'export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"',
      'PWCLI="$CODEX_HOME/skills/playwright-like/scripts/run.sh"',
      'bash "$PWCLI" --help',
      '```',
      '',
      'Always invoke the wrapper through $PWCLI.',
      '',
    ].join('\n'),
  )
  write(
    root,
    'skills/playwright-like/scripts/run.sh',
    ['#!/usr/bin/env bash', 'export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"', 'echo "$CODEX_HOME/skills/playwright-like/scripts/run.sh"', ''].join('\n'),
  )
  write(root, 'skills/playwright-like/agents/openai.yaml', 'name: playwright-like\ninterface:\n  display_name: Playwright\n')
  write(root, 'skills/playwright-like/LICENSE.txt', 'Apache License 2.0 (fixture)\n')
  write(root, 'skills/playwright-like/NOTICE.txt', 'NOTICE (fixture)\n')
  write(root, 'skills/playwright-like/references/cli.md', '# CLI\n')
  write(root, 'skills/playwright-like/references/workflows.md', '# Workflows\n')
  write(root, 'skills/playwright-like/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  // >1MB 二进制：snapshot 必须跳过
  mkdirSync(join(root, 'skills', 'playwright-like', 'assets'), { recursive: true })
  writeFileSync(join(root, 'skills', 'playwright-like', 'assets', 'huge.bin'), Buffer.alloc(1024 * 1024 + 64, 7))

  // 3) plugin-multi：一个插件带两个子技能
  write(
    root,
    'plugins/cache/m/multi/1.2.3/.codex-plugin/plugin.json',
    JSON.stringify({ name: 'multi', version: '1.2.3', description: 'multi-skill fixture', license: 'MIT', skills: './skills/' }, null, 2),
  )
  for (const skill of ['alpha', 'beta']) {
    write(
      root,
      `plugins/cache/m/multi/1.2.3/skills/${skill}/SKILL.md`,
      ['---', `name: ${skill}`, `description: Use when the ${skill} fixture skill is relevant.`, '---', '', `# ${skill}`, '', `Body of ${skill}.`, ''].join('\n'),
    )
  }

  // 4) plugin-multi-version：1.2.3 与 1.10.0 并存，必须选 1.10.0
  for (const [version, skill] of [
    ['1.2.3', 'old-skill'],
    ['1.10.0', 'new-skill'],
  ]) {
    write(
      root,
      `plugins/cache/m/versioned/${version}/.codex-plugin/plugin.json`,
      JSON.stringify({ name: 'versioned', version, description: 'version fixture', skills: './skills/' }, null, 2),
    )
    write(
      root,
      `plugins/cache/m/versioned/${version}/skills/${skill}/SKILL.md`,
      ['---', `name: ${skill}`, `description: Use when the ${skill} is relevant.`, '---', '', `# ${skill}`, ''].join('\n'),
    )
  }

  // 5) plugin-mcp-only：只有 .mcp.json
  write(
    root,
    'plugins/cache/m/mcponly/9.9.9/.mcp.json',
    JSON.stringify({ mcpServers: { example: { command: 'example-mcp' } } }, null, 2),
  )
  write(root, 'plugins/cache/m/mcponly/9.9.9/README.md', '# mcp only\n')

  // 干扰项：以 . 开头的目录必须跳过
  write(
    root,
    'plugins/cache/m/.plugin-appserver/1.0.0/skills/ghost/SKILL.md',
    ['---', 'name: ghost', 'description: Use when you must never see this.', '---', '', '# ghost', ''].join('\n'),
  )
  write(root, 'plugins/cache/m/.plugin-appserver/1.0.0/.codex-plugin/plugin.json', JSON.stringify({ name: 'ghost', version: '1.0.0' }))

  // 重名：两个目录的 frontmatter name 相同
  for (const dir of ['dup-a', 'dup-b']) {
    write(
      root,
      `skills/${dir}/SKILL.md`,
      ['---', 'name: dup', `description: Use when the ${dir} copy of dup is relevant.`, '---', '', `# ${dir}`, ''].join('\n'),
    )
  }

  return root
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2] ?? join(HERE, 'tmp')
  process.stdout.write(buildFixtures(dest) + '\n')
}
