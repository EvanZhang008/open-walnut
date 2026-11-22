/**
 * A browser spec opens a session's Board through `openSessionBoard` (or leaves it through
 * `closeSessionBoard`) in tests/e2e/browser/board-view-helpers.ts, never by clicking the
 * header's Board chip itself. The header folds the chip into its "..." menu when the row is
 * too narrow (web/src/components/sessions/useSessionHeaderFit.ts: Board leaves just before
 * Terminal), and a phone keeps it hidden; a direct click then waits on a hidden chip until the
 * test times out. 2026-11-22: the session header's keys moved onto the wider button family,
 * the chip folded in a 460px Home column, and both replica away specs failed in the nightly run.
 *
 * Only a spec whose subject is the chip on the row itself (it asserts the chip is visible, then
 * presses it) clicks it directly, and is listed below with its count and why.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../e2e/browser')
const HELPER = 'board-view-helpers.ts'

/** Specs that press the chip on the row on purpose: file -> how many presses, and why. */
const ON_THE_ROW: Record<string, { count: number; why: string }> = {
  'session-board-tab-lead-only.spec.ts': { count: 4, why: 'the tab itself: it is on the row for a lead, and pressing it again leaves the Board' },
  'session-header-chips-hold-place.spec.ts': { count: 1, why: 'the chip holds its place on the row, then acts' },
  'task-board.spec.ts': { count: 1, why: 'the chip arrives live on the row with the first worker, then opens the Board' },
}

const CHIP = String.raw`getByTestId\(\s*['"]session-board-chip['"]\s*\)`
const PRESS = String.raw`\.(?:click|tap|dblclick|dispatchEvent)\(`
const DIRECT = new RegExp(CHIP + String.raw`\s*` + PRESS, 'g')
/** `const chip = panel.getByTestId('session-board-chip')`, or an arrow that returns it. */
const BINDING = new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?[\w.()]*` + CHIP + String.raw`\s*$`, 'gm')

/** Every press of the Board chip in `text`: a direct click, or one through a name bound to the chip. */
function boardChipPresses(text: string): number {
  let n = (text.match(DIRECT) ?? []).length
  for (const [, name] of text.matchAll(BINDING)) {
    const call = String.raw`\b${name}\b(?:\([^)]*\))?`
    n += (text.match(new RegExp(call + PRESS, 'g')) ?? []).length
    // A helper that presses by native input: press(page, chip), pointer(page, chip(panel)).
    n += (text.match(new RegExp(String.raw`\w+\(\s*page\s*,\s*` + call + String.raw`\s*[,)]`, 'g')) ?? []).length
  }
  return n
}

function specSources(): Array<{ file: string; text: string }> {
  return fs.readdirSync(DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.includes('node_modules'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }))
}

describe('a spec that opens a session Board', () => {
  it('goes through openSessionBoard, never a click on the header chip', () => {
    const found: Record<string, number> = {}
    for (const { file, text } of specSources()) {
      if (file === HELPER) continue
      const n = boardChipPresses(text)
      if (n > 0) found[file] = n
    }
    const expected = Object.fromEntries(Object.entries(ON_THE_ROW).map(([f, v]) => [f, v.count]))
    expect(found, 'open the Board with openSessionBoard(page, panel) from board-view-helpers.ts').toEqual(expected)
  })

  it('catches the shapes it was written for', () => {
    expect(boardChipPresses("  await panel.getByTestId('session-board-chip').click()")).toBe(1)
    expect(boardChipPresses("  const chip = panel.getByTestId('session-board-chip')\n  await chip.click()")).toBe(1)
    expect(boardChipPresses("const chip = (panel: Locator) => panel.getByTestId('session-board-chip')\nawait chip(panel).click()")).toBe(1)
    expect(boardChipPresses("  const chip = panel.getByTestId('session-board-chip')\n  await pointer(page, chip)")).toBe(1)
    // Reading the chip is not pressing it.
    expect(boardChipPresses("  const chip = panel.getByTestId('session-board-chip')\n  await expect(chip).toBeVisible()")).toBe(0)
    expect(boardChipPresses("  const pane = await openSessionBoard(page, panel)")).toBe(0)
  })
})
