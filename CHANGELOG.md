# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-16

### 变更

- **安装方式**：把「插件市场 / `dsh plugin add <release tarball>`」的一行安装写到首位，手工 `npm i` 到 profile 降为备选路径。
- **文档**：说明 profile 里既有插件之间的 peer 冲突（`ERESOLVE`）与本插件无关（零依赖、无 peer 要求），可用 `--legacy-peer-deps` 绕过；并说明装完需重启 DSH。

### 其他

- 发布 `dsh-codex-bridge-0.1.1.tgz` 到 GitHub Release，供 DSH 插件市场条目与离线安装使用。
- 仓库添加 `dsh-plugin` topic，便于市场收录与检索。

## [0.1.0] - 2026-11-15

### 新增

- **扫描**：`bridge scan` / `codex_scan` 读取 `~/.codex/skills` 与 `~/.codex/plugins/cache`，识别独立技能、单版本/多版本插件、只有 MCP 的插件；多版本按数值比较选最大（`1.10.0 > 1.2.3`），hash 版本目录排最后；以 `.` 开头的目录跳过。
- **解析**：零依赖实现 Codex 用到的 YAML 子集——单双引号、`>` 折叠标量、`|` 字面标量（含 chomping 与缩进指示符）、缩进多行、嵌套对象、序列、CRLF/BOM；解析失败不抛异常，只写 `problems`。
- **描述压缩**：把 900–1500 字的长描述压到 ≤220 字符（可配置），保留触发句与平台/工具关键词；对已达标文本原样返回，因此幂等；绝不切断 emoji 代理对。
- **导入**：`bridge import` / `codex_import` 默认 dry-run，`--yes` 才落库；支持 `reference`（不复制）与 `snapshot`（复制 + 改写 CODEX_HOME 路径 + 保留 LICENSE/NOTICE）两种模式；冲突策略 `prefix` / `skip` / `overwrite`。
- **锁文件**：`~/.dsh/codex-bridge/.bridge.json` 记录 name、sourcePath、hash、压缩描述、原始长描述、文件清单、改写明细；临时文件 + fsync + rename 原子写入。
- **重放**：DSH 启动时按锁文件注册技能，description 用锁文件值、正文从上游现读；单条失败只 `warn`，绝不阻塞启动；同一个 ctx 重复 `apply` 会先撤销上一轮。
- **体检**：`bridge doctor` / `codex_doctor` 检查根目录、目标可写性、失效路径、超预算描述、缺失的命令行工具；`--fix` 只清理失效锁条目。`which` 用纯 JS 扫 PATH，不 `spawn`。
- **CLI**：`scan` / `inspect` / `import` / `list` / `remove` / `doctor`，`--json` 单行输出，退出码 0/1/2。
- **测试**：72 个用例（6 个测试文件）+ 现场生成的 5 种 fixtures + 真实 `~/.codex` 冒烟脚本；`lib/` 行覆盖率 > 90%。

### 安全

- 只读 `codexRoot` 内文件（含 realpath 校验），只写 `targetDir` 内文件；不执行被导入的脚本、不联网、不上传任何数据。

[0.1.1]: https://github.com/DanceElephant/dsh-codex-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/DanceElephant/dsh-codex-bridge/releases/tag/v0.1.0
