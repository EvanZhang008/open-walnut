/**
 * The Scripts menu's last result per script (web/src/components/workspaces/
 * script-results.ts), read from the end line each terminal run prints with its run id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __reloadScriptResults, __resetScriptResults, busyRun, noteScriptDropped, noteTerminalAttached, noteTerminalDetached, noteScriptQueued, noteScriptStarted, noteScriptTyped, noteTerminalGone, noteTerminalOutput, scriptResultText, scriptResultsOf, settledBusyRun, waitForScriptEnd } from '../../web/src/components/workspaces/script-results'

const end = (id: string, name: string, code: number) => `\r\n\x1b]1337;walnut-run=${id}\x07\x1b[1m[${name} exited with ${code}]\x1b[0m\r\n`

describe('script results from the terminal', () => {
  beforeEach(() => __resetScriptResults())

  it('a run is running until its own end line, then passed, failed or stopped', () => {
    noteScriptStarted('s1', 'Test', 'r1', 1)
    expect(scriptResultText(scriptResultsOf('s1').get('Test')!)).toBe('Running…')
    // The echo of the typed line holds the sequence as text: not a result.
    noteTerminalOutput('s1', `$ (cd '/w' || exit 1; bun test); printf '\\n\\033]1337;walnut-run=%s\\007\\033[1m[%s exited with %s]\\033[0m\\n' 'r1' 'Test' "$?"\r\n`, 2)
    expect(scriptResultsOf('s1').get('Test')!.state).toBe('running')
    noteTerminalOutput('s1', `3 passed${end('r1', 'Test', 0)}`, 3)
    expect(scriptResultsOf('s1').get('Test')).toMatchObject({ state: 'passed', code: 0, at: 3 })
    // Split over two chunks.
    noteScriptStarted('s1', 'Test', 'r2', 4)
    const line = end('r2', 'Test', 1)
    noteTerminalOutput('s1', line.slice(0, 12), 5)
    noteTerminalOutput('s1', line.slice(12), 6)
    expect(scriptResultText(scriptResultsOf('s1').get('Test')!)).toBe('Failed (exit 1)')
    noteScriptStarted('s1', 'Dev', 'r3', 7)
    noteTerminalOutput('s1', end('r3', 'Dev', 130), 8)
    expect(scriptResultText(scriptResultsOf('s1').get('Dev')!)).toBe('Stopped')
  })

  it('an end line of an earlier run (a replay on reattach) never ends the new one', () => {
    noteScriptStarted('s1', 'Test', 'old', 1)
    noteTerminalOutput('s1', end('old', 'Test', 1), 2)
    noteScriptStarted('s1', 'Test', 'new', 3)
    noteTerminalOutput('s1', `earlier output${end('old', 'Test', 1)}`, 4)
    expect(scriptResultsOf('s1').get('Test')!.state).toBe('running')
    noteTerminalOutput('s1', end('new', 'Test', 0), 5)
    expect(scriptResultsOf('s1').get('Test')!.state).toBe('passed')
  })

  it('only that session takes it; a shell that ended drops what was still running', () => {
    noteScriptStarted('s1', 'Lint', 'a', 1)
    noteTerminalOutput('s2', end('a', 'Lint', 0), 2)
    expect(scriptResultsOf('s1').get('Lint')!.state).toBe('running')
    // s2's own scrollback says how its Lint ended; s1's run is untouched.
    expect(scriptResultsOf('s2').get('Lint')!.state).toBe('passed')
    noteTerminalGone('s1')
    expect(scriptResultsOf('s1').has('Lint')).toBe(false)
  })

  it('a reload or a reopened app keeps the results (localStorage); two-week-old ones go', () => {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) }, key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    const g = globalThis as { localStorage?: unknown }
    const had = g.localStorage
    // A session whose newest result is three weeks old.
    mem.set('walnut.scriptResults.old', JSON.stringify([['Lint', { state: 'passed', code: 0, at: Date.now() - 21 * 86400_000, runId: 'x1' }]]))
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
    try {
      noteScriptStarted('s9', 'Test', 'r9', 1)
      noteTerminalOutput('s9', end('r9', 'Test', 0), 2)
      noteScriptStarted('s9', 'Dev', 'r10', Date.now())
      noteScriptStarted('s9', 'Old', 'r11', Date.now() - 2 * 3600_000)
      __reloadScriptResults()
      // A run "running" for hours lost its end line: not shown after the reload.
      expect(scriptResultsOf('s9').has('Old')).toBe(false)
      expect(scriptResultsOf('s9').get('Test')).toMatchObject({ state: 'passed', code: 0 })
      // A run still going when the page reloaded finishes from the replayed end line.
      noteTerminalOutput('s9', end('r10', 'Dev', 2), 4)
      expect(scriptResultText(scriptResultsOf('s9').get('Dev')!)).toBe('Failed (exit 2)')
      expect(scriptResultsOf('s1').size).toBe(0)
      expect(mem.has('walnut.scriptResults.old')).toBe(false)
      expect(scriptResultsOf('old').size).toBe(0)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: had, configurable: true, writable: true })
    }
  })

  it('a run waits for its terminal, runs once typed, and says Not run when it never was', () => {
    noteScriptQueued('s3', 'Test', 'q1', 1)
    expect(scriptResultText(scriptResultsOf('s3').get('Test')!)).toBe('Waiting for the terminal…')
    noteScriptTyped('s3', 'q1', 2)
    expect(scriptResultsOf('s3').get('Test')).toMatchObject({ state: 'running', at: 2 })
    // Dropped after it was typed: nothing changes.
    noteScriptDropped('s3', 'q1', 3)
    expect(scriptResultsOf('s3').get('Test')!.state).toBe('running')
    noteScriptQueued('s3', 'Lint', 'q2', 4)
    noteScriptDropped('s3', 'q2', 5)
    expect(scriptResultText(scriptResultsOf('s3').get('Lint')!)).toBe('Not run')
  })

  it('a run still waiting for its terminal when the page closed reads Not run on the next page', () => {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) }, key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    const g = globalThis as { localStorage?: unknown }
    const had = g.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
    try {
      noteScriptQueued('s4', 'Test', 'q3', Date.now())
      __reloadScriptResults()
      expect(scriptResultsOf('s4').get('Test')!.state).toBe('notrun')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: had, configurable: true, writable: true })
    }
  })

  it('waits for a stopped run to print its end line, or gives up', async () => {
    vi.useFakeTimers()
    try {
      noteScriptStarted('s5', 'Install', 'w1', 1)
      const ended = waitForScriptEnd('s5', 'w1', 5_000)
      noteTerminalOutput('s5', end('w1', 'Install', 130), 2)
      await expect(ended).resolves.toBe(true)
      expect(scriptResultText(scriptResultsOf('s5').get('Install')!)).toBe('Stopped')
      noteScriptStarted('s5', 'Dev', 'w2', 3)
      const late = waitForScriptEnd('s5', 'w2', 5_000)
      vi.advanceTimersByTime(5_000)
      await expect(late).resolves.toBe(false)
      await expect(waitForScriptEnd('s5', 'w1', 10)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('only a run going on in the attached terminal holds the next one; a lost end line never does', () => {
    const start = (id: string) => `\x1b]1337;walnut-run-start=${id}\x07`
    const g1 = noteTerminalAttached('s6')
    noteScriptQueued('s6', 'Dev', 'd1', 1)
    noteScriptTyped('s6', 'd1', 2)
    expect(busyRun('s6')?.[0]).toBe('Dev')
    // The terminal closes: its end line can no longer be seen.
    noteTerminalDetached('s6', g1)
    expect(busyRun('s6')).toBeUndefined()
    // Opened again with a fresh shell (nothing replayed): Dev still reads Running, but holds nothing.
    noteTerminalAttached('s6')
    noteTerminalOutput('s6', '$ ', 3)
    expect(scriptResultsOf('s6').get('Dev')!.state).toBe('running')
    expect(busyRun('s6')).toBeUndefined()
    // Opened again on the same shell: its replay shows Dev started and not ended, so it runs here.
    noteTerminalAttached('s6')
    noteTerminalOutput('s6', `${start('d1')}dev server on :5173\r\n`, 4)
    expect(busyRun('s6')?.[0]).toBe('Dev')
    noteTerminalOutput('s6', end('d1', 'Dev', 130), 5)
    expect(busyRun('s6')).toBeUndefined()
  })

  it("a replayed scrollback tells how a script with no result here last ended; it never overrides one", () => {
    noteTerminalOutput('s7', `$ ${end('x1', 'Lint', 0)}$ ${end('x2', 'Test', 1)}`, 1)
    expect(scriptResultsOf('s7').get('Lint')).toMatchObject({ state: 'passed', runId: 'x1' })
    expect(scriptResultText(scriptResultsOf('s7').get('Test')!)).toBe('Failed (exit 1)')
    noteScriptQueued('s7', 'Test', 'x3', 2, 'bun test')
    noteScriptTyped('s7', 'x3', 3)
    noteTerminalOutput('s7', end('x3', 'Test', 0), 4)
    expect(scriptResultsOf('s7').get('Test')).toMatchObject({ state: 'passed', command: 'bun test' })
    // The old run's end line again (a reattach): the newer result stays.
    noteTerminalOutput('s7', end('x2', 'Test', 1), 5)
    expect(scriptResultsOf('s7').get('Test')!.state).toBe('passed')
  })

  it('a terminal opened a moment ago gets time to show that a run typed before still goes on', async () => {
    vi.useFakeTimers()
    try {
      const start = (id: string) => `\x1b]1337;walnut-run-start=${id}\x07`
      const g1 = noteTerminalAttached('s8')
      noteScriptQueued('s8', 'Install', 'i1', Date.now())
      noteScriptTyped('s8', 'i1', Date.now())
      noteTerminalDetached('s8', g1)
      // Reopened: its replay is not here yet, so nothing is known to run.
      noteTerminalAttached('s8')
      expect(busyRun('s8')).toBeUndefined()
      const asked = settledBusyRun('s8')
      vi.advanceTimersByTime(500)
      noteTerminalOutput('s8', `${start('i1')}Resolving 3 packages\r\n`)
      await expect(asked).resolves.toMatchObject(['Install', { runId: 'i1' }])
      // A fresh shell (the old one was let go): the wait ends at the grace, with nothing to hold.
      noteTerminalOutput('s8', end('i1', 'Install', 0))
      noteScriptQueued('s8', 'Lint', 'l1', Date.now())
      noteScriptTyped('s8', 'l1', Date.now())
      noteTerminalAttached('s8')
      const fresh = settledBusyRun('s8')
      vi.advanceTimersByTime(2_500)
      await expect(fresh).resolves.toBeUndefined()
      // Long after the attach it answers at once.
      vi.advanceTimersByTime(5_000)
      await expect(settledBusyRun('s8')).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
