/**
 * scripts/ci-red-range.mjs: for a job red on main, the run where it last passed and the run
 * that turned it red, stepping over runs where it was cancelled or did not run.
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error plain .mjs without types
import { redRange, ABSENT_RUNS_END, failingTestsOf, importStemsOf, suspectReason } from '../../scripts/ci-red-range.mjs'

const runs = (list: (string | null)[]) => list.map((c, i) => ({ id: i, c }))
const of = (r: { c: string | null }) => r.c

describe('redRange', () => {
  it('newest first: the last green run and the oldest red run after it', () => {
    const r = redRange(runs(['failure', 'failure', 'cancelled', 'failure', 'success', 'failure']), of)
    expect(r.lastGreen.id).toBe(4)
    expect(r.firstRed.id).toBe(3)
  })

  it('a job red in every run read has no last green; the oldest red is where the walk ended', () => {
    const r = redRange(runs(['failure', null, 'failure']), of)
    expect(r.lastGreen).toBeNull()
    expect(r.firstRed.id).toBe(2)
  })

  it('green on the newest run: nothing turned it red', () => {
    expect(redRange(runs(['success', 'failure']), of)).toEqual({ lastGreen: { id: 0, c: 'success' }, firstRed: null })
  })
  it('a job absent from ABSENT_RUNS_END runs in a row is new: the walk stops there', () => {
    const list = ['failure', 'failure', ...Array(ABSENT_RUNS_END).fill(null), 'success']
    expect(redRange(runs(list), of)).toEqual({ lastGreen: null, firstRed: { id: 1, c: 'failure' }, isNew: true })
  })
})

describe('suspects', () => {
  it('reads the failing test files from a vitest and a Playwright log, never a passing one', () => {
    const log = [
      '2026-11-08T00:30:01.1Z  FAIL  tests/e2e/a-flow.test.ts > a > b',
      '2026-11-08T00:30:01.2Z  ✓ tests/e2e/ok.test.ts (3 tests) 900ms',
      '2026-11-08T00:30:02.0Z   ✘  12 [chromium] › tests/e2e/browser/board.spec.ts:40:3 › the board › opens (5.1s)',
      '2026-11-08T00:30:03.0Z  FAIL  tests/e2e/a-flow.test.ts > a > c',
    ].join('\n')
    expect(failingTestsOf(log)).toEqual(['tests/e2e/a-flow.test.ts', 'tests/e2e/browser/board.spec.ts'])
  })

  it('a commit is a suspect when it changed the failing test or a module it imports', () => {
    const stems = importStemsOf('tests/e2e/a-flow.test.ts', "import { x } from '../../src/core/x.js'\nvi.mock('../helpers/h')\nimport y from 'vitest'")
    expect([...stems].sort()).toEqual(['src/core/x', 'tests/helpers/h'])
    expect(suspectReason(['src/core/x.ts'], 'tests/e2e/a-flow.test.ts', stems)).toMatch(/src\/core\/x\.ts, which a-flow\.test\.ts imports/)
    expect(suspectReason(['tests/e2e/a-flow.test.ts'], 'tests/e2e/a-flow.test.ts', stems)).toMatch(/^changed tests\/e2e\/a-flow/)
    expect(suspectReason(['src/core/other.ts', 'docs/x.md'], 'tests/e2e/a-flow.test.ts', stems)).toBeNull()
  })
})
