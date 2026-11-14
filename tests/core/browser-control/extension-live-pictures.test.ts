/**
 * Live pictures of a covered agent window (packages/browser-extension/src/agent-live.ts), the
 * shared debugger session (cdp.ts acquireDebugger), the real-input switch kept apart from the
 * debugger permission (trusted-switch.ts) and the grant page opener (grant-open.ts), against a fake
 * Chrome. 2026-11-09: with Walnut's agent window entirely under other windows, Chrome draws nothing
 * there and captureVisibleTab fails "image readback failed"; Page.captureScreenshot draws the page
 * off screen, and the user approved using it while the Browser view is watched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const ev = () => ({ addListener() {}, removeListener() {} })
type Detach = (source: { tabId?: number }, reason: string) => void
const fake = {
  session: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  captureError: '' as string,
  captures: 0,
  perm: true,
  grantAnswer: true,
  requests: 0,
  removes: 0,
  attached: new Set<number>(),
  attaches: [] as number[],
  detaches: [] as number[],
  sent: [] as Array<{ tab: number; m: string; p?: Record<string, unknown> }>,
  onDetach: [] as Detach[],
  created: [] as Array<Record<string, unknown>>,
  tabUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  windowUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  /** Tabs open in the person's windows (for the grant page). */
  others: [] as Array<{ id: number; windowId: number; url?: string; active?: boolean }>,
  lastFocused: 1,
  /** Page.captureScreenshot never answers (a page that hangs). */
  hang: false,
  windowState: 'normal',
  incognito: new Set<number>(),
  changed: [] as Array<(c: Record<string, { newValue?: unknown }>, area: string) => void>,
  /** Every tabs.onRemoved listener (a tab closing is told to each). */
  removed: [] as Array<(tabId: number) => void>,
  /** Tab 7 is the front tab of the agent window (else another tab is in front: 8). */
  active: true,
  discarded: false,
  /** The browser refuses the attach (DevTools holds the tab). */
  attachError: '',
}
const tab = (id = 7) => ({ id, windowId: 3, active: id === 7 ? fake.active : !fake.active, url: 'https://shop.example.test/', title: 'Shop', ...(id === 7 && fake.discarded ? { discarded: true } : {}) })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://walnut/${p}`, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: {
      get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in fake.local).map((x) => [x, fake.local[x]])),
      set: async (o: Record<string, unknown>) => {
        Object.assign(fake.local, o)
        const c = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }]))
        for (const f of fake.changed) f(c, 'local')
      },
    },
    onChanged: { addListener(f: (c: Record<string, { newValue?: unknown }>, area: string) => void) { fake.changed.push(f) }, removeListener() {} },
  },
  tabs: {
    onRemoved: { addListener(f: (tabId: number) => void) { fake.removed.push(f) }, removeListener() {} }, onUpdated: ev(),
    get: async (id: number) => tab(id),
    query: async (q: Record<string, unknown>) => {
      if (q.url) return fake.others.filter((t) => t.url === q.url)
      if (q.lastFocusedWindow) return fake.others.filter((t) => t.windowId === fake.lastFocused && t.active)
      if (q.windowId === 3) return q.active ? [fake.active ? tab(7) : tab(8)] : [tab(7), tab(8)]
      return [tab(7), ...fake.others.filter((t) => t.active)]
    },
    create: async (o: Record<string, unknown>) => { fake.created.push(o); return { id: 90, windowId: o.windowId as number, url: o.url as string } },
    update: async (id: number, o: Record<string, unknown>) => { fake.tabUpdates.push({ id, o }); return tab(id) },
    sendMessage: async () => ({ ok: true }),
    captureVisibleTab: async () => { fake.captures++; if (fake.captureError) throw new Error(fake.captureError); return 'data:image/jpeg;base64,SEEN' },
  },
  windows: {
    get: async (id: number) => ({ id, state: id === 3 ? fake.windowState : 'normal', focused: false, type: 'normal', incognito: fake.incognito.has(id) }), onRemoved: ev(),
    update: async (id: number, o: Record<string, unknown>) => { fake.windowUpdates.push({ id, o }); return {} },
  },
  permissions: {
    contains: async (p: { permissions?: string[] }) => (p.permissions?.includes('debugger') ? fake.perm : true),
    request: async () => { fake.requests++; if (fake.grantAnswer) fake.perm = true; return fake.grantAnswer },
    remove: async () => { fake.removes++; fake.perm = false; return true },
    onRemoved: ev(),
  },
  debugger: {
    attach: async (t: { tabId: number }) => {
      fake.attaches.push(t.tabId)
      await new Promise((r) => setTimeout(r, 5))
      if (fake.attachError) throw new Error(fake.attachError)
      if (fake.attached.has(t.tabId)) throw new Error('Another debugger is already attached to the tab')
      fake.attached.add(t.tabId)
    },
    detach: async (t: { tabId: number }) => { fake.detaches.push(t.tabId); fake.attached.delete(t.tabId) },
    sendCommand: async (t: { tabId: number }, m: string, p?: Record<string, unknown>) => {
      if (!fake.attached.has(t.tabId)) throw new Error('Debugger is not attached to the tab')
      fake.sent.push({ tab: t.tabId, m, p })
      if (m === 'Page.captureScreenshot' && fake.hang) return new Promise(() => undefined)
      return m === 'Page.captureScreenshot' ? { data: 'LIVE' } : {}
    },
    onEvent: ev(),
    onDetach: { addListener(f: Detach) { fake.onDetach.push(f) }, removeListener() {} },
  },
}

const { viewWatch, viewFrame, streaming, STREAM_QUALITY, _resetViewForTesting } = await import('../../../packages/browser-extension/src/agent-view')
const { liveHeld, liveState, LIVE_GAP_MS, _resetLiveForTesting } = await import('../../../packages/browser-extension/src/agent-live')
const { acquireDebugger, releaseDebugger, holdDebugger, holdersOf, withDebugger, debuggerHeld, _resetDebuggerForTesting, _setLingerMsForTesting } = await import('../../../packages/browser-extension/src/cdp')
const { migrateRealInput, realInputOn, livePicturesOn, setTrustedInput, setLivePictures, trustedInputState } = await import('../../../packages/browser-extension/src/trusted-switch')
const { trustedReady } = await import('../../../packages/browser-extension/src/agent-trusted')
const { openGrant } = await import('../../../packages/browser-extension/src/grant-open')
const { shooter } = await import('../../../packages/browser-extension/src/agent-shot')
const { foldDialogEvent, _resetDialogsForTesting } = await import('../../../packages/browser-extension/src/agent-dialog')
const { endShot, livePicture, endLive } = await import('../../../packages/browser-extension/src/agent-live')
const { startRecording, stopRecording, RECORDING_DOMAINS } = await import('../../../packages/browser-extension/src/agent-net')
const { watchGrantClose, GRANT_COOL_MS, GRANT_STATE_KEY } = await import('../../../packages/browser-extension/src/grant-open')
const { grantLivePictures } = await import('../../../packages/browser-extension/src/trusted-switch')

const OWNER = 'task:live'
const allow = { any: true, sites: [], walnut: ['walnut.example.test'] }
const cmd = (action: string, args: Record<string, unknown> = {}) => ({ id: 'c', action, args: { tab: 7, ...args }, allow })
const until = async (ok: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
const COVERED = 'Failed to capture tab: image readback failed'
const dbg = (globalThis as any).chrome.debugger

/** A watch that posts `n` frames (or until `stop` says so), then nobody watches. */
async function watch(n: number, onPost?: (b: Record<string, unknown>, i: number) => void): Promise<Array<Record<string, unknown>>> {
  const posts: Array<Record<string, unknown>> = []
  await viewWatch(cmd('view_watch'), () => false, async (b) => { posts.push(b); onPost?.(b, posts.length); return { more: posts.length < n, ms: 5000 } })
  await until(() => !streaming(7), 8000)
  return posts
}

beforeEach(() => {
  fake.session = { agentTabs: { 7: { owner: OWNER, grant: 'g1', who: 'Order paper' } }, agentWindow: 3 }
  fake.local = { realInput: true }
  fake.captureError = ''
  fake.captures = 0
  fake.perm = true
  fake.grantAnswer = true
  fake.requests = 0
  fake.removes = 0
  fake.attached = new Set()
  fake.attaches = []
  fake.detaches = []
  fake.sent = []
  fake.created = []
  fake.tabUpdates = []
  fake.windowUpdates = []
  fake.others = [{ id: 20, windowId: 1, active: true, url: 'https://news.example.test/' }]
  fake.lastFocused = 1
  fake.hang = false
  fake.windowState = 'normal'
  fake.incognito = new Set()
  fake.active = true
  fake.discarded = false
  fake.attachError = ''
  _setLingerMsForTesting(0)
  _resetViewForTesting()
  _resetLiveForTesting()
  _resetDebuggerForTesting()
  _resetDialogsForTesting()
})

describe('a covered agent window, watched', () => {
  it('pictures come through Page.captureScreenshot: one attach for the whole stream, detached when nobody watches', async () => {
    fake.captureError = COVERED
    const t0 = Date.now()
    const posts = await watch(4)
    expect(posts.map((p) => p.shown)).toEqual([true, true, true, true])
    expect(posts[0]).toMatchObject({ tab: 7, shown: true, image: 'data:image/jpeg;base64,LIVE' })
    // The same picture again goes without its bytes, as a visible window's does.
    expect(posts[1]).toMatchObject({ same: true })
    const shots = fake.sent.filter((s) => s.m === 'Page.captureScreenshot')
    expect(shots).toHaveLength(4)
    expect(shots[0].p).toEqual({ format: 'jpeg', quality: STREAM_QUALITY, optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false })
    // Nothing else is sent: no input, no script, nothing that raises a window.
    expect(new Set(fake.sent.map((s) => s.m))).toEqual(new Set(['Page.captureScreenshot']))
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
    expect(liveHeld(7)).toBe(false)
    expect(debuggerHeld(7)).toBe(false)
    // At least the visible stream's rate: four pictures well within the two-a-second pace's time.
    expect(Date.now() - t0).toBeLessThan(4 * 550 + 400)
    expect(LIVE_GAP_MS).toBeLessThanOrEqual(550)
    // Never a window raised or focused, never a tab switched.
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('once it needed the debugger, the watch keeps its one session to the end, also after the window shows again (no attach and detach per frame)', async () => {
    fake.captureError = COVERED
    let attachedWhileShown = false
    const posts = await watch(4, (_b, i) => { if (i === 2) fake.captureError = ''; if (i === 3) attachedWhileShown = fake.attached.has(7) })
    expect(posts.every((p) => p.shown === true)).toBe(true)
    expect(attachedWhileShown).toBe(true)
    // One attach, one detach (when nobody watches), every picture through the same session.
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
    expect(fake.sent.filter((s) => s.m === 'Page.captureScreenshot')).toHaveLength(4)
  })

  it('a visible window never attaches the debugger', async () => {
    const posts = await watch(3)
    expect(posts.every((p) => p.shown === true)).toBe(true)
    expect(fake.attaches).toEqual([])
  })

  it('without the permission: no attach, and the covered frame says live pictures need it', async () => {
    fake.captureError = COVERED
    fake.perm = false
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'no_permission' })
    expect(fake.attaches).toEqual([])
  })

  it('with live pictures turned off: no attach, and the frame says off', async () => {
    fake.captureError = COVERED
    fake.local.livePictures = false
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'off' })
    expect(fake.attaches).toEqual([])
  })

  it('the person turning live pictures off while watched lets the debugger go at the next frame', async () => {
    fake.captureError = COVERED
    const posts = await watch(4, (_b, i) => { if (i === 2) fake.local.livePictures = false })
    expect(posts.slice(0, 2).map((p) => p.shown)).toEqual([true, true])
    expect(posts.at(-1)).toMatchObject({ shown: false, why: 'covered', live: 'off' })
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
    expect(fake.sent.filter((s) => s.m === 'Page.captureScreenshot')).toHaveLength(2)
  })

  it('the person cancelling Chrome\'s debugging bar ends live pictures for that tab', async () => {
    fake.captureError = COVERED
    const posts = await watch(3, (_b, i) => {
      if (i !== 1) return
      fake.attached.delete(7)
      for (const f of fake.onDetach) f({ tabId: 7 }, 'canceled_by_user')
    })
    expect(posts[0]).toMatchObject({ shown: true })
    expect(posts.at(-1)).toMatchObject({ shown: false, why: 'covered', live: 'cancelled' })
    expect(fake.attaches).toEqual([7])
  })

  it('a picture that never comes is given up after a moment: the gate is free again, the debugger let go, no new try for a while', async () => {
    _resetLiveForTesting(200)
    fake.captureError = COVERED
    fake.hang = true
    const posts = await watch(3)
    expect(posts.map((p) => p.live)).toEqual(['failed', 'failed', 'failed'])
    // One attach and its detach: the backoff keeps the bar from flashing every frame.
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
  })

  it('a dialog open on the page: no live picture is tried (it may never come), and the frame says so', async () => {
    fake.captureError = COVERED
    foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' })
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'dialog' })
    expect(fake.attaches).toEqual([])
  })

  it('never on a tab of the person\'s: a handed-over tab gets the covered line, no debugger', async () => {
    fake.captureError = COVERED
    fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1', handed: 'shop.example.test' } }
    expect(await viewFrame(cmd('view_frame'), () => false)).toMatchObject({ shown: false, why: 'covered' })
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'unavailable' })
    expect(fake.attaches).toEqual([])
    await expect(shooter(7, 3, false)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered' })
    expect(fake.attaches).toEqual([])
  })

  it('turned off in Settings while streaming: let go at once, before the next frame', async () => {
    fake.captureError = COVERED
    let detachedAt = -1
    const posts = await watch(3, (_b, i) => {
      if (i !== 1) return
      void (globalThis as any).chrome.storage.local.set({ livePictures: false })
      detachedAt = fake.detaches.length
    })
    expect(posts[0]).toMatchObject({ shown: true })
    expect(posts.at(-1)).toMatchObject({ why: 'covered', live: 'off' })
    // Detached in the same moment the switch went off, before any next frame.
    expect(detachedAt).toBe(1)
    expect(fake.detaches).toEqual([7])
  })

  it('minimized meanwhile: pictures go on through the debugger, and nothing restores the window', async () => {
    fake.captureError = COVERED
    const posts = await watch(3, (_b, i) => { if (i === 1) fake.windowState = 'minimized' })
    expect(posts.map((p) => p.shown)).toEqual([true, true, true])
    expect(fake.attaches).toEqual([7])
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('minimized with live pictures off: says minimized and why, and holds no debugger', async () => {
    fake.windowState = 'minimized'
    fake.local.livePictures = false
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'minimized', live: 'off' })
    expect(fake.attaches).toEqual([])
  })

  it('minimized from the start: the first picture already comes through the debugger', async () => {
    fake.windowState = 'minimized'
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: true, image: 'data:image/jpeg;base64,LIVE' })
    // captureVisibleTab of a minimized window is never tried.
    expect(fake.captures).toBe(0)
  })

  it('a single frame (an older Walnut, view_frame) never attaches', async () => {
    fake.captureError = COVERED
    expect(await viewFrame(cmd('view_frame'), () => false)).toMatchObject({ shown: false, why: 'covered' })
    expect(fake.attaches).toEqual([])
  })
})

describe('an agent\'s screenshot of a covered window', () => {
  it('nobody watches the card: the picture comes through the debugger anyway (2026-11-09: the agent fully capable), then the hold goes', async () => {
    fake.captureError = COVERED
    expect(await shooter(7, 3, true)({ format: 'png' })).toBe('data:image/png;base64,LIVE')
    expect(fake.attaches).toEqual([7])
    await endShot(7)
    expect(fake.detaches).toEqual([7])
    expect(debuggerHeld(7)).toBe(false)
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('live pictures off, or the bar cancelled lately: covered, as before, with no attach', async () => {
    fake.captureError = COVERED
    fake.local.livePictures = false
    await expect(shooter(7, 3, true)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered' })
    fake.local.livePictures = true
    await acquireDebugger(dbg, 7, 'record')
    fake.attached.delete(7)
    for (const f of fake.onDetach) f({ tabId: 7 }, 'canceled_by_user')
    fake.attaches = []
    await expect(shooter(7, 3, true)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered' })
    expect(fake.attaches).toEqual([])
  })

  it('a picture through the debugger that fails keeps the covered code and says why', async () => {
    fake.captureError = COVERED
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    await expect(shooter(7, 3, true)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered', message: expect.stringMatching(/debugger gave no picture either/) })
    expect(await liveState(7)).toBe('devtools')
  })

  it('while the Browser view\'s stream holds the tab: through that session, held for the screenshot, and the stream\'s attach stays', async () => {
    fake.captureError = COVERED
    await livePicture(7, STREAM_QUALITY)
    expect(liveHeld(7)).toBe(true)
    fake.sent = []
    const shoot = shooter(7, 3, true)
    expect(await shoot({ format: 'png' })).toBe('data:image/png;base64,LIVE')
    expect(await shoot({ format: 'jpeg', quality: 70 })).toBe('data:image/jpeg;base64,LIVE')
    // One attach for the stream and both pictures (a full page takes several).
    expect(fake.attaches).toEqual([7])
    expect(fake.sent.map((x) => x.p)).toEqual([
      { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false },
      { format: 'jpeg', quality: 70, optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false },
    ])
    await endShot(7)
    expect(fake.detaches).toEqual([])
    await endLive(7)
    expect(fake.detaches).toEqual([7])
  })

  it('a session a recording holds: the screenshot joins it, and the recording keeps it after', async () => {
    fake.captureError = COVERED
    await acquireDebugger(dbg, 7, 'record')
    expect(await shooter(7, 3, true)({ format: 'png' })).toBe('data:image/png;base64,LIVE')
    await endShot(7)
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([])
    expect(holdersOf(7)).toEqual(['record'])
    await releaseDebugger(dbg, 7, 'record')
  })

  it('a tab behind another (inPlace): only the debugger, never captureVisibleTab of the window', async () => {
    expect(await shooter(7, 3, true, true)({ format: 'jpeg', quality: 70 })).toBe('data:image/jpeg;base64,LIVE')
    expect(fake.captures).toBe(0)
    expect(fake.tabUpdates).toEqual([])
  })

  it('without the permission says covered as before, even while a stream ran', async () => {
    fake.captureError = COVERED
    await livePicture(7, STREAM_QUALITY)
    fake.perm = false
    await expect(shooter(7, 3, true)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered' })
    await endLive(7)
    expect(fake.attaches).toEqual([7])
  })

  it('a visible window is captured as always, no debugger', async () => {
    expect(await shooter(7, 3, true)({ format: 'png' })).toBe('data:image/jpeg;base64,SEEN')
    expect(fake.attaches).toEqual([])
  })
})

describe('one debugger session per tab, shared', () => {
  it('a real-input step while pictures hold the session uses it: no second attach, no detach under either', async () => {
    const pic = await acquireDebugger(dbg, 7, 'picture')
    let during: string[] = []
    await withDebugger(dbg, 7, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      during = holdersOf(7)
      // The pictures end while the click runs: the session stays for the click.
      await releaseDebugger(dbg, 7, 'picture')
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 })
    })
    expect(pic).toBeTypeOf('function')
    expect(during).toEqual(expect.arrayContaining(['picture']))
    expect(fake.attaches).toEqual([7])
    expect(fake.sent.map((s) => s.p?.type)).toEqual(['mouseMoved', 'mousePressed'])
    // The last holder (the click) let go: detached once.
    expect(fake.detaches).toEqual([7])
  })

  it('two users asking at once attach once', async () => {
    const [a, b] = await Promise.all([acquireDebugger(dbg, 7, 'picture'), acquireDebugger(dbg, 7, 'record')])
    expect(a).toBe(b)
    expect(fake.attaches).toEqual([7])
    await releaseDebugger(dbg, 7, 'picture')
    expect(fake.detaches).toEqual([])
    await releaseDebugger(dbg, 7, 'record')
    expect(fake.detaches).toEqual([7])
  })

  it('a dialog waiting for its answer keeps the session after the pictures end', async () => {
    const send = await acquireDebugger(dbg, 7, 'picture')
    holdDebugger(7, send, 'dialog')
    await releaseDebugger(dbg, 7, 'picture')
    expect(debuggerHeld(7)).toBe(true)
    expect(fake.detaches).toEqual([])
    await releaseDebugger(dbg, 7, 'dialog')
    expect(fake.detaches).toEqual([7])
  })

  it('the browser letting go forgets the session for every holder', async () => {
    await acquireDebugger(dbg, 7, 'picture')
    await acquireDebugger(dbg, 7, 'record')
    fake.attached.delete(7)
    for (const f of fake.onDetach) f({ tabId: 7 }, 'target_closed')
    expect(debuggerHeld(7)).toBe(false)
    // A later use attaches afresh.
    await acquireDebugger(dbg, 7, 'picture')
    expect(fake.attaches).toEqual([7, 7])
  })
})

describe('live pictures ended while their attach was on its way (review 2026-11-09)', () => {
  it('endLive during the attach: the hold that lands is let go at once, nothing stays attached, no picture', async () => {
    const pic = livePicture(7, STREAM_QUALITY)
    // The attach is under way (the fake takes a few ms): the stream ends now.
    expect(fake.attaches).toEqual([7])
    await endLive(7)
    await expect(pic).rejects.toThrow(/ended meanwhile/)
    expect(holdersOf(7)).toEqual([])
    expect(debuggerHeld(7)).toBe(false)
    expect(fake.attached.has(7)).toBe(false)
    expect(fake.detaches).toEqual([7])
    expect(fake.sent.filter((x) => x.m === 'Page.captureScreenshot')).toEqual([])
    expect(liveHeld(7)).toBe(false)
  })

  it('a new stream that starts before the old attach lands keeps its own hold: the old one never detaches it', async () => {
    const old = livePicture(7, STREAM_QUALITY)
    await endLive(7)
    const fresh = livePicture(7, STREAM_QUALITY)
    await expect(old).rejects.toThrow(/ended meanwhile/)
    expect(await fresh).toBe('data:image/jpeg;base64,LIVE')
    expect(liveHeld(7)).toBe(true)
    expect(holdersOf(7)).toHaveLength(1)
    expect(fake.attached.has(7)).toBe(true)
    await endLive(7)
    expect(debuggerHeld(7)).toBe(false)
    expect(fake.attached.has(7)).toBe(false)
  })

  it('the stream let go while its picture was being drawn: no failure of the page, live pictures stay on', async () => {
    _resetLiveForTesting(200)
    fake.hang = true
    const pic = livePicture(7, STREAM_QUALITY)
    await vi.waitFor(() => expect(fake.sent.some((x) => x.m === 'Page.captureScreenshot')).toBe(true))
    await endLive(7)
    await expect(pic).rejects.toThrow()
    expect(await liveState(7)).toBe('on')
  })

  it('an end that lost its race is no failure of the page: the next stream may start at once', async () => {
    const pic = livePicture(7, STREAM_QUALITY)
    await endLive(7)
    await pic.catch(() => undefined)
    fake.captureError = COVERED
    const posts = await watch(1)
    expect(posts[0]).toMatchObject({ shown: true, image: 'data:image/jpeg;base64,LIVE' })
  })
})

describe('a recording that stops while another holder keeps the session (review 2026-11-09)', () => {
  const rec = { owner: OWNER, grant: 'g1' }

  it('turns off what it turned on, so the browser stops filling its buffers; Page stays for a step\'s dialogs', async () => {
    await livePicture(7, STREAM_QUALITY)
    expect(await startRecording(7, rec)).toBe(true)
    fake.sent = []
    expect(await stopRecording(7)).toBe(true)
    expect(fake.sent.map((x) => x.m)).toEqual(RECORDING_DOMAINS.map((d) => `${d}.disable`))
    expect(RECORDING_DOMAINS).toEqual(['Network', 'Runtime', 'Log'])
    // The pictures keep their session.
    expect(debuggerHeld(7)).toBe(true)
    expect(fake.detaches).toEqual([])
    await endLive(7)
    expect(fake.detaches).toEqual([7])
  })

  it('every domain a recording enables but Page is in the list it turns off', () => {
    const src = readFileSync('packages/browser-extension/src/agent-net.ts', 'utf8')
    const start = src.slice(src.indexOf('export async function startRecording'), src.indexOf('export async function stopRecording'))
    const enabled = [...start.matchAll(/send\('(\w+)\.enable'/g)].map((m) => m[1]).filter((d) => d !== 'Page')
    expect(enabled.sort()).toEqual([...RECORDING_DOMAINS].sort())
  })

  it('alone: detached, nothing more sent', async () => {
    expect(await startRecording(7, rec)).toBe(true)
    fake.sent = []
    await stopRecording(7)
    expect(fake.sent).toEqual([])
    expect(fake.detaches).toEqual([7])
  })
})

// 2026-11-09, the user: "why still no picture", "we need make it fully capable using debug". With
// the debugger held, every case captureVisibleTab cannot serve gets its picture in place.
describe('pictures always while watched: every case captureVisibleTab cannot serve', () => {
  it('a tab behind another tab of the agent window: pictured in place, the front tab never switched', async () => {
    fake.active = false
    const posts = await watch(3)
    expect(posts.map((p) => p.shown)).toEqual([true, true, true])
    expect(posts[0]).toMatchObject({ image: 'data:image/jpeg;base64,LIVE' })
    expect(fake.tabUpdates).toEqual([])
    expect(fake.windowUpdates).toEqual([])
    expect(fake.captures).toBe(0)
    // One session for the whole watch.
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
  })

  it('the same tab without the debugger (live pictures off): the old way, no debugger, and never a switch while the person is in the window', async () => {
    fake.active = false
    fake.local.livePictures = false
    await watch(1)
    expect(fake.attaches).toEqual([])
  })

  it('about four pictures a second while the page changes', async () => {
    fake.captureError = COVERED
    let n = 0
    const sendCommand = dbg.sendCommand
    dbg.sendCommand = async (t: { tabId: number }, m: string, p?: Record<string, unknown>) => (m === 'Page.captureScreenshot' ? (await sendCommand(t, m, p), { data: `LIVE${++n}` }) : sendCommand(t, m, p))
    try {
      const t0 = Date.now()
      const posts = await watch(6)
      const took = Date.now() - t0
      expect(posts.every((p) => p.shown === true && typeof p.image === 'string')).toBe(true)
      // Six different pictures in about 6 x LIVE_GAP_MS, well above captureVisibleTab's two a second.
      expect(LIVE_GAP_MS).toBeLessThanOrEqual(334)
      expect(took).toBeLessThan(6 * 550)
    } finally {
      dbg.sendCommand = sendCommand
    }
  })

  it('a tab Chrome discarded: its own reason, and no attach (that would load it again)', async () => {
    fake.discarded = true
    const posts = await watch(1)
    expect(posts[0]).toMatchObject({ shown: false, why: 'discarded' })
    expect(fake.attaches).toEqual([])
  })

  it('DevTools holds the tab: the frame says devtools, and the next try waits (no bar flashing)', async () => {
    fake.captureError = COVERED
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    const posts = await watch(3)
    expect(posts.map((p) => p.live)).toEqual(['devtools', 'devtools', 'devtools'])
    expect(fake.attaches).toEqual([7])
  })

  it('a tab behind another with DevTools on it: one try (the next waits), then the window\'s own picture as before', async () => {
    fake.active = false
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    await watch(2)
    expect(fake.attaches).toEqual([7])
    expect(await liveState(7)).toBe('devtools')
    // The old way: the agent window's own tab brought up (never a window focused), as before the debugger.
    expect(fake.tabUpdates.every((u) => u.id === 7 || u.id === 8)).toBe(true)
    expect(fake.windowUpdates).toEqual([])
  })

  it('a tab behind another while the person is in the agent window, with DevTools on it: behind, and why', async () => {
    fake.active = false
    fake.attachError = 'Another debugger is already attached to the tab with id: 7.'
    const get = (globalThis as any).chrome.windows.get
    ;(globalThis as any).chrome.windows.get = async (id: number) => ({ ...(await get(id)), focused: id === 3 })
    try {
      const posts = await watch(1)
      expect(posts[0]).toMatchObject({ shown: false, why: 'behind', live: 'devtools' })
      expect(fake.tabUpdates).toEqual([])
    } finally {
      ;(globalThis as any).chrome.windows.get = get
    }
  })

  it('the person cancelling the bar: no picture through it for the cool-down, on any tab', async () => {
    fake.captureError = COVERED
    await watch(1)
    for (const f of fake.onDetach) f({ tabId: 7 }, 'canceled_by_user')
    fake.attaches = []
    expect(await liveState(7)).toBe('cancelled')
    expect(await liveState(9)).toBe('cancelled')
    const posts = await watch(1)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'cancelled' })
    expect(fake.attaches).toEqual([])
  })
})

describe('the debugger session stays while the agent works (cdp.ts linger)', () => {
  it('a step\'s session lingers: the next step joins it, no second attach; it goes LINGER_MS after the last step', async () => {
    _setLingerMsForTesting(80)
    await withDebugger(dbg, 7, async (send) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }) }, { linger: true })
    expect(fake.detaches).toEqual([])
    expect(holdersOf(7)).toEqual(['linger'])
    await withDebugger(dbg, 7, async (send) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }) }, { linger: true })
    expect(fake.attaches).toEqual([7])
    await vi.waitFor(() => expect(fake.detaches).toEqual([7]), { timeout: 2000 })
    expect(debuggerHeld(7)).toBe(false)
  })

  it('the agent letting the tab go ends it at once', async () => {
    _setLingerMsForTesting(60_000)
    await withDebugger(dbg, 7, async () => undefined, { linger: true })
    const { endLinger } = await import('../../../packages/browser-extension/src/cdp')
    await endLinger(dbg, 7)
    expect(fake.detaches).toEqual([7])
  })

  it('after the person cancelled the bar, a step does not linger', async () => {
    _setLingerMsForTesting(60_000)
    await acquireDebugger(dbg, 7, 'record')
    fake.attached.delete(7)
    for (const f of fake.onDetach) f({ tabId: 7 }, 'canceled_by_user')
    await withDebugger(dbg, 7, async () => undefined, { linger: true })
    expect(holdersOf(7)).toEqual([])
    expect(fake.detaches).toEqual([7])
  })

  it('a step without linger (a recording\'s own) detaches at once, as before', async () => {
    _setLingerMsForTesting(60_000)
    await withDebugger(dbg, 7, async () => undefined)
    expect(fake.detaches).toEqual([7])
  })
})

describe('real input: on while the permission is held, until the person chooses (2026-11-09)', () => {
  it('never set by the person: it follows the permission, whatever an older build stored by itself', async () => {
    fake.local = {}
    fake.perm = true
    expect(await migrateRealInput()).toBe(true)
    expect(fake.local.realInput).toBe(true)
    expect(await trustedReady()).toBe(true)
    // An older build's own migration (or a grant for live pictures) stored it off: not the person's choice.
    fake.local = { realInput: false }
    expect(await realInputOn()).toBe(true)
    expect(fake.local.realInput).toBe(true)
    // No permission (a copy that lacks it): off, and on again once it is held.
    fake.local = {}
    fake.perm = false
    expect(await migrateRealInput()).toBe(false)
    expect(await trustedReady()).toBe(false)
    fake.perm = true
    expect(await trustedReady()).toBe(true)
  })

  it('the person\'s own off stays off; their on stays on', async () => {
    fake.local = {}
    expect(await setTrustedInput(false)).toBe(false)
    expect(fake.local).toMatchObject({ realInput: false, realInputBy: 'person' })
    expect(await migrateRealInput()).toBe(false)
    expect(await trustedReady()).toBe(false)
    expect(await trustedInputState()).toMatchObject({ on: false, livePictures: true, permission: true })
    expect(await setTrustedInput(true)).toBe(true)
    expect(await trustedReady()).toBe(true)
  })

  it('real input needs the permission too', async () => {
    fake.local = { realInput: true, realInputBy: 'person' }
    fake.perm = false
    expect(await trustedReady()).toBe(false)
    fake.perm = true
    expect(await trustedReady()).toBe(true)
  })

  it('turning either switch off never removes the permission (it is required now)', async () => {
    expect(await setTrustedInput(false)).toBe(false)
    expect(await setLivePictures(false)).toBe(false)
    expect(fake.removes).toBe(0)
    expect(await trustedInputState()).toMatchObject({ on: false, livePictures: false, permission: true })
    const src = readFileSync('packages/browser-extension/src/trusted-switch.ts', 'utf8')
    expect(src).not.toMatch(/permissions\.remove/)
  })

  it('a copy without the permission: turning real input on asks Chrome in the click; a no puts it back', async () => {
    fake.local = {}
    fake.perm = false
    fake.grantAnswer = false
    expect(await setTrustedInput(true)).toBe(false)
    expect(fake.local.realInput).toBe(false)
    fake.grantAnswer = true
    expect(await setTrustedInput(true)).toBe(true)
    expect(fake.local.realInput).toBe(true)
    expect(fake.requests).toBe(2)
  })

  it('the grant page stores live pictures on and leaves real input as it was', async () => {
    fake.local = { realInput: false, realInputBy: 'person' }
    fake.perm = false
    expect(await grantLivePictures()).toBe(true)
    expect(fake.local).toMatchObject({ livePictures: true, realInput: false, realInputBy: 'person' })
    expect(await trustedReady()).toBe(false)
    // Never set by the person: it follows the permission the grant brought.
    fake.local = {}
    fake.perm = false
    expect(await grantLivePictures()).toBe(true)
    expect(await trustedReady()).toBe(true)
  })

  it('grant.ts keeps no permission state from its opening: Allow calls grantLivePictures and nothing before it', () => {
    const src = readFileSync('packages/browser-extension/src/grant.ts', 'utf8')
    expect(src).not.toMatch(/debuggerGranted|setLivePictures|heldBefore/)
    const click = src.slice(src.indexOf('allow.onclick'), src.indexOf('root.append'))
    expect(click).toMatch(/void grantLivePictures\(\)/)
    expect(click.slice(0, click.indexOf('grantLivePictures'))).not.toMatch(/\bawait\b/)
  })

  it('the background settles the switch at its start', () => {
    const src = readFileSync('packages/browser-extension/src/background.ts', 'utf8')
    expect(src).toMatch(/void migrateRealInput\(\)/)
  })
})

describe('view_grant: the page that turns live pictures on', () => {
  it('the person\'s click opens it in front of their last-focused window, which comes forward; never in the agent window', async () => {
    fake.perm = false
    expect(await openGrant({ args: { tab: 7, person: true } })).toMatchObject({ opened: true, shown: true })
    expect(fake.created).toEqual([{ url: 'chrome-extension://walnut/grant.html', windowId: 1, active: true }])
    expect(fake.windowUpdates).toEqual([{ id: 1, o: { focused: true } }])
  })

  it('an agent\'s ask opens it in the background and focuses nothing', async () => {
    fake.perm = false
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: true, shown: false })
    expect(fake.created).toEqual([{ url: 'chrome-extension://walnut/grant.html', windowId: 1, active: false }])
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('the person last in the agent window: the page goes to another window of theirs', async () => {
    fake.perm = false
    fake.lastFocused = 3
    fake.others = [{ id: 20, windowId: 5, active: true }]
    await openGrant({ args: { person: true } })
    expect(fake.created[0]).toMatchObject({ windowId: 5 })
  })

  it('never in a private window', async () => {
    fake.perm = false
    fake.incognito.add(1)
    fake.others = [{ id: 20, windowId: 1, active: true }, { id: 21, windowId: 6, active: true }]
    await openGrant({ args: { person: true } })
    expect(fake.created[0]).toMatchObject({ windowId: 6 })
  })

  it('opens nothing when live pictures are on already, and reuses a page already open', async () => {
    expect(await openGrant({ args: { person: true } })).toMatchObject({ opened: false, already: true })
    expect(fake.created).toEqual([])
    // The permission held and the person turned live pictures off: their choice, never undone by this page.
    fake.local.livePictures = false
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: false, already: true, off: true })
    expect(fake.created).toEqual([])
    fake.local.livePictures = true
    fake.perm = false
    fake.others.push({ id: 31, windowId: 1, url: 'chrome-extension://walnut/grant.html' })
    expect(await openGrant({ args: { person: true } })).toMatchObject({ opened: true, reused: true })
    expect(fake.created).toEqual([])
    expect(fake.tabUpdates).toEqual([{ id: 31, o: { active: true } }])
  })

  it('no window of the person\'s: nothing opens, and it says why', async () => {
    fake.perm = false
    fake.others = []
    fake.lastFocused = 3
    expect(await openGrant({ args: { person: true } })).toMatchObject({ opened: false, why: 'no_window' })
    expect(fake.created).toEqual([])
  })
})

describe('view_grant: an agent cannot keep putting the page back after the person closed it (review 2026-11-09)', () => {
  const close = (tabId: number) => { for (const f of fake.removed) f(tabId) }
  const state = () => fake.local[GRANT_STATE_KEY] as { tab?: number; closedAt?: number } | undefined

  it('closed without allowing: an agent\'s ask opens nothing for GRANT_COOL_MS; the person\'s own click still opens it', async () => {
    watchGrantClose()
    fake.perm = false
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: true, shown: false })
    expect(state()?.tab).toBe(90)
    close(90)
    await vi.waitFor(() => expect(state()?.closedAt).toBeTypeOf('number'))
    const again = await openGrant({ args: { tab: 7 } })
    expect(again).toMatchObject({ opened: false, why: 'closed_recently' })
    expect(again.retry_after_ms as number).toBeGreaterThan(GRANT_COOL_MS - 5000)
    expect(fake.created).toHaveLength(1)
    // The person's click is never held back.
    expect(await openGrant({ args: { tab: 7, person: true } })).toMatchObject({ opened: true, shown: true })
    expect(fake.created).toHaveLength(2)
  })

  it('a close the background did not see (it slept) counts too: the page it opened is gone, so no new one', async () => {
    fake.perm = false
    await openGrant({ args: { tab: 7 } })
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: false, why: 'closed_recently' })
    expect(fake.created).toHaveLength(1)
  })

  it('after the cooldown an agent may ask again; allowed meanwhile, nothing opens at all', async () => {
    fake.perm = false
    fake.local[GRANT_STATE_KEY] = { closedAt: Date.now() - GRANT_COOL_MS - 1 }
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: true })
    fake.perm = true
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: false, already: true })
  })

  it('a page still open is reused for an agent, never a second one', async () => {
    fake.perm = false
    fake.local[GRANT_STATE_KEY] = { tab: 31, openedAt: Date.now() }
    fake.others.push({ id: 31, windowId: 1, url: 'chrome-extension://walnut/grant.html' })
    expect(await openGrant({ args: { tab: 7 } })).toMatchObject({ opened: true, reused: true, shown: false })
    expect(fake.created).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })
})

// The Browser replay (agent-replay.ts, 2026-11-14): a step's picture in a covered agent window
// comes the screenshot's way, through the debugger, with nothing switched or raised.
describe('a replay step\'s picture of a covered window', () => {
  it('comes through Page.captureScreenshot, posted with the token; the hold goes after', async () => {
    const { replayStep } = await import('../../../packages/browser-extension/src/agent-replay')
    fake.captureError = COVERED
    const posts: Array<Record<string, unknown>> = []
    await replayStep('tok', 7, { ok: true, result: { clicked: 'button "Pay"' } }, allow.walnut, async (b) => { posts.push(b) })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ token: 'tok', tab: 7, said: 'button "Pay"', image: 'data:image/jpeg;base64,LIVE' })
    expect(fake.sent.filter((s) => s.m === 'Page.captureScreenshot')).toHaveLength(1)
    expect(holdersOf(7)).not.toContain('shot')
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('live pictures off: no attach, the step goes with no picture', async () => {
    const { replayStep } = await import('../../../packages/browser-extension/src/agent-replay')
    fake.captureError = COVERED
    fake.local.livePictures = false
    const posts: Array<Record<string, unknown>> = []
    await replayStep('tok', 7, { ok: true }, allow.walnut, async (b) => { posts.push(b) })
    expect(fake.attaches).toEqual([])
    expect(posts[0].image).toBeUndefined()
  })
})
