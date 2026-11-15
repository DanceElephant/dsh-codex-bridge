/**
 * 覆盖率闸门：跑测试并解析 `--experimental-test-coverage` 的汇总行，
 * 行覆盖率低于阈值就以非零退出码失败（CI 里用这个，而不是只打印报告）。
 *
 * 用 `--test-coverage-include` 把统计范围限制在 lib/，与"lib 行覆盖率 ≥85%"的口径一致；
 * 该参数需要 Node ≥ 22.5，因此在 Node 20 上本脚本直接报错退出，由 CI 只在 Node 24 上执行它。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_LINE = 85
const MIN_NODE_MAJOR = 22
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const major = Number.parseInt(process.versions.node.split('.')[0], 10)
if (!(major >= MIN_NODE_MAJOR)) {
  console.error(`✗ 覆盖率闸门需要 Node ≥ ${MIN_NODE_MAJOR}（当前 ${process.versions.node}）：--test-coverage-include 不可用`)
  process.exit(1)
}

// 显式枚举测试文件：`test/*.test.mjs` 依赖 shell 展开，Windows 与纯 spawn 都不可靠；
// 而裸 `node --test` 会把 test/fixtures/build-fixtures.mjs 也当测试跑，导致并发写同一目录。
const files = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('test', name))
if (files.length === 0) {
  console.error('✗ test/ 下没有 .test.mjs')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', '--test-coverage-include=lib/**', ...files],
  { encoding: 'utf8', cwd: ROOT },
)
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
process.stdout.write(output)

const rows = output
  .split('\n')
  .map((line) => line.replace(/^(?:ℹ|#)+\s*/, '').trim())
  .filter((line) => line.startsWith('all files'))
const last = rows.at(-1)
if (last === undefined) {
  console.error('\n✗ 没找到覆盖率汇总行；测试可能根本没跑起来')
  process.exit(1)
}

const linePercent = Number.parseFloat(last.split('|')[1])
if (!Number.isFinite(linePercent)) {
  console.error(`\n✗ 无法解析覆盖率：${last}`)
  process.exit(1)
}

if (result.status !== 0) {
  console.error('\n✗ 测试失败')
  process.exit(result.status ?? 1)
}

if (linePercent < MIN_LINE) {
  console.error(`\n✗ lib/ 行覆盖率 ${linePercent.toFixed(2)}% 低于阈值 ${MIN_LINE}%`)
  process.exit(1)
}

console.log(`\n✓ lib/ 行覆盖率 ${linePercent.toFixed(2)}% ≥ ${MIN_LINE}%`)
