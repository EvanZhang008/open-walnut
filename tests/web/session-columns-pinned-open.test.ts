/**
 * Every way a column opens on Home keeps every pin AND the column it opened.
 *
 * 2026-11-03 report: with every Home column locked, a task started from the draft
 * column vanished as soon as its session became real (the trim after a placeholder
 * turned real took the only unpinned column, the new one). The class is "an open
 * path on a fully pinned strip": a pill click, a draft or quick-start or fork that
 * resolves, an Undo of a completed column. Each must leave all pins on screen and
 * the opened session beside them, taking the lock grant (one more column) up to the
 * ceiling, and past it keeping the new session as an overflow column (a launched
 * session) or refusing up front (a pill click, which only shows a toast).
 *
 * The ratchet at the bottom fails when sessionColumns.ts grows a helper this file
 * has not classified, so a new open path has to join the matrix.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addSessionColumn,
  forceAddSessionColumn,
  realColumnCount,
  replaceSessionColumn,
  restoreSessionColumn,
  settleOpenedColumns,
  type SessionSlot,
} from '../../web/src/pages/sessionColumns'
import { MAX_PANELS } from '../../web/src/hooks/session-panel-limits'

const pins = (n: number): SessionSlot[] => Array.from({ length: n }, (_, i) => ({ id: `pin-${i}`, locked: true }))

/** A launch from the draft column: "+" (draft) → Start (pending) → the session is real. */
function launchFromDraft(cols: SessionSlot[], triage: boolean, count: number): SessionSlot[] {
  const withDraft = forceAddSessionColumn(cols, 'draft:1')
  const pending = replaceSessionColumn(withDraft, 'draft:1', 'pending:qs-1')
  const real = replaceSessionColumn(pending, 'pending:qs-1', 'new-session')
  return settleOpenedColumns(real, pending, triage, count)
}

/** A fork or quick-start with no draft: the pending column is inserted, then resolves. */
function launchPending(cols: SessionSlot[], triage: boolean, count: number): SessionSlot[] {
  const pending = addSessionColumn(cols, 'pending:fork-1', triage, count)
  const real = replaceSessionColumn(pending, 'pending:fork-1', 'new-session')
  return settleOpenedColumns(real, pending, triage, count)
}

/** Every open path; `refusesAtCeiling` = it may answer "no room" (a toast) instead. */
const OPEN_PATHS: ReadonlyArray<{ name: string; run: (cols: SessionSlot[], triage: boolean, count: number) => SessionSlot[]; refusesAtCeiling: boolean }> = [
  { name: 'pill click (addSessionColumn)', run: (c, t, n) => addSessionColumn(c, 'new-session', t, n), refusesAtCeiling: true },
  { name: 'draft Start resolving', run: launchFromDraft, refusesAtCeiling: false },
  { name: 'fork / quick-start resolving', run: launchPending, refusesAtCeiling: false },
  {
    name: 'Undo of a completed column (restoreSessionColumn)',
    run: (c, t, n) => restoreSessionColumn(c, { id: 'new-session', locked: false }, 0, t, n),
    refusesAtCeiling: true,
  },
]

describe('an open on a fully pinned strip', () => {
  for (const p of OPEN_PATHS) {
    for (const triage of [false, true]) {
      for (let n = 1; n <= MAX_PANELS; n++) {
        const count = triage ? n + 1 : n
        it(`${p.name}: ${n} pins filling the count${triage ? ' (triage open)' : ''}`, () => {
          const before = pins(n)
          const after = p.run(before, triage, count)
          // Every pin stays, in its order.
          expect(after.filter(c => c.locked).map(c => c.id)).toEqual(before.map(c => c.id))
          const refused = !after.some(c => c.id === 'new-session')
          if (refused) {
            // Only a path that tells the user so may refuse, and only at the ceiling.
            expect(p.refusesAtCeiling).toBe(true)
            expect(n).toBe(MAX_PANELS)
            expect(after).toBe(before)
            return
          }
          // The opened session sits leftmost of the real strip, the pins to its right.
          expect(after.map(c => c.id)).toEqual(['new-session', ...before.map(c => c.id)])
          expect(realColumnCount(after)).toBe(n + 1)
        })
      }
    }
  }
})

describe('settleOpenedColumns', () => {
  it('one in, one out when a free column exists: the old free column goes, the new session stays', () => {
    const before: SessionSlot[] = [{ id: 'pending:qs-1', locked: false }, { id: 'free', locked: false }, { id: 'pin', locked: true }]
    const real = replaceSessionColumn(before, 'pending:qs-1', 'new-session')
    expect(settleOpenedColumns(real, before, false, 2).map(c => c.id)).toEqual(['new-session', 'pin'])
  })

  it('a draft closed with no launch changes nothing', () => {
    const before: SessionSlot[] = [{ id: 'draft:1', locked: false }, ...pins(2)]
    const after = before.filter(c => c.id !== 'draft:1')
    expect(settleOpenedColumns(after, before, false, 2)).toBe(after)
  })

  it('evicts at most one column for the one it adds, even over budget since an unlock', () => {
    const before: SessionSlot[] = [{ id: 'pending:qs-1', locked: false }, { id: 'a', locked: false }, { id: 'b', locked: false }, { id: 'c', locked: false }]
    const real = replaceSessionColumn(before, 'pending:qs-1', 'new-session')
    expect(settleOpenedColumns(real, before, false, 2).map(c => c.id)).toEqual(['new-session', 'a', 'b'])
  })

  it('past the ceiling the overflow column yields to the next open, one in, one out', () => {
    const strip: SessionSlot[] = [{ id: 'overflow', locked: false }, ...pins(MAX_PANELS)]
    expect(addSessionColumn(strip, 'next', false, MAX_PANELS).map(c => c.id)).toEqual(['next', ...pins(MAX_PANELS).map(c => c.id)])
  })

  it('a placeholder is never refused, even with MAX_PANELS pins', () => {
    const before = pins(MAX_PANELS)
    expect(addSessionColumn(before, 'pending:fork-1', false, MAX_PANELS).map(c => c.id)).toEqual(['pending:fork-1', ...before.map(c => c.id)])
  })
})

// ── Ratchet: every helper of the column queue is classified ──
// An OPEN helper adds a column and must appear in OPEN_PATHS above (directly or through
// a launch). The others never add a session column (or only re-key one in place).
const CLASSIFIED: Record<string, 'open' | 'not-open'> = {
  addSessionColumn: 'open',
  forceAddSessionColumn: 'open', // the draft "+" (placeholder only): launchFromDraft
  settleOpenedColumns: 'open',
  restoreSessionColumn: 'open',
  withDraftSlots: 'open', // restores draft placeholders through forceAddSessionColumn
  replaceSessionColumn: 'not-open', // swaps an id in place: same column, same pin
  removeSessionColumn: 'not-open',
  toggleLockSlot: 'not-open',
  trimUnlockedToMax: 'not-open', // capacity changes; pins exempt
  fitRestoredColumns: 'not-open',
  mergeUrlColumns: 'not-open', // a URL's strip; keeps every saved pin
  panelBudget: 'not-open',
  realColumnCount: 'not-open',
  splitByLock: 'not-open',
  columnKey: 'not-open',
}

describe('ratchet: the column queue helpers', () => {
  it('every exported helper of web/src/pages/sessionColumns.ts is classified here', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/pages/sessionColumns.ts'), 'utf8')
    const exported = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1])
    const missing = exported.filter(name => !(name in CLASSIFIED))
    expect(missing, 'a new column helper: classify it, and add an open one to OPEN_PATHS').toEqual([])
  })

  it('Home builds no column slot by hand: every write goes through a helper', () => {
    for (const file of ['../../web/src/pages/MainPage.tsx', '../../web/src/pages/useColumnCompleteClose.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
      const writes = [...src.matchAll(/setSessionColumns\(([\s\S]*?)\);\n/g)].map(m => m[1])
      for (const w of writes) {
        expect(w, `${file}: a slot literal inside setSessionColumns bypasses the pin rules`).not.toMatch(/\{\s*id:/)
      }
    }
  })
})
