/**
 * scripts/flaky-log.mjs: the flaky-test record. A file that failed and then passed alone in two
 * runs within a week is an offender until it changes, is removed, or is cleared with a reason.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { clear, judgeRun, offenders, readLog, record, REPEATS, WINDOW_DAYS } from '../../scripts/flaky-log.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-09T12:00:00Z')
const dirs: string[] = []
const logFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-log-')); dirs.push(d); return path.join(d, 'flaky.jsonl') }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const A = 'tests/a.test.ts'
const unchanged = () => null

describe('flaky-log', () => {
  it(`a file flaky ${REPEATS} times within ${WINDOW_DAYS} days is an offender; once is not`, () => {
    const file = logFile()
    record([`${A} :: races`], 'gate 1', { file, now: NOW - 2 * DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toEqual([])
    record([`${A} :: races again`], 'gate 2', { file, now: NOW - DAY })
    const list = offenders(readLog(file), { now: NOW, lastChange: unchanged })
    expect(list.map((o: { file: string }) => o.file)).toEqual([A])
    expect(list[0].flakes.map((r: { source: string }) => r.source)).toEqual(['gate 1', 'gate 2'])
  })

  it('two tests of one file flaking in one run are one flake of the file, not two', () => {
    const file = logFile()
    record([`${A} :: one`, `${A} :: two`, `${A} :: three`], 'test-layers local', { file, now: NOW - DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toEqual([])
    record([`${A} :: one`], 'test-layers local', { file, now: NOW - DAY / 2 })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged }).map((o: { file: string }) => o.file)).toEqual([A])
  })

  it("the gate leaves out local runs (a task's own clone), a local check reads them", () => {
    const file = logFile()
    record([`${A} :: x`], 'test-layers local', { file, now: NOW - 2 * DAY })
    record([`${A} :: x`], 'test-layers land', { file, now: NOW - DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged, gateOnly: true })).toEqual([])
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toHaveLength(1)
    record([`${A} :: x`], 'push-gate abc', { file, now: NOW - DAY / 2 })
    record([`${A} :: x`], 'push-gate def', { file, now: NOW - DAY / 4 })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged, gateOnly: true })).toHaveLength(1)
  })

  it('a flake older than the window does not count', () => {
    const file = logFile()
    record([`${A} :: x`], 'old', { file, now: NOW - (WINDOW_DAYS + 1) * DAY })
    record([`${A} :: x`], 'new', { file, now: NOW - DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toEqual([])
  })

  it('a change to the file after its flakes, or its removal, clears it', () => {
    const file = logFile()
    record([`${A} :: x`], 's', { file, now: NOW - 3 * DAY })
    record([`${A} :: x`], 's', { file, now: NOW - 2 * DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: () => NOW - DAY })).toEqual([])
    expect(offenders(readLog(file), { now: NOW, lastChange: () => 'gone' })).toEqual([])
    expect(offenders(readLog(file), { now: NOW, lastChange: () => NOW - 4 * DAY })).toHaveLength(1)
  })

  it('a clear with a reason ends it; a clear without one is refused', () => {
    const file = logFile()
    record([`${A} :: x`], 's', { file, now: NOW - 3 * DAY })
    record([`${A} :: y`], 's', { file, now: NOW - 2 * DAY })
    expect(() => clear(A, 'short', { file, now: NOW - DAY })).toThrow(/reason/)
    clear(A, 'the race in src/core/queue.ts is fixed', { file, now: NOW - DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toEqual([])
    record([`${A} :: x`], 's', { file, now: NOW - 2000 })
    record([`${A} :: y`], 's', { file, now: NOW - 1000 })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toHaveLength(1)
  })

  it('reads past a damaged line, and `only` narrows to the files asked for', () => {
    const file = logFile()
    record([`${A} :: x`, 'tests/b.test.ts :: p'], 's', { file, now: NOW - 2 * DAY })
    record([`${A} :: y`, 'tests/b.test.ts :: q'], 's', { file, now: NOW - DAY })
    fs.appendFileSync(file, '{not json\n')
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toHaveLength(2)
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged, only: new Set(['tests/b.test.ts']) }).map((o: { file: string }) => o.file)).toEqual(['tests/b.test.ts'])
  })

  // 2026-11-14: two 11-12 flakes of one file failed every later `bun run test` whose tests of it
  // all passed. A run fails only on a file that flaked in it too; the rest are named, not failed on.
  it('a run fails only on a file that flaked in it; one on the record that passed here is standing', () => {
    const file = logFile()
    record([`${A} :: races`], 'gate 1', { file, now: NOW - 3 * DAY })
    record([`${A} :: races`], 'gate 2', { file, now: NOW - 2 * DAY })
    const passed = judgeRun([], { rows: readLog(file), now: NOW, lastChange: unchanged })
    expect(passed.failing).toEqual([])
    expect(passed.standing.map((o: { file: string }) => o.file)).toEqual([A])
    const other = judgeRun(['tests/b.test.ts :: once'], { rows: readLog(file), now: NOW, lastChange: unchanged })
    expect(other.failing).toEqual([])
    record([`${A} :: races`], 'gate 3', { file, now: NOW - DAY })
    const again = judgeRun([`${A} :: races`], { rows: readLog(file), now: NOW, lastChange: unchanged })
    expect(again.failing.map((o: { file: string }) => o.file)).toEqual([A])
    expect(again.standing).toEqual([])
    // `only` still narrows what a run names.
    expect(judgeRun([], { rows: readLog(file), now: NOW, lastChange: unchanged, only: new Set(['tests/c.test.ts']) }).standing).toEqual([])
  })

  // The class: every script that judges a run on the record goes through judgeRun, so none fails a run
  // on a file whose tests all passed in it. Enumerated from the scripts that import flaky-log.mjs.
  it('every script that reads the record judges a run with judgeRun, never offenders() alone', () => {
    const dir = path.resolve(__dirname, '../../scripts')
    const users = fs.readdirSync(dir).filter((f) => /\.(mjs|sh)$/.test(f) && f !== 'flaky-log.mjs')
      .filter((f) => /flaky-log\.mjs/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(users.sort()).toEqual(['push-gate.sh', 'test-baseline.mjs', 'test-layers.mjs'])
    for (const f of users.filter((u) => u.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      expect(src, f).toMatch(/judgeRun\(/)
      expect(src, f).not.toMatch(/\boffenders\(/)
    }
    // The push gate calls the CLI's `gate`, which judges with judgeRun.
    expect(fs.readFileSync(path.join(dir, 'push-gate.sh'), 'utf8')).toMatch(/flaky-log\.mjs gate /)
  })
})
