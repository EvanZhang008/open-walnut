/**
 * useFocusRequest (web/src/utils/focus-when-shown.ts) under StrictMode's mount, unmount, mount.
 * 2026-11-10: Ask in the mail drawer left the caret on the mail row instead of the draft composer.
 * The drawer's effect cleanup returns focus to the row; StrictMode runs that cleanup between the
 * two mounts, and the composer's request, already marked served by the first mount, was skipped
 * on the second. A request torn down in the same commit it focused in is not served yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { StrictMode, act, createElement, useEffect, useRef } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { useFocusRequest } from '../../web/src/utils/focus-when-shown'

const dom = parseHTML('<!DOCTYPE html><html><head></head><body><button id="row">row</button><div id="app"></div></body></html>')
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.document
g.IS_REACT_ACT_ENVIRONMENT = true
// linkedom keeps no focus: a minimal one, as a browser does it (a removed element loses it).
let active: Element | null = null
Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => (active && active.isConnected ? active : dom.document.body) })
;(dom.window as unknown as { HTMLElement: { prototype: { focus: () => void } } }).HTMLElement.prototype.focus = function (this: Element) { active = this }

let frames: Array<() => void> = []
function flushFrames(): void {
  for (let i = 0; i < 5; i++) { const due = frames; frames = []; for (const f of due) f() }
}

beforeEach(() => {
  frames = []
  active = null
  let id = 0
  const queued = new Map<number, () => void>()
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { const n = ++id; queued.set(n, f); frames.push(() => { const q = queued.get(n); queued.delete(n); q?.() }); return n })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => { queued.delete(n) })
})
afterEach(() => { vi.unstubAllGlobals() })

const row = dom.document.getElementById('row') as unknown as HTMLButtonElement

function Composer() {
  const ref = useRef<HTMLTextAreaElement>(null)
  useFocusRequest(true, () => ref.current)
  return createElement('textarea', { ref, 'data-testid': 'composer' })
}
/** The Ask drawer's shape: its cleanup gives focus back to the row that opened it. */
function Drawer() {
  useEffect(() => () => { row.focus() }, [])
  return createElement(Composer)
}

describe('useFocusRequest', () => {
  it('a StrictMode remount between the parent focus return and the request still leaves the caret in the box', async () => {
    const app = dom.document.getElementById('app')!
    row.focus()
    const root = createRoot(app)
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Drawer))) })
    flushFrames()
    expect(dom.document.activeElement).toBe(app.querySelector('[data-testid="composer"]'))
    // Served once settled: focus moved elsewhere by the person stays there across a re-render.
    row.focus()
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Drawer))) })
    flushFrames()
    expect(dom.document.activeElement).toBe(row)
    await act(async () => { root.unmount() })
  })
})
