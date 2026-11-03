/**
 * One daemon, two Walnuts: each keeps its own trigger set, against BOTH real twins.
 *
 * 2026-11-03: a host shared by the user's Walnut and another person's held ONE
 * trigger set. Each server's triggers.configure replaced the other's, so the second
 * Walnut to connect disarmed every check of the first, and every fire went to both.
 * Now a push names its Walnut (`home`) and replaces only that Walnut's set; fires go
 * only to that Walnut's sockets; run, ack, claim and test reach only its triggers;
 * each set is kept in its own file and reloaded at boot. A push with no home (an
 * older server) is the unnamed set, kept where it always was. A set an older daemon
 * left (no `scoped` marker) is taken over by the first named push.
 *
 * What's real: both daemon twins, their files, a node check script, the clocks.
 * What's mocked: nothing (these triggers name no session).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'
import { walnutScopeDir } from '../helpers/walnut-scope-dir.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
const d = BUN ? describe : describe.skip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** One server socket: its own events, its own RPCs. */
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
  fires(id: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.ev === 'trigger.fired' && e.id === id)
  }
  close(): void { try { this.ws.close() } catch { /* already gone */ } }
}

type Twin = 'standalone' | 'source'
type Def = Record<string, unknown>

/**
 * One daemon of `twin` in its own temp dirs, started in beforeAll over the set an
 * older daemon left (`inherited`, written with no `scoped` marker), stopped in afterAll.
 */
interface InheritedMaker { HOME_A: string; HOME_B: string; def(id: string, extra?: Def): Def; deliverTo(home: string): Def }

function harness(twin: Twin, label: string, inherited: (h: InheritedMaker) => Def[]) {
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trig-2w-${label}-${twin}-`))
  const RUN_DIR = path.join(BASE, 'run')
  const DURABLE = path.join(BASE, 'durable')
  const BIN = path.join(BASE, 'bin')
  const CHECK = path.join(BASE, 'check.cjs')
  // Every check run appends its trigger id here.
  const RUNS = path.join(BASE, 'runs.txt')
  let daemonPid: number | null = null
  let port = 0
  const clients: Client[] = []

  const h = {
    BASE, RUN_DIR, DURABLE, RUNS,
    // Two data dirs, as two people's Walnuts name themselves.
    HOME_A: path.join(BASE, 'walnut-a'),
    HOME_B: path.join(BASE, 'walnut-b'),
    def: (id: string, extra: Def = {}): Def => ({
      id, name: id, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(CHECK)}` }, ...extra,
    }),
    deliverTo: (home: string): Def => ({ deliver: { home, taskId: 'task-1', prompt: 'New items. Handle each one.' } }),
    configure(c: Client, ids: Array<string | Def>, home?: string) {
      return c.rpc({
        cmd: 'triggers.configure', ...(home ? { home } : {}),
        config: { version: 1, triggers: ids.map((x) => (typeof x === 'string' ? h.def(x) : x)) },
      })
    },
    readJson: (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, any>,
    legacyFile: () => path.join(RUN_DIR, 'triggers.json'),
    setFile: (home: string) => path.join(walnutScopeDir(RUN_DIR, home), 'triggers.json'),
    stateFile: (home: string, id: string) => path.join(walnutScopeDir(DURABLE, home), `${id}.json`),
    sharedStateFile: (id: string) => path.join(DURABLE, `${id}.json`),
    runsOf: (id: string) => (fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf-8').split('\n').filter((l) => l === id).length : 0),

    /** Run now and wait until `c` saw a new fire of `id`; returns that fire. */
    async fireOn(c: Client, id: string, home?: string): Promise<Record<string, unknown>> {
      const before = c.fires(id).length
      const reply = await c.rpc({ cmd: 'triggers.run', triggerId: id, ...(home ? { home } : {}) })
      expect(reply, `run ${id}`).toMatchObject({ ok: true, ran: true })
      return waitFor(() => c.fires(id)[before], 15_000, `a fire of ${id}`)
    },

    async startDaemon(): Promise<void> {
      const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: RUN_DIR, WALNUT_TRIGGER_STATE_DIR: DURABLE, WALNUT_TRIGGER_REPLAY_MS: '600000' }
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
    },

    async stopDaemon(): Promise<void> {
      const pid = daemonPid!
      for (const c of clients.splice(0)) c.close()
      process.kill(pid, 'SIGTERM')
      await waitFor(() => { try { process.kill(pid, 0); return undefined } catch { return true } }, 15_000, 'the daemon to exit')
      daemonPid = null
    },

    async client(): Promise<Client> {
      const c = await Client.open(port)
      clients.push(c)
      return c
    },
  }
  beforeAll(async () => {
    if (twin === 'source') {
      fs.mkdirSync(BIN, { recursive: true })
      fs.writeFileSync(path.join(BIN, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
      execFileSync(BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(BIN, 'trigger-check-core.cjs'),
        path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], { stdio: 'ignore' })
    }
    // Every run reports one new item, so every run fires.
    fs.writeFileSync(CHECK, [
      `require('fs').appendFileSync(${JSON.stringify(RUNS)}, process.env.WALNUT_TRIGGER_ID + '\\n')`,
      "console.log(JSON.stringify({ fire: true, items: [{ id: String(Date.now()) + '-' + Math.random() }] }))",
    ].join('\n') + '\n')
    fs.mkdirSync(RUN_DIR, { recursive: true })
    fs.writeFileSync(h.legacyFile(), JSON.stringify({ version: 1, triggers: inherited(h) }))
    await h.startDaemon()
  }, 60_000)

  afterAll(async () => {
    for (const c of clients) c.close()
    if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* already exited */ } }
    await sleep(500)
    for (const dir of [BASE, `${RUN_DIR}-streams`]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  return h
}

for (const twin of ['standalone', 'source'] as const) {
  d(`two Walnuts on one daemon keep their own triggers (${twin} twin)`, () => {
    // The one global set a daemon from before the split left: A's check, and one
    // that delivers into B's Walnut. No `scoped` marker.
    const h = harness(twin, 'main', (x) => [x.def('old-a', x.deliverTo(x.HOME_A)), x.def('old-b', x.deliverTo(x.HOME_B))])
    const { HOME_A, HOME_B, DURABLE, def, deliverTo, configure, readJson, setFile, stateFile, fireOn } = h
    const oldA = () => def('old-a', deliverTo(HOME_A))
    let a: Client
    let b: Client

    it('the set an older daemon left is taken over by each Walnut\'s first named push, its memory with it', async () => {
      a = await h.client()
      // Before any named push the inherited set runs as it did, and fans out to every server.
      const old = await fireOn(a, 'old-a')
      expect(fs.existsSync(path.join(DURABLE, 'old-a.json'))).toBe(true)

      expect(await configure(a, [oldA(), 'a1'], HOME_A)).toMatchObject({ ok: true, count: 2 })
      // A took old-a with its unacked fire (same numbering), not B's old-b.
      const replay = await waitFor(() => a.fires('old-a').find((f) => f.replay === true && f.seq === old.seq), 10_000, 'the taken fire replayed')
      expect(replay.epoch).toBe(old.epoch)
      expect(readJson(setFile(HOME_A))).toMatchObject({ version: 1, home: HOME_A })
      expect(readJson(setFile(HOME_A)).triggers.map((t: { id: string }) => t.id)).toEqual(['old-a', 'a1'])
      expect(fs.existsSync(stateFile(HOME_A, 'old-a')), 'the memory was copied into A\'s dir').toBe(true)
      expect(fs.existsSync(path.join(DURABLE, 'old-a.json')), 'and stays in the shared one for a downgraded daemon').toBe(true)
      const legacy = readJson(h.legacyFile())
      expect(legacy.triggers.map((t: { id: string }) => t.id), 'B\'s trigger waits for B').toEqual(['old-b'])
      expect(legacy.scoped, 'still the inherited copy').toBeUndefined()

      b = await h.client()
      expect(await configure(b, ['old-b', 'b1'].map((id) => def(id, deliverTo(HOME_B))), HOME_B)).toMatchObject({ ok: true, count: 2 })
      expect(fs.existsSync(h.legacyFile()), 'nothing is left of the inherited copy').toBe(false)
      expect(readJson(setFile(HOME_B)).triggers.map((t: { id: string }) => t.id)).toEqual(['old-b', 'b1'])
      expect(await a.rpc({ cmd: 'triggers.ack', triggerId: 'old-a', seq: old.seq, home: HOME_A })).toMatchObject({ acked: true })
    }, 60_000)
    it('a Walnut\'s push never disarms the other\'s triggers, and each hears only its own fires', async () => {
      // B pushes again, a set without anything of A's: A's triggers keep running.
      expect(await configure(b, [def('b1', deliverTo(HOME_B))], HOME_B)).toMatchObject({ ok: true, count: 1 })
      const aFire = await fireOn(a, 'a1', HOME_A)
      const bFire = await fireOn(b, 'b1', HOME_B)
      await sleep(500)
      expect(b.fires('a1'), 'B never hears A\'s fire').toEqual([])
      expect(a.fires('b1'), 'A never hears B\'s fire').toEqual([])
      expect(aFire.seq).toBeGreaterThan(0)
      expect(bFire.seq).toBeGreaterThan(0)

      // A def that delivers into another Walnut is not this Walnut's to arm.
      const r = await configure(b, [def('b1', deliverTo(HOME_B)), def('sneaky', deliverTo(HOME_A))], HOME_B)
      expect(r).toMatchObject({ ok: true, count: 1 })
      expect((r.refused as Array<{ id: string }>).map((x) => x.id)).toEqual(['sneaky'])

      // B cannot run, ack, claim or test A's trigger.
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'a1', home: HOME_B })).toMatchObject({ ok: false })
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'a1', home: HOME_A }), 'B\'s socket speaks for B').toMatchObject({ ok: false })
      expect(await b.rpc({ cmd: 'triggers.run', triggerId: 'a1' }), 'a run with no home is the socket\'s Walnut').toMatchObject({ ok: false })
      expect(await b.rpc({ cmd: 'triggers.ack', triggerId: 'a1', seq: aFire.seq, home: HOME_B })).toMatchObject({ acked: false })
      const claim = await b.rpc({ cmd: 'triggers.claim', triggerId: 'a1', seqs: [aFire.seq], home: HOME_B })
      expect(claim.claimed).toEqual([])
      expect(readJson(stateFile(HOME_A, 'a1')).pendingFires.map((f: { seq: number }) => f.seq), 'A\'s fire is still owed').toContain(aFire.seq)
      expect(await a.rpc({ cmd: 'triggers.claim', triggerId: 'a1', seqs: [aFire.seq], home: HOME_A })).toMatchObject({ ok: true })
      expect(await a.rpc({ cmd: 'triggers.ack', triggerId: 'a1', seq: aFire.seq, home: HOME_A })).toMatchObject({ acked: true })
      expect(await b.rpc({ cmd: 'triggers.ack', triggerId: 'b1', seq: bFire.seq, home: HOME_B })).toMatchObject({ acked: true })

      // A test run of A's trigger reads A's memory; from B it is a stranger.
      const fromA = await a.rpc({ cmd: 'triggers.test', triggerId: 'a1', home: HOME_A, check: def('x').check })
      expect(fromA).toMatchObject({ ok: true })
      const fromB = await b.rpc({ cmd: 'triggers.test', triggerId: 'a1', home: HOME_A, check: { run: 'true' } })
      expect(fromB, 'B\'s socket may not test as A').toMatchObject({ ok: false })
    }, 60_000)

    it('a push with no home is the unnamed set, kept and fanned out as before, beside both Walnuts', async () => {
      const older = await h.client()
      expect(await configure(older, ['legacy1'])).toMatchObject({ ok: true, count: 1 })
      const legacy = readJson(h.legacyFile())
      expect(legacy).toMatchObject({ version: 1, scoped: 1 })
      expect(legacy.triggers.map((t: { id: string }) => t.id)).toEqual(['legacy1'])
      const f = await fireOn(older, 'legacy1')
      await sleep(500)
      expect(a.fires('legacy1')).toEqual([])
      expect(b.fires('legacy1')).toEqual([])
      expect(await older.rpc({ cmd: 'triggers.ack', triggerId: 'legacy1', seq: f.seq })).toMatchObject({ acked: true })
      // Neither Walnut's set moved.
      await fireOn(a, 'a1', HOME_A)
      await fireOn(b, 'b1', HOME_B)
      expect(older.fires('a1')).toEqual([])
    }, 60_000)

    it('a restart reloads every Walnut\'s set from its own file', async () => {
      await h.stopDaemon()
      await h.startDaemon()
      const fresh = await h.client()
      // Armed from disk before anyone pushes: each Walnut's trigger answers for that Walnut only.
      expect(await fresh.rpc({ cmd: 'triggers.run', triggerId: 'a1', home: HOME_A })).toMatchObject({ ok: true, ran: true })
      expect(await fresh.rpc({ cmd: 'triggers.run', triggerId: 'b1', home: HOME_B })).toMatchObject({ ok: true, ran: true })
      expect(await fresh.rpc({ cmd: 'triggers.run', triggerId: 'legacy1' })).toMatchObject({ ok: true, ran: true })
      expect(await fresh.rpc({ cmd: 'triggers.run', triggerId: 'a1', home: HOME_B })).toMatchObject({ ok: false })
      // The same sets pushed again are no change: each hash came back from its file.
      a = await h.client()
      b = await h.client()
      expect(await configure(a, [oldA(), 'a1'], HOME_A)).toMatchObject({ ok: true, changed: false })
      expect(await configure(b, [def('b1', deliverTo(HOME_B))], HOME_B)).toMatchObject({ ok: true, changed: false })
    }, 60_000)
  })

  d(`a downgrade and an upgrade again keep one memory per trigger (${twin} twin)`, () => {
    // One Walnut on the host: a trigger that names no Walnut is that Walnut's.
    const h = harness(twin, 'down', (x) => [x.def('dg-1')])
    const { HOME_A, configure, readJson, setFile, stateFile, sharedStateFile, fireOn } = h

    it('the first named push copies the memory and leaves the older copy where an older daemon reads it', async () => {
      const a = await h.client()
      const old = await fireOn(a, 'dg-1')
      expect(await configure(a, ['dg-1'], HOME_A)).toMatchObject({ ok: true, count: 1 })
      expect(fs.existsSync(h.legacyFile()), 'the inherited set is taken').toBe(false)
      expect(readJson(stateFile(HOME_A, 'dg-1')).epoch).toBe(old.epoch)
      expect(fs.existsSync(sharedStateFile('dg-1')), 'the older copy stays').toBe(true)
      expect(readJson(sharedStateFile('dg-1')).epoch).toBe(old.epoch)
      expect(await a.rpc({ cmd: 'triggers.ack', triggerId: 'dg-1', seq: old.seq, home: HOME_A })).toMatchObject({ acked: true })

      // Every later write of A's memory reaches the shared copy too, so a downgrade
      // goes on from now, not from the upgrade: the items reported since stay seen.
      const before = Object.keys(readJson(stateFile(HOME_A, 'dg-1')).seen)
      const next = await fireOn(a, 'dg-1', HOME_A)
      const mine = readJson(stateFile(HOME_A, 'dg-1'))
      expect(mine.sharedCopy, 'A took it over').toBe(true)
      expect(Object.keys(mine.seen).length).toBeGreaterThan(before.length)
      const shared = readJson(sharedStateFile('dg-1'))
      expect(Object.keys(shared.seen).sort(), 'the shared copy holds the grown set').toEqual(Object.keys(mine.seen).sort())
      expect(shared.seq).toBe(next.seq)
      expect(shared.sharedCopy, 'an older daemon reads plain state').toBeUndefined()
      expect(await a.rpc({ cmd: 'triggers.ack', triggerId: 'dg-1', seq: next.seq, home: HOME_A })).toMatchObject({ acked: true })

      // Another Walnut's trigger of the same id never writes there.
      const b = await h.client()
      expect(await configure(b, ['dg-1'], h.HOME_B)).toMatchObject({ ok: true, count: 1 })
      const bFire = await fireOn(b, 'dg-1', h.HOME_B)
      expect(bFire.epoch).not.toBe(next.epoch)
      expect(readJson(sharedStateFile('dg-1')).epoch, 'still A\'s memory').toBe(next.epoch)
      expect(readJson(sharedStateFile('dg-1')).seq).toBe(next.seq)
      expect(readJson(stateFile(h.HOME_B, 'dg-1')).sharedCopy).toBeUndefined()
      expect(await configure(b, [], h.HOME_B)).toMatchObject({ ok: true })
      // And a new trigger of A keeps the shared copy from its first check, so a downgraded
      // daemon (which reads only the shared dir) does not report its items again.
      expect(await configure(a, ['dg-1', 'a-own'], HOME_A)).toMatchObject({ ok: true, count: 2 })
      const own = await fireOn(a, 'a-own', HOME_A)
      expect(readJson(stateFile(HOME_A, 'a-own')).sharedCopy).toBe(true)
      expect(readJson(sharedStateFile('a-own')).seq).toBe(own.seq)
      expect(readJson(sharedStateFile('a-own')).sharedCopy).toBeUndefined()
      expect(await configure(a, ['dg-1'], HOME_A)).toMatchObject({ ok: true, count: 1 })
    }, 60_000)

    it('after an older daemon ran it, the upgrade runs it once and keeps that newer memory', async () => {
      await h.stopDaemon()
      // What an older daemon leaves after running a while: its own unmarked set, and
      // its memory of the trigger in the shared dir, newer than the named copies.
      const past = new Date(Date.now() - 60_000)
      fs.utimesSync(setFile(HOME_A), past, past)
      fs.utimesSync(stateFile(HOME_A, 'dg-1'), past, past)
      fs.writeFileSync(h.legacyFile(), JSON.stringify({ version: 1, triggers: [h.def('dg-1')] }))
      fs.writeFileSync(sharedStateFile('dg-1'), JSON.stringify({
        version: 1, epoch: 'feedfacecafe', seen: {}, state: null, budget: { used: 0, atMs: Date.now() },
        pendingFires: [], consecutiveErrors: 0, seq: 40,
      }))
      fs.rmSync(h.RUNS, { force: true })
      await h.startDaemon()
      // Both sets hold dg-1. Its boot run (15 s after the start) happens once.
      await waitFor(() => (h.runsOf('dg-1') >= 1 ? true : undefined), 30_000, 'the boot run of dg-1')
      await sleep(3_000)
      expect(h.runsOf('dg-1'), 'one run, not one per copy').toBe(1)

      const a = await h.client()
      expect(await configure(a, ['dg-1'], HOME_A)).toMatchObject({ ok: true, count: 1 })
      const f = await fireOn(a, 'dg-1', HOME_A)
      expect(f.epoch, 'the older daemon\'s numbering goes on').toBe('feedfacecafe')
      expect(f.seq as number).toBeGreaterThan(40)
      expect(readJson(stateFile(HOME_A, 'dg-1')).epoch).toBe('feedfacecafe')
      expect(fs.existsSync(h.legacyFile())).toBe(false)
      expect(fs.existsSync(sharedStateFile('dg-1'))).toBe(true)
    }, 90_000)
  })

  d(`a trigger that names no Walnut stays with the Walnut whose set it is (${twin} twin)`, () => {
    // A shared host's older set: a check that names no Walnut, and one of B's.
    const h = harness(twin, 'free', (x) => [x.def('free-1'), x.def('b-1', x.deliverTo(x.HOME_B))])
    const { HOME_A, HOME_B, def, deliverTo, configure, readJson, stateFile, fireOn } = h

    it('another Walnut\'s push leaves it, and the Walnut the set belongs to takes it', async () => {
      const a = await h.client()
      expect(await configure(a, ['a-x'], HOME_A)).toMatchObject({ ok: true, count: 1 })
      expect(readJson(h.legacyFile()).triggers.map((t: { id: string }) => t.id), 'A took nothing of B\'s set').toEqual(['free-1', 'b-1'])
      expect(fs.existsSync(stateFile(HOME_A, 'free-1'))).toBe(false)

      const b = await h.client()
      expect(await configure(b, [def('b-1', deliverTo(HOME_B)), 'free-1'], HOME_B)).toMatchObject({ ok: true, count: 2 })
      expect(fs.existsSync(h.legacyFile()), 'nothing is left of the inherited copy').toBe(false)
      await fireOn(b, 'free-1', HOME_B)
      expect(fs.existsSync(stateFile(HOME_B, 'free-1'))).toBe(true)
      expect(await a.rpc({ cmd: 'triggers.run', triggerId: 'free-1', home: HOME_A })).toMatchObject({ ok: false })
    }, 60_000)
  })

  d(`a named push after a reboot reads the memory an older daemon kept (${twin} twin)`, () => {
    // An older daemon ran rb-1; a reboot then emptied the dir its set lived in, so
    // only its memory (kept under HOME) is left when the new daemon starts.
    const h = harness(twin, 'reboot', (x) => [x.def('rb-1')])
    const { HOME_A, configure, readJson, stateFile, sharedStateFile, fireOn } = h

    it('the first fire after the push goes on from that memory', async () => {
      const older = await h.client()
      const old = await fireOn(older, 'rb-1')
      expect(await older.rpc({ cmd: 'triggers.ack', triggerId: 'rb-1', seq: old.seq })).toMatchObject({ acked: true })
      const seenBefore = Object.keys(readJson(sharedStateFile('rb-1')).seen)
      expect(seenBefore.length).toBeGreaterThan(0)
      await h.stopDaemon()
      fs.rmSync(h.legacyFile())
      await h.startDaemon()

      const a = await h.client()
      expect(await configure(a, ['rb-1'], HOME_A)).toMatchObject({ ok: true, count: 1 })
      const next = await fireOn(a, 'rb-1', HOME_A)
      expect(next.epoch, 'the same numbering').toBe(old.epoch)
      expect(next.seq).toBe((old.seq as number) + 1)
      const mine = readJson(stateFile(HOME_A, 'rb-1'))
      for (const k of seenBefore) expect(mine.seen[k], `still seen: ${k}`).toBeDefined()
      expect(mine.sharedCopy).toBe(true)
      expect(fs.existsSync(sharedStateFile('rb-1')), 'copied, not moved').toBe(true)
      expect(readJson(sharedStateFile('rb-1')).seq, 'and kept current for a downgrade').toBe(next.seq)
    }, 60_000)
  })
}
