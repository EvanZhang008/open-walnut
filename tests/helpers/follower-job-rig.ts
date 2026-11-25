/**
 * A REAL standalone daemon running a real plugin job, with this host's own Walnut server linked as
 * its follower, for the plugin-job gateway suites (tests/integration/follower-gateway-job-*.test.ts):
 *
 *   test as the Mac ==trusted WS (no auto pong)==> daemon
 *     leader.configure, server.configure, jobs.configure; app pings while it is awake
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a real job run (the daemon's own `walnut plugin-job`): its run id is the caller
 *   optionally the cloud companion: a /bridge server the daemon dials, whose link claims the lead
 *
 * The generic plumbing (daemon, sockets, frames, cleanup) is follower-twin-rig.ts; this file adds
 * the job, its calls on the agent gateway socket and the companion's bridge.
 */
import { expect } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHostCallEntry, listenHostCallEntry, type HostCallListener } from '../../src/replica/host-call-entry.js'
import { cmd, connectWs, linkFollower, lines, nextFrameId, sleep, spawnFollowerTwin, waitFor, type Daemon } from './follower-twin-rig.js'

export { BUN, cleanupFollowerTwins, cmd, lines, sleep, waitFor } from './follower-twin-rig.js'

export const HOME = '/fixture/marina-home'
export const WALNUT = 'wmarinahost01'
/**
 * The daemon runs from source under bun; WALNUT_TEST_DAEMON_BINARIES names a build of
 * scripts/build-daemon.sh to run its binary instead (the program a host really runs).
 */
const BINARIES = process.env.WALNUT_TEST_DAEMON_BINARIES?.trim()
export const BINARY = BINARIES ? path.join(BINARIES, `daemon-${process.platform}-${process.arch}`) : undefined
/** Beats of 400 ms: the gateway passes over a silent Mac after 3 (1.2 s), the keepalive closes it after 8 (3.2 s). */
export const BEAT_MS = 400
/** Between the two: the follower may write once the Mac has been quiet this long. */
export const QUIET_MS = 3_000
/** The daemon's own default takeover window: the companion cannot claim the lead in a suite's time. */
const TAKEOVER_DEFAULT_MS = 60_000

/**
 * The plugin's job, as the Mac bundles it: tells the test its run id and waits. Each line the test
 * writes to `<JOB_OUT>.go` asks it to call: an op name through its own walnut.ops.call, or `child`
 * through a child process it starts (JOB_CHILD), which calls under the run's id on its own socket.
 */
const BUNDLE = `
import fs from 'node:fs'
import { spawn } from 'node:child_process'
export const jobs = {
  worker: async (walnut, signal) => {
    const info = JSON.parse(process.env.WALNUT_PLUGIN_JOB)
    const out = process.env.JOB_OUT
    fs.appendFileSync(out, JSON.stringify({ pid: process.pid, sid: info.sid }) + '\\n')
    let done = 0
    const poll = setInterval(() => {
      let asks = []
      try { asks = fs.readFileSync(out + '.go', 'utf8').split('\\n').filter(Boolean) } catch {}
      for (const name of asks.slice(done)) {
        done++
        if (name === 'child') { spawn(process.env.JOB_NODE || process.execPath, [process.env.JOB_CHILD], { env: process.env, stdio: 'ignore' }); continue }
        walnut.ops.call(name, {}).then(
          (r) => fs.appendFileSync(out, JSON.stringify({ called: name, result: r }) + '\\n'),
          (e) => fs.appendFileSync(out, JSON.stringify({ called: name, error: String(e) }) + '\\n'))
      }
    }, 100)
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
    clearInterval(poll)
  },
}
`

/** The job's child: one call under the run's id on the gateway socket, its answer to JOB_OUT. */
const CHILD = `
const fs = require('fs'), net = require('net')
const info = JSON.parse(process.env.WALNUT_PLUGIN_JOB)
const note = (o) => fs.appendFileSync(process.env.JOB_OUT, JSON.stringify({ child: process.pid, ...o }) + '\\n')
const c = net.connect(process.env.WALNUT_AGENT_SOCKET)
let buf = ''
c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid: info.sid, args: { name: 'task_get', args: {} } }) + '\\n'))
c.on('data', (d) => { buf += d; if (buf.includes('\\n')) { note({ reply: JSON.parse(buf.slice(0, buf.indexOf('\\n'))) }); c.destroy(); process.exit(0) } })
c.on('error', (e) => { note({ error: String(e) }); process.exit(1) })
`

/** The job as the daemon names it in a frame's `caller` (plugin-jobs-core.ts callerOfRun). */
export const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }

/** The fields of a server end's `gateway-result` for one `gateway-request` it was sent. */
export type AnswerOf = (m: Record<string, any>) => Record<string, unknown>

/** A server end: answers every gateway request (by default with who it is); returns what it was asked. */
export function answersAs(ws: WebSocket, who: string, answer: AnswerOf = (m) => ({ result: { who, op: m.payload?.name } })): Array<Record<string, any>> {
  const asked: Array<Record<string, any>> = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push(m)
    ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'gateway-result', relayId: m.relayId, ...answer(m) }))
  })
  return asked
}

/**
 * One call on the agent gateway socket under `sid`, as the job's walnut.ops.call sends it:
 * `sent` settles once the request left this process, `done` with the daemon's answer.
 */
export function startGatewayCall(sock: string, sid: string, name: string): { sent: Promise<void>; done: Promise<{ at: number; reply: Record<string, any> }> } {
  let wrote!: () => void
  const sent = new Promise<void>((resolve) => { wrote = resolve })
  const done = new Promise<{ at: number; reply: Record<string, any> }>((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {} } }) + '\n', () => wrote()))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve({ at: Date.now(), reply: JSON.parse(buf.slice(0, buf.indexOf('\n'))) }) } })
    c.on('error', reject)
  })
  return { sent, done }
}

export const gatewayCall = (sock: string, sid: string, name: string) => startGatewayCall(sock, sid, name).done

/** One raw request line on the agent gateway socket (any fields a caller may write), and the daemon's answer. */
export function rawGatewayCall(sock: string, request: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify(request) + '\n'))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))) } })
    c.on('error', reject)
  })
}

export interface Rig {
  d: Daemon; mac: WebSocket; follower: WebSocket; macAsked: Array<Record<string, any>>; followerAsked: Array<Record<string, any>>
  jobSid: string; jobOut: string; awake: (on: boolean) => void
  /** The leader record's epoch the Mac's leader.configure was given: a companion claims above it. */
  epoch: number
  /** The lines the follower's call entry handed to the daemon (`entry: true`), and its listener. */
  entryLines: Array<Record<string, any>>; entry?: HostCallListener
}

/** Writes the job's child script into the suite's `base` (once per suite, before any rig). */
export function writeJobChild(base: string): void {
  fs.writeFileSync(path.join(base, 'job-child.cjs'), CHILD)
}

/**
 * One rig in `base/name`. `entry`: the follower serves its host call entry (the real
 * replica/host-call-entry.ts on its own unix socket, each line handed to the daemon over the
 * follower link) and names it in its hello, before the job starts, so the run is given
 * WALNUT_CALL_SOCKET and WALNUT_CALL_TOKEN. `backup`: the user lets the cloud companion lead this
 * Walnut, which may claim the lead once the Mac is quiet `takeoverMs`. `follower`: how the
 * follower answers each call it is handed (by default, ok with who it is).
 */
export async function rig(o: { base: string; started: number[]; name: string; entry?: boolean; backup?: boolean; takeoverMs?: number; follower?: AnswerOf }): Promise<Rig> {
  const { base, name } = o
  const jobOut = path.join(base, `${name}-job.jsonl`)
  const d = await spawnFollowerTwin({
    base, name, started: o.started, binary: BINARY, beatMs: BEAT_MS, quietMs: QUIET_MS, takeoverMs: o.takeoverMs ?? TAKEOVER_DEFAULT_MS,
    // The child's runtime: a built daemon binary runs the job, and it runs no script of its own.
    env: { JOB_OUT: jobOut, JOB_CHILD: path.join(base, 'job-child.cjs'), JOB_NODE: process.execPath },
  })
  const mac = await connectWs(d.port, false)
  let beat: ReturnType<typeof setInterval> | null = null
  const awake = (on: boolean) => {
    if (beat) { clearInterval(beat); beat = null }
    if (on) beat = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT_MS / 2)
  }
  awake(true)
  const macAsked = answersAs(mac, 'mac')
  const configured = await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: o.backup === true })
  expect(configured.ok, JSON.stringify(configured)).toBe(true)
  const entryLines: Array<Record<string, any>> = []
  let callEntry: HostCallListener | undefined
  // The entry hands its lines over the follower link, linked below (before any job calls).
  const link: { follower?: WebSocket } = {}
  if (o.entry) {
    const served = createHostCallEntry({
      request: (command, params) => { entryLines.push(params); return cmd(link.follower!, { cmd: command, ...params }) },
      capabilities: () => ['host-call-entry-v1'],
      linked: () => true,
      enabled: () => true,
      log: () => {},
    })
    const socketPath = path.join(d.dir, 'host-call', `${crypto.randomBytes(8).toString('hex')}.sock`)
    callEntry = (await listenHostCallEntry(served, { socketPath, uid: typeof process.getuid === 'function' ? process.getuid() : null, log: () => {} })) ?? undefined
    expect(callEntry, 'the call entry listens').toBeTruthy()
  }
  // The host server this daemon starts; its token makes the second socket the follower.
  const { follower, hello } = await linkFollower({ base, name, d, mac, home: HOME, walnutId: WALNUT, serverPort: 41_237, ...(callEntry ? { callSocket: callEntry.socketPath } : {}) })
  link.follower = follower
  expect(hello.ok, JSON.stringify(hello)).toBe(true)
  const followerAsked = answersAs(follower, 'follower', o.follower)
  // A real job run: its run id is the caller the gateway knows.
  const sha256 = crypto.createHash('sha256').update(BUNDLE).digest('hex')
  const file = path.join(d.dir, 'plugin-jobs', 'bundles', `${sha256}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, BUNDLE)
  const jobs = [{ plugin: 'acme-sync', version: '1.0.0', job: 'worker', kind: 'long-running', bundle: { sha256, file }, config: {}, host: 'devbox' }]
  expect((await cmd(mac, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs } })).ok).toBe(true)
  await waitFor(() => lines(jobOut).some((l) => typeof l.sid === 'string'), 30_000, 'the job run')
  const jobSid = String(lines(jobOut).find((l) => typeof l.sid === 'string')!.sid)
  return { d, mac, follower, macAsked, followerAsked, jobSid, jobOut, awake, epoch: Number(configured.epoch), entryLines, ...(callEntry ? { entry: callEntry } : {}) }
}

/**
 * Waits until the daemon passes over its silent leader: three missed beats, plus the beat of
 * the sweep that notices them, read from the daemon's own clock for the leader (the follower
 * view's `primaryHeardAgoMs`), never from a fixed wait here.
 */
export async function leaderPassedOver(r: Rig): Promise<void> {
  const end = Date.now() + 30_000
  for (;;) {
    const view = await cmd(r.follower, { cmd: 'follower.status' })
    if (Number(view.primaryHeardAgoMs) >= BEAT_MS * 4 + 100) return
    if (Date.now() > end) throw new Error('timed out waiting for the daemon to pass over its leader: ' + JSON.stringify(view).slice(0, 300))
    await sleep(50)
  }
}

/**
 * The cloud companion as the daemon's bridge sees it: a /bridge server that keeps each host's
 * link up (answers its pings), records every `gateway-request` the daemon relays to it and answers
 * it as `companion`, and claims the lead over a link the way the real backup leader does.
 */
export interface Companion {
  port: number
  /** The gateway requests relayed to the companion over the link of the host `alias`. */
  askedBy: (alias: string) => Array<Record<string, any>>
  /** The bridge link of the host that said hello as `alias`, once it has. */
  link: (alias: string) => WebSocket | undefined
  close: () => Promise<void>
}

export async function startCompanion(): Promise<Companion> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  const links = new Map<string, WebSocket>()
  const asked: Array<{ alias: string; frame: Record<string, any> }> = []
  wss.on('connection', (ws) => {
    let alias = ''
    ws.on('message', (d) => {
      let f: Record<string, any>
      try { f = JSON.parse(String(d)) } catch { return }
      if (f.ev === 'hello') { alias = String(f.hostAlias); links.set(alias, ws); return }
      if (f.ev === 'bridge-ping') { try { ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'ping', ackSeq: f.seq })) } catch { /* closed */ } return }
      if (f.ev === 'gateway-request') {
        asked.push({ alias, frame: f })
        try { ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'gateway-result', relayId: f.relayId, result: { who: 'companion', op: f.payload?.name } })) } catch { /* closed */ }
      }
    })
  })
  return {
    port: (wss.address() as net.AddressInfo).port,
    askedBy: (host) => asked.filter((a) => a.alias === host).map((a) => a.frame),
    link: (alias) => links.get(alias),
    close: async () => {
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}

/**
 * The companion leads the rig's Walnut: the Mac gives the host its bridge to `companion` (named for
 * the Walnut) and falls silent; once the takeover window has passed, the link claims the lead
 * (leader.claim, the epoch above the Mac's). Returns the bridge link.
 */
export async function companionLeads(r: Rig, companion: Companion, alias: string): Promise<WebSocket> {
  const bridged = await cmd(r.mac, { cmd: 'bridge.configure', home: HOME, enabled: true, url: `ws://127.0.0.1:${companion.port}/bridge`, token: 't', hostAlias: alias })
  expect(bridged.ok, JSON.stringify(bridged)).toBe(true)
  await waitFor(() => companion.link(alias) !== undefined, 20_000, 'the bridge to the companion')
  const bridge = companion.link(alias)!
  r.awake(false)
  // The daemon refuses the claim while it heard the Mac within the window ('primary_alive').
  const end = Date.now() + 30_000
  for (;;) {
    const claimed = await cmd(bridge, { cmd: 'leader.claim', walnutId: WALNUT, epoch: r.epoch + 1 })
    if (claimed.ok === true) { expect(claimed).toMatchObject({ holder: 'backup', epoch: r.epoch + 1 }); return bridge }
    if (claimed.errorKind !== 'primary_alive' || Date.now() > end) throw new Error('leader.claim: ' + JSON.stringify(claimed))
    await sleep(100)
  }
}
