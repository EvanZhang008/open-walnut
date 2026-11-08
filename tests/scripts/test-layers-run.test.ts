/**
 * The test layers' runner and timing recorder against real vitest runs on a scratch project:
 * a run's verdict must never read a failure as a pass, and a file's recorded cost must include
 * its imports (scripts/test-layers.mjs, scripts/lib/duration-reporter.mjs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error plain .mjs without types
import { runVitest, judge } from '../../scripts/test-layers.mjs'
// @ts-expect-error plain .mjs without types
import { vitestCommand } from '../../scripts/bun-vitest.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
let dir: string
let config: string
const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body)

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-layers-run-'))
  config = path.join(dir, 'vitest.config.mjs')
  write('vitest.config.mjs', `export default { test: { root: ${JSON.stringify(dir)}, include: ['*.test.mjs'], globals: true } }`)
  write('pass.test.mjs', "it('passes', () => { expect(1).toBe(1) })")
  write('fail.test.mjs', "it('fails', () => { expect(1).toBe(2) })")
  write('unhandled.test.mjs', "it('passes, and leaves a rejection nobody handles', async () => { void Promise.reject(new Error('UNHANDLED')); await new Promise((r) => setTimeout(r, 50)); expect(1).toBe(1) })")
  write('slow-import.test.mjs', "await new Promise((r) => setTimeout(r, 900))\nit('is quick itself', () => { expect(1).toBe(1) })")
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const runIn = (files: string[]) => runVitest(files, ['--maxWorkers=1'], { config, root: dir })

describe('runVitest and judge', () => {
  it('a vitest run that exits nonzero with every file passing (an unhandled rejection) fails the layer', () => {
    const first = runIn(['unhandled.test.mjs'])
    expect(first.failed).toEqual([])
    expect(first.crashed).toEqual([])
    expect(first.runError).toMatch(/unhandled/)
    expect(judge(first, { failed: [], crashed: [], ms: 0, runError: null }).fails).toEqual([expect.stringMatching(/^<run> :: /)])
  }, 60_000)

  it('a clean pass has no run error; a failing test is named; a file that never reports is a crash', () => {
    expect(runIn(['pass.test.mjs']).runError).toBeNull()
    const r = runIn(['fail.test.mjs', 'missing.test.mjs'])
    expect(r.failed).toEqual(['fail.test.mjs :: fails'])
    expect(r.crashed).toEqual(['missing.test.mjs'])
    expect(r.runError).toBeNull()
  }, 60_000)

  it('judge: failing again is a failure, passing alone is flaky', () => {
    const first = { failed: ['a.test.ts :: x', 'b.test.ts :: y'], crashed: [], ms: 0, runError: null }
    const again = { failed: ['a.test.ts :: x'], crashed: [], ms: 0, runError: null }
    expect(judge(first, again)).toEqual({ fails: ['a.test.ts :: x'], flaky: ['b.test.ts :: y'] })
  })
})

describe('the duration reporter', () => {
  it("records a file's import time, not only its tests", () => {
    const out = path.join(dir, 'costs.json')
    const { cmd, args } = vitestCommand(['run', '--config', config, '--reporter=dot', `--reporter=${path.join(REPO, 'scripts/lib/duration-reporter.mjs')}`, 'slow-import.test.mjs', 'pass.test.mjs'])
    spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, WALNUT_DURATIONS_OUT: out }, stdio: 'ignore' })
    const costs = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(costs['slow-import.test.mjs']).toBeGreaterThanOrEqual(850)
    expect(costs['pass.test.mjs']).toBeLessThan(costs['slow-import.test.mjs'])
  }, 60_000)
})
