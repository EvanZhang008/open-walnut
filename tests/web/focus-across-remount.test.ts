/**
 * useFocusAcrossRemount (web/src/utils/focus-across-remount.ts): a control that moves between two
 * parents (a settings pane's header actions, portalled into the sticky bar once the pane scrolls)
 * is a new element each time, and the new one takes the focus back when the old one held it and
 * the focus fell to the page. Covered too: a control that rendered nothing at first (Remote
 * Hosts' "need a look" count before the rows report) still keeps the focus when it moves
 * (review: the hook read its element only at mount), and a move with the focus elsewhere takes
 * nothing.
 */
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { StrictMode, act, createElement, useRef } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { createPortal } from '../../web/node_modules/react-dom/index.js'
import { useFocusAcrossRemount } from '../../web/src/utils/focus-across-remount'

const dom = parseHTML('<!DOCTYPE html><html><head></head><body><div id="pane"></div><div id="bar"></div><input id="other"></body></html>')
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.document
g.IS_REACT_ACT_ENVIRONMENT = true
// linkedom keeps no focus: a minimal one, as a browser does it (a removed element loses it).
let active: Element | null = null
Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => (active && active.isConnected ? active : dom.document.body) })
;(dom.window as unknown as { HTMLElement: { prototype: { focus: () => void } } }).HTMLElement.prototype.focus = function (this: Element) { active = this }

const pane = dom.document.getElementById('pane')!
const bar = dom.document.getElementById('bar')!

function Count({ show }: { show: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  useFocusAcrossRemount('test-count', ref)
  return show ? createElement('button', { ref, 'data-testid': 'count' }, '2 need a look') : null
}
/** In the pane's header, or portalled into the sticky bar: React mounts it again either way. */
function Header({ show, inBar }: { show: boolean; inBar: boolean }) {
  const c = createElement(Count, { show })
  return inBar ? createPortal(c, bar) : c
}

describe('useFocusAcrossRemount', () => {
  it('a control that came later still keeps the focus when it moves, both ways', async () => {
    const root = createRoot(pane)
    await act(async () => { root.render(createElement(Header, { show: false, inBar: false })) })
    await act(async () => { root.render(createElement(Header, { show: true, inBar: false })) })
    const first = pane.querySelector<HTMLButtonElement>('[data-testid="count"]')!
    first.focus()
    await act(async () => { root.render(createElement(Header, { show: true, inBar: true })) })
    const moved = bar.querySelector('[data-testid="count"]')
    expect(moved).not.toBeNull()
    expect(moved).not.toBe(first)
    expect(dom.document.activeElement).toBe(moved)
    await act(async () => { root.render(createElement(Header, { show: true, inBar: false })) })
    expect(dom.document.activeElement).toBe(pane.querySelector('[data-testid="count"]'))
    await act(async () => { root.unmount() })
  })

  it('a focus a press landed keeps its ring when the control moves', async () => {
    const root = createRoot(pane)
    await act(async () => { root.render(createElement(Header, { show: true, inBar: true })) })
    const first = bar.querySelector<HTMLButtonElement>('[data-testid="count"]')!
    first.setAttribute('data-landed', 'true')
    first.focus()
    await act(async () => { root.render(createElement(Header, { show: true, inBar: false })) })
    const moved = pane.querySelector<HTMLButtonElement>('[data-testid="count"]')!
    expect(dom.document.activeElement).toBe(moved)
    expect(moved.getAttribute('data-landed')).toBe('true')
    // A plain focus (a mouse press) moves with no ring.
    moved.removeAttribute('data-landed')
    await act(async () => { root.render(createElement(Header, { show: true, inBar: true })) })
    expect(bar.querySelector('[data-testid="count"]')!.hasAttribute('data-landed')).toBe(false)
    await act(async () => { root.unmount() })
  })

  it('a control mounted twice in place (StrictMode) keeps no claim on the focus for its next move', async () => {
    // 2026-11-05, Chromium: the count took the focus back on its move, its effects ran twice
    // there, and the second run's cleanup kept a claim; a move of the page's header a moment
    // later then gave the focus to the count instead of Add host, which had it.
    const root = createRoot(pane)
    const strict = (inBar: boolean) => createElement(StrictMode, null, createElement(Header, { show: true, inBar }))
    await act(async () => { root.render(strict(false)) })
    pane.querySelector<HTMLButtonElement>('[data-testid="count"]')!.focus()
    await act(async () => { root.render(strict(true)) })
    expect(dom.document.activeElement).toBe(bar.querySelector('[data-testid="count"]'))
    // The focus goes to another control, which then leaves the page: the focus is on nothing.
    const other = dom.document.createElement('button')
    dom.document.body.appendChild(other)
    other.focus()
    other.remove()
    await act(async () => { root.render(strict(false)) })
    expect(dom.document.activeElement).toBe(dom.document.body)
    await act(async () => { root.unmount() })
  })

  it('a move while the focus is elsewhere takes nothing', async () => {
    const root = createRoot(pane)
    await act(async () => { root.render(createElement(Header, { show: true, inBar: false })) })
    const other = dom.document.getElementById('other')!
    other.focus()
    await act(async () => { root.render(createElement(Header, { show: true, inBar: true })) })
    expect(dom.document.activeElement).toBe(other)
    await act(async () => { root.unmount() })
  })
})
