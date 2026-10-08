/**
 * A host reads its own copy of the notes, memory and skills while the Walnut
 * server cannot answer, on REAL daemon processes (docs/plan/walnut-control-plane.md).
 *
 *   this process (the primary: the REAL core/host-replica.ts push, a gateway
 *   answerer) ══ freezable TCP proxy ══► daemon (source twin, node) ── session S
 *                                     ╚═► daemon (standalone twin, bun) ── session S2
 *
 * The proxy is how a Mac falls asleep: frozen, the socket stays open and
 * nothing crosses it either way, so the daemon's keepalive counts missed beats,
 * exactly as with a closed lid. What's real: both twins, their copies on disk,
 * the agent-gateway socket as the `walnut` CLI speaks it, the replica protocol,
 * the read fallback. The sessions are a mock CLI. What's not here: the real
 * Walnut server (tests/e2e/leader-takeover-live-e2e.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-replica-twins'))
vi.mock('../../src/core/skill-store.js', () => ({
  listAllSkills: async () => [{ dirName: 'deploy', name: 'deploy', description: 'Ship it', content: '---\nname: deploy\n---\nRun the deploy script.' }],
}))
let config: Record<string, unknown> = {}
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => config }))

import { NOTES_DIR, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { syncHostReplica, forgetHostReplica, sha12 } from '../../src/core/host-replica.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import type { HostSlice, OfflineRecord } from '../../src/providers/offline-host-core.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
/** The daemon's keepalive beat: 3 missed = silent (reads skip it), 8 = the socket is closed. */
const BEAT = 600
const GATEWAY_TIMEOUT = 3_000
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

const MOCK_CLI = `
const sid = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
// The daemon holds the FIFO's write end: it gone, stdin ends and so does this.
process.stdin.on('end', () => process.exit(0))
setTimeout(() => process.exit(0), 10 * 60_000)
`

const RETRO = '# Retro\nThe build broke twice; the rollback worked.'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

/** A TCP proxy that can stop forwarding while keeping both sockets open. */
function freezableProxy(targetPort: number) {
  let frozen = false
  const pairs: Array<[net.Socket, net.Socket]> = []
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, '127.0.0.1')
    pairs.push([client, up])
    client.pipe(up)
    up.pipe(client)
    if (frozen) { client.pause(); up.pause() }
    const end = () => { client.destroy(); up.destroy() }
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
  })
  return {
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    freeze: () => { frozen = true; for (const [a, b] of pairs) { a.unpipe(b); b.unpipe(a); a.pause(); b.pause() } },
    thaw: () => { frozen = false; for (const [a, b] of pairs) { a.pipe(b); b.pipe(a); a.resume(); b.resume() } },
    close: () => { for (const [a, b] of pairs) { a.destroy(); b.destroy() } server.close() },
  }
}

interface Daemon { twin: 'source' | 'standalone'; proc: ChildProcess; dir: string; port: number; sock: string; pid: number; sid: string }

/** The primary as a daemon sees it: one trusted socket, a copy, answers to relays. */
class Primary {
  ws!: WebSocket
  private id = 0
  private pending = new Map<number, (m: Record<string, unknown>) => void>()
  answerRelays = true
  relays: string[] = []
  /** What the host journaled while this primary did not answer, taken when it says so (`offline-journal`). */
  drained: OfflineRecord[] = []
  constructor(readonly port: number, readonly hostKey: string) {}
  private async drain(): Promise<void> {
    for (;;) {
      const r = await this.send('offline.drain', { home: WALNUT_HOME })
      const records = (Array.isArray(r.records) ? r.records : []) as OfflineRecord[]
      if (records.length === 0) return
      this.drained.push(...records)
      await this.send('offline.ack', { home: WALNUT_HOME, upTo: Math.max(...records.map((x) => x.seq)) })
    }
  }
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`)
    await new Promise<void>((resolve, reject) => { this.ws.once('open', () => resolve()); this.ws.once('error', reject) })
    this.ws.on('message', (d) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(String(d)) } catch { return }
      if (typeof m.id === 'number' && this.pending.has(m.id)) { const f = this.pending.get(m.id)!; this.pending.delete(m.id); f(m); return }
      if (m.ev === 'offline-journal') { void this.drain(); return }
      if (m.ev === 'gateway-request') {
        const payload = m.payload as { name?: string }
        this.relays.push(String(payload?.name))
        if (this.answerRelays) this.ws.send(JSON.stringify({ id: ++this.id, cmd: 'gateway-result', relayId: m.relayId, result: { answeredBy: 'primary' } }))
      }
    })
  }
  send = (cmd: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> => {
    const my = ++this.id
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(my); resolve({ ok: false, error: `${cmd} timed out` }) }, timeoutMs)
      this.pending.set(my, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id: my, cmd, ...params }))
    })
  }
  close(): void { try { this.ws.terminate() } catch { /* gone */ } }
}

let base = ''
const daemons: Daemon[] = []

async function spawnDaemon(name: string, twin: 'source' | 'standalone', sid: string): Promise<Daemon> {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  const portFile = path.join(dir, 'daemon.port')
  const pidFile = path.join(dir, 'daemon.pid')
  const sock = path.join(dir, 'agent-gateway.sock')
  // A restart: what the last daemon left must not pass for the new one being up.
  for (const f of [portFile, pidFile, sock]) { try { fs.rmSync(f) } catch { /* first boot */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_REPLICA_DIR: path.join(dir, 'replica'),
    WALNUT_GATEWAY_TIMEOUT_MS: String(GATEWAY_TIMEOUT),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${name}] ` + b.toString()))
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(pidFile), 60_000, `${name} daemon`)
  return {
    twin, proc, dir, sock, sid,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10),
  }
}

async function startSession(d: Daemon): Promise<void> {
  const mock = path.join(base, 'mock-cli.cjs')
  if (!fs.existsSync(mock)) fs.writeFileSync(mock, MOCK_CLI)
  const p = new Primary(d.port, 'x')
  await p.connect()
  const started = await p.send('start', { sid: d.sid, cwd: d.dir, message: 'init', args: [process.execPath, mock, d.sid], origin: { home: WALNUT_HOME, task: 'mtask000-0001' } })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  p.close()
  await waitFor(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${d.sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${d.sid} idle`)
}

function gatewayCall(d: Daemon, name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse & { ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const s = net.connect(d.sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error(`gateway ${name} timeout`)) }, 30_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: d.sid, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve({ ...JSON.parse(buf.slice(0, nl)), ms: Date.now() - t0 }) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function slice(d: Daemon): HostSlice {
  return {
    v: 1, home: WALNUT_HOME, hash: `h-${d.twin}`, asOf: Date.now(), host: d.twin,
    sessions: [{ sid: d.sid, taskId: 'mtask000-0001', title: 'Release work' }],
    tasks: [{ id: 'mtask000-0001', title: 'Release work', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
  }
}

function writeNote(rel: string, body: string): void {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

const twinsToRun: Array<'source' | 'standalone'> = BUN ? ['source', 'standalone'] : ['source']

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'whrt-'))
  writeNote('Projects/Release plan.md', '---\nid: n_rel01\n---\n# Release plan\nShip on Friday.')
  writeNote('Projects/Retro.md', RETRO)
  writeNote('health/Checkup.md', '# Checkup\nBlood test on Friday.')
  writeNote('_attachment/scan.md', 'ocr')
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
  fs.writeFileSync(MEMORY_FILE, '# Memory\n- deploy with the script\n')
}, 30_000)

afterAll(async () => {
  for (const d of daemons) {
    if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
    try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  }
  await sleep(500)
  if (base && !process.env.KEEP_REPLICA_TWINS) fs.rmSync(base, { recursive: true, force: true })
}, 30_000)

for (const twin of twinsToRun) {
  describe(`${twin} twin: reads from the host's copy while the server cannot answer`, () => {
    let d: Daemon
    let proxy: ReturnType<typeof freezableProxy>
    let primary: Primary

    beforeAll(async () => {
      d = await spawnDaemon(twin === 'source' ? 'src' : 'bun', twin, twin === 'source' ? 'aaaaaaaa-1111-4111-8111-111111111111' : 'bbbbbbbb-2222-4222-8222-222222222222')
      daemons.push(d)
      await startSession(d)
      proxy = freezableProxy(d.port)
      primary = new Primary(await proxy.listen(), twin)
      await primary.connect()
      expect((await primary.send('host.slice', { slice: slice(d) })).ok).toBe(true)
      forgetHostReplica(twin)
      config = { hosts: { [twin]: { hostname: 'h', keep: { notes_exclude: ['health'] } } } }
      const round = await syncHostReplica({ hostKey: twin, send: primary.send })
      expect(round.map((r) => `${r.kind}:${r.action}`)).toEqual(['notes:synced', 'memory:synced', 'skills:synced'])
    }, 120_000)

    afterAll(() => { primary?.close(); proxy?.close() })

    it('the copy is on disk under the replica dir, and has no left-out folder and no attachment', async () => {
      const status = await primary.send('replica.status', { home: WALNUT_HOME })
      expect(status).toMatchObject({ ok: true, kinds: { notes: { entries: 2, pending: 0 }, memory: { entries: 1 }, skills: { entries: 1 } } })
      const files = fs.readdirSync(path.join(d.dir, 'replica'), { recursive: true }).map(String)
      expect(files.some((f) => f.endsWith('index.json'))).toBe(true)
      const all = files.filter((f) => /[/\\]f[/\\]/.test(f)).map((f) => fs.readFileSync(path.join(d.dir, 'replica', f), 'utf8')).join('\n')
      expect(all).toContain('rollback worked')
      expect(all).not.toContain('Blood test')
      expect(all).not.toContain('ocr')
    })

    it('while the server answers, reads go to it', async () => {
      const r = await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })
      expect(r).toMatchObject({ ok: true, result: { answeredBy: 'primary' } })
      expect(primary.relays).toContain('note_read')
    }, 30_000)

    it('a server that is heard but does not answer: the read comes from the copy at the timeout, a write still times out', async () => {
      primary.answerRelays = false
      try {
        const r = await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { content: RETRO, contentHash: sha12(RETRO), offline: true } })
        expect(r.ms).toBeGreaterThanOrEqual(GATEWAY_TIMEOUT - 200)
        // A search, too: a read, so nothing is applied twice.
        const s = await gatewayCall(d, 'search', { q: 'release' })
        expect(s, JSON.stringify(s)).toMatchObject({ ok: true, result: { offline: true } })
        expect(primary.relays).toContain('search')
        const w = await gatewayCall(d, 'note_write', { path: 'Projects/New', content: 'x' })
        expect(w).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
      } finally {
        primary.answerRelays = true
      }
    }, 60_000)

    it('the Mac falls asleep with its socket open: after 3 missed beats the host answers what it can at once', async () => {
      proxy.freeze()
      try {
        // 3 missed beats land 3 to 4 beats after the freeze; 8 (8 to 9 beats) close the socket.
        await sleep(BEAT * 4.6)
        const r = await gatewayCall(d, 'note_read', { id: 'n_rel01' })
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { path: 'Projects/Release plan', id: 'n_rel01', offline: true } })
        expect(r.ms).toBeLessThan(GATEWAY_TIMEOUT)
        const s = await gatewayCall(d, 'note_search', { q: 'friday' })
        expect(s.ok && (s.result.results as Array<{ path: string }>).map((x) => x.path)).toEqual(['Projects/Release plan'])
        expect(s.ok && s.result.degraded).toBe('offline-keyword')
        expect(await gatewayCall(d, 'memory_read', { doc: 'global' })).toMatchObject({ ok: true, result: { memory: { content: '# Memory\n- deploy with the script\n' } } })
        expect(await gatewayCall(d, 'skill_read', { dirName: 'deploy' })).toMatchObject({ ok: true, result: { skill: { content: '---\nname: deploy\n---\nRun the deploy script.' } } })
        // The task copy rides the same path.
        expect(await gatewayCall(d, 'task_get', { id: 'mtask000-0001' })).toMatchObject({ ok: true, result: { offline: true } })
        // Search: a keyword search of this host's tasks, sessions and memory copy.
        const found = await gatewayCall(d, 'search', { q: 'release work', types: 'task' })
        expect(found, JSON.stringify(found)).toMatchObject({ ok: true, result: { offline: true, degraded: 'offline-keyword' } })
        expect(found.ok && (found.result.results as Array<{ taskId: string }>).map((x) => x.taskId)).toEqual(['mtask000-0001'])
        expect(found.ms).toBeLessThan(GATEWAY_TIMEOUT)
        const remembered = await gatewayCall(d, 'search', { q: 'deploy script', types: 'memory' })
        expect(remembered.ok && remembered.result.results).toEqual([expect.objectContaining({ type: 'memory', path: 'MEMORY.md' })])
        // A left-out folder is not in the copy.
        expect(await gatewayCall(d, 'note_read', { path: 'health/Checkup' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
        // Its own task: written here at once, journaled for the server.
        const own = await gatewayCall(d, 'task_update', { id: 'mtask000-0001', description: 'Drafted while the Mac slept.' })
        expect(own, JSON.stringify(own)).toMatchObject({ ok: true, result: { queued: true, offline: true } })
        expect(own.ms).toBeLessThan(GATEWAY_TIMEOUT)
        // What only the server can do is refused at once, not after a timeout.
        const global = await gatewayCall(d, 'note_write', { path: 'Projects/New', content: 'x' })
        expect(global).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
        expect(global.ms).toBeLessThan(GATEWAY_TIMEOUT)
        // After a compaction the session still gets back what is open.
        expect(await gatewayCall(d, 'open_items', { hook: 'compact' })).toMatchObject({ ok: true })
      } finally {
        proxy.thaw()
      }
      // Awake again on the same socket: the host's nudge, buffered while it slept,
      // has the server take the write; then calls go to the server again.
      await waitFor(() => primary.drained.some((r) => r.kind === 'op' && r.op === 'task_update'), 15_000, 'the server to take the queued write')
      const op = primary.drained.find((r) => r.kind === 'op') as Extract<OfflineRecord, { kind: 'op' }>
      expect(op).toMatchObject({ op: 'task_update', args: { id: 'mtask000-0001', description: 'Drafted while the Mac slept.' } })
      expect(primary.drained.filter((r) => r.kind === 'op')).toHaveLength(1)
      primary.relays = []
      await waitFor(async () => (await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })).ok === true && primary.relays.includes('note_read'), 15_000, 'reads to go back to the server')
      primary.relays = []
      expect(await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { answeredBy: 'primary' } })
    }, 60_000)

    it('a note changed on the server reaches the copy with only that note sent', async () => {
      writeNote('Projects/Retro.md', '# Retro\nThird time lucky.')
      const round = await syncHostReplica({ hostKey: twin, send: primary.send })
      expect(round.find((r) => r.kind === 'notes')).toMatchObject({ action: 'synced', sent: 1 })
      expect(round.filter((r) => r.kind !== 'notes').map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
      writeNote('Projects/Retro.md', RETRO)
      await syncHostReplica({ hostKey: twin, send: primary.send })
    }, 60_000)

    it('a daemon restart keeps the copy: a session reads it with no server at all', async () => {
      primary.close()
      try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
      await waitFor(() => { try { process.kill(d.pid, 0); return false } catch { return true } }, 20_000, 'the daemon to stop')
      const again = await spawnDaemon(twin === 'source' ? 'src' : 'bun', twin, d.sid)
      daemons.push(again)
      Object.assign(d, again)
      await startSession(d)
      const r = await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { content: RETRO, offline: true } })
    }, 120_000)

    it('notes turned off for this host are removed from it', async () => {
      proxy.close()
      proxy = freezableProxy(d.port)
      primary = new Primary(await proxy.listen(), twin)
      await primary.connect()
      expect((await primary.send('host.slice', { slice: slice(d) })).ok).toBe(true)
      forgetHostReplica(twin)
      config = { hosts: { [twin]: { hostname: 'h', keep: { notes: false } } } }
      const round = await syncHostReplica({ hostKey: twin, send: primary.send })
      expect(round.find((r) => r.kind === 'notes')).toMatchObject({ action: 'dropped' })
      // A stuck server: a note read is the server's again (it times out as before),
      // while memory, still kept here, comes from the copy at the timeout.
      primary.answerRelays = false
      expect(await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
      expect(await gatewayCall(d, 'memory_read', { doc: 'global' })).toMatchObject({ ok: true, result: { offline: true } })
      primary.close()
      await sleep(200)
      const r = await gatewayCall(d, 'note_read', { path: 'Projects/Retro' })
      expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      const left = fs.readdirSync(path.join(d.dir, 'replica'), { recursive: true }).map(String).filter((f) => /[/\\]f[/\\]/.test(f))
      expect(left.map((f) => fs.readFileSync(path.join(d.dir, 'replica', f), 'utf8')).join('\n')).not.toContain('rollback')
      // Memory and skills are still kept.
      expect(await gatewayCall(d, 'memory_read', { doc: 'global' })).toMatchObject({ ok: true })
    }, 60_000)
  })
}
