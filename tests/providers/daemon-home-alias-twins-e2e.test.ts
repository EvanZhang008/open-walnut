/**
 * One Walnut, one home, against BOTH real daemon twins (walnut-scope-core.ts declared moves).
 *
 * A host keyed every Walnut by its data dir, so a leader that came back from another path
 * with the same instance id was a new Walnut to it: epoch 1 again, its triggers re-reported
 * everything with a fresh epoch, its old set kept firing, its jobs and host server ran twice.
 * Now a server whose data dir moved DECLARES it (leader.configure's movedFrom, the connect's
 * first frame), and the new home continues the first one, whose files and state go on as they
 * were. Nothing is inferred: a copy that declares nothing is a Walnut of its own by its path.
 *
 * Covered: (a) a declared move continues the leader book's epoch, a trigger's epoch and seq,
 * its dedup memory, the host copy, plugin jobs; (a2) the home it left is refused for good
 * (`walnut_home_busy` with `movedTo`), while the new home is connected and after, a command
 * and a copy alike; (a3) a declared move back flips it, and forth again; (g) a new Walnut's
 * first check runs once at the normal delay, with no wait, on a host that holds a move;
 * (b) a leader with no id keeps the path; (d) a copy that declares nothing, a volatile id and
 * a move from a home of another Walnut stay Walnuts of their own; (c) after a restart the move
 * holds and the set runs once; (f) a backup declaring the same move is refused for good (no
 * turns), several hops are followed, another Walnut at a path one left reads `walnut_home_taken`,
 * and a move the host cannot follow is said on the answer; (h) a backup that reached the host first
 * gives way once the real copy's server says it is gone (`copyGone`), and the same Walnut's own
 * record at the new path is not told; (e) a rollback reader (sha1 of the home each file embeds) finds
 * every file under its own name.
 *
 * What's real: both daemon twins, their files, a node check script, the clocks. Mocked: nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
    const BUSY = 'this Walnut moved to another data dir'
    const configureLeader = (c: Client, home: string, walnutId: string, movedFrom?: string) => c.rpc({ cmd: 'leader.configure', home, walnutId, backup: false, ...(movedFrom ? { movedFrom } : {}) })
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

    it('the Walnut at its first home: its epoch, its triggers, its copy and its jobs', async () => {
      const a = await client()
      expect(await configureLeader(a, HOME_A, W)).toMatchObject({ ok: true, epoch: 7 })
      expect(fs.existsSync(aliasFile()), 'nothing was declared: no alias file').toBe(false)
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
    }, 60_000)

    it('(a) a declared move continues it: no fresh epoch, no fire again, no second set', async () => {
      const b = await client()
      bLive = b
      const runsBefore = { same: runsOf('same'), fresh: runsOf('fresh') }
      // The connect's first frame declares the move (home-move.ts): the leader book's record goes on.
      expect(await configureLeader(b, HOME_B, W, HOME_A)).toMatchObject({ ok: true, epoch: 7 })
      expect(fs.existsSync(leaderFile(HOME_B)), 'no record of its own for the new home').toBe(false)
      expect(readJson(aliasFile())).toMatchObject({ v: 2, aliases: { [HOME_B]: { to: HOME_A, walnutId: W } }, places: { [HOME_A]: HOME_B } })
      // Then its set and its copy: the first home's, keyed by it.
      expect(await b.rpc({ cmd: 'triggers.configure', home: HOME_B, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: true, count: 2 })
      expect(await b.rpc({ cmd: 'host.slice', slice: slice(HOME_B, 'copy-2', Date.now()) })).toMatchObject({ ok: true })
      expect({ same: runsOf('same'), fresh: runsOf('fresh') }).toEqual(runsBefore)

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

      // The copy is the Walnut's: a probe of it is held, in the first home's file.
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

    it('(a2) the home it left is refused for good: while the new home is connected and after', async () => {
      const expectRefused = (reply: Record<string, unknown>) => {
        expect(reply).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: HOME_B })
        expect(String(reply.error)).toBe(`${BUSY}: ${sha(HOME_A)}`)
      }
      const a = await client()
      expectRefused(await configureLeader(a, HOME_A, W))
      expectRefused(await a.rpc({ cmd: 'triggers.configure', home: HOME_A, config: { version: 1, triggers: SET() } }))
      // A copy names its home inside: refused the same way, and the Walnut's copy is untouched.
      expectRefused(await a.rpc({ cmd: 'host.slice', slice: slice(HOME_A, 'copy-stale', Date.now()) }))
      expect(readJson(path.join(RUN_DIR, 'offline-host', `slice-${sha(HOME_A)}.json`))).toMatchObject({ hash: 'copy-2' })
      // The new home goes away: the old one is still refused, so two copies never take turns.
      await bLive.close()
      expectRefused(await configureLeader(a, HOME_A, W))
      expect(fs.existsSync(leaderFile(HOME_B))).toBe(false)
      await a.close()
    }, 60_000)

    it('(a3) a declared move back flips it, and a move forth again flips it back', async () => {
      const a = await client()
      expect(await configureLeader(a, HOME_A, W, HOME_B)).toMatchObject({ ok: true, epoch: 7 })
      const b = await client()
      expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: HOME_A })
      await a.close()
      expect(await configureLeader(b, HOME_B, W, HOME_A)).toMatchObject({ ok: true, epoch: 7 })
      const again = await client()
      expect(await configureLeader(again, HOME_A, W)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: HOME_B })
      for (const c of [again, b]) await c.close()
    }, 60_000)

    it('(g) a new Walnut\'s first check runs once at the normal delay, with no wait, on a host that holds a move', async () => {
      const c = await client()
      const pushedAt = Date.now()
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_NEW, config: { version: 1, triggers: [def('new-fresh', FRESH)] } })).toMatchObject({ ok: true, count: 1 })
      const f = await waitFor(() => c.fires('new-fresh')[0], 20_000, 'the first fire of new-fresh')
      // The 5 s first-run delay and a tick: no leader.configure is waited for.
      expect(Date.now() - pushedAt).toBeLessThan(15_000)
      expect(runsOf('new-fresh')).toBe(1)
      expect(await configureLeader(c, HOME_NEW, W_NEW)).toMatchObject({ ok: true, epoch: 1 })
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

    it('(d) a copy that declares nothing, a volatile id and a move from another Walnut\'s home stay apart', async () => {
      const live = await client()
      expect(await configureLeader(live, HOME_LIVE, W_LIVE)).toMatchObject({ ok: true, epoch: 1 })
      await live.close()
      // A copy of its data dir (same id) that declares nothing is a Walnut of its own by its path.
      const copy = await client()
      expect(await configureLeader(copy, HOME_COPY, W_LIVE)).toMatchObject({ ok: true, epoch: 1 })
      expect(fs.existsSync(leaderFile(HOME_COPY))).toBe(true)
      expect(readJson(aliasFile()).aliases[HOME_COPY]).toBeUndefined()
      // An id the leader keeps in memory only names no Walnut, even with a move declared.
      const vol = await client()
      expect(await vol.rpc({ cmd: 'leader.configure', home: HOME_VOLATILE, walnutId: W, walnutIdVolatile: true, backup: false, movedFrom: HOME_A })).toMatchObject({ ok: true, epoch: 1 })
      expect(readJson(aliasFile()).aliases[HOME_VOLATILE]).toBeUndefined()
      // A move declared from a home whose record names another Walnut: not taken.
      const wrong = await client()
      expect(await configureLeader(wrong, HOME_PLAIN, W, HOME_LIVE)).toMatchObject({ ok: true, epoch: 1 })
      expect(readJson(aliasFile()).aliases[HOME_PLAIN]).toBeUndefined()
      expect(fs.existsSync(leaderFile(HOME_PLAIN))).toBe(true)
      for (const c of [copy, vol, wrong]) await c.close()
    }, 60_000)

    it('(c) after a restart the new home is still the same Walnut, and its set runs once', async () => {
      await stopDaemon()
      await startDaemon()
      const b = await client()
      // The move is kept: the new home is the Walnut, the first one still refused.
      expect(await configureLeader(b, HOME_B, W)).toMatchObject({ ok: true, epoch: 7 })
      const a = await client()
      expect(await configureLeader(a, HOME_A, W)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: HOME_B })
      expect(await b.rpc({ cmd: 'triggers.configure', home: HOME_B, config: { version: 1, triggers: SET() } })).toMatchObject({ ok: true, count: 2 })
      const before = runsOf('fresh')
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'fresh', home: HOME_B })).toMatchObject({ ok: true, ran: true })
      const f = await waitFor(() => b.fires('fresh')[0], 15_000, 'a fire of fresh')
      expect(f.epoch).toBe(firstFresh.epoch)
      expect(f.seq).toBe((firstFresh.seq as number) + 2)
      expect(runsOf('fresh') - before).toBe(1)
      expect(b.fires('fresh')).toHaveLength(1)
      // One set: the move came before the new home pushed anything, so nothing was ever kept under its own key.
      expect(fs.existsSync(path.join(RUN_DIR, 'walnuts', sha(HOME_B))), 'no scope dir of the new home').toBe(false)
      for (const c of [a, b]) await c.close()
    }, 90_000)

    it('(f) a backup that declares the same move never takes turns, several hops are followed, another Walnut at a left path reads taken', async () => {
      const M = path.join(BASE, 'm', 'walnut')
      const M1 = path.join(BASE, 'm1', 'walnut')
      const MB = path.join(BASE, 'm-backup', 'walnut')
      const C0 = path.join(BASE, 'c0')
      const C2 = path.join(BASE, 'c2')
      const W_M = crypto.randomBytes(16).toString('hex')
      const W_C = crypto.randomBytes(16).toString('hex')
      const W_Y = crypto.randomBytes(16).toString('hex')
      for (const [h, w] of [[M, W_M], [C0, W_C]] as const) {
        const first = await client()
        expect(await configureLeader(first, h, w)).toMatchObject({ ok: true, epoch: 1 })
        await first.close()
      }
      // M1: the real move, then a backup of M started later declaring the same move; they reconnect in turn.
      const real = await client()
      expect(await configureLeader(real, M1, W_M, M)).toMatchObject({ ok: true, epoch: 1 })
      for (let i = 0; i < 2; i++) {
        const backup = await client()
        expect(await configureLeader(backup, MB, W_M, M)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: M1 })
        expect(await backup.rpc({ cmd: 'triggers.configure', home: MB, config: { version: 1, triggers: [] } })).toMatchObject({ ok: false, errorKind: 'walnut_home_busy' })
        await backup.close()
        const again = await client()
        expect(await configureLeader(again, M1, W_M, M)).toMatchObject({ ok: true, epoch: 1 })
        await again.close()
      }
      expect(readJson(aliasFile()).places[M]).toBe(M1)
      await real.close()
      // M3: a new Walnut at the path M left is told it is another Walnut's, not "a copy".
      const other = await client()
      const taken = await configureLeader(other, M, W_Y)
      expect(taken).toMatchObject({ ok: false, errorKind: 'walnut_home_taken', movedTo: M1 })
      expect(String(taken.error)).toBe(`another Walnut used this data dir here and moved to another one: ${sha(M)}`)
      await other.close()
      // M2: this host missed the move C0 -> C1; the move C1 -> C2 lists both and is followed from C0.
      const hop = await client()
      expect(await hop.rpc({ cmd: 'leader.configure', home: C2, walnutId: W_C, backup: false, movedFrom: path.join(BASE, 'c1'), formerHomes: [path.join(BASE, 'c1'), C0] }))
        .toMatchObject({ ok: true, epoch: 1 })
      expect(readJson(aliasFile()).aliases[C2]).toMatchObject({ to: C0, walnutId: W_C })
      // M2: a move this host cannot follow is said on the answer (the server raises a Walnut Health item).
      await hop.close()
      const lost = await client()
      expect(await lost.rpc({ cmd: 'leader.configure', home: path.join(BASE, 'c9'), walnutId: W_C, backup: false, movedFrom: path.join(BASE, 'c8') }))
        .toMatchObject({ ok: true, moveNotTaken: 'lost_trail' })
      await lost.close()
    }, 60_000)

    it('(h) a backup that reached the host first gives the place to the real copy once that copy\'s server says it is gone; the same id at the new home is quiet', async () => {
      const N = path.join(BASE, 'n', 'walnut')
      const N1 = path.join(BASE, 'n1', 'walnut')
      const NB = path.join(BASE, 'n-backup', 'walnut')
      const W_N = crypto.randomBytes(16).toString('hex')
      const first = await client()
      expect(await configureLeader(first, N, W_N)).toMatchObject({ ok: true, epoch: 1 })
      await first.close()
      const backup = await client()
      expect(await configureLeader(backup, NB, W_N, N)).toMatchObject({ ok: true, epoch: 1 })
      await backup.close()
      // The real copy comes later: refused while the backup may still live.
      const real = await client()
      expect(await configureLeader(real, N1, W_N, N)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: NB })
      await real.close()
      // Its server found the backup's folder gone: it takes the place, and the backup is the one refused.
      const back = await client()
      expect(await back.rpc({ cmd: 'leader.configure', home: N1, walnutId: W_N, backup: false, movedFrom: N, copyGone: NB })).toMatchObject({ ok: true, epoch: 1 })
      await back.close()
      expect(readJson(aliasFile()).places[N]).toBe(N1)
      const later = await client()
      expect(await configureLeader(later, N1, W_N, N)).toMatchObject({ ok: true, epoch: 1 })
      await later.close()
      const revived = await client()
      expect(await configureLeader(revived, NB, W_N, N)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy', movedTo: N1 })
      await revived.close()
      // N2: a Walnut that moved with the switch off already has its own record at the new path: no moveNotTaken.
      const S = path.join(BASE, 's', 'walnut')
      const S1 = path.join(BASE, 's1', 'walnut')
      const W_S = crypto.randomBytes(16).toString('hex')
      for (const h of [S, S1]) {
        const c = await client()
        expect(await configureLeader(c, h, W_S)).toMatchObject({ ok: true })
        await c.close()
      }
      const declared = await client()
      const split = await configureLeader(declared, S1, W_S, S)
      expect(split).toMatchObject({ ok: true })
      expect(split).not.toHaveProperty('moveNotTaken')
      await declared.close()
    }, 60_000)

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
  })
}
