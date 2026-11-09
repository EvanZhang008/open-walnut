/**
 * scripts/flaky-log.mjs: the flaky-test record. A file that failed and then passed alone twice
 * within a week is an offender until it changes, is removed, or is cleared with a reason.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { clear, offenders, readLog, record, REPEATS, WINDOW_DAYS } from '../../scripts/flaky-log.mjs'

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
    record([`${A} :: x`, `${A} :: y`], 's', { file, now: NOW - 2 * DAY })
    expect(() => clear(A, 'short', { file, now: NOW - DAY })).toThrow(/reason/)
    clear(A, 'the race in src/core/queue.ts is fixed', { file, now: NOW - DAY })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toEqual([])
    record([`${A} :: x`, `${A} :: y`], 's', { file, now: NOW - 1000 })
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toHaveLength(1)
  })

  it('reads past a damaged line, and `only` narrows to the files asked for', () => {
    const file = logFile()
    record([`${A} :: x`, `${A} :: y`, 'tests/b.test.ts :: p', 'tests/b.test.ts :: q'], 's', { file, now: NOW - DAY })
    fs.appendFileSync(file, '{not json\n')
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged })).toHaveLength(2)
    expect(offenders(readLog(file), { now: NOW, lastChange: unchanged, only: new Set(['tests/b.test.ts']) }).map((o: { file: string }) => o.file)).toEqual(['tests/b.test.ts'])
  })
})
