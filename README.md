# dsh-codex-bridge

把本机 **Codex** 的技能（`~/.codex/skills` 与 `~/.codex/plugins/cache`）导入 **DeepSeek Harness（DSH）** 的技能体系：扫描、压缩描述、登记到锁文件、启动时自动重放，并对外提供 6 个工具和一套 CLI。

零运行时依赖、纯 ESM、无构建步骤，Node.js ≥ 20。

## 为什么需要它

Codex 与 DSH 的技能格式几乎一样（都是带 YAML frontmatter 的 `SKILL.md`），但有两处硬伤：

1. **描述太长**：Codex 的 `description` 是给检索用的长文（真实样本 900–1500 字），直接塞进系统提示词会挤占上下文。本插件按预算把它压缩成一句触发式描述（默认 ≤ 220 字符），并保留平台/工具名等检索关键词。
2. **目录假设不同**：Codex 技能正文里常写死 `${CODEX_HOME:-$HOME/.codex}/skills/<name>/...`。`snapshot` 模式会把副本里的这些路径改写成新目录，并保留上游的 `LICENSE`/`NOTICE`。

## 安装

### 从插件市场安装（推荐）

DSH 的**插件市场**（`dshmarket`）已收录本插件，在市场的「工具 / 技能」分类里点安装即可。
也可以直接交给 CLI：

```bash
dsh plugin add https://github.com/DanceElephant/dsh-codex-bridge/releases/download/v0.1.1/dsh-codex-bridge-0.1.1.tgz
```

装完重启 DSH。

### 手工装进 profile

```bash
cd /path/to/dsh-codex-bridge
npm pack                                   # 生成 dsh-codex-bridge-0.1.1.tgz
cd ~/.dsh/profiles/<你的 profile>
npm i /path/to/dsh-codex-bridge-0.1.1.tgz
```

如果 profile 里已装的插件之间存在 peer 依赖冲突（例如 `dsh-univer-office` 与 `@perrylink/dsh-github`
对 `@deepseek-ai/dsh-llm` 的版本要求不一致），`npm i` 会报 `ERESOLVE`。这是 profile 既有问题，
与本插件无关（本插件零依赖、无 peer 要求），可以加 `--legacy-peer-deps` 安装：

```bash
npm i /path/to/dsh-codex-bridge-0.1.1.tgz --legacy-peer-deps
```

装完需要**重启 DSH**，bundle 才会被加载。

然后在该 profile 的 `cordis.patch.yml` 里追加（`dsh.profile.bundles` 也需加上 `"dsh-codex-bridge"`）：

```yaml
- insert:
    - id: dsh-codex-bridge
      name: dsh-codex-bridge
      config: {}
```

可选的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `codexRoot` | `~/.codex` | 只读的 Codex 根目录 |
| `targetDir` | `~/.dsh/codex-bridge` | 锁文件与 snapshot 副本的存放处 |
| `maxDescription` | `220` | 注入 DSH 的 description 预算（按码点计） |
| `autoReplay` | `true` | 启动时是否重放锁文件里的导入项 |

### 只用 CLI

```bash
node bin/bridge.mjs scan
```

## CLI

```
bridge scan    [--root DIR] [--target DIR] [--json]
bridge inspect <name|path> [--root DIR] [--json]
bridge import  <name...> [--mode reference|snapshot] [--on-conflict prefix|skip|overwrite]
                         [--dry-run] [--yes] [--root DIR] [--target DIR] [--json]
bridge list    [--target DIR] [--json]
bridge remove  <name...> [--purge] [--target DIR] [--json]
bridge doctor  [--fix] [--root DIR] [--target DIR] [--json]
```

- `import` 默认 **dry-run**：只打印计划，不写任何文件；加 `--yes` 才真正写入。
- `--json` 输出单行 JSON，便于脚本断言。
- 退出码：`0` 成功 · `1` 用法错误 · `2` 执行失败或部分失败。

典型流程：

```bash
bridge scan                                  # 看有哪些技能可导入
bridge inspect playwright                    # 看 willInject 正文前 500 字符
bridge import playwright --dry-run           # 预演
bridge import playwright --yes                # 真写
bridge list                                  # 已导入 + 上游是否变化
bridge doctor                                # 体检（缺失二进制 / 失效路径 / 超预算）
```

## DSH 工具

插件注册 6 个工具，返回值为 `{ ok, ...字段, data }` 形状（字段同时出现在顶层与 `data` 里，便于两种读法）：

| 工具 | 作用 | 关键返回 |
| --- | --- | --- |
| `codex_scan` | 扫描 `~/.codex` 下所有可导入技能（只读） | `total`、`items[]`（含 `alreadyImported`） |
| `codex_inspect` | 检视单个技能：解析结果 + 注入用的正文前 500 字符 + 脚本清单 | `willInject`、`scriptFiles[]` |
| `codex_import` | 导入并登记；默认 `dryRun` 不落库，`confirm:true` 才写 | `planned[]`、`applied[]`、`failed[]` |
| `codex_list` | 列出已导入项，并按 hash 比对上游 | `items[]`（含 `upstreamChanged`） |
| `codex_remove` | 注销；`purge:true` 只删 `targetDir` 内的 snapshot 副本 | `removed[]`、`purged[]` |
| `codex_doctor` | 体检：根目录、可写性、失效条目、超预算、缺失命令行工具 | `missingBinaries[]`、`stalePaths[]`、`overBudget[]` |

## 支持的 Codex 技能形态

| 形态 | 位置 | 处理 |
| --- | --- | --- |
| 独立技能 | `~/.codex/skills/<name>/SKILL.md` | 直接导入 |
| 插件（单版本） | `~/.codex/plugins/cache/<market>/<plugin>/<version>/skills/<name>/SKILL.md` | 逐个技能导入，`kind: plugin` |
| 插件（多版本） | 同上，存在多个 `<version>` | 选版本号最大者（`1.10.0 > 1.2.3`）；hash 目录排最后 |
| 只有 MCP | 只有 `.mcp.json`、没有 `skills/` | **不产技能条目**，只在 `problems` 里记 `MCP_ONLY` |
| 无 skills 的插件 | 有 `.codex-plugin/plugin.json`，但没有 `skills/` | 记 `NO_SKILLS` |

以 `.` 开头的目录（如 `plugins/.plugin-appserver`）一律跳过。

## description 压缩

1. 去掉 Markdown 装饰（围栏、链接、加粗、行内代码的反引号）与多余空白。
2. 清洗后已经 ≤ `maxDescription` 的**原样返回**（因此压缩是幂等的，重复跑结果不变）。
3. 超长时：优先保留触发句（`Use when…` / `Must use…` / `使用时机` / `用于` / `当…时` / `适合…场景`），整句放不下就按子句边界（`，、,：:；;—`）截取；同时为关键词预留预算，追加平台/工具名（如 `小红书`、`抖音`、`playwright-cli`）。
4. 兜底在空格/斜杠/破折号处截断并加 `…`；绝不切断 emoji 代理对。

原始长描述会完整保存在锁文件的 `longDescription` 里，方便日后重算。

## reference 与 snapshot

- **reference（默认）**：不复制任何文件，锁文件只记录 `sourcePath`、`hash`、压缩后的 `description`；启动重放时正文从上游现读，所以**上游改正文会即时生效，但描述以锁文件为准**。
- **snapshot**：把技能复制到 `targetDir/<name>`（跳过 `.git`、`node_modules`、>1 MB 的 `assets/` 二进制），并把正文里的 `${CODEX_HOME:-$HOME/.codex}/skills/<name>`、`$CODEX_HOME/skills/<name>`、`$HOME/.codex/skills/<name>`、`~/.codex/skills/<name>` 改写成新目录；改写明细记在锁文件 `rewrites` 里。**上游的 `LICENSE`/`NOTICE` 会一并保留**。

两种模式都不会删除上游文件；`remove --purge` 也只删 `targetDir` 内的副本。

## 安全声明

**能力边界**

- 文件读取：只读 `codexRoot`（默认 `~/.codex`）内的文件，`resolve` 后必须仍在该目录下（含 realpath 校验，防符号链接逃逸）。
- 文件写入：只写 `targetDir`（默认 `~/.dsh/codex-bridge`）内的锁文件 `.bridge.json` 与 snapshot 副本；锁文件用「临时文件 + fsync + rename」原子替换。
- 可选 shell：**没有**。`doctor` 的 `which` 用纯 JS 扫 `PATH` 实现，不 `spawn` 任何子进程。

**明确不做**

- 不执行被导入的脚本（只把路径登记到 `scriptFiles` 供审阅）。
- 不上传任何数据，**无网络访问**，无遥测。
- 不修改、不删除 `~/.codex` 里的任何东西。

**版权**：snapshot 模式保留上游的 `LICENSE`/`NOTICE`；被导入技能的版权归上游作者所有，本仓库只做格式转换与登记。

## 测试

```bash
npm test                                             # 6 个测试文件，合成 fixtures
npm run coverage                                     # 行覆盖率（lib/，当前 > 90%）
npm run smoke                                        # 对着真实 ~/.codex 跑完整生命周期
CODEX_BRIDGE_REAL=1 node --test test/discover.test.mjs  # 真实数据断言
```

测试 fixtures 由 `test/fixtures/build-fixtures.mjs` 现场生成到 `test/fixtures/tmp/`（已 gitignore），不依赖任何外部样本。真实数据相关的断言默认跳过，设置 `CODEX_BRIDGE_REAL=1` 才启用。

## 已知限制

- 插件的 `agents/openai.yaml`、`.app.json` 等 Codex 专有配置**不做转换**：只取 `SKILL.md`，其余文件按普通文件处理（reference 模式不复制，snapshot 复制）。
- snapshot 只能改写上面列出的 4 种路径写法；脚本里硬编码的绝对路径（如 `/Users/xxx/.codex/...`）不会被改写。
- 重名只按 `name` 判断：两个不同插件下有同名技能时，用 `--on-conflict prefix`（默认，生成 `codex-<name>`）或 `skip` / `overwrite`。
- 描述压缩是启发式的：极端长且没有任何触发句的描述会被截断并加 `…`。

## License

MIT © 2026 DanceElephant
