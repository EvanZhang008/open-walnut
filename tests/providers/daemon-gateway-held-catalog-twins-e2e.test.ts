/**
 * tools-list-held-v1 on the real daemon twins (the JS source twin under node, the standalone
 * twin under bun when bun is installed): the gateway holds the op catalogs the server sent,
 * names them in the next `tools.list {schemas: true}` relay (`have`), and hands the caller
 * the held catalog when the server answers `{sameAs: hash}`.
 *
 * 2026-11-14: about 20 sessions starting at once on a host that had just reconnected each
 * asked for the catalog, and each got all of it (about 130 KB gzipped): 2.6 MB up one session
 * link in 10 s, and the relay on the SSH path ended the link.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths and the daemon is
 * SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
let rpcId = 1
let daemonDir = ''

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wbh-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '8000',
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')), 30_000)).toBe(true)
  return port
}

type Relay = Record<string, unknown> & { relayId: number; capability: string; payload: Record<string, unknown> }

/** A server's socket: open it and say hello with its run; every relay it is sent. */
async function connect(port: number, run: string): Promise<{ ws: WebSocket; requests: Relay[]; hello: Record<string, unknown> }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const requests: Relay[] = []
  ws.on('message', (data: Buffer) => {
    try {
      const m = JSON.parse(data.toString()) as Relay
      if (m.ev === 'gateway-request') requests.push(m)
    } catch { /* not a frame */ }
  })
  const hello = await rpc(ws, { cmd: 'hello', run })
  expect(hello.ok).toBe(true)
  return { ws, requests, hello }
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/** A session's `walnut mcp-server` asking for its tool list: one NDJSON line on the gateway socket. */
function listTools(sid: string, args: Record<string, unknown> = { schemas: true }): Promise<{ resp: Record<string, unknown>; lines: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('gateway timeout')) }, 30_000)
    sock.on('connect', () => sock.write(JSON.stringify({ v: 1, op: 'tools.list', sid, args }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      const resp = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      // A moment more: a second answer line would be a bug.
      setTimeout(() => { sock.destroy(); resolve({ resp, lines: buf.split('\n').filter(Boolean).length }) }, 300)
    })
    sock.on('close', () => { if (buf.includes('\n')) return; clearTimeout(timer); reject(new Error('gateway socket closed with no answer')) })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

const answer = (ws: WebSocket, relayId: unknown, result: Record<string, unknown>) => rpc(ws, { cmd: 'gateway-result', relayId, result })

/** A catalog as the server sends it: its ops and the hash naming them. */
function catalog(hash: string, n = 3): Record<string, unknown> {
  return {
    ops: Array.from({ length: n }, (_, i) => ({ name: `op_${hash}_${i}`, title: `Op ${i}`, description: 'd', readonly: true, inputSchema: { type: 'object', properties: {} } })),
    catalogHash: hash,
  }
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

function daemonLog(): string {
  try {
    return fs.readdirSync(daemonDir).filter((f) => /^daemon-.*\.log$/.test(f)).map((f) => fs.readFileSync(path.join(daemonDir, f), 'utf8')).join('\n')
  } catch { return '' }
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-held-twins-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

it('tools-list-held-v1 is advertised', () => {
  expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('tools-list-held-v1')
})

for (const twin of TWINS) {
  describe(`the gateway holds the tool catalogs it was sent, ${twin.name}`, () => {
    it('the second session gets its catalog from the host: the server sends only its hash', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      expect(server.hello.capabilities).toContain('tools-list-held-v1')
      const full = catalog('aaaaaaaaaaaaaaaa', 40)

      // The first session: nothing is held, so nothing is named; the full answer is held.
      const first = listTools('external')
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      expect(server.requests[0].capability).toBe('tools.list')
      expect(server.requests[0].payload).toEqual({ schemas: true })
      expect((await answer(server.ws, server.requests[0].relayId, full)).ok).toBe(true)
      expect((await first).resp).toEqual({ ok: true, result: full })

      // The second: the held hash is named; the server answers with it alone, the caller gets it all.
      const second = listTools('external')
      expect(await waitFor(() => server.requests.length === 2)).toBe(true)
      expect(server.requests[1].payload).toEqual({ schemas: true, have: ['aaaaaaaaaaaaaaaa'] })
      expect((await answer(server.ws, server.requests[1].relayId, { sameAs: 'aaaaaaaaaaaaaaaa' })).ok).toBe(true)
      const got = await second
      expect(got.resp).toEqual({ ok: true, result: full })
      expect(got.lines).toBe(1)
      expect(server.requests.length).toBe(2)

      // The plain list (the `walnut` CLI's) names nothing, and a caller's own `have` is never sent on.
      const plain = listTools('external', {})
      expect(await waitFor(() => server.requests.length === 3)).toBe(true)
      expect(server.requests[2].payload).toEqual({})
      expect((await answer(server.ws, server.requests[2].relayId, { ops: [] })).ok).toBe(true)
      expect((await plain).resp).toEqual({ ok: true, result: { ops: [] } })
      const forged = listTools('external', { schemas: true, have: ['ffffffffffffffff'] })
      expect(await waitFor(() => server.requests.length === 4)).toBe(true)
      expect(server.requests[3].payload).toEqual({ schemas: true, have: ['aaaaaaaaaaaaaaaa'] })
      expect((await answer(server.ws, server.requests[3].relayId, { sameAs: 'aaaaaaaaaaaaaaaa' })).ok).toBe(true)
      expect((await forged).resp).toEqual({ ok: true, result: full })
    }, 90_000)

    it('five sessions starting at once on a cold host cost one full catalog: the rest wait for it and name it', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const full = catalog('cccccccccccccccc', 40)
      const asks = Array.from({ length: 5 }, () => listTools('external'))
      expect(await waitFor(() => server.requests.length >= 1)).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      // Only the first went; the others wait for what it brings.
      expect(server.requests.length).toBe(1)
      expect(server.requests[0].payload).toEqual({ schemas: true })
      expect((await answer(server.ws, server.requests[0].relayId, full)).ok).toBe(true)
      expect(await waitFor(() => server.requests.length === 5)).toBe(true)
      for (const r of server.requests.slice(1)) {
        expect(r.payload).toEqual({ schemas: true, have: ['cccccccccccccccc'] })
        expect((await answer(server.ws, r.relayId, { sameAs: 'cccccccccccccccc' })).ok).toBe(true)
      }
      for (const got of await Promise.all(asks)) expect(got.resp).toEqual({ ok: true, result: full })
    }, 90_000)

    it('a hash the host no longer holds is asked for again in full, once; a caller never gets a sameAs', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      // Held: one catalog.
      const first = listTools('external')
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      expect((await answer(server.ws, server.requests[0].relayId, catalog('aaaaaaaaaaaaaaaa'))).ok).toBe(true)
      await first

      // The server names one this host never held (it was dropped, or this daemon restarted).
      const second = listTools('external')
      expect(await waitFor(() => server.requests.length === 2)).toBe(true)
      expect(server.requests[1].payload.have).toEqual(['aaaaaaaaaaaaaaaa'])
      expect((await answer(server.ws, server.requests[1].relayId, { sameAs: 'bbbbbbbbbbbbbbbb' })).ok).toBe(true)
      // The same call goes again as a NEW relay, with nothing named.
      expect(await waitFor(() => server.requests.length === 3)).toBe(true)
      expect(server.requests[2].relayId).not.toBe(server.requests[1].relayId)
      expect(server.requests[2].payload).toEqual({ schemas: true })
      expect(server.requests[2].callerSid).toBe(server.requests[1].callerSid)
      const other = catalog('bbbbbbbbbbbbbbbb')
      expect((await answer(server.ws, server.requests[2].relayId, other)).ok).toBe(true)
      const got = await second
      expect(got.resp).toEqual({ ok: true, result: other })
      expect(got.lines).toBe(1)
      expect(await waitFor(() => /tool catalog not held here; asking for it in full/.test(daemonLog()), 3_000)).toBe(true)

      // Both are held now, in use order.
      const third = listTools('external')
      expect(await waitFor(() => server.requests.length === 4)).toBe(true)
      expect(server.requests[3].payload.have).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
      // A server that answers a hash to a call that named none (a bug): an error, not a sameAs, and no third ask.
      expect((await answer(server.ws, server.requests[3].relayId, { sameAs: 'cccccccccccccccc' })).ok).toBe(true)
      expect(await waitFor(() => server.requests.length === 5)).toBe(true)
      expect((await answer(server.ws, server.requests[4].relayId, { sameAs: 'cccccccccccccccc' })).ok).toBe(true)
      const refused = await third
      expect(refused.resp).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(JSON.stringify(refused.resp)).not.toContain('sameAs')
      await new Promise((r) => setTimeout(r, 500))
      expect(server.requests.length).toBe(5)
    }, 90_000)

    it('an older server answers in full with no hash: nothing is held, every caller gets its answer', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const old = { ops: [{ name: 'task_get', inputSchema: { type: 'object' } }] }
      for (let i = 0; i < 2; i++) {
        const pending = listTools('external')
        expect(await waitFor(() => server.requests.length === i + 1)).toBe(true)
        expect(server.requests[i].payload).toEqual({ schemas: true })
        expect((await answer(server.ws, server.requests[i].relayId, old)).ok).toBe(true)
        expect((await pending).resp).toEqual({ ok: true, result: old })
      }
    }, 90_000)

    it('at most 8 catalogs are held, the least recently used dropped first', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const hashes = Array.from({ length: 9 }, (_, i) => String(i + 1).repeat(16).slice(0, 16))
      for (const [i, hash] of hashes.entries()) {
        const pending = listTools('external')
        expect(await waitFor(() => server.requests.length === i + 1)).toBe(true)
        expect((await answer(server.ws, server.requests[i].relayId, catalog(hash))).ok).toBe(true)
        await pending
      }
      const pending = listTools('external')
      expect(await waitFor(() => server.requests.length === 10)).toBe(true)
      expect(server.requests[9].payload.have).toEqual(hashes.slice(1))
      expect((await answer(server.ws, server.requests[9].relayId, { sameAs: hashes[1] })).ok).toBe(true)
      expect((await pending).resp).toEqual({ ok: true, result: catalog(hashes[1]) })
    }, 90_000)
  })
}
