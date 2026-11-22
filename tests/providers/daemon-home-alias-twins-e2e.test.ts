/**
 * One Walnut, one home, against BOTH real daemon twins (walnut-scope-core.ts aliases).
 *
 * A host keyed every Walnut by its data dir, so a leader that came back from another path
 * (a new machine, a promoted standby, a moved dir) with the same instance id was a new
 * Walnut to it: epoch 1 again, its triggers re-reported everything with a fresh epoch,
 * its old set kept firing, its jobs and host server ran twice. Now the id names the Walnut
 * and the path is only where it is: the new home becomes an alias of the first one, whose
 * files and state go on as they were.
 *
 * Covered: (0) no leader ever offered home moves (the experiment off): a new home's first
 * check runs at the normal delay; (a) upgrade continuity: the leader book's epoch, a trigger's
 * epoch and seq, its dedup memory, the host copy, plugin jobs; a set pushed under the new home
 * before its leader.configure waits for it, past the first-run delay, and never runs on fresh
 * memory; (a2) one home of a Walnut speaks at a time, in both orders, and the other works
 * once the first is gone; (g) a new Walnut's checks wait for its leader.configure and run right
 * after it; (b) a leader with no id keeps the path (two homes are two Walnuts); (c) after a
 * restart the alias holds and the set runs once; (d) the first home in use: no alias; a
 * volatile id: no alias; (e) a rollback reader (sha1 of the home each file embeds) finds every
 * file under its own name; (f) a home whose leader.configure never comes runs as its own
 * after the cap (WALNUT_HOME_ALIAS_WAIT_MS, shortened), said once.
 *
 * What's real: both daemon twins, their files, a node check script, the clocks. Mocked: nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
const d = BUN ? describe : describe.skip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (v: string) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16)

async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

class Client {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (reply: Record<string, unknown>) => void>()
  private constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (waiter) { this.waiters.delete(msg.id as number); waiter(msg) }
    })
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
    return new Client(ws)
  }
  rpc(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiters.set(id, resolve)
      this.ws.send(JSON.stringify({ id, ...frame }))
    })
  }
  /** Fires of `id` as they happened (not the at-least-once replays of one already sent). */
  fires(id: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.ev === 'trigger.fired' && e.id === id && e.replay !== true)
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((res) => { this.ws.once('close', () => res()); try { this.ws.close() } catch { res() } })
  }
}

/** Every JSON file under `dir`, recursively. */
function jsonFiles(dir: string): string[] {
  const out: string[] = []
  let names: fs.Dirent[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of names) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsonFiles(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

for (const twin of ['standalone', 'source'] as const) {
  d(`a Walnut from another data dir keeps its state on this host (${twin} twin)`, () => {
    const BASE = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-home-alias-${twin}-`))
    const RUN_DIR = path.join(BASE, 'run')
    const DURABLE = path.join(BASE, 'durable')
    const BIN = path.join(BASE, 'bin')
    const SAME = path.join(BASE, 'same.cjs')
    const FRESH = path.join(BASE, 'fresh.cjs')
    const RUNS = path.join(BASE, 'runs.txt')
    // The Walnut's first home, the home it comes back from, and other Walnuts of this host.
    const HOME_A = path.join(BASE, 'mac', 'walnut')
    const HOME_B = path.join(BASE, 'new-mac', 'data', 'walnut')
    const HOME_OLD = path.join(BASE, 'older-leader')
    const HOME_LIVE = path.join(BASE, 'live')
    const HOME_COPY = path.join(BASE, 'live-copy')
    const HOME_VOLATILE = path.join(BASE, 'volatile')
    const HOME_PLAIN = path.join(BASE, 'plain')
    const HOME_NEW = path.join(BASE, 'new-walnut')
    const HOME_LATE = path.join(BASE, 'late')
    const W = crypto.randomBytes(16).toString('hex')
    const W_LIVE = crypto.randomBytes(16).toString('hex')
    const W_NEW = crypto.randomBytes(16).toString('hex')
    let daemonPid: number | null = null
    let port = 0
    const clients: Client[] = []

    const def = (id: string, script: string) => ({ id, name: id, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` } })
    const SET = () => [def('same', SAME), def('fresh', FRESH)]
    const runsOf = (id: string) => (fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf-8').split('\n').filter((l) => l === id).length : 0)
    const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, any>
    const leaderFile = (home: string) => path.join(RUN_DIR, 'leader', `leader-${sha(home)}.json`)
    const aliasFile = () => path.join(RUN_DIR, 'leader', 'homes.json')
    /** The daemon's log lines (JSON) with this message for this Walnut key. */
    const logLines = (msg: string, scope: string) => fs.readdirSync(RUN_DIR).filter((n) => /^daemon-.*\.log$/.test(n))
      .flatMap((n) => fs.readFileSync(path.join(RUN_DIR, n), 'utf-8').split('\n'))
      .filter((l) => l.includes(msg) && l.includes(`"scope":"${scope}"`))
    const WAIT_LOG = "first checks wait for its leader.configure"
    const CAP_LOG = 'no leader.configure came for a new home in time'
    const BUSY = 'another data dir speaks as this Walnut here'
    const configureLeader = (c: Client, home: string, walnutId: string) => c.rpc({ cmd: 'leader.configure', home, walnutId, backup: false, walnutHomeMoves: true })
    const slice = (home: string, hash: string, asOf: number) => ({ v: 1, home, hash, asOf, host: 'h', sessions: [], tasks: [], requests: [] })
    // One plugin job, every hour (its first run is an hour away): kept as a set, it never runs here.
    const JOBS = () => [{
      plugin: 'acme-jobs', version: '1.0.0', job: 'poll', kind: 'every', everyMs: 3_600_000, config: {}, host: 'devbox',
      bundle: { sha256: 'c'.repeat(64), file: path.join(RUN_DIR, 'plugin-jobs', 'bundles', `${'c'.repeat(64)}.mjs`) },
    }]

    async function client(): Promise<Client> {
      const c = await Client.open(port)
      clients.push(c)
      return c
    }

    async function startDaemon(extra: NodeJS.ProcessEnv = {}): Promise<void> {
      const env: NodeJS.ProcessEnv = {
        ...process.env, WALNUT_DAEMON_DIR: RUN_DIR, WALNUT_TRIGGER_STATE_DIR: DURABLE, WALNUT_TRIGGER_REPLAY_MS: '600000',
        // The first home counts as away half a second after its socket closed.
        WALNUT_LEADER_TAKEOVER_MS: '500',
        ...extra,
      }
      // The cap is the daemon's own (10 minutes) unless this start shortens it.
      if (!extra.WALNUT_HOME_ALIAS_WAIT_MS) delete env.WALNUT_HOME_ALIAS_WAIT_MS
      delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
      delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
      const [cmd, args] = twin === 'standalone'
        ? [BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']]
        : [SOURCE_TWIN.file, [path.join(BIN, 'daemon.cjs'), '--start']]
      const portFile = path.join(RUN_DIR, 'daemon.port')
      try { fs.unlinkSync(portFile) } catch { /* first start */ }
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      proc.unref()
      await waitFor(() => (fs.existsSync(portFile) ? true : undefined), 30_000, 'the daemon port file')
      port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
      daemonPid = parseInt(fs.readFileSync(path.join(RUN_DIR, 'daemon.pid'), 'utf-8').trim(), 10)
    }

    async function stopDaemon(): Promise<void> {
      const pid = daemonPid!
      for (const c of clients.splice(0)) await c.close()
      process.kill(pid, 'SIGTERM')
      await waitFor(() => { try { process.kill(pid, 0); return undefined } catch { return true } }, 15_000, 'the daemon to exit')
      daemonPid = null
    }

    beforeAll(async () => {
      if (twin === 'source') {
        fs.mkdirSync(BIN, { recursive: true })
        fs.writeFileSync(path.join(BIN, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
        execFileSync(BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(BIN, 'trigger-check-core.cjs'),
          path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], { stdio: 'ignore' })
      }
      const record = `require('fs').appendFileSync(${JSON.stringify(RUNS)}, process.env.WALNUT_TRIGGER_ID + '\\n')`
      // `same` reports one item, always the same: only its first run fires (the dedup memory).
      fs.writeFileSync(SAME, [record, "console.log(JSON.stringify({ fire: true, items: [{ id: 'the-one-item' }] }))"].join('\n') + '\n')
      // `fresh` reports a new item on every run, so every run fires (its seq counts).
      fs.writeFileSync(FRESH, [record, "console.log(JSON.stringify({ fire: true, items: [{ id: String(Date.now()) + '-' + Math.random() }] }))"].join('\n') + '\n')
      // The Walnut's record from before: its lead changed hands six times (epoch 7).
      fs.mkdirSync(path.join(RUN_DIR, 'leader'), { recursive: true })
      fs.writeFileSync(leaderFile(HOME_A), JSON.stringify({ v: 1, home: HOME_A, walnutId: W, backup: false, epoch: 7, holder: 'primary', since: Date.now() - 60_000 }))
      await startDaemon()
    }, 90_000)

    afterAll(async () => {
      for (const c of clients) await c.close()
      if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* already exited */ } }
      await sleep(500)
      for (const dir of [BASE, `${RUN_DIR}-streams`]) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    })

    let firstFresh: Record<string, unknown>
    let firstSame: Record<string, unknown>
    /** The new home's server, still connected after (a). */
    let bLive: Client

    it('(0) no leader ever offered its home moves: a new home\'s first check runs at the normal delay', async () => {
      const c = await client()
      const pushedAt = Date.now()
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_PLAIN, config: { version: 1, triggers: [def('plain', FRESH)] } })).toMatchObject({ ok: true, count: 1 })
      const f = await waitFor(() => c.fires('plain')[0], 20_000, 'the first fire of plain')
      // The 5 s first-run delay and a tick, never the 10 minute cap of a wait for an alias.
      expect(Date.now() - pushedAt).toBeLessThan(15_000)
      expect(fs.existsSync(aliasFile()), 'nothing was offered: no alias file').toBe(false)
      expect(logLines(WAIT_LOG, sha(HOME_PLAIN))).toEqual([])
      await c.rpc({ cmd: 'triggers.ack', triggerId: 'plain', seq: f.seq, home: HOME_PLAIN })
      await c.close()
    }, 60_000)

    it('the Walnut at its first home: its epoch, its triggers, its copy and its jobs', async () => {
      const a = await client()
      expect(await configureLeader(a, HOME_A, W)).toMatchObject({ ok: true, epoch: 7 })
      // The offer is kept: from now on a new home's first checks wait for its leader.configure.
      expect(readJson(aliasFile())).toMatchObject({ v: 1, movesOffered: true })
      expect(await a.rpc({ cmd: 'host.slice', slice: slice(HOME_A, 'copy-1', Date.now()) })).toMatchObject({ ok: true })
      expect(await a.rpc({ cmd: 'triggers.configure', home: HOME_A, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: true, count: 2 })
      // Their first checks run by themselves a few seconds after the push.
      firstSame = await waitFor(() => a.fires('same')[0], 20_000, 'the first fire of same')
      firstFresh = await waitFor(() => a.fires('fresh')[0], 20_000, 'the first fire of fresh')
      for (const f of [firstSame, firstFresh]) {
        expect(await a.rpc({ cmd: 'triggers.ack', triggerId: f.id, seq: f.seq, home: HOME_A })).toMatchObject({ acked: true })
      }
      const jobs = await a.rpc({ cmd: 'jobs.configure', home: HOME_A, spec: { home: HOME_A, walnutId: W, jobs: JOBS() } })
      expect(jobs).toMatchObject({ ok: true, jobs: [{ job: 'poll', kind: 'every' }] })
      await a.close()
      // Away: the socket closed and the takeover window passed.
      await sleep(1_200)
    }, 60_000)

    it('(a) the same id from another data dir continues it: no fresh epoch, no fire again, no second set', async () => {
      const b = await client()
      bLive = b
      const runsBefore = { same: runsOf('same'), fresh: runsOf('fresh') }
      // A server pushes its set and its copy at connect, before leader.configure says which Walnut it is.
      expect(await b.rpc({ cmd: 'triggers.configure', home: HOME_B, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: true, count: 2 })
      expect(await b.rpc({ cmd: 'host.slice', slice: slice(HOME_B, 'copy-2', Date.now()) })).toMatchObject({ ok: true })
      // Past the first-run delay (5 s) its checks are due, and the daemon says they wait instead:
      // they never run on fresh memory, however late the leader.configure comes.
      await waitFor(() => (logLines(WAIT_LOG, sha(HOME_B)).length > 0 ? true : undefined), 30_000, 'the wait for the leader.configure')
      expect({ same: runsOf('same'), fresh: runsOf('fresh') }).toEqual(runsBefore)
      expect(b.fires('same')).toEqual([])

      // The leader book's record goes on: epoch 7, not a new record at 1.
      expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: true, epoch: 7 })
      expect(fs.existsSync(leaderFile(HOME_B)), 'no record of its own for the new home').toBe(false)
      expect(readJson(aliasFile()).aliases[HOME_B]).toMatchObject({ to: HOME_A, walnutId: W })

      // The dedup memory went on: the item reported under the first home is not reported again.
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'same', home: HOME_B })).toMatchObject({ ok: true, ran: true })
      // The check's outcome comes after any fire of the same run.
      await waitFor(() => b.events.find((e) => e.ev === 'trigger.checked' && e.id === 'same' && e.replay !== true), 15_000, 'the check of same')
      expect(runsOf('same')).toBe(runsBefore.same + 1)
      expect(b.fires('same'), 'the one item was reported already').toEqual([])
      // The numbering went on: the same epoch, the next seq; and the fire reaches the new home's socket.
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'fresh', home: HOME_B })).toMatchObject({ ok: true, ran: true })
      const next = await waitFor(() => b.fires('fresh')[0], 15_000, 'a fire of fresh')
      expect(next.epoch).toBe(firstFresh.epoch)
      expect(next.seq).toBe((firstFresh.seq as number) + 1)
      expect(await b.rpc({ cmd: 'triggers.ack', triggerId: 'fresh', seq: next.seq, home: HOME_B })).toMatchObject({ acked: true })

      // The copy it sent before the alias is the Walnut's: a probe of it is held.
      expect(await b.rpc({ cmd: 'host.slice', home: HOME_B, hash: 'copy-2', asOf: Date.now() })).toMatchObject({ ok: true, have: true })
      expect(readJson(path.join(RUN_DIR, 'offline-host', `slice-${sha(HOME_A)}.json`))).toMatchObject({ home: HOME_A, hash: 'copy-2' })

      // Its plugin jobs are the one set the first home had, not a second one.
      const jobs = await b.rpc({ cmd: 'jobs.configure', home: HOME_B, spec: { home: HOME_B, walnutId: W, jobs: JOBS() } })
      expect(jobs).toMatchObject({ ok: true, jobs: [{ job: 'poll', kind: 'every' }] })
      expect(jobs.jobs).toHaveLength(1)
      const jobFiles = fs.readdirSync(path.join(RUN_DIR, 'plugin-jobs')).filter((n) => /^jobs-[0-9a-f]{16}\.json$/.test(n))
      expect(jobFiles).toEqual([`jobs-${sha(HOME_A)}.json`])
      expect(readJson(path.join(RUN_DIR, 'plugin-jobs', jobFiles[0]!))).toMatchObject({ home: HOME_A, walnutId: W })
    }, 90_000)

    it('(a2) one home of a Walnut speaks at a time, in both orders; the other works once the first is gone', async () => {
      // The new home speaks (bLive): the first home comes back, it is refused, nothing of it mixes in.
      const a = await client()
      const refused = await configureLeader(a, HOME_A, W)
      expect(refused).toMatchObject({ ok: false, errorKind: 'walnut_home_busy' })
      expect(String(refused.error)).toBe(`${BUSY}: ${sha(HOME_A)}`)
      expect(await a.rpc({ cmd: 'triggers.configure', home: HOME_A, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: false, errorKind: 'walnut_home_busy' })
      await bLive.close()
      await vi.waitFor(async () => expect(await configureLeader(a, HOME_A, W)).toMatchObject({ ok: true, epoch: 7 }), { timeout: 10_000, interval: 200 })

      // The reverse: the first home speaks, the new home is refused until it is gone.
      const b = await client()
      expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy' })
      await a.close()
      await vi.waitFor(async () => expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: true, epoch: 7 }), { timeout: 10_000, interval: 200 })
      // Still one Walnut: no record of its own for either refused attempt.
      expect(fs.existsSync(leaderFile(HOME_B))).toBe(false)
      await b.close()
    }, 60_000)

    it('(g) a new Walnut\'s checks wait for its leader.configure and run right after it', async () => {
      const c = await client()
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_NEW, config: { version: 1, triggers: [def('new-fresh', FRESH)] } })).toMatchObject({ ok: true, count: 1 })
      await waitFor(() => (logLines(WAIT_LOG, sha(HOME_NEW)).length > 0 ? true : undefined), 30_000, 'the wait for the leader.configure')
      expect(runsOf('new-fresh')).toBe(0)
      // The wait ends at the event, not at a time: the check runs at the next tick.
      expect(await configureLeader(c, HOME_NEW, W_NEW)).toMatchObject({ ok: true, epoch: 1 })
      const f = await waitFor(() => c.fires('new-fresh')[0], 15_000, 'the first fire of new-fresh')
      expect(runsOf('new-fresh')).toBe(1)
      await c.rpc({ cmd: 'triggers.ack', triggerId: 'new-fresh', seq: f.seq, home: HOME_NEW })
      await c.close()
    }, 60_000)

    it('(b) a leader that sends no id keeps the path: its home is a Walnut of its own', async () => {
      const old = await client()
      expect(await old.rpc({ cmd: 'triggers.configure', home: HOME_OLD, config: { version: 1, triggers: [def('old-fresh', FRESH)] } })).toMatchObject({ ok: true, count: 1 })
      expect(await old.rpc({ cmd: 'triggers.run', triggerId: 'old-fresh', home: HOME_OLD })).toMatchObject({ ok: true, ran: true })
      const f = await waitFor(() => old.fires('old-fresh')[0], 15_000, 'a fire of old-fresh')
      expect(f.epoch).not.toBe(firstFresh.epoch)
      expect(readJson(path.join(RUN_DIR, 'walnuts', sha(HOME_OLD), 'triggers.json'))).toMatchObject({ home: HOME_OLD })
      expect(readJson(aliasFile()).aliases[HOME_OLD]).toBeUndefined()
      await old.rpc({ cmd: 'triggers.ack', triggerId: 'old-fresh', seq: f.seq, home: HOME_OLD })
    }, 60_000)

    it('(d) while the first home is in use a copy of its data dir stays apart, and a volatile id never aliases', async () => {
      const live = await client()
      expect(await live.rpc({ cmd: 'leader.configure', home: HOME_LIVE, walnutId: W_LIVE, backup: false, walnutHomeMoves: true })).toMatchObject({ ok: true, epoch: 1 })
      const copy = await client()
      // The live home's socket is open: the copy is a Walnut of its own here.
      expect(await copy.rpc({ cmd: 'leader.configure', home: HOME_COPY, walnutId: W_LIVE, backup: false, walnutHomeMoves: true })).toMatchObject({ ok: true, epoch: 1 })
      expect(fs.existsSync(leaderFile(HOME_COPY))).toBe(true)
      expect(readJson(aliasFile()).aliases[HOME_COPY]).toBeUndefined()
      // An id the leader keeps in memory only names no Walnut: the first home is away, still no alias.
      const vol = await client()
      expect(await vol.rpc({ cmd: 'leader.configure', home: HOME_VOLATILE, walnutId: W, walnutIdVolatile: true, backup: false, walnutHomeMoves: true })).toMatchObject({ ok: true, epoch: 1 })
      expect(readJson(aliasFile()).aliases[HOME_VOLATILE]).toBeUndefined()
      for (const c of [live, copy, vol]) await c.close()
    }, 60_000)

    it('(c) after a restart the new home is still the same Walnut, and its set runs once', async () => {
      await stopDaemon()
      await startDaemon()
      const b = await client()
      expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: true, epoch: 7 })
      expect(await b.rpc({ cmd: 'triggers.configure', home: HOME_B, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: true, count: 2 })
      const before = runsOf('fresh')
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'fresh', home: HOME_B })).toMatchObject({ ok: true, ran: true })
      const f = await waitFor(() => b.fires('fresh')[0], 15_000, 'a fire of fresh')
      expect(f.epoch).toBe(firstFresh.epoch)
      expect(f.seq).toBe((firstFresh.seq as number) + 2)
      expect(runsOf('fresh') - before).toBe(1)
      expect(b.fires('fresh')).toHaveLength(1)
      // One armed copy of the set: the one the new home pushed before its alias was left out at boot.
      const log = fs.readdirSync(RUN_DIR).filter((n) => /^daemon-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(RUN_DIR, n), 'utf-8')).join('\n')
      expect(log).toContain(path.join(RUN_DIR, 'walnuts', sha(HOME_B), 'triggers.json'))
      expect(log).toMatch(/triggers file ignored: its home does not match its dir/)
    }, 90_000)

    it('(e) a rollback reader finds every file: each is named by the sha1 of the home it embeds', () => {
      const named = jsonFiles(BASE).flatMap((file) => {
        let raw: unknown
        try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return [] }
        const home = (raw as { home?: unknown; spec?: { home?: unknown } } | null)?.home ?? (raw as { spec?: { home?: unknown } } | null)?.spec?.home
        if (typeof home !== 'string' || !home.startsWith(BASE)) return []
        const m = /(?:^|-)([0-9a-f]{16})(?:\.state)?\.json$/.exec(path.basename(file)) ?? /walnuts[/\\]([0-9a-f]{16})[/\\]/.exec(file)
        return m ? [{ file: path.relative(BASE, file), home: path.relative(BASE, home), key: m[1]!, ok: m[1] === sha(home) }] : []
      })
      expect(named.length, 'the scan found the Walnut\'s files').toBeGreaterThan(4)
      expect(named.filter((n) => !n.ok), 'an older daemon checks sha1(embedded home) against the name').toEqual([])
      // Everything written for the new home after the alias is the first home's, under its name.
      const forA = named.filter((n) => n.key === sha(HOME_A)).map((n) => n.file)
      expect(forA).toEqual(expect.arrayContaining([
        path.relative(BASE, leaderFile(HOME_A)),
        path.join('run', 'walnuts', sha(HOME_A), 'triggers.json'),
        path.join('run', 'offline-host', `slice-${sha(HOME_A)}.json`),
        path.join('run', 'plugin-jobs', `jobs-${sha(HOME_A)}.json`),
      ]))
      expect(readJson(leaderFile(HOME_A))).toMatchObject({ home: HOME_A, walnutId: W, epoch: 7 })
    })

    it('(f) a home whose leader.configure never comes runs as its own after the cap, said once', async () => {
      // The cap shortened to 3 s (it is 10 minutes): past it the checks run on the home's own memory.
      await stopDaemon()
      await startDaemon({ WALNUT_HOME_ALIAS_WAIT_MS: '3000' })
      const c = await client()
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_LATE, config: { version: 1, triggers: [def('late', FRESH), def('late-2', FRESH)] } })).toMatchObject({ ok: true, count: 2 })
      await waitFor(() => c.fires('late')[0], 30_000, 'the first fire of late')
      await waitFor(() => c.fires('late-2')[0], 30_000, 'the first fire of late-2')
      expect(logLines(CAP_LOG, sha(HOME_LATE)), 'said once for the home, not per trigger').toHaveLength(1)
      expect(fs.existsSync(leaderFile(HOME_LATE))).toBe(false)
    }, 90_000)
  })
}
