/**
 * The client half of the host call entry (host-call-client-core.ts) against real HTTP servers on
 * unix sockets:
 * the entry's answer is the answer; anything that proves nothing ran (no listener, a server that
 * is not the entry, a refused token, the entry unavailable) hands the line back for the socket;
 * a line that left with no answer is lost (may have run), never sent again.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH, createHostCallClient } from '../../src/providers/host-call-client-core.js'

const TOKEN = 'f'.repeat(64)
const LINE = { v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_get', args: { id: 't1' }, callId: 'oc-abcdefgh12' } }
const servers: http.Server[] = []
let dir = ''
let n = 0
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-')) })
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)) })))
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A server on a unix socket of its own; its path. */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  const sock = path.join(dir, `e${n++}.sock`)
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  return sock
}

/** A socket file nothing listens on any more (a follower that died), and a path with no file. */
async function deadSocket(): Promise<string> {
  const sock = path.join(dir, `dead${n++}.sock`)
  const s = http.createServer(() => {})
  await new Promise<void>((resolve) => s.listen(sock, () => resolve()))
  // Close the listener but keep the file, as a killed process leaves it.
  const handle = (s as unknown as { _handle?: { close?: () => void } })._handle
  if (handle?.close) handle.close()
  else await new Promise((r) => s.close(() => r(null)))
  if (!fs.existsSync(sock)) fs.writeFileSync(sock, '')
  return sock
}

function readAll(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => resolve(b)) })
}

function answer(res: http.ServerResponse, status: number, body: unknown, entry = true): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(entry ? { [HOST_CALL_ANSWER_HEADER]: '1' } : {}) })
  res.end(JSON.stringify(body))
}

describe('the client reads the same header the entry writes', () => {
  it('the factory names HOST_CALL_ANSWER_HEADER', () => {
    // The loader may fold the constant into its uses, in either quote style: the name is there.
    expect(createHostCallClient.toString()).toContain(HOST_CALL_ANSWER_HEADER)
  })
})

describe('host call client', () => {
  const make = createHostCallClient
  const client = (sock: string, token = TOKEN) => make({ http, env: { WALNUT_CALL_SOCKET: sock, WALNUT_CALL_TOKEN: token } })

  it('posts the line with its token to the entry\'s path on the socket and takes the entry\'s answer as the call\'s', async () => {
    let seen: { auth?: string; body?: unknown; url?: string; forwarded?: unknown } = {}
    const url = await serve(async (req, res) => {
      seen = { auth: req.headers.authorization, body: JSON.parse(await readAll(req)), url: req.url, forwarded: req.headers['x-forwarded-for'] }
      answer(res, 200, { ok: false, error: { code: 'needs_leader', message: 'x' } })
    })
    const o = await client(url).post(LINE, 5_000)
    expect(o).toEqual({ kind: 'answer', resp: { ok: false, error: { code: 'needs_leader', message: 'x' } } })
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    expect(seen.body).toEqual(LINE)
    expect(seen.url).toBe(HOST_CALL_PATH)
    expect(seen.forwarded).toBeUndefined()
  })

  it('no entry given, a malformed token, an address that is no absolute socket path (an old http one too): never posted', async () => {
    expect(make({ http, env: {} }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_SOCKET: '/d/host-call/0123456789abcdef.sock', WALNUT_CALL_TOKEN: 'short' } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_SOCKET: 'host-call/0123456789abcdef.sock', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_SOCKET: 'http://127.0.0.1:80/api/host/call', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_SOCKET: '/' + 'a'.repeat(120) + '.sock', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_URL: 'http://127.0.0.1:80/api/host/call', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toBeNull()
    expect(make({ http, env: { WALNUT_CALL_SOCKET: '/d/host-call/0123456789abcdef.sock', WALNUT_CALL_TOKEN: TOKEN } }).entry()).toEqual({ socketPath: '/d/host-call/0123456789abcdef.sock', token: TOKEN })
    expect((await make({ http, env: {} }).post(LINE, 1_000)).kind).toBe('not_taken')
  })

  it('nothing listening (no socket file, or a stale one a dead follower left): not taken, nothing ran', async () => {
    expect((await client(path.join(dir, 'none.sock')).post(LINE, 5_000)).kind).toBe('not_taken')
    expect((await client(await deadSocket()).post(LINE, 5_000)).kind).toBe('not_taken')
  })

  it('a server without the entry (an older follower: 404, or a 503 of its dispatcher): not taken', async () => {
    const url404 = await serve((_req, res) => answer(res, 404, { error: 'not found' }, false))
    expect((await client(url404).post(LINE, 5_000)).kind).toBe('not_taken')
    // Even a 200 is not the entry's without its header.
    const url200 = await serve((_req, res) => answer(res, 200, { ok: true, result: {} }, false))
    expect((await client(url200).post(LINE, 5_000)).kind).toBe('not_taken')
  })

  it('a token the entry refused, a forwarded request refused, or the entry unavailable: not taken', async () => {
    for (const [status, body] of [[401, { code: 'token_refused' }], [403, { code: 'forwarded' }], [429, { code: 'too_many_failures' }], [503, { code: 'entry_unavailable' }], [501, { code: 'entry_unavailable' }]] as const) {
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
