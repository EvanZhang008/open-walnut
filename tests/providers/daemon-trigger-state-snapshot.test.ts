/**
 * triggers.state.snapshot against BOTH real daemon twins: the command is wired,
 * advertised, scoped to the socket that pushed the Walnut's set, refuses a trigger
 * that set still carries, and returns the exact state file of that Walnut's scope
 * (a hand-written full host state, so no user script runs) without writing it.
 * The pure rules are covered in trigger-state-snapshot-core.test.ts; this proves the
 * twins call them with the right facts. The receiving half, triggers.state.seed, is
 * proven the same way: a seeded state is the one the next configure arms the trigger
 * with (its first check fires only what the seen set lacks), and is never written over
 * a file, through a symlink, for a held trigger or from another Walnut's socket. The
 * configure reply's armed/draining counts ride along.
 *
 * What's real: both daemon twins, their files. What's mocked: nothing. The daemon
 * runs with a minimal env (fixture HOME and TMPDIR, a system-only PATH), not as a
 * service, and makes no outside request. The snapshotted trigger is never armed;
 * the one armed trigger only proves the still-configured refusal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { canonicalTriggerStateJson } from '../../src/providers/trigger-state-snapshot-core.js'
import { triggerStateFileName } from '../../src/providers/trigger-check-core.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'
import { walnutScopeDir } from '../helpers/walnut-scope-dir.js'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
const d = BUN ? describe : describe.skip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RPC_TIMEOUT_MS = 8_000
const EXIT_WAIT_MS = 5_000

async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** One server socket. Every RPC has a deadline, and a closed socket fails what is pending. */
class Client {
  private nextId = 1
  /** Every frame that answers no RPC (trigger.fired, trigger.checked, ...). */
  readonly events: Record<string, any>[] = []
  private waiters = new Map<number, { resolve: (reply: Record<string, any>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (!waiter) { this.events.push(msg); return }
      this.waiters.delete(msg.id as number)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    })
    ws.on('close', () => this.failAll(new Error('socket closed')))
    ws.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    return new Client(ws)
  }
  rpc(frame: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`rpc ${String(frame.cmd)} timed out after ${RPC_TIMEOUT_MS} ms`))
      }, RPC_TIMEOUT_MS)
      this.waiters.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, ...frame }))
    })
  }
  private failAll(err: Error): void {
    for (const [id, w] of this.waiters) { clearTimeout(w.timer); this.waiters.delete(id); w.reject(err) }
  }
  close(): void { try { this.ws.close() } catch { /* already gone */ } }
}

const TID = 'legacy-mail-watch'

for (const twin of ['standalone', 'source'] as const) {
  d(`triggers.state.snapshot (${twin} twin)`, () => {
    const BASE = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trig-snap-${twin}-`))
    const RUN_DIR = path.join(BASE, 'run')
    const DURABLE = path.join(BASE, 'durable')
    const BIN = path.join(BASE, 'bin')
    const FIXTURE_HOME = path.join(BASE, 'home')
    const FIXTURE_TMP = path.join(BASE, 'tmp')
    const CHECK = path.join(BASE, 'check.cjs')
    const CHECK_SEED = path.join(BASE, 'check-seed.cjs')
    const SEED_ITEMS = ['uid-100', 'uid-101', 'uid-102']
    const HOME_A = path.join(BASE, 'walnut-a')
    const HOME_B = path.join(BASE, 'walnut-b')
    // The daemon's own file naming (triggerStateFileName) inside the daemon's own scope dir.
    const stateFile = (home: string, id: string) => path.join(walnutScopeDir(DURABLE, home), triggerStateFileName(id))
    const sharedStateFile = (id: string) => path.join(DURABLE, triggerStateFileName(id))
    const def = (id: string) => ({ id, name: id, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(CHECK)}` } })
    const configure = (c: Client, ids: string[], home: string) =>
      c.rpc({ cmd: 'triggers.configure', home, config: { version: 1, triggers: ids.map(def) } })
    const snapshot = (c: Client, frame: Record<string, unknown>) => c.rpc({ cmd: 'triggers.state.snapshot', ...frame })
    let proc: ChildProcess | null = null
    let exited: Promise<void> | null = null
    let port = 0
    const clients: Client[] = []
    const client = async () => { const c = await Client.open(port); clients.push(c); return c }

    /** A complete host state, as a daemon writes it, with its own epoch. */
    const fakeState = (epoch: string, extra: Record<string, unknown> = {}) => {
      const at = Date.now() - 60 * 60 * 1000
      return {
        version: 1, epoch, seen: { 'uid-100': at, 'uid-101': at + 1_000 }, state: { lastUid: 101 },
        budget: { used: 1, atMs: at }, pendingFires: [], consecutiveErrors: 0, seq: 9,
        lastRunAtMs: at + 2_000, lastFireAtMs: at + 1_000, ...extra,
      }
    }
    const writeFile = (file: string, body: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body) }

    beforeAll(async () => {
      if (twin === 'source') {
        fs.mkdirSync(BIN, { recursive: true })
        fs.writeFileSync(path.join(BIN, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
        execFileSync(BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(BIN, 'trigger-check-core.cjs'),
          path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], { stdio: 'ignore' })
      }
      // Neutral: reports nothing new and touches nothing.
      fs.writeFileSync(CHECK, "console.log(JSON.stringify({ fire: false }))\n")
      // The moved watcher: reports two items it already reported on the old daemon, and one new.
      fs.writeFileSync(CHECK_SEED, `console.log(JSON.stringify({ fire: true, items: ${JSON.stringify(SEED_ITEMS.map((id) => ({ id })))}, state: { lastUid: 102 } }))\n`)
      for (const dir of [RUN_DIR, FIXTURE_HOME, FIXTURE_TMP]) fs.mkdirSync(dir, { recursive: true })
      // A minimal env: nothing of the real HOME, no credentials, no inherited Walnut settings.
      const env: NodeJS.ProcessEnv = {
        PATH: guardedPath([], '/usr/bin:/bin'),
        HOME: FIXTURE_HOME,
        TMPDIR: FIXTURE_TMP,
        WALNUT_DAEMON_DIR: RUN_DIR,
        WALNUT_TRIGGER_STATE_DIR: DURABLE,
        WALNUT_TRIGGER_REPLAY_MS: '600000',
      }
      // `--start`, never `--service`.
      const [cmd, args] = twin === 'standalone'
        ? [BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']]
        : [SOURCE_TWIN.file, [path.join(BIN, 'daemon.cjs'), '--start']]
      const portFile = path.join(RUN_DIR, 'daemon.port')
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      proc = child
      exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', () => resolve())
      })
      child.unref()
      const pidFile = path.join(RUN_DIR, 'daemon.pid')
      await waitFor(() => (fs.existsSync(portFile) && fs.existsSync(pidFile) ? true : undefined), 30_000, 'the daemon port and pid files')
      port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
      // The daemon serving this port is the process this file spawned, nothing else;
      // the pid file is only compared, never signalled.
      const filePid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      expect(filePid, 'daemon.pid names the spawned process').toBe(child.pid)
    }, 60_000)

    afterAll(async () => {
      for (const c of clients) c.close()
      if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM')
      }
      if (exited) await Promise.race([exited, sleep(EXIT_WAIT_MS)])
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        throw new Error('The fixture daemon has not exited; its files are left intact.')
      }
      for (const dir of [BASE, `${RUN_DIR}-streams`]) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    it('advertises trigger-state-snapshot-v1', async () => {
      const c = await client()
      const hello = await c.rpc({ cmd: 'hello' })
      expect(hello.ok).toBe(true)
      expect(hello.capabilities as string[]).toContain('trigger-state-snapshot-v1')
    })

    it('snapshots only the exact state of the socket\'s own Walnut, and writes nothing', async () => {
      const a = await client()
      // A set without the trigger, so nothing ever arms or runs it.
      expect(await configure(a, ['keep-a'], HOME_A)).toMatchObject({ ok: true, count: 1 })

      const own = stateFile(HOME_A, TID)
      const body = JSON.stringify(fakeState('epoch-own-a'))
      writeFile(own, body)
      // Decoys a fallback would pick: another Walnut's copy and the shared copy.
      writeFile(stateFile(HOME_B, TID), JSON.stringify(fakeState('epoch-of-b')))
      writeFile(sharedStateFile(TID), JSON.stringify(fakeState('epoch-shared')))
      const before = fs.statSync(own)

      expect(await snapshot(a, { triggerId: TID })).toMatchObject({ ok: true, supported: false, reason: 'home_required' })
      const b = await client()
      expect(await configure(b, ['keep-b'], HOME_B)).toMatchObject({ ok: true })
      expect(await snapshot(b, { home: HOME_A, triggerId: TID }), 'another Walnut\'s socket').toMatchObject({ supported: false, reason: 'socket_not_owner' })
      const stranger = await client()
      expect(await snapshot(stranger, { home: HOME_A, triggerId: TID }), 'a socket that pushed no set').toMatchObject({ supported: false, reason: 'socket_not_owner' })

      const reply = await snapshot(a, { home: HOME_A, triggerId: TID })
      expect(reply).toMatchObject({ ok: true, supported: true, complete: true, frozen: true, triggerId: TID, seenCount: 2 })
      expect(reply.state).toEqual(JSON.parse(body))
      expect(reply.state.epoch, 'never the other Walnut\'s or the shared copy').toBe('epoch-own-a')
      expect(reply.digest).toBe(createHash('sha256').update(canonicalTriggerStateJson(reply.state)).digest('hex'))
      expect(reply.fileSha256).toBe(createHash('sha256').update(body).digest('hex'))
      expect(reply.stateMtimeMs).toBe(before.mtimeMs)
      expect(reply.seenReliableUntil).toBeGreaterThan(Date.now())

      // Read only: the file is byte for byte and time for time what it was.
      expect(fs.readFileSync(own, 'utf-8')).toBe(body)
      expect(fs.statSync(own).mtimeMs).toBe(before.mtimeMs)
    }, 60_000)

    it('refuses a file with a pending fire and a missing file, and creates none', async () => {
      const a = await client()
      expect(await configure(a, ['keep-a'], HOME_A)).toMatchObject({ ok: true })
      const own = stateFile(HOME_A, TID)
      writeFile(own, JSON.stringify(fakeState('epoch-own-a', { pendingFires: [{ seq: 10, atMs: Date.now(), items: [{ id: 'uid-102' }], durationMs: 3 }] })))
      expect(await snapshot(a, { home: HOME_A, triggerId: TID })).toMatchObject({ supported: false, reason: 'pending_fires' })
      fs.unlinkSync(own)
      expect(await snapshot(a, { home: HOME_A, triggerId: TID })).toMatchObject({ supported: false, reason: 'state_missing' })
      expect(fs.existsSync(own), 'a missing state is never created').toBe(false)
    }, 60_000)

    it('refuses a trigger the socket\'s latest set still carries', async () => {
      const a = await client()
      expect(await configure(a, ['armed-watch', 'keep-a'], HOME_A)).toMatchObject({ ok: true, count: 2 })
      expect(await snapshot(a, { home: HOME_A, triggerId: 'armed-watch' })).toMatchObject({ ok: true, supported: false, reason: 'still_configured' })
    }, 60_000)

    // ── triggers.state.seed (trigger-state-seed-v1): the receiving half of a set move ──

    const HOME_C = path.join(BASE, 'walnut-c')
    const SEED_TID = 'moved-mail-watch'
    const seedDef = { id: SEED_TID, name: SEED_TID, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(CHECK_SEED)}` } }
    const seed = (c: Client, frame: Record<string, unknown>) => c.rpc({ cmd: 'triggers.state.seed', ...frame })
    const digestOf = (s: unknown) => createHash('sha256').update(canonicalTriggerStateJson(s)).digest('hex')

    it('advertises trigger-state-seed-v1', async () => {
      const hello = await (await client()).rpc({ cmd: 'hello' })
      expect(hello.capabilities as string[]).toContain('trigger-state-seed-v1')
    })

    it('a configure reply says what the home still arms and drains', async () => {
      const c = await client()
      expect(await c.rpc({ cmd: 'triggers.configure', home: path.join(BASE, 'walnut-d'), config: { version: 1, triggers: [] } }))
        .toMatchObject({ ok: true, applied: true, count: 0, armed: 0, draining: 0 })
      expect(await c.rpc({ cmd: 'triggers.configure', home: path.join(BASE, 'walnut-d'), config: { version: 1, triggers: [def('d-watch')] } }))
        .toMatchObject({ ok: true, count: 1, armed: 1, draining: 0 })
      expect(await c.rpc({ cmd: 'triggers.configure', home: path.join(BASE, 'walnut-d'), config: { version: 1, triggers: [] } }))
        .toMatchObject({ ok: true, count: 0, armed: 0, draining: 0 })
    }, 60_000)

    it('seeds the moved state, and the first configure arms the trigger with it: only a new item fires', async () => {
      const moved = fakeState('epoch-moved')
      const digest = digestOf(moved)
      const own = stateFile(HOME_C, SEED_TID)
      // The set's daemon has not been pushed this Walnut's triggers yet (the leader holds the push).
      const c = await client()
      expect(await seed(c, { triggerId: SEED_TID, state: moved, digest })).toMatchObject({ ok: true, seeded: false, reason: 'home_required' })
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: moved, digest: 'f'.repeat(64) })).toMatchObject({ ok: true, seeded: false, reason: 'digest_mismatch' })
      const pending = { ...moved, pendingFires: [{ seq: 10, atMs: Date.now(), items: [{ id: 'uid-102' }], durationMs: 3 }] }
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: pending, digest: digestOf(pending) })).toMatchObject({ seeded: false, reason: 'pending_fires' })
      expect(fs.existsSync(own), 'a refused seed writes nothing').toBe(false)

      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: moved, digest })).toMatchObject({ ok: true, seeded: true, triggerId: SEED_TID, digest, seq: 9, seenCount: 2 })
      const body = fs.readFileSync(own, 'utf-8')
      expect(JSON.parse(body)).toEqual(moved)
      expect(fs.statSync(own).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(path.dirname(own)), 'no temp file left').toEqual([path.basename(own)])
      // A resend of the same state (a lost reply) answers seeded; another state is never written over it.
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: moved, digest })).toMatchObject({ seeded: true, already: true })
      const other = fakeState('epoch-other')
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: other, digest: digestOf(other) })).toMatchObject({ ok: true, seeded: false, reason: 'state_exists' })
      expect(fs.readFileSync(own, 'utf-8')).toBe(body)

      // The push the leader held: the trigger arms with the seeded file, which stays as it is.
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_C, config: { version: 1, triggers: [seedDef] } })).toMatchObject({ ok: true, count: 1, armed: 1 })
      expect(fs.readFileSync(own, 'utf-8'), 'configure reads the seeded state, it does not replace it').toBe(body)
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: moved, digest })).toMatchObject({ ok: true, seeded: false, reason: 'still_configured' })

      // Its first check reports three items; two are in the moved seen set.
      expect(await c.rpc({ cmd: 'triggers.run', home: HOME_C, triggerId: SEED_TID })).toMatchObject({ ok: true, ran: true })
      const fired = await waitFor(() => c.events.find((e) => e.ev === 'trigger.fired' && e.id === SEED_TID), 20_000, 'the first fire')
      expect(fired.items.map((i: { id: string }) => i.id), 'only the item the old daemon never reported').toEqual(['uid-102'])
      expect(fired.epoch, 'the moved epoch, so the server dedups across the move').toBe('epoch-moved')
      expect(fired.seq).toBe(10)
      const after = JSON.parse(fs.readFileSync(own, 'utf-8'))
      expect(Object.keys(after.seen).sort()).toEqual(SEED_ITEMS)
      expect(after.state).toEqual({ lastUid: 102 })

      // Acked and disarmed: nothing of this home is left armed or draining.
      expect(await c.rpc({ cmd: 'triggers.ack', home: HOME_C, triggerId: SEED_TID, seq: 10 })).toMatchObject({ ok: true, acked: true })
      expect(await c.rpc({ cmd: 'triggers.configure', home: HOME_C, config: { version: 1, triggers: [] } })).toMatchObject({ ok: true, armed: 0, draining: 0 })
      // Disarmed, the file is this Walnut's own again: still never overwritten.
      expect(await seed(c, { home: HOME_C, triggerId: SEED_TID, state: moved, digest })).toMatchObject({ seeded: false, reason: 'state_exists' })
    }, 60_000)

    it('never writes through a symlink, and a socket of another Walnut cannot seed', async () => {
      const moved = fakeState('epoch-link')
      const digest = digestOf(moved)
      const link = stateFile(HOME_C, 'linked-watch')
      const target = path.join(BASE, 'link-target.json')
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(target, link)
      const c = await client()
      expect(await seed(c, { home: HOME_C, triggerId: 'linked-watch', state: moved, digest })).toMatchObject({ ok: true, seeded: false, reason: 'state_exists' })
      expect(fs.existsSync(target)).toBe(false)

      const bound = await client()
      expect(await bound.rpc({ cmd: 'leader.configure', home: HOME_A, walnutId: 'walnuta' })).toMatchObject({ ok: true })
      const r = await seed(bound, { home: HOME_C, triggerId: 'foreign-watch', state: moved, digest })
      expect(r).toMatchObject({ ok: false, errorKind: 'not_owner' })
      expect(fs.existsSync(stateFile(HOME_C, 'foreign-watch'))).toBe(false)
    }, 60_000)
  })
}
