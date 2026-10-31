/**
 * A test run's prefs copy (src/core/test-run-prefs.ts): only the run's own changes, made on its
 * first write, never by a read, and gone TEST_RUN_PREFS_IDLE_MS after its last write (every
 * automated browser shares the label `webdriver`, so a layout one run left must not stay on
 * every later one). A real request has no copy at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withTestRun } from '../../src/core/test-run.js'
import {
  TEST_RUN_PREFS_IDLE_MS, TEST_RUN_PREFS_MAX_RUNS, _resetTestRunPrefsForTest, testRunPrefsRead, testRunPrefsWrite,
} from '../../src/core/test-run-prefs.js'

const write = (label: string, key: string, v: string) =>
  withTestRun(label, () => { testRunPrefsWrite<Record<string, string>>('ui-prefs', () => ({}))![key] = v })
const read = (label: string | undefined) => withTestRun(label, () => testRunPrefsRead<Record<string, string>>('ui-prefs'))

beforeEach(() => { _resetTestRunPrefsForTest(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); _resetTestRunPrefsForTest() })

describe('test-run prefs copy', () => {
  it('a real request neither reads nor writes one', () => {
    expect(testRunPrefsWrite('ui-prefs', () => ({}))).toBeNull()
    expect(testRunPrefsRead('ui-prefs')).toBeNull()
  })

  it('a read makes none; the first write does, and each run has its own', () => {
    expect(read('a')).toBeNull()
    write('a', 'k', '1')
    expect(read('a')).toEqual({ k: '1' })
    expect(read('b')).toBeNull()
    expect(read(undefined)).toBeNull()
  })

  it('goes once its run wrote nothing for the idle time, however often it reads', () => {
    write('webdriver', 'k', '1')
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(TEST_RUN_PREFS_IDLE_MS / 5)
      expect(read('webdriver')).toEqual({ k: '1' })
    }
    vi.advanceTimersByTime(1)
    expect(read('webdriver')).toBeNull()
  })

  it('a write keeps it', () => {
    write('webdriver', 'k', '1')
    vi.advanceTimersByTime(TEST_RUN_PREFS_IDLE_MS - 1)
    write('webdriver', 'j', '2')
    vi.advanceTimersByTime(TEST_RUN_PREFS_IDLE_MS - 1)
    expect(read('webdriver')).toEqual({ k: '1', j: '2' })
  })

  it('keeps at most TEST_RUN_PREFS_MAX_RUNS runs, the oldest going first', () => {
    for (let i = 0; i <= TEST_RUN_PREFS_MAX_RUNS; i++) { write(`run-${i}`, 'k', String(i)); vi.advanceTimersByTime(1) }
    expect(read('run-0')).toBeNull()
    expect(read('run-1')).toEqual({ k: '1' })
    expect(read(`run-${TEST_RUN_PREFS_MAX_RUNS}`)).toEqual({ k: String(TEST_RUN_PREFS_MAX_RUNS) })
  })
})
