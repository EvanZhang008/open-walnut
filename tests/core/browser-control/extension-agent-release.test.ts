/**
 * What happens to a tab when the agent holds it and when it lets it go, end to end in the
 * extension's own command code (packages/browser-extension/src/agent.ts, agent-shared.ts,
 * agent-groups-person.ts, agent-cursor.ts) against a fake browser with tab groups:
 *   - a tab of the person's window the agent holds (handed over with Act in tab, or taken) joins
 *     that task's `walnut-<task name>` group of that window: one group per task per window, never
 *     folded, the active tab and the focused window never changed; the agent window keeps its own;
 *   - every release path (enumerated from the source: a new one fails here until it is tested)
 *     takes the agent's cursor out of every frame of the tab and puts the tab back where it was:
 *     its old group if it still exists, the group made again if it was its only tab, else
 *     ungrouped, and its old index; a tab the person moved meanwhile stays where they put it;
 *   - a step in a frame has its cursor drawn in the top document at the frame's place.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FTab = { id: number; windowId: number; index: number; groupId: number; url: string; active: boolean; status: string; title?: string }
type FGroup = { id: number; windowId: number; title?: string; color?: string; collapsed?: boolean }
const ev = () => ({ addListener() {}, removeListener() {} })
const fake = {
  session: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  tabs: new Map<number, FTab>(),
  groups: new Map<number, FGroup>(),
  nextGroup: 100,
  sent: [] as Array<{ tab: number; msg: Record<string, unknown>; frameId?: number }>,
  /** Everything that could change what the person sees: tab and window updates, folds. */
  shown: [] as string[],
  frameBoxes: {} as Record<number, Record<number, { x: number; y: number }>>,
  frames: [] as number[],
  /** Chrome's way (no runtime.getFrameId in a content script): the frame element's place, told by the document holding it (`parent`) when the frame says hello. */
  parents: {} as Record<number, { parent: number; box: { x: number; y: number }; tab?: number }>,
  /** A page message held back until this resolves (`agent-mark` on, `agent-frame-box`). */
  hold: null as null | { type: string; wait: Promise<void> },
  /** tabs.ungroup refuses this many more times ("Tabs cannot be edited right now"). */
  ungroupRefusals: 0,
  /** Chrome put a moved tab into the group its new place is inside. */
  joinOnMove: -1,
}
const inWindow = (w: number) => [...fake.tabs.values()].filter((t) => t.windowId === w).sort((a, b) => a.index - b.index)
const reindex = (w: number, order: FTab[]) => order.forEach((t, i) => { t.index = i })
const dropEmpty = () => { for (const g of [...fake.groups.values()]) if (![...fake.tabs.values()].some((t) => t.groupId === g.id)) fake.groups.delete(g.id) }
const copy = (t: FTab) => ({ ...t })

;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) }, remove: async () => undefined },
    // Kept across a reload (the person's places, agent-groups-person.ts); agents are on.
    local: { get: async (k: string) => ({ [k]: k === 'agentControl' ? true : fake.local[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.local, o) } },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => { const t = fake.tabs.get(id); if (!t) throw new Error('No tab'); return copy(t) },
    query: async (q: { windowId?: number; active?: boolean }) => [...fake.tabs.values()].filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active)).map(copy),
    update: async (id: number, o: Record<string, unknown>) => { fake.shown.push(`tabs.update ${id} ${JSON.stringify(o)}`); return copy(fake.tabs.get(id)!) },
    create: async () => { throw new Error('no new tabs here') },
    remove: async (id: number) => { fake.tabs.delete(id); dropEmpty() },
    // As Chrome does: a new group starts where the tab is; a tab joining a group it is not next to goes to the group's end.
    group: async (o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
      const t = fake.tabs.get(o.tabIds[0])!
      const gid = o.groupId ?? fake.nextGroup++
      if (o.groupId !== undefined && !fake.groups.has(gid)) throw new Error('No group')
      if (!fake.groups.has(gid)) fake.groups.set(gid, { id: gid, windowId: o.createProperties?.windowId ?? t.windowId })
      const span = inWindow(t.windowId).filter((x) => x.groupId === gid).map((x) => x.index)
      t.groupId = gid
      if (span.length && (t.index < Math.min(...span) - 1 || t.index > Math.max(...span) + 1)) {
        const rest = inWindow(t.windowId).filter((x) => x.id !== t.id)
        rest.splice(rest.findIndex((x) => x.index === Math.max(...span)) + 1, 0, t)
        reindex(t.windowId, rest)
      }
      dropEmpty()
      return gid
    },
    ungroup: async (ids: number | number[]) => {
      if (fake.ungroupRefusals > 0) { fake.ungroupRefusals--; throw new Error('Tabs cannot be edited right now (user may be dragging a tab).') }
      for (const id of [ids].flat()) fake.tabs.get(id)!.groupId = -1
      dropEmpty()
    },
    move: async (id: number, o: { index: number }) => {
      const t = fake.tabs.get(id)!
      const rest = inWindow(t.windowId).filter((x) => x.id !== id)
      rest.splice(o.index, 0, t)
      reindex(t.windowId, rest)
      if (fake.joinOnMove >= 0) t.groupId = fake.joinOnMove
    },
    sendMessage: async (tab: number, msg: Record<string, unknown>, opts?: { frameId?: number }) => {
      fake.sent.push({ tab, msg, ...(opts ? { frameId: opts.frameId } : {}) })
      const h = fake.hold
      if (h && h.type === msg.type && (msg.type !== 'agent-mark' || msg.on === true)) { fake.hold = null; await h.wait }
      if (msg.type === 'agent-check') return { ok: true, walnut: false, href: fake.tabs.get(tab)?.url }
      if (msg.type === 'agent-frame-box') return { ok: true, box: fake.frameBoxes[opts?.frameId ?? 0]?.[Number(msg.frameId)] ?? null }
      if (msg.type === 'agent-frame-hello') {
        const p = fake.parents[opts?.frameId ?? 0]
        if (!p) return { ok: false }
        // The parent's script answers as a page message would: after this send has answered.
        setTimeout(() => frameHelloBox({ type: 'agent-frame-hello-box', token: msg.token, box: p.box }, { tab: { id: p.tab ?? tab }, frameId: p.parent } as never), 0)
        return { ok: true }
      }
      if (msg.type === 'agent-cursor') return { ok: true, placed: true }
      return { ok: true }
    },
  },
  tabGroups: {
    get: async (id: number) => { const g = fake.groups.get(id); if (!g) throw new Error('No group'); return { ...g } },
    update: async (id: number, o: Record<string, unknown>) => {
      if ('collapsed' in o) fake.shown.push(`fold ${id} in window ${fake.groups.get(id)?.windowId}`)
      Object.assign(fake.groups.get(id)!, o)
    },
  },
  scripting: { executeScript: async () => [{ frameId: 0, result: { href: 'https://shop.example.test/', w: 1200, h: 800, kids: fake.frames.length } }, ...fake.frames.map((f) => ({ frameId: f, result: { href: 'https://pay.example.test/', w: 300, h: 200, kids: 0 } }))] },
  windows: {
    get: async (id: number) => ({ id, state: 'normal', focused: id === 5, type: 'normal' }), onRemoved: ev(),
    update: async (id: number, o: Record<string, unknown>) => { fake.shown.push(`windows.update ${id} ${JSON.stringify(o)}`); return {} },
  },
  permissions: { contains: async () => true, onRemoved: ev() },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: ev(), onDetach: ev() },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
  alarms: { create: () => undefined, onAlarm: ev() },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { agentTabs, mark, walnutCheck } = await import('../../../packages/browser-extension/src/agent-shared')
const { foldIdleGroup, noteGroupUse, _resetGroupsForTesting } = await import('../../../packages/browser-extension/src/agent-groups')
const { cursorUp, frameHelloBox, _resetCursorRelayForTesting } = await import('../../../packages/browser-extension/src/agent-cursor')
const { RESTORE_RETRY_MS, restoreLeftPersonTabs, restorePersonTab } = await import('../../../packages/browser-extension/src/agent-groups-person')
walnutCheck.isWalnutPage = async () => false

const api = (globalThis as any).chrome
const OWNER = 'task:paper'
const WHO = 'Order printer paper'
const allow = { any: true, sites: [] }
const idle = () => new Promise((r) => setTimeout(r, 30))

/**
 * The person's window 5: Work (tabs 1 and 2, blue), tab 3 alone, Solo (tab 4 alone, red), tab 6
 * the one in front. The agent window 3 holds the agent's own tab 9.
 */
function browser(): void {
  fake.session = { agentWindow: 3 }
  fake.local = {}
  fake.tabs.clear(); fake.groups.clear(); fake.nextGroup = 100
  fake.sent = []; fake.shown = []; fake.frameBoxes = {}; fake.frames = []; fake.parents = {}
  fake.hold = null; fake.ungroupRefusals = 0; fake.joinOnMove = -1
  _resetCursorRelayForTesting()
  const t = (id: number, windowId: number, index: number, groupId = -1, active = false): FTab => ({ id, windowId, index, groupId, url: `https://shop.example.test/${id}`, active, status: 'complete' })
  for (const x of [t(1, 5, 0, 50), t(2, 5, 1, 50), t(3, 5, 2), t(4, 5, 3, 60), t(6, 5, 4, -1, true), t(9, 3, 0, -1, true), t(11, 7, 0, -1, true)]) fake.tabs.set(x.id, x)
  fake.groups.set(50, { id: 50, windowId: 5, title: 'Work', color: 'blue' })
  fake.groups.set(60, { id: 60, windowId: 5, title: 'Solo', color: 'red' })
  _resetGroupsForTesting()
}

/** The tab handed over (Act in tab) and marked, as adoptTab does once Walnut said yes. */
async function hand(tabId: number, owner = OWNER, who = WHO): Promise<void> {
  await agentTabs.set(tabId, { owner, who, history: [fake.tabs.get(tabId)!.url], handed: 'example.test' })
  await mark(tabId, true, who)
  await idle()
}
const place = (id: number) => { const t = fake.tabs.get(id)!; return { index: t.index, group: t.groupId >= 0 ? fake.groups.get(t.groupId)?.title : undefined } }
const walnutGroups = () => [...fake.groups.values()].filter((g) => g.title?.startsWith('walnut-'))
const cursorOffSent = (tabId: number) => fake.sent.some((s) => s.tab === tabId && s.msg.type === 'agent-cursor' && s.msg.off === true && s.frameId === undefined)

beforeEach(browser)

describe('a tab the agent holds in the person\'s window joins its task\'s group there', () => {
  it('handed over: into walnut-<task name> of that window, named once, never folded, nothing brought up', async () => {
    await hand(3)
    expect(place(3).group).toBe('walnut-order-printer-paper')
    expect(walnutGroups()).toEqual([expect.objectContaining({ windowId: 5, title: 'walnut-order-printer-paper', color: 'orange' })])
    expect(walnutGroups()[0].collapsed).toBeUndefined()
    // A second tab of the same task in that window: the same group.
    await hand(2)
    expect(walnutGroups()).toHaveLength(1)
    expect(place(2).group).toBe('walnut-order-printer-paper')
    // Busy or idle, the person's window is never folded, and nothing is switched there.
    noteGroupUse(api as never, OWNER)
    expect(await foldIdleGroup(api as never, OWNER, Date.now() + 60_000)).toBe(false)
    expect(fake.shown).toEqual([])
    expect(fake.tabs.get(6)!.active).toBe(true)
  })

  it('one group per task per window: another window, another task, each its own; the agent window keeps its own group', async () => {
    await hand(3)
    await hand(11)
    await hand(1, 'task:table', 'Book a table')
    await agentTabs.set(9, { owner: OWNER, who: WHO })
    await mark(9, true, WHO)
    await idle()
    const titles = walnutGroups().map((g) => `${g.windowId}:${g.title}`).sort()
    expect(titles).toEqual(['3:walnut-order-printer-paper', '5:walnut-book-a-table', '5:walnut-order-printer-paper', '7:walnut-order-printer-paper'])
    expect(fake.shown).toEqual([])
  })

  it('only a hand-over (Act in tab) is grouped: a tab taken with `take` and one opened from a handed tab stay where they are', async () => {
    await agentTabs.set(4, { owner: OWNER, who: WHO, taken: true })
    await mark(4, true, WHO)
    await agentTabs.set(1, { owner: OWNER, who: WHO, popup: true, viaHanded: true })
    await mark(1, true, WHO)
    await idle()
    expect(place(4).group).toBe('Solo')
    expect(place(1).group).toBe('Work')
    expect(walnutGroups()).toEqual([])
  })

  it('handed on to another conversation: it moves to that task\'s group, and still goes back to where it was at first', async () => {
    await hand(3)
    await hand(3, 'task:table', 'Book a table')
    expect(place(3).group).toBe('walnut-book-a-table')
    await agent.releaseTab(3)
    await idle()
    expect(place(3)).toEqual({ index: 2, group: undefined })
    expect(walnutGroups()).toEqual([])
  })
})

describe('let go, it goes back where it was', () => {
  /** The task's group moved along the window meanwhile (the person dragged it, or Chrome gathered it). */
  const drift = async (id: number) => { await api.tabs.move(id, { index: inWindow(5).length - 1 }) }

  it('ungrouped before: ungrouped, at its old index', async () => {
    await hand(3)
    await drift(3)
    expect(place(3)).toEqual({ index: 4, group: 'walnut-order-printer-paper' })
    await agent.releaseTab(3)
    await idle()
    expect(place(3)).toEqual({ index: 2, group: undefined })
    expect(walnutGroups()).toEqual([])
  })

  it('in a group that still exists: back into it', async () => {
    await hand(2)
    await drift(2)
    await agent.releaseTab(2)
    await idle()
    expect(place(2)).toEqual({ index: 1, group: 'Work' })
    expect(inWindow(5).map((t) => t.id)).toEqual([1, 2, 3, 4, 6])
  })

  it('the only tab of its group (the group went when it left): the group is made again, its name and colour as they were', async () => {
    await hand(4)
    await drift(4)
    expect([...fake.groups.values()].some((g) => g.title === 'Solo')).toBe(false)
    await agent.releaseTab(4)
    await idle()
    expect(place(4)).toEqual({ index: 3, group: 'Solo' })
    expect([...fake.groups.values()].find((g) => g.title === 'Solo')).toMatchObject({ color: 'red', windowId: 5 })
  })

  it('the person moved it out of the task\'s group meanwhile: it stays where they put it', async () => {
    await hand(3)
    fake.tabs.get(3)!.groupId = -1
    const before = place(3)
    await agent.releaseTab(3)
    await idle()
    expect(place(3)).toEqual(before)
  })

  it('let go before its grouping had its turn (the page was slow to show the frame): it is never grouped', async () => {
    let go!: () => void
    fake.hold = { type: 'agent-mark', wait: new Promise<void>((r) => { go = r }) }
    await agentTabs.set(3, { owner: OWNER, who: WHO, handed: 'example.test' })
    const marking = mark(3, true, WHO)
    await idle()
    await agent.releaseTab(3)
    go()
    await marking
    await idle()
    expect(place(3)).toEqual({ index: 2, group: undefined })
    expect(walnutGroups()).toEqual([])
  })

  it('Chrome refuses the restore once (the person is dragging a tab): it is tried again and goes back', async () => {
    await hand(3)
    await drift(3)
    fake.ungroupRefusals = 1
    await agent.releaseTab(3)
    await idle()
    expect(place(3).group).toBe('walnut-order-printer-paper')
    // Tried once more after RESTORE_RETRY_MS: waited on the tab going back, not on a clock.
    await vi.waitFor(() => expect(place(3)).toEqual({ index: 2, group: undefined }), { timeout: RESTORE_RETRY_MS + 5000, interval: 20 })
  })

  it('no group of its own before: one its move back landed it inside is not kept', async () => {
    await hand(3)
    await drift(3)
    fake.joinOnMove = 50
    await agent.releaseTab(3)
    await idle()
    expect(place(3).group).toBeUndefined()
  })

  it('a pinned tab is never grouped (Chrome would unpin it)', async () => {
    ;(fake.tabs.get(3) as FTab & { pinned?: boolean }).pinned = true
    await hand(3)
    expect(place(3)).toEqual({ index: 2, group: undefined })
    expect(walnutGroups()).toEqual([])
  })

  it('a window with fewer tabs now: no index past its end; a tab closed meanwhile: nothing fails', async () => {
    await hand(3)
    fake.tabs.delete(1); fake.tabs.delete(2); fake.tabs.delete(4); fake.tabs.delete(6)
    await agent.releaseTab(3)
    await idle()
    expect(place(3).group).toBeUndefined()
    await hand(6 in fake.tabs ? 6 : 3)
    fake.tabs.delete(3)
    await expect(agent.releaseTab(3)).resolves.toBeUndefined()
  })
})

describe('every release path takes the cursor away and puts the tab back (enumerated from the source)', () => {
  const SRC = 'packages/browser-extension/src'
  const paths: Record<string, (tab: number) => Promise<unknown>> = {
    'side panel release (Done)': (tab) => agent.releaseTab(tab),
    'side panel Stop all': () => agent.releaseAllTabs(),
    'Stop on the page': (tab) => agent.agentMessage('agent-stop', { tab: { id: tab } }),
    'Browser view Stop': (tab) => agent._viewActForTesting({ id: 's', action: 'view_stop', args: { tab, owner: OWNER }, allow }),
    'close (the person\'s tab is given back)': (tab) => agent._actForTesting({ id: 'c', action: 'close', args: { tab }, allow }),
    'the task\'s tidy-up (close tidy)': (tab) => agent._actForTesting({ id: 'c', action: 'close', args: { tab, tidy: true, owner: OWNER }, allow }),
    'agents turned off': () => agent.agentOff(),
  }

  it.each(Object.keys(paths))('%s', async (name) => {
    await hand(3)
    await hand(2)
    await api.tabs.move(3, { index: 4 })
    fake.sent = []
    await paths[name](3)
    await idle()
    expect(await agentTabs.get(3)).toBeUndefined()
    expect(cursorOffSent(3)).toBe(true)
    expect(place(3)).toEqual({ index: 2, group: undefined })
    // Nothing of the release brings a tab up or focuses a window.
    expect(fake.shown).toEqual([])
  })

  it('the tab closed: its holding goes and nothing is left to restore', async () => {
    await hand(3)
    fake.tabs.delete(3)
    await agentTabs.delete(3)
    expect(((fake.local.agentGroupBefore ?? {}) as Record<string, unknown>)['3']).toBeUndefined()
  })

  it('every holding ends through agentTabs.delete or deleteIf, which let the tab go (no other writer of the store)', () => {
    const shared = readFileSync(`${SRC}/agent-shared.ts`, 'utf8')
    expect(shared).toMatch(/delete: async \(tabId: number\) => \{ await rawAgentTabs\.delete\(tabId\); await letGo\(tabId\) \}/)
    expect(shared).toMatch(/if \(done\) await letGo\(tabId\)/)
    expect(shared).toMatch(/async function letGo[\s\S]{0,200}type: 'agent-cursor', off: true[\s\S]{0,200}restorePersonTab/)
    for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
      const s = readFileSync(`${SRC}/${f}`, 'utf8')
      if (f !== 'agent-shared.ts') expect(s, f).not.toMatch(/rawAgentTabs|tabStore<AgentTab>|tabStore\('agentTabs'\)/)
      expect(s, f).not.toMatch(/session\.set\(\{\s*agentTabs/)
      expect(s, f).not.toMatch(/agentTabs\.sweep\(/)
    }
  })

  it('the release paths of agent.ts are the ones tested here', () => {
    // Each function of agent.ts that ends a holding; a new one fails here until a path above tests it.
    const s = readFileSync(`${SRC}/agent.ts`, 'utf8')
    const fns = [...s.matchAll(/\n(?:export )?(?:async )?function (\w+)[\s\S]*?\n\}\n/g)].filter((m) => /agentTabs\.(delete|deleteIf)\(/.test(m[0])).map((m) => m[1]).sort()
    expect(fns).toEqual(['act', 'agentMessage', 'agentOff', 'initAgent', 'releaseTab', 'report', 'viewAct'])
    // act: close (both kinds, above), a closed tab in `tabs`, and an open that loaded Walnut itself; report and
    // initAgent (tabs.onRemoved): a closed tab, which has nothing left to restore (tested above).
    expect(s).toMatch(/for \(const id of await agentTabs\.keys\(\)\) await releaseTab\(id\)/)
  })
})

describe('a step in a frame: the cursor in the top document', () => {
  const up = (frameId: number, tab = 3) => cursorUp({ x: 10, y: 20, kind: 'click' }, { tab: { id: tab }, frameId })
  const drawn = () => fake.sent.filter((s) => s.msg.type === 'agent-cursor' && !s.msg.off)

  it('a frame of the top document: at the frame\'s place there', async () => {
    await hand(3)
    fake.sent = []
    fake.frameBoxes = { 0: { 4: { x: 100, y: 200 } } }
    expect(await up(4)).toEqual({ ok: true, placed: true })
    expect(drawn()).toEqual([{ tab: 3, msg: { type: 'agent-cursor', x: 110, y: 220, kind: 'click' }, frameId: 0 }])
  })

  it('a frame inside another site\'s frame: the frame that holds it says where, and its own place is added', async () => {
    await hand(3)
    fake.sent = []
    fake.frames = [2, 4]
    fake.frameBoxes = { 0: { 2: { x: 100, y: 200 } }, 2: { 4: { x: 5, y: 7 } } }
    expect(await up(4)).toEqual({ ok: true, placed: true })
    expect(drawn()[0].msg).toMatchObject({ x: 115, y: 227 })
  })

  it('let go while the frame\'s place was looked for: nothing is drawn after the release took the cursor away', async () => {
    await hand(3)
    let go!: () => void
    fake.hold = { type: 'agent-frame-box', wait: new Promise<void>((r) => { go = r }) }
    fake.frameBoxes = { 0: { 4: { x: 100, y: 200 } } }
    fake.sent = []
    const placing = up(4)
    await idle()
    await agent.releaseTab(3)
    go()
    expect(await placing).toEqual({ ok: true, placed: true })
    expect(drawn()).toEqual([])
    expect(cursorOffSent(3)).toBe(true)
  })

  it('a top document too slow to answer (a loaded machine) is no "not here": the next step looks again', async () => {
    await hand(3)
    fake.frameBoxes = { 0: { 4: { x: 100, y: 200 } } }
    // The top document's first answer never comes in time (2026-11-09, the land gate's runner).
    fake.hold = { type: 'agent-frame-box', wait: new Promise<void>(() => undefined) }
    vi.useFakeTimers()
    try {
      const first = up(4)
      await vi.advanceTimersByTimeAsync(4000)
      expect(await first).toEqual({ ok: true, placed: false })
    } finally {
      vi.useRealTimers()
    }
    fake.sent = []
    expect(await up(4)).toEqual({ ok: true, placed: true })
    expect(drawn()[0].msg).toMatchObject({ x: 110, y: 220 })
  })

  it('Chrome (no runtime.getFrameId): the frame says hello to its parent, which says where it starts; nested frames add up', async () => {
    await hand(3)
    fake.sent = []
    fake.frames = [2, 4]
    fake.parents = { 4: { parent: 2, box: { x: 5, y: 7 } }, 2: { parent: 0, box: { x: 100, y: 200 } } }
    expect(await up(4)).toEqual({ ok: true, placed: true })
    expect(drawn()[0].msg).toMatchObject({ x: 115, y: 227 })
    expect(fake.sent.filter((s) => s.msg.type === 'agent-frame-hello').map((s) => s.frameId)).toEqual([4, 2])
  })

  it('an answer from another tab is not taken, nor one with no place; a token nobody waits for is ignored', async () => {
    await hand(3)
    fake.parents = { 4: { parent: 0, box: { x: 1, y: 1 }, tab: 99 } }
    fake.sent = []
    expect(await up(4)).toEqual({ ok: true, placed: false })
    expect(drawn()).toEqual([])
    _resetCursorRelayForTesting()
    fake.parents = { 4: { parent: 0, box: { x: Number.NaN, y: 1 } } }
    vi.useFakeTimers()
    try {
      const r = up(4)
      await vi.advanceTimersByTimeAsync(4000)
      expect(await r).toEqual({ ok: true, placed: false })
    } finally {
      vi.useRealTimers()
    }
    expect(drawn()).toEqual([])
    expect(frameHelloBox({ token: 'not-a-token-of-ours-0000', box: { x: 1, y: 1 } }, { tab: { id: 3 }, frameId: 0 } as never)).toEqual({ ok: true })
  })

  it('a place nobody can say, or a tab no agent holds: not drawn there (the frame draws it itself), and not looked for again for a while', async () => {
    await hand(3)
    fake.frames = [2]
    expect(await up(4)).toEqual({ ok: true, placed: false })
    fake.frameBoxes = { 0: { 4: { x: 1, y: 1 } } }
    fake.sent = []
    expect(await up(4)).toEqual({ ok: true, placed: false })
    expect(fake.sent).toEqual([])
    expect(await up(4, 6)).toEqual({ ok: true, placed: false })
    expect(await up(0)).toEqual({ ok: true, placed: false })
  })
})

/** Every grouping and restore queued so far has run (they go one at a time, in one line). */
const groupsSettled = () => restorePersonTab(api as never, -12345)
const heldNow = async (tabId: number) => !!(await agentTabs.get(tabId))

describe('a hand-over is grouped once per holding, and nothing else of the person\'s is (review 2026-11-09)', () => {
  it('the person drags it out of the task\'s group: Take over, Hand back and any later mark leave it where they put it', async () => {
    await hand(3)
    expect(place(3).group).toBe('walnut-order-printer-paper')
    await api.tabs.ungroup(3)
    await mark(3, true, WHO, 'driving')
    await mark(3, true, WHO)
    await groupsSettled()
    expect(place(3).group).toBeUndefined()
    expect((await agentTabs.get(3))?.grouped).toBe((await agentTabs.get(3))?.grant)
  })

  it('marks at once (the frame and the Browser view both mark): one grouping, one group', async () => {
    await agentTabs.set(3, { owner: OWNER, who: WHO, handed: 'example.test' })
    await Promise.all([mark(3, true, WHO), mark(3, true, WHO), mark(3, true, WHO)])
    await groupsSettled()
    expect(place(3).group).toBe('walnut-order-printer-paper')
    expect(walnutGroups()).toHaveLength(1)
  })

  it('the grouping is only in mark, and only for a hand-over recorded with its grant', () => {
    const shared = readFileSync('packages/browser-extension/src/agent-shared.ts', 'utf8')
    expect(shared).toMatch(/if \(rec\?\.handed && rec\.grant && rec\.grouped !== rec\.grant && await firstGrouping\(tabId, rec\.grant\)\)/)
    for (const f of readdirSync('packages/browser-extension/src').filter((x) => x.endsWith('.ts') && x !== 'agent-groups-person.ts')) {
      const calls = readFileSync(`packages/browser-extension/src/${f}`, 'utf8').match(/groupPersonTab\(/g) ?? []
      expect(calls.length, f).toBe(f === 'agent-shared.ts' ? 1 : 0)
    }
  })
})

describe('a tab left in its task\'s group by an extension reload or a browser restart goes back (review 2026-11-09)', () => {
  /** An extension reload or update: storage.session (every holding) is cleared, the tabs and groups keep their ids. */
  const reload = () => { fake.session = { agentWindow: 3 } }

  /** A browser restart: storage.session is cleared, and Chrome restores the windows, tabs and groups under new ids. */
  function restart(): void {
    const tabs = [...fake.tabs.values()]
    const groups = [...fake.groups.values()]
    fake.tabs.clear(); fake.groups.clear()
    for (const g of groups) fake.groups.set(g.id + 1000, { ...g, id: g.id + 1000, windowId: g.windowId + 10 })
    for (const t of tabs) fake.tabs.set(t.id + 200, { ...t, id: t.id + 200, windowId: t.windowId + 10, groupId: t.groupId >= 0 ? t.groupId + 1000 : -1 })
    fake.session = {}
  }
  const byUrl = (n: number) => [...fake.tabs.values()].find((t) => t.url === `https://shop.example.test/${n}`)!
  const placeOf = (n: number) => place(byUrl(n).id)

  it('the places are kept in storage.local, which a reload and a restart keep', async () => {
    await hand(3)
    expect(Object.keys((fake.local.agentGroupBefore ?? {}) as object)).toEqual(['3'])
    expect(fake.session.agentGroupBefore).toBeUndefined()
    expect((fake.local.agentGroupBefore as Record<string, Record<string, unknown>>)['3']).toMatchObject({ windowId: 5, index: 2, groupId: -1, oursTitle: 'walnut-order-printer-paper' })
  })

  it('a reload: the same tab, still in our group with no holding, goes back as a release would; Work, Solo and their order as they were', async () => {
    await hand(3)
    await hand(2)
    await hand(4)
    await api.tabs.move(3, { index: 4 })
    reload()
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(place(3)).toEqual({ index: 2, group: undefined })
    expect(place(2).group).toBe('Work')
    expect(place(4).group).toBe('Solo')
    expect(walnutGroups()).toEqual([])
    expect(fake.local.agentGroupBefore).toEqual({})
    expect(fake.shown).toEqual([])
  })

  it('a restart: tabs found again in restored groups of ours by title and colour, put back by title, the only-tab group made again', async () => {
    await hand(3)
    await hand(2)
    await hand(4)
    restart()
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(placeOf(3).group).toBeUndefined()
    expect(placeOf(2).group).toBe('Work')
    expect(placeOf(4)).toMatchObject({ group: 'Solo' })
    expect([...fake.groups.values()].find((g) => g.title === 'Solo')).toMatchObject({ color: 'red' })
    expect(walnutGroups()).toEqual([])
    expect(fake.shown).toEqual([])
  })

  it('never a group we did not make, never the agent window\'s, never a tab held now', async () => {
    // The agent window (3) has its own page and its task's group of the same name, in orange.
    fake.tabs.set(8, { id: 8, windowId: 3, index: 1, groupId: -1, url: 'chrome-extension://test/agent-window.html', active: false, status: 'complete' })
    fake.tabs.get(9)!.groupId = 70
    fake.groups.set(70, { id: 70, windowId: 3, title: 'walnut-order-printer-paper', color: 'orange' })
    // The person named a group of theirs the same, in another colour (window 7).
    fake.tabs.get(11)!.groupId = 80
    fake.groups.set(80, { id: 80, windowId: 7, title: 'walnut-order-printer-paper', color: 'blue' })
    await hand(3)
    restart()
    // After the restart another task's hand-over is held in a group named like ours: it is theirs now.
    await agentTabs.set(201, { owner: OWNER, who: WHO, handed: 'example.test' })
    fake.tabs.get(201)!.groupId = 1100
    fake.groups.set(1100, { id: 1100, windowId: 15, title: 'walnut-order-printer-paper', color: 'orange' })
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(placeOf(3).group).toBeUndefined()
    expect(fake.tabs.get(209)!.groupId).toBe(1070)
    expect(fake.tabs.get(211)!.groupId).toBe(1080)
    expect(fake.tabs.get(201)!.groupId).toBe(1100)
  })

  it('a restart with the agent window\'s own page gone: its tabs are known by being muted, and left alone', async () => {
    // Every agent tab is muted (agent-window.ts); the person's handed tab is not.
    ;(fake.tabs.get(9) as FTab & { mutedInfo?: { muted: boolean } }).mutedInfo = { muted: true }
    fake.tabs.get(9)!.groupId = 70
    fake.groups.set(70, { id: 70, windowId: 3, title: 'walnut-order-printer-paper', color: 'orange' })
    await hand(3)
    restart()
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(placeOf(3).group).toBeUndefined()
    expect(fake.tabs.get(209)!.groupId).toBe(1070)
  })

  it('a reload with the agent window unknown (storage.session cleared, its page closed): only the person\'s own window is swept', async () => {
    ;(fake.tabs.get(9) as FTab & { mutedInfo?: { muted: boolean } }).mutedInfo = { muted: false }
    fake.tabs.get(9)!.groupId = 70
    fake.groups.set(70, { id: 70, windowId: 3, title: 'walnut-order-printer-paper', color: 'orange' })
    await hand(3)
    // The person moved it out meanwhile; its place is kept, our title is known.
    await api.tabs.ungroup(3)
    fake.session = {}
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(fake.tabs.get(9)!.groupId).toBe(70)
    expect(fake.local.agentGroupBefore).toEqual({})
  })

  it('a tab still held (the background only woke) is left in its group', async () => {
    await hand(3)
    await restoreLeftPersonTabs(api as never, heldNow)
    expect(place(3).group).toBe('walnut-order-printer-paper')
    expect(Object.keys(fake.local.agentGroupBefore as object)).toEqual(['3'])
  })

  it('a refused move (the person drags a tab) never loses the rest', async () => {
    await hand(3)
    await hand(2)
    reload()
    fake.ungroupRefusals = 1
    await expect(restoreLeftPersonTabs(api as never, heldNow)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(place(2).group).toBe('Work'))
  })

  it('runs on every start of the background: its first wake, a browser start, an install or update', () => {
    const src = readFileSync('packages/browser-extension/src/agent.ts', 'utf8')
    const init = src.slice(src.indexOf('export function initAgent('), src.indexOf('\n}\n', src.indexOf('export function initAgent(')))
    expect(init).toMatch(/onStartup\?\.addListener\(\(\) => \{[^}]*restoreLeft\(\)/)
    expect(init).toMatch(/onInstalled\?\.addListener\(\(\) => restoreLeft\(\)\)/)
    expect(init).toMatch(/\n  restoreLeft\(\)\n/)
    expect(src).toMatch(/restoreLeftPersonTabs\(ext as unknown as GroupApi, async \(tabId\) => !!\(await agentTabs\.get\(tabId\)\)\)/)
    // The places live in storage.local, never only in storage.session.
    const person = readFileSync('packages/browser-extension/src/agent-groups-person.ts', 'utf8')
    expect(person).toMatch(/const placeStore = \(api: GroupApi\) => api\.storage\.local \?\? api\.storage\.session/)
    expect(person).not.toMatch(/storage\.session\.(get|set)\([^)]*BEFORE/)
  })
})
