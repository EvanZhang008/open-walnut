/**
 * The extension's half of the live Browser view, Take over and the task's tab group
 * (packages/browser-extension/src/agent-view.ts, agent-takeover.ts, agent-groups.ts), against a
 * fake browser. 2026-11-08, the user: "very laggy like it doesn't show in real time, it takes so
 * long to screenshot, and very bad, also I want it to be able to take over if needed, also in the
 * chrome it should show walnut-xxx-task-name in a chrome group".
 *
 *   - one watch starts one stream, which posts each picture at the screen's own pixels (never
 *     shrunk), a repeat without its bytes, and stops when Walnut says nobody watches or the tab went;
 *   - Take over marks the tab the person's, brings its window and tab forward, and every agent
 *     command there is refused until Hand back; another owner's tab is never taken over;
 *   - an agent's tab goes into one group per task, named walnut-<task name>.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const ev = () => ({ addListener() {}, removeListener() {} })
const fake = {
  session: {} as Record<string, unknown>,
  captures: [] as Array<{ windowId: number; o: Record<string, unknown> }>,
  image: 'data:image/jpeg;base64,AAAA',
  windowUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  tabUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  messages: [] as Array<{ tab: number; msg: Record<string, unknown> }>,
  /** The tab in front of the agent window. */
  front: 7,
  /** Whether the person is in the agent window. */
  focused: false,
}
const tab = (id = 7) => ({ id, windowId: 3, active: id === fake.front, url: 'https://shop.example.test/', title: 'Shop' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => p, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => tab(id),
    query: async () => [tab(fake.front)],
    update: async (id: number, o: Record<string, unknown>) => { fake.tabUpdates.push({ id, o }); if (o.active === true) fake.front = id; return tab(id) },
    sendMessage: async (id: number, msg: Record<string, unknown>) => { fake.messages.push({ tab: id, msg }); return { ok: true } },
    captureVisibleTab: async (windowId: number, o: Record<string, unknown>) => { fake.captures.push({ windowId, o }); return fake.image },
  },
  windows: {
    get: async () => ({ state: 'normal', focused: fake.focused }), onRemoved: ev(),
    update: async (id: number, o: Record<string, unknown>) => { fake.windowUpdates.push({ id, o }); return {} },
  },
  permissions: { contains: async () => true },
}

const { viewWatch, viewFrame, streaming, noteWorked, bringUpForCommand, STREAM_QUALITY, BEHIND_EVERY_MS, _resetViewForTesting } = await import('../../../packages/browser-extension/src/agent-view')
const { takeOver, handBack, drivingRefusal } = await import('../../../packages/browser-extension/src/agent-takeover')
const { agentTabs } = await import('../../../packages/browser-extension/src/agent-shared')
const { groupAgentTab, groupTitle } = await import('../../../packages/browser-extension/src/agent-groups')

const OWNER = 'task:stream'
const allow = { any: true, sites: [], walnut: ['walnut.example.test'] }
const cmd = (action: string, args: Record<string, unknown> = {}) => ({ id: 'c', action, args: { tab: 7, ...args }, allow })
const until = async (ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }

beforeEach(() => {
  fake.session = { agentTabs: { 7: { owner: OWNER, grant: 'g1', who: 'Order printer paper' } }, agentWindow: 3 }
  fake.captures = []
  fake.windowUpdates = []
  fake.tabUpdates = []
  fake.messages = []
  fake.image = 'data:image/jpeg;base64,AAAA'
  fake.front = 7
  fake.focused = false
  _resetViewForTesting()
})

describe('the stream', () => {
  it('posts pictures at the screen\'s own pixels until Walnut says nobody watches; a repeat goes without its bytes', async () => {
    const posts: Array<Record<string, unknown>> = []
    const push = async (b: Record<string, unknown>) => { posts.push(b); return { more: posts.length < 3, ms: 5000 } }
    const out = await viewWatch(cmd('view_watch'), () => false, push)
    expect(out).toMatchObject({ watching: true, started: true })
    await until(() => !streaming(7), 5000)
    expect(posts).toHaveLength(3)
    expect(posts[0]).toMatchObject({ tab: 7, seq: 1, shown: true, image: fake.image })
    // The same picture again: posted with no bytes.
    expect(posts[1]).toMatchObject({ seq: 2, shown: true, same: true })
    expect(posts[1].image).toBeUndefined()
    expect(fake.captures[0].o).toEqual({ format: 'jpeg', quality: STREAM_QUALITY })
  })

  it('a second watch while one runs only makes it longer; Walnut asking for the bytes again gets them', async () => {
    const posts: Array<Record<string, unknown>> = []
    let n = 0
    const push = async (b: Record<string, unknown>) => { posts.push(b); n++; return n >= 3 ? { more: false } : { more: true, ms: 5000, ...(n === 1 ? { again: true } : {}) } }
    await viewWatch(cmd('view_watch'), () => false, push)
    expect(await viewWatch(cmd('view_watch'), () => false, push)).toEqual({ tab: 7, watching: true })
    await until(() => !streaming(7), 5000)
    // `again` after the first: the second post carries the picture whole.
    expect(posts[1].image).toBe(fake.image)
    expect(posts.filter((p) => p.seq === 1)).toHaveLength(1)
  })

  it('a tab given back ends the stream with one `gone` post', async () => {
    const posts: Array<Record<string, unknown>> = []
    const push = async (b: Record<string, unknown>) => { posts.push(b); fake.session.agentTabs = {}; return { more: true } }
    await viewWatch(cmd('view_watch'), () => false, push)
    await until(() => !streaming(7), 5000)
    expect(posts.at(-1)).toMatchObject({ tab: 7, gone: true, code: 'not_your_tab' })
  })

  it('a watch of a tab no agent holds is refused', async () => {
    fake.session.agentTabs = {}
    await expect(viewWatch(cmd('view_watch'), () => false, async () => ({ more: true }))).rejects.toMatchObject({ code: 'not_your_tab' })
  })
})

describe('a tab behind the one the agent uses (2026-11-08: the view froze on "Waiting for the next picture")', () => {
  const watchBehind = async (busy: (id: number) => boolean, ms: number) => {
    fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1' }, 8: { owner: OWNER, grant: 'g1' } }
    // The agent works in tab 7.
    noteWorked(7)
    const posts: Array<Record<string, unknown>> = []
    const t0 = Date.now()
    await viewWatch({ ...cmd('view_watch'), args: { tab: 8 } }, busy, async (b) => { posts.push({ ...b, ms: Date.now() - t0 }); return { more: !posts.some((p) => p.shown === true) && Date.now() - t0 < ms } })
    await until(() => !streaming(8), ms + 3000)
    return posts
  }

  it('gets its picture while the agent reads or drives the front tab through its page, and the front tab is put back', async () => {
    // The agent's command on tab 7 needs no screen (a navigate, a text read): it never blocks the view.
    const posts = await watchBehind(() => false, 4000)
    const first = posts.find((p) => p.shown === true)
    expect(first, JSON.stringify(posts.map((p) => p.why ?? 'picture'))).toBeTruthy()
    expect(first!.ms).toBeLessThan(1500)
    // The agent's tab is in front again after the picture.
    expect(fake.front).toBe(7)
    expect(fake.tabUpdates.map((u) => u.id)).toEqual(expect.arrayContaining([8, 7]))
  })

  it('waits while a click holds the front tab, and gets its picture within a moment once the click ends', async () => {
    let held = true
    setTimeout(() => { held = false }, 1500)
    const posts = await watchBehind((id) => held && id === 7, 6000)
    const first = posts.find((p) => p.shown === true)
    expect(posts[0]).toMatchObject({ shown: false, why: 'busy' })
    // Never a freeze: the picture comes no later than a few seconds after the screen is free.
    expect(first, JSON.stringify(posts.map((p) => p.why ?? 'picture'))).toBeTruthy()
    expect(first!.ms).toBeLessThan(1500 + 2500)
    expect(fake.front).toBe(7)
  })
  const frameOf8 = () => viewFrame({ ...cmd('view_frame'), args: { tab: 8 } }, () => false)
  const twoTabs = () => { fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1' }, 8: { owner: OWNER, grant: 'g1' } } }

  it('switches to it at most every BEHIND_EVERY_MS while the agent works in the front tab (its page is not hidden and shown over and over)', async () => {
    twoTabs()
    noteWorked(7)
    expect(await frameOf8()).toMatchObject({ shown: true })
    expect(fake.front).toBe(7)
    const switches = fake.tabUpdates.filter((u) => u.id === 8).length
    expect(await frameOf8()).toMatchObject({ shown: false, why: 'busy' })
    expect(fake.tabUpdates.filter((u) => u.id === 8).length).toBe(switches)
    await new Promise((r) => setTimeout(r, BEHIND_EVERY_MS + 50))
    expect(await frameOf8()).toMatchObject({ shown: true })
  })

  it('a front tab no agent works in is not put back: one switch, none back', async () => {
    twoTabs()
    expect(await frameOf8()).toMatchObject({ shown: true })
    expect(fake.front).toBe(8)
    expect(fake.tabUpdates).toEqual([{ id: 8, o: { active: true } }])
  })

  it('never switches a tab in a window the person is in', async () => {
    twoTabs()
    fake.focused = true
    expect(await frameOf8()).toMatchObject({ shown: false, why: 'behind' })
    expect(fake.tabUpdates).toEqual([])
    // Nor for a click.
    await bringUpForCommand(8)
    expect(fake.tabUpdates).toEqual([])
  })

  it('a click brings its tab to the front of the agent window first, never the window itself', async () => {
    twoTabs()
    await bringUpForCommand(8)
    expect(fake.tabUpdates).toEqual([{ id: 8, o: { active: true } }])
    expect(fake.windowUpdates).toEqual([])
    // A tab the person handed over is never switched.
    fake.tabUpdates = []
    fake.front = 7
    fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1' }, 8: { owner: OWNER, grant: 'g1', handed: true } }
    await bringUpForCommand(8)
    expect(fake.tabUpdates).toEqual([])
  })
})

describe('Take over', () => {
  it('marks the tab the person\'s, brings its window and tab up, and the agent is refused there until Hand back', async () => {
    const out = await takeOver(cmd('view_takeover', { owner: OWNER }))
    expect(out).toMatchObject({ tab: 7, driving: true })
    expect(fake.tabUpdates).toContainEqual({ id: 7, o: { active: true } })
    expect(fake.windowUpdates).toEqual([{ id: 3, o: { focused: true } }])
    expect(fake.messages.at(-1)!.msg).toMatchObject({ type: 'agent-mark', on: true, mode: 'driving' })
    expect(drivingRefusal(await agentTabs.get(7))).toMatchObject({ code: 'person_driving' })
    expect(await handBack(7, OWNER)).toBe(true)
    expect(drivingRefusal(await agentTabs.get(7))).toBeNull()
    expect(fake.messages.at(-1)!.msg).toMatchObject({ type: 'agent-mark', on: true })
    expect(fake.messages.at(-1)!.msg.mode).toBeUndefined()
    // Handed back already: nothing to give.
    expect(await handBack(7, OWNER)).toBe(false)
  })

  it('a tab of the person\'s own window is taken over where it is: their window is never switched or focused', async () => {
    fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1', who: 'x', handed: true } }
    fake.session.agentWindow = 99
    expect(await takeOver(cmd('view_takeover', { owner: OWNER }))).toMatchObject({ driving: true })
    expect(fake.windowUpdates).toEqual([])
    expect(fake.tabUpdates).toEqual([])
  })

  it('while the person has the front tab, no picture of another tab there pulls it away', async () => {
    // Tab 7 in front, taken over; tab 8 behind it, another task's, watched.
    fake.session.agentTabs = { 7: { owner: OWNER, grant: 'g1', driving: Date.now() }, 8: { owner: 'task:other', grant: 'g2' } }
    const posts: Array<Record<string, unknown>> = []
    await viewWatch({ ...cmd('view_watch'), args: { tab: 8 } }, () => false, async (b) => { posts.push(b); return { more: posts.length < 2 } })
    await until(() => !streaming(8), 5000)
    expect(posts[0]).toMatchObject({ tab: 8, shown: false, why: 'behind' })
    expect(fake.tabUpdates).toEqual([])
    expect(fake.captures).toEqual([])
  })

  it('never takes over another owner\'s tab, and never focuses a window for it', async () => {
    await expect(takeOver(cmd('view_takeover', { owner: 'task:other' }))).rejects.toMatchObject({ code: 'not_your_tab' })
    expect(fake.windowUpdates).toEqual([])
    expect(drivingRefusal(await agentTabs.get(7))).toBeNull()
  })
})

describe('the task\'s tab group', () => {
  it('is named walnut-<task name>, short', () => {
    expect(groupTitle('Order printer paper')).toBe('walnut-order-printer-paper')
    expect(groupTitle('Interview')).toBe('walnut-interview')
    expect(groupTitle(undefined)).toBe('walnut-agent')
    expect(groupTitle('  A/B: test, the "checkout" flow!!  ')).toBe('walnut-a-b-test-the-checkout')
    expect([...groupTitle('x'.repeat(80))].length).toBeLessThanOrEqual(32)
    // Exactly at a word's end: nothing lost.
    expect(groupTitle('Pay the electricity bill now')).toBe('walnut-pay-the-electricity-bill')
    // Not Latin: kept as written (面试 is a two-character word).
    expect(groupTitle('面试 prep')).toBe('walnut-面试-prep')
  })

  it('one group per task in the agent window: made once, named, then reused; nothing outside the agent window', async () => {
    const groups = new Map<number, { id: number; title?: string; windowId: number }>()
    const tabs = new Map<number, { id: number; windowId: number; groupId?: number }>([[7, { id: 7, windowId: 3 }], [8, { id: 8, windowId: 3 }], [9, { id: 9, windowId: 5 }]])
    let made = 0
    const session: Record<string, unknown> = {}
    const api = {
      tabs: {
        get: async (id: number) => ({ ...tabs.get(id)! }),
        group: async (o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
          const gid = o.groupId ?? 100 + made++
          if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: o.createProperties?.windowId ?? 3 })
          for (const t of o.tabIds) tabs.get(t)!.groupId = gid
          return gid
        },
      },
      tabGroups: {
        get: async (id: number) => { const g = groups.get(id); if (!g) throw new Error('No group'); return g },
        update: async (id: number, o: { title?: string }) => { groups.get(id)!.title = o.title },
      },
      storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o) } } },
    }
    await groupAgentTab(api as never, 7, OWNER, 'Order printer paper', 3)
    await groupAgentTab(api as never, 8, OWNER, 'Order printer paper', 3)
    await groupAgentTab(api as never, 9, OWNER, 'Order printer paper', 3)
    expect(made).toBe(1)
    expect([...groups.values()]).toEqual([{ id: 100, windowId: 3, title: 'walnut-order-printer-paper' }])
    expect(tabs.get(7)!.groupId).toBe(100)
    expect(tabs.get(8)!.groupId).toBe(100)
    // A tab in the person's window is never grouped.
    expect(tabs.get(9)!.groupId).toBeUndefined()
    // Another task: a group of its own.
    tabs.set(10, { id: 10, windowId: 3 })
    await groupAgentTab(api as never, 10, 'task:other', 'Book a table', 3)
    expect(groups.get(tabs.get(10)!.groupId!)!.title).toBe('walnut-book-a-table')
    // A browser without tab groups: nothing, and no error.
    await expect(groupAgentTab({ ...api, tabGroups: undefined } as never, 7, OWNER, 'x', 3)).resolves.toBeUndefined()
  })
})
