/**
 * What an agent may read of its tab's recording (packages/browser-extension/src/agent-net.ts),
 * and when its live picture counts (agent-view.ts), against a fake browser that sends the
 * debugger's own events. Each case is one the 2026-11-07 review reproduced:
 *   - a body of a request to a site agents may not use, or to Walnut, is never read, and the
 *     listing leaves such requests out (also when only a redirect or the page that sent it was one);
 *   - a console message logged by a page Walnut signed the agent in on stays unreadable after the
 *     agent moves to another page;
 *   - a Stop while the debugger still attaches ends the recording: nothing records after it;
 *   - a frame whose tab moved to another page, or was given back, during the capture has no picture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (source: { tabId?: number }, method: string, params: unknown) => void
const fake = {
  session: {} as Record<string, unknown>,
  url: 'https://login.example.test/',
  events: [] as Listener[],
  log: [] as string[],
  attachWait: null as null | Promise<void>,
  beforeCapture: () => {},
  shownId: 7,
  permRemoved: [] as Array<(p: { permissions?: string[] }) => void>,
  detached: [] as Array<(source: { tabId?: number }, reason: string) => void>,
  /** Runs once inside the next debugger command (a redirect that lands while a body is read). */
  duringSend: null as null | (() => void),
}
const ev = () => ({ addListener() {}, removeListener() {} })
const tab = () => ({ id: 7, windowId: 3, active: true, url: fake.url, title: 'Page' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => p, onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) } },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onRemoved: ev(), onUpdated: ev(),
    get: async () => tab(),
    query: async () => [{ ...tab(), id: fake.shownId }],
    update: async () => tab(),
    captureVisibleTab: async () => { fake.beforeCapture(); return 'data:image/jpeg;base64,AAAA' },
  },
  windows: { get: async () => ({ state: 'normal' }), onRemoved: ev() },
  permissions: { contains: async () => true, onRemoved: { addListener: (fn: (p: { permissions?: string[] }) => void) => fake.permRemoved.push(fn), removeListener() {} } },
  debugger: {
    attach: async () => { fake.log.push('attach'); if (fake.attachWait) await fake.attachWait },
    detach: async () => { fake.log.push('detach') },
    sendCommand: async (_t: unknown, method: string) => {
      fake.log.push(method)
      if (fake.duringSend && method.startsWith('Network.get')) { const f = fake.duringSend; fake.duringSend = null; f() }
      if (method === 'Network.getResponseBody') return { body: 'response body' }
      if (method === 'Network.getRequestPostData') return { postData: 'a=1' }
      return {}
    },
    onEvent: { addListener: (fn: Listener) => fake.events.push(fn), removeListener() {} },
    onDetach: { addListener: (fn: (source: { tabId?: number }, reason: string) => void) => fake.detached.push(fn), removeListener() {} },
  },
}

const { startRecording, stopRecording, netAct } = await import('../../../packages/browser-extension/src/agent-net')
const { agentTabs, noteFilled, walnutCheck } = await import('../../../packages/browser-extension/src/agent-shared')
/** Runs once inside the next Walnut-page check (a redirect that lands while a request is judged). */
let duringCheck: null | (() => void) = null
walnutCheck.isWalnutPage = async () => { await Promise.resolve(); if (duringCheck) { const f = duringCheck; duringCheck = null; f() } return false }
const { debuggerHeld } = await import('../../../packages/browser-extension/src/cdp')
const { viewFrame } = await import('../../../packages/browser-extension/src/agent-view')

const OWNER = 'task:boundaries'
const rec = { owner: OWNER }
const allow = { any: false, sites: ['example.test'], walnut: ['walnut.example.test'] }
const cmd = (action: string, args: Record<string, unknown> = {}) => ({ id: 'c', action, args: { tab: 7, ...args }, allow })
const emit = (method: string, p: unknown) => fake.events.forEach((fn) => fn({ tabId: 7 }, method, p))
const sent = (id: string, url: string, page: string, extra: Record<string, unknown> = {}) =>
  emit('Network.requestWillBeSent', { requestId: id, documentURL: page, type: 'Fetch', request: { method: 'GET', url }, ...extra })
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)

beforeEach(async () => {
  await stopRecording(7)
  fake.session = { agentTabs: { 7: rec } }
  fake.url = 'https://login.example.test/'
  fake.log = []
  fake.attachWait = null
  fake.duringSend = null
  duringCheck = null
  fake.beforeCapture = () => {}
  fake.shownId = 7
})

describe('network reads keep the site rules', () => {
  it('reads no body of a request to a site agents may not use, or to Walnut, and lists none', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    sent('ok', 'https://shop.example.test/api/cart', 'https://shop.example.test/')
    sent('off', 'https://elsewhere.other.test/account', 'https://elsewhere.other.test/account')
    sent('walnut', 'https://walnut.example.test/api/tasks', 'https://shop.example.test/')
    sent('framed', 'https://shop.example.test/api/x', 'https://elsewhere.other.test/frame')
    sent('hop', 'https://elsewhere.other.test/next', 'https://shop.example.test/')
    sent('hop', 'https://shop.example.test/landed', 'https://shop.example.test/', { redirectResponse: { status: 302 } })
    for (const id of ['ok', 'off', 'walnut', 'framed', 'hop']) emit('Network.responseReceived', { requestId: id, response: { status: 200 } })

    for (const id of ['off', 'walnut', 'framed', 'hop']) {
      expect(await code(netAct(cmd('network_body', { request_id: id }), 7, rec))).toBe('request_site_not_allowed')
      expect(await code(netAct(cmd('network_request_body', { request_id: id }), 7, rec))).toBe('request_site_not_allowed')
    }
    expect(fake.log.filter((m) => m === 'Network.getResponseBody')).toHaveLength(0)
    expect(await netAct(cmd('network_body', { request_id: 'ok' }), 7, rec)).toMatchObject({ body: 'response body' })

    const list = await netAct(cmd('network'), 7, rec) as { requests: Array<{ id: string }>; withheld: number }
    expect(list.requests.map((e) => e.id)).toEqual(['ok'])
    expect(list.withheld).toBe(4)
  })

  it('masks every address of a request on a site Walnut signed the agent in on, the page and the redirect chain too', async () => {
    await startRecording(7, rec)
    await noteFilled(OWNER, 'https://login.example.test/')
    sent('nav', 'https://login.example.test/start?pw=hunter2', 'https://login.example.test/start?pw=hunter2', { type: 'Document' })
    sent('nav', 'https://login.example.test/home', 'https://login.example.test/home', { type: 'Document', redirectResponse: { status: 302 } })
    sent('sub', 'https://cdn.example.test/app.js', 'https://login.example.test/start?pw=hunter2')
    const list = await netAct(cmd('network', { include_static: true }), 7, rec) as { requests: unknown[] }
    expect(JSON.stringify(list)).not.toContain('hunter2')
    // Filtering on the hidden part finds nothing, whatever is guessed.
    for (const guess of ['pw=h', 'pw=x', 'hunter2']) {
      expect((await netAct(cmd('network', { url: guess }), 7, rec) as { matched: number }).matched).toBe(0)
    }
    const head = await netAct(cmd('network_body', { request_id: 'sub' }), 7, rec)
    expect(JSON.stringify(head)).not.toContain('hunter2')
    expect(await code(netAct(cmd('network_request_body', { request_id: 'sub' }), 7, rec))).toBe('filled_here')
  })
})

describe('a body read is of the request that was judged', () => {
  it('a redirect to a site agents may not use while the request is judged reads no body', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    sent('go', 'https://shop.example.test/go', 'https://shop.example.test/')
    duringCheck = () => {
      sent('go', 'https://bank.other.test/statement', 'https://bank.other.test/statement', { redirectResponse: { status: 302 } })
      emit('Network.responseReceived', { requestId: 'go', response: { status: 200 } })
    }
    expect(['request_site_not_allowed', 'request_changed']).toContain(await code(netAct(cmd('network_body', { request_id: 'go' }), 7, rec)))
    expect(fake.log).not.toContain('Network.getResponseBody')
  })

  it('a redirect while the browser hands the body over gives no body', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    sent('go', 'https://shop.example.test/go', 'https://shop.example.test/')
    emit('Network.responseReceived', { requestId: 'go', response: { status: 200 } })
    await netAct(cmd('network'), 7, rec)
    fake.duringSend = () => sent('go', 'https://bank.other.test/statement', 'https://bank.other.test/statement', { redirectResponse: { status: 302 } })
    expect(await code(netAct(cmd('network_body', { request_id: 'go' }), 7, rec))).toBe('request_changed')
  })

  it('a listing never shows a request that came in or moved while it was judged', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    sent('go', 'https://shop.example.test/go', 'https://shop.example.test/')
    duringCheck = () => sent('go', 'https://bank.other.test/statement', 'https://bank.other.test/statement', { redirectResponse: { status: 302 } })
    const out = await netAct(cmd('network'), 7, rec) as { requests: unknown[] }
    expect(JSON.stringify(out.requests)).not.toContain('bank.other.test')
  })
})

describe('every address in an answer is masked on a signed-in site', () => {
  it('the tab\'s own address and a console message\'s text lose their query too', async () => {
    await startRecording(7, rec)
    await noteFilled(OWNER, 'https://login.example.test/')
    fake.url = 'https://login.example.test/auth?pw=hunter2'
    emit('Runtime.executionContextCreated', { context: { id: 3, origin: 'https://shop.example.test' } })
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 3, args: [{ type: 'string', value: 'came from https://login.example.test/auth?pw=hunter2' }] })
    sent('n', 'https://login.example.test/auth?pw=hunter2', 'https://login.example.test/auth?pw=hunter2', { type: 'Document' })
    // A sign-in on login.example.test may post to another host of the site.
    sent('p', 'https://auth.example.test/session?pw=hunter2', 'https://auth.example.test/session?pw=hunter2', { type: 'Document' })
    for (const action of ['network', 'console']) {
      const out = await netAct(cmd(action), 7, rec)
      expect(JSON.stringify(out), action).not.toContain('hunter2')
    }
    expect(JSON.stringify(await netAct(cmd('network_body', { request_id: 'n' }), 7, rec))).not.toContain('hunter2')
  })
})

describe('the console of a signed-in page', () => {
  it('stays unreadable after the agent moves to another page', async () => {
    await startRecording(7, rec)
    emit('Runtime.executionContextCreated', { context: { id: 1, origin: 'https://login.example.test' } })
    emit('Runtime.executionContextCreated', { context: { id: 2, origin: 'https://shop.example.test' } })
    await noteFilled(OWNER, 'https://login.example.test/')
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 1, args: [{ type: 'string', value: 'secret-from-login' }] })
    emit('Runtime.exceptionThrown', { exceptionDetails: { executionContextId: 1, text: 'secret-error-from-login' } })
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'unknown-page' }] })
    fake.url = 'https://shop.example.test/'
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 2, args: [{ type: 'string', value: 'shop ready' }] })
    const out = await netAct(cmd('console'), 7, rec) as { messages: Array<{ text: string }>; withheld: number }
    expect(out.messages.map((m) => m.text)).toEqual(['shop ready'])
    expect(out.withheld).toBe(3)
  })

  it('reads a page\'s console when Walnut signed in nowhere', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    emit('Runtime.executionContextCreated', { context: { id: 2, origin: 'https://shop.example.test' } })
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 2, args: [{ type: 'string', value: 'plain' }] })
    emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404', source: 'network', url: 'https://shop.example.test/missing.js' } })
    const out = await netAct(cmd('console'), 7, rec) as { messages: Array<{ text: string }> }
    expect(out.messages.map((m) => m.text)).toEqual(['plain', 'Failed to load resource: 404'])
  })

  it('gives no message from an unknown or opaque place, a site agents may not use, or Walnut, signed in or not', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    emit('Runtime.executionContextCreated', { context: { id: 5, origin: 'null' } })
    emit('Runtime.executionContextCreated', { context: { id: 6, origin: 'https://bank.other.test' } })
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'no-context' }] })
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 5, args: [{ type: 'string', value: 'opaque-frame' }] })
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 6, args: [{ type: 'string', value: 'other-site-frame' }] })
    emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'exception-without-context' } })
    emit('Log.entryAdded', { entry: { level: 'error', text: 'bank-token-123', source: 'network', url: 'https://bank.other.test/statement' } })
    emit('Log.entryAdded', { entry: { level: 'error', text: 'walnut-token-456', source: 'network', url: 'https://walnut.example.test/api/tasks' } })
    emit('Log.entryAdded', { entry: { level: 'warning', text: 'no-url-browser-note', source: 'intervention' } })
    const out = await netAct(cmd('console'), 7, rec) as { messages: unknown[]; withheld: number }
    expect(out.messages).toEqual([])
    expect(out.withheld).toBe(7)
  })
})

describe('Stop while the recording starts', () => {
  it('leaves nothing recording and the debugger let go', async () => {
    let attached!: () => void
    fake.attachWait = new Promise<void>((r) => { attached = r })
    const starting = startRecording(7, rec)
    await vi.waitFor(() => expect(fake.log).toContain('attach'))
    // The person's Stop: the tab is no agent's, its recording ends.
    await agentTabs.delete(7)
    expect(await stopRecording(7)).toBe(false)
    attached()
    expect(await code(starting)).toBe('not_your_tab')
    expect(debuggerHeld(7)).toBe(false)
    expect(fake.log).toContain('detach')
    expect(fake.log).not.toContain('Network.enable')
  })

  it('a Stop alone (the tab still listed) also wins over the attach', async () => {
    let attached!: () => void
    fake.attachWait = new Promise<void>((r) => { attached = r })
    const starting = startRecording(7, rec)
    await vi.waitFor(() => expect(fake.log).toContain('attach'))
    await stopRecording(7)
    attached()
    expect(await code(starting)).toBe('not_your_tab')
    expect(debuggerHeld(7)).toBe(false)
  })
})

describe('Cancel on the debugging bar while the debugger attaches', () => {
  it('is kept: the start ends, and no agent records in that tab again', async () => {
    // A tab of its own: a Cancel is for good in that tab.
    (fake.session.agentTabs as Record<string, unknown>)['9'] = rec
    let attached!: () => void
    fake.attachWait = new Promise<void>((r) => { attached = r })
    const starting = startRecording(9, rec)
    await vi.waitFor(() => expect(fake.log).toContain('attach'))
    fake.detached.forEach((fn) => fn({ tabId: 9 }, 'canceled_by_user'))
    attached()
    expect(await code(starting)).toBe('recording_cancelled')
    expect(debuggerHeld(9)).toBe(false)
    fake.attachWait = null
    const attachesBefore = fake.log.filter((m) => m === 'attach').length
    expect(await code(startRecording(9, rec))).toBe('recording_cancelled')
    expect(fake.log.filter((m) => m === 'attach').length).toBe(attachesBefore)
  })
})

describe('real input turned off', () => {
  it('ends every recording: the debugger lets go', async () => {
    fake.url = 'https://shop.example.test/'
    await startRecording(7, rec)
    expect(debuggerHeld(7)).toBe(true)
    fake.permRemoved.forEach((fn) => fn({ permissions: ['debugger'] }))
    await vi.waitFor(() => expect(debuggerHeld(7)).toBe(false))
    expect(fake.log.at(-1)).toBe('detach')
  })
})

describe('a frame checks the page and the owner after the capture', () => {
  const view = { id: 'v', action: 'view_frame', args: { tab: 7 }, allow }
  it('has no picture when the tab moved to another page during the capture', async () => {
    fake.url = 'https://shop.example.test/'
    fake.beforeCapture = () => { fake.url = 'https://walnut.example.test/private' }
    const out = await viewFrame(view, () => false)
    expect(out).toMatchObject({ shown: false, why: 'changed' })
    expect(out.image).toBeUndefined()
  })

  it('has no picture when the tab was given back during the capture', async () => {
    fake.url = 'https://shop.example.test/'
    fake.beforeCapture = () => { (fake.session.agentTabs as Record<string, unknown>)['7'] = undefined }
    expect(await code(viewFrame(view, () => false))).toBe('not_your_tab')
  })

  it('pictures a tab that stayed', async () => {
    fake.url = 'https://shop.example.test/'
    expect(await viewFrame(view, () => false)).toMatchObject({ shown: true })
  })
})
