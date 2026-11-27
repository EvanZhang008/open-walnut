/**
 * A held row drawn again in another form in its own place is the same row (useScrollAnchor
 * followRedrawn; 2026-11-27: folding the first Threads card by its × left 728px of blank above the
 * list). Pinned on the DOM alone: the same card folded in its group is followed; a card drawn in
 * another group, or a watched thread's copy above the groups, is not.
 */
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { followRedrawn, type Anchor } from '../../web/src/hooks/useScrollAnchor'
import { threadRowKey } from '../../web/src/components/org/useThreadsHold'

const ROWS = '[data-testid="org-thread"]'

function page(html: string) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="box">${html}</div></body></html>`)
  // linkedom draws nothing: every row in the document has a box.
  const proto = Object.getPrototypeOf(document.body) as { getClientRects: () => unknown[] }
  Object.getPrototypeOf(proto).getClientRects = function (this: { isConnected: boolean }) { return this.isConnected ? [{}] : [] }
  return { document, box: document.getElementById('box') as unknown as HTMLElement }
}
const row = (id: string, group: string, extra = '') => `<li data-testid="org-thread" data-thread-id="${id}" data-group="${group}" ${extra}></li>`
const rowsOf = (box: HTMLElement) => Array.from(box.querySelectorAll(ROWS))
const heldOn = (box: HTMLElement, i: number): Anchor => {
  const list = rowsOf(box)
  return { el: list[i]!, read: true, top: 0, scrollTop: 0, prev: list[i - 1] ?? null, next: list[i + 1] ?? null }
}
/** The row at `i` drawn again as a new element (a fold), optionally in another group. */
function redraw(box: HTMLElement, i: number, group?: string): Element {
  const old = rowsOf(box)[i]!
  const fresh = old.cloneNode() as Element
  if (group) fresh.setAttribute('data-group', group)
  old.replaceWith(fresh)
  return fresh
}

describe('a held row drawn again', () => {
  it('folded in its own place (the first card of the list): the anchor follows the new element', () => {
    const { box } = page(row('a', 'needs') + row('b', 'needs') + row('c', 'done'))
    const held = heldOn(box, 0)
    const fresh = redraw(box, 0)
    followRedrawn(held, box, ROWS, threadRowKey)
    expect(held.el).toBe(fresh)
  })

  it('a watched thread: its copy above the groups has the same key and is not it', () => {
    const { box } = page(row('a', 'needs', 'data-copy="watching"') + row('a', 'needs') + row('b', 'needs'))
    const held = heldOn(box, 1)
    const fresh = redraw(box, 1)
    followRedrawn(held, box, ROWS, threadRowKey)
    expect(held.el).toBe(fresh)
  })

  it('drawn in another group: a row that left, not followed', () => {
    const { box } = page(row('a', 'needs') + row('b', 'needs'))
    const held = heldOn(box, 0)
    const was = held.el
    redraw(box, 0, 'done')
    followRedrawn(held, box, ROWS, threadRowKey)
    expect(held.el).toBe(was)
  })

  it('in its group but between other rows (it moved): not followed', () => {
    const { box } = page(row('a', 'needs') + row('b', 'needs') + row('c', 'needs'))
    const held = heldOn(box, 0)
    const was = held.el
    const fresh = redraw(box, 0)
    rowsOf(box)[2]!.after(fresh)
    followRedrawn(held, box, ROWS, threadRowKey)
    expect(held.el).toBe(was)
  })
})
