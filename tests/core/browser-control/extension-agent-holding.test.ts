/**
 * One holding of an agent tab, end to end in the extension's own command code
 * (packages/browser-extension/src/agent.ts) against a fake browser (2026-11-07 review, round 2):
 *   - an open that is still starting (its recording attaching, its page loading) when the person
 *     takes the tab back or turns agents off ends there, and never hands the tab back to the agent;
 *   - the Browser view's Stop ends only the holding Walnut names: a tab another task took since
 *     stays that task's.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const ev = () => ({ addListener() {}, removeListener() {} })
const fake = {
  session: {} as Record<string, unknown>,
  tab: { id: 42, windowId: 3, url: 'about:blank', active: true, status: 'complete' } as Record<string, unknown>,
  attachWait: null as null | Promise<void>,
  attached: () => {},
  onNavigate: () => {},
  log: [] as string[],
}
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({ agentControl: true }), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    create: async () => fake.tab, get: async () => fake.tab, query: async () => [fake.tab],
    update: async (_id: number, patch: Record<string, unknown>) => {
      fake.tab = { ...fake.tab, ...patch }
      if (typeof patch.url === 'string') fake.onNavigate()
      return fake.tab
    },
    sendMessage: async () => null,
  },
  windows: { get: async () => ({ state: 'normal' }), onRemoved: ev() },
  permissions: { contains: async () => true, onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push('attach'); fake.attached(); if (fake.attachWait) await fake.attachWait },
    detach: async () => { fake.log.push('detach') },
    sendCommand: async (_t: unknown, m: string) => { fake.log.push(m); return {} },
    onEvent: ev(), onDetach: ev(),
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev() },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { agentTabs, walnutCheck } = await import('../../../packages/browser-extension/src/agent-shared')
const { debuggerHeld } = await import('../../../packages/browser-extension/src/cdp')
walnutCheck.isWalnutPage = async () => false

const open = (record: boolean) => agent._actForTesting({ id: 'c', action: 'open', args: { url: 'https://shop.example.test/', owner: 'task:A', ...(record ? { record: true } : {}) }, allow: { any: true, sites: [] } })
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)

beforeEach(() => {
  fake.session = { agentWindow: 3 }
  fake.tab = { id: 42, windowId: 3, url: 'about:blank', active: true, status: 'complete' }
  fake.attachWait = null
  fake.attached = () => {}
  fake.onNavigate = () => {}
  fake.log = []
})

describe('an open still starting when the person takes the tab back', () => {
  it('with record: a Stop while the debugger attaches ends the open, and the tab stays theirs', async () => {
    let release!: () => void
    fake.attachWait = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { fake.attached = r })
    const opening = open(true)
    await started
    await agent.releaseTab(42)
    release()
    expect(await code(opening)).toBe('not_your_tab')
    expect(await agentTabs.get(42)).toBeUndefined()
    expect(debuggerHeld(42)).toBe(false)
  })

  it('with record: agents turned off while the debugger attaches ends the open', async () => {
    let release!: () => void
    fake.attachWait = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { fake.attached = r })
    const opening = open(true)
    await started
    await agent.agentOff()
    release()
    expect(await code(opening)).toBe('not_your_tab')
    expect(await agentTabs.get(42)).toBeUndefined()
  })

  it('without record: agents turned off while the page loads ends the open', async () => {
    fake.onNavigate = () => { void agent.agentOff() }
    expect(await code(open(false))).toBe('not_your_tab')
    expect(await agentTabs.get(42)).toBeUndefined()
  })

  it('an open nobody interrupts holds the tab', async () => {
    expect(await code(open(true))).toBe('ok')
    expect((await agentTabs.get(42))?.owner).toBe('task:A')
    expect((await agentTabs.get(42))?.grant).toBeTruthy()
    await agent.releaseTab(42)
  })
})

describe('the Browser view\'s Stop ends the holding Walnut names', () => {
  const stop = (owner?: string) => agent._viewActForTesting({ id: 's', action: 'view_stop', args: { tab: 42, ...(owner ? { owner } : {}) }, allow: { any: true, sites: [] } })
  it('a tab another task took since stays that task\'s', async () => {
    await agentTabs.set(42, { owner: 'task:B' })
    expect(await stop('task:A')).toMatchObject({ stopped: false })
    expect((await agentTabs.get(42))?.owner).toBe('task:B')
  })

  it('the holding named ends', async () => {
    await agentTabs.set(42, { owner: 'task:A' })
    expect(await stop('task:A')).toMatchObject({ stopped: true })
    expect(await agentTabs.get(42)).toBeUndefined()
  })
})
