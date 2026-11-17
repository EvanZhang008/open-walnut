/**
 * An agent leaving a page (packages/browser-extension/src/agent-leave.ts, agent-dialog-act.ts,
 * tab-close.ts) against a fake browser whose tabs, page and debugger behave as Chromium's were
 * measured to (2026-11-17, real extension in Chromium): a close or navigate of a page with a
 * beforeunload handler opens "Leave site?" (the debugger's Page.javascriptDialogOpening, type
 * beforeunload, no message), chrome.tabs.remove does not end until it is answered Leave, and Stay
 * leaves the page as it was.
 *   - close, navigate and back answer at once with the dialog, the tab still the agent's (before:
 *     a 504 after 30 s, and the tab read as the person's); dismiss stays, accept leaves;
 *   - discard: true leaves without asking (a close goes through Target.closeTarget, no beforeunload);
 *   - work the page holds (page-unsaved.ts) stops the leave first, naming it, unless discard;
 *   - a page that does not answer is page_held at once; close discard still closes it.
 * The page is asked first whether it would ask "Leave site?" (page-leave-ask.ts, in its own world),
 * so Chrome never shows the dialog, which brings the agent's window to the front over the person's
 * work (measured in Chromium): `asks` below. The native dialog tests are of a page that asks only on
 * a real event, which that first ask misses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void
type Updated = (tabId: number, change: { status?: string; url?: string }) => void
const PAGE_URL = 'https://forum.example.test/submit'
const fake = {
  session: {} as Record<string, unknown>,
  events: [] as Listener[],
  updated: [] as Updated[],
  log: [] as Array<[string, Record<string, unknown> | undefined]>,
  /** The page has a beforeunload handler (and the sticky activation Chrome asks for). */
  beforeunload: false,
  /** What leaving would lose, as page-unsaved.ts answers. */
  unsaved: { unsaved: [] as unknown[], count: 0 },
  /** Whether the page's script answers (a dialog Walnut never saw holds it when not). */
  answers: true,
  removed: false,
  url: PAGE_URL,
  /** What a "Leave site?" holds up: answered Leave, it runs. */
  pendingLeave: undefined as undefined | (() => void),
  /** The "Leave site?" event comes this long after the call that starts the leave answered (a busy page). */
  lateMs: 0,
  /** The page answers Walnut's own ask that it would ask "Leave site?" (page-leave-ask.ts). */
  asks: false,
  /** Walnut quieted the page's beforeunload for the leave under way. */
  quieted: false,
  winState: 'normal',
  winUpdates: [] as unknown[],
}
const ev = () => ({ addListener() {}, removeListener() {} })
const tab = () => ({ id: 7, windowId: 3, active: false, url: fake.url, title: 'Submit', status: 'complete' })
let dialogUp = false
const emit = (method: string, params: Record<string, unknown>) => {
  if (method === 'Page.javascriptDialogOpening') dialogUp = true
  if (method === 'Page.javascriptDialogClosed') dialogUp = false
  fake.events.forEach((fn) => fn({ tabId: 7 }, method, params))
}
const update = (change: { status?: string; url?: string }) => fake.updated.slice().forEach((fn) => fn(7, change))
/** A leave of the page: through its "Leave site?" when it has one. */
function leavePage(then: () => void): void {
  if (!fake.beforeunload || fake.quieted) { then(); return }
  fake.pendingLeave = then
  const open = () => emit('Page.javascriptDialogOpening', { type: 'beforeunload', message: '', defaultPrompt: '', url: fake.url, hasBrowserHandler: true })
  if (fake.lateMs) setTimeout(open, fake.lateMs); else open()
}
const navigateTo = (url: string) => () => { setTimeout(() => { fake.url = url; update({ status: 'loading', url }); setTimeout(() => update({ status: 'complete' }), 20) }, 10) }

;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) }, remove: async () => undefined },
    local: { get: async () => ({ agentControl: true }), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(),
    onUpdated: { addListener: (fn: Updated) => fake.updated.push(fn), removeListener: (fn: Updated) => { fake.updated = fake.updated.filter((f) => f !== fn) } },
    get: async () => { if (fake.removed) throw new Error('No tab with id: 7'); return tab() },
    query: async () => (fake.removed ? [] : [tab()]),
    update: async (_id: number, o: { url?: string }) => { if (o.url) leavePage(navigateTo(o.url)); return tab() },
    goBack: async () => { leavePage(navigateTo('https://forum.example.test/home')) },
    create: async () => tab(),
    ungroup: async () => undefined,
    // chrome.tabs.remove ends only once the tab is gone: a "Leave site?" answered Stay never ends it.
    remove: (_id: number) => new Promise<void>((resolve) => leavePage(() => { fake.removed = true; resolve() })),
    sendMessage: async (_tabId: number, msg: { type: string; op?: string }) => {
      if (!fake.answers) return new Promise(() => {})
      if (msg.type === 'agent-check') return { ok: true, walnut: false, href: fake.url, doc: 'doc-1' }
      if (msg.type === 'agent' && msg.op === 'unsaved') return { ok: true, result: fake.unsaved }
      return { ok: true, result: {} }
    },
  },
  scripting: {
    executeScript: async (o: { world?: string; args?: unknown[] }) => {
      if (!fake.answers) return new Promise(() => {})
      if (o.world === 'MAIN' && o.args?.[0] === 'ask') return [{ frameId: 0, result: { asks: fake.asks, frame: fake.url } }]
      if (o.world === 'MAIN' && o.args?.[0] === 'quiet') { fake.quieted = true; return [{ frameId: 0, result: { asks: false } }] }
      return [{ frameId: 0, result: {} }]
    },
  },
  windows: { get: async () => ({ state: fake.winState, focused: false }), update: async (id: number, o: unknown) => { fake.winUpdates.push([id, o]) }, onRemoved: ev() },
  permissions: { contains: async () => true, onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push(['attach', undefined]) },
    detach: async () => { fake.log.push(['detach', undefined]) },
    getTargets: async () => [{ id: 'T7', tabId: 7, type: 'page' }],
    sendCommand: async (_t: unknown, method: string, params?: Record<string, unknown>) => {
      fake.log.push([method, params])
      // As in Chromium: while a dialog is up, Page.enable waits for the page, which waits for the dialog.
      if (method === 'Page.enable' && dialogUp) return new Promise(() => {})
      if (method === 'Page.handleJavaScriptDialog') {
        const go = fake.pendingLeave
        fake.pendingLeave = undefined
        emit('Page.javascriptDialogClosed', { result: params?.accept === true })
        if (params?.accept === true) go?.()
      }
      if (method === 'Target.closeTarget') fake.removed = true
      return {}
    },
    onEvent: { addListener: (fn: Listener) => fake.events.push(fn), removeListener() {} },
    onDetach: ev(),
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { walnutCheck, agentTabs } = await import('../../../packages/browser-extension/src/agent-shared')
const { debuggerHeld, dropDebugger, _setLingerMsForTesting } = await import('../../../packages/browser-extension/src/cdp')
const dialogs = await import('../../../packages/browser-extension/src/agent-dialog')
const { _inPageForTesting: inPage } = await import('../../../packages/browser-extension/src/page-leave-ask')
walnutCheck.isWalnutPage = async () => false

const act = (action: string, args: Record<string, unknown> = {}) => agent._actForTesting({ id: 'c', action, args: { tab: 7, ...args }, allow: { any: true, sites: [] } }) as Promise<Record<string, any>>
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
const answers = () => fake.log.filter((l) => l[0] === 'Page.handleJavaScriptDialog').map((l) => l[1])
const LEAVE = { type: 'beforeunload', message: 'Leave site? Changes you made may not be saved.' }

beforeEach(() => {
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:A', history: [PAGE_URL] } } }
  fake.log = []
  fake.beforeunload = false
  fake.unsaved = { unsaved: [], count: 0 }
  fake.answers = true
  fake.removed = false
  fake.url = PAGE_URL
  fake.pendingLeave = undefined
  fake.lateMs = 0
  fake.asks = false
  fake.quieted = false
  fake.winState = 'normal'
  fake.winUpdates = []
  dialogUp = false
  dialogs._resetDialogsForTesting()
  dropDebugger(7)
  _setLingerMsForTesting(0)
})

describe('close on a page that asks "Leave site?"', () => {
  it('answers at once with the dialog; the tab stays the agent\'s; dismiss stays, close again asks again, accept closes it', async () => {
    fake.beforeunload = true
    const t0 = Date.now()
    const r = await act('close')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r).toMatchObject({ closed: false, dialog: { ...LEAVE, leaving: 'close' } })
    expect(r.note).toMatch(/dialog dismiss stays/)
    expect(await agentTabs.get(7)).toBeTruthy()
    expect(debuggerHeld(7)).toBe(true)
    // Nothing else reaches the page meanwhile.
    expect(await code(act('snapshot'))).toBe('dialog_open')

    const stay = await act('dialog', { accept: false })
    expect(stay).toMatchObject({ dialog: 'dismissed', stayed: true, answered: LEAVE })
    expect(fake.removed).toBe(false)
    expect(await agentTabs.get(7)).toBeTruthy()
    expect(debuggerHeld(7)).toBe(false)

    expect((await act('close')).dialog).toMatchObject(LEAVE)
    const leave = await act('dialog', { accept: true })
    expect(leave).toMatchObject({ dialog: 'accepted', closed: true, answered: LEAVE })
    expect(fake.removed).toBe(true)
    expect(answers()).toEqual([{ accept: false }, { accept: true }])
  })

  it('a second close while its "Leave site?" is up answers with the same dialog', async () => {
    fake.beforeunload = true
    await act('close')
    expect(await act('close')).toMatchObject({ closed: false, dialog: LEAVE })
    expect(answers()).toEqual([])
  })

  it('discard: true closes it without its beforeunload at all (Target.closeTarget)', async () => {
    fake.beforeunload = true
    expect(await act('close', { discard: true })).toMatchObject({ closed: true })
    expect(fake.log.find((l) => l[0] === 'Target.closeTarget')?.[1]).toEqual({ targetId: 'T7' })
    expect(answers()).toEqual([])
  })

  it('discard: true on a close already waiting on its "Leave site?" answers it Leave', async () => {
    fake.beforeunload = true
    await act('close')
    expect(await act('close', { discard: true })).toMatchObject({ closed: true })
    expect(answers()).toEqual([{ accept: true }])
  })

  it('a page without one closes as before', async () => {
    expect(await act('close')).toEqual({ tab: 7, closed: true })
    expect(await agentTabs.get(7)).toBeUndefined()
  })
})

describe('navigate and back', () => {
  it('navigate answers with the "Leave site?"; accept goes there, dismiss stays', async () => {
    fake.beforeunload = true
    const r = await act('navigate', { url: 'https://forum.example.test/other' })
    expect(r).toMatchObject({ dialog: { ...LEAVE, leaving: 'navigate' }, url: PAGE_URL })
    expect(await act('dialog', { accept: false })).toMatchObject({ stayed: true, url: PAGE_URL })
    await act('navigate', { url: 'https://forum.example.test/other' })
    expect(await act('dialog', { accept: true })).toMatchObject({ dialog: 'accepted', left: true, url: 'https://forum.example.test/other' })
  })

  it('navigate with discard leaves without asking (the page is quieted first, so no "Leave site?" opens)', async () => {
    fake.beforeunload = true
    const r = await act('navigate', { url: 'https://forum.example.test/other', discard: true })
    expect(r).toMatchObject({ url: 'https://forum.example.test/other' })
    expect(fake.quieted).toBe(true)
    expect(answers()).toEqual([])
  })

  it('back answers with the "Leave site?" too', async () => {
    fake.beforeunload = true
    expect(await act('back')).toMatchObject({ dialog: { ...LEAVE, leaving: 'back' } })
    expect(await act('dialog', { accept: true })).toMatchObject({ left: true, url: 'https://forum.example.test/home' })
  })
})

describe('work the page would lose', () => {
  it('stops navigate, back and close first, naming it; discard leaves anyway', async () => {
    fake.unsaved = { unsaved: [{ what: 'Body', kind: 'text', chars: 412 }, { what: 'Add video', kind: 'file', files: ['demo.mp4'] }], count: 2 }
    for (const [action, args] of [['navigate', { url: 'https://forum.example.test/x' }], ['back', {}], ['close', {}]] as const) {
      const err = await act(action, args).catch((e) => e)
      expect(err.code).toBe('unsaved_work')
      expect(err.message).toMatch(/Body \(412 characters typed\); Add video \(files chosen: demo\.mp4\)/)
      expect(err.message).toMatch(new RegExp(`call ${action} again with discard: true`))
      expect(err.extra.unsaved).toHaveLength(2)
    }
    expect(fake.removed).toBe(false)
    expect(await act('close', { discard: true })).toMatchObject({ closed: true })
  })
})

describe('a page that does not answer', () => {
  it('a dialog no debugger saw holds it: page_held within seconds (Page.enable waits on it), never a wait for good; close discard still closes it', async () => {
    // As in Chromium: the page's script and Page.enable both wait on that dialog.
    fake.answers = false
    dialogUp = true
    const t0 = Date.now()
    expect(await code(act('close'))).toBe('page_held')
    expect(await code(act('navigate', { url: 'https://forum.example.test/x' }))).toBe('page_held')
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(await act('close', { discard: true })).toMatchObject({ closed: true })
    expect(fake.log.some((l) => l[0] === 'Target.closeTarget')).toBe(true)
  }, 30_000)

  it('a page whose script never loads (a network error page) still navigates: it is not taken as held', async () => {
    fake.answers = false
    expect(await act('navigate', { url: 'https://forum.example.test/x' })).toMatchObject({ url: 'https://forum.example.test/x' })
  }, 30_000)
})

describe('a "Leave site?" already up when the agent leaves again', () => {
  it('navigate answers with it; navigate with discard answers it Leave and goes on', async () => {
    fake.beforeunload = true
    expect((await act('navigate', { url: 'https://forum.example.test/a' })).dialog).toMatchObject({ leaving: 'navigate' })
    expect(await act('navigate', { url: 'https://forum.example.test/b' })).toMatchObject({ dialog: { ...LEAVE, leaving: 'navigate' } })
    fake.beforeunload = false
    const r = await act('navigate', { url: 'https://forum.example.test/b', discard: true })
    expect(answers()).toEqual([{ accept: true }])
    expect(r.url).toBe('https://forum.example.test/b')
  })

  it('a "Leave site?" whose event comes after back\'s own call answered is still that back\'s', async () => {
    fake.beforeunload = true
    fake.lateMs = 400
    expect(await act('back')).toMatchObject({ dialog: { ...LEAVE, leaving: 'back' } })
    expect(debuggerHeld(7)).toBe(true)
  })
})

describe('the page is asked before Chrome is', () => {
  const dialogsSeen = () => fake.log.filter((l) => l[0] === 'Page.handleJavaScriptDialog').length

  it('close, navigate and back on a page that would ask "Leave site?" stay, with no dialog shown, naming it', async () => {
    fake.beforeunload = true
    fake.asks = true
    for (const [action, args] of [['close', {}], ['navigate', { url: 'https://forum.example.test/x' }], ['back', {}]] as const) {
      const err = await act(action, args).catch((e) => e)
      expect(err.code).toBe('unsaved_work')
      expect(err.message).toMatch(/the page itself asks "Leave site\?"/)
      expect(err.message).toMatch(/showed no dialog/)
      expect(err.extra.dialog).toMatchObject({ type: 'beforeunload', shown: false, url: PAGE_URL })
    }
    expect(dialogUp).toBe(false)
    expect(fake.pendingLeave).toBeUndefined()
    expect(fake.removed).toBe(false)
    expect(await agentTabs.get(7)).toBeTruthy()
  })

  it('discard: true on navigate quiets the page first: it leaves with no dialog at all', async () => {
    fake.beforeunload = true
    fake.asks = true
    const r = await act('navigate', { url: 'https://forum.example.test/other', discard: true })
    expect(fake.quieted).toBe(true)
    expect(r.url).toBe('https://forum.example.test/other')
    expect(r.left_anyway).toBeUndefined()
    expect(dialogsSeen()).toBe(0)
  })

  it('a "Leave site?" the ask missed, in the agent window in the Dock: the window goes back to the Dock', async () => {
    fake.beforeunload = true
    fake.winState = 'minimized'
    expect((await act('close')).dialog).toMatchObject({ type: 'beforeunload' })
    expect(fake.winUpdates).toEqual([[3, { state: 'minimized' }]])
  })

  it('a window not in the Dock is left as it is', async () => {
    fake.beforeunload = true
    await act('close')
    expect(fake.winUpdates).toEqual([])
  })
})

describe('the in-page ask and quiet (page-leave-ask.ts inPage, on a stand-in window)', () => {
  const g = globalThis as any
  const withWindow = (handlers: Array<(e: any) => unknown>, onbeforeunload?: (e: any) => unknown) => {
    class BeforeUnloadEvent {}
    Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', { configurable: true, get: () => '', set: () => undefined })
    const w: any = {
      onbeforeunload: onbeforeunload ?? null,
      BeforeUnloadEvent,
      dispatchEvent(e: any) { for (const h of handlers) h(e); if (typeof w.onbeforeunload === 'function') w.onbeforeunload(e); return true },
    }
    g.window = w
    g.location = { href: 'https://forum.example.test/submit' }
    return w
  }
  const restore = { window: g.window, location: g.location }
  afterEach(() => { g.window = restore.window; g.location = restore.location; vi.useRealTimers() })

  it.each([
    ['preventDefault', (e: any) => { e.preventDefault() }],
    ['returnValue = \'\'', (e: any) => { e.returnValue = '' }],
  ])('a handler that asks with %s is read as asking; one that does nothing is not', (_n, h) => {
    withWindow([h])
    expect(inPage('ask', Date.now() + 2000).asks).toBe(true)
    withWindow([() => undefined])
    expect(inPage('ask', Date.now() + 2000).asks).toBe(false)
  })

  it('an onbeforeunload that returns words asks, and it is still the page\'s afterwards', () => {
    const h = () => 'Unsaved'
    const w = withWindow([], h)
    expect(inPage('ask', Date.now() + 2000).asks).toBe(true)
    expect(w.onbeforeunload).toBe(h)
  })

  it('quiet lasts 20 s: then the page\'s onbeforeunload and the event\'s own returnValue are as they were', () => {
    vi.useFakeTimers()
    const h = () => 'Unsaved'
    const w = withWindow([], h)
    const before = Object.getOwnPropertyDescriptor(w.BeforeUnloadEvent.prototype, 'returnValue')
    inPage('quiet', Date.now() + 2000)
    expect(w.onbeforeunload).toBeNull()
    vi.advanceTimersByTime(20_000)
    expect(w.onbeforeunload).toBe(h)
    expect(Object.getOwnPropertyDescriptor(w.BeforeUnloadEvent.prototype, 'returnValue')).toEqual(before)
    expect(Object.getOwnPropertyDescriptor(w.BeforeUnloadEvent.prototype, 'preventDefault')).toBeUndefined()
  })

  it('a call that comes after Walnut stopped waiting does nothing', () => {
    const h = () => 'Unsaved'
    const w = withWindow([], h)
    expect(inPage('quiet', Date.now() - 1)).toEqual({ asks: false })
    expect(w.onbeforeunload).toBe(h)
  })
})
