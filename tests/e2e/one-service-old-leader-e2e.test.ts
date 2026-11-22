/**
 * An old leader drives a host that runs as its one Walnut service (direction A of the pair; a new
 * leader in front of an old host is the simulated-hello tests). The leader is the 1fe1fd194 build
 * (tests/helpers/v1-daemon-sources.ts), which knows nothing of the one service: its own
 * DaemonConnection (getDirectDaemonConnection, the hello and its capability check, send, and
 * probeDaemonSession), its leader description (configureHostLeader, core/leader/primary-leader.ts)
 * and its RemoteSessionManager (start, writeMessage, the event stream), run from its own sources on
 * bun in a process of its own. The host is this tree's service-mode runtime
 * (tests/helpers/service-holder.ts) and the session's CLI is the cluster's mock CLI.
 *
 * Not here: the old leader's `server.configure`. Its host-server manager sends it only after it
 * installs its build on the host over ssh (runRemoteScript, uploadFile), which a direct link has no
 * way to run; the service's answer to `server.configure` is tests/providers/one-service-door.test.ts b.
 *
 * MACHINE SAFETY: one temp root; every process is one this file started (the holder, the old leader)
 * or the CLI the service reports; nothing is signalled by pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeStubBin } from '../helpers/replica-cluster.js'
import { alive, doorPort, holderEnv, openDoor, startHolder, stopHolders, until, type Holder } from '../helpers/service-holder.js'
import { OLD_BUILD_FETCH_MS, ensureOldBuild, oldBuildTree, removeOldBuildTree } from '../helpers/v1-daemon-sources.js'

const BUN = process.versions.bun ? process.execPath : null
const HOST = 'devbox'
const SID = 'cccccccc-7003-4003-8003-000000000003'
const FIRST = 'hello from the old leader'
const SECOND = 'a second line from the old leader'

interface Report {
  hello: { connected: boolean; known: boolean; verified: boolean; missing: string[]; instanceId: string | null; startup: string }
  leader: { epoch: number; holder: string } | null
  before: { ok: boolean; sessions?: Array<{ sid: string; alive: boolean }> }
  started: { pid: number }
  written: boolean
  results: string[]
  exits: number[]
  after: { ok: boolean; sessions?: Array<{ sid: string; pid: number; alive: boolean }> }
  probe: { alive: boolean; pid?: number } | null
}

/** The old leader: the 1fe1fd194 modules at `oldRoot`, on the service's door, one report line, then it stays until stdin closes. */
function leaderScript(o: { oldRoot: string; port: number; cli: string; cwd: string; home: string }): string {
  const at = (f: string) => JSON.stringify(path.join(o.oldRoot, f))
  return `
const say = (k, v) => process.stdout.write(k + ' ' + JSON.stringify(v) + '\\n')
const until = async (what, fn, ms = 60000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 100)) }
}
try {
  const c = await import(${at('src/constants.ts')})
  if (c.WALNUT_HOME !== ${JSON.stringify(o.home)}) throw new Error('REFUSING: wrong home ' + c.WALNUT_HOME)
  const dcm = await import(${at('src/providers/daemon-connection.ts')})
  const { RemoteSessionManager } = await import(${at('src/providers/remote-session-manager.ts')})
  const { configureHostLeader } = await import(${at('src/core/leader/primary-leader.ts')})
  const { REQUIRED_DAEMON_CAPABILITIES } = await import(${at('src/providers/daemon-capabilities.ts')})
  const url = 'ws://127.0.0.1:${o.port}'
  const conn = await dcm.getDirectDaemonConnection(${JSON.stringify(HOST)}, url)
  dcm.setPooledConnectionForTest(${JSON.stringify(HOST)}, conn)
  // The old build's own check of a hello (its ssh path redeploys a daemon that fails it).
  const verified = await conn.verifyCapabilities()
  const hello = {
    connected: conn.connected, known: conn.capabilitiesKnown, verified,
    missing: REQUIRED_DAEMON_CAPABILITIES.filter((x) => !conn.hasCapability(x)),
    instanceId: conn.daemonInstanceId, startup: conn.daemonStartup,
  }
  const leader = await configureHostLeader(conn)
  const before = await conn.send('list')
  const results = []
  const exits = []
  const rsm = new RemoteSessionManager(${JSON.stringify(SID)}, ${JSON.stringify(HOST)}, null, url, ${JSON.stringify(o.cli)})
  const started = await rsm.start({
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', ${JSON.stringify(SID)}],
    cwd: ${JSON.stringify(o.cwd)}, message: ${JSON.stringify(FIRST)}, mode: 'default',
    onOutput: ({ line }) => { try { const v = JSON.parse(line); if (v.type === 'result') results.push(String(v.result)) } catch {} },
    onExit: (code) => { exits.push(code) },
  })
  await until('the first answer', () => results.some((r) => r.includes(${JSON.stringify(FIRST)})))
  const written = await rsm.writeMessage(${JSON.stringify(SECOND)})
  await until('the second answer', () => results.some((r) => r.includes(${JSON.stringify(SECOND)})))
  const after = await conn.send('list')
  const probe = await dcm.probeDaemonSession(${JSON.stringify(HOST)}, ${JSON.stringify(SID)})
  say('REPORT', { hello, leader, before, started, written, results, exits, after, probe })
} catch (err) {
  say('FAILED', String(err && err.stack || err))
  process.exit(1)
}
await new Promise((r) => { process.stdin.on('end', r); process.stdin.on('close', r); process.stdin.resume() })
process.exit(0)
`
}

/** The pids whose environment names the service's daemon dir: the service itself and what it started. */
function processesOnDir(dir: string): number[] {
  const want = `WALNUT_DAEMON_DIR=${dir}`
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number).filter((pid) => {
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(want) && alive(pid) } catch { return false }
  })
}
const parentOf = (pid: number): number => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1])

describe.skipIf(!BUN || process.platform !== 'linux')('an old leader (1fe1fd194) drives a host whose one Walnut service is new', () => {
  const holders: ChildProcess[] = []
  const strays: number[] = []
  let root = ''
  let dir = ''
  let holder: Holder
  let leader: ChildProcess | null = null
  let leaderOut = ''
  let report: Report

  beforeAll(() => ensureOldBuild(), OLD_BUILD_FETCH_MS)

  beforeAll(async () => {
    // Short: the service's unix sockets live under it.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osol-')))
    const bin = path.join(root, 'bin')
    writeStubBin(bin)
    const leaderHome = path.join(root, 'lh')
    const leaderData = path.join(leaderHome, 'data')
    const work = path.join(root, 'work')
    for (const d of [leaderData, work]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    // The service follows the Walnut whose data dir is the old leader's.
    const env = holderEnv(path.join(root, 'svc'), { serviceHome: leaderData })
    dir = env.WALNUT_DAEMON_DIR!
    holder = await startHolder(env, holders)

    const oldRoot = oldBuildTree()
    const file = path.join(root, 'old-leader.mts')
    fs.writeFileSync(file, leaderScript({ oldRoot, port: doorPort(dir), cli: path.join(bin, 'claude'), cwd: work, home: leaderData }))
    const leaderDaemonDir = path.join(root, 'ld')
    fs.mkdirSync(leaderDaemonDir, { recursive: true, mode: 0o700 })
    leader = spawn(process.execPath, [file], {
      cwd: oldRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '', HOME: leaderHome, USERPROFILE: leaderHome, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
        OPEN_WALNUT_HOME: leaderData, WALNUT_DAEMON_DIR: leaderDaemonDir, WALNUT_STREAMS_DIR: path.join(leaderDaemonDir, 'streams'),
        WALNUT_LEGACY_STREAMS_DIR: path.join(leaderDaemonDir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(leaderDaemonDir, 'spawn-journal.jsonl'),
        WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
      },
    })
    let leaderErr = ''
    leader.stdout!.on('data', (b: Buffer) => { leaderOut += b.toString() })
    leader.stderr!.on('data', (b: Buffer) => { leaderErr = (leaderErr + b.toString()).slice(-4000) })
    const line = await until('the old leader\'s report', () => {
      const failed = /^FAILED (.*)$/m.exec(leaderOut)
      if (failed) throw new Error(`the old leader failed: ${failed[1]}\n${leaderErr}\nservice:\n${holder.output().slice(-2000)}`)
      if (leader!.exitCode !== null) throw new Error(`the old leader exited ${leader!.exitCode}\n${leaderErr}`)
      return /^REPORT (.*)$/m.exec(leaderOut)?.[1]
    }, 180_000)
    report = JSON.parse(line) as Report
    if (typeof report.started?.pid === 'number') strays.push(report.started.pid)
  }, 240_000)

  afterAll(async () => {
    if (leader && leader.exitCode === null && leader.signalCode === null) {
      const gone = new Promise((r) => leader!.once('exit', r))
      try { leader.stdin?.end() } catch { /* closed */ }
      await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))])
      if (leader.exitCode === null && leader.signalCode === null) leader.kill('SIGKILL')
    }
    if (dir && fs.existsSync(path.join(dir, 'daemon.port')) && holder?.child.exitCode === null) {
      const door = await openDoor(doorPort(dir)).catch(() => null)
      await door?.call({ cmd: 'stop', sid: SID }).catch(() => undefined)
      door?.close()
    }
    await stopHolders(holders)
    for (const pid of strays) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (root) fs.rmSync(root, { recursive: true, force: true })
    removeOldBuildTree()
  }, 60_000)

  it('the old leader\'s hello is accepted by the service door, and its own capability check passes', async () => {
    // What the service's door says (the hello the old code just read): it is the one Walnut service.
    const door = await openDoor(doorPort(dir))
    const said = await door.call({ cmd: 'hello' })
    door.close()
    expect(said).toMatchObject({ ok: true, serves: 'walnut-serve' })
    // The old code took that hello as a daemon's: every capability it requires, and this runtime's id.
    // Startup 'service' is one the old build knows: it never stops or redeploys such a daemon.
    expect(report.hello).toMatchObject({ connected: true, known: true, verified: true, missing: [], startup: 'service' })
    expect(report.hello.instanceId).toBe(said.instanceId)
    // Its leader description (leader.configure) was accepted: it holds the lead there.
    expect(report.leader).toMatchObject({ holder: 'primary' })
  })

  it('it lists sessions, starts one on the mock CLI and gets answers to its first and next line, as on a daemon', () => {
    expect(report.before.ok).toBe(true)
    expect((report.before.sessions ?? []).filter((s) => s.sid === SID)).toEqual([])
    expect(report.started.pid).toBeGreaterThan(1)
    expect(report.written).toBe(true)
    expect(report.results).toEqual([`echo: ${FIRST}`, `echo: ${SECOND}`])
    expect(report.exits).toEqual([])
    expect(report.after.ok).toBe(true)
    expect(report.after.sessions?.find((s) => s.sid === SID)).toMatchObject({ pid: report.started.pid, alive: true })
    expect(report.probe).toEqual({ alive: true, pid: report.started.pid })
  })

  it('the session runs under the service process itself, and stays there after the old leader leaves', async () => {
    const cli = report.started.pid
    // One Walnut process on this dir: the service holds it, and the CLI is its own child.
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim()).toBe(String(holder.pid))
    expect(parentOf(cli)).toBe(holder.pid)
    expect(processesOnDir(dir).filter((pid) => pid !== cli)).toEqual([holder.pid])

    // The old leader goes away (its process ends; the link closes).
    const gone = new Promise((r) => leader!.once('exit', r))
    leader!.stdin!.end()
    await gone
    expect(leader!.exitCode).toBe(0)

    const door = await openDoor(doorPort(dir))
    try {
      const status = await until('the service to report the session', async () => {
        const s = await door.call({ cmd: 'status', sid: SID })
        return s.exists === true ? s : null
      })
      expect(status).toMatchObject({ ok: true, alive: true, pid: cli })
      // The same runtime, still the one service: no restart, no fallback to a daemon program.
      expect(await door.call({ cmd: 'hello' })).toMatchObject({ ok: true, serves: 'walnut-serve', instanceId: report.hello.instanceId })
      expect(holder.child.exitCode).toBeNull()
      expect(processesOnDir(dir).filter((pid) => pid !== cli)).toEqual([holder.pid])
      // The service ends its session when asked.
      expect((await door.call({ cmd: 'stop', sid: SID })).ok).toBe(true)
      await until('the CLI to end', () => !alive(cli), 15_000)
    } finally {
      door.close()
    }
  }, 60_000)
})
