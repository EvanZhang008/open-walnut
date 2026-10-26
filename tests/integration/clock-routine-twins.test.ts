/**
 * Clock routines (clock-routine-v1) on a REAL daemon, both twins: a routine whose
 * work runs on this host keeps its clock in the daemon, fires on the schedule and
 * is delivered into the task's live session here while no server is connected.
 *
 * What it pins: the catch-up rule (one run for every slot missed), delivery into
 * a same-host session in the scheduled envelope, no second run while one is owed,
 * a restart that neither repeats nor loses a run, and a release that keeps every
 * run the server has not recorded (the one the host delivered, the one nobody
 * took, one claimed whose answer was lost) and replays it until it is acked, a
 * restart included. One def the daemon cannot take is refused alone, and a clock
 * never runs a slot at or before the routine's last run.
 *
 * A claude-code routine whose def carries `start` (clock-host-start-v1) is started
 * by the host itself when no server takes its run: the CLI from the Mac's routine
 * spawn template, then its task-create and session records in the journal, then the
 * fire marked as started; a server that comes back records the run (the fire's
 * replay, a claim) and never starts it again, and a daemon that dies between the CLI
 * and the records starts nothing twice.
 *
 * What's real: the daemon process (source twin under node with its trigger
 * sidecar bundled into its dir; standalone twin under bun), the state files, a
 * mock CLI reading its FIFO. The Walnut server is a bare WS client. Every daemon
 * is stopped by the pid it wrote into its own temp dir, every mock CLI by the pid it
 * recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { buildRoutineSpawnTemplate } from '../../src/providers/spawn-template.js'
import { START_TASK_TOKEN } from '../../src/providers/trigger-clock-core.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const SID = 'cccccccc-7777-4777-8777-777777777777'
const TASK = 'mclock00-0c11'
const DIGEST = 'mclockd0-a1a1'
const ONCE = 'mclocko0-b2b2'
const OWED = 'mclockw0-c3c3'
const GRACE_MS = 1_500
const HOUR = 3_600_000
const PROMPT = 'Write the daily digest for the team. é中'

const bunPath = (() => {
  for (const p of [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

/** The mock CLI: every user message it reads lands in its inbox file. */
const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const inbox = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
  }
})
setInterval(() => {}, 1 << 30)
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

async function spawnDaemon(twin: 'source' | 'standalone', reuseDir?: string, extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `walnut-clock-${twin}-`))
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_HOST_GRACE_MS: String(GRACE_MS),
    WALNUT_TRIGGER_REPLAY_MS: '60000',
    ...extraEnv,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR; delete env.WALNUT_JOURNAL_DIR
  // A run from inside a Walnut session inherits its API root and gateway: none may reach these daemons.
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    buildSync({
      entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
    })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

/** Stop a daemon this test started, by the pid it wrote, and wait until it is gone. */
async function stopDaemon(d: Daemon): Promise<void> {
  const exited = new Promise<void>((r) => { if (d.proc.exitCode !== null) r(); else d.proc.once('exit', () => r()) })
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  await Promise.race([exited, sleep(10_000)])
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(d.dir, f)) } catch { /* gone */ } }
}

class FakeServer {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (m: Record<string, unknown>) => void>()
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const w = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (w) { this.waiters.delete(msg.id as number); w(msg) }
    })
  }
  static async connect(port: number): Promise<FakeServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    return new FakeServer(ws)
  }
  cmd(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...body }))
    })
  }
  fires(id: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.ev === 'trigger.fired' && e.id === id)
  }
  close(): Promise<void> {
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.data && typeof reply.data === 'object' ? reply.data : reply) as Record<string, unknown>
}

function slice(): HostSlice {
  return {
    v: 1, home: HOME, hash: `h-${HOME}`, asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: SID, taskId: TASK, title: 'Digest' }],
    tasks: [{ id: TASK, title: 'Team digest', phase: 'IN_PROGRESS', project: 'Ops' }],
    requests: [],
  }
}

describe.each(bunPath ? ['source', 'standalone'] as const : ['source'] as const)('clock routines on the real %s daemon', (twin) => {
  let d: Daemon
  let inbox: string
  const T0 = Date.now()
  // Hourly, anchored 3.5h back: the daemon owns three past slots and the next is half an hour out.
  const anchor = T0 - 3.5 * HOUR
  const digestFrom = anchor + HOUR

  const digestDef = (fromMs = digestFrom) => ({
    id: DIGEST, name: 'Daily digest',
    clock: { schedule: { kind: 'every', everyMs: HOUR, anchorMs: anchor }, fromMs },
    deliver: { home: HOME, taskId: TASK, prompt: PROMPT },
  })
  const onceDef = (onceAt: string) => ({
    id: ONCE, name: 'One reminder',
    clock: { schedule: { kind: 'at', at: onceAt }, fromMs: Date.parse(onceAt) },
    deliver: { home: HOME, taskId: TASK, prompt: 'The one reminder.' },
  })
  // No deliver (a claude-code routine): its runs wait for the server. Every 4s, so slots pass during the test.
  const owedDef = (fromMs: number) => ({
    id: OWED, name: 'Nightly build', everyMs: 4_000,
    clock: { schedule: { kind: 'every', everyMs: 4_000, anchorMs: T0 - 60_000 }, fromMs },
  })

  const delivered = (): string[] => {
    try { return fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content)) } catch { return [] }
  }
  const scheduled = (name: string) => delivered().filter((c) => c.includes('<walnut-message kind="trigger"') && c.includes(`from="Trigger: ${name}"`))
  const triggersFile = () => JSON.parse(fs.readFileSync(path.join(d.dir, 'triggers.json'), 'utf8')) as {
    triggers: Array<{ id: string }>
    draining?: Array<{ id: string }>
  }
  const stateOf = (id: string) => JSON.parse(fs.readFileSync(path.join(d.dir, 'trigger-state', `${id}.json`), 'utf8')) as {
    pendingFires: Array<Record<string, unknown> & { seq: number; clock?: { slotMs: number; fromMs: number } }>
    clock?: { fromMs: number; nextRunAtMs?: number }
    seq: number
  }

  async function configure(server: FakeServer, triggers: unknown[]): Promise<Record<string, unknown>> {
    const r = await server.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return data(r)
  }

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    inbox = path.join(d.dir, 'inbox.jsonl')
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    const server = await FakeServer.connect(d.port)
    const hello = await server.cmd({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('clock-routine-v1')
    const started = await server.cmd({
      cmd: 'start', sid: SID, cwd: d.dir, message: 'init',
      args: [process.execPath, mock, SID, inbox], origin: { home: HOME, task: TASK },
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitFor(() => {
      try { return fs.readFileSync(path.join(d.dir, 'streams', `${SID}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
    }, 20_000, 'session idle')
    expect((await server.cmd({ cmd: 'host.slice', slice: slice() })).ok).toBe(true)
    await server.close()
  }, 90_000)

  afterAll(async () => { if (d) await stopDaemon(d) })

  it('with no server connected, catches up ONCE on the slots it missed, into the live session', async () => {
    const server = await FakeServer.connect(d.port)
    const reply = await configure(server, [digestDef()])
    expect(reply.clocks).toEqual([{ id: DIGEST, fromMs: digestFrom, nextRunAtMs: digestFrom }])
    await server.close()
    await waitFor(() => scheduled('Daily digest').length > 0, 25_000, 'the digest in the session')
    // Past the grace and two ticks: still one run for the three missed slots.
    await sleep(GRACE_MS + 10_500)
    const runs = scheduled('Daily digest')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('note="scheduled"')
    expect(runs[0]).toContain(PROMPT)
    expect(runs[0]).toContain(`This run was due at ${new Date(digestFrom).toISOString()}`)
    const st = stateOf(DIGEST)
    expect(st.clock).toEqual({ fromMs: digestFrom, nextRunAtMs: anchor + 4 * HOUR })
    expect(st.pendingFires).toHaveLength(1)
    expect(st.pendingFires[0]).toMatchObject({ seq: 1, items: [], clock: { slotMs: digestFrom, fromMs: digestFrom }, host: { sessionId: SID, seqs: [1] } })
  })

  it('a returning server that takes the clock back still gets the run the host delivered, until it acks it', async () => {
    const server = await FakeServer.connect(d.port)
    // The routine no longer belongs here: the push leaves it out.
    const reply = await configure(server, [])
    expect(reply.clocks).toEqual([])
    expect(reply.released).toEqual([{ id: DIGEST, fromMs: digestFrom, nextRunAtMs: anchor + 4 * HOUR, pending: 1 }])
    await waitFor(() => server.fires(DIGEST).length > 0, 10_000, 'the replay')
    const replay = server.fires(DIGEST)[0]
    expect(replay).toMatchObject({ seq: 1, clock: { slotMs: digestFrom, fromMs: digestFrom }, host: { sessionId: SID } })
    // A released clock holds no slot to report.
    expect(replay.nextRunAtMs).toBeUndefined()
    expect(triggersFile().draining?.map((t) => t.id)).toEqual([DIGEST])
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: DIGEST, seq: 1 })).acked).toBe(true)
    expect(stateOf(DIGEST).pendingFires).toEqual([])
    expect(triggersFile().draining).toBeUndefined()
    // Handed again under the same mark, it keeps its place.
    const again = await configure(server, [digestDef()])
    expect(again.clocks).toEqual([{ id: DIGEST, fromMs: digestFrom, nextRunAtMs: anchor + 4 * HOUR }])
    await server.close()
    expect(scheduled('Daily digest')).toHaveLength(1)
  })

  it('refuses a def it cannot take alone, and runs no slot at or before the routine’s last run', async () => {
    const server = await FakeServer.connect(d.port)
    const bad = { id: 'mclockx0-d4d4', name: 'Bad', clock: { schedule: { kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' }, fromMs: digestFrom } }
    // The routine ran at 4.5h elsewhere (an older Mac, Run now on the server): 4h is spent.
    const floored = { ...digestDef(), clock: { ...digestDef().clock, notBeforeMs: anchor + 4.5 * HOUR } }
    const reply = await configure(server, [floored, bad])
    expect(reply.refused).toEqual([{ id: bad.id, error: expect.any(String) }])
    expect(reply.clocks).toEqual([{ id: DIGEST, fromMs: digestFrom, nextRunAtMs: anchor + 5 * HOUR }])
    expect(triggersFile().triggers.map((t) => t.id)).toEqual([DIGEST])
    await server.close()
  })

  it('while a run nobody took is owed, later slots add no second run; a release keeps it, claimed or not, until acked', async () => {
    const server = await FakeServer.connect(d.port)
    const from = T0 - 60_000 + 4_000
    await configure(server, [digestDef(), owedDef(from)])
    // The catch-up run, then at least three more slots pass with it still owed.
    await waitFor(() => server.fires(OWED).length > 0, 15_000, 'the owed run')
    await sleep(13_000)
    expect(server.fires(OWED)).toHaveLength(1)
    const st = stateOf(OWED)
    expect(st.pendingFires).toHaveLength(1)
    expect(st.pendingFires[0].clock).toEqual({ slotMs: from, fromMs: from })
    expect(st.pendingFires[0].host).toBeUndefined()
    // The clock moved on past those slots (to within a tick of now).
    expect(st.clock!.nextRunAtMs!).toBeGreaterThan(from + 3 * 4_000)
    expect(st.clock!.nextRunAtMs!).toBeGreaterThan(Date.now() - 6_000)
    // A claim whose answer the server never got.
    const epoch = String(server.fires(OWED)[0].epoch)
    expect(data(await server.cmd({ cmd: 'triggers.claim', triggerId: OWED, epoch, seqs: [1] }))).toMatchObject({ claimed: [1] })
    // The server takes the clock back: the run stays with the daemon and replays.
    const reply = await configure(server, [digestDef()])
    const released = reply.released as Array<Record<string, unknown>>
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ id: OWED, fromMs: from, pending: 1 })
    await waitFor(() => server.fires(OWED).length > 1, 10_000, 'the replay after the release')
    expect(server.fires(OWED)[1]).toMatchObject({ seq: 1, clock: { slotMs: from, fromMs: from }, replay: true })
    expect(stateOf(OWED).pendingFires.map((f) => f.seq)).toEqual([1])
    // The server asks again and gets it: the run is its own, once.
    expect(data(await server.cmd({ cmd: 'triggers.claim', triggerId: OWED, epoch, seqs: [1] }))).toMatchObject({ claimed: [1] })
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: OWED, seq: 1 })).acked).toBe(true)
    expect(stateOf(OWED).pendingFires).toEqual([])
    expect(data(await server.cmd({ cmd: 'triggers.claim', triggerId: OWED, epoch, seqs: [1] }))).toMatchObject({ claimed: [], unknown: [1] })
    await server.close()
  })

  it('a new handover mark starts the clock over and drops a run nobody took under the old one', async () => {
    const server = await FakeServer.connect(d.port)
    const first = T0 - 60_000 + 8_000
    await configure(server, [digestDef(), owedDef(first)])
    await waitFor(() => stateOf(OWED).pendingFires.length > 0, 15_000, 'an owed run')
    const later = Date.now() + 10 * HOUR
    const reply = await configure(server, [digestDef(), owedDef(later)])
    expect((reply.clocks as Array<Record<string, unknown>>).find((c) => c.id === OWED)).toEqual({ id: OWED, fromMs: later, nextRunAtMs: later })
    expect(stateOf(OWED).pendingFires).toEqual([])
    await configure(server, [digestDef()])
    await server.close()
  })

  it('a manual run fires now and leaves the schedule where it was', async () => {
    const server = await FakeServer.connect(d.port)
    const before = stateOf(DIGEST).clock
    const r = data(await server.cmd({ cmd: 'triggers.run', triggerId: DIGEST }))
    expect(r).toMatchObject({ ran: true, outcome: 'fired' })
    await waitFor(() => server.fires(DIGEST).some((e) => e.seq === 2), 10_000, 'the manual run')
    expect(stateOf(DIGEST).clock).toEqual(before)
    expect(server.fires(DIGEST).find((e) => e.seq === 2)).toMatchObject({ clock: { fromMs: digestFrom } })
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: DIGEST, seq: 2 })).acked).toBe(true)
    await server.close()
  })

  it('a slot that passes while the daemon is down runs once after the restart, and a second restart repeats nothing', async () => {
    const onceAt = new Date(Date.now() + 3_000).toISOString()
    const server = await FakeServer.connect(d.port)
    await configure(server, [digestDef(), onceDef(onceAt)])
    await server.close()
    // Down before the first-run delay ends, so the slot passes while nothing runs.
    await stopDaemon(d)
    const digestSeq = (JSON.parse(fs.readFileSync(path.join(d.dir, 'trigger-state', `${DIGEST}.json`), 'utf8')) as { seq: number }).seq
    await waitFor(() => Date.now() > Date.parse(onceAt) + 500, 60_000, 'the one-shot slot to pass')
    d = await spawnDaemon(twin, d.dir)
    // The boot delay, then one run of the missed one-shot; the digest's slot is still ahead.
    await waitFor(() => { try { return stateOf(ONCE).seq === 1 } catch { return false } }, 40_000, 'the missed one-shot to run')
    await sleep(GRACE_MS + 6_000)
    const once = stateOf(ONCE)
    expect(once.seq).toBe(1)
    expect(once.clock).toEqual({ fromMs: Date.parse(onceAt) })
    expect(once.pendingFires[0].clock).toEqual({ slotMs: Date.parse(onceAt), fromMs: Date.parse(onceAt) })
    expect(stateOf(DIGEST).seq).toBe(digestSeq)
    await stopDaemon(d)
    d = await spawnDaemon(twin, d.dir)
    await sleep(15_000 + GRACE_MS + 6_000)
    expect(stateOf(ONCE).seq).toBe(1)
    expect(stateOf(DIGEST).seq).toBe(digestSeq)
  }, 180_000)

  it('a released clock’s run survives a restart and replays to the next server until acked', async () => {
    let server = await FakeServer.connect(d.port)
    const from = Date.now() - 2_000
    await configure(server, [digestDef(), owedDef(from)])
    await waitFor(() => { try { return stateOf(OWED).pendingFires.some((f) => f.clock?.fromMs === from) } catch { return false } }, 20_000, 'a run under the new mark')
    const seq = stateOf(OWED).pendingFires.find((f) => f.clock?.fromMs === from)!.seq
    const reply = await configure(server, [digestDef()])
    expect((reply.released as Array<Record<string, unknown>>).find((r) => r.id === OWED)).toMatchObject({ id: OWED, pending: 1 })
    await server.close()
    await stopDaemon(d)
    d = await spawnDaemon(twin, d.dir)
    // The one-shot that ran after the last restart was never acked either: it drains too.
    expect(triggersFile().draining?.map((t) => t.id).sort()).toEqual([ONCE, OWED].sort())
    server = await FakeServer.connect(d.port)
    await configure(server, [digestDef()])
    await waitFor(() => server.fires(OWED).some((e) => e.seq === seq), 10_000, 'the replay after the restart')
    await waitFor(() => server.fires(ONCE).length > 0, 10_000, 'the one-shot replay')
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: OWED, seq })).acked).toBe(true)
    expect(stateOf(OWED).pendingFires).toEqual([])
    expect(triggersFile().draining?.map((t) => t.id)).toEqual([ONCE])
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: ONCE, seq: 1 })).acked).toBe(true)
    expect(triggersFile().draining).toBeUndefined()
    await server.close()
  }, 90_000)
})

/**
 * The mock `claude` a routine template names: records its argv, cwd and pid, and every
 * user line it reads, under OUT. One program, as `claude` is (a shell wrapper).
 */
function routineMock(base: string): { mock: string; out: string } {
  const out = path.join(base, 'mock-out')
  fs.mkdirSync(out, { recursive: true })
  const script = path.join(base, 'routine-mock-cli.cjs')
  fs.writeFileSync(script, `
const fs = require('fs')
const OUT = ${JSON.stringify(out)}
const argv = process.argv.slice(2)
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const sid = at('--session-id') || at('--resume') || 'none'
fs.appendFileSync(OUT + '/calls.jsonl', JSON.stringify({ pid: process.pid, sid, argv, cwd: process.cwd() }) + '\\n')
fs.appendFileSync(OUT + '/pids.txt', process.pid + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (!m || m.type !== 'user') continue
    const c = m.message && m.message.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('') : ''
    fs.appendFileSync(OUT + '/stdin.jsonl', JSON.stringify({ sid, text }) + '\\n')
    out({ type: 'result', subtype: 'success', is_error: false, result: 'built', session_id: sid })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  }
})
setInterval(() => {}, 1 << 30)
`)
  const mock = path.join(base, 'claude')
  fs.writeFileSync(mock, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 })
  return { mock, out }
}

function lines<T>(file: string): T[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) } catch { return [] }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe.each(bunPath ? ['source', 'standalone'] as const : ['source'] as const)('a claude-code routine run the real %s daemon starts itself', (twin) => {
  const ROUTINE = 'mclockr0-e5e5'
  const WALNUT = 'wwalnuthome01'
  const MESSAGE = 'Build the nightly and report. é中'
  const T0 = Date.now()
  // Hourly, anchored half an hour back: one slot is owed now, the next is half an hour out.
  const anchor = T0 - 0.5 * HOUR
  const bases: string[] = []

  const startOf = (cwd: string) => ({
    home: HOME, host: 'devbox', title: 'Routine: Nightly build', project: 'Routines', cwd, message: MESSAGE, mode: 'bypass',
    context: `You are working on the task "Routine: Nightly build" (id ${START_TASK_TOKEN}, project "Routines").`,
  })
  const routineDef = (cwd: string) => ({
    id: ROUTINE, name: 'Nightly build', everyMs: 0,
    clock: { schedule: { kind: 'every', everyMs: HOUR, anchorMs: anchor }, fromMs: anchor },
    start: startOf(cwd),
  })
  const stateIn = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'trigger-state', `${ROUTINE}.json`), 'utf8')) as {
    pendingFires: Array<Record<string, any> & { seq: number }>
    seq: number
  }

  /** The Mac connects: describes its Walnut (the v2 drains) and pushes its copy. */
  async function macConnects(d: Daemon): Promise<FakeServer> {
    const mac = await FakeServer.connect(d.port)
    const conf = await mac.cmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false, drains: JOURNAL_V2_DRAINS })
    expect(conf.ok, JSON.stringify(conf)).toBe(true)
    expect((await mac.cmd({ cmd: 'host.slice', slice: { ...slice(), sessions: [], tasks: [] } })).ok).toBe(true)
    return mac
  }

  /** Drain everything the host journaled, acking each batch. */
  async function macDrains(mac: FakeServer): Promise<Array<Record<string, any>>> {
    const all: Array<Record<string, any>> = []
    for (let round = 0; round < 20; round++) {
      const r = await mac.cmd({ cmd: 'offline.drain', home: HOME, kinds: JOURNAL_V2_DRAINS })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const recs = (data(r).records ?? []) as Array<Record<string, any>>
      if (!recs.length) break
      all.push(...recs)
      expect((await mac.cmd({ cmd: 'offline.ack', home: HOME, seqs: recs.map((x) => x.seq) })).ok).toBe(true)
    }
    return all
  }

  /** A daemon with the Mac's routine template and the routine's clock, and no server connected. */
  async function setUp(name: string, extraEnv: Record<string, string> = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-rstart-${twin}-${name}-`))
    bases.push(base)
    const cwd = path.join(base, 'repo')
    fs.mkdirSync(cwd)
    const m = routineMock(base)
    const d = await spawnDaemon(twin, path.join(base, 'daemon'), extraEnv)
    const mac = await macConnects(d)
    const hello = await mac.cmd({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('clock-host-start-v1')
    const template = buildRoutineSpawnTemplate({ home: HOME, hostKey: 'devbox', cliCommand: m.mock, env: {} })
    const t = await mac.cmd({ cmd: 'leader.spawnTemplate', home: HOME, template, use: 'routine' })
    expect(t.ok, JSON.stringify(t)).toBe(true)
    const reply = data(await mac.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers: [routineDef(cwd)] } }))
    expect(reply.refused ?? []).toEqual([])
    await mac.close()
    return { base, cwd, m, d }
  }

  afterAll(() => {
    // Only the CLIs these daemons started for this test (each recorded its own pid).
    for (const base of bases) {
      for (const pid of lines<number>(path.join(base, 'mock-out', 'pids.txt'))) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('with no server: starts the run once from the Mac\'s template, journals its task and session, and a later server records it and starts nothing', async () => {
    const { cwd, m, d } = await setUp('once')
    try {
      await waitFor(() => lines(path.join(m.out, 'calls.jsonl')).length > 0, 40_000, 'the routine CLI')
      const [call] = lines<{ pid: number; sid: string; argv: string[]; cwd: string }>(path.join(m.out, 'calls.jsonl'))
      expect(call.sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(cwd))
      expect(call.argv[call.argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      const ctx = call.argv[call.argv.indexOf('--append-system-prompt') + 1]
      expect(ctx).not.toContain(START_TASK_TOKEN)
      const taskId = /\(id ([^,]+), project "Routines"\)/.exec(ctx)?.[1] ?? ''
      expect(taskId).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/)
      expect(call.argv).not.toContain('--allowedTools')
      await waitFor(() => lines<{ text: string }>(path.join(m.out, 'stdin.jsonl')).some((l) => l.text === MESSAGE), 20_000, 'the instructions on stdin')
      // The fire is marked as started here, with its session and task.
      await waitFor(() => !!stateIn(d.dir).pendingFires[0]?.host, 10_000, 'the started mark')
      const fire = stateIn(d.dir).pendingFires[0]
      expect(fire).toMatchObject({ seq: 1, clock: { slotMs: anchor }, host: { sessionId: call.sid, started: true, taskId, seqs: [1] } })
      // Past the grace and the retry: still one CLI, one run.
      await sleep(GRACE_MS + 6_000)
      expect(lines(path.join(m.out, 'calls.jsonl'))).toHaveLength(1)
      expect(stateIn(d.dir).seq).toBe(1)

      // A server comes back: the journal holds the run's task, then its session.
      const mac = await macConnects(d)
      const recs = await macDrains(mac)
      expect(recs.map((r) => r.kind)).toEqual(['task-create', 'session'])
      expect(recs[0]).toMatchObject({ taskId, fields: { title: 'Routine: Nightly build', pinned: false }, placement: { project: 'Routines' }, actor: { kind: 'trigger', id: ROUTINE } })
      expect(recs[1]).toMatchObject({ sid: call.sid, taskId, host: 'devbox', cwd, mode: 'bypass', title: 'Routine: Nightly build', firstMessage: MESSAGE, routine: { id: ROUTINE, slotMs: anchor } })
      expect(recs[1].agentId).toBeUndefined()
      // The fire replays with its mark, and a claim of it gets the run back: the server records it.
      const again = data(await mac.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers: [routineDef(cwd)] } }))
      expect(again.refused ?? []).toEqual([])
      await waitFor(() => mac.fires(ROUTINE).some((e) => (e.host as Record<string, unknown> | undefined)?.started === true), 10_000, 'the replay with its mark')
      const epoch = String(mac.fires(ROUTINE)[0].epoch)
      const claim = data(await mac.cmd({ cmd: 'triggers.claim', triggerId: ROUTINE, epoch, seqs: [1] }))
      expect(claim).toMatchObject({ claimed: [], host: [{ seq: 1, host: { sessionId: call.sid, started: true, taskId } }] })
      expect(data(await mac.cmd({ cmd: 'triggers.ack', triggerId: ROUTINE, seq: 1 })).acked).toBe(true)
      await mac.close()
      await sleep(GRACE_MS + 3_000)
      expect(lines(path.join(m.out, 'calls.jsonl'))).toHaveLength(1)
      expect(stateIn(d.dir).pendingFires).toEqual([])
    } finally {
      await stopDaemon(d)
    }
  }, 120_000)

  it('a server that answers takes the run itself: the host starts nothing', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-rstart-${twin}-mac-`))
    bases.push(base)
    const cwd = path.join(base, 'repo')
    fs.mkdirSync(cwd)
    const m = routineMock(base)
    const d = await spawnDaemon(twin, path.join(base, 'daemon'))
    try {
      const mac = await macConnects(d)
      const template = buildRoutineSpawnTemplate({ home: HOME, hostKey: 'devbox', cliCommand: m.mock, env: {} })
      expect((await mac.cmd({ cmd: 'leader.spawnTemplate', home: HOME, template, use: 'routine' })).ok).toBe(true)
      await mac.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers: [routineDef(cwd)] } })
      await waitFor(() => mac.fires(ROUTINE).length > 0, 40_000, 'the fire')
      const epoch = String(mac.fires(ROUTINE)[0].epoch)
      expect(data(await mac.cmd({ cmd: 'triggers.claim', triggerId: ROUTINE, epoch, seqs: [1] }))).toMatchObject({ claimed: [1] })
      await sleep(GRACE_MS + 4_000)
      expect(lines(path.join(m.out, 'calls.jsonl'))).toEqual([])
      expect(stateIn(d.dir).pendingFires[0].host).toBeUndefined()
      await mac.close()
    } finally {
      await stopDaemon(d)
    }
  }, 90_000)

  it('a daemon that dies between the CLI and the records starts nothing twice: the next boot journals both, once, and marks the fire', async () => {
    const set = await setUp('crash', { WALNUT_TEST_DIE_AFTER_ROUTINE_SPAWN: '1' })
    const { cwd, m } = set
    let d = set.d
    try {
      await waitFor(() => lines(path.join(m.out, 'calls.jsonl')).length > 0, 40_000, 'the routine CLI')
      await waitFor(() => !alive(d.pid), 20_000, 'the daemon death')
      const [call] = lines<{ pid: number; sid: string }>(path.join(m.out, 'calls.jsonl'))
      expect(alive(call.pid)).toBe(true)
      for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(d.dir, f)) } catch { /* gone */ } }
      d = await spawnDaemon(twin, d.dir)
      // Past the boot, the grace and a tick: the run is marked as started, from its journaled session.
      await waitFor(() => { try { return !!stateIn(d.dir).pendingFires[0]?.host } catch { return false } }, 40_000, 'the started mark after the restart')
      expect(stateIn(d.dir).pendingFires[0].host).toMatchObject({ sessionId: call.sid, started: true })
      await sleep(GRACE_MS + 4_000)
      // One more boot: still nothing new.
      await stopDaemon(d)
      d = await spawnDaemon(twin, d.dir)
      await sleep(GRACE_MS + 8_000)
      expect(lines(path.join(m.out, 'calls.jsonl'))).toHaveLength(1)
      const mac = await macConnects(d)
      const recs = await macDrains(mac)
      expect(recs.map((r) => r.kind)).toEqual(['task-create', 'session'])
      expect(recs[1]).toMatchObject({ sid: call.sid, cwd, routine: { id: ROUTINE, slotMs: anchor } })
      expect(recs[1].taskId).toBe(recs[0].taskId)
      await mac.close()
    } finally {
      await stopDaemon(d)
    }
  }, 180_000)

  it('a server that claims a run whose mark a daemon death cut gets the run back, never the run to start again', async () => {
    const set = await setUp('claim', { WALNUT_TEST_DIE_AFTER_ROUTINE_SPAWN: '1' })
    const { cwd, m } = set
    let d = set.d
    try {
      await waitFor(() => lines(path.join(m.out, 'calls.jsonl')).length > 0, 40_000, 'the routine CLI')
      await waitFor(() => !alive(d.pid), 20_000, 'the daemon death')
      const [call] = lines<{ pid: number; sid: string }>(path.join(m.out, 'calls.jsonl'))
      for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(d.dir, f)) } catch { /* gone */ } }
      // A long grace: the host does not get to mark the run itself before the server claims it.
      d = await spawnDaemon(twin, d.dir, { WALNUT_TRIGGER_HOST_GRACE_MS: '120000' })
      expect(stateIn(d.dir).pendingFires[0].host).toBeUndefined()
      const mac = await macConnects(d)
      await mac.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers: [routineDef(cwd)] } })
      await waitFor(() => mac.fires(ROUTINE).length > 0, 10_000, 'the replay of the unmarked run')
      const epoch = String(mac.fires(ROUTINE)[0].epoch)
      const claim = data(await mac.cmd({ cmd: 'triggers.claim', triggerId: ROUTINE, epoch, seqs: [1] }))
      expect(claim).toMatchObject({ claimed: [], host: [{ seq: 1, host: { sessionId: call.sid, started: true } }] })
      expect(stateIn(d.dir).pendingFires[0].host).toMatchObject({ sessionId: call.sid, started: true })
      const recs = await macDrains(mac)
      expect(recs.map((r) => r.kind)).toEqual(['task-create', 'session'])
      expect(data(await mac.cmd({ cmd: 'triggers.ack', triggerId: ROUTINE, seq: 1 })).acked).toBe(true)
      await mac.close()
      await sleep(3_000)
      expect(lines(path.join(m.out, 'calls.jsonl'))).toHaveLength(1)
    } finally {
      await stopDaemon(d)
    }
  }, 180_000)
})
