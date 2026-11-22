/**
 * A host's one Walnut service (src/binary/service-entry.ts), end to end, in one real process:
 *   - the launcher's `--service` start with a mode file naming this executable and the follower
 *     spec an older daemon kept: the follower child that daemon left is ended first (its pid file
 *     goes, its spec stays), then ONE process serves: the follower server and the daemon runtime;
 *   - the launcher's ready mark is written by the server, once the door answers and the public
 *     GET /api/v1/instance does (a replica trusts no loopback caller with /api/config);
 *   - the door is the daemon's: daemon.pid names this process, its hello says `serves: 'walnut-serve'`
 *     and is managed by the service, `daemonReady` (what `walnut daemon update` waits for) passes;
 *   - a second service on the same dirs does not take them, and says why (the service that holds them);
 *   - `walnut daemon update`'s handover (`service.update`, which the lock banner `service` lets
 *     through) ends the whole process, with the launcher's leaving mark.
 * MACHINE SAFETY: one temp root (HOME, data, run, daemon and state dirs); the only processes
 * signalled are the ones this test spawned (a `sleep` standing in for the old follower, the runners).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { defaultReadStartTime } from '../../src/providers/daemon-core.js'
import { daemonReady } from '../../src/providers/daemon-service-ready.js'

const RUNNER = path.resolve(__dirname, 'fixtures/one-service-runner.ts')
const BUN = process.versions.bun ? process.execPath : null
const LEADER = '/leader-of-test/walnut-home'
const roots: string[] = []
const spawned: ChildProcess[] = []
afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null && c.pid && c.pid > 1) { try { process.kill(c.pid, 'SIGKILL') } catch { /* gone */ } }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

async function until<T>(what: string, fn: () => T | null | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** The warnings and errors the service logged (its run dir's logs), for a failure's message. */
function problems(dirs: string[], out: string): string {
  const lines: string[] = []
  for (const dir of dirs) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.endsWith('.log')) continue
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) if (/"level":"(warn|error)"|\b(WRN|ERR)\b/.test(line)) lines.push(line.slice(0, 400))
    }
  }
  return `${lines.slice(-40).join('\n')}\n--- output ---\n${out.split('\n').filter((l) => !/replica away answer/.test(l)).slice(-40).join('\n')}`
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


/** A leader on the door (what a Walnut's session link is): it names its Walnut, describes it, and asks. */
async function leaderOnDoor(port: number, home: string, walnutId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('the door did not open')) })
  const waiting = new Map<number, (m: Record<string, unknown>) => void>()
  let next = 1
  ws.onmessage = (m) => { const v = JSON.parse(String(m.data)); const done = typeof v.id === 'number' ? waiting.get(v.id) : undefined; if (done) { waiting.delete(v.id); done(v) } }
  const call = (cmd: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => { const id = next++; waiting.set(id, resolve); ws.send(JSON.stringify({ id, ...cmd })) })
  const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
  expect((await call({ cmd: 'leader.configure', home, walnutId })).ok).toBe(true)
  const slice = { v: 1, home, hash: 'h1', asOf: Date.now(), host: 'test host', sessions: [], tasks: [], requests: [] }
  expect((await call({ cmd: 'host.slice', slice })).ok).toBe(true)
  return { call, close: () => { clearInterval(beat); ws.close() } }
}

describe.skipIf(!BUN || process.platform !== 'linux')('the host\'s one Walnut service', () => {
  it('ends the old follower, serves as one process, is ready once, and ends with its update', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-'))
    roots.push(root)
    const p = (n: string) => path.join(root, n)
    const home = p('home'), state = p('s'), daemonDir = p('d'), launcher = path.join(state, 'launcher')
    for (const d of [home, path.join(state, 'host-server'), launcher]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const port = await freePort()
    const spec = {
      v: 1, home: LEADER, walnutId: 'w-test', command: BUN, args: [], cwd: p('data'), log: p('follower.log'), port, settings: {},
      env: {
        OPEN_WALNUT_HOME: p('data'), WALNUT_DAEMON_DIR: p('run'), WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(port),
        WALNUT_LEADER_HOME: LEADER, WALNUT_WALNUT_ID: 'w-test', WALNUT_HOST_LABEL: 'test host', WALNUT_NO_AUTO_UPDATE: '1',
        WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'test-host',
      },
    }
    const specFile = path.join(state, 'host-server', 'server-00112233aabbccdd.json')
    fs.writeFileSync(specFile, JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
    // The follower child an older daemon left: a process in a group of its own, recorded with its start time.
    const old = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    spawned.push(old)
    const oldGone = new Promise((r) => old.once('exit', r))
    fs.writeFileSync(specFile.replace(/\.json$/, '.pid'), JSON.stringify({ pid: old.pid, startTime: defaultReadStartTime(fs, old.pid!) }))
    fs.writeFileSync(path.join(state, 'service-mode.json'), JSON.stringify({ v: 1, home: LEADER, exe: BUN }))

    const env: NodeJS.ProcessEnv = {
      HOME: home, WALNUT_HOME_OVERRIDE: home, PATH: guardedPath([], '/usr/bin:/bin'), SHELL: '/bin/sh', LANG: 'C',
      WALNUT_DAEMON_DIR: daemonDir, WALNUT_DAEMON_STATE_DIR: state, WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: launcher,
      WALNUT_STREAMS_DIR: p('streams'), WALNUT_LEGACY_STREAMS_DIR: p('no-legacy'), WALNUT_SPAWN_JOURNAL: p('spawn-journal.jsonl'),
      WALNUT_JOURNAL_DIR: p('j'), WALNUT_TASK_DIR_ROOT: p('t'), TMPDIR: os.tmpdir(),
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    }
    let out = ''
    const service = spawn(BUN!, [RUNNER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    spawned.push(service)
    service.stdout!.on('data', (c) => { out += c })
    service.stderr!.on('data', (c) => { out += c })
    const exited = new Promise<number | null>((r) => service.once('exit', (code) => r(code)))

    await oldGone
    // Ready: the server's mark, once the door and the API answer.
    const ready = await until('the ready mark', () => (fs.existsSync(path.join(launcher, 'ready')) ? fs.readFileSync(path.join(launcher, 'ready'), 'utf8') : null), 90_000)
      .catch((err) => { throw new Error(`${(err as Error).message}\n${problems([p('run'), daemonDir], out)}`) })
    expect(ready).toContain(`pid=${service.pid}`)
    // The old follower's pid file went; its spec stayed for a rollback.
    expect(fs.existsSync(specFile.replace(/\.json$/, '.pid'))).toBe(false)
    expect(fs.existsSync(specFile)).toBe(true)
    // One writer of the launcher's heartbeat: the server (its pid).
    expect(fs.readFileSync(path.join(launcher, 'heartbeat'), 'utf8').trim().split(' ')[2]).toBe(String(service.pid))

    // The door: daemon.pid names this process, the hello says it is the service.
    expect(Number(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'))).toBe(service.pid)
    const doorPort = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8'))
    const said = await hello(doorPort)
    expect(said).toMatchObject({ ok: true, serves: 'walnut-serve', cronSupervision: { managed: true, startup: 'service' } })
    expect(await daemonReady(daemonDir, undefined, 10_000)).toBe(true)
    // The follower server answers on its own port (the public route: a replica trusts no loopback caller).
    const instance = await fetch(`http://127.0.0.1:${port}/api/v1/instance`)
    expect(instance.status).toBe(200)
    // The follower in the service calls the runtime directly: a leader that describes its Walnut on the
    // door is followed with no socket and no follower.hello (the runtime's log says how it arrived),
    // and the follower's report reaches the leader's server.status.
    const leader = await leaderOnDoor(doorPort, LEADER, 'w-test')
    let reported: Record<string, unknown> | null = null
    for (const end = Date.now() + 30_000; !reported && Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      const r = await leader.call({ cmd: 'server.status', home: LEADER })
      if ((r.status as { report?: unknown } | undefined)?.report) reported = r
    }
    if (!reported) throw new Error(`the follower never reported\n${problems([p('run'), daemonDir], out)}`)
    expect(((reported as Record<string, unknown>).status as { state: string }).state).toBe('running')
    const daemonLog = () => fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(daemonDir, n), 'utf8')).join('\n')
    await until('the seat in the log', () => daemonLog().includes('follower: the server in this process follows its leader'), 15_000)
    expect(daemonLog()).not.toContain('follower: a server on this host follows its leader')
    leader.close()
    // Nothing else runs below it but what it started itself: no second Walnut program.
    const kids = fs.readFileSync(`/proc/${service.pid}/task/${service.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
    for (const kid of kids) expect(fs.readFileSync(`/proc/${kid}/cmdline`, 'utf8')).not.toMatch(/--replica|--service|__daemon/)

    // A second service on the same dirs does not take them: it ends, the first serves on.
    const second = spawn(BUN!, [RUNNER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    spawned.push(second)
    let secondOut = ''
    second.stdout!.on('data', (c) => { secondOut += c })
    second.stderr!.on('data', (c) => { secondOut += c })
    const secondCode = await new Promise<number | null>((r) => second.once('exit', (code) => r(code)))
    expect(secondCode, secondOut.slice(-2000)).not.toBe(0)
    // It says why, naming the service that holds them.
    expect(secondOut).toMatch(new RegExp(`Another Walnut (server|service) \\(pid ${service.pid}\\b`))
    expect(service.exitCode).toBeNull()
    expect((await hello(doorPort)).instanceId).toBe(said.instanceId)

    // `walnut daemon update` hands over (service.update): the whole service ends, as a daemon would.
    const { requestDaemonServiceUpdate } = await import('../../src/providers/daemon-service-cli.js')
    expect(await requestDaemonServiceUpdate(daemonDir, state, { busyMs: 20_000 })).toBe('prepared')
    expect(await exited).toBe(0)
    expect(fs.existsSync(path.join(launcher, 'leaving'))).toBe(true)
  }, 180_000)
})

describe.skipIf(!BUN || process.platform !== 'linux')('the trial of a version that will run as the service (daemon-boot-proof.ts serve)', () => {
  it('a real service boots in the proof\'s throwaway dirs and writes its ready mark', async () => {
    const { proveDaemonBoot } = await import('../../src/providers/daemon-boot-proof.js')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-proof-'))
    roots.push(base)
    // The executable the mode file names is bun itself, running the entry's two calls (fixtures/one-service-runner.ts).
    const why = await proveDaemonBoot({ executable: BUN!, args: [RUNNER], path: guardedPath([], '/usr/bin:/bin'), base, serve: true, aliveMs: 1_000 })
    expect(why).toBeNull()
    expect(fs.readdirSync(base).filter((n) => n.startsWith('walnut-proof-'))).toEqual([])
  }, 120_000)
})
