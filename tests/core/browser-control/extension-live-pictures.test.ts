/**
 * Live pictures of a covered agent window (packages/browser-extension/src/agent-live.ts), the
 * shared debugger session (cdp.ts acquireDebugger), the real-input switch kept apart from the
 * debugger permission (trusted-switch.ts) and the grant page opener (grant-open.ts), against a fake
 * Chrome. 2026-11-09: with Walnut's agent window entirely under other windows, Chrome draws nothing
 * there and captureVisibleTab fails "image readback failed"; Page.captureScreenshot draws the page
 * off screen, and the user approved using it while the Browser view is watched.
 */
import { beforeEach, describe, expect, it } from 'vitest'

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
}
const tab = (id = 7) => ({ id, windowId: 3, active: true, url: 'https://shop.example.test/', title: 'Shop' })
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
    onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => tab(id),
    query: async (q: Record<string, unknown>) => {
      if (q.url) return fake.others.filter((t) => t.url === q.url)
      if (q.lastFocusedWindow) return fake.others.filter((t) => t.windowId === fake.lastFocused && t.active)
      if (q.windowId === 3) return [tab(7)]
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
const { liveHeld, LIVE_GAP_MS, _resetLiveForTesting } = await import('../../../packages/browser-extension/src/agent-live')
const { acquireDebugger, releaseDebugger, holdDebugger, holdersOf, withDebugger, debuggerHeld, _resetDebuggerForTesting } = await import('../../../packages/browser-extension/src/cdp')
const { migrateRealInput, realInputOn, livePicturesOn, setTrustedInput, setLivePictures, trustedInputState } = await import('../../../packages/browser-extension/src/trusted-switch')
const { trustedReady } = await import('../../../packages/browser-extension/src/agent-trusted')
const { openGrant } = await import('../../../packages/browser-extension/src/grant-open')
const { shooter } = await import('../../../packages/browser-extension/src/agent-shot')
const { foldDialogEvent, _resetDialogsForTesting } = await import('../../../packages/browser-extension/src/agent-dialog')
const { endShot } = await import('../../../packages/browser-extension/src/agent-live')

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

  it('goes back to captureVisibleTab and lets the debugger go as soon as the window shows again', async () => {
    _resetLiveForTesting(0)
    fake.captureError = COVERED
    const posts = await watch(4, (_b, i) => { if (i === 2) fake.captureError = '' })
    expect(posts.every((p) => p.shown === true)).toBe(true)
    expect(posts.at(-1)).toMatchObject({ shown: true })
    // Detached once the window drew again, while the stream still ran (no bar for a visible window).
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
    expect(fake.sent.filter((s) => s.m === 'Page.captureScreenshot')).toHaveLength(2)
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
    _resetLiveForTesting(3000, 200)
    fake.captureError = COVERED
    fake.hang = true
    const posts = await watch(3)
    expect(posts.map((p) => p.live)).toEqual(['failed', 'failed', 'failed'])
    // One attach and its detach: the backoff keeps the bar from flashing every frame.
    expect(fake.attaches).toEqual([7])
    expect(fake.detaches).toEqual([7])
  })

  it('a dialog open on the page: no live picture is tried (it may never come)', async () => {
    fake.captureError = COVERED
    foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' })
    const posts = await watch(2)
    expect(posts[0]).toMatchObject({ shown: false, why: 'covered', live: 'failed' })
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

  it('minimized meanwhile: the stream lets the debugger go', async () => {
    fake.captureError = COVERED
    let gone = -1
    const posts = await watch(3, (_b, i) => { if (i === 1) fake.windowState = 'minimized'; if (i === 2) gone = fake.detaches.length })
    expect(posts[1]).toMatchObject({ why: 'minimized' })
    expect(gone).toBe(1)
  })

  it('a single frame (an older Walnut, view_frame) never attaches', async () => {
    fake.captureError = COVERED
    expect(await viewFrame(cmd('view_frame'), () => false)).toMatchObject({ shown: false, why: 'covered' })
    expect(fake.attaches).toEqual([])
  })
})

describe('an agent\'s screenshot of a covered window', () => {
  it('comes through the debugger while live pictures are on, held for the screenshot and let go after', async () => {
    fake.captureError = COVERED
    const shoot = shooter(7, 3, true)
    expect(await shoot({ format: 'png' })).toBe('data:image/png;base64,LIVE')
    expect(await shoot({ format: 'jpeg', quality: 70 })).toBe('data:image/jpeg;base64,LIVE')
    // One attach for both pictures (a full page takes several).
    expect(fake.attaches).toEqual([7])
    expect(fake.sent.map((x) => x.p)).toEqual([
      { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false },
      { format: 'jpeg', quality: 70, optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false },
    ])
    await endShot(7)
    expect(fake.detaches).toEqual([7])
  })

  it('leaves the stream\'s session attached, and without the permission says covered as before', async () => {
    fake.captureError = COVERED
    await acquireDebugger(dbg, 7, 'picture')
    await shooter(7, 3, true)({ format: 'png' })
    await endShot(7)
    expect(fake.detaches).toEqual([])
    await releaseDebugger(dbg, 7, 'picture')
    fake.perm = false
    await expect(shooter(7, 3, true)({ format: 'png' })).rejects.toMatchObject({ code: 'window_covered' })
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

describe('real input apart from the debugger permission', () => {
  it('migrates once: a never-stored switch becomes whether the permission is held now', async () => {
    fake.local = {}
    fake.perm = true
    expect(await migrateRealInput()).toBe(true)
    expect(fake.local.realInput).toBe(true)
    fake.local = {}
    fake.perm = false
    expect(await migrateRealInput()).toBe(false)
    expect(fake.local.realInput).toBe(false)
    // Stored: a grant later (for live pictures) does not turn real input on.
    fake.perm = true
    expect(await migrateRealInput()).toBe(false)
    expect(await realInputOn()).toBe(false)
    expect(await trustedReady()).toBe(false)
    expect(await livePicturesOn()).toBe(true)
  })

  it('real input needs both the permission and the switch', async () => {
    fake.local = { realInput: true }
    fake.perm = false
    expect(await trustedReady()).toBe(false)
    fake.perm = true
    expect(await trustedReady()).toBe(true)
  })

  it('turning real input off keeps the permission while live pictures are on, and removes it when they are off too', async () => {
    fake.local = { realInput: true }
    expect(await setTrustedInput(false)).toBe(false)
    expect(fake.local.realInput).toBe(false)
    expect(fake.removes).toBe(0)
    expect(fake.perm).toBe(true)
    expect(await trustedInputState()).toMatchObject({ on: false, livePictures: true, permission: true })
    expect(await setLivePictures(false, true)).toBe(false)
    expect(fake.removes).toBe(1)
    expect(await trustedInputState()).toMatchObject({ on: false, livePictures: false, permission: false })
  })

  it('turning real input on asks Chrome in the click and stores the switch; a no puts it back', async () => {
    fake.local = { realInput: false }
    fake.perm = false
    fake.grantAnswer = false
    expect(await setTrustedInput(true)).toBe(false)
    expect(fake.local.realInput).toBe(false)
    fake.grantAnswer = true
    expect(await setTrustedInput(true)).toBe(true)
    expect(fake.local.realInput).toBe(true)
    expect(fake.requests).toBe(2)
  })

  it('a grant made for live pictures alone stores real input off', async () => {
    fake.local = { realInput: true }
    fake.perm = false
    expect(await setLivePictures(true, false)).toBe(true)
    expect(fake.local).toMatchObject({ livePictures: true, realInput: false })
    expect(await trustedReady()).toBe(false)
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
