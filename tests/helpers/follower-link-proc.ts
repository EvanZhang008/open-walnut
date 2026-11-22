/**
 * Run by tests/replica/follower-link-both.test.ts with bun: one host daemon runtime (the
 * service's shape: no listening port, the door open, its own follower home) and one follower
 * link to it, then the same scenario of a host replica's day through that link, printed as one
 * JSON line. argv: <temp root> <ws|direct>.
 *
 *   ws      the socket link (createFollowerLink): follower.hello with the token the daemon keeps
 *           for its follower, then frames over the door's port
 *   direct  the service's link (createDirectFollowerLink): the runtime's follower seat, no socket
 *
 * The scenario: a leader links and describes its Walnut; the follower links; a write while the
 * leader answers is refused; streams run both ways; the leader goes away; the write is journaled;
 * a leader comes back and drains and acks the journal through the door. Everything it prints is
 * what a caller of the link sees, so the two arms print the same, except what only one of them does
 * on the wire (`wire`: the daemon's own log of how the follower arrived).
 * MACHINE SAFETY: the temp root only; no CLI is started; the runtime is stopped by the script.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonRuntime } from '../../src/providers/daemon-standalone.ts'
import { createDirectFollowerLink, createFollowerLink, type FollowerLink } from '../../src/core/link/follower-link.ts'
import { createStreamEndpoint, type StreamEndpoint } from '../../src/lib/link-stream.ts'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.ts'

const root = process.argv[2]!
const arm = process.argv[3] as 'ws' | 'direct'
const HOME = '/acme/home'
const WALNUT = 'w-acme'
const TASK_A = 'mtaskaaa-0001'
const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const ACTOR = { kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' }
const out: Record<string, unknown> = {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(40)
  }
}

const dir = path.join(root, 'daemon')
const home = path.join(root, 'home')
fs.mkdirSync(path.join(dir, 'host-server'), { recursive: true, mode: 0o700 })
fs.mkdirSync(home, { recursive: true })
const token = crypto.randomBytes(32).toString('hex')
// The follower spec a leader configured, with the token the daemon keeps for its follower.
fs.writeFileSync(path.join(dir, 'host-server', 'server-0011223344556677.json'), JSON.stringify({
  spec: {
    v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [], cwd: root, log: path.join(root, 'follower.log'), port: 40123, settings: {},
    env: {},
  },
  token,
}), { mode: 0o600 })

const exitCalls: number[] = []
const runtime = await createDaemonRuntime({
  env: {
    ...process.env, HOME: home, SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'), WALNUT_JOURNAL_DIR: path.join(root, 'journal'),
    WALNUT_LEADER_QUIET_MS: '2500', WALNUT_TRUSTED_CLIENT_BEAT_MS: '400', WALNUT_LEADER_TAKEOVER_MS: '6000',
  },
  mode: 'start', listen: false, door: true, selfHome: HOME,
  exit: (code) => { exitCalls.push(code) },
})
await runtime.start()
const port = Number(await until('the door port', () => { try { return fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim() } catch { return '' } }))

/** A leader of the Walnut on the door: its session link (beating), and a stream endpoint that echoes in capitals. */
async function leader() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('the door did not open')) })
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  let next = 1
  const streams: StreamEndpoint = createStreamEndpoint({
    send: (frame) => ws.send(JSON.stringify(frame)),
    accept: (info) => (info.from === 'follower' ? (s) => { s.on('data', (d: Buffer) => s.write(Buffer.from(String(d).toUpperCase()))) } : null),
  })
  ws.onmessage = (m) => {
    const v = JSON.parse(String(m.data)) as Record<string, unknown>
    if (streams.handle(v)) return
    const done = typeof v.id === 'number' ? pending.get(v.id) : undefined
    if (done) { pending.delete(v.id as number); done(v) }
  }
  const call = (cmd: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    const id = next++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
  const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 400)
  const configured = await call({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, drains: JOURNAL_V2_DRAINS })
  if (configured.ok !== true) throw new Error('leader.configure: ' + JSON.stringify(configured))
  const slice = {
    v: 1, home: HOME, hash: 'h1', asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: SID_A, taskId: TASK_A, title: 'Leader work' }],
    tasks: [{ id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', updated_at: '2026-10-14T09:00:00Z', description: 'first line' }],
    requests: [],
  }
  const sliced = await call({ cmd: 'host.slice', slice })
  if (sliced.ok !== true) throw new Error('host.slice: ' + JSON.stringify(sliced))
  return { call, streams, close: () => { clearInterval(beat); ws.close() } }
}

const L1 = await leader()
const accepted: string[] = []
const wiring = {
  walnutId: WALNUT, home: HOME, host: 'devbox', pollMs: 200,
  accept: (info: { from: string }) => (info.from === 'primary' ? (s: import('node:stream').Duplex) => {
    accepted.push(info.from)
    s.on('data', (d: Buffer) => s.write(Buffer.from([...String(d)].reverse().join(''))))
  } : null),
  log: () => {},
}
const link: FollowerLink = arm === 'ws'
  ? createFollowerLink({ ...wiring, daemonDir: dir, token })
  : createDirectFollowerLink({ ...wiring, seat: () => runtime.follower })
link.start()
await until('the link to follow', () => link.linkState() === 'following' && link.view() !== null && link.capabilities() !== null)
const view = link.view()!.view
out.linked = {
  state: link.state(), linkState: link.linkState(), walnutId: view.walnutId, holder: view.holder, primaryConnected: view.primaryConnected,
  opsCap: link.capabilities()!.includes('replica-ops-v1'), readsCap: link.capabilities()!.includes('replica-reads-v1'),
}

const OP = (description: string, opId: string) => ({ op: 'task_update', args: { id: TASK_A, description }, actor: ACTOR, base: { description: 'first line' }, opId })
const brief = (r: Record<string, unknown>) => ({ ok: r.ok, errorKind: r.errorKind, kind: r.kind, duplicate: r.duplicate })

// The leader answers: a write through the follower is refused with the code callers retry by.
out.writeWhileLeaderAnswers = brief(await link.request('follower.op', OP('draft one', 'op-online')))
out.sendWhileLeaderAnswers = brief(await link.request('follower.send', { sid: SID_A, text: 'hello', messageId: 'qm-1' }))
const sessions = await link.request('follower.sessions')
out.sessions = { ok: sessions.ok, host: sessions.host, sids: (sessions.sessions as Array<{ sid: string; state: string }>).map((s) => `${s.sid}:${s.state}`) }
const status = await link.request('follower.status')
out.status = { ok: status.ok, walnutId: status.walnutId, home: status.home, holder: status.holder }
// A read of a session that is not this Walnut's is answered as nobody's (the follower's owner scope).
const stranger = await link.request('read-history', { sid: 'cccccccc-3333-4333-8333-333333333333' })
out.readOfAStranger = { ok: stranger.ok, errorKind: stranger.errorKind }
// A command only the leader sends is refused on the follower's own link.
const forbidden = await link.request('stop', { sid: SID_A })
out.leaderOnlyCommand = { ok: forbidden.ok, errorKind: forbidden.errorKind }

// Streams both ways through the daemon's relay.
const toLeader = await link.openStream('primary', 'web')
const echoed = new Promise<string>((resolve) => toLeader.once('data', (d: Buffer) => resolve(String(d))))
toLeader.write('through the daemon')
out.streamToLeader = await echoed
toLeader.destroy()
const toFollower = await L1.streams.open('follower', { purpose: 'web' })
const reversed = new Promise<string>((resolve) => toFollower.once('data', (d: Buffer) => resolve(String(d))))
toFollower.write('abc')
out.streamToFollower = { echoed: await reversed, plugged: accepted }
toFollower.destroy()

// The leader goes away (its link closes): the same write is journaled for it.
L1.close()
let lastAway: unknown = null
const away = await until('the write to be journaled', async () => {
  const r = await link.request('follower.op', OP('draft two', 'op-away'))
  lastAway = r
  return r.ok === true ? r : null
}, 20_000).catch((err: Error) => { throw new Error(`${err.message}: last answer ${JSON.stringify(lastAway)}`) })
out.writeWhileLeaderAway = brief(away)
// The same op id asked again (a lost answer) journals once.
out.writeAskedAgain = brief(await link.request('follower.op', OP('draft two', 'op-away')))
const pending = await link.request('follower.pending', { sinceSeq: 0 })
out.pendingWhileAway = { ok: pending.ok, kinds: ((pending.records ?? []) as Array<{ kind: string }>).map((r) => r.kind) }
out.sendWhileAway = brief(await link.request('follower.send', { sid: 'cccccccc-3333-4333-8333-333333333333', text: 'x', messageId: 'qm-2' }))
// Report: the leader reads it back with server.status.
link.report({ marker: 'reported', answersOnline: false })

// A leader comes back: it drains the journal through the door and acks it.
const L2 = await leader()
const status2 = await until('the report', async () => {
  const s = await L2.call({ cmd: 'server.status', home: HOME })
  const st = s.status as { report?: { marker?: string } } | undefined
  return st?.report?.marker ? s : null
})
out.reportRead = (status2.status as { report: { marker: string } }).report.marker
const drained = await L2.call({ cmd: 'offline.drain', home: HOME, kinds: JOURNAL_V2_DRAINS })
const records = (drained.records ?? []) as Array<{ seq: number; kind: string; opId?: string; payload?: Record<string, unknown>; args?: Record<string, unknown> }>
out.drained = { ok: drained.ok, kinds: records.map((r) => r.kind), opIds: records.map((r) => r.opId), description: JSON.stringify(records).includes('draft two'), more: drained.more }
const acked = await L2.call({ cmd: 'offline.ack', home: HOME, seqs: records.map((r) => r.seq) })
out.acked = { ok: acked.ok, remaining: acked.remaining }
const after = await link.request('follower.pending', { sinceSeq: 0 })
out.pendingAfterAck = { ok: after.ok, kinds: ((after.records ?? []) as Array<{ kind: string }>).map((r) => r.kind) }

// How the follower arrived, from the daemon's own log: a socket link says hello, the seat does not.
runtime.saveNow()
const logs = fs.readdirSync(dir).filter((n) => /^daemon-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n')
const count = (s: string) => logs.split('\n').filter((l) => l.includes(s)).length
const wire = { helloLogged: count('follower: a server on this host follows its leader'), seatedLogged: count('follower: the server in this process follows its leader') }

// The service's seat only (review A3b S56-L3, L5; S34-L3): what the runtime's seat does that a socket never meets.
const seat: Record<string, unknown> = {}
if (arm === 'direct') {
  // A socket that says follower.hello with the follower's token: the seat in this process keeps it.
  const stray = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => { stray.onopen = () => resolve(); stray.onerror = () => reject(new Error('the door did not open')) })
  const hello = await new Promise<Record<string, unknown>>((resolve) => {
    stray.onmessage = (m) => { const v = JSON.parse(String(m.data)) as Record<string, unknown>; if (v.id === 1) resolve(v) }
    stray.send(JSON.stringify({ id: 1, cmd: 'follower.hello', home: HOME, walnutId: WALNUT, token }))
  })
  stray.close()
  seat.socketHello = { ok: hello.ok, errorKind: hello.errorKind }
  seat.stillFollowing = link.linkState()
  // The Walnut's data dir moves: its leader declares it from the new home, and hears the home this host keeps it under.
  const MOVED = '/acme/home-moved'
  const moved = await L2.call({ cmd: 'leader.configure', home: MOVED, walnutId: WALNUT, movedFrom: HOME, formerHomes: [HOME], drains: JOURNAL_V2_DRAINS })
  seat.moveAnswer = { ok: moved.ok, homeHere: moved.homeHere }
  // The service restarted on the new spec follows the new home: the seat resolves it as the socket path does.
  link.stop()
  const movedLink = createDirectFollowerLink({ ...wiring, home: MOVED, seat: () => runtime.follower })
  movedLink.start()
  await until('the moved link to follow', () => movedLink.linkState() === 'following' && movedLink.view() !== null)
  const st = await movedLink.request('follower.status')
  seat.movedStatus = { ok: st.ok, walnutId: st.walnutId, home: st.home }
  // Another in-process client takes the seat: the link takes it back on its next poll.
  const other = runtime.follower.attach(MOVED, {}, () => {})
  seat.otherSeatedAs = runtime.follower.seatedAs(other)
  await until('the seat taken back', () => runtime.follower.seatedAs(other) === null)
  seat.afterTakeBack = { linkState: movedLink.linkState(), status: (await movedLink.request('follower.status')).ok }
  other.close()
  movedLink.stop()
}

link.stop()
L2.close()
out.stopCode = await runtime.stop()
out.exitCalls = exitCalls.length
process.stdout.write(JSON.stringify({ arm, shared: out, wire, seat }) + '\n', () => process.exit(0))
