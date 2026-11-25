/**
 * A remote host two Walnuts share (host_service_sets off: one daemon there), with the one-service
 * experiments on by default: the plain daemon becomes the one service of whichever leader asks
 * first (Walnut A). What that does to the OTHER Walnut (B), in real processes:
 *
 *   1. the host's launcher `--service` runs the plain session daemon (no mode file yet), and B's
 *      server starts a session there through its own RemoteSessionManager, over the daemon's door;
 *   2. A's leader decides the switch (the real one-service-mode decision: nothing in it reads who
 *      else uses the daemon); `walnut daemon update`'s handover ends the daemon (service.update),
 *      the mode file names A, and the launcher's next `--service` start runs A's follower with the
 *      daemon runtime in its own process (tests/providers/fixtures/one-service-runner.ts);
 *   3. B's session is not cut: its CLI is the same process throughout (never ended, adopted by the
 *      service's runtime), B reaches it again on the door and its next turns are turns 2 and 3 of
 *      the same conversation; B's own decision leaves A's service alone.
 *
 * B's link to the daemon drops with the old process, as any update drops it: B dials again where the
 * door is now (the address a leader's tunnel reads from daemon.port at each connect).
 *
 * MACHINE SAFETY: one temp root (HOME, data, run, daemon and state dirs); the only processes
 * signalled are ones this test started (the services, the session side) and the fake CLI, checked
 * by its command line under the temp root first.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { startSessionSide } from '../helpers/walnut-session-side.js'
import { wantedServiceMode, servesFromHello } from '../../src/providers/one-service-mode.js'

const RUNNER = path.resolve(__dirname, 'fixtures/one-service-runner.ts')
const BUN = process.versions.bun ? process.execPath : null
const LEADER_A = '/leader-a-of-test/walnut-home'
const roots: string[] = []
const spawned: ChildProcess[] = []
const cliPids: Array<{ pid: number; root: string }> = []

function alive(pid: number): boolean {
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/^\S+ \(.*\) [ZX] /.test(st) } catch { return false }
}
function cmdline(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { return '' }
}

afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null && c.pid && c.pid > 1) { try { process.kill(c.pid, 'SIGTERM') } catch { /* gone */ } }
  // The fake CLI the kept session left: only when it is still our script under our root.
  for (const { pid, root } of cliPids) if (pid > 1 && alive(pid) && cmdline(pid).includes(root)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 300))
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

async function until<T>(what: string, fn: () => T | null | undefined | false, ms: number, why = () => ''): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${why()}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function hello(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => { ws.close(); reject(new Error('hello timed out')) }, 10_000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' }))
    ws.onmessage = (m) => { const v = JSON.parse(String(m.data)); if (v.id === 1) { clearTimeout(t); ws.close(); resolve(v) } }
    ws.onerror = () => { clearTimeout(t); reject(new Error('hello failed')) }
  })
}

describe.skipIf(!BUN || process.platform !== 'linux')('a shared host becomes the one service of the first leader that asks', () => {
  it('the other Walnut\'s running session is not cut, and it still sends to it and hears it after the switch', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-switch-')))
    roots.push(root)
    const p = (n: string) => path.join(root, n)
    const hostHome = p('host-home'), state = p('s'), daemonDir = p('d'), launcher = path.join(state, 'launcher')
    for (const d of [hostHome, path.join(state, 'host-server'), launcher]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

    // The host: its launcher's env, as the launcher exports it for `<exe> --service`.
    const hostEnv: NodeJS.ProcessEnv = {
      HOME: hostHome, WALNUT_HOME_OVERRIDE: hostHome, PATH: guardedPath([], '/usr/bin:/bin'), SHELL: '/bin/sh', LANG: 'C',
      WALNUT_DAEMON_DIR: daemonDir, WALNUT_DAEMON_STATE_DIR: state, WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: launcher,
      WALNUT_STREAMS_DIR: p('streams'), WALNUT_LEGACY_STREAMS_DIR: p('no-legacy'), WALNUT_SPAWN_JOURNAL: p('spawn-journal.jsonl'),
      WALNUT_JOURNAL_DIR: p('j'), WALNUT_TASK_DIR_ROOT: p('t'), TMPDIR: os.tmpdir(), WALNUT_NET_NO_DOWNLOAD: '1',
      XDG_STATE_HOME: path.join(hostHome, '.local', 'state'), XDG_CONFIG_HOME: path.join(hostHome, '.config'), XDG_CACHE_HOME: path.join(hostHome, '.cache'),
    }
    const logs = () => fs.readdirSync(daemonDir).filter((n) => n.endsWith('.log')).map((n) => fs.readFileSync(path.join(daemonDir, n), 'utf8').split('\n').filter((l) => /warn|error|WRN|ERR/.test(l)).slice(-20).join('\n')).join('\n')
    const startService = (extra: NodeJS.ProcessEnv) => {
      let out = ''
      const c = spawn(BUN!, [RUNNER, '--service'], { env: { ...hostEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
      spawned.push(c)
      c.stdout!.on('data', (d) => { out = (out + d).slice(-8000) })
      c.stderr!.on('data', (d) => { out = (out + d).slice(-8000) })
      const exited = new Promise<number | null>((r) => c.once('exit', (code) => r(code)))
      return { c, exited, out: () => out }
    }

    // ── 1. The plain daemon (no mode file), and B's session on it ─────────────────────
    const plain = startService({ WALNUT_TEST_SERVICE_DAEMON: '1' })
    const port1 = await until('the daemon\'s door', () => {
      try { return Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8').trim()) || null } catch { return null }
    }, 60_000, plain.out)
    const said1 = await hello(port1)
    expect(servesFromHello(said1)).toEqual({ serves: 'daemon', serviceHome: null })

    const bRoot = p('walnut-b')
    const bEnv: NodeJS.ProcessEnv = {
      HOME: path.join(bRoot, 'home'), WALNUT_HOME_OVERRIDE: path.join(bRoot, 'home'), OPEN_WALNUT_HOME: path.join(bRoot, 'walnut-home'),
      WALNUT_DAEMON_DIR: path.join(bRoot, 'own-run'), WALNUT_LEGACY_STREAMS_DIR: p('no-legacy'), WALNUT_IN_PROCESS_DAEMON: '0',
      WALNUT_NET_NO_DOWNLOAD: '1', SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: os.tmpdir(),
    }
    fs.mkdirSync(bEnv.HOME!, { recursive: true })
    const b = await startSessionSide(bEnv, bRoot, spawned)
    const started = await b.call({ op: 'start', url: `ws://127.0.0.1:${port1}` })
    expect(started, b.output()).toMatchObject({ ok: true, result: 'answer one', turns: 1 })
    const cli = Number(started.pid)
    cliPids.push({ pid: cli, root })
    expect(alive(cli)).toBe(true)

    // ── 2. A asks first: its decision switches the plain daemon (who else uses it is not read) ──
    const facts = { experiment: true, serves: 'daemon' as const, serviceHome: null, launcher: true, platform: 'linux', follower: { kind: 'replica' as const } }
    expect(wantedServiceMode({ ...facts, home: LEADER_A })).toEqual({ want: 'walnut-serve' })
    // The follower spec A's supervisor kept on the host, and the mode file the update writes.
    const port = await freePort()
    const spec = {
      v: 1, home: LEADER_A, walnutId: 'w-a', command: BUN, args: [], cwd: p('a-data'), log: p('a-follower.log'), port, settings: {},
      env: {
        OPEN_WALNUT_HOME: p('a-data'), WALNUT_DAEMON_DIR: p('a-run'), WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(port),
        WALNUT_LEADER_HOME: LEADER_A, WALNUT_WALNUT_ID: 'w-a', WALNUT_HOST_LABEL: 'shared host', WALNUT_NO_AUTO_UPDATE: '1',
        WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'shared-host',
      },
    }
    fs.writeFileSync(path.join(state, 'host-server', 'server-a0a0a0a0a0a0a0a0.json'), JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
    fs.writeFileSync(path.join(state, 'service-mode.json'), JSON.stringify({ v: 1, home: LEADER_A, exe: BUN }))
    const { requestDaemonServiceUpdate } = await import('../../src/providers/daemon-service-cli.js')
    expect(await requestDaemonServiceUpdate(daemonDir, state, { busyMs: 20_000, note: () => {} })).toBe('prepared')
    // A daemon program ends a service update with 1, so its service manager (here the launcher) starts it again.
    expect(await plain.exited, plain.out()).toBe(1)
    // The daemon is gone; B's CLI is not: its session was kept for the next runtime.
    expect(alive(cli), 'the CLI outlives the daemon\'s handover').toBe(true)

    // The launcher starts `--service` again: A's follower, the runtime in its process.
    const service = startService({})
    // Its own ready mark (the plain daemon's earlier one names the old pid).
    const readMark = () => { try { return fs.readFileSync(path.join(launcher, 'ready'), 'utf8') } catch { return '' } }
    await until('the service\'s ready mark', () => readMark().includes(`pid=${service.c.pid}\n`), 90_000, () => `${service.out()}\n${logs()}`)
    const port2 = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8').trim())
    const said2 = await hello(port2)
    expect(servesFromHello(said2)).toEqual({ serves: 'walnut-serve', serviceHome: LEADER_A })
    // B's own decision: another Walnut's service, left as it is (never switched back from B).
    expect(wantedServiceMode({ ...facts, ...servesFromHello(said2), home: path.join(bRoot, 'walnut-home') })).toEqual({ want: null })

    // ── 3. B reaches its session again: the same CLI, the same conversation ─────────────
    const again = await b.call({ op: 'attach', url: `ws://127.0.0.1:${port2}`, word: 'two' })
    expect(again, `${b.output()}\n${logs()}`).toMatchObject({ ok: true, alive: true, pid: cli, written: true, result: 'answer two', turns: 2 })
    expect(await b.call({ op: 'round', word: 'three' })).toMatchObject({ ok: true, written: true, result: 'answer three', turns: 3 })
    expect(alive(cli)).toBe(true)
    // The service holds the CLI now: B's session is one of the runtime's.
    const door = await hello(port2)
    expect(door.instanceId).toBe(said2.instanceId)

    // ── Cleanup: B lets go; the service ends with an update's handover, as a daemon would ──
    await b.call({ op: 'exit' })
    await b.stop()
    expect(await requestDaemonServiceUpdate(daemonDir, state, { busyMs: 20_000, note: () => {} })).toBe('prepared')
    expect(await service.exited).toBe(0)
  }, 240_000)
})
