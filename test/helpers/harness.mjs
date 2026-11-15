/**
 * 测试公共设施：临时目录、合成 fixtures、mock ctx。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixtures } from '../fixtures/build-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(HERE, '..', 'fixtures', 'tmp')

let counter = 0

/** 在 test/fixtures/tmp/ 下建一个用例专属目录，测试结束自动删除。 */
export function tempDir(t, label = 'run') {
  counter += 1
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${counter}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 生成合成 Codex 根目录（5 种形态），返回根路径。 */
export function fixtureRoot(t, label = 'fx') {
  return buildFixtures(join(tempDir(t, label), 'codex'))
}

/**
 * 最小 mock ctx：记录注册结果与 warning。
 * 用 Map 存，重复注册同名会覆盖，因此"跑两次 apply 不翻倍"可断言。
 */
export function createMockContext(options = {}) {
  const tools = new Map()
  const skills = new Map()
  const warnings = []
  const handlers = new Map()
  const disposers = []
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: () => {},
    },
    tools: options.tools === false
      ? undefined
      : {
          register(definition) {
            tools.set(definition.name, definition)
            const dispose = () => tools.delete(definition.name)
            disposers.push(dispose)
            return dispose
          },
        },
    skills: options.skills === false
      ? undefined
      : {
          register(spec) {
            if (typeof options.onRegister === 'function') options.onRegister(spec)
            skills.set(spec.name, spec)
            const dispose = () => skills.delete(spec.name)
            disposers.push(dispose)
            return dispose
          },
        },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
  }
  return { ctx, tools, skills, warnings, handlers, disposers }
}
