/**
 * The client half of the host call entry (host-call-client-core.ts) against real HTTP servers:
 * the entry's answer is the answer; anything that proves nothing ran (no listener, a server that
 * is not the entry, a refused token, the entry unavailable) hands the line back for the socket;
 * a line that left with no answer is lost (may have run), never sent again. Run as imported and
 * as the text the source twin inlines for its plugin job runs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH, createHostCallClient } from '../../src/providers/host-call-client-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const TOKEN = 'f'.repeat(64)
const LINE = { v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_get', args: { id: 't1' }, callId: 'oc-abcdefgh12' } }
const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)) }))) })

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${HOST_CALL_PATH}`
}

/** A port nothing listens on (bound, then closed). */
async function deadPort(): Promise<string> {
  const url = await serve(() => {})
  const s = servers.pop()!
  await new Promise((r) => s.close(() => r(null)))
  return url
}

function readAll(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => resolve(b)) })
}

function answer(res: http.ServerResponse, status: number, body: unknown, entry = true): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(entry ? { [HOST_CALL_ANSWER_HEADER]: '1' } : {}) })
  res.end(JSON.stringify(body))
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inlined = new Function(`"use strict"; return (${createHostCallClient.toString()})`)() as typeof createHostCallClient

describe('the inlined client reads the same header the entry writes', () => {
  it('the factory names HOST_CALL_ANSWER_HEADER, and the source twin carries it with no placeholder left', () => {
    // The loader may fold the constant into its uses, in either quote style: the name is there.
    expect(createHostCallClient.toString()).toContain(HOST_CALL_ANSWER_HEADER)
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_HOST_CALL_CLIENT__')
    expect(generated).toContain(`hostCall: (${createHostCallClient.toString()})({ http: http, env: process.env })`)
  })
})

describe.each([['imported', createHostCallClient], ['inlined', inlined]] as const)('host call client (%s)', (_label, make) => {
  const client = (url: string, token = TOKEN) => make({ http, env: { WALNUT_CALL_URL: url, WALNUT_CALL_TOKEN: token } })

  it('posts the line with its token and takes the entry\'s answer as the call\'s', async () => {
    let seen: { auth?: string; body?: unknown } = {}
    const url = await serve(async (req, res) => {
      seen = { auth: req.headers.authorization, body: JSON.parse(await readAll(req)) }
      answer(res, 200, { ok: false, error: { code: 'needs_leader', message: 'x' } })
    })
    const o = await client(url).post(LINE, 5_000)
    expect(o).toEqual({ kind: 'answer', resp: { ok: false, error: { code: 'needs_leader', message: 'x' } } })
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    expect(seen.body).toEqual(LINE)
  })

  it('no entry given, a malformed token, or an address off this machine: never posted', async () => {
    expect(make({ http, env: {} }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_URL: 'http://127.0.0.1:1/api/host/call', WALNUT_CALL_TOKEN: 'short' } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_URL: 'http://10.0.0.2:80/api/host/call', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_URL: 'https://127.0.0.1:80/api/host/call', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect((await make({ http, env: {} }).post(LINE, 1_000)).kind).toBe('not_taken')
  })

  it('nothing listening (a follower restarting, on another port now): not taken, nothing ran', async () => {
    const o = await client(await deadPort()).post(LINE, 5_000)
    expect(o.kind).toBe('not_taken')
  })

  it('a server without the entry (an older follower: 404, or a 503 of its dispatcher): not taken', async () => {
    const url404 = await serve((_req, res) => answer(res, 404, { error: 'not found' }, false))
    expect((await client(url404).post(LINE, 5_000)).kind).toBe('not_taken')
    // Even a 200 is not the entry's without its header.
    const url200 = await serve((_req, res) => answer(res, 200, { ok: true, result: {} }, false))
    expect((await client(url200).post(LINE, 5_000)).kind).toBe('not_taken')
  })

  it('a token the entry refused, too many refusals, or the entry unavailable: not taken', async () => {
    for (const [status, body] of [[401, { code: 'token_refused' }], [429, { code: 'too_many_failures' }], [503, { code: 'entry_unavailable' }], [501, { code: 'entry_unavailable' }]] as const) {
      const url = await serve((_req, res) => answer(res, status, body))
      expect((await client(url).post(LINE, 5_000)).kind, String(status)).toBe('not_taken')
    }
  })

  it('a line that left and whose answer broke off: lost (it may have run)', async () => {
    const url = await serve(async (req) => { await readAll(req); req.socket.destroy() })
    const o = await client(url).post(LINE, 5_000)
    expect(o.kind).toBe('lost')
    expect((o as { timeout: boolean }).timeout).toBe(false)
  })

  it('a line that left and got no answer in time: lost, timed out', async () => {
    const url = await serve(() => { /* never answers */ })
    const o = await client(url).post(LINE, 300)
    expect(o).toMatchObject({ kind: 'lost', timeout: true })
  })

  it('an entry answer that is not a call\'s answer: lost, never taken as one', async () => {
    const url = await serve((_req, res) => answer(res, 500, { error: 'boom' }))
    expect((await client(url).post(LINE, 5_000)).kind).toBe('lost')
  })
})
