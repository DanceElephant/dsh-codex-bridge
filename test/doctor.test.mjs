import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { collectBinaryHints, doctor, which } from '../lib/doctor.mjs'
import { importSkills } from '../lib/importer.mjs'
import { readLock, writeLock } from '../lib/lockfile.mjs'
import { fixtureRoot, tempDir } from './helpers/harness.mjs'

function setup(t, label = 'doctor') {
  const root = fixtureRoot(t, label)
  const targetDir = join(tempDir(t, label + '-target'), 'bridge')
  return { root, targetDir }
}

test('which：找到 node，找不到伪造的二进制，绝对路径也可用', () => {
  assert.equal(typeof which('node'), 'string')
  assert.ok(which('node').endsWith('node'))
  assert.equal(which('definitely-not-a-real-binary-xyz'), null)
  assert.equal(which(''), null)
  assert.equal(which('/bin/sh'), '/bin/sh')
  assert.equal(which('/bin/definitely-missing-xyz'), null)
})

test('collectBinaryHints：从正文里挑出命令行工具名', () => {
  const hints = collectBinaryHints('Run `playwright-cli` via bash; needs node and pandoc. Ignore nothing.')
  assert.deepEqual(hints, ['node', 'pandoc', 'playwright-cli'])
})

test('健康状态：正常导入后 healthy=true，无 missing/stale/overBudget', (t) => {
  const { root, targetDir } = setup(t, 'healthy')
  importSkills({ codexRoot: root, targetDir, names: ['agent-reach-like'], confirm: true, dryRun: false })
  const result = doctor({ codexRoot: root, targetDir })
  assert.equal(result.ok, true)
  assert.equal(result.data.healthy, true)
  assert.deepEqual(result.data.problems, [])
  assert.deepEqual(result.data.missingBinaries, [])
  assert.deepEqual(result.data.stalePaths, [])
  assert.deepEqual(result.data.overBudget, [])
  assert.equal(result.data.entries.length, 1)
  assert.equal(result.data.entries[0].replayable, true)
  assert.equal(result.data.entries[0].mode, 'reference')
  assert.equal(result.data.nodeVersion, process.version)
})

test('missingBinaries：显式指定的二进制会被检查', (t) => {
  const { root, targetDir } = setup(t, 'missing')
  const result = doctor({ codexRoot: root, targetDir, binaries: ['pandoc', 'definitely-not-a-real-binary-xyz'] })
  assert.ok(result.data.missingBinaries.includes('definitely-not-a-real-binary-xyz'))
})

test('codexRoot 不存在：CODEX_ROOT_MISSING，不崩', (t) => {
  const root = join(tempDir(t, 'noroot'), 'absent')
  const result = doctor({ codexRoot: root, targetDir: join(root, 'bridge') })
  assert.equal(result.ok, true)
  assert.equal(result.data.healthy, false)
  assert.equal(result.data.problems[0].code, 'CODEX_ROOT_MISSING')
})

test('targetDir 不可写：TARGET_NOT_WRITABLE', (t) => {
  const base = tempDir(t, 'notwritable')
  const root = fixtureRoot(t, 'notwritable-fx')
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, 'i am a file, not a directory')
  const result = doctor({ codexRoot: root, targetDir: join(blocker, 'nested') })
  assert.equal(result.ok, true)
  assert.ok(result.data.problems.some((problem) => problem.code === 'TARGET_NOT_WRITABLE'))
})

test('stalePaths：上游目录被删后标记，fix 后从锁文件移除', (t) => {
  const { root, targetDir } = setup(t, 'stale')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like', 'agent-reach-like'], confirm: true, dryRun: false })
  rmSync(join(root, 'skills/playwright-like'), { recursive: true, force: true })

  const before = doctor({ codexRoot: root, targetDir })
  assert.equal(before.data.healthy, false)
  assert.equal(before.data.stalePaths.length, 1)
  assert.equal(before.data.stalePaths[0].name, 'playwright-like')
  const entry = before.data.entries.find((item) => item.name === 'playwright-like')
  assert.equal(entry.replayable, false)
  assert.deepEqual(entry.problems, ['STALE_PATH'])

  const fixed = doctor({ codexRoot: root, targetDir, fix: true })
  assert.equal(fixed.data.fixApplied, true)
  assert.deepEqual(fixed.data.fixed, ['playwright-like'])
  assert.equal(readLock(targetDir).lock.imports.length, 1)
  assert.equal(doctor({ codexRoot: root, targetDir }).data.healthy, true)
})

test('overBudget：锁文件里超长描述会被列出（fix 不改它）', (t) => {
  const { root, targetDir } = setup(t, 'budget')
  importSkills({ codexRoot: root, targetDir, names: ['playwright-like'], confirm: true, dryRun: false })
  const { lock } = readLock(targetDir)
  lock.imports[0].description = 'x'.repeat(300)
  writeLock(targetDir, lock)

  const result = doctor({ codexRoot: root, targetDir, fix: true })
  assert.equal(result.data.healthy, false)
  assert.equal(result.data.overBudget.length, 1)
  assert.equal(result.data.overBudget[0].length, 300)
  assert.equal(result.data.overBudget[0].max, 220)
  assert.deepEqual(result.data.fixed, [])
  assert.equal(readLock(targetDir).lock.imports.length, 1, 'over-budget 不是可自动修复项')
})

test('BAD_ENTRY_NAME / SNAPSHOT_MISSING 可被检出', (t) => {
  const { root, targetDir } = setup(t, 'badname')
  importSkills({
    codexRoot: root,
    targetDir,
    names: ['playwright-like'],
    mode: 'snapshot',
    confirm: true,
    dryRun: false,
  })
  const { lock } = readLock(targetDir)
  lock.imports[0].name = 'Bad Name!'
  writeLock(targetDir, lock)

  const bad = doctor({ codexRoot: root, targetDir })
  assert.ok(bad.data.problems.some((problem) => problem.code === 'BAD_ENTRY_NAME'))

  // 删掉 snapshot 副本 → SNAPSHOT_MISSING
  rmSync(join(targetDir, 'Bad Name!'), { recursive: true, force: true })
  lock.imports[0].mode = 'snapshot'
  const dir = join(targetDir, 'bad-name')
  mkdirSync(join(targetDir, 'bad-name'), { recursive: true })
  writeLock(targetDir, lock)
  const missing = doctor({ codexRoot: root, targetDir })
  assert.ok(
    missing.data.problems.some((problem) => problem.code === 'SNAPSHOT_MISSING' || problem.code === 'BAD_ENTRY_NAME'),
  )
  rmSync(dir, { recursive: true, force: true })
})
