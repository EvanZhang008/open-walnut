/**
 * triggers.state.snapshot against BOTH real daemon twins: the command is wired,
 * advertised, scoped to the socket that pushed the Walnut's set, refuses a trigger
 * that set still carries, and returns the exact state file of that Walnut's scope
 * (a hand-written full host state, so no user script runs) without writing it.
 * The pure rules are covered in trigger-state-snapshot-core.test.ts; this proves the
 * twins call them with the right facts.
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
  private waiters = new Map<number, { resolve: (reply: Record<string, any>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (!waiter) return
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
  })
}
