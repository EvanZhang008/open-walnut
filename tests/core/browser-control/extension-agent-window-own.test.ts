/**
 * The agent window stops being Walnut's the moment the person uses it (agent-window-own.ts).
 * 2026-11-17, the user's Chrome: the agent window had become his main window (26 tabs of his own,
 * his New Tabs and links in it), and every agent step put an agent's tab or the "Walnut agent
 * window" page in front of it while he was in another app, so it kept jumping in front of him.
 * Here: what counts as his tab, the window given up once (Walnut's page closed, the agents' tabs
 * moved to a new window behind his, his own tabs untouched), and that no front tab of his window
 * changes afterwards (frontInWindow, the fold, a new open).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetOwnForTesting, isPersonsTab, noteAgentTabMaking, ownAgentWindow, setScreenSharing } from '../../../packages/browser-extension/src/agent-window-own'
import { frontInWindow, noteScreenShare, openInAgentWindow, revealForPerson } from '../../../packages/browser-extension/src/agent-window'
import { _resetGroupsForTesting, foldIdleGroup } from '../../../packages/browser-extension/src/agent-groups'

type T = { id: number; windowId: number; url?: string; active?: boolean; openerTabId?: number; groupId?: number }
const PAGE = 'chrome-extension://walnut/agent-window.html'

function browser() {
  const tabs = new Map<number, T>()
  const windows = new Map<number, { id: number; focused: boolean; state: string; type: string }>()
  const session: Record<string, unknown> = {}
  const calls: Array<{ fn: string; arg: unknown }> = []
  const groups = new Map<number, { id: number; windowId: number; collapsed?: boolean }>()
  let next = 1000
  const api = {
    runtime: { getURL: (p: string) => `chrome-extension://walnut/${p}` },
    storage: {
      session: {
        get: async (k: string | string[]) => Object.fromEntries([k].flat().filter((x) => session[x] !== undefined).map((x) => [x, structuredClone(session[x])])),
        set: async (o: Record<string, unknown>) => { Object.assign(session, structuredClone(o)) },
        remove: async (k: string | string[]) => { for (const x of [k].flat()) delete session[x] },
      },
    },
    windows: {
      get: async (id: number) => { const w = windows.get(id); if (!w) throw new Error('No window'); return { ...w } },
      create: async (o: Record<string, unknown>) => {
        calls.push({ fn: 'windows.create', arg: o })
        const id = next++
        windows.set(id, { id, focused: o.focused === true, state: typeof o.state === 'string' ? o.state : 'normal', type: 'normal' })
        const t = { id: next++, windowId: id, url: String(o.url), active: true }
        tabs.set(t.id, t)
        return { id, state: windows.get(id)!.state, tabs: [{ ...t }] }
      },
      update: async (id: number, o: Record<string, unknown>) => { calls.push({ fn: 'windows.update', arg: { id, o } }); if (typeof o.state === 'string') windows.get(id)!.state = o.state; return { ...windows.get(id)! } },
      getCurrent: async () => ({}),
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabs: {
      get: async (id: number) => { const t = tabs.get(id); if (!t) throw new Error('No tab'); return { ...t } },
      query: async (q: { windowId?: number; active?: boolean }) => [...tabs.values()].filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || !!t.active === q.active)).map((t) => ({ ...t })),
      create: async (o: { url: string; windowId: number; active?: boolean; index?: number }) => {
        calls.push({ fn: 'tabs.create', arg: o })
        const t = { id: next++, windowId: o.windowId, url: o.url, active: false }
        tabs.set(t.id, t)
        return { ...t }
      },
      update: async (id: number, o: { active?: boolean; url?: string; muted?: boolean }) => {
        calls.push({ fn: 'tabs.update', arg: { id, o } })
        const t = tabs.get(id)!
        if (o.url) t.url = o.url
        if (o.active) for (const x of tabs.values()) if (x.windowId === t.windowId) x.active = x.id === id
        return { ...t }
      },
      remove: async (id: number) => { calls.push({ fn: 'tabs.remove', arg: id }); tabs.delete(id) },
      move: async (ids: number | number[], o: { windowId: number; index: number }) => {
        calls.push({ fn: 'tabs.move', arg: { ids, o } })
        for (const id of [ids].flat()) { const t = tabs.get(id)!; t.windowId = o.windowId; t.active = false; t.groupId = -1 }
      },
    },
    tabGroups: {
      get: async (id: number) => { const g = groups.get(id); if (!g) throw new Error('No group'); return { ...g } },
      update: async (id: number, o: { collapsed?: boolean }) => { calls.push({ fn: 'tabGroups.update', arg: { id, o } }); Object.assign(groups.get(id)!, o) },
    },
  }
  const add = (t: T) => { tabs.set(t.id, { ...t }) }
  const switches = () => calls.filter((c) => c.fn === 'tabs.update' && (c.arg as { o: { active?: boolean } }).o.active === true)
  return { api, tabs, windows, session, calls, groups, add, switches }
}

/** Walnut's agent window 3 as it is made: its page (tab 30), two agents' tabs (31 held, 32 made). */
function agentWindow(b: ReturnType<typeof browser>) {
  b.windows.set(3, { id: 3, focused: false, state: 'normal', type: 'normal' })
  b.add({ id: 30, windowId: 3, url: PAGE, active: true })
  b.add({ id: 31, windowId: 3, url: 'https://shop.example.test/cart' })
  b.add({ id: 32, windowId: 3, url: 'https://mail.example.test/' })
  Object.assign(b.session, { agentWindow: 3, agentPage: 30, agentTabs: { 31: { owner: 'task:a', who: 'Order paper' } }, agentMade: { 31: 0, 32: 0 } })
}

/** The user's own window 1, and his tab 11 he handed over (Act in tab) in it. */
function personWindow(b: ReturnType<typeof browser>) {
  b.windows.set(1, { id: 1, focused: false, state: 'normal', type: 'normal' })
  b.add({ id: 10, windowId: 1, url: 'https://calendar.example.test/', active: true })
}

beforeEach(() => { _resetOwnForTesting(); _resetGroupsForTesting(); setScreenSharing(false) })

describe('what counts as the person\'s tab in the agent window', () => {
  const own = { ids: new Set([31, 32]), persons: new Set([11]), page: 30, pageUrl: PAGE }
  it('a web page no agent made, holds or opened is theirs', () => {
    expect(isPersonsTab({ id: 40, windowId: 3, url: 'https://news.example.test/' }, own)).toBe(true)
    expect(isPersonsTab({ id: 41, windowId: 3, url: 'file:///Users/someone/notes.html' }, own)).toBe(true)
  })
  it('a tab the person handed over is theirs, wherever it is', () => {
    expect(isPersonsTab({ id: 11, windowId: 3, url: 'https://bank.example.test/' }, own)).toBe(true)
  })
  it('an agent\'s tab, a tab an agent\'s page opened, the agent page, blank and New Tab are not', () => {
    expect(isPersonsTab({ id: 31, windowId: 3, url: 'https://shop.example.test/' }, own)).toBe(false)
    expect(isPersonsTab({ id: 42, windowId: 3, url: 'https://shop.example.test/receipt', openerTabId: 31 } as never, own)).toBe(false)
    expect(isPersonsTab({ id: 30, windowId: 3, url: PAGE }, own)).toBe(false)
    expect(isPersonsTab({ id: 43, windowId: 3, url: `${PAGE}?again` }, own)).toBe(false)
    expect(isPersonsTab({ id: 44, windowId: 3, url: 'about:blank' }, own)).toBe(false)
    expect(isPersonsTab({ id: 45, windowId: 3, url: 'chrome://newtab/' }, own)).toBe(false)
    // A New Tab the person typed an address into is a page of theirs.
    expect(isPersonsTab({ id: 45, windowId: 3, url: '', pendingUrl: 'https://docs.example.test/' } as never, own)).toBe(true)
  })
})

describe('the agent window is given up once the person uses it', () => {
  // Seen in the extension's Chromium spec: an agent's open shows its address before storage holds the tab.
  it('a tab an agent\'s open is still making is no sign, and neither is one given back in place (Stop)', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 33, windowId: 3, url: '', pendingUrl: 'https://shop.example.test/issues' } as never)
    noteAgentTabMaking(33)
    expect(await ownAgentWindow(b.api as never)).toBe(3)
    // The person's Stop: tab 31 is no agent's any more, but it was: still no sign.
    b.session.agentTabs = {}
    b.session.agentMade = { 32: 0 }
    expect(await ownAgentWindow(b.api as never)).toBe(3)
    expect(b.calls).toEqual([])
  })

  it('stays Walnut\'s while every tab in it is an agent\'s', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 33, windowId: 3, url: 'chrome://newtab/' })
    expect(await ownAgentWindow(b.api as never)).toBe(3)
    expect(b.calls).toEqual([])
  })

  it('the user\'s case: his tabs in it, the agent page in front: Walnut\'s page closes, the agents\' tabs move to a new window behind his, his tabs stay', async () => {
    const b = browser()
    agentWindow(b)
    // His own tabs, as Chrome put them there (New Tab, links from other apps); he is on one of them.
    for (let i = 0; i < 26; i++) b.add({ id: 100 + i, windowId: 3, url: `https://work.example.test/${i}` })
    for (const t of b.tabs.values()) t.active = t.id === 105
    // The answer is the new agent window, made for the tabs it moved.
    const newWindow = await ownAgentWindow(b.api as never)
    expect(newWindow).toBe(b.session.agentWindow)
    expect(newWindow).not.toBe(3)
    // Walnut's own page there is closed; nothing of his is closed.
    expect(b.calls.filter((c) => c.fn === 'tabs.remove')).toEqual([{ fn: 'tabs.remove', arg: 30 }])
    // A new agent window, made unfocused, takes the agents' tabs.
    const made = b.calls.find((c) => c.fn === 'windows.create')!
    expect(made.arg).toMatchObject({ focused: false, type: 'normal' })
    const newId = b.session.agentWindow as number
    expect(b.tabs.get(31)!.windowId).toBe(newId)
    expect(b.tabs.get(32)!.windowId).toBe(newId)
    for (let i = 0; i < 26; i++) expect(b.tabs.get(100 + i)!.windowId).toBe(3)
    expect(b.tabs.get(105)!.active).toBe(true)
    // No window was focused and no tab of his window put in front.
    expect(b.calls.some((c) => c.fn === 'windows.update')).toBe(false)
    expect(b.switches()).toEqual([])
    // The new window is Walnut's own.
    expect(await ownAgentWindow(b.api as never)).toBe(newId)
  })

  // Review: "the person is looking" by focus is the very check that failed; the front tab is never touched.
  for (const focused of [true, false]) {
    it(`the window's front tab stays as it is, an agent's or Walnut's page (window ${focused ? 'focused' : 'not focused'})`, async () => {
      const b = browser()
      agentWindow(b)
      b.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
      b.windows.get(3)!.focused = focused
      for (const t of b.tabs.values()) t.active = t.id === 31
      await ownAgentWindow(b.api as never)
      expect(b.tabs.get(31)!.windowId).toBe(3)
      expect(b.tabs.get(32)!.windowId).not.toBe(3)
      // Walnut's page there is not in front: it closes.
      expect(b.tabs.has(30)).toBe(false)
      const b2 = browser()
      agentWindow(b2)
      b2.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
      await ownAgentWindow(b2.api as never)
      // Walnut's page in front: it stays (closing it would switch the window to another tab).
      expect(b2.tabs.has(30)).toBe(true)
      expect(b2.switches()).toEqual([])
    })
  }

  it('a task\'s group moves whole; a tab that closed meanwhile holds no other back', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 33, windowId: 3, url: 'https://shop.example.test/a', groupId: 200 })
    b.tabs.get(31)!.groupId = 200
    ;(b.session.agentMade as Record<string, number>)[33] = 0
    ;(b.session.agentMade as Record<string, number>)[34] = 0
    b.add({ id: 34, windowId: 3, url: 'https://mail.example.test/b' })
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
    const moves: unknown[] = []
    ;(b.api as unknown as { tabGroups: Record<string, unknown> }).tabGroups.move = async (g: number, o: { windowId: number }) => { moves.push(['group', g]); for (const t of b.tabs.values()) if (t.groupId === g) t.windowId = o.windowId }
    const move = b.api.tabs.move
    b.api.tabs.move = async (ids: number | number[], o: { windowId: number; index: number }) => { if (ids === 34) throw new Error('No tab with id: 34'); return move(ids, o) }
    await ownAgentWindow(b.api as never)
    const now = b.session.agentWindow as number
    expect(moves).toEqual([['group', 200]])
    expect([b.tabs.get(31)!.windowId, b.tabs.get(33)!.windowId, b.tabs.get(32)!.windowId]).toEqual([now, now, now])
  })

  it('a tab opened by a tab an agent\'s page opened (not adopted yet) is no sign', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 40, windowId: 3, url: 'https://login.example.test/', openerTabId: 31 })
    b.add({ id: 41, windowId: 3, url: 'https://login.example.test/popup', openerTabId: 40 })
    expect(await ownAgentWindow(b.api as never)).toBe(3)
  })

  it('a handed-over tab of the person\'s is never moved', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 11, windowId: 3, url: 'https://bank.example.test/' })
    ;(b.session.agentTabs as Record<string, unknown>)[11] = { owner: 'task:a', handed: 'bank.example.test' }
    expect(await ownAgentWindow(b.api as never)).not.toBe(3)
    expect(b.tabs.get(11)!.windowId).toBe(3)
  })

  it('two readers at once give it up once: one new window', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
    const both = await Promise.all([ownAgentWindow(b.api as never), ownAgentWindow(b.api as never)])
    expect(both[0]).toBe(b.session.agentWindow)
    expect(both[1]).toBe(b.session.agentWindow)
    expect(b.calls.filter((c) => c.fn === 'windows.create')).toHaveLength(1)
  })

  it('with no agents\' tabs to move, no window is made until an agent opens one', async () => {
    const b = browser()
    agentWindow(b)
    b.session.agentTabs = {}
    b.session.agentMade = {}
    b.tabs.delete(31); b.tabs.delete(32)
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
    expect(await ownAgentWindow(b.api as never)).toBeUndefined()
    expect(b.calls.filter((c) => c.fn === 'windows.create')).toEqual([])
  })
})

describe('no agent step changes the front tab of a window the person uses', () => {
  it('frontInWindow: only in Walnut\'s own agent window, only while nobody is in it', async () => {
    const b = browser()
    agentWindow(b)
    personWindow(b)
    b.add({ id: 12, windowId: 1, url: 'https://shop.example.test/x' })
    // The person's window, never.
    expect(await frontInWindow(b.api as never, 1, 12)).toBe(false)
    // The agent window while the person is in it, never.
    b.windows.get(3)!.focused = true
    expect(await frontInWindow(b.api as never, 3, 31)).toBe(false)
    expect(b.switches()).toEqual([])
    // The agent window while nobody is in it: yes, and no window is focused.
    b.windows.get(3)!.focused = false
    expect(await frontInWindow(b.api as never, 3, 31)).toBe(true)
    expect(b.calls.some((c) => c.fn === 'windows.update')).toBe(false)
  })

  it('frontInWindow: never in the agent window once the person\'s tab is in it, focused or not', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/', active: false })
    expect(await frontInWindow(b.api as never, 3, 31)).toBe(false)
    expect(b.switches()).toEqual([])
  })

  it('the fold never puts the agent page in front of the person\'s window', async () => {
    const b = browser()
    agentWindow(b)
    b.groups.set(200, { id: 200, windowId: 3 })
    b.session.agentGroups = { 'task:a': 200 }
    b.tabs.get(31)!.groupId = 200
    for (const t of b.tabs.values()) t.active = t.id === 31
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/' })
    expect(await foldIdleGroup(b.api as never, 'task:a', Date.now() + 60_000)).toBe(false)
    expect(b.switches()).toEqual([])
  })

  it('a new open in an agent window the person took: a new window behind theirs, nothing of theirs switched', async () => {
    const b = browser()
    agentWindow(b)
    b.add({ id: 100, windowId: 3, url: 'https://work.example.test/', active: true })
    for (const t of b.tabs.values()) t.active = t.id === 100
    const tab = await openInAgentWindow(b.api as never, 'https://shop.example.test/new')
    expect(tab.windowId).not.toBe(3)
    // Review: the window the release made for the moved tabs is the one the open uses: one window, not two.
    expect(b.calls.filter((c) => c.fn === 'windows.create')).toHaveLength(1)
    expect(tab.windowId).toBe(b.tabs.get(31)!.windowId)
    expect(b.tabs.get(100)!.active).toBe(true)
    for (const s of b.switches()) expect(b.tabs.get((s.arg as { id: number }).id)!.windowId).not.toBe(3)
    expect(b.calls.filter((c) => c.fn === 'windows.create').every((c) => (c.arg as { focused?: boolean }).focused === false)).toBe(true)
  })
})

describe('the person\'s own click', () => {
  it('revealForPerson puts the tab in front and focuses its window', async () => {
    const b = browser()
    agentWindow(b)
    await revealForPerson(b.api as never, 31, 'takeover')
    expect(b.calls).toEqual([
      { fn: 'tabs.update', arg: { id: 31, o: { active: true } } },
      { fn: 'windows.update', arg: { id: 3, o: { focused: true } } },
    ])
  })
})

// 2026-11-17, the user: his screen share is by application, so sharing Chrome shares the agent
// window too wherever it is not covered. While this machine's screen is shared the agent window
// is minimized (no minimized window is drawn in a share), and never shown again by Walnut.
describe('while the screen is shared', () => {
  it('the agent window is minimized once when the share starts, and left as the person sets it', async () => {
    const b = browser()
    agentWindow(b)
    expect(await noteScreenShare(b.api as never, true)).toBe(true)
    expect(b.windows.get(3)!.state).toBe('minimized')
    expect(b.calls.filter((c) => c.fn === 'windows.update')).toEqual([{ fn: 'windows.update', arg: { id: 3, o: { state: 'minimized' } } }])
    // The person opens it again during the share: Walnut does not fight them.
    b.windows.get(3)!.state = 'normal'
    expect(await noteScreenShare(b.api as never, true)).toBe(false)
    expect(b.windows.get(3)!.state).toBe('normal')
  })

  it('after the share it stays minimized: Walnut never shows it again (that would bring it to the front)', async () => {
    const b = browser()
    agentWindow(b)
    await noteScreenShare(b.api as never, true)
    await noteScreenShare(b.api as never, false)
    expect(b.windows.get(3)!.state).toBe('minimized')
    expect(b.calls.filter((c) => c.fn === 'windows.update').map((c) => (c.arg as { o: unknown }).o)).toEqual([{ state: 'minimized' }])
  })

  it('an agent window made during the share is made minimized, unfocused, with no size', async () => {
    const b = browser()
    await noteScreenShare(b.api as never, true)
    const tab = await openInAgentWindow(b.api as never, 'https://shop.example.test/')
    expect(b.calls[0]).toEqual({ fn: 'windows.create', arg: { url: PAGE, type: 'normal', focused: false, state: 'minimized' } })
    expect(b.windows.get(tab.windowId!)!.state).toBe('minimized')
    // Its tabs open in it, and nothing raises it.
    expect(b.calls.some((c) => c.fn === 'windows.update')).toBe(false)
  })

  it('a share that ends before the window is made: a normal window again', async () => {
    const b = browser()
    await noteScreenShare(b.api as never, true)
    await noteScreenShare(b.api as never, false)
    await openInAgentWindow(b.api as never, 'https://shop.example.test/')
    expect(b.calls[0]).toMatchObject({ fn: 'windows.create', arg: { focused: false, width: 1280, height: 900, type: 'normal' } })
  })
})
