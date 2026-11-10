/**
 * Real input by default (packages/browser-extension/src/agent-trusted.ts trustedByDefault,
 * 2026-11-09, the user: "we need make it fully capable using debug"): an agent's click, type,
 * press and hover in its own tab in Walnut's agent window go through the debugger without
 * `trusted`, against a fake browser (the page's answers and the debugger are faked, the rest is the
 * real command code). Guards:
 *   - a step that buys, sends or deletes is refused on the default path exactly as on the named one:
 *     judged after the cursor, and again with the debugger attached, nothing pressed;
 *   - it falls back to the page's events in a frame, in a tab of the person's, outside the agent
 *     window, with the switch off or no permission, after the person cancelled the bar, with
 *     DevTools on the tab, on a link to a new tab, for long text, and with `trusted: false`;
 *   - also on a control that opens a picker of the browser's (select, file field) and on a shortcut
 *     with Control, Meta or Alt;
 *   - the session lingers after a step (no bar flashing per step) and goes when the tab is let go,
 *     never after a step that failed, a let-go or take-over during the step, in a tab of the
 *     person's, or once real input is turned off;
 *   - the person's Cancel on the bar holds 10 minutes on every tab, across a restart;
 *   - a default step leaves the page fillable (it sends only mouse and key events).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void
type Detach = (source: { tabId?: number }, reason: string) => void
type PageAnswer = (op: string, args: Record<string, unknown>, frameId: number) => unknown
const fake = {
  session: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  events: [] as Listener[],
  detached: [] as Detach[],
  log: [] as Array<[string, Record<string, unknown> | undefined]>,
  pageLog: [] as Array<{ op: string; args: Record<string, unknown>; frameId: number }>,
  page: (() => ({})) as PageAnswer,
  frames: [] as Array<{ frameId: number; href: string }>,
  perm: true,
  attachError: '',
  /** A debugger command of this type (a mouse event type) fails. */
  sendError: '',
  /** storage.onChanged listeners (the real-input switch turned off ends the lingers). */
  changed: [] as Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>,
  windowId: 3,
  /** Tab 7 is the front tab of its window. */
  active: true,
  windowState: 'normal',
  created: [] as Array<Record<string, unknown>>,
  tabUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  /** The page's ops, the cursor's messages and the debugger's commands, in the order they went out. */
  order: [] as string[],
}
const ev = () => ({ addListener() {}, removeListener() {} })
const PAGE_URL = 'https://shop.example.test/checkout'
const tab = () => ({ id: 7, windowId: fake.windowId, active: fake.active, url: PAGE_URL, title: 'Checkout', status: 'complete' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) }, remove: async () => undefined },
    local: {
      get: async (k: string | string[]) => ({ agentControl: true, ...Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in fake.local).map((x) => [x, fake.local[x]])) }),
      set: async (o: Record<string, unknown>) => { Object.assign(fake.local, o) },
    },
    onChanged: { addListener: (fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => fake.changed.push(fn), removeListener() {} },
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => (id === 7 ? tab() : { id, windowId: fake.windowId, url: 'https://shop.example.test/new', status: 'complete' }),
    query: async (q: Record<string, unknown>) => (q.active && !fake.active ? [{ id: 8, windowId: fake.windowId, active: true, url: PAGE_URL }] : [tab()]),
    captureVisibleTab: async () => { fake.log.push(['captureVisibleTab', undefined]); return 'data:image/jpeg;base64,SEEN' },
    update: async (id: number, o: Record<string, unknown>) => { fake.tabUpdates.push({ id, o }); if (id === 7 && o.active === true) fake.active = true; return tab() },
    create: async (o: Record<string, unknown>) => { fake.created.push(o); return { id: 30, windowId: o.windowId, url: o.url } },
    sendMessage: async (_tabId: number, msg: { type: string; op?: string; args?: Record<string, unknown> }, opts?: { frameId?: number }) => {
      if (msg.type === 'agent-check') return { ok: true, walnut: false, href: PAGE_URL, doc: 'doc-1' }
      if (msg.type === 'agent-cursor') fake.order.push(`cursor ${JSON.stringify(msg)}`)
      if (msg.type !== 'agent') return { ok: true }
      const frameId = opts?.frameId ?? 0
      fake.order.push(`page ${msg.op} ${JSON.stringify(msg.args ?? {})}`)
      fake.pageLog.push({ op: msg.op!, args: msg.args ?? {}, frameId })
      try {
        return { ok: true, result: await fake.page(msg.op!, msg.args ?? {}, frameId) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: (err as { code?: string }).code ?? 'page_error' } }
      }
    },
  },
  scripting: {
    executeScript: async () => [
      { frameId: 0, result: { href: PAGE_URL, w: 1200, h: 800, kids: fake.frames.length } },
      ...fake.frames.map((f) => ({ frameId: f.frameId, result: { href: f.href, w: 300, h: 200, kids: 0 } })),
    ],
  },
  windows: { get: async () => ({ state: fake.windowState, focused: false }), onRemoved: ev() },
  permissions: { contains: async (p: { permissions?: string[] }) => (p.permissions?.includes('debugger') ? fake.perm : true), onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push(['attach', undefined]); if (fake.attachError) throw new Error(fake.attachError) },
    detach: async () => { fake.log.push(['detach', undefined]) },
    sendCommand: async (_t: unknown, method: string, params?: Record<string, unknown>) => {
      fake.log.push([method, params])
      fake.order.push(`${method} ${String(params?.type ?? '')}`)
      if (fake.sendError && params?.type === fake.sendError) throw new Error('Cannot dispatch the event')
      return method === 'Page.captureScreenshot' ? { data: 'LIVE' } : {}
    },
    onEvent: { addListener: (fn: Listener) => fake.events.push(fn), removeListener() {} },
    onDetach: { addListener: (fn: Detach) => fake.detached.push(fn), removeListener() {} },
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { walnutCheck, agentTabs, tamperedNow } = await import('../../../packages/browser-extension/src/agent-shared')
const { CANCEL_COOL_MS, debuggerHeld, endLinger, holdersOf, _resetDebuggerForTesting, _setLingerMsForTesting } = await import('../../../packages/browser-extension/src/cdp')
const { CANCELLED_AT_KEY, liveState, _resetLiveForTesting } = await import('../../../packages/browser-extension/src/agent-live')
const dialogs = await import('../../../packages/browser-extension/src/agent-dialog')
const { DEFAULT_TYPE_MAX } = await import('../../../packages/browser-extension/src/agent-trusted')
walnutCheck.isWalnutPage = async () => false

const act = (action: string, args: Record<string, unknown> = {}) => agent._actForTesting({ id: 'c', action, args: { tab: 7, ...args }, allow: { any: true, sites: [] } }) as Promise<Record<string, any>>
const methods = () => fake.log.map((l) => l[0])
const mouse = () => fake.log.filter((l) => l[0] === 'Input.dispatchMouseEvent').map((l) => l[1]!)
const keys = () => fake.log.filter((l) => l[0] === 'Input.dispatchKeyEvent' || l[0] === 'Input.insertText')
const pageOps = (op: string) => fake.pageLog.filter((p) => p.op === op)
const button = { x: 30, y: 40, what: 'button "Next"' }
const hold = { kind: 'buy', why: '"Place order" buys or pays', what: 'click button "Place order"', url: PAGE_URL, sig: 'buy|click button "Place order"|x||' }

beforeEach(() => {
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:A' } } }
  fake.local = {}
  fake.log = []
  fake.pageLog = []
  fake.page = (op) => (op === 'locate' ? button : op === 'click' ? { clicked: 'button "Next"' } : op === 'type' ? { typed: 'x' } : op === 'press' ? { pressed: 'Enter' } : {})
  fake.frames = []
  fake.perm = true
  fake.attachError = ''
  fake.sendError = ''
  fake.changed = []
  fake.windowId = 3
  fake.active = true
  fake.windowState = 'normal'
  fake.created = []
  fake.tabUpdates = []
  fake.order = []
  dialogs._resetDialogsForTesting()
  _resetDebuggerForTesting()
  _resetLiveForTesting()
  _setLingerMsForTesting(0)
})

describe('a click, type, press or hover in the agent\'s own tab goes through the debugger without trusted', () => {
  it('click: the cursor first, then the browser\'s own mouse; the page\'s click never runs', async () => {
    const r = await act('click', { ref: 'e5' })
    expect(r).toMatchObject({ clicked: 'button "Next"', trusted: true, tab: 7 })
    expect(mouse().map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(pageOps('click')).toEqual([])
    // The cursor overlay shows on this path too: the page draws it before the debugger acts.
    const located = pageOps('locate').filter((p) => !p.args.recheck)
    expect(located[0].args).toMatchObject({ ref: 'e5', cursor: 'click', outward: 'click', blank: true })
    const firstLocate = fake.order.findIndex((o) => o.startsWith('page locate'))
    const firstPress = fake.order.findIndex((o) => o.startsWith('Input.dispatchMouseEvent mousePressed'))
    expect(firstLocate).toBeGreaterThanOrEqual(0)
    expect(firstLocate).toBeLessThan(firstPress)
  })

  it('type, press and hover too', async () => {
    expect(await act('type', { ref: 'e2', text: 'ab' })).toMatchObject({ trusted: true })
    expect(keys().map((k) => `${k[1]!.type} ${k[1]!.key}`)).toEqual(['keyDown a', 'keyUp a', 'keyDown b', 'keyUp b'])
    fake.log = []
    expect(await act('press', { key: 'Tab' })).toMatchObject({ pressed: 'Tab', trusted: true })
    fake.log = []
    expect(await act('hover', { ref: 'e5' })).toMatchObject({ hovered: 'button "Next"', trusted: true })
    expect(mouse().map((m) => m.type)).toEqual(['mouseMoved', 'mouseMoved'])
    expect(pageOps('type')).toEqual([])
    expect(pageOps('press')).toEqual([])
    expect(pageOps('hover')).toEqual([])
  })

  it('a scroll stays the page\'s (its answer says where the page is)', async () => {
    fake.page = (op) => (op === 'scroll' ? { scrollTop: 400, atBottom: false } : {})
    expect(await act('scroll', { direction: 'down' })).toMatchObject({ scrollTop: 400 })
    expect(methods()).toEqual([])
  })
})

// The outward-step hold is exactly as strict on the default path (the judge after the cursor and
// again with the debugger attached, review 2026-11-09): nothing is pressed, typed or sent.
describe('a step that buys, sends or deletes still waits for the person on the default path', () => {
  const heldFirst = (op: string) => (op === 'locate' ? { hold } : {})
  const heldOnAttach = (op: string) => (op === 'locate' ? (methods().includes('attach') ? { hold } : button) : {})

  it.each([
    ['click', { ref: 'e5' }],
    ['click at a point', { x: 30, y: 40 }],
    ['type that submits', { ref: 'e5', text: 'ab', submit: true }],
    ['type at a point', { x: 30, y: 40, text: 'ab\n' }],
    ['press Enter', { key: 'Enter' }],
  ] as const)('%s: held at the first look (after the cursor), nothing pressed, and the page\'s own step never runs', async (name, args) => {
    fake.page = heldFirst
    const action = name.startsWith('click') ? 'click' : name.startsWith('type') ? 'type' : 'press'
    const err = await act(action, args).catch((e) => e)
    expect(err.code).toBe('outward_needs_ok')
    expect(err.extra.hold).toMatchObject({ kind: 'buy' })
    expect(mouse()).toEqual([])
    expect(keys()).toEqual([])
    expect(pageOps(action)).toEqual([])
    // Judged as the named path judges it.
    expect(pageOps('locate')[0].args.outward ?? pageOps('locate')[0].args.then_enter).toBeTruthy()
  })

  it.each([
    ['click', { ref: 'e5' }],
    ['type that submits', { ref: 'e5', text: 'ab', submit: true }],
    ['press Enter', { key: 'Enter' }],
  ] as const)('%s: held when it shows only once the debugger is attached (its bar moved the page), nothing pressed', async (name, args) => {
    fake.page = heldOnAttach
    const action = name.startsWith('click') ? 'click' : name.startsWith('type') ? 'type' : 'press'
    const err = await act(action, args).catch((e) => e)
    expect(err.code).toBe('outward_needs_ok')
    expect(mouse().filter((m) => m.type === 'mousePressed')).toEqual([])
    expect(keys()).toEqual([])
    expect(pageOps('locate').some((p) => p.args.recheck === true)).toBe(true)
    expect(pageOps(action)).toEqual([])
  })

  it('the person\'s yes passed on (outward_ok) reaches the judge, and only then is it pressed', async () => {
    fake.page = (op, a) => (op === 'locate' ? (a.outward_ok === hold.sig ? button : { hold }) : {})
    await act('click', { ref: 'e5', outward_ok: hold.sig })
    expect(mouse().filter((m) => m.type === 'mousePressed')).toHaveLength(1)
  })
})

describe('where real input cannot take it, the page\'s events do, as before', () => {
  const pageClicked = () => expect(pageOps('click')).toHaveLength(1)

  it('trusted: false', async () => {
    await act('click', { ref: 'e5', trusted: false })
    pageClicked()
    expect(methods()).toEqual([])
  })

  it('a ref in a frame', async () => {
    fake.frames = [{ frameId: 3, href: 'https://pay.example.test/w' }]
    await act('click', { ref: 'f3:e2' })
    expect(pageOps('click')[0].frameId).toBe(3)
    expect(methods()).toEqual([])
  })

  it('a click by its words that lands in a frame: the page clicks the match there, searched once', async () => {
    fake.frames = [{ frameId: 3, href: 'https://pay.example.test/w' }]
    fake.page = (op, _a, frameId) => (op === 'find' ? (frameId === 0 ? { matches: [], count: 0 } : { matches: [{ ref: 'f3:e2', role: 'button', name: 'Pay later' }], count: 1 }) : op === 'click' ? { clicked: 'button "Pay later"' } : {})
    const r = await act('click', { text: 'Pay later' })
    expect(r).toMatchObject({ clicked: 'button "Pay later"', matched: { ref: 'f3:e2' } })
    expect(pageOps('find').filter((p) => p.frameId === 0)).toHaveLength(1)
    expect(methods()).toEqual([])
  })

  it('the point is inside a frame (the page says so before anything is pressed)', async () => {
    fake.page = (op) => {
      if (op === 'locate') throw Object.assign(new Error('That point is inside a frame'), { code: 'trusted_frame' })
      return op === 'click' ? { clicked: 'x' } : {}
    }
    await act('click', { x: 5, y: 5 })
    pageClicked()
    expect(mouse()).toEqual([])
  })

  it('a tab of the person\'s (handed over): page events by default; real input there only when asked by name', async () => {
    fake.session.agentTabs = { 7: { owner: 'task:A', handed: 'shop.example.test' } }
    await act('click', { ref: 'e5' })
    pageClicked()
    expect(methods()).toEqual([])
    fake.pageLog = []
    await act('click', { ref: 'e5', trusted: true })
    expect(mouse().filter((m) => m.type === 'mousePressed')).toHaveLength(1)
  })

  it('a tab outside the agent window', async () => {
    fake.windowId = 9
    await act('click', { ref: 'e5' })
    pageClicked()
    expect(methods()).toEqual([])
  })

  it('the person turned real input off, or the permission is missing', async () => {
    fake.local = { realInput: false, realInputBy: 'person' }
    await act('click', { ref: 'e5' })
    pageClicked()
    fake.pageLog = []
    fake.local = {}
    fake.perm = false
    await act('click', { ref: 'e5' })
    pageClicked()
    expect(methods()).toEqual([])
  })

  it('the person cancelled Chrome\'s debugging bar lately', async () => {
    await act('click', { ref: 'e5' })
    for (const f of fake.detached) f({ tabId: 7 }, 'canceled_by_user')
    fake.log = []
    fake.pageLog = []
    await act('click', { ref: 'e5' })
    pageClicked()
    expect(methods()).toEqual([])
  })

  it('DevTools holds the tab: the attach fails before anything is pressed, and the page clicks', async () => {
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    const r = await act('click', { ref: 'e5' })
    expect(r.clicked).toBe('button "Next"')
    pageClicked()
    expect(mouse()).toEqual([])
  })

  it('a link to a new tab: the page\'s click, so the extension opens it in the background as the agent\'s', async () => {
    fake.page = (op) => (op === 'locate' ? { ...button, newTab: 'https://shop.example.test/new' } : op === 'click' ? { clicked: 'link "Terms"', newTab: 'https://shop.example.test/new' } : {})
    await act('click', { ref: 'e5' })
    expect(mouse().filter((m) => m.type === 'mousePressed')).toEqual([])
    expect(fake.created[0]).toMatchObject({ url: 'https://shop.example.test/new', active: false })
  })

  it.each([
    ['a select, a file field, a date picker or their label (the page tells it at the first look)', false],
    ['such a control under the point only once the debugger attached', true],
  ] as const)('%s: the page\'s click, nothing pressed', async (_name, onAttach) => {
    fake.page = (op) => (op === 'locate' ? (!onAttach || methods().includes('attach') ? { ...button, native: true } : button) : op === 'click' ? { clicked: 'combobox "Size"' } : {})
    const r = await act('click', { ref: 'e5' })
    expect(r.clicked).toBe('combobox "Size"')
    expect(mouse().filter((m) => m.type === 'mousePressed')).toEqual([])
    pageClicked()
    // Asked of the page both times (the first look, and with the debugger attached).
    expect(pageOps('locate').every((p) => p.args.blank === true)).toBe(true)
  })

  it.each(['Control+t', 'Meta+w', 'Alt+ArrowLeft', 'Control+Shift+n', 'Insert', 'CapsLock'])('a shortcut the browser takes (%s): the page\'s key events', async (key) => {
    await act('press', { key })
    expect(pageOps('press')).toHaveLength(1)
    expect(keys()).toEqual([])
    expect(methods()).not.toContain('attach')
  })

  it('Shift with a key, or a plain key, stays real input', async () => {
    await act('press', { key: 'Shift+Tab' })
    expect(keys().length).toBeGreaterThan(0)
    expect(pageOps('press')).toEqual([])
  })

  it('typing longer than DEFAULT_TYPE_MAX', async () => {
    await act('type', { ref: 'e2', text: 'x'.repeat(DEFAULT_TYPE_MAX + 1) })
    expect(pageOps('type')).toHaveLength(1)
    expect(methods()).toEqual([])
  })
})

describe('the session lingers while the agent works, and goes when it is done', () => {
  it('two clicks in a row attach once; letting the tab go detaches at once', async () => {
    _setLingerMsForTesting(60_000)
    await act('click', { ref: 'e5' })
    await act('click', { ref: 'e5' })
    expect(methods().filter((m) => m === 'attach')).toHaveLength(1)
    expect(methods()).not.toContain('detach')
    expect(holdersOf(7)).toEqual(['linger'])
    await agentTabs.delete(7)
    await vi.waitFor(() => expect(methods()).toContain('detach'))
    expect(debuggerHeld(7)).toBe(false)
  })

  it('a let-go or take-over that comes while the step runs leaves nothing attached after it', async () => {
    _setLingerMsForTesting(60_000)
    const dbg = (globalThis as any).chrome.debugger
    fake.page = (op, a) => {
      if (op === 'locate' && a.recheck) void endLinger(dbg, 7)
      return op === 'locate' ? button : {}
    }
    await act('click', { ref: 'e5' })
    expect(mouse().filter((m) => m.type === 'mousePressed')).toHaveLength(1)
    expect(debuggerHeld(7)).toBe(false)
    expect(methods().at(-1)).toBe('detach')
  })

  it('the person took the tab over meanwhile (driving), or it is theirs: no linger', async () => {
    _setLingerMsForTesting(60_000)
    fake.page = (op, a) => {
      if (op === 'locate' && a.recheck) (fake.session.agentTabs as Record<number, Record<string, unknown>>)[7].driving = Date.now()
      return op === 'locate' ? button : {}
    }
    await act('click', { ref: 'e5' })
    expect(debuggerHeld(7)).toBe(false)
    fake.page = (op) => (op === 'locate' ? button : {})
    fake.session.agentTabs = { 7: { owner: 'task:A', handed: 'shop.example.test' } }
    fake.log = []
    await act('click', { ref: 'e5', trusted: true })
    expect(mouse().filter((m) => m.type === 'mousePressed')).toHaveLength(1)
    expect(debuggerHeld(7)).toBe(false)
  })

  it('a step that failed keeps nothing attached', async () => {
    _setLingerMsForTesting(60_000)
    fake.sendError = 'mousePressed'
    await act('click', { ref: 'e5', trusted: true }).catch(() => undefined)
    expect(debuggerHeld(7)).toBe(false)
  })

  it('the person turned real input off: every lingering session goes at once, a step asked for by name included', async () => {
    _setLingerMsForTesting(60_000)
    // Only a named step since the background (re)started: it sets up the switch's listener too.
    await act('click', { ref: 'e5', trusted: true })
    expect(holdersOf(7)).toEqual(['linger'])
    for (const f of fake.changed) f({ realInput: { newValue: false } }, 'local')
    await vi.waitFor(() => expect(debuggerHeld(7)).toBe(false))
  })

  it('an in-place screenshot lingers like a step; a let-go during it, or a failed one, leaves nothing attached', async () => {
    _setLingerMsForTesting(60_000)
    fake.active = false
    await act('screenshot')
    expect(holdersOf(7)).toEqual(['linger'])
    await agentTabs.delete(7)
    await vi.waitFor(() => expect(debuggerHeld(7)).toBe(false))
    // Let go while the picture is drawn.
    fake.session.agentTabs = { 7: { owner: 'task:A' } }
    fake.page = (op) => (op === 'locate' ? button : {})
    const dbg = (globalThis as any).chrome.debugger
    const send = dbg.sendCommand
    dbg.sendCommand = async (t: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.captureScreenshot') await endLinger(dbg, 7)
      return send(t, method, params)
    }
    try {
      await act('screenshot')
    } finally {
      dbg.sendCommand = send
    }
    expect(debuggerHeld(7)).toBe(false)
    // A picture that fails: no hold kept for it.
    fake.sendError = ''
    dbg.sendCommand = async (t: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.captureScreenshot') throw new Error('Unable to capture screenshot')
      return send(t, method, params)
    }
    try {
      await act('screenshot').catch(() => undefined)
    } finally {
      dbg.sendCommand = send
    }
    expect(holdersOf(7)).not.toContain('linger')
  })
})

describe('the person\'s Cancel on Chrome\'s debugging bar', () => {
  it('holds for 10 minutes on every tab, then ends', async () => {
    await act('click', { ref: 'e5' })
    for (const f of fake.detached) f({ tabId: 7 }, 'canceled_by_user')
    expect(await liveState(7)).toBe('cancelled')
    expect(await liveState(8)).toBe('cancelled')
    expect(await liveState(8, Date.now() + CANCEL_COOL_MS + 1000)).toBe('on')
  })

  it('is kept across a restart of the background (storage.session)', async () => {
    await act('click', { ref: 'e5' })
    for (const f of fake.detached) f({ tabId: 7 }, 'canceled_by_user')
    await vi.waitFor(() => expect(typeof fake.session[CANCELLED_AT_KEY]).toBe('number'))
    // The service worker slept: what it held in memory is gone, storage.session is not.
    _resetDebuggerForTesting()
    _resetLiveForTesting()
    fake.log = []
    fake.pageLog = []
    await act('click', { ref: 'e5' })
    expect(pageOps('click')).toHaveLength(1)
    expect(methods()).toEqual([])
    expect(await liveState(7)).toBe('cancelled')
  })
})

describe('a default step leaves the page fillable; a step asked for by name marks it as before', () => {
  it('fill_login is not refused after a default click', async () => {
    await act('click', { ref: 'e5' })
    expect(await tamperedNow(7, 'doc-1')).toBe(false)
    await act('click', { ref: 'e5', trusted: true })
    expect(await tamperedNow(7, 'doc-1')).toBe(true)
  })
})

// Point 3 of 2026-11-09: an agent's screenshot through the debugger whenever captureVisibleTab cannot
// serve, whether or not anyone watches, and a tab behind another is pictured in place.
describe('an agent\'s screenshot through the debugger, watched or not', () => {
  it('a tab behind another: drawn in place, the agent window\'s front tab never switched, no window capture', async () => {
    fake.active = false
    const r = await act('screenshot')
    expect(r.image).toBe('data:image/jpeg;base64,LIVE')
    expect(methods()).toContain('Page.captureScreenshot')
    expect(methods()).not.toContain('captureVisibleTab')
    expect(fake.tabUpdates.filter((u) => u.o.active === true)).toEqual([])
  })

  it('a minimized agent window: the same, nothing restored', async () => {
    fake.windowState = 'minimized'
    const r = await act('screenshot')
    expect(r.image).toBe('data:image/jpeg;base64,LIVE')
    expect(methods()).not.toContain('captureVisibleTab')
  })

  it('a visible front tab: the window\'s own picture, no debugger', async () => {
    const r = await act('screenshot')
    expect(r.image).toBe('data:image/jpeg;base64,SEEN')
    expect(methods()).toEqual(['captureVisibleTab'])
  })

  it('DevTools holds a tab behind another: no picture in place, so it is brought up and captured as before', async () => {
    fake.active = false
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    const r = await act('screenshot')
    expect(r.image).toBe('data:image/jpeg;base64,SEEN')
    expect(fake.tabUpdates.filter((u) => u.o.active === true).map((u) => u.id)).toEqual([7])
  })

  it('live pictures off: a tab behind another is brought up in the agent window as before (no debugger)', async () => {
    fake.active = false
    fake.local = { livePictures: false }
    await act('screenshot').catch(() => undefined)
    expect(methods()).not.toContain('attach')
    expect(fake.tabUpdates.filter((u) => u.o.active === true).map((u) => u.id)).toEqual([7])
  })
})
