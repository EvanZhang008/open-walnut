/**
 * Settings' anchor hold follows its row by id: a re-render that replaces the row's node (a
 * section drawing it in another branch once its data lands) leaves the hold on the new node,
 * never on the detached one, which measures at the pane's top and scrolled the pane to 0
 * (2026-11-26: devices-ways-and-qr "Find a setting reaches a row on a tab" red under load).
 *
 * No layout here (linkedom): each node's top in the content is set by hand, and its rect is that
 * minus the pane's scrollTop, as a browser draws it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'

vi.mock('../../web/src/components/settings/settings-anchor-event', () => ({ announceSettingsAnchor: vi.fn() }))
import { holdAnchor } from '../../web/src/components/settings/hold-anchor'

const PANE_HEIGHT = 800
let scroller: HTMLElement

/** A node at `contentTop` px into the pane's content; detached nodes measure 0, as in a browser. */
function placed<T extends HTMLElement>(node: T, contentTop: number): T {
  node.getBoundingClientRect = () => {
    const top = node.isConnected ? contentTop - scroller.scrollTop : 0
    return { top, bottom: top + 30, left: 0, right: 0, width: 0, height: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  }
  return node
}

function row(id: string, contentTop: number): HTMLElement {
  const el = document.createElement('button')
  el.id = id
  return placed(el, contentTop)
}

beforeAll(() => {
  const { window, document } = parseHTML('<html><body></body></html>')
  // Node has no frames: fake timers replace these (they fake only what exists).
  Object.assign(globalThis, {
    window, document,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  scroller = document.createElement('div')
  let top = 0
  Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v) }, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: PANE_HEIGHT, configurable: true })
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: PANE_HEIGHT, left: 0, right: 0, width: 0, height: PANE_HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(scroller)
})

afterEach(() => {
  scroller.remove()
  vi.useRealTimers()
})

/** The row's top inside the pane's viewport now. */
const shownAt = (id: string) => document.getElementById(id)!.getBoundingClientRect().top

describe('holdAnchor', () => {
  it('scrolls a Find a setting hit a third down the pane', () => {
    scroller.appendChild(row('devices-backup-leader', 1200))
    const stop = holdAnchor(scroller, { id: 'devices-backup-leader', mode: 'third', flash: false })
    vi.advanceTimersByTime(200)
    expect(shownAt('devices-backup-leader')).toBe(Math.round(PANE_HEIGHT / 3))
    stop()
  })

  it('a row whose node a re-render replaced stays in view: the hold takes the new node of its id', () => {
    const first = row('devices-backup-leader', 600)
    scroller.appendChild(first)
    const stop = holdAnchor(scroller, { id: 'devices-backup-leader', mode: 'third', flash: false })
    vi.advanceTimersByTime(200)
    // The section draws again in its other branch: a new node, lower down, the old one detached.
    first.remove()
    scroller.appendChild(row('devices-backup-leader', 1215))
    vi.advanceTimersByTime(300)
    expect(shownAt('devices-backup-leader')).toBe(Math.round(PANE_HEIGHT / 3))
    expect(scroller.scrollTop).toBeGreaterThan(0)
    stop()
  })

  it('while the replaced row is not drawn again, the pane is left where it is', () => {
    const first = row('devices-backup-leader', 900)
    scroller.appendChild(first)
    const stop = holdAnchor(scroller, { id: 'devices-backup-leader', mode: 'third', flash: false })
    vi.advanceTimersByTime(200)
    const held = scroller.scrollTop
    first.remove()
    vi.advanceTimersByTime(500)
    expect(scroller.scrollTop).toBe(held)
    // It comes back within the hold: the hold takes it.
    scroller.appendChild(row('devices-backup-leader', 1500))
    vi.advanceTimersByTime(300)
    expect(shownAt('devices-backup-leader')).toBe(Math.round(PANE_HEIGHT / 3))
    stop()
  })
})
