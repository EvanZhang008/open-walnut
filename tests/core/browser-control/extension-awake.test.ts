/**
 * A covered agent window's page keeps running while an agent works in it (packages/browser-extension/src/agent-awake.ts).
 * 2026-11-17, the user's Chrome: with Walnut's agent window behind his, the page counted as hidden,
 * so the video a site made from the picked file never loaded (readyState 0), its upload sat at
 * "Uploading", and its Post button's checks never finished. Against a fake browser: a step on a
 * hidden page of an agent's own tab holds the debugger with focus emulation on (the page counts as
 * on screen) for AWAKE_MS, later steps there keep it, letting the tab go ends it; nothing is held
 * for a page on screen, a close, a tab of the person's, a tab outside the agent window, or after the
 * person cancelled the debugging bar; and no window or tab is touched.
 * The video itself loading is the Chromium spec's (tests/e2e/browser/extension-awake.spec.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'

const fake = {
  session: {} as Record<string, unknown>,
  log: [] as string[],
  params: [] as Array<[string, unknown]>,
  hidden: true,
  /** The page stays hidden even with emulation on (a window Chrome draws nowhere). */
  stillHidden: false,
  windowCalls: [] as string[],
  tabCalls: [] as string[],
}
const ev = () => ({ addListener() {}, removeListener() {} })
const URL_ = 'https://video.example.test/submit'
const tab = (id = 7) => ({ id, windowId: 3, active: true, url: URL_, title: 'Submit', status: 'complete' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: {
      get: async (k: string) => ({ [k]: structuredClone(fake.session[k]) }),
      set: async (o: Record<string, unknown>) => { Object.assign(fake.session, structuredClone(o)) },
      remove: async (k: string) => { delete fake.session[k] },
    },
    local: { get: async () => ({ agentControl: true }), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    get: async (id: number) => tab(id), query: async () => [tab()],
    update: async (id: number, o: unknown) => { fake.tabCalls.push(`update ${id} ${JSON.stringify(o)}`); return tab(id) },
    sendMessage: async (_id: number, msg: { type: string }) => msg.type === 'agent-check' ? { ok: true, walnut: false, href: URL_, doc: 'd', ...(fake.hidden ? { hidden: true } : {}) } : { ok: true },
  },
  scripting: { executeScript: async () => [{ frameId: 0, result: {} }] },
  windows: {
    get: async () => ({ id: 3, state: 'normal', focused: false, type: 'normal' }), onRemoved: ev(),
    update: async (id: number, o: unknown) => { fake.windowCalls.push(`update ${id} ${JSON.stringify(o)}`); return {} },
  },
  permissions: { contains: async () => true, onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push('attach') },
    detach: async () => { fake.log.push('detach') },
    sendCommand: async (_t: unknown, method: string, params?: unknown) => {
      fake.log.push(method); fake.params.push([method, params])
      if (failEmulation && method.startsWith('Emulation.')) throw new Error('Cannot access a chrome-extension:// URL of different extension')
      if (method === 'Emulation.setFocusEmulationEnabled') fake.hidden = fake.stillHidden || !(params as { enabled: boolean }).enabled
      return {}
    },
    onEvent: ev(),
    onDetach: ev(),
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
let failEmulation = false
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const { AWAKE_MS, NO_WAKE_ACTS, isAwake, wakeForStep } = await import('../../../packages/browser-extension/src/agent-awake')
const cdp = await import('../../../packages/browser-extension/src/cdp')
const { _resetOwnForTesting } = await import('../../../packages/browser-extension/src/agent-window-own')

const wake = (action: string, t = 7) => wakeForStep({ id: 'c', action, args: { tab: t }, allow: { any: true, sites: [] } } as never)
const step = (action: string, t = 7) => wake(action, t).then((r) => r.awake)

beforeEach(() => {
  cdp._resetDebuggerForTesting()
  cdp._setLingerMsForTesting()
  failEmulation = false
  _resetOwnForTesting()
  fake.stillHidden = false
  fake.log = []; fake.params = []; fake.windowCalls = []; fake.tabCalls = []; fake.hidden = true
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:a', who: 'Post the video' } }, agentMade: { 7: 0 } }
})

describe('a covered agent window\'s page keeps running for an upload', () => {
  for (const action of ['upload', 'click', 'snapshot']) it(`${action} on a hidden page: the debugger holds the tab with focus emulation, for AWAKE_MS`, async () => {
    expect(await step(action)).toBe(true)
    expect(fake.log).toEqual(['attach', 'Emulation.setFocusEmulationEnabled'])
    expect(fake.params[0]).toEqual(['Emulation.setFocusEmulationEnabled', { enabled: true }])
    expect(cdp.holdersOf(7)).toEqual(['linger'])
    expect(cdp.lingerLeft(7)).toBeGreaterThan(AWAKE_MS - 5_000)
    expect(isAwake(7)).toBe(true)
    // Nothing on screen changed: no window shown or focused, no tab switched.
    expect(fake.windowCalls).toEqual([])
    expect(fake.tabCalls).toEqual([])
  })

  it('a later step in the tab keeps it awake (the page now reads visible), and a step\'s own linger never cuts it short', async () => {
    await step('upload')
    fake.hidden = false
    expect(await step('snapshot')).toBe(true)
    expect(fake.log.filter((x) => x === 'attach')).toHaveLength(1)
    cdp.linger(chrome.debugger as never, 7)
    expect(isAwake(7)).toBe(true)
  })

  it('the hold ends by itself AWAKE_MS after the last step: detached, and the next step looks at the page again', async () => {
    cdp._setLingerMsForTesting(20)
    const awakeFor = 40
    cdp.linger(chrome.debugger as never, 7)
    // A short hold stands in for AWAKE_MS: woken, then nothing for longer than it.
    await cdp.acquireDebugger(chrome.debugger as never, 7, 'x')
    expect(await cdp.emulateFocus(7)).toBe(true)
    cdp.linger(chrome.debugger as never, 7, awakeFor)
    await cdp.releaseDebugger(chrome.debugger as never, 7, 'x')
    expect(isAwake(7)).toBe(true)
    await new Promise((r) => setTimeout(r, awakeFor + 30))
    expect(cdp.debuggerHeld(7)).toBe(false)
    expect(isAwake(7)).toBe(false)
    fake.hidden = false
    expect(await step('wait')).toBe(false)
  })

  it('a step\'s own short linger never cuts a longer hold short', async () => {
    await step('upload')
    const left = cdp.lingerLeft(7)
    cdp.linger(chrome.debugger as never, 7)
    expect(cdp.lingerLeft(7)).toBeGreaterThan(cdp.LINGER_MS)
    expect(cdp.lingerLeft(7)).toBeLessThanOrEqual(left)
  })

  it('emulation the browser refused holds nothing: detached at once, not awake', async () => {
    failEmulation = true
    expect(await wake('upload')).toEqual({ awake: false, why: 'refused' })
    expect(fake.log).toEqual(['attach', 'Emulation.setFocusEmulationEnabled', 'detach'])
    expect(isAwake(7)).toBe(false)
  })

  it('emulation that leaves the page hidden (a minimized window) keeps no debugging bar, and says so', async () => {
    fake.stillHidden = true
    expect(await wake('upload')).toEqual({ awake: false, why: 'still_hidden' })
    expect(cdp.debuggerHeld(7)).toBe(false)
    expect(fake.log.at(-1)).toBe('detach')
  })

  it('the answer\'s reasons: woke, then kept; a page on screen and a close say nothing', async () => {
    expect(await wake('upload')).toEqual({ awake: true, why: 'woke' })
    expect(await wake('snapshot')).toEqual({ awake: true, why: 'kept' })
    await cdp.endLinger(chrome.debugger as never, 7)
    fake.hidden = false
    expect((await wake('snapshot')).why).toBe('on_screen')
    expect((await wake('close')).why).toBe('no_tab')
  })

  it('the hold ending while a recording keeps the session turns emulation off, and the session stays the recording\'s', async () => {
    await step('upload')
    await cdp.acquireDebugger(chrome.debugger as never, 7, 'record')
    await cdp.endLinger(chrome.debugger as never, 7)
    expect(fake.params.at(-1)).toEqual(['Emulation.setFocusEmulationEnabled', { enabled: false }])
    expect(cdp.holdersOf(7)).toEqual(['record'])
    expect(isAwake(7)).toBe(false)
    // The recording's session is not a woken one: the next step looks at the page again.
    fake.hidden = false
    expect(await step('snapshot')).toBe(false)
  })

  it('a woken tab that left the agent window lets go at once', async () => {
    await step('upload')
    fake.session.agentWindow = 4
    expect(await step('snapshot')).toBe(false)
    expect(cdp.debuggerHeld(7)).toBe(false)
  })

  it('letting the tab go (Stop, take over) ends it at once, and the next step does not wake it again', async () => {
    await step('upload')
    await cdp.endLinger(chrome.debugger as never, 7)
    expect(fake.log.at(-1)).toBe('detach')
    expect(cdp.debuggerHeld(7)).toBe(false)
    fake.hidden = false
    expect(await step('snapshot')).toBe(false)
    expect(fake.log.filter((x) => x === 'attach')).toHaveLength(1)
  })

  it('nothing is held for a page on screen, a close, the person\'s tab, a tab outside the agent window, or after the bar\'s Cancel', async () => {
    fake.hidden = false
    expect(await step('upload')).toBe(false)
    fake.hidden = true
    expect(NO_WAKE_ACTS.has('close')).toBe(true)
    expect(await step('close')).toBe(false)
    fake.session.agentWindow = 4
    expect(await step('click')).toBe(false)
    fake.session.agentWindow = 3
    fake.session.agentTabs = { 7: { owner: 'task:a', handed: 'video.example.test' } }
    expect(await step('upload')).toBe(false)
    fake.session.agentTabs = { 7: { owner: 'task:a', who: 'Post the video' } }
    cdp.noteDetached(99, 'canceled_by_user')
    expect(await step('upload')).toBe(false)
    expect(fake.log).toEqual([])
  })
})
