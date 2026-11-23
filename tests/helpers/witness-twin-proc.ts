/**
 * Run by tests/core/leader/switch/witness-twin.test.ts with bun: one real host daemon runtime (the standalone twin, as the
 * service's shape: no listening port, the door open), a follower link to it that hands every stream the leader opens
 * to a real leader door (src/replica/leader-door.ts, the witness route on it), and a leader of the Walnut on the daemon's
 * door that opens `follower` streams of purpose `replica` and sends witness requests over them, as
 * witness-transport.ts overDaemonLink does (link(host).openStream('follower', 'replica'), then requestOver).
 * Everything it prints is what the leader gets back, as one JSON line. argv: <temp root>.
 * MACHINE SAFETY: the temp root only; no CLI is started; the runtime is stopped by the script.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonRuntime } from '../../src/providers/daemon-standalone.ts'
import { createDirectFollowerLink } from '../../src/core/link/follower-link.ts'
import { createStreamEndpoint, type StreamEndpoint } from '../../src/lib/link-stream.ts'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.ts'
import { createLeaderDoor } from '../../src/replica/leader-door.ts'
import { requestOver } from '../../src/core/host-server/request-over.ts'
import { genesisConfigId } from '../../src/core/leader/permit/index.ts'
import { WITNESS_REQUEST_PATH, WITNESS_SETUP_PATH } from '../../src/core/leader/switch/witness-wire.ts'

const root = process.argv[2]!
const HOME = '/acme/home'
const WALNUT = 'w-acme'
const LIST = ['w1', 'w2', 'w3']
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
const witnessRoot = path.join(root, 'leader-witness')
fs.mkdirSync(path.join(dir, 'host-server'), { recursive: true, mode: 0o700 })
fs.mkdirSync(home, { recursive: true })
const token = crypto.randomBytes(32).toString('hex')
fs.writeFileSync(path.join(dir, 'host-server', 'server-0011223344556677.json'), JSON.stringify({
  spec: { v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [], cwd: root, log: path.join(root, 'follower.log'), port: 40123, settings: {}, env: {} },
  token,
}), { mode: 0o600 })

const runtime = await createDaemonRuntime({
  env: {
    ...process.env, HOME: home, SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'), WALNUT_JOURNAL_DIR: path.join(root, 'journal'),
    WALNUT_LEADER_QUIET_MS: '2500', WALNUT_TRUSTED_CLIENT_BEAT_MS: '400', WALNUT_LEADER_TAKEOVER_MS: '6000',
  },
  mode: 'start', listen: false, door: true, selfHome: HOME,
  exit: () => {},
})
await runtime.start()
const port = Number(await until('the door port', () => { try { return fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim() } catch { return '' } }))

// The host's service: a leader door whose witness route is on or off, as the experiment is.
let enabled = false
const door = createLeaderDoor({
  devices: { put: async () => ({}) } as never,
  witness: { enabled: async () => enabled, walnutId: () => WALNUT, root: () => witnessRoot },
})
const link = createDirectFollowerLink({
  walnutId: WALNUT, home: HOME, host: 'devbox', pollMs: 200,
  accept: (info: { from: string }) => (info.from === 'primary' ? (s: import('node:stream').Duplex) => { door.accept(s) } : null),
  log: () => {},
  seat: () => runtime.follower,
})
link.start()

/** The leader of the Walnut on the daemon's door: its session link (beating) and a stream endpoint. */
async function leader() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('the door did not open')) })
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  let next = 1
  const streams: StreamEndpoint = createStreamEndpoint({ send: (frame) => ws.send(JSON.stringify(frame)), accept: () => null })
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
  return { streams, close: () => { clearInterval(beat); ws.close() } }
}

const L = await leader()
await until('the link to follow', () => link.linkState() === 'following' && link.view() !== null)

/** One request on a fresh `follower`/`replica` stream, as overDaemonLink makes it. */
async function ask(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const stream = await L.streams.open('follower', { purpose: 'replica' })
  const res = await requestOver(stream, 'POST', route, Buffer.from(JSON.stringify(body)), 10_000)
  const json = await res.json().catch(() => null)
  stream.destroy()
  return { status: res.status, body: json }
}
const read = (witness: string, round: number) => ask(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness, request: { type: 'read' }, round })
const record = { number: 1, kind: 'grant', holder: 'A', by: 'A', nonce: 'n1', validMs: 60_000, list: LIST, cfg: genesisConfigId(LIST), epoch: 0 }

// The experiment off on this host: every witness path answers like a path the service never had.
out.neverHad = await ask('/host-api/never-had-this', {})
out.offRead = await read('w1', 1)
// On, not set up: the same bytes.
enabled = true
out.onNotSetUp = await read('w1', 1)
// Set up, with evidence that nothing held a record; then a read, a grant and a read again.
out.setup = await ask(WITNESS_SETUP_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence: [{ witness: 'w2', seen: 'absent' }, { witness: 'w3', seen: 'absent' }] })
out.setupAgainWithRecords = await ask(WITNESS_SETUP_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence: [{ witness: 'w2', seen: 'record' }, { witness: 'w3', seen: 'absent' }] })
out.readAfterSetup = await read('w1', 2)
out.grant = await ask(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'propose', record } })
out.readAfterGrant = await read('w1', 3)
// Another Walnut's call is refused.
out.otherWalnut = await ask(WITNESS_REQUEST_PATH, { v: 1, walnutId: 'w-other', witness: 'w1', request: { type: 'read' }, round: 4 })
out.recordOnDisk = fs.existsSync(path.join(witnessRoot, WALNUT, 'w1', 'permit-record.json'))

link.stop()
L.close()
await door.close()
out.stopCode = await runtime.stop()
process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0))
