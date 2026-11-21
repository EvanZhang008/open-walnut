/**
 * The host's `walnut` (wn-cli.ts) with a host call entry in its env: every socket call of the CLI
 * goes to the entry first, and to the socket with the very same line (same call id) only when the
 * entry did not take it; a line the entry took whose answer broke off is a lost answer
 * (hub_timeout), never sent again on the socket. Driven through callHostDaemonTool, the call the
 * installed CLI and the MCP tools in a session make (src/commands/tools.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { callHostDaemonTool } from '../../src/providers/wn-cli.js'
import { HOST_CALL_ANSWER_HEADER } from '../../src/providers/host-call-client-core.js'

const TOKEN = 'd'.repeat(64)
let dir = ''
let n = 0
let socketLines: Array<Record<string, any>> = []
const closers: Array<() => Promise<void>> = []

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcw-'))
  socketLines = []
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      socketLines.push(JSON.parse(buf.slice(0, nl)))
      sock.end(JSON.stringify({ ok: true, result: { via: 'socket' } }) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(path.join(dir, 'gw.sock'), () => resolve()))
  closers.push(() => new Promise((r) => server.close(() => r())))
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function entry(handler: http.RequestListener): Promise<{ url: string; seen: Array<Record<string, any>> }> {
  const seen: Array<Record<string, any>> = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { seen.push(JSON.parse(b)); handler(req, res) })
  })
  const sock = path.join(dir, `entry${n++}.sock`)
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }))
  return { url: sock, seen }
}

const env = (url?: string): NodeJS.ProcessEnv => ({
  WALNUT_AGENT_SOCKET: path.join(dir, 'gw.sock'), WALNUT_SESSION_ID: 'sid-1',
  ...(url ? { WALNUT_CALL_SOCKET: url, WALNUT_CALL_TOKEN: TOKEN } : {}),
})

describe('the host walnut with a host call entry', () => {
  it('no entry given: the socket, as before', async () => {
    expect(await callHostDaemonTool('task_get', { id: 't1' }, env(), 'oc-abcdefgh01')).toEqual({ ok: true, result: { via: 'socket' } })
    expect(socketLines).toHaveLength(1)
  })

  it('the entry answers: its answer, the socket is never asked', async () => {
    const e = await entry((_req, res) => { res.writeHead(200, { [HOST_CALL_ANSWER_HEADER]: '1' }); res.end(JSON.stringify({ ok: true, result: { via: 'entry' } })) })
    expect(await callHostDaemonTool('task_get', { id: 't1' }, env(e.url), 'oc-abcdefgh02')).toEqual({ ok: true, result: { via: 'entry' } })
    expect(e.seen).toEqual([{ v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_get', args: { id: 't1' }, callId: 'oc-abcdefgh02' } }])
    expect(socketLines).toEqual([])
  })

  it('a server that is not the entry (an older follower) or nothing listening: the very same line on the socket', async () => {
    const old = await entry((_req, res) => { res.writeHead(404); res.end('{}') })
    expect(await callHostDaemonTool('task_update', { id: 't1' }, env(old.url), 'oc-abcdefgh03')).toEqual({ ok: true, result: { via: 'socket' } })
    expect(socketLines).toEqual(old.seen)
    const gone = await entry(() => {})
    const goneUrl = gone.url
    await closers.pop()!()
    expect(await callHostDaemonTool('task_update', { id: 't2' }, env(goneUrl), 'oc-abcdefgh04')).toEqual({ ok: true, result: { via: 'socket' } })
    expect(socketLines.at(-1)!.args.callId).toBe('oc-abcdefgh04')
  })

  it('the entry refused the token: the socket', async () => {
    const e = await entry((_req, res) => { res.writeHead(401, { [HOST_CALL_ANSWER_HEADER]: '1' }); res.end('{"code":"token_refused"}') })
    expect(await callHostDaemonTool('task_get', {}, env(e.url), 'oc-abcdefgh05')).toEqual({ ok: true, result: { via: 'socket' } })
  })

  it('the entry took the line and its answer broke off: hub_timeout, never sent again on the socket', async () => {
    const e = await entry((req) => { req.socket.destroy() })
    const resp = await callHostDaemonTool('task_create', { title: 'x' }, env(e.url), 'oc-abcdefgh06')
    expect(resp).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
    expect(e.seen).toHaveLength(1)
    expect(socketLines).toEqual([])
  })
})
