/**
 * The extension's half of the Browser replay (packages/browser-extension/src/agent-replay.ts),
 * against a fake browser. 2026-11-14, the user: "can we make sure the browser action screenshot or
 * video is saved for 7 days (configurable), and can be played back".
 *
 *   - after a step, the tab in front of its window is pictured once and posted with the step's
 *     token, what the step did and the page's address and title;
 *   - nothing is ever switched, raised or focused for it: a tab not on screen is posted with no
 *     picture (the debugger path is agent-live.ts's own, tested in extension-live-pictures);
 *   - no post for a tab that is no agent's, or Walnut's own page; a failed step says its code.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const ev = () => ({ addListener() {}, removeListener() {} })
const fake = {
  session: {} as Record<string, unknown>,
  captures: 0,
  updates: 0,
  front: 7,
  url: 'https://mail.example.test/inbox',
  windowId: 3,
}
const tab = (id: number) => ({ id, windowId: fake.windowId, active: id === fake.front, url: fake.url, title: 'Inbox' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => p, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({}), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => tab(id),
    query: async () => [tab(fake.front)],
    update: async () => { fake.updates++; return {} },
    captureVisibleTab: async () => { fake.captures++; return 'data:image/jpeg;base64,/9j/AAAA' },
  },
  windows: { get: async () => ({ state: 'normal', focused: false }), update: async () => { fake.updates++; return {} }, onRemoved: ev() },
  permissions: { contains: async () => true },
}

const { replayStep, saidOf } = await import('../../../packages/browser-extension/src/agent-replay')

beforeEach(() => {
  fake.session = { agentTabs: { 7: { owner: 'task:t1' }, 8: { owner: 'task:t1' } }, agentWindow: 3 }
  fake.captures = 0
  fake.updates = 0
  fake.front = 7
  fake.url = 'https://mail.example.test/inbox'
  fake.windowId = 3
})

async function step(tabId: number, answer: { ok: boolean; result?: unknown; error?: { code?: string } }) {
  const posts: Array<Record<string, unknown>> = []
  await replayStep('tok-1', tabId, answer, ['walnut.example.test'], async (b) => { posts.push(b) })
  return posts
}

describe('a step\'s picture', () => {
  it('pictures the tab in front once and posts it with the token and what the step did', async () => {
    const posts = await step(7, { ok: true, result: { clicked: 'button "Send"', changed: 'the page changed' } })
    expect(fake.captures).toBe(1)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ token: 'tok-1', tab: 7, ok: true, said: 'button "Send"', url: 'https://mail.example.test/inbox', title: 'Inbox', image: 'data:image/jpeg;base64,/9j/AAAA' })
    expect(fake.updates).toBe(0)
  })

  it('never brings a tab up for it: a tab behind another goes with no picture', async () => {
    const posts = await step(8, { ok: true, result: { typed: '5 characters into textbox "To"' } })
    expect(fake.captures).toBe(0)
    expect(fake.updates).toBe(0)
    expect(posts[0]).toMatchObject({ tab: 8, said: '5 characters into textbox "To"' })
    expect(posts[0].image).toBeUndefined()
  })

  it('a failed step says its code and no words', async () => {
    const posts = await step(7, { ok: false, error: { code: 'stale_ref' } })
    expect(posts[0]).toMatchObject({ ok: false, code: 'stale_ref' })
    expect(posts[0].said).toBeUndefined()
  })

  it('posts nothing for a tab that is no agent\'s, or Walnut\'s own page', async () => {
    fake.session.agentTabs = {}
    expect(await step(7, { ok: true })).toEqual([])
    fake.session.agentTabs = { 7: { owner: 'task:t1' } }
    fake.url = 'https://walnut.example.test/tasks'
    expect(await step(7, { ok: true })).toEqual([])
    expect(fake.captures).toBe(0)
  })

  it('a browser page is posted with no picture', async () => {
    fake.url = 'chrome://settings'
    const posts = await step(7, { ok: true })
    expect(fake.captures).toBe(0)
    expect(posts[0].image).toBeUndefined()
  })

  it('takes only the picture in the tab\'s turn; the post goes after it, outside the turn', async () => {
    const log: string[] = []
    const inTurn = async <T>(_t: number, w: () => Promise<T>) => { log.push('turn start'); const r = await w(); log.push('turn end'); return r }
    await replayStep('tok-2', 7, { ok: true }, [], async () => { log.push('post') }, inTurn)
    expect(log).toEqual(['turn start', 'turn end', 'post'])
  })

  it('reads what a step did from its answer, never anything else', () => {
    expect(saidOf({ typed: '12 characters into textbox "Email"', text: 'me@bank.test' })).toBe('12 characters into textbox "Email"')
    expect(saidOf({ pressed: 'Enter' })).toBe('Enter')
    expect(saidOf({ value: 'secret' })).toBeUndefined()
    expect(saidOf(null)).toBeUndefined()
  })
})
