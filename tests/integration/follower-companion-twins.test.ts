/**
 * A session's call this host's Walnut server refuses for want of a leader while the cloud
 * companion leads, on a REAL standalone daemon process (follower-gateway-core.ts askElsewhere):
 *
 *   test as the Mac ==trusted WS (no auto pong)==> daemon <==bridge== companion (this process:
 *     leader.configure {backup}, host.slice,            a /bridge server with the REAL backup
 *     server.configure; pings while awake               leader and gateway)
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}:
 *     answers every call as the real one answers host_exec away: `needs_leader`, final
 *   a mock session on the daemon, its calls on the agent-gateway socket
 *
 * The Mac falls silent; the companion takes the lead. Then:
 *   - note_read (the companion answers it): the companion's answer, never the daemon's own
 *   - host_exec (it does not): the follower's refusal, at once (2026-11-22 the daemon's own away
 *     answer asked the companion, waited out the call's time for the Mac and was counted twice)
 *   - either way the daemon's own away answer is never used: its counter stays 0
 *
 * Hygiene: every dir is a temp dir (short: socket paths); each daemon is stopped by the pid it
 * wrote into its own dir, the fake host server and the mock session by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createBackupLeader } from '../../src/core/leader/backup-leader.js'
import { createBackupGateway } from '../../src/core/leader/backup-gateway.js'
import { BUN, cleanupFollowerTwins, cmd, connectWs, gatewayCall, linkFollower, nextFrameId, spawnFollowerTwin, startMockSession, waitFor } from '../helpers/follower-twin-rig.js'

const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinacomp01'
const SID = 'dddddddd-4444-4444-8444-444444444444'
const TASK = 'mcompddd-0004'
/** The takeover window, and the daemon's keepalive beat. */
const T = 4_000
const BEAT = 1_000

let base = ''
const started: number[] = []

// ── The companion: a /bridge server with the real backup leader and gateway ──
let wss: WebSocketServer | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const conns = new Map<string, WebSocket>()
const pendingReplies = new Map<number, (m: Record<string, unknown>) => void>()
let nextId = 10_000
/** What the companion's gateway was asked, by op. */
const companionAsked: string[] = []
/** Whether the Mac's heartbeat reaches the companion (in production it rides the Mac's own bridge). */
let macAwake = true

function request(host: string, cmd: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const ws = conns.get(host)
  if (!ws) return Promise.reject(new Error(`no bridge to ${host}`))
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingReplies.delete(id); reject(new Error(`bridge request timed out: ${cmd} -> ${host}`)) }, timeoutMs)
    pendingReplies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

const leader = createBackupLeader({ now: () => Date.now(), takeoverMs: T, hosts: () => [...conns.keys()], request, stateFile: null })
const gateway = createBackupGateway({
  leader,
  request,
  sessions: async () => [],
  findTask: async () => null,
  executeOp: async (name, args) => ({ ok: true, result: { name, args } }),
})

async function startCompanion(): Promise<number> {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss!.on('listening', () => r()))
  wss.on('connection', (ws) => {
    let alias = ''
    ws.on('message', (d) => {
      let f: Record<string, unknown>
      try { f = JSON.parse(String(d)) } catch { return }
      if (f.ev === 'hello') { alias = String(f.hostAlias); conns.set(alias, ws); return }
      if (f.ev === 'bridge-ping') { try { ws.send(JSON.stringify({ id: nextId++, cmd: 'ping', ackSeq: f.seq })) } catch { /* closed */ } return }
      if (f.ev === 'gateway-request') {
        companionAsked.push(String((f.payload as { name?: unknown } | undefined)?.name ?? ''))
        void gateway.handle(alias, f)
        return
      }
      if (typeof f.id === 'number' && pendingReplies.has(f.id)) { const r = pendingReplies.get(f.id)!; pendingReplies.delete(f.id); r(f) }
    })
    ws.on('close', () => { if (conns.get(alias) === ws) conns.delete(alias) })
  })
  tickTimer = setInterval(() => { void leader.tick() }, 250)
  return (wss.address() as net.AddressInfo).port
}

// ── The follower ──
/** The follower as the real one answers a route of the leader's while away (replica/local-calls.ts awayReply). */
function refusesForTheMac(ws: WebSocket): string[] {
  const asked: string[] = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push(String(m.payload?.name ?? ''))
    ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'gateway-result', relayId: m.relayId, errorCode: 'needs_leader', error: `${m.payload?.name} needs your Mac`, detail: { final: true } }))
  })
  return asked
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fco-'))
})

afterAll(async () => {
  if (tickTimer) clearInterval(tickTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  for (const c of wss?.clients ?? []) c.terminate()
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
  await cleanupFollowerTwins(base, started)
}, 60_000)

describe.skipIf(!BUN)("standalone daemon: a final refusal of this host's server while the companion leads", () => {
  it('goes to the companion: its answer when it takes the call, else the follower\'s refusal at once; never the daemon\'s own away answer', async () => {
    if (!wss) await startCompanion()
    const cport = (wss!.address() as net.AddressInfo).port
    const alias = 'stabox'
    const d = await spawnFollowerTwin({ base, name: alias, takeoverMs: T, beatMs: BEAT, started })
    const mac = await connectWs(d.port, false)
    let beat: ReturnType<typeof setInterval> | null = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT / 2)
    macAwake = true
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => { if (macAwake) leader.noteHeartbeat({ walnutId: WALNUT, backup: true }) }, 300)
    try {
      // A session of this Walnut on the host, and the host's bridge to the companion.
      const startedSession = await startMockSession({ base, name: alias, d, mac, sid: SID, home: HOME, task: TASK })
      expect(startedSession.ok, JSON.stringify(startedSession)).toBe(true)
      expect((await cmd(mac, { cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cport}/bridge`, token: 't', hostAlias: alias })).ok).toBe(true)
      await waitFor(() => conns.has(alias), 20_000, 'the bridge')
      await cmd(mac, { cmd: 'host.slice', slice: { v: 1, home: HOME, hash: `h-${alias}`, asOf: Date.now(), host: alias, sessions: [{ sid: SID, taskId: TASK, title: 'Ship it' }], tasks: [{ id: TASK, title: 'Ship it', phase: 'IN_PROGRESS', project: 'Acme' }], requests: [], boards: [], boardOf: {} } })
      expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      // The host server this daemon starts; its token makes the second socket the follower.
      const { follower, hello } = await linkFollower({ base, name: alias, d, mac, home: HOME, walnutId: WALNUT, serverPort: 41_238 })
      expect(hello.ok, JSON.stringify(hello)).toBe(true)
      const followerAsked = refusesForTheMac(follower)

      // The Mac sleeps: its socket goes silent, its heartbeat stops; the companion takes the lead.
      clearInterval(beat); beat = null
      macAwake = false
      await waitFor(() => leader.status().leading.some((l) => l.host === alias), 6 * T, 'the companion to lead the host')
      companionAsked.length = 0

      // One the companion answers: its answer.
      const read = await gatewayCall(d, SID, 'note_read', { path: 'Acme/plan.md' })
      expect(read.reply, JSON.stringify(read.reply)).toMatchObject({ ok: true, result: { name: 'note_read', viaLeader: true } })
      // One it does not: the follower's refusal, at once (no wait for the Mac, not asked twice).
      const exec = await gatewayCall(d, SID, 'host_exec', { host: alias, command: 'ls' })
      expect(exec.reply, JSON.stringify(exec.reply)).toMatchObject({ ok: false, error: { code: 'needs_leader', message: 'host_exec needs your Mac' } })
      expect(exec.ms).toBeLessThan(5_000)
      expect(followerAsked).toEqual(['note_read', 'host_exec'])
      expect(companionAsked).toEqual(['note_read', 'host_exec'])
      // The daemon's own away answer was never used.
      const status = await cmd(follower, { cmd: 'follower.status' })
      expect(status.offlineAnswers?.total ?? 0, JSON.stringify(status.offlineAnswers)).toBe(0)
      follower.close()
    } finally {
      if (beat) clearInterval(beat)
      mac.close()
    }
  }, 180_000)
})
