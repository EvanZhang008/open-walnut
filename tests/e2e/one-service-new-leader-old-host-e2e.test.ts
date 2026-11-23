/**
 * A new leader drives a host whose daemon is the old build (direction B of the pair; an old leader
 * in front of a host that runs as its one Walnut service is tests/e2e/one-service-old-leader-e2e.test.ts).
 * The host is the 1fe1fd194 session daemon (tests/helpers/v1-daemon-sources.ts), the last build
 * before the one service: its own daemon-standalone.ts, run from its own sources on bun in a process
 * of its own, with a temp HOME and daemon dir. Its hello says nothing of `serves` or `launcher`.
 * The leader is this tree: its DaemonConnection (getDirectDaemonConnection, the hello and its
 * capability check, send, probeDaemonSession), its leader description (configureHostLeader), its
 * RemoteSessionManager and its one-service decision for the host (one-service-mode.ts, through the
 * connection's own serviceModeWant and serviceModeNow, the facts its hello gave), in a process of
 * its own. The session's CLI is the cluster's mock CLI.
 *
 * Not here: the daemon update itself. A switch of the mode rides the daemon update over ssh (the
 * upload and `walnut daemon update` with `--serve`/`--no-serve`, daemon-service-update.ts), which a
 * direct link has no way to run. What this file proves is the input that update takes from this
 * leader: for an old host without the launcher, with the experiments off or on, nothing is due and
 * no service words are asked (serviceModeNow), so the update an old host gets for its build alone
 * carries no switch; which words make which update line is tests/providers/daemon-service-update.test.ts.
 *
 * MACHINE SAFETY: one temp root; every process is one this file started (the old daemon, the new
 * leader) or the CLI the daemon reports; nothing is signalled by pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { servesFromHello } from '../../src/providers/one-service-mode.js'
import { writeStubBin } from '../helpers/replica-cluster.js'
import { alive, doorPort, openDoor, until } from '../helpers/service-holder.js'
import { OLD_BUILD_FETCH_MS, ensureOldBuild, oldBuildTree, removeOldBuildTree } from '../helpers/v1-daemon-sources.js'

const BUN = process.versions.bun ? process.execPath : null
const ROOT = path.resolve(__dirname, '../..')
const HOST = 'devbox'
const SID = 'dddddddd-7004-4004-8004-000000000004'
const FIRST = 'hello from the new leader'
const SECOND = 'a second line from the new leader'

type Want = { want: 'walnut-serve' | 'daemon' | null; why?: string }
interface ModeCase { launcher: string; offer: string; want: Want; now: { due: boolean; serve?: unknown }; connected: boolean; instanceId: string | null }

interface Report {
  hello: {
    connected: boolean; known: boolean; verified: boolean; missing: string[]; instanceId: string | null; startup: string
    version: string | null; servesAs: { serves: string; serviceHome: string | null }; launcher: unknown; expected: string | null
  }
  leader: { epoch: number; holder: string } | null
  before: { ok: boolean; sessions?: Array<{ sid: string; alive: boolean }> }
  started: { pid: number }
  written: boolean
  results: string[]
  exits: number[]
  after: { ok: boolean; sessions?: Array<{ sid: string; pid: number; alive: boolean }> }
  probe: { alive: boolean; pid?: number } | null
  modes: ModeCase[]
}

/** The new leader: this tree's modules, on the old daemon's port, one report line, then it stays until stdin closes. */
function leaderScript(o: { port: number; cli: string; cwd: string; home: string }): string {
  const at = (f: string) => JSON.stringify(path.join(ROOT, f))
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
  // This build's own check of the hello (private in TypeScript only; the ssh path redeploys a daemon that fails it).
  const verified = await conn.verifyCapabilities()
  const hello = {
    connected: conn.connected, known: conn.capabilitiesKnown, verified,
    missing: REQUIRED_DAEMON_CAPABILITIES.filter((x) => !conn.hasCapability(x)),
    instanceId: conn.daemonInstanceId, startup: conn.daemonStartup, version: conn.daemonVersion,
    servesAs: conn.servesAs, launcher: conn.launcher, expected: conn.getExpectedDaemonVersion(),
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
  // The one-service decision for this host, as the connection makes it (its hello's facts), with the
  // experiments off, with only service_launcher on, and with both on and this host offered. Each env
  // pair decides for this process (service-launcher-flag.ts). checkServiceMode is the leader's own
  // "switch if due" step: it must leave the link and the daemon as they are.
  const modes = []
  for (const [launcher, offer] of [['0', '0'], ['1', '0'], ['1', '1']]) {
    process.env.WALNUT_SERVICE_LAUNCHER = launcher
    process.env.WALNUT_HOST_SERVICE_OFFER = offer
    const want = await conn.serviceModeWant()
    const now = await conn.serviceModeNow()
    await conn.checkServiceMode()
    await new Promise((r) => setTimeout(r, 500))
    modes.push({ launcher, offer, want, now, connected: conn.connected, instanceId: conn.daemonInstanceId })
  }
  say('REPORT', { hello, leader, before, started, written, results, exits, after, probe, modes })
} catch (err) {
  say('FAILED', String(err && err.stack || err))
  process.exit(1)
}
await new Promise((r) => { process.stdin.on('end', r); process.stdin.on('close', r); process.stdin.resume() })
process.exit(0)
`
}

/** The pids whose environment names the old daemon's dir: the daemon itself and what it started. */
function processesOnDir(dir: string): number[] {
  const want = `WALNUT_DAEMON_DIR=${dir}`
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number).filter((pid) => {
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(want) && alive(pid) } catch { return false }
  })
}
const parentOf = (pid: number): number => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1])

/** Ends a child this file started: stdin closed or SIGTERM first, SIGKILL after 10 s. */
async function endChild(child: ChildProcess | null, signal: 'stdin' | 'SIGTERM'): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const gone = new Promise((r) => child.once('exit', r))
  try { if (signal === 'stdin') child.stdin?.end(); else child.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

describe.skipIf(!BUN || process.platform !== 'linux')('a new leader drives a host whose daemon is the old build (1fe1fd194)', () => {
  const strays: number[] = []
  let root = ''
  let dir = ''
  let daemon: ChildProcess | null = null
  let daemonErr = ''
  let leader: ChildProcess | null = null
  let leaderOut = ''
  let report: Report

  beforeAll(() => ensureOldBuild(), OLD_BUILD_FETCH_MS)

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osnl-')))
    const bin = path.join(root, 'bin')
    writeStubBin(bin)
    const hostHome = path.join(root, 'hh')
    const leaderHome = path.join(root, 'lh')
    const leaderData = path.join(leaderHome, 'data')
    const work = path.join(root, 'work')
    dir = path.join(root, 'd')
    for (const d of [hostHome, leaderData, work, dir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

    // The old host: its own daemon-standalone.ts on bun, every path it keeps under the root.
    const oldRoot = oldBuildTree()
    daemon = spawn(process.execPath, [path.join(oldRoot, 'src/providers/daemon-standalone.ts'), '--start'], {
      cwd: oldRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: hostHome, WALNUT_HOME_OVERRIDE: hostHome, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
        WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(dir, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
        WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_TRIGGER_STATE_DIR: path.join(dir, 'triggers'),
        WALNUT_RESUME_RECORD_DIR: path.join(dir, 'resume'), WALNUT_REPLICA_DIR: path.join(dir, 'replica'),
      },
    })
    daemon.stderr!.on('data', (b: Buffer) => { daemonErr = (daemonErr + b.toString()).slice(-4000) })
    await until('the old daemon', () => {
      if (daemon!.exitCode !== null || daemon!.signalCode !== null) throw new Error(`the old daemon exited (${daemon!.exitCode ?? daemon!.signalCode})\n${daemonErr}`)
      return fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid'))
    }, 90_000)
    // It runs in the foreground: the pid file names the child this file started.
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim()).toBe(String(daemon.pid))

    const file = path.join(root, 'new-leader.mts')
    fs.writeFileSync(file, leaderScript({ port: doorPort(dir), cli: path.join(bin, 'claude'), cwd: work, home: leaderData }))
    const leaderDaemonDir = path.join(root, 'ld')
    fs.mkdirSync(leaderDaemonDir, { recursive: true, mode: 0o700 })
    leader = spawn(process.execPath, [file], {
      cwd: ROOT,
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
    const line = await until('the new leader\'s report', () => {
      const failed = /^FAILED (.*)$/m.exec(leaderOut)
      if (failed) throw new Error(`the new leader failed: ${failed[1]}\n${leaderErr}\nold daemon:\n${daemonErr.slice(-2000)}`)
      if (leader!.exitCode !== null) throw new Error(`the new leader exited ${leader!.exitCode}\n${leaderErr}`)
      return /^REPORT (.*)$/m.exec(leaderOut)?.[1]
    }, 180_000)
    report = JSON.parse(line) as Report
    if (typeof report.started?.pid === 'number') strays.push(report.started.pid)
  }, 240_000)

  afterAll(async () => {
    await endChild(leader, 'stdin')
    if (dir && fs.existsSync(path.join(dir, 'daemon.port')) && daemon?.exitCode === null) {
      const door = await openDoor(doorPort(dir)).catch(() => null)
      await door?.call({ cmd: 'stop', sid: SID }).catch(() => undefined)
      door?.close()
    }
    await endChild(daemon, 'SIGTERM')
    for (const pid of strays) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (root) fs.rmSync(root, { recursive: true, force: true })
    removeOldBuildTree()
  }, 60_000)

  it('the new leader\'s capability check passes on the old hello, and it reads the host as a daemon', async () => {
    // What the old daemon's hello says: no word of the one service or the launcher.
    const door = await openDoor(doorPort(dir))
    const said = await door.call({ cmd: 'hello' })
    door.close()
    expect(said.ok).toBe(true)
    expect(said).not.toHaveProperty('serves')
    expect(said).not.toHaveProperty('launcher')
    // This tree's reading of that hello: the session daemon, no service home.
    expect(servesFromHello(said)).toEqual({ serves: 'daemon', serviceHome: null })
    // The connection's own check: every capability this build requires, the old daemon's id and build.
    expect(report.hello).toMatchObject({ connected: true, known: true, verified: true, missing: [], startup: 'on-demand', launcher: null })
    expect(report.hello.instanceId).toBe(said.instanceId)
    expect(report.hello.version).toBe(said.version)
    expect(report.hello.servesAs).toEqual({ serves: 'daemon', serviceHome: null })
    // Its leader description (leader.configure) was accepted by the old daemon: it holds the lead there.
    expect(report.leader).toMatchObject({ holder: 'primary' })
  })

  it('it lists sessions, starts one on the mock CLI and gets answers to its first and next line', () => {
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

  it('its one-service decision never asks the old host to switch, with the experiments off or on', () => {
    const byCase = Object.fromEntries(report.modes.map((m) => [`${m.launcher}${m.offer}`, m]))
    // Off (and service_launcher alone, the offer off): a host that runs as the daemon is left as it is.
    expect(byCase['00'].want).toEqual({ want: null })
    expect(byCase['10'].want).toEqual({ want: null })
    // On and this host offered: no launcher in the old hello, so the daemon stays, with the reason for Walnut Health.
    expect(byCase['11'].want).toEqual({ want: 'daemon', why: expect.stringMatching(/does not run under the service launcher/) })
    for (const m of report.modes) {
      // No switch is due and no service words go with an update (`serve` feeds --serve/--no-serve).
      expect(m.now).toEqual({ due: false })
      // checkServiceMode changed nothing: the same link, the same daemon process.
      expect(m.connected).toBe(true)
      expect(m.instanceId).toBe(report.hello.instanceId)
    }
  })

  it('the session runs under the old daemon, and stays there after the new leader leaves', async () => {
    const cli = report.started.pid
    expect(parentOf(cli)).toBe(daemon!.pid)
    expect(processesOnDir(dir).filter((pid) => pid !== cli)).toEqual([daemon!.pid])

    const gone = new Promise((r) => leader!.once('exit', r))
    leader!.stdin!.end()
    await gone
    expect(leader!.exitCode).toBe(0)

    const door = await openDoor(doorPort(dir))
    try {
      const status = await until('the old daemon to report the session', async () => {
        const s = await door.call({ cmd: 'status', sid: SID })
        return s.exists === true ? s : null
      })
      expect(status).toMatchObject({ ok: true, alive: true, pid: cli })
      // The same old daemon: no restart, no redeploy, still no word of the service.
      const hello = await door.call({ cmd: 'hello' })
      expect(hello).toMatchObject({ ok: true, instanceId: report.hello.instanceId, version: report.hello.version })
      expect(servesFromHello(hello).serves).toBe('daemon')
      expect(daemon!.exitCode).toBeNull()
      expect(processesOnDir(dir).filter((pid) => pid !== cli)).toEqual([daemon!.pid])
      expect((await door.call({ cmd: 'stop', sid: SID })).ok).toBe(true)
      await until('the CLI to end', () => !alive(cli), 15_000)
    } finally {
      door.close()
    }
  }, 60_000)
})
