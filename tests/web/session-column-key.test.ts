/**
 * A column keeps its React key while its id changes in place (SessionSlot.key).
 *
 * 2026-10-31: a prefix deep link adopting its full id, a pending column getting its
 * session, a draft becoming its launch and plan -> exec all changed the column's key,
 * so the sessions area's auto-animate played the swap as a remove plus an insert and
 * the new panel scaled in under a click aimed at its header (WebKit: Files 24 px off
 * for a frame). Every strip transform must carry the key of a slot it keeps; the
 * coverage list below fails when sessionColumns.ts exports a new one nobody checked.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as columns from '../../web/src/pages/sessionColumns'
import type { SessionSlot } from '../../web/src/pages/sessionColumns'

const { columnKey, replaceSessionColumn, toggleLockSlot } = columns

const keyed: SessionSlot = { id: 'sess-full', locked: false, key: 'col:sess' }
const strip = (): SessionSlot[] => [{ id: 'a', locked: false }, { ...keyed }, { id: 'b', locked: true }]
const keyOf = (cols: SessionSlot[], id: string) => {
  const slot = cols.find((c) => c.id === id)
  return slot ? columnKey(slot) : undefined
}

/** Every exported strip transform, run so the keyed slot survives it. */
const TRANSFORMS: Record<string, (cols: SessionSlot[]) => SessionSlot[]> = {
  trimUnlockedToMax: (cols) => columns.trimUnlockedToMax(cols, 3),
  addSessionColumn: (cols) => columns.addSessionColumn(cols, 'c', false, 6),
  fitRestoredColumns: (cols) => columns.fitRestoredColumns(cols, 6),
  forceAddSessionColumn: (cols) => columns.forceAddSessionColumn(cols, 'c'),
  withDraftSlots: (cols) => columns.withDraftSlots(cols, ['draft:x']),
  removeSessionColumn: (cols) => columns.removeSessionColumn(cols, 'a'),
  restoreSessionColumn: (cols) => columns.restoreSessionColumn(cols, { id: 'c', locked: false }, 0, false, 6),
  replaceSessionColumn: (cols) => columns.replaceSessionColumn(cols, 'a', 'a-full'),
  toggleLockSlot: (cols) => columns.toggleLockSlot(cols, 'sess-full'),
}
/** Exports that read a strip or build one from saved ids (which carry no key). */
const NOT_TRANSFORMS = ['columnKey', 'realColumnCount', 'panelBudget', 'splitByLock', 'mergeUrlColumns']

describe('a column keeps its key while its id changes in place', () => {
  it('an in-place swap keeps the key across a chain of swaps', () => {
    let cols: SessionSlot[] = [{ id: 'draft:1', locked: false }, { id: 'other', locked: false }]
    const first = keyOf(cols, 'draft:1')
    cols = replaceSessionColumn(cols, 'draft:1', 'pending:1')
    const kept = keyOf(cols, 'pending:1')
    expect(kept).not.toBe(first)
    expect(kept).toMatch(/^col:/)
    cols = replaceSessionColumn(cols, 'pending:1', 'abc12345')
    cols = replaceSessionColumn(cols, 'abc12345', 'abc12345-full-id')
    expect(keyOf(cols, 'abc12345-full-id')).toBe(kept)
    expect(keyOf(cols, 'other')).toBe('other')
  })

  it('one id swapped away twice gives two columns two keys', () => {
    // Plan P runs into E1 in one column; P opened again runs into E2 in another.
    let cols = replaceSessionColumn([{ id: 'P', locked: false }], 'P', 'E1')
    cols = columns.forceAddSessionColumn(cols, 'P')
    cols = replaceSessionColumn(cols, 'P', 'E2')
    const keys = cols.map(columnKey)
    expect(cols.map((c) => c.id).sort()).toEqual(['E1', 'E2'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('a kept key never equals an id, so a column later opened under the old id has its own', () => {
    let cols = replaceSessionColumn([{ id: 'abc', locked: false }], 'abc', 'abc-full')
    cols = columns.forceAddSessionColumn(cols, 'abc')
    const keys = cols.map(columnKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('a swap into a column already open folds into it and keeps that column\'s key', () => {
    const cols = replaceSessionColumn([{ id: 'abc', locked: false }, { ...keyed }], 'abc', 'sess-full')
    expect(cols).toHaveLength(1)
    expect(columnKey(cols[0])).toBe('col:sess')
  })

  it('lock and unlock move the same column, key and all', () => {
    const locked = toggleLockSlot(strip(), 'sess-full')
    expect(keyOf(locked, 'sess-full')).toBe('col:sess')
    expect(keyOf(toggleLockSlot(locked, 'sess-full'), 'sess-full')).toBe('col:sess')
  })

  it.each(Object.entries(TRANSFORMS))('%s carries the key of a slot it keeps', (_name, run) => {
    expect(keyOf(run(strip()), 'sess-full')).toBe('col:sess')
  })

  it('checks every strip transform sessionColumns.ts exports', () => {
    const exported = Object.keys(columns).filter((k) => typeof (columns as Record<string, unknown>)[k] === 'function')
    expect(exported.filter((k) => !(k in TRANSFORMS) && !NOT_TRANSFORMS.includes(k)), 'exports with no key check').toEqual([])
  })

  it('MainPage keys the column by columnKey and the panel inside by its id', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/pages/MainPage.tsx'), 'utf8')
    const block = src.slice(src.indexOf('{sessionColumns.map((slot, idx) => {'))
    expect(block).toMatch(/const colKey = columnKey\(slot\);/)
    expect(block).toMatch(/<Fragment key=\{colKey\}>/)
    expect(block).not.toMatch(/<(Fragment|div) key=\{sid\}/)
    for (const panel of ['DraftSessionPanel', 'WorkspacePreparingPanel', 'PendingSessionPanel', 'SessionPanel']) {
      expect(block, `${panel} remounts for its new id`).toMatch(new RegExp(`<${panel} key=\\{sid\\}`))
    }
  })
})
