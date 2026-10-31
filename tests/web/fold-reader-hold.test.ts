/**
 * Where a fold meets a scrolled-up reader (fold-reader-hold.ts): over rows they
 * can see it opens; rows all above them fold with their row held; rows never
 * drawn (older rows just loaded, rows a closed fold held) or all below them fold
 * as usual. A fold is weighed for the rows that joined it, each looked up the way
 * last commit drew it: a message row by its id, a run by its tool calls, else by
 * the index the row had then.
 */
import { describe, expect, it } from 'vitest'
import {
  foldPlace, joinedRows, keysOfElement, readReaderView, restoreReaderRow, rowKeysAttr, rowsAsDrawn,
  type HeldBefore, type ReaderView,
} from '@/components/sessions/fold-reader-hold'

// The viewport is 1000..1400 on screen.
const view: ReaderView = {
  top: 1000,
  bottom: 1400,
  keys: new Map([
    ['m:above', { top: 600, bottom: 900 }],
    ['m:edge', { top: 900, bottom: 1000 }],
    ['m:seen', { top: 1300, bottom: 1500 }],
    ['m:below', { top: 1400, bottom: 1600 }],
    ['t:call-1', { top: 950, bottom: 1250 }],
  ]),
  indices: new Map([[40, { top: 100, bottom: 300 }], [59, { top: 1100, bottom: 1200 }]]),
  anchor: { key: 'm:seen', top: 1300 },
}

describe('foldPlace', () => {
  it('a row in view makes the fold open, by key (message id or tool call) or by history index', () => {
    expect(foldPlace(view, { keys: ['m:above', 'm:seen'], indices: [] })).toBe('inside')
    expect(foldPlace(view, { keys: ['t:call-1'], indices: [] })).toBe('inside')
    expect(foldPlace(view, { keys: [], indices: [40, 59] })).toBe('inside')
  })

  it('rows all above the viewport, one ending at its top edge included, are above', () => {
    expect(foldPlace(view, { keys: ['m:above', 'm:edge'], indices: [40] })).toBe('above')
  })

  it('rows below the viewport, starting at its bottom edge included, leave the fold alone', () => {
    expect(foldPlace(view, { keys: ['m:below'], indices: [] })).toBeNull()
  })

  it('rows that were not drawn last commit leave the fold alone', () => {
    expect(foldPlace(view, { keys: ['m:older-1', 'm:older-2'], indices: [3, 4] })).toBeNull()
    expect(foldPlace(view, { keys: [], indices: [] })).toBeNull()
  })
})

interface Row { id?: string; text: string; tools?: string[]; own?: boolean }

/** Keys as the timeline gives them: a row's id only when it is drawn as its own row. */
const keysOf = (r: Row) => [...(r.id && r.own !== false ? [`m:${r.id}`] : []), ...(r.tools ?? []).map((t) => `t:${t}`)]

function heldBefore(rows: readonly Row[], blockKeys: readonly string[] = []): HeldBefore<Row> {
  const keys = new Set<string>(blockKeys)
  for (const r of rows) {
    if (r.id) keys.add(`m:${r.id}`)
    for (const t of r.tools ?? []) keys.add(`t:${t}`)
  }
  return { keysOf, keys, indexOf: new Map(rows.map((r, i) => [r, i])) }
}

describe('joinedRows', () => {
  const a: Row = { id: 'a', text: 'a' }
  const b: Row = { id: 'b', text: 'b' }
  const c: Row = { text: 'c' }

  it('a new fold weighs every row; an unchanged or smaller one weighs none', () => {
    expect(joinedRows(new Set([a, b]), undefined)).toEqual([a, b])
    expect(joinedRows(new Set([a, b]), new Set([a, b]))).toEqual([])
    expect(joinedRows(new Set([a]), new Set([a, b]))).toEqual([])
  })

  it('a fold that grew under its key weighs the rows that joined it', () => {
    // The turn's fold over the message that started it, then over the turn's work too.
    expect(joinedRows(new Set([a, b, c]), new Set([a]))).toEqual([b, c])
  })
})

describe('rowsAsDrawn', () => {
  it('names a row by its id, a stream block twin included, by its tool calls, and by the index it had then', () => {
    const rows: Row[] = [{ id: 'h0', text: '0' }, { text: 'no id' }]
    const persisted: Row = { id: 'stream-1', text: 'persisted twin of a stream block' }
    const run: Row = { text: '', tools: ['call-1'], own: false }
    expect(rowsAsDrawn([rows[1], persisted, run], heldBefore(rows, ['m:stream-1', 't:call-1'])))
      .toEqual({ keys: ['m:stream-1', 't:call-1'], indices: [1] })
  })

  it('a row derived into a run never borrows the id of the row it came from', () => {
    // The answer's reasoning moves into the fold before it with the answer's id;
    // the reader reading the answer must not open that fold.
    const answer: Row = { id: 'answer', text: 'the answer' }
    const reasoning: Row = { id: 'answer', text: '', own: false }
    const then = heldBefore([answer])
    expect(rowsAsDrawn([reasoning], then)).toBeNull()
    expect(foldPlace({ ...view, keys: new Map([['m:answer', { top: 1100, bottom: 1300 }]]) }, { keys: keysOf(reasoning), indices: [] })).toBeNull()
  })

  it('rows last commit never held need no DOM', () => {
    const rows: Row[] = [{ id: 'h0', text: '0' }]
    expect(rowsAsDrawn([{ id: 'older', text: 'an older page' }, { text: 'older, no id' }], heldBefore(rows))).toBeNull()
  })

  it('after rows were inserted above, a fold of the inserted rows is not read off the rows that moved down', () => {
    // Last commit drew rows 0..2; the reader sees row 2 (index 2 then). A gap fill
    // inserts two rows at index 1, so row 2 is index 4 now and the new rows are 1
    // and 2: by today's index, the new fold would claim the reader's row.
    const then: Row[] = [{ text: 'r0' }, { text: 'r1' }, { text: 'r2' }]
    const inserted: Row[] = [{ text: 'gap 1' }, { text: 'gap 2' }]
    const reading = new Map([[2, { top: 1100, bottom: 1200 }]])
    const v: ReaderView = { top: 1000, bottom: 1400, keys: new Map(), indices: reading, anchor: null }
    expect(rowsAsDrawn(inserted, heldBefore(then))).toBeNull()
    expect(foldPlace(v, { keys: [], indices: [1, 2] }), 'today\'s indices would have said inside').toBe('inside')
    // A fold that takes the row the reader sees finds it at its index then.
    expect(foldPlace(v, rowsAsDrawn([then[2]], heldBefore(then))!)).toBe('inside')
  })
})

/** An element as the helpers read it: its data attributes and its box. */
function el(data: Record<string, string>, top: number, bottom: number) {
  let at = { top, bottom }
  return {
    dataset: data,
    getBoundingClientRect: () => ({ top: at.top, bottom: at.bottom }),
    move: (dy: number) => { at = { top: at.top + dy, bottom: at.bottom + dy } },
  }
}

function box(els: ReturnType<typeof el>[]) {
  const b = {
    scrollTop: 500,
    getBoundingClientRect: () => ({ top: 1000, bottom: 1400 }),
    querySelectorAll: () => els,
  }
  return b as unknown as HTMLElement & { scrollTop: number }
}

describe('keys on the DOM', () => {
  it('a row wears its message id and the keys it lists', () => {
    expect(keysOfElement(el({ messageId: 'x', rowKeys: 't:a t:b' }, 0, 1) as unknown as HTMLElement)).toEqual(['m:x', 't:a', 't:b'])
    expect(rowKeysAttr(['a', undefined, 'b'], ['m1'])).toBe('t:a t:b m:m1')
    expect(rowKeysAttr([undefined])).toBeUndefined()
  })

  it('the anchor is the innermost row across the top edge: the step inside an open run, not the run', () => {
    const run = el({ msgIndex: '7', rowKeys: 't:a t:b' }, 200, 1800)
    const step = el({ messageId: 'step' }, 900, 1150)
    const v = readReaderView(box([run, step]))
    expect(v.anchor).toEqual({ key: 'm:step', top: 900 })
    expect(v.keys.get('t:a')).toEqual({ top: 200, bottom: 1800 })
    expect(v.indices.get(7)).toEqual({ top: 200, bottom: 1800 })
  })

  it('with nothing across the top edge, the first row below it; a sliver at the edge is not read', () => {
    const sliver = el({ messageId: 'sliver' }, 900, 1010)
    const next = el({ rowKeys: 't:c' }, 1050, 1200)
    expect(readReaderView(box([sliver, next])).anchor).toEqual({ key: 't:c', top: 1050 })
  })

  it('a held row goes back where it was, by any key it wears, the nearer of two copies', () => {
    const block = el({ messageId: 'p' }, 1200, 1300)
    const twin = el({ messageId: 'p' }, 1600, 1700)
    const b = box([block, twin])
    restoreReaderRow(b, { key: 'm:p', top: 1150 })
    expect(b.scrollTop).toBe(550)
    const run = el({ rowKeys: 't:z' }, 1300, 1400)
    const b2 = box([run])
    restoreReaderRow(b2, { key: 't:z', top: 1000 })
    expect(b2.scrollTop).toBe(800)
  })
})
