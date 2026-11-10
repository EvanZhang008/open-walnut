/**
 * The agent's state outlives an extension reload (packages/browser-extension/src/agent-keep.ts).
 * 2026-11-10, in the user's Chrome: a self-update reload cleared storage.session while Chrome kept
 * every window and tab, so the next open made a second agent window, the agent's tab read as the
 * person's, and nothing tidied it. A fake browser here keeps its windows, tabs and groups across a
 * "reload" (storage.session emptied, the module started again) the way Chrome does.
 *
 *   - after a reload (self-update's stamp, or Chrome's onInstalled `update`), the agent window,
 *     its page, every holding (grants included), agentMade and the groups come back: the next open
 *     uses the same window, the leftover is tidied LEFT_MS after no agent holds it;
 *   - a kept id is dropped when it no longer names the same thing (gone, another window, another
 *     site, a handed tab now on another site);
 *   - a browser start (onStartup, or no word from Chrome at all) trusts no kept id;
 *   - a wake of the background (storage.session intact) changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Tab = { id: number; windowId: number; url: string; groupId?: number; active?: boolean }
type Listener = (...a: any[]) => void
const listeners = { installed: [] as Listener[], startup: [] as Listener[], changed: [] as Listener[], attached: [] as Listener[] }
const b = {
  session: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  windows: new Map<number, { id: number; type: string; focused: boolean }>(),
  tabs: new Map<number, Tab>(),
  groups: new Map<number, { id: number; windowId: number }>(),
  createdWindows: 0,
  removed: [] as number[],
  nextId: 500,
}
const PAGE = 'chrome-extension://walnut/agent-window.html'
const area = (name: 'session' | 'local') => ({
  get: async (k: string | string[] | null) => {
    const all = b[name]
    const keys = k === null ? Object.keys(all) : Array.isArray(k) ? k : [k]
    return Object.fromEntries(keys.filter((x) => all[x] !== undefined).map((x) => [x, structuredClone(all[x])]))
  },
  set: async (o: Record<string, unknown>) => {
    const changes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) { b[name][k] = structuredClone(v); changes[k] = { newValue: v } }
    for (const f of listeners.changed) f(changes, name)
  },
  remove: async (k: string | string[]) => {
    const changes: Record<string, unknown> = {}
    for (const x of Array.isArray(k) ? k : [k]) { delete b[name][x]; changes[x] = {} }
    for (const f of listeners.changed) f(changes, name)
  },
})
const ev = (list: Listener[]) => ({ addListener: (f: Listener) => list.push(f), removeListener() {} })
const noop = () => ({ addListener() {}, removeListener() {} })
const fake = {
  runtime: { id: 'walnut', getURL: (p: string) => `chrome-extension://walnut/${p}`, onInstalled: ev(listeners.installed), onStartup: ev(listeners.startup), onMessage: noop() },
  storage: { session: area('session'), local: area('local'), onChanged: ev(listeners.changed) },
  windows: {
    get: async (id: number) => { const w = b.windows.get(id); if (!w) throw new Error('No window'); return { ...w } },
    create: async (o: { url: string }) => {
      b.createdWindows++
      const id = b.nextId++
      b.windows.set(id, { id, type: 'normal', focused: false })
      const t = { id: b.nextId++, windowId: id, url: o.url }
      b.tabs.set(t.id, t)
      return { id, tabs: [{ ...t }] }
    },
    onRemoved: noop(),
  },
  tabs: {
    get: async (id: number) => { const t = b.tabs.get(id); if (!t) throw new Error('No tab'); return { ...t } },
    create: async (o: { url: string; windowId: number }) => { const t = { id: b.nextId++, windowId: o.windowId, url: o.url }; b.tabs.set(t.id, t); return { ...t } },
    update: async (id: number, o: { url?: string; active?: boolean }) => { const t = b.tabs.get(id)!; if (o.url) t.url = o.url; return { ...t } },
    query: async () => [...b.tabs.values()].map((t) => ({ ...t })),
    remove: async (id: number) => { b.removed.push(id); b.tabs.delete(id) },
    ungroup: async (id: number) => { b.tabs.get(id)!.groupId = -1 },
    onAttached: ev(listeners.attached), onRemoved: noop(), onUpdated: noop(),
  },
  tabGroups: { get: async (id: number) => { const g = b.groups.get(id); if (!g) throw new Error('No group'); return { ...g } } },
}
;(globalThis as any).chrome = fake

const keep = await import('../../../packages/browser-extension/src/agent-keep')
const { openInAgentWindow } = await import('../../../packages/browser-extension/src/agent-window')
const { tidyLeftovers, LEFT_MS } = await import('../../../packages/browser-extension/src/agent-tidy')
const { agentTabs } = await import('../../../packages/browser-extension/src/agent-shared')
const { KEPT_KEYS } = await import('../../../packages/browser-extension/src/session-keys')
const api = fake as unknown as Parameters<typeof keep.startKeep>[0]

/** The browser as it is mid-work: the agent window (3) with its page (30) and a task's tab (31), the person's window (1) with a tab they handed over (11). */
function working(): void {
  b.windows.set(3, { id: 3, type: 'normal', focused: false })
  b.windows.set(1, { id: 1, type: 'normal', focused: true })
  b.tabs.set(30, { id: 30, windowId: 3, url: PAGE })
  b.tabs.set(31, { id: 31, windowId: 3, url: 'https://github.com/login', groupId: 70 })
  b.tabs.set(11, { id: 11, windowId: 1, url: 'https://mail.example.com/inbox', groupId: 71 })
  b.groups.set(70, { id: 70, windowId: 3 })
  b.groups.set(71, { id: 71, windowId: 1 })
  b.session = {
    agentAlive: 1,
    agentWindow: 3,
    agentPage: 30,
    agentTabs: {
      31: { owner: 'task:a', who: 'Sign in', history: ['https://github.com/login'], grant: 'g1' },
      11: { owner: 'task:b', handed: 'example.com', history: ['https://mail.example.com/inbox'], grant: 'g2', grouped: 'g2' },
    },
    agentMade: { 31: 0 },
    agentGroups: { 'task:a': 70 },
    agentPersonGroups: { 'task:b\u00001': 71 },
    agentFilled: { 123: ['https://github.com'] },
    agentTampered: { 31: { owner: 'task:a', doc: 'd1', at: 1 } },
    agentDownloads: { 9: { owner: 'task:a', tab: 31, at: 1 } },
    debuggerCancelledAt: 5,
  }
}

/** Chrome reloads the extension: storage.session is emptied, windows and tabs stay, the background starts again. */
function reload(): void {
  b.session = {}
  keep._resetKeepForTesting()
  for (const k of Object.keys(listeners) as Array<keyof typeof listeners>) listeners[k].length = 0
}

beforeEach(() => {
  b.session = {}; b.local = {}; b.windows = new Map(); b.tabs = new Map(); b.groups = new Map(); b.createdWindows = 0; b.removed = []; b.nextId = 500
  reload()
})
afterEach(() => { vi.useRealTimers(); keep._resetKeepForTesting() })

describe('after a self-update reload the agent keeps what it had', () => {
  it('the window, its page, every holding (same grants), agentMade and the groups come back', async () => {
    working()
    const before = structuredClone(b.session)
    await keep.keepForReload(api)
    reload()
    await keep.startKeep(api)
    // Every kept key is in the fixture, so a new one fails here until its rule puts it back.
    for (const k of KEPT_KEYS) { expect(before[k], k).toBeDefined(); expect(b.session[k], k).toEqual(before[k]) }
  })

  it('the next open uses the same agent window: no second window', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    await keep.startKeep(api)
    const tab = await openInAgentWindow(api as never, 'https://example.org/')
    expect(b.createdWindows).toBe(0)
    expect(tab.windowId).toBe(3)
  })

  it('the restored holding reads as the task\'s, and a leftover is tidied LEFT_MS after no agent holds it', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    await keep.startKeep(api)
    expect((await agentTabs.get(31))?.owner).toBe('task:a')
    expect((await agentTabs.get(11))?.grant).toBe('g2')
    // The task lets its tab go (its holding ends): it is still the agent's own, so it is tidied.
    await agentTabs.delete(31)
    const t0 = Date.now()
    expect(await tidyLeftovers(t0)).toEqual([])
    expect(await tidyLeftovers(t0 + LEFT_MS + 1)).toEqual([31])
    expect(b.removed).toEqual([31])
  })

  it('Chrome\'s onInstalled `update` (a reload with no stamp) puts it back too, once no browser start follows', async () => {
    working()
    await keep.keepForReload(api)
    delete (b.local[keep.KEPT] as { reloading?: number }).reloading
    reload()
    vi.useFakeTimers()
    const ready = keep.startKeep(api)
    for (const f of listeners.installed) f({ reason: 'update' })
    await vi.advanceTimersByTimeAsync(keep.EVENT_WAIT_MS + 10)
    await ready
    expect(b.session.agentWindow).toBe(3)
    expect(Object.keys(b.session.agentTabs as object).sort()).toEqual(['11', '31'])
  })

  it('the stamp counts once: the mirror written after the restore carries none', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    await keep.startKeep(api)
    await new Promise((r) => setTimeout(r, keep.MIRROR_MS + 100))
    expect((b.local[keep.KEPT] as { reloading?: number }).reloading).toBeUndefined()
    expect((b.local[keep.KEPT] as { values: Record<string, unknown> }).values.agentWindow).toBe(3)
  })

  it('a stamp asked for while the start still decides waits for it: the kept state is never written over empty', async () => {
    working()
    await keep.keepForReload(api)
    delete (b.local[keep.KEPT] as { reloading?: number }).reloading
    reload()
    vi.useFakeTimers()
    const ready = keep.startKeep(api)
    for (const f of listeners.installed) f({ reason: 'update' })
    const stamping = keep.keepForReload(api)
    await vi.advanceTimersByTimeAsync(keep.EVENT_WAIT_MS + 10)
    await ready
    await stamping
    const kept = b.local[keep.KEPT] as { reloading?: number; values: Record<string, unknown> }
    expect(kept.values.agentWindow).toBe(3)
    expect(typeof kept.reloading).toBe('number')
  })

  it('a change is mirrored into storage.local soon after, so a reload Chrome makes by itself keeps it too', async () => {
    working()
    await keep.startKeep(api)
    await agentTabs.set(31, { owner: 'task:c', grant: 'g9' })
    await new Promise((r) => setTimeout(r, keep.MIRROR_MS + 100))
    const kept = b.local[keep.KEPT] as { values: Record<string, Record<string, { owner: string }>>; tabs: Record<string, { windowId: number }> }
    expect(kept.values.agentTabs['31'].owner).toBe('task:c')
    expect(kept.tabs['31']).toEqual({ windowId: 3, origin: 'https://github.com' })
  })

  it('no address goes to disk: only origins, never a holding\'s address list', async () => {
    working()
    b.tabs.get(31)!.url = 'https://github.com/login/oauth?code=SECRET'
    ;(b.session.agentTabs as Record<string, { history: string[] }>)['31'].history = ['https://github.com/login/oauth?code=SECRET']
    await keep.keepForReload(api)
    expect(JSON.stringify(b.local)).not.toContain('SECRET')
    reload()
    await keep.startKeep(api)
    // It comes back as the tab's address now (in storage.session, memory only).
    expect((b.session.agentTabs as Record<string, { history: string[] }>)['31'].history).toEqual(['https://github.com/login/oauth?code=SECRET'])
  })

  it('a steady stream of changes is still mirrored within MIRROR_MAX_MS', async () => {
    working()
    await keep.startKeep(api)
    await new Promise((r) => setTimeout(r, keep.MIRROR_MS + 100))
    vi.useFakeTimers()
    const t0 = Date.now()
    let n = 0
    while (Date.now() - t0 < keep.MIRROR_MAX_MS + 500) {
      await agentTabs.set(31, { owner: `task:${n++}`, grant: 'g' })
      await vi.advanceTimersByTimeAsync(100)
    }
    const owner = (b.local[keep.KEPT] as { values: Record<string, Record<string, { owner: string }>> }).values.agentTabs['31'].owner
    expect(owner).not.toBe('task:a')
  })
})

describe('a kept id comes back only while it names the same thing', () => {
  it('a closed tab, a tab now in another window or on another site, and a handed tab on another site are dropped', async () => {
    working()
    b.tabs.set(32, { id: 32, windowId: 3, url: 'https://docs.example.org/a' })
    b.tabs.set(33, { id: 33, windowId: 3, url: 'https://shop.example.net/' })
    ;(b.session.agentTabs as Record<string, unknown>)[32] = { owner: 'task:a', grant: 'g3' }
    ;(b.session.agentTabs as Record<string, unknown>)[33] = { owner: 'task:a', grant: 'g4' }
    await keep.keepForReload(api)
    reload()
    b.tabs.delete(31) // closed
    b.tabs.get(32)!.windowId = 1 // dragged to the person's window
    b.tabs.get(33)!.url = 'https://evil.example.com/' // another site now
    b.tabs.get(11)!.url = 'https://bank.example.org/' // the handed tab left the site the person allowed
    await keep.startKeep(api)
    expect(b.session.agentTabs).toBeUndefined()
    expect(b.session.agentMade).toBeUndefined()
    expect(b.session.agentTampered).toBeUndefined()
    expect(b.session.agentWindow).toBe(3)
  })

  it('a handed tab on another page of the same origin keeps its holding', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    b.tabs.get(11)!.url = 'https://mail.example.com/thread/7'
    await keep.startKeep(api)
    expect(Object.keys(b.session.agentTabs as object)).toContain('11')
  })

  it('a closed agent window is dropped with its page and groups: the next open makes a new one', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    b.windows.delete(3); b.tabs.delete(30); b.tabs.delete(31); b.groups.delete(70)
    await keep.startKeep(api)
    expect(b.session.agentWindow).toBeUndefined()
    expect(b.session.agentPage).toBeUndefined()
    expect(b.session.agentGroups).toBeUndefined()
    await openInAgentWindow(api as never, 'https://example.org/')
    expect(b.createdWindows).toBe(1)
  })

  it('a group that is gone, or now in another window, is dropped', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    b.groups.delete(70)
    b.groups.get(71)!.windowId = 9
    await keep.startKeep(api)
    expect(b.session.agentGroups).toBeUndefined()
    expect(b.session.agentPersonGroups).toBeUndefined()
  })

  it('what was written since the reload wins over the kept value', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    b.session.agentTabs = { 31: { owner: 'task:new', grant: 'g7' } }
    await keep.startKeep(api)
    expect((b.session.agentTabs as Record<string, { owner: string }>)['31'].owner).toBe('task:new')
    expect((b.session.agentTabs as Record<string, { owner: string }>)['11'].owner).toBe('task:b')
  })
})

describe('a browser start trusts no kept id', () => {
  it('onStartup: nothing comes back, and the mirror is dropped', async () => {
    working()
    await keep.keepForReload(api)
    delete (b.local[keep.KEPT] as { reloading?: number }).reloading
    reload()
    const ready = keep.startKeep(api)
    for (const f of listeners.startup) f()
    await ready
    for (const k of KEPT_KEYS) expect(b.session[k], k).toBeUndefined()
  })

  it('onInstalled `update` and then onStartup (a folder updated while the browser was closed): nothing comes back', async () => {
    working()
    await keep.keepForReload(api)
    delete (b.local[keep.KEPT] as { reloading?: number }).reloading
    reload()
    vi.useFakeTimers()
    const ready = keep.startKeep(api)
    for (const f of listeners.installed) f({ reason: 'update' })
    await vi.advanceTimersByTimeAsync(500)
    for (const f of listeners.startup) f()
    await vi.advanceTimersByTimeAsync(keep.EVENT_WAIT_MS)
    await ready
    for (const k of KEPT_KEYS) expect(b.session[k], k).toBeUndefined()
  })

  it('a stamp, then a browser start (a crash right after it): what came back goes again, what was written since stays', async () => {
    working()
    await keep.keepForReload(api)
    reload()
    await keep.startKeep(api)
    expect(b.session.agentWindow).toBe(3)
    b.windows.set(600, { id: 600, type: 'normal', focused: false })
    await fake.storage.session.set({ agentWindow: 600 })
    for (const f of listeners.startup) f()
    await new Promise((r) => setTimeout(r, 10))
    expect(b.session.agentWindow).toBe(600)
    for (const k of KEPT_KEYS.filter((x) => x !== 'agentWindow')) expect(b.session[k], k).toBeUndefined()
  })

  it('no stamp and no word from Chrome within EVENT_WAIT_MS: nothing comes back', async () => {
    working()
    await keep.keepForReload(api)
    ;(b.local[keep.KEPT] as { reloading?: number }).reloading = Date.now() - keep.RELOAD_FRESH_MS - 1
    reload()
    vi.useFakeTimers()
    const ready = keep.startKeep(api)
    await vi.advanceTimersByTimeAsync(keep.EVENT_WAIT_MS + 10)
    await ready
    vi.useRealTimers()
    expect(b.session.agentWindow).toBeUndefined()
    expect(b.session.agentTabs).toBeUndefined()
  })
})

describe('a wake of the background changes nothing', () => {
  it('storage.session intact (its mark there): nothing is written over it', async () => {
    working()
    await keep.keepForReload(api)
    keep._resetKeepForTesting()
    b.session.agentWindow = 4
    b.windows.set(4, { id: 4, type: 'normal', focused: false })
    await keep.startKeep(api)
    expect(b.session.agentWindow).toBe(4)
  })
})
