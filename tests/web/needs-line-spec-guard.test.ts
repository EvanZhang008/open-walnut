/**
 * Guard: a browser spec finds a task's own ask where Home draws it, the Action needed block under
 * the row (rowAsk in tests/e2e/browser/agent-text-entry-helpers.ts), never in the row's Needs you
 * line (`status-card-needs-line`), which says nothing while its words are an item (ownLineIsItem,
 * src/core/action-needed.ts; StatusSections.tsx `shownReason`).
 *
 * 2026-11-20, nightly "Browser specs with their own fixture": since the row's asks moved into the
 * Action needed block (2026-11-19), agent-status-source.spec.ts and agent-text-entries.spec.ts
 * still looked for the ask's path in the line, found nothing and failed seven tests.
 *
 * The class, found from the source: every browser spec that reads the line for anything but its
 * absence. A spec is listed below only with why its line is no item (a usage limit's own wait); a
 * new spec reading the line fails here until it reads the block or says why.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BROWSER = join(__dirname, '..', 'e2e', 'browser')

/** Specs whose Needs you line is no item, with why. */
const LINE_IS_NO_ITEM: Record<string, string> = {
  'session-usage-limit.spec.ts': 'a usage limit the user turned off is his own wait (source limit), no answerable item',
}

/** Each use of the line in a spec that is not a check that it is gone. */
function lineReads(text: string): string[] {
  return text.split('\n')
    .filter((l) => l.includes('status-card-needs-line'))
    .filter((l) => !/\.toHaveCount\(0\)/.test(l))
}

describe('browser specs read a task\'s ask in its Action needed block', () => {
  const specs = readdirSync(BROWSER).filter((f) => f.endsWith('.ts'))

  it('no spec reads the row\'s Needs you line for its ask, unless it says why that line is no item', () => {
    const offenders = specs
      .filter((f) => !(f in LINE_IS_NO_ITEM))
      .map((f) => ({ f, reads: lineReads(readFileSync(join(BROWSER, f), 'utf8')) }))
      .filter((x) => x.reads.length > 0)
      .map((x) => `${x.f}: ${x.reads[0]!.trim()}`)
    expect(offenders, 'read the ask with rowAsk(panel, taskId) (agent-text-entry-helpers.ts), or list the spec with why its line is no item').toEqual([])
  })

  it('every listed spec still reads the line, so the list never outlives its reason', () => {
    for (const f of Object.keys(LINE_IS_NO_ITEM)) {
      expect(lineReads(readFileSync(join(BROWSER, f), 'utf8')).length, f).toBeGreaterThan(0)
    }
  })

  it('the shared helper reads the block, and checks the line is gone', () => {
    const helpers = readFileSync(join(BROWSER, 'agent-text-entry-helpers.ts'), 'utf8')
    expect(helpers).toContain('[data-asks-for="${taskId}"] [data-testid="action-summary"]')
    expect(helpers).toMatch(/getByTestId\('status-card-needs-line'\)\)\.toHaveCount\(0\)/)
  })
})
