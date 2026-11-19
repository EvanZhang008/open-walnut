/**
 * Browser specs share one fixture server, and spec files run in parallel workers. Two
 * classes of cross-spec interference reached CI on 2026-11-07:
 *
 * 1. A fixture task one spec writes (renames, completes, resets) was written by a second
 *    spec too: task-store-detail-popup-instant reused pw-task-store-sync, which
 *    task-store-same-browser-instant renames and completes mid-run, and opened on the other
 *    spec's title with its row Done. A fixture task a spec writes belongs to that spec alone;
 *    another spec makes its own task.
 * 2. A kanban spec read every worker's notices in the window's one corner: another team's
 *    seeded Bash prompts held the corner, the full-screen sheet moved past it, the board pane
 *    fell under 600px and the lane strip (wide mode only) was gone mid-test
 *    (board-kanban-controls C53). Every kanban spec keeps the corner to the board's own toasts
 *    (keepCornerToBoard), as the others already did.
 * 3. A Home side bar one spec opened stayed open for the specs after it (2026-11-18): the
 *    notes stress spec opened the Scratchpad, the page wrote it to the shared server's UI
 *    prefs, and every later page booted with it open over its session column's composer, so
 *    the drawing and Latest update specs timed out on the "+" button and the narrow header
 *    spec measured a squeezed "wide" column. Every file that opens a side bar (Agenda,
 *    Scratchpad, Routines) keeps it to its own page with isolateUiPrefs.
 * 4. Two specs moved the server's one tunnel under each other's phones (2026-11-18):
 *    phone-settings turned the tunnel on again (a new address) and off while
 *    browser-access-tunnel's phones were open through it, so its removed-phone test reloaded
 *    into ERR_CONNECTION_REFUSED and phone-settings C75 timed out; each also took "the newest
 *    browser" as its own phone. Every file that drives the tunnel or signs a browser in does
 *    it through sign-in-state.ts, whose calls put it in the one-at-a-time sign-in group
 *    (one-at-a-time-specs.ts), and names its phone by its own sign-in.
 * 5. A page that shows a phone link hears every browser sign-in on the server (2026-11-19):
 *    browser-access-addresses served its own links and counted them, and a phone that
 *    browser-access-tunnel signed in beside it made its page ask for a third. Every file that
 *    serves its page's links does it with sign-in-state.ts's serveBrowserCodes, which puts it
 *    in the sign-in group too.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SIGN_IN_CALL } from '../e2e/browser/one-at-a-time-specs'

const DIR = path.resolve(import.meta.dirname, '../e2e/browser')
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'))
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf-8')
/** Specs and their helpers: a helper that opens a side bar leaks it for every spec calling it. */
const sources = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))

/** Pairs that write different fields of one fixture task and read neither field of the other's. */
const SHARED_WRITERS: Record<string, { files: string[]; why: string }> = {
  'pw-task-vscode': {
    files: ['kebab-menu-viewport-fit.spec.ts', 'session-header-title-row.spec.ts'],
    why: 'kebab-menu-viewport-fit only resets the phase to IN_PROGRESS and finds the row by id; session-header-title-row only sets the title it then reads',
  },
}

describe('browser specs keep out of each other\'s data', () => {
  it('a fixture task a spec writes is written by no other spec', () => {
    const writers = new Map<string, string[]>()
    for (const f of specs) {
      const src = read(f)
      const id = /const TASK_ID = '([^']+)'/.exec(src)?.[1]
      if (!id) continue
      const writes = /\.patch\(\s*`\/api\/(v1\/)?tasks\/\$\{TASK_ID\}`/.test(src) || /\/api\/(v1\/)?tasks\/\$\{TASK_ID\}\/toggle-complete/.test(src)
      if (writes) writers.set(id, [...(writers.get(id) ?? []), f])
    }
    expect(writers.size).toBeGreaterThan(0)
    const shared = [...writers].filter(([id, files]) => files.length > 1
      && !(SHARED_WRITERS[id] && files.every((f) => SHARED_WRITERS[id].files.includes(f))))
    expect(shared, 'give the second spec a task of its own (create it in the test, delete it after)').toEqual([])
  })

  it('every kanban spec keeps the notice corner to the board', () => {
    const kanban = specs.filter((f) => f.startsWith('board-kanban-'))
    expect(kanban.length).toBeGreaterThan(5)
    const missing = kanban.filter((f) => !/await keepCornerToBoard\(/.test(read(f)))
    expect(missing, 'call keepCornerToBoard(context) in the spec\'s beforeEach').toEqual([])
  })

  it('a file that opens a Home side bar keeps it out of the shared UI prefs', () => {
    // todo-panel-helpers defines both openScratchpad and isolateUiPrefs.
    const opens = sources.filter((f) => f !== 'todo-panel-helpers.ts'
      && /openScratchpad\(|sidebar-toggle-(scratchpad|calendar|routines)/.test(read(f)))
    expect(opens.length).toBeGreaterThan(10)
    const missing = opens.filter((f) => !/isolateUiPrefs\(|\/api\/ui-prefs/.test(read(f)))
    expect(missing, 'call isolateUiPrefs(page) before the page opens Home').toEqual([])
  })

  it('a file that drives the tunnel, signs a browser in or serves the phone links does it through sign-in-state', () => {
    // A direct write of the server's tunnel (config.yaml's expose, PUT /api/expose) or of its
    // browser sign-ins (a code, a code traded, a browser record made or removed).
    const WRITES = /\.(?:put|post)\(\s*[`'"]\/api\/(?:expose|devices\/browser-code|v1\/browser-pair)\b|\.delete\(\s*[`'"]\/api\/devices\/|\bready_pattern\b|putExactSection\([^)]*['"]expose['"]|name:\s*`browser-/
    expect(WRITES.test(read('sign-in-state.ts')), 'the pattern still finds the helper\'s own writes').toBe(true)
    // A spec that writes it must call the helpers, so playwright.config.ts puts it in the group.
    const writers = specs.filter((f) => WRITES.test(read(f)) && !SIGN_IN_CALL.test(read(f)))
    expect(writers, 'drive the tunnel and sign browsers in with tests/e2e/browser/sign-in-state.ts').toEqual([])
    // A page answered with links of the spec's own still makes a new one when any browser signs
    // in on the server, so the spec reads that state: it serves them with serveBrowserCodes.
    const SERVES = /\.route\(\s*[`'"][^`'"]*\/api\/devices\/browser-code/
    expect(SERVES.test(read('sign-in-state.ts')), 'the pattern still finds the helper\'s own route').toBe(true)
    const readers = specs.filter((f) => SERVES.test(read(f)))
    expect(readers, 'serve the page\'s phone links with serveBrowserCodes (tests/e2e/browser/sign-in-state.ts)').toEqual([])
    // The group is found in spec files only: a shared helper that writes it would take its callers out.
    const helpers = sources.filter((f) => !f.endsWith('.spec.ts') && f !== 'sign-in-state.ts' && (WRITES.test(read(f)) || SERVES.test(read(f)) || SIGN_IN_CALL.test(read(f))))
    expect(helpers, 'call sign-in-state.ts from the spec itself').toEqual([])
  })
})
