/**
 * The extension's half of keeping the agent window tidy (packages/browser-extension/src/agent-groups.ts
 * folding, agent-tidy.ts leftovers). 2026-11-08, the user: "group show as it is open why walnut",
 * and "clean up after used, unless wait for human".
 *
 *   - a task's group folds to its chip after a quiet spell, never while one of its commands runs;
 *     when its tab is in front, the agent window's own page comes in front first;
 *   - a tab leaves its group before it closes (Chrome saves a closed group);
 *   - a tab the extension opened for an agent and that no agent holds any more closes after
 *     LEFT_MS; a tab the person opened, or one in the person's window, never does.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const ev = () => ({ addListener() {}, removeListener() {} })
type T = { id: number; windowId: number; active?: boolean; groupId?: number; url?: string }
const fake = {
  session: {} as Record<string, unknown>,
  tabs: new Map<number, T>(),
  removed: [] as number[],
  ungrouped: [] as number[],
  focused: new Set<number>(),
}
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://walnut/${p}`, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => { const t = fake.tabs.get(id); if (!t) throw new Error('No tab'); return { ...t } },
    remove: async (id: number) => { fake.removed.push(id); fake.tabs.delete(id) },
    ungroup: async (id: number) => { fake.ungrouped.push(id); fake.tabs.get(id)!.groupId = -1 },
  },
  windows: { get: async (id: number) => ({ id, focused: fake.focused.has(id) }), onRemoved: ev() },
}

const { tidyLeftovers, noteAgentMade, forgetAgentMade, LEFT_MS } = await import('../../../packages/browser-extension/src/agent-tidy')
const { foldIdleGroup, noteGroupUse, setGroupBusy, ungroupBeforeClose, agentPageTab, FOLD_IDLE_MS, _resetGroupsForTesting } = await import('../../../packages/browser-extension/src/agent-groups')

beforeEach(() => {
  fake.session = { agentWindow: 3, agentTabs: {} }
  fake.tabs = new Map()
  fake.removed = []
  fake.ungrouped = []
  fake.focused = new Set()
  _resetGroupsForTesting()
  setGroupBusy(() => false)
})

function groupApi() {
  const groups = new Map<number, { id: number; windowId: number; collapsed: boolean; title?: string }>([[100, { id: 100, windowId: 3, collapsed: false }]])
  const session: Record<string, unknown> = { agentGroups: { 'task:a': 100 }, agentWindow: 3, agentTabs: {} }
  const win = { focused: false }
  const tabs = new Map<number, T>([[7, { id: 7, windowId: 3, active: true, groupId: 100 }], [8, { id: 8, windowId: 3, groupId: 100 }]])
  const made: Array<Record<string, unknown>> = []
  const api = {
    tabs: {
      get: async (id: number) => { const t = tabs.get(id); if (!t) throw new Error('No tab'); return { ...t } },
      query: async (o: { active?: boolean; windowId?: number }) => [...tabs.values()].filter((t) => (o.active === undefined || !!t.active === o.active) && (o.windowId === undefined || t.windowId === o.windowId)),
      update: async (id: number, o: { active?: boolean }) => { if (o.active) for (const t of tabs.values()) if (t.windowId === tabs.get(id)!.windowId) t.active = t.id === id },
      create: async (o: { url: string; windowId?: number; active?: boolean; index?: number }) => { made.push(o); const t = { id: 70, windowId: o.windowId ?? 3, active: !!o.active }; tabs.set(70, t); return t },
      ungroup: async (id: number) => { tabs.get(id)!.groupId = -1 },
    },
    tabGroups: {
      get: async (id: number) => { const g = groups.get(id); if (!g) throw new Error('No group'); return { ...g } },
      update: async (id: number, o: { collapsed?: boolean }) => { if (o.collapsed !== undefined) groups.get(id)!.collapsed = o.collapsed },
    },
    runtime: { getURL: (p: string) => `chrome-extension://walnut/${p}` },
    windows: { get: async () => ({ ...win }) },
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o) } } },
  }
  return { api, groups, tabs, made, session, win }
}

describe('a task\'s group folds when quiet', () => {
  it('folds after FOLD_IDLE_MS, with the agent window\'s own page in front first; the page is made once, never active', async () => {
    const w = groupApi()
    noteGroupUse(w.api as never, 'task:a')
    _resetGroupsForTesting() // no timer: the pass below runs by hand
    expect(await foldIdleGroup(w.api as never, 'task:a', Date.now() + FOLD_IDLE_MS)).toBe(true)
    expect(w.groups.get(100)!.collapsed).toBe(true)
    expect(w.made).toEqual([{ url: 'chrome-extension://walnut/agent-window.html', windowId: 3, active: false, index: 0 }])
    expect(w.tabs.get(70)!.active).toBe(true)
    expect(w.tabs.get(7)!.active).toBe(false)
    // Again: nothing to do, the page is not made twice.
    expect(await agentPageTab(w.api as never, 3)).toBe(70)
    expect(w.made).toHaveLength(1)
  })

  it('never folds while a command of the task runs, or right after its last use', async () => {
    const w = groupApi()
    noteGroupUse(w.api as never, 'task:a')
    expect(await foldIdleGroup(w.api as never, 'task:a', Date.now() + 1000)).toBe(false)
    setGroupBusy((o) => o === 'task:a')
    expect(await foldIdleGroup(w.api as never, 'task:a', Date.now() + 10 * FOLD_IDLE_MS)).toBe(false)
    expect(w.groups.get(100)!.collapsed).toBe(false)
    _resetGroupsForTesting()
  })

  it('never folds under the person: a window they are in, a front tab they took over, a group in a window of theirs', async () => {
    const later = () => Date.now() + 10 * FOLD_IDLE_MS
    const w = groupApi()
    w.win.focused = true
    expect(await foldIdleGroup(w.api as never, 'task:a', later())).toBe(false)
    w.win.focused = false
    w.session.agentTabs = { 7: { owner: 'task:a', driving: Date.now() } }
    expect(await foldIdleGroup(w.api as never, 'task:a', later())).toBe(false)
    w.session.agentTabs = {}
    w.groups.get(100)!.windowId = 9
    expect(await foldIdleGroup(w.api as never, 'task:a', later())).toBe(false)
    expect(w.groups.get(100)!.collapsed).toBe(false)
    expect(w.made).toEqual([])
    expect(w.tabs.get(7)!.active).toBe(true)
    _resetGroupsForTesting()
  })

  it('a tab leaves its group before it closes, so no saved group is left behind', async () => {
    const w = groupApi()
    await ungroupBeforeClose(w.api as never, 8)
    expect(w.tabs.get(8)!.groupId).toBe(-1)
  })
})

describe('leftover tabs', () => {
  it('a tab the extension opened that no agent holds closes LEFT_MS after it was let go; held ones and the person\'s stay', async () => {
    fake.tabs.set(10, { id: 10, windowId: 3, groupId: 100 })     // opened for an agent, let go: closes
    fake.tabs.set(11, { id: 11, windowId: 3 })                   // opened for an agent, still held: stays
    fake.tabs.set(12, { id: 12, windowId: 3 })                   // the person's own tab in the agent window: never noted, stays
    fake.tabs.set(13, { id: 13, windowId: 9 })                   // moved to the person's window: stays
    fake.tabs.set(14, { id: 14, windowId: 3, active: true })     // the person looks at it in the focused agent window: stays
    fake.focused.add(3)
    for (const id of [10, 11, 13, 14]) await noteAgentMade(id)
    fake.session.agentTabs = { 11: { owner: 'task:a', grant: 'g' } }
    const t0 = Date.now()
    expect(await tidyLeftovers(t0)).toEqual([])                  // first seen let go: the clock starts
    expect(await tidyLeftovers(t0 + LEFT_MS - 1)).toEqual([])
    expect(await tidyLeftovers(t0 + LEFT_MS)).toEqual([10])
    expect(fake.ungrouped).toEqual([10])
    expect(fake.removed).toEqual([10])
    expect([...fake.tabs.keys()].sort()).toEqual([11, 12, 13, 14])
    // A tab that went by itself is forgotten.
    fake.tabs.delete(13)
    await tidyLeftovers(t0 + 2 * LEFT_MS)
    expect(Object.keys(fake.session.agentMade as object)).not.toContain('13')
  })

  it('a tab the person took (Stop, the side panel, agents off) is theirs: never tidied', async () => {
    fake.tabs.set(20, { id: 20, windowId: 3 })
    await noteAgentMade(20)
    await forgetAgentMade(20)
    const t0 = Date.now()
    await tidyLeftovers(t0)
    expect(await tidyLeftovers(t0 + 2 * LEFT_MS)).toEqual([])
    expect(fake.tabs.has(20)).toBe(true)
  })

  it('notes made while a pass runs are kept (one change at a time)', async () => {
    fake.tabs.set(30, { id: 30, windowId: 3 })
    fake.tabs.set(31, { id: 31, windowId: 3 })
    await Promise.all([noteAgentMade(30), tidyLeftovers(Date.now()), noteAgentMade(31)])
    expect(Object.keys(fake.session.agentMade as object).sort()).toEqual(['30', '31'])
  })
})
