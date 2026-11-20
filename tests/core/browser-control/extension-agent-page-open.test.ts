/**
 * Who may ask for a window through a page's window.open (packages/browser-extension/src/agent-opened.ts pageOpen).
 * The ask comes through the page's own world, so the background opens one only for an agent's own
 * tab of the agent window, during or just after one of its steps, with that step's grant, and only
 * so many at once. Against a fake browser: every refusal opens nothing and tells the page's
 * stand-in it is closed. The opening itself is the Chromium spec's
 * (tests/e2e/browser/extension-agent-outward.spec.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'

const fake = { session: {} as Record<string, unknown>, created: [] as unknown[], updated: [] as unknown[], tabWindow: 3, next: 100 }
const ev = () => ({ addListener() {}, removeListener() {} })
/** tabs.onUpdated: a made tab says it loaded (agent-shared.ts loaded waits for it). */
const updated: Array<(id: number, change: { status?: string; url?: string }) => void> = []
const tab = (id: number) => ({ id, windowId: fake.tabWindow, active: true, url: 'https://site.example.test/login', title: 'Sign in', status: 'complete' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: {
      get: async (k: string) => ({ [k]: structuredClone(fake.session[k]) }),
      set: async (o: Record<string, unknown>) => { Object.assign(fake.session, structuredClone(o)) },
      remove: async (k: string | string[]) => { for (const x of [k].flat()) delete fake.session[x] },
    },
    local: { get: async () => ({ agentControl: true }), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(),
    onUpdated: { addListener: (f: (typeof updated)[number]) => updated.push(f), removeListener: (f: (typeof updated)[number]) => { const i = updated.indexOf(f); if (i >= 0) updated.splice(i, 1) } },
    get: async (id: number) => tab(id), query: async () => [tab(7)],
    create: async (o: unknown) => {
      fake.created.push(o)
      const id = fake.next++
      setTimeout(() => { for (const f of [...updated]) f(id, { status: 'complete' }) }, 5)
      return { id, windowId: 3 }
    },
    update: async (id: number, o: unknown) => { fake.updated.push([id, o]); return tab(id) },
    sendMessage: async () => ({ ok: true }),
  },
  scripting: { executeScript: async () => [{ frameId: 0, result: {} }] },
  windows: { get: async () => ({ id: 3, state: 'normal', focused: false, type: 'normal' }), onRemoved: ev(), update: async () => ({}) },
  permissions: { contains: async () => true, onRemoved: ev() },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const { pageOpen, OPENS_MAX, _resetPageOpenForTesting } = await import('../../../packages/browser-extension/src/agent-opened')
const { opening, stepAllow } = await import('../../../packages/browser-extension/src/agent-shared')
const { _resetOwnForTesting } = await import('../../../packages/browser-extension/src/agent-window-own')

const sender = { id: 'test', tab: tab(7), frameId: 0, url: 'https://site.example.test/login' }
const ask = (o: Record<string, unknown>) => pageOpen({ op: 'open', id: 'k1', url: 'https://login.example.test/oauth', ...o }, sender as never)

beforeEach(() => {
  _resetPageOpenForTesting()
  _resetOwnForTesting()
  fake.created = []
  fake.updated = []
  fake.tabWindow = 3
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:a', who: 'Sign in' } }, agentMade: { 7: 0 } }
  opening.set(7, Date.now() + 10_000)
  stepAllow.set(7, { any: true, sites: [] } as never)
})

describe('a window a page asks for opens only for an agent\'s own step', () => {
  it('refused, nothing opened, the stand-in closed: no step running, no grant, the person\'s tab, a tab they handed over, outside the agent window', async () => {
    opening.set(7, Date.now() - 1)
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    opening.set(7, Date.now() + 10_000)
    stepAllow.delete(7)
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    stepAllow.set(7, { any: true, sites: [] } as never)
    fake.session.agentTabs = {}
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    fake.session.agentTabs = { 7: { owner: 'task:a', handed: 'site.example.test' } }
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    fake.session.agentTabs = { 7: { owner: 'task:a', fromPerson: true } }
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    fake.session.agentTabs = { 7: { owner: 'task:a', who: 'Sign in' } }
    fake.tabWindow = 4
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    expect(fake.created).toEqual([])
  })

  it('a blank window waits for its address; a page\'s close or an unknown ask opens nothing', async () => {
    expect(await ask({ url: '' })).toEqual({ ok: true })
    expect(await ask({ op: 'close' })).toEqual({ ok: true, closed: true })
    expect(await ask({ op: 'print' })).toMatchObject({ ok: false })
    expect(await pageOpen({ op: 'open', id: '' }, sender as never)).toMatchObject({ ok: false, closed: true })
    expect(fake.created).toEqual([])
  })

  it('opens a background tab of the agent window beside the tab; a later address loads the same tab, checked like the first', async () => {
    const r = await ask({})
    expect(r).toMatchObject({ ok: true, tab: expect.any(Number) })
    const made = r.tab!
    expect(fake.created).toEqual([{ url: 'https://login.example.test/oauth', windowId: 3, active: false, openerTabId: 7 }])
    expect(await ask({ op: 'nav', url: 'https://login.example.test/next' })).toEqual({ ok: true })
    expect(fake.updated).toContainEqual([made, { url: 'https://login.example.test/next' }])
    // Not a web page (a later address is checked as the first one is): refused, the tab stays where it was.
    expect(await ask({ op: 'nav', url: 'chrome://settings' })).toMatchObject({ ok: false })
    expect(fake.updated).not.toContainEqual([made, { url: 'chrome://settings' }])
    // An address for a window this background does not know: nothing.
    expect(await ask({ op: 'nav', id: 'unknown', url: 'https://login.example.test/x' })).toMatchObject({ closed: true })
    expect(fake.created).toHaveLength(1)
  })

  it('a page\'s asks for one window keep their order when not awaited: a blank window given its address, an open closed at once', async () => {
    const [blank, nav] = await Promise.all([ask({ id: 'w', url: '' }), ask({ op: 'nav', id: 'w', url: 'https://login.example.test/late' })])
    expect(blank).toEqual({ ok: true })
    expect(nav).toMatchObject({ ok: true, tab: expect.any(Number) })
    expect(fake.created).toEqual([{ url: 'https://login.example.test/late', windowId: 3, active: false, openerTabId: 7 }])
    const [opened, closed] = await Promise.all([ask({ id: 'gone' }), ask({ op: 'close', id: 'gone' })])
    expect(opened).toMatchObject({ ok: false, closed: true })
    expect(closed).toEqual({ ok: true, closed: true })
    expect(fake.created).toHaveLength(1)
  })

  it('nothing while the person drives the tab (taken over)', async () => {
    fake.session.agentTabs = { 7: { owner: 'task:a', who: 'Sign in', driving: Date.now() } }
    expect(await ask({})).toMatchObject({ ok: false, closed: true })
    expect(fake.created).toEqual([])
  })

  it('at most OPENS_MAX new tabs in a short time from one tab, blank windows given their address counted too', async () => {
    for (let i = 0; i < OPENS_MAX - 1; i++) expect(await ask({ id: `b${i}` })).toMatchObject({ ok: true })
    expect(await ask({ id: 'blank', url: '' })).toEqual({ ok: true })
    expect(await ask({ op: 'nav', id: 'blank', url: 'https://login.example.test/late' })).toMatchObject({ ok: true })
    expect(await ask({ id: 'one-more' })).toMatchObject({ ok: false, closed: true, error: 'too many windows' })
    expect(fake.created).toHaveLength(OPENS_MAX)
  })
})
