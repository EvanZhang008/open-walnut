/**
 * Open in Chrome, the extension's half (packages/browser-extension/src/agent-reveal.ts), against a
 * fake browser. 2026-11-17, the user: the Browser view should always have a one-click jump to the
 * task's tab in Chrome, as Take over had, even after the agent closed it.
 *
 *   - the task's own open tab comes to the front of its window, and that window is focused;
 *   - a tab that is another task's now, or was closed, is refused and nothing comes forward;
 *   - with no tab, the page opens through the agent's own open (the agent window), then comes forward;
 *   - only a web address opens; an open that made no tab is an error, and nothing is focused.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const ev = () => ({ addListener() {}, removeListener() {} })
const fake = {
  session: {} as Record<string, unknown>,
  open: new Set<number>([7, 8]),
  windowUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
  tabUpdates: [] as Array<{ id: number; o: Record<string, unknown> }>,
}
const tab = (id: number) => (fake.open.has(id) ? { id, windowId: 3, url: 'https://shop.example.test/', title: 'Shop' } : null)
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => p, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => { const t = tab(id); if (!t) throw new Error('No tab with id'); return t },
    update: async (id: number, o: Record<string, unknown>) => { fake.tabUpdates.push({ id, o }); return tab(id) },
  },
  windows: {
    get: async () => ({ state: 'normal', focused: false }), onRemoved: ev(),
    update: async (id: number, o: Record<string, unknown>) => { fake.windowUpdates.push({ id, o }); return {} },
  },
}

const { reveal } = await import('../../../packages/browser-extension/src/agent-reveal')

const OWNER = 'task:reveal'
const allow = { any: true, sites: [], walnut: ['walnut.example.test'] }
const cmd = (args: Record<string, unknown>) => ({ id: 'c', action: 'view_reveal', args, allow })
const opens: Array<{ url: string; owner: string }> = []
const reopen = async (url: string, owner: string) => { opens.push({ url, owner }); fake.open.add(9); return { tab: 9, url, window: 'agent' } }

beforeEach(() => {
  fake.session = { agentTabs: { 7: { owner: OWNER, grant: 'g1' }, 8: { owner: 'task:other', grant: 'g2' } }, agentWindow: 3 }
  fake.open = new Set([7, 8])
  fake.windowUpdates = []
  fake.tabUpdates = []
  opens.length = 0
})

describe('Open in Chrome in the extension', () => {
  it('brings the task\'s tab to the front of its window and focuses that window', async () => {
    expect(await reveal(cmd({ tab: 7, owner: OWNER }), reopen)).toEqual({ tab: 7, revealed: true })
    expect(fake.tabUpdates).toEqual([{ id: 7, o: { active: true } }])
    expect(fake.windowUpdates).toEqual([{ id: 3, o: { focused: true } }])
    expect(opens).toEqual([])
  })

  it('refuses another task\'s tab and a closed one, and brings nothing forward', async () => {
    await expect(reveal(cmd({ tab: 8, owner: OWNER }), reopen)).rejects.toMatchObject({ code: 'not_your_tab' })
    fake.open.delete(7)
    await expect(reveal(cmd({ tab: 7, owner: OWNER }), reopen)).rejects.toMatchObject({ code: 'not_your_tab' })
    await expect(reveal(cmd({ tab: 7 }), reopen)).rejects.toMatchObject({ code: 'bad_request' })
    expect(fake.tabUpdates).toEqual([])
    expect(fake.windowUpdates).toEqual([])
  })

  it('with no tab, opens the page as the agent\'s own open does, then brings it forward', async () => {
    const out = await reveal(cmd({ url: 'https://shop.example.test/cart', owner: OWNER }), reopen)
    expect(out).toMatchObject({ tab: 9, url: 'https://shop.example.test/cart', revealed: true, reopened: true })
    expect(opens).toEqual([{ url: 'https://shop.example.test/cart', owner: OWNER }])
    expect(fake.windowUpdates).toEqual([{ id: 3, o: { focused: true } }])
  })

  it('opens only a web address, and an open that made no tab focuses nothing', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', '']) {
      await expect(reveal(cmd({ url, owner: OWNER }), reopen)).rejects.toMatchObject({ code: 'bad_request' })
    }
    await expect(reveal(cmd({ url: 'https://shop.example.test/', owner: OWNER }), async () => ({}))).rejects.toMatchObject({ code: 'open_failed' })
    expect(opens).toEqual([])
    expect(fake.windowUpdates).toEqual([])
  })
})
