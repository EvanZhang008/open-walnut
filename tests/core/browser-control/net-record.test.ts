/**
 * An agent's recording of its own tab (packages/browser-extension/src/net-record.ts, fed by
 * agent-net.ts from the browser's debugger): the requests, with status, type, timing and size, a
 * redirect followed under one id, the console as text, both rings capped, the listing filtered
 * (static resources out unless asked, a status class, a method), addresses from a site where
 * Walnut signed the agent in without their query, and bodies cut to size. Also: an action that
 * needs the debugger uses the recording's session instead of a second attach (cdp.ts).
 */
import { describe, expect, it } from 'vitest'
import { CONSOLE_MAX, NET_MAX, bodyOut, fold, listConsole, listRequests, newRecord } from '../../../packages/browser-extension/src/net-record'
import { cdpClick, debuggerHeld, dropDebugger, holdDebugger, withDebugger } from '../../../packages/browser-extension/src/cdp'

const sent = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId: id, request: { url, method: 'GET' }, type: 'Fetch', timestamp: 100, wallTime: 1_700_000_000, documentURL: 'https://portal.example.test/records', ...extra,
})

describe('the record of a tab', () => {
  it('keeps each request with its status, type, time and size; a redirect stays one entry', () => {
    const r = newRecord(0)
    fold(r, 'Network.requestWillBeSent', sent('1', 'https://portal.example.test/api/records?page=1'))
    fold(r, 'Network.responseReceived', { requestId: '1', type: 'Fetch', response: { status: 200, statusText: 'OK', mimeType: 'application/json' } })
    fold(r, 'Network.loadingFinished', { requestId: '1', timestamp: 100.25, encodedDataLength: 812 })
    fold(r, 'Network.requestWillBeSent', sent('2', 'https://portal.example.test/old', { type: 'Document' }))
    fold(r, 'Network.requestWillBeSent', sent('2', 'https://portal.example.test/new', { type: 'Document', redirectResponse: { status: 302 } }))
    fold(r, 'Network.loadingFailed', { requestId: '2', timestamp: 100.5, errorText: 'net::ERR_ABORTED' })
    const { requests, total } = listRequests(r, {})
    expect(total).toBe(2)
    expect(requests[0]).toEqual({ id: '1', url: 'https://portal.example.test/api/records?page=1', method: 'GET', type: 'Fetch', status: 200, statusText: 'OK', mime: 'application/json', ms: 250, size: 812, at: 1_700_000_000_000, page: 'https://portal.example.test/records' })
    expect(requests[1]).toMatchObject({ id: '2', url: 'https://portal.example.test/new', redirects: 1, failed: 'net::ERR_ABORTED', ms: 500 })
  })

  it('a POST says it carried a body; nothing of the body is kept', () => {
    const r = newRecord(0)
    fold(r, 'Network.requestWillBeSent', { requestId: '9', request: { url: 'https://portal.example.test/api/note', method: 'POST', hasPostData: true, postData: '{"secret":"x"}' }, type: 'XHR' })
    expect(JSON.stringify([...r.requests.values()])).not.toContain('secret')
    expect(listRequests(r, {}).requests[0]).toMatchObject({ method: 'POST', hasBody: true })
  })

  it('filters by address, method, status or its class, and type; images and fonts only when asked', () => {
    const r = newRecord(0)
    const add = (id: string, url: string, type: string, status: number, method = 'GET') => {
      fold(r, 'Network.requestWillBeSent', { ...sent(id, url, { type }), request: { url, method } })
      fold(r, 'Network.responseReceived', { requestId: id, response: { status } })
    }
    add('a', 'https://x.test/api/one', 'XHR', 200)
    add('b', 'https://x.test/api/two', 'Fetch', 404, 'POST')
    add('c', 'https://x.test/logo.png', 'Image', 200)
    add('d', 'https://x.test/font.woff2', 'Font', 200)
    expect(listRequests(r, {}).requests.map((e) => e.id)).toEqual(['a', 'b'])
    expect(listRequests(r, { includeStatic: true }).requests.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(listRequests(r, { status: '4xx' }).requests.map((e) => e.id)).toEqual(['b'])
    expect(listRequests(r, { status: 200 }).requests.map((e) => e.id)).toEqual(['a'])
    expect(listRequests(r, { method: 'post' }).requests.map((e) => e.id)).toEqual(['b'])
    expect(listRequests(r, { type: 'xhr', url: '/api/' }).requests.map((e) => e.id)).toEqual(['a'])
    expect(listRequests(r, { limit: 1 }).requests.map((e) => e.id)).toEqual(['b'])
    expect(listRequests(r, { limit: 1 }).matched).toBe(2)
  })

  it('an address from a site where Walnut signed the agent in loses its query', () => {
    const r = newRecord(0)
    fold(r, 'Network.requestWillBeSent', sent('1', 'https://login.example.test/auth?user=a&pw=hunter2', { documentURL: 'https://login.example.test/' }))
    fold(r, 'Network.requestWillBeSent', sent('2', 'https://cdn.other.test/a.js?v=3', { documentURL: 'https://shop.other.test/' }))
    const out = listRequests(r, {}, (u) => u.startsWith('https://login.example.test/')).requests
    expect(out[0].url).toBe('https://login.example.test/auth?…')
    expect(out[1].url).toBe('https://cdn.other.test/a.js?v=3')
  })

  it('keeps the newest requests and console messages, and counts what went', () => {
    const r = newRecord(0)
    for (let i = 0; i < NET_MAX + 5; i++) fold(r, 'Network.requestWillBeSent', sent(String(i), `https://x.test/${i}`))
    expect(r.requests.size).toBe(NET_MAX)
    expect(r.dropped.requests).toBe(5)
    expect(r.requests.has('0')).toBe(false)
    for (let i = 0; i < CONSOLE_MAX + 3; i++) fold(r, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `m${i}` }] })
    expect(r.console.length).toBe(CONSOLE_MAX)
    expect(r.dropped.console).toBe(3)
  })

  it('reads the console as text, with its level and place; filters by level and above', () => {
    const r = newRecord(0)
    fold(r, 'Runtime.consoleAPICalled', { type: 'log', timestamp: 5, args: [{ type: 'string', value: 'ready' }, { type: 'number', value: 3 }, { type: 'object', description: 'Object' }], stackTrace: { callFrames: [{ url: 'https://x.test/app.js', lineNumber: 9 }] } })
    fold(r, 'Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'slow' }] })
    fold(r, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' }, url: 'https://x.test/app.js', lineNumber: 1 } })
    fold(r, 'Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404', source: 'network', url: 'https://x.test/missing' } })
    expect(r.console[0]).toEqual({ level: 'log', text: 'ready 3 Object', at: 5, source: 'console', where: 'https://x.test/app.js:10' })
    expect(r.console[1].level).toBe('warn')
    expect(listConsole(r, { level: 'warn' }).messages.map((m) => m.text)).toEqual(['slow', 'TypeError: x is undefined', 'Failed to load resource: 404'])
    expect(listConsole(r, { level: 'error' }).messages.map((m) => m.source)).toEqual(['exception', 'network'])
    expect(listConsole(r, { limit: 1 }).messages).toHaveLength(1)
  })

  it('cuts a body to size, and says so; bytes stay base64', () => {
    expect(bodyOut({ body: 'x'.repeat(5000) }, 1000)).toEqual({ body: 'x'.repeat(1000), cut: true, length: 5000 })
    expect(bodyOut({ body: 'QUJD', base64Encoded: true })).toEqual({ body: 'QUJD', base64: true, length: 4 })
    expect(bodyOut({}, 10)).toEqual({ body: '', length: 0 })
  })
})

describe('an action that needs the debugger while the tab records', () => {
  it('uses the recording\'s session: no second attach, and it stays attached', async () => {
    const log: string[] = []
    const dbg = { attach: async () => { log.push('attach') }, detach: async () => { log.push('detach') }, sendCommand: async (_t: unknown, m: string) => { log.push(`own:${m}`) } }
    holdDebugger(5, async (m) => { log.push(`held:${m}`) })
    try {
      expect(debuggerHeld(5)).toBe(true)
      await withDebugger(dbg, 5, (send) => cdpClick(send, 1, 2))
      expect(log).toEqual(['held:Input.dispatchMouseEvent', 'held:Input.dispatchMouseEvent', 'held:Input.dispatchMouseEvent'])
    } finally {
      dropDebugger(5)
    }
    await withDebugger(dbg, 5, async () => undefined)
    expect(log.slice(-2)).toEqual(['attach', 'detach'])
  })
})
