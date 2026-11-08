/** phoneHostSlot keyed on the bar slot a hosted viewer replaces looped into React #185 (2026-11-07); the host is decided by layout. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act, useState, Fragment } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { createPortal } from '../../web/node_modules/react-dom/index.js'

// The top bar's leaf dependencies: the socket's resync state and the status row.
vi.mock('../../web/src/hooks/usePhoneResync', () => ({
  useResyncState: () => ({ syncing: false }),
  runPhoneResync: async () => {},
}))
vi.mock('../../web/src/components/layout/PhoneStatusRow', () => ({ PhoneStatusRow: () => null }))

// ---------------------------------------------------------------------------
// The product's own conditions, read from source.

const WEB = path.resolve(import.meta.dirname, '../../web/src')
const askSrc = readFileSync(path.join(WEB, 'components/chat/AskWalnutSlot.tsx'), 'utf8')
const panelSrc = readFileSync(path.join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8')

const HOST_PROP = /\{\.\.\.\(([^?{}]+?)\s*\?\s*\{\s*phoneHostSlot:\s*'chat'\s*\}\s*:\s*\{\}\s*\)\}/
const HOST_CLOSE = /onClose=\{([^?{}]+?)\s*\?\s*phoneChat\.close\s*:\s*hideSlot\}/
const VIEWER_ACTIVE = /kind:\s*activeView === 'board' \? 'board' : 'viewer',\s*active:\s*([^\n]+?),\s*\n[\s\S]{0,240}?withAction:\s*false/

/** The slot-presence condition the crash shipped with: the red control. */
const OLD_HOST_CONDITION = 'phoneChat.slot'

/** An expression of only these names and boolean operators, or throw. */
function onlyNames(expr: string, names: string[]): string {
  if (!/^[\w$.\s&|!()]+$/.test(expr)) throw new Error(`not a plain boolean expression: ${expr}`)
  for (const id of expr.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []) {
    if (!names.includes(id)) throw new Error(`unexpected name ${id} in ${expr}`)
  }
  return expr
}

type ChatLayer = { phone: boolean; slot: HTMLElement | null; registered: boolean }
type HostRule = (phoneChat: ChatLayer, phoneOpen: boolean) => boolean
function hostRule(expr: string): HostRule {
  const safe = onlyNames(expr.trim(), ['phoneChat.phone', 'phoneChat.slot', 'phoneChat.registered', 'phoneOpen'])
  return new Function('phoneChat', 'phoneOpen', `return !!(${safe});`) as HostRule
}

const hostProp = askSrc.match(HOST_PROP)?.[1]?.trim() ?? null
const hostClose = askSrc.match(HOST_CLOSE)?.[1]?.trim() ?? null
const viewerExpr = panelSrc.match(VIEWER_ACTIVE)?.[1]?.trim() ?? null
const viewerActive = viewerExpr
  ? new Function('phoneLayer', 'phoneHostSlot', 'activeView',
    `return !!(${onlyNames(viewerExpr, ['phoneLayer', 'phoneHostSlot', 'activeView'])});`) as
    (phoneLayer: boolean | undefined, phoneHostSlot: string | undefined, activeView: string | null) => boolean
  : null

// ---------------------------------------------------------------------------
// A browser: linkedom, a phone-width media query that can flip, a history whose
// back() lands asynchronously like a real one.

let doc: Document
let win: Record<string, unknown> & { dispatchEvent: (e: Event) => boolean; Event: typeof Event }
let phoneNow = true
const mediaListeners = new Set<(ev: { matches: boolean }) => void>()
const savedGlobals: Record<string, unknown> = {}

class FakeHistory {
  entries: unknown[] = [null]
  i = 0
  get state(): unknown { return this.entries[this.i] }
  pushState(s: unknown): void { this.entries.splice(this.i + 1); this.entries.push(s); this.i += 1 }
  replaceState(s: unknown): void { this.entries[this.i] = s }
  back(): void { this.go(-1) }
  go(n: number): void {
    setTimeout(() => {
      this.i = Math.max(0, Math.min(this.entries.length - 1, this.i + n))
      const ev = new win.Event('popstate')
      Object.defineProperty(ev, 'state', { value: this.state })
      win.dispatchEvent(ev)
    }, 0)
  }
}

function setPhone(v: boolean): void {
  phoneNow = v
  for (const l of [...mediaListeners]) l({ matches: v })
}

type Store = typeof import('../../web/src/hooks/usePhoneOverlayHistory')
type Layer = typeof import('../../web/src/components/sessions/phone-session-layer')
let store: Store
let layer: Layer
let PhoneTopBar: typeof import('../../web/src/components/layout/PhoneTopBar').PhoneTopBar

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  for (const k of ['window', 'document', 'history', 'location', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT']) savedGlobals[k] = g[k]
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  win = dom.window as unknown as typeof win
  // linkedom's window falls back to globalThis for these, so they are set there.
  win.history = new FakeHistory()
  win.location = { href: 'http://localhost/' }
  win.matchMedia = (query: string) => ({
    get matches() { return query.includes('max-width: 768px') ? phoneNow : false },
    media: query,
    addEventListener: (_t: string, l: (ev: { matches: boolean }) => void) => { mediaListeners.add(l) },
    removeEventListener: (_t: string, l: (ev: { matches: boolean }) => void) => { mediaListeners.delete(l) },
  })
  doc = dom.document as unknown as Document
  store = await import('../../web/src/hooks/usePhoneOverlayHistory')
  layer = await import('../../web/src/components/sessions/phone-session-layer')
  ;({ PhoneTopBar } = await import('../../web/src/components/layout/PhoneTopBar'))
})

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(savedGlobals)) g[k] = v
})

// ---------------------------------------------------------------------------
// The harness: the Ask slot (chat layer, its menu portaled into its bar slot)
// hosting a panel whose viewer layer has no action, beside the real top bar.

const SID = 'sess-phone-host-1'
const RENDER_BOUND = 200
let hostRenders = 0
let lastHosted: boolean | null = null
let setView: ((v: string | null) => void) | null = null
let topClose: (() => void) | null = null
let topIds: string[] = []
const errors: unknown[] = []
let root: Root | null = null
let container: Element | null = null

function Viewer({ phoneHostSlot, activeView, onCloseView }: { phoneHostSlot?: string; activeView: string | null; onCloseView: () => void }) {
  layer.usePhoneLayerWithBar({
    id: `viewer:${activeView ?? 'none'}:${SID}`,
    kind: 'viewer',
    active: viewerActive!(undefined, phoneHostSlot, activeView),
    title: activeView ?? '',
    withAction: false,
    onClose: onCloseView,
  })
  return createElement('div', { 'data-viewer': activeView ?? 'none' })
}

function Host({ phoneOpen, hosts, activeView, onCloseView }: { phoneOpen: boolean; hosts: HostRule; activeView: string | null; onCloseView: () => void }) {
  hostRenders += 1
  if (hostRenders > RENDER_BOUND) throw new Error(`render loop: the host rendered ${hostRenders} times`)
  const phoneChat = layer.usePhoneLayerWithBar({ id: 'chat', kind: 'chat', active: phoneOpen, title: 'Walnut', onClose: () => {} })
  const hosted = hosts(phoneChat, phoneOpen)
  lastHosted = hosted
  return createElement(Fragment, null,
    createElement(Viewer, hosted ? { phoneHostSlot: 'chat', activeView, onCloseView } : { activeView, onCloseView }),
    phoneChat.slot ? createPortal(createElement('button', { 'data-menu': 'chat' }), phoneChat.slot) : null,
  )
}

function Probe() {
  const top = store.usePhoneOverlayTop()
  topClose = top?.close ?? null
  if (topIds.at(-1) !== (top?.id ?? '')) topIds.push(top?.id ?? '')
  return null
}

function App({ phoneOpen, hosts, initialView }: { phoneOpen: boolean; hosts: HostRule; initialView: string | null }) {
  const [activeView, setActiveView] = useState<string | null>(initialView)
  setView = setActiveView
  return createElement(Fragment, null,
    createElement(PhoneTopBar, { pageTitle: 'Home', menuRef: null, menuExpanded: false, onMenu: () => {} }),
    createElement(Host, { phoneOpen, hosts, activeView, onCloseView: () => setActiveView(null) }),
    createElement(Probe),
  )
}

const settle = () => new Promise((r) => setTimeout(r, 20))

/** One step inside act; an error React or act throws is kept, never swallowed into a pass. */
async function step(fn: () => void): Promise<void> {
  try {
    await act(async () => { fn(); await settle() })
  } catch (e) {
    errors.push(e)
  }
}

async function mount(props: { phoneOpen: boolean; hosts: HostRule; initialView: string | null }): Promise<void> {
  container = doc.createElement('div')
  doc.body.appendChild(container)
  root = createRoot(container, {
    onUncaughtError: (e: unknown) => { errors.push(e) },
    onCaughtError: (e: unknown) => { errors.push(e) },
  })
  await step(() => root!.render(createElement(App, props)))
}

const rerender = (props: { phoneOpen: boolean; hosts: HostRule; initialView: string | null }) =>
  step(() => root!.render(createElement(App, props)))

/** The chat bar slot as the store holds it, read by a fresh mount. */
async function chatSlotNow(): Promise<HTMLElement | null> {
  let seen: HTMLElement | null = null
  const probeRoot = createRoot(doc.createElement('div'))
  function SlotProbe() { seen = layer.usePhoneBarSlot('chat'); return null }
  await act(async () => { probeRoot.render(createElement(SlotProbe)) })
  await act(async () => { probeRoot.unmount() })
  return seen
}

const loopError = (e: unknown) => /Maximum update depth exceeded|Minified React error #185|render loop/.test(String((e as Error)?.message ?? e))
const VIEWER_ID = `viewer:files:${SID}`

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await settle() })
  root = null
  container?.remove()
  container = null
  // Nothing of a test outlives its unmount: no layer, no bar slot.
  expect(store.phoneOverlayIds()).toEqual([])
  expect(await chatSlotNow()).toBeNull()
  store.__resetPhoneOverlaysForTest()
  ;(win.history as FakeHistory).entries = [null]
  ;(win.history as FakeHistory).i = 0
  phoneNow = true
  hostRenders = 0
  lastHosted = null
  setView = null
  topClose = null
  topIds = []
  errors.length = 0
})

// ---------------------------------------------------------------------------

describe('the source the harness runs', () => {
  it('finds the Ask slot host condition, the same on both lines, and the viewer layer rule', () => {
    expect(hostProp, 'AskWalnutSlot phoneHostSlot spread').not.toBeNull()
    expect(hostClose, 'AskWalnutSlot onClose').not.toBeNull()
    expect(hostClose).toBe(hostProp)
    expect(viewerExpr, 'SessionPanel viewer layer active').not.toBeNull()
    expect(viewerExpr).toContain('phoneHostSlot')
  })

  it('decides the host from the layout, never from the bar slot a hosted layer can replace', () => {
    expect(hostProp).toBe('phoneChat.phone && phoneOpen && phoneChat.registered')
  })

  it('every phoneHostSlot writer in web/src decides it without a DOM slot', () => {
    // The class: whoever hands a panel phoneHostSlot. Every mention outside the
    // prop's owner must be a writer this guard can read; a new shape fails here
    // until it is read too, so a writer is never skipped.
    const OWNER = path.join(WEB, 'components/sessions/SessionPanel.tsx')
    const SPREAD = /\{\.\.\.\(([^?{}]+?)\s*\?\s*\{\s*phoneHostSlot:\s*[^}]+\}\s*:\s*\{\}\s*\)\}/g
    const ATTR = /phoneHostSlot=\{([^}]+)\}/g
    const SLOT_WORD = /slot|BarSlot|usePhoneBarSlot|\bel\b|ref\.current|querySelector/i
    const files: string[] = []
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(tsx?|jsx?)$/.test(ent.name)) files.push(p)
      }
    }
    walk(WEB)
    const writers: Array<{ file: string; cond: string }> = []
    const unread: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('phoneHostSlot')) continue
      const found = [...src.matchAll(SPREAD), ...src.matchAll(ATTR)].map((m) => m[1].trim())
      for (const cond of found) writers.push({ file: path.relative(WEB, file), cond })
      if (file === OWNER) continue
      const mentions = src.match(/phoneHostSlot/g)?.length ?? 0
      if (mentions !== found.length) unread.push(`${path.relative(WEB, file)}: ${mentions} mentions, ${found.length} read`)
    }
    expect(unread).toEqual([])
    expect(writers.length).toBeGreaterThan(0)
    for (const w of writers) expect(w.cond, `${w.file} decides phoneHostSlot from a DOM slot`).not.toMatch(SLOT_WORD)
    expect(writers.filter((w) => w.file === 'components/chat/AskWalnutSlot.tsx').map((w) => w.cond))
      .toEqual(['phoneChat.phone && phoneOpen && phoneChat.registered'])
  })
})

describe('a hosted viewer with no action over the Ask slot chat, at phone width', () => {
  it('red control: the slot-presence host condition loops on mount and the error is caught', async () => {
    await mount({ phoneOpen: true, hosts: hostRule(OLD_HOST_CONDITION), initialView: 'files' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(loopError)).toBe(true)
  })

  it('the shipped condition mounts once: the viewer on top, the chat slot empty, the viewer kept', async () => {
    await mount({ phoneOpen: true, hosts: hostRule(hostProp!), initialView: 'files' })
    expect(errors).toEqual([])
    expect(lastHosted).toBe(true)
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])
    expect(topIds.at(-1)).toBe(VIEWER_ID)
    expect(await chatSlotNow()).toBeNull()
    // Time passes (release microtasks, the back timer): the viewer stays open.
    await step(() => {})
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])
    expect(container!.querySelector('[data-viewer]')?.getAttribute('data-viewer')).toBe('files')
    expect(hostRenders).toBeLessThan(20)
  })

  it('closing the viewer from the bar shows the chat bar and its menu; reopening puts the viewer back', async () => {
    await mount({ phoneOpen: true, hosts: hostRule(hostProp!), initialView: 'files' })
    expect(topClose).not.toBeNull()
    await step(() => topClose!())
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual(['chat'])
    expect(topIds.at(-1)).toBe('chat')
    expect(await chatSlotNow()).not.toBeNull()
    expect(container!.querySelector('[data-phone-bar-slot="chat"] [data-menu="chat"]')).not.toBeNull()
    expect(container!.querySelector('[data-viewer]')?.getAttribute('data-viewer')).toBe('none')

    await step(() => setView!('files'))
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])
    expect(topIds.at(-1)).toBe(VIEWER_ID)
    expect(hostRenders).toBeLessThan(40)
  })

  it('a host that is not open pushes no viewer, a remembered view or not', async () => {
    await mount({ phoneOpen: false, hosts: hostRule(hostProp!), initialView: 'files' })
    expect(errors).toEqual([])
    expect(lastHosted).toBe(false)
    expect(store.phoneOverlayIds()).toEqual([])
    // Opening the slot then hosts the panel and the viewer goes on top, once.
    await rerender({ phoneOpen: true, hosts: hostRule(hostProp!), initialView: 'files' })
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])
  })

  it('phone, then desktop, then phone: desktop is not hosted (its own header stays), and no loop on the way back', async () => {
    await mount({ phoneOpen: true, hosts: hostRule(hostProp!), initialView: 'files' })
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])

    await step(() => setPhone(false))
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([])
    expect(lastHosted).toBe(false)
    // A view opened on desktop is no phone layer.
    await step(() => setView!('files'))
    expect(store.phoneOverlayIds()).toEqual([])
    expect(lastHosted).toBe(false)

    await step(() => setPhone(true))
    expect(errors).toEqual([])
    expect(lastHosted).toBe(true)
    expect(store.phoneOverlayIds()).toEqual(['chat', VIEWER_ID])
    expect(topIds.at(-1)).toBe(VIEWER_ID)
    expect(hostRenders).toBeLessThan(60)
  })
})
