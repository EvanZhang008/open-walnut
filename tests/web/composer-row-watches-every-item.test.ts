/**
 * The composer's controls row is measured again whenever any item on it changes size. Its room is
 * read off the whole row (rowRoom in web/src/components/chat/ComposerControlsBar.tsx: the bar, the
 * spacer, the recall line, Note and btw, the send keys), but the ResizeObserver watched only the
 * bar, the row and its own controls. A condensed bar's own box does not grow when room comes back,
 * only the spacer beside it does, so the row kept the short model name with room for the full one
 * (2026-11-25, composer-controls-overflow.spec.ts: the send keys narrowed back after a -12 px
 * squeeze and nothing measured again).
 *
 * The members are found, not listed: every child the row has, plus one mounted after the bar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

const watched = new Set<Element>()
class RecordingResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(el: Element) { watched.add(el) }
  unobserve(el: Element) { watched.delete(el) }
  disconnect() { watched.clear() }
}

const g = globalThis as unknown as Record<string, unknown>
const saved: Record<string, unknown> = {}
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']

let doc: Document
let root: Root

beforeAll(() => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  for (const k of GLOBALS) saved[k] = g[k]
  const w = window as unknown as Record<string, unknown>
  w.ResizeObserver = RecordingResizeObserver
  w.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.getComputedStyle ??= () => ({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', columnGap: '4px', paddingLeft: '0', paddingRight: '0', position: 'static' })
  w.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
  w.cancelAnimationFrame = (id: number) => clearTimeout(id)
  Object.assign(g, {
    window, document, navigator: w.navigator ?? { userAgent: 'node' },
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver,
    ResizeObserver: RecordingResizeObserver, getComputedStyle: w.getComputedStyle,
    requestAnimationFrame: w.requestAnimationFrame, cancelAnimationFrame: w.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  doc = document as unknown as Document
})

afterAll(() => {
  act(() => root?.unmount())
  for (const k of GLOBALS) g[k] = saved[k]
})

describe('the composer controls row watches every item on it', () => {
  it('each child of the row, and one mounted later, is observed', async () => {
    const { ComposerControlsBar } = await import('../../web/src/components/chat/ComposerControlsBar')
    const controls = [{ id: 'model', name: 'Model', priority: 1, node: createElement('button', { type: 'button' }, 'Fable 5.1') }]
    // The row as ChatInput draws it: the bar, the spacer, the send keys, and later the recall line.
    const draw = (withHint: boolean) => createElement('div', { className: 'chat-input-controls' },
      createElement(ComposerControlsBar, { controls }),
      createElement('span', { className: 'chat-input-controls-spacer' }),
      withHint ? createElement('span', { className: 'chat-recall-hint' }, '2 of 15 back') : null,
      createElement('div', { className: 'chat-send-group' }))
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(draw(false)) })
    const row = host.querySelector('.chat-input-controls') as HTMLElement
    const unwatched = () => [...row.children].filter((el) => !watched.has(el)).map((el) => el.className || el.tagName)
    expect(row.querySelector(':scope > .composer-controls-bar'), 'the bar sits on the row').toBeTruthy()
    expect(row.children.length).toBeGreaterThanOrEqual(3)
    expect(unwatched()).toEqual([])
    await act(async () => { root.render(draw(true)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(row.querySelector(':scope > .chat-recall-hint'), 'the recall line mounted').toBeTruthy()
    expect(unwatched()).toEqual([])
  })
})
