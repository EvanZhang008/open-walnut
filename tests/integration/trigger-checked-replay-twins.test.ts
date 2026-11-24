/**
 * A host's latest quiet or failed check reaches the server when it comes back, on
 * the real standalone daemon.
 *
 * The incident (2026-11-14): the server lost its link to a dev host for about six
 * hours. The daemon's log shows it kept checking all four triggers the whole time,
 * every run quiet; but a quiet run is a `trigger.checked` event sent once to whoever
 * listens, so the server's last check time stayed six hours old, and the trigger
 * page called four healthy watches stalled. Now the daemon keeps the latest
 * checked event in each trigger's state (cleared by a fire) and replays it on a
 * `triggers.configure` or probe that asks (`replayChecks: true`), after a daemon
 * restart too; and a restarted daemon runs its first check within one interval
 * (the old 15 s boot delay was longer than the 10 s minimum interval).
 *
 * What's real: the daemon process (the standalone, under bun), its trigger and
 * state files, restarts, /bin/sh checks that stay quiet, die mid-run or outlive
 * the daemon. What's faked: the Walnut server is a bare WS client. No triggers.run, pause or resume is sent:
 * every check here is the daemon's own clock. Every daemon is stopped by SIGTERM
 * to the pid it wrote into its own temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const EVERY_MS = 10_000
/** The daemon's tick: a due check starts on the first tick after its time. */
const TICK_MS = 5_000
/** After this many failures in a row the daemon checks only every 5 minutes. */
const MAX_ERRORS = 5
const BACKOFF_MS = 5 * 60_000
/** Four watches, as in the incident. */
const IDS = ['mrpl0000-0001', 'mrpl0000-0002', 'mrpl0000-0003', 'mrpl0000-0004']
const [, , T_DIES, T_HANGS] = IDS

const BUN: string | undefined = testBun()

type Ev = Record<string, any> & { at: number }
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; readyAt: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(pick: () => T | undefined | false, ms: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const hit = pick()
    if (hit !== undefined && hit !== false) return hit
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

/** A daemon on `dir` (a fresh one when absent; the same dir again is a restart). */
async function spawnDaemon(existing?: string): Promise<Daemon> {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ckrp-'))
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* fresh dir */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_STATE_DIR: path.join(dir, 'trigger-state'),
    WALNUT_TRIGGER_REPLAY_MS: '60000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
  const stdio: ['ignore', 'ignore', 'pipe' | 'ignore'] = ['ignore', 'ignore', process.env.DEBUG_DAEMON ? 'pipe' : 'ignore']
  const proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio, cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  return {
    proc, dir, readyAt: Date.now(),
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

async function stopDaemon(d: Daemon): Promise<void> {
  const exited = new Promise<void>((r) => { if (d.proc.exitCode !== null || d.proc.signalCode !== null) r(); else d.proc.once('exit', () => r()) })
  // Only the pid this isolated daemon wrote into its own temp dir, and the child we spawned.
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  let cap: ReturnType<typeof setTimeout> | undefined
  await Promise.race([exited, new Promise<void>((r) => { cap = setTimeout(r, 15_000) })])
  clearTimeout(cap)
}

/** A stand-in Walnut server: commands with replies, and every event stamped with when it came. */
class FakeServer {
  private nextId = 1
  private waiters = new Map<number, (m: Record<string, any>) => void>()
  readonly events: Ev[] = []
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, any>
      const w = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (w) { this.waiters.delete(msg.id); w(msg) } else this.events.push({ ...msg, at: Date.now() })
    })
  }
  static async connect(port: number): Promise<FakeServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    return new FakeServer(ws)
  }
  cmd(body: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...body }))
    })
  }
  checks(id: string, pred: (e: Ev) => boolean = () => true): Ev[] {
    return this.events.filter((e) => e.ev === 'trigger.checked' && e.id === id && pred(e))
  }
  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }
}

describe.skipIf(!BUN)('latest trigger check replayed on the real standalone daemon', () => {
  let d: Daemon
  let s: FakeServer
  let check: string

  const set = () => ({ version: 1, triggers: IDS.map((id) => ({ id, name: `Watch ${id}`, everyMs: EVERY_MS, check: { run: `sh ${check} ${id}`, timeoutSeconds: 10 } })) })
  /** The returning server's full push, asking for the checks it missed. */
  const push = () => ({ cmd: 'triggers.configure', config: set(), home: HOME, pushHash: 'ph-1', replayChecks: true })
  const runsOf = (id: string) => { try { return fs.readFileSync(path.join(d.dir, `runs-${id}.log`), 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
  const setMode = (id: string, mode: string | null) => {
    const f = path.join(d.dir, `mode-${id}`)
    if (mode) fs.writeFileSync(f, mode); else fs.rmSync(f, { force: true })
  }
  /** The trigger's state file as the daemon wrote it, found under its Walnut's dir. */
  function statePath(id: string): string {
    const root = path.join(d.dir, 'trigger-state')
    const file = (fs.readdirSync(root, { recursive: true }) as string[]).find((f) => path.basename(f) === `${id}.json`)
    if (!file) throw new Error(`no state file for ${id}`)
    return path.join(root, file)
  }
  const stateOf = (id: string): Record<string, any> => JSON.parse(fs.readFileSync(statePath(id), 'utf8'))
  /** For a wait: a file mid-write reads as not there yet. */
  const stateNow = (id: string): Record<string, any> => { try { return stateOf(id) } catch { return {} } }
  /** Stand in for failures the stopped daemon had already counted (its own isolated file). */
  const seedErrors = (id: string, n: number) => fs.writeFileSync(statePath(id), JSON.stringify({ ...stateOf(id), consecutiveErrors: n }))
  /** Stop, seed `n` failures of T_DIES with its check still failing, start again: no server listens yet. */
  async function restartFailing(n: number): Promise<void> {
    await s.close()
    await stopDaemon(d)
    seedErrors(T_DIES, n)
    setMode(T_DIES, 'die')
    d = await spawnDaemon(d.dir)
  }
  /** One replayed checked event per trigger, each within 2 s of the reply: not the next scheduled run. */
  async function replays(server: FakeServer, ids: string[], repliedAt: number): Promise<Map<string, Ev>> {
    const out = new Map<string, Ev>()
    await waitFor(() => {
      for (const id of ids) { const r = server.checks(id, (e) => e.replay === true).at(-1); if (r) out.set(id, r) }
      return out.size === ids.length
    }, 2_000, `replayed checks of ${ids.join(', ')}`)
    for (const r of out.values()) expect(r.at - repliedAt).toBeLessThan(2_000)
    return out
  }

  beforeAll(async () => {
    d = await spawnDaemon()
    check = path.join(d.dir, 'check.sh')
    // Quiet unless its mode file says otherwise: `die` prints half an answer and exits
    // mid-run, `hang` is still running when the daemon is stopped (it ends by itself).
    fs.writeFileSync(check, [
      'id="$1"; dir="$(dirname "$0")"',
      'mode="$(cat "$dir/mode-$id" 2>/dev/null)"',
      'echo run >> "$dir/runs-$id.log"',
      'case "$mode" in',
      '  die) printf \'{"fire":\'; exit 3 ;;',
      '  hang) echo started > "$dir/hang-$id.log"; sleep 8 ;;',
      'esac',
      'printf \'{"fire":false}\\n\'',
    ].join('\n') + '\n')
    s = await FakeServer.connect(d.port)
    expect((await s.cmd({ cmd: 'hello' })).capabilities as string[]).toContain('triggers-probe-v1')
    expect(await s.cmd(push())).toMatchObject({ ok: true, applied: true, count: 4 })
  }, 60_000)

  afterAll(async () => {
    await s?.close()
    if (d) await stopDaemon(d)
    if (d?.dir) fs.rmSync(d.dir, { recursive: true, force: true })
  })

  it('checks keep running through a long absence, and only the probe that asks gets the latest of each, at once', async () => {
    // The first scheduled run of each, while the server listens.
    await waitFor(() => IDS.every((id) => s.checks(id, (e) => e.outcome === 'quiet' && e.replay !== true).length > 0), 20_000, 'a first check of each')
    await s.close()
    const goneAt = Date.now()
    const before = new Map(IDS.map((id) => [id, runsOf(id)]))
    // Nobody listens for two full cycles: each check still runs on the daemon's own clock.
    await waitFor(() => IDS.every((id) => runsOf(id) > before.get(id)! + 1), 2 * EVERY_MS + TICK_MS + 10_000, 'two checks of each while the server is away')
    // The second one ended at least one interval after the server left, and is kept as the latest.
    await waitFor(() => IDS.every((id) => (stateNow(id).lastCheck?.atMs ?? 0) > goneAt + EVERY_MS), 5_000, 'the latest check of each kept in its state')
    const replayed = (srv: FakeServer) => srv.events.filter((e) => e.ev === 'trigger.checked' && e.replay === true)

    // An older server of this Walnut comes back first: its probe asks for no replay and gets
    // none (a hello behind the reply orders anything the probe sent before it).
    const old = await FakeServer.connect(d.port)
    await old.cmd({ cmd: 'hello' })
    expect(await old.cmd({ cmd: 'triggers.configure', probe: true, hash: 'ph-1', home: HOME })).toMatchObject({ ok: true, held: true, count: 4 })
    await old.cmd({ cmd: 'hello' })
    expect(replayed(old)).toEqual([])

    s = await FakeServer.connect(d.port)
    await s.cmd({ cmd: 'hello' })
    const reply = await s.cmd({ cmd: 'triggers.configure', probe: true, hash: 'ph-1', home: HOME, replayChecks: true })
    expect(reply).toMatchObject({ ok: true, applied: true, held: true, count: 4 })
    const got = await replays(s, IDS, Date.now())
    for (const id of IDS) {
      const r = got.get(id)!
      expect(r, id).toMatchObject({ outcome: 'quiet', reason: 'fire-false', consecutiveErrors: 0, durationMs: expect.any(Number) })
      expect(r.atMs, `${id}: the latest check made while the server was away, not the first`).toBeGreaterThan(goneAt + EVERY_MS)
      expect(r.nextRunAtMs, `${id}: the next run is the daemon's schedule now`).toBeGreaterThan(r.atMs)
    }
    // The replay goes to the socket that asked; the other client of the same Walnut gets none.
    await old.cmd({ cmd: 'hello' })
    expect(replayed(old)).toEqual([])
    await old.close()
  }, 90_000)

  it('a restart keeps the latest check, replays it on a push that asks, and checks again within one interval', async () => {
    await stopDaemon(d)
    // Kept in the state file as the full event the server would have got.
    const kept = new Map(IDS.map((id) => [id, stateOf(id).lastCheck]))
    for (const id of IDS) {
      expect(kept.get(id), id).toMatchObject({ type: 'trigger.checked', id, outcome: 'quiet', reason: 'fire-false', atMs: expect.any(Number), durationMs: expect.any(Number), nextRunAtMs: expect.any(Number), consecutiveErrors: 0 })
    }
    const spawnedAt = Date.now()
    d = await spawnDaemon(d.dir)
    s = await FakeServer.connect(d.port)
    expect(await s.cmd(push())).toMatchObject({ ok: true, applied: true, count: 4 })
    const got = await replays(s, IDS, Date.now())
    for (const id of IDS) {
      const r = got.get(id)!
      expect(r, id).toMatchObject({ outcome: 'quiet', consecutiveErrors: 0 })
      expect(r.atMs, `${id}: the check kept from before the restart`).toBe(kept.get(id).atMs)
      // The schedule of this daemon, not the one that stopped: due within one interval of its boot.
      expect(r.nextRunAtMs).toBeGreaterThanOrEqual(spawnedAt)
      expect(r.nextRunAtMs).toBeLessThanOrEqual(d.readyAt + EVERY_MS)
    }
    // No triggers.run: the restarted daemon's own clock checks each again within one interval.
    await waitFor(() => IDS.every((id) => s.checks(id, (e) => e.replay !== true && e.atMs >= d.readyAt).length > 0), EVERY_MS + 10_000, 'a check of each after the restart')
    for (const id of IDS) {
      const first = s.checks(id, (e) => e.replay !== true && e.atMs >= d.readyAt)[0]
      expect(first, id).toMatchObject({ outcome: 'quiet' })
      expect(first.at - d.readyAt, `${id}: first check after the restart`).toBeLessThanOrEqual(EVERY_MS + 2_000)
    }
  }, 60_000)

  it('a check that dies mid-run is kept as the latest error, and the next scheduled run succeeds', async () => {
    const from = s.events.length
    setMode(T_DIES, 'die')
    const failed = await waitFor(() => s.events.slice(from).find((e) => e.ev === 'trigger.checked' && e.id === T_DIES && e.outcome === 'error'), EVERY_MS + TICK_MS + 10_000, 'the failed check')
    expect(failed.consecutiveErrors).toBeGreaterThanOrEqual(1)
    expect(stateOf(T_DIES).lastCheck, 'the failure is the latest check').toMatchObject({ type: 'trigger.checked', id: T_DIES, outcome: 'error', error: expect.any(String), atMs: failed.atMs })
    setMode(T_DIES, null)
    const healed = await waitFor(() => s.checks(T_DIES, (e) => e.replay !== true && e.atMs > failed.atMs).find((e) => e.outcome === 'quiet'), EVERY_MS + TICK_MS + 10_000, 'the next check')
    expect(healed.consecutiveErrors).toBe(0)
    expect(healed.at - failed.at, 'not wedged: the very next scheduled run').toBeLessThanOrEqual(EVERY_MS + TICK_MS + 2_000)
    // The other watches never stopped meanwhile.
    await waitFor(() => IDS.filter((x) => x !== T_DIES).every((id) => s.checks(id, (e) => e.replay !== true && e.atMs > failed.atMs).length > 0), EVERY_MS + TICK_MS + 5_000, 'the other watches checking on')
    // The quiet run replaced the error as the latest, and a probe replays that.
    expect(stateOf(T_DIES).lastCheck).toMatchObject({ outcome: 'quiet', atMs: healed.atMs, consecutiveErrors: 0 })
    const mark = s.events.length
    expect(await s.cmd({ cmd: 'triggers.configure', probe: true, hash: 'ph-1', home: HOME, replayChecks: true })).toMatchObject({ ok: true, held: true })
    const r = await waitFor(() => s.events.slice(mark).find((e) => e.ev === 'trigger.checked' && e.id === T_DIES && e.replay === true), 2_000, 'the replayed check')
    expect(r.atMs).toBeGreaterThanOrEqual(healed.atMs)
    expect(r.outcome).toBe('quiet')
  }, 90_000)

  it('a daemon stopped while a check runs comes back unwedged: it replays a finished check, and the next scheduled one runs', async () => {
    const latest = (stateOf(T_HANGS).lastCheck ?? {}) as Record<string, any>
    const hangLog = path.join(d.dir, `hang-${T_HANGS}.log`)
    fs.rmSync(hangLog, { force: true })
    setMode(T_HANGS, 'hang')
    await waitFor(() => fs.existsSync(hangLog), EVERY_MS + TICK_MS + 10_000, 'the long check to start')
    await s.close()
    await stopDaemon(d)
    setMode(T_HANGS, null)
    d = await spawnDaemon(d.dir)
    s = await FakeServer.connect(d.port)
    expect(await s.cmd({ cmd: 'triggers.configure', probe: true, hash: 'ph-1', home: HOME, replayChecks: true })).toMatchObject({ ok: true, held: true, count: 4 })
    const got = await replays(s, [T_HANGS], Date.now())
    const r = got.get(T_HANGS)!
    // A finished check (the one before the cut, or the cut one if the stop let it end), never a half one.
    expect(r).toMatchObject({ outcome: 'quiet', reason: 'fire-false', consecutiveErrors: 0 })
    expect(r.atMs).toBeGreaterThanOrEqual(latest.atMs ?? 0)
    // The restarted daemon's own clock checks it again, within one interval.
    const next = await waitFor(() => s.checks(T_HANGS, (e) => e.replay !== true && e.atMs >= d.readyAt)[0], EVERY_MS + 10_000, 'the check after the restart')
    expect(next).toMatchObject({ outcome: 'quiet', consecutiveErrors: 0 })
    expect(next.at - d.readyAt).toBeLessThanOrEqual(EVERY_MS + 2_000)
  }, 90_000)

  it('failures in a row while the server is away put a check on the long backoff; a reconnect that asks runs it again within one interval', async () => {
    // Five failures counted already; the boot keeps the count, and its own run fails once more.
    await restartFailing(MAX_ERRORS)
    await waitFor(() => stateNow(T_DIES).consecutiveErrors === MAX_ERRORS + 1, 2 * EVERY_MS + TICK_MS + 5_000, 'the failed check after the boot')
    const failed = stateOf(T_DIES).lastCheck
    expect(failed, 'kept as the latest check').toMatchObject({ type: 'trigger.checked', id: T_DIES, outcome: 'error', consecutiveErrors: MAX_ERRORS + 1 })
    expect(failed.nextRunAtMs - failed.atMs, 'on the long backoff').toBeGreaterThanOrEqual(BACKOFF_MS - 1_000)
    // The cause is gone; the server comes back.
    setMode(T_DIES, null)
    s = await FakeServer.connect(d.port)
    expect(await s.cmd(push())).toMatchObject({ ok: true, applied: true, count: 4 })
    const repliedAt = Date.now()
    const r = (await replays(s, [T_DIES], repliedAt)).get(T_DIES)!
    expect(r).toMatchObject({ outcome: 'error', consecutiveErrors: MAX_ERRORS + 1, atMs: failed.atMs })
    // Not the backoff's run in 5 minutes: the next run is pulled into this interval.
    expect(r.nextRunAtMs).toBeLessThanOrEqual(repliedAt + EVERY_MS)
    // No triggers.run: the daemon's own clock runs it, and it succeeds.
    const healed = await waitFor(() => s.checks(T_DIES, (e) => e.replay !== true && e.atMs > failed.atMs)[0], EVERY_MS + 10_000, 'the check after the reconnect')
    expect(healed).toMatchObject({ outcome: 'quiet', consecutiveErrors: 0 })
    expect(healed.at - repliedAt, 'within one interval of the reconnect').toBeLessThanOrEqual(EVERY_MS + 2_000)
  }, 90_000)

  it('a pause and resume (a set without it, then with it) gives a failing check a fresh count; a boot does not', async () => {
    await restartFailing(MAX_ERRORS)
    s = await FakeServer.connect(d.port)
    expect(await s.cmd(push())).toMatchObject({ ok: true, applied: true, count: 4 })
    // The boot kept the five: the first run here counts on from them.
    const kept = await waitFor(() => s.checks(T_DIES, (e) => e.replay !== true && e.outcome === 'error')[0], 2 * EVERY_MS + TICK_MS + 5_000, 'the failed check after the boot')
    expect(kept.consecutiveErrors).toBeGreaterThan(MAX_ERRORS)
    // Paused: the server's set leaves it out. Resumed: the set carries it again.
    const paused = { ...set(), triggers: set().triggers.filter((t) => t.id !== T_DIES) }
    expect(await s.cmd({ cmd: 'triggers.configure', config: paused, home: HOME, pushHash: 'ph-paused', replayChecks: true })).toMatchObject({ ok: true, count: 3 })
    const resumedAt = Date.now()
    expect(await s.cmd(push())).toMatchObject({ ok: true, applied: true, count: 4 })
    const first = await waitFor(() => s.checks(T_DIES, (e) => e.replay !== true && e.atMs > resumedAt)[0], EVERY_MS + 10_000, 'the first check after the resume')
    expect(first, 'a fresh count, not the old one plus one').toMatchObject({ outcome: 'error', consecutiveErrors: 1 })
    expect(first.nextRunAtMs - first.atMs, 'so the normal interval, not the backoff').toBeLessThanOrEqual(EVERY_MS + 1_000)
    setMode(T_DIES, null)
  }, 90_000)
})
