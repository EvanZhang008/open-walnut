/**
 * The host network update io (src/providers/daemon-net-update-io.ts) through the shared
 * update flow (daemon-service-update.ts), against a small stand-in for the host's daemon:
 * fs.writePart is the daemons' own transfer core on a temp dir, exec.run runs the line
 * with /bin/sh in a process group of its own and, like the daemon, signals that whole
 * group when the shell is gone and something still holds its pipes 2 s later (or always,
 * for the cases that prove the script outlives the group). The `walnut daemon update` it
 * reaches is a fake script.
 *
 * Proven here: the chunks land in order and the host checks each one; a chunk the host
 * finds corrupt is sent again under its own name, and one that never arrives whole fails the update before
 * the service is touched; the final update runs detached (it outlives the group signal),
 * is retried while the old daemon says it has active operations, and not for any other
 * refusal; a launch that could not detach stops the script before it changed anything;
 * what the login profile prints never reaches the answer; a script a later launch took
 * over stops before its next try; a hold before the launch is waited out; a compiled
 * server's walnut file goes up as its own gz, and one whose daemon version differs is
 * refused before the service is touched.
 *
 * MACHINE SAFETY: every file is under a temp dir or a /tmp/open-walnut-update.* dir this
 * file made and removes; the only processes are /bin/sh, the fake script and sleep; the
 * group signal goes only to the shell this test spawned (pid > 1 checked).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNetUpdateIo, launcherScript, NetUpdateHeldError, NetUpdateUnansweredError, runnerScript, RUNNER_PAUSE_SECONDS, RUNNER_TRIES, UPDATE_WAIT_MS,
  type NetUpdateIoOptions,
} from '../../src/providers/daemon-net-update-io.js'
import { daemonInstallRoot, renderDaemonLaunchAgent } from '../../src/providers/daemon-service-config.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { fakeUpdateRunner, type FakeRunner, type FakeRunnerState } from '../helpers/fake-update-runner.js'
import { UPDATE_BUSY_WAIT_MS } from '../../src/providers/daemon-service-cli.js'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { permissionRisk } from '../../src/providers/host-exec-guards.js'
import { guardedPath } from '../setup/exec-guard.js'
import { LAB_STAGING, LAB_VERSION, labDaemon, labHost, type Host } from '../helpers/net-update-lab.js'

const VERSION = LAB_VERSION
const STAGING = LAB_STAGING
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-net-update-io-')))
const made = new Set<string>()
/** The upload's chunk dir, named by the payload's sha256 (kept until an update is applied). */
const CHUNK_DIR = /^\/tmp\/open-walnut-update\.r[0-9a-f]{24}$/
/** The staging dirs this case left on the host. */
const left = () => [...made].filter((dir) => fs.existsSync(dir))
// Every case sends the same fake daemon, so one case's kept chunks would feed the next.
afterEach(() => {
  for (const dir of made) if (STAGING.test(dir)) fs.rmSync(dir, { recursive: true, force: true })
  made.clear()
})
afterAll(() => {
  for (const dir of made) if (STAGING.test(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

let work: string
let state: string
let home: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  state = path.join(work, 'state')
  home = path.join(work, 'home')
  fs.mkdirSync(state)
  fs.mkdirSync(home)
})

/** The fake daemon file (tests/helpers/net-update-lab.ts) in this case's dirs. */
const fakeDaemon = (o: Parameters<typeof labDaemon>[1] = {}): string => labDaemon({ work, state }, o)
/** The daemon's side of the three commands, in this case's dirs. */
const miniHost = (o: Parameters<typeof labHost>[1] = {}): Host => labHost({ work, home, made }, o)

/** Quick clocks, and the latest marker in this case's own dir. */
const fast = (over: NetUpdateIoOptions = {}): NetUpdateIoOptions => ({ pauseSeconds: 0.2, settleSeconds: 0, pollMs: 100, waitMs: 30_000, holdWaitMs: 0, latestMarker: path.join(work, 'latest'), ...over })
/** A process that still runs (a zombie nobody reaped yet counts as gone). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}
const calls = () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : [])

describe('the host network update io', () => {
  it('lands the chunks in order, checks them on the host, and runs the update detached', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ signalGroup: 'always' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const chunks = host.writes.filter((p) => /\/chunk_\d{4}$/.test(p))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks).toEqual([...chunks].sort())
    expect(host.writes.at(-1)).toMatch(/\/update\.sh$/)
    const [update] = calls()
    expect(update).toMatch(/--scope user --executable \/tmp\/open-walnut-update\.\w+\/daemon$/)
    // It ran outside every exec job's group, so the group signal did not reach it.
    const pgid = Number(/pgid=(\d+)/.exec(update)![1])
    expect(host.jobGroups).not.toContain(pgid)
    // The staging dir is gone afterwards.
    const dir = STAGING.exec(update)![0]
    expect(fs.existsSync(dir)).toBe(false)
    // No line it ran is one the macOS guard would refuse, and none carries the bytes.
    for (const line of host.lines) {
      expect(permissionRisk(line, '/', '/Users/someone')).toBeNull()
      expect(line.length).toBeLessThan(8 * 1024)
    }
  }, 60_000)

  it('sends a chunk the host found corrupt again, under its own name (a late write holds the same bytes)', async () => {
    const binary = fakeDaemon()
    let damaged = 0
    const host = miniHost({ corrupt: (p) => /chunk_0000$/.test(p) && damaged++ === 0 })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(host.writes.filter((p) => /chunk_\d{4}$/.test(p)).map((p) => p.slice(-4))).toEqual(['0000', '0000'])
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a chunk that never arrives whole fails the update before the service is touched', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ corrupt: () => true })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user'))
      .rejects.toThrow('the installed service was not changed')
    expect(host.writes.filter((p) => /chunk_\d{4}$/.test(p))).toHaveLength(3)
    expect(calls()).toEqual([])
    expect(host.lines.some((l) => l.includes('daemon update') || l.includes('update.sh'))).toBe(false)
    // Only the chunk dir stays, for the next try, and it holds no damaged chunk.
    expect(left()).toHaveLength(1)
    expect(left()[0]).toMatch(CHUNK_DIR)
    expect(fs.readdirSync(left()[0]).filter((f) => /^chunk_\d{4}$/.test(f))).toEqual([])
  }, 60_000)

  it('asks again while the old daemon has active operations, and reads the answer after the link comes back', async () => {
    const binary = fakeDaemon({ refusals: 2 })
    // The old daemon exits during the handover: reads fail for a while.
    let reads = 0
    const host = miniHost({ readFails: () => { reads += 1; return reads >= 2 && reads <= 4 } })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(calls()).toHaveLength(3)
    expect(reads).toBeGreaterThan(4)
  }, 60_000)

  it('does not ask again after any other refusal', async () => {
    const binary = fakeDaemon({ refusals: 5, refusal: 'Only a managed daemon can prepare a service update' })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast()), 'user'))
      .rejects.toThrow('Only a managed daemon')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('every try, each asking a busy daemon again for its own while, fits in the time the server waits', () => {
    // Half of it: each try also probes, checks and writes, and the last one swaps the daemon.
    expect(RUNNER_TRIES * (UPDATE_BUSY_WAIT_MS + RUNNER_PAUSE_SECONDS * 1000)).toBeLessThan(UPDATE_WAIT_MS / 2)
    expect(RUNNER_TRIES).toBeGreaterThan(1)
  })

  it('stops after the last allowed busy refusal and says the update failed', async () => {
    const binary = fakeDaemon({ refusals: 10 })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ tries: 3 })), 'user'))
      .rejects.toThrow('has active operations')
    expect(calls()).toHaveLength(3)
  }, 60_000)

  it('sends a compiled server\'s walnut file as its own gz, checked by sha256 and its daemon version', async () => {
    const gz = zlib.gzipSync(fs.readFileSync(fakeDaemon({ pad: 600_000 })))
    const host = miniHost()
    await updateRemoteDaemonService({ binary: null, gz }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const chunks = host.writes.filter((p) => /\/chunk_\d{4}$/.test(p))
    expect(chunks.length).toBe(Math.ceil(gz.length / 262_144))
    expect(chunks.length).toBeGreaterThan(1)
    expect(calls()).toHaveLength(1)
    expect(left()).toEqual([])
  }, 60_000)

  it('a walnut file whose daemon version differs is refused before the service is touched', async () => {
    const gz = zlib.gzipSync(fs.readFileSync(fakeDaemon({ version: 'walnut-daemon-000000000000' })))
    const host = miniHost()
    await expect(updateRemoteDaemonService({ binary: null, gz }, VERSION, createNetUpdateIo(host, fast()), 'user'))
      .rejects.toThrow('Uploaded daemon version differs; the installed service was not changed')
    expect(calls()).toEqual([])
    expect(host.writes.some((p) => p.endsWith('/update.sh'))).toBe(false)
    expect(host.lines.some((l) => l.includes('walnut daemon update'))).toBe(false)
    // The chunks proved to be another build: none of them is kept.
    expect(left()).toEqual([])
  }, 60_000)

  it('what the login profile prints never reaches the answers it reads', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ noise: 'Last login: Mon Nov  3 09:00 on ttys001\n{"motd":true}\n/tmp/open-walnut-update.Noise1\n' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  /** A later launch's runner dir (tests/helpers/fake-update-runner.ts). */
  function laterRunner(runner: FakeRunnerState): string {
    const made = fakeUpdateRunner(runner)
    later.push(made)
    return made.dir
  }
  const later: FakeRunner[] = []
  afterEach(() => { for (const made of later.splice(0)) made.stop() })

  it('a script a later launch took over stops before its next try', async () => {
    const latestMarker = path.join(work, 'latest')
    const binary = fakeDaemon({ refusals: 5, supersede: latestMarker, laterDir: laterRunner('alive') })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ latestMarker })), 'user'))
      .rejects.toThrow('a later update on the host took over')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  // 2026-11-04 review: any other dir in the marker counted, so a later launch that never ran stood the only runner down.
  it('a later launch whose runner is gone does not stand this one down', async () => {
    const latestMarker = path.join(work, 'latest')
    const binary = fakeDaemon({ refusals: 1, supersede: latestMarker, laterDir: laterRunner('dead') })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ latestMarker })), 'user')).resolves.toBe('applied')
    expect(calls()).toHaveLength(2)
  }, 60_000)

  // 2026-11-04 review: a server restarted mid-update launched a second runner beside the first one.
  it('a launch while another runner is at work on the host is refused before anything runs, and says so', async () => {
    const latestMarker = path.join(work, 'latest')
    fs.writeFileSync(latestMarker, `${laterRunner('alive')}\n`)
    const host = miniHost()
    const err = await updateRemoteDaemonService({ binary: fakeDaemon() }, VERSION, createNetUpdateIo(host, fast({ latestMarker })), 'user').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(NetUpdateHeldError)
    expect(String(err)).toContain('another daemon update is still running on the host')
    expect(calls()).toEqual([])
    // A dead one in the marker is no runner: the next launch goes ahead.
    fs.writeFileSync(latestMarker, `${laterRunner('dead')}\n`)
    await expect(updateRemoteDaemonService({ binary: fakeDaemon() }, VERSION, createNetUpdateIo(miniHost(), fast({ latestMarker })), 'user')).resolves.toBe('applied')
    expect(calls()).toHaveLength(1)
    // Nor is a live pid that is not its update.sh (a dead runner's pid reused): 2026-11-04 review,
    // every later update would have been refused for as long as that process lived.
    fs.writeFileSync(latestMarker, `${laterRunner('reused')}\n`)
    await expect(updateRemoteDaemonService({ binary: fakeDaemon() }, VERSION, createNetUpdateIo(miniHost(), fast({ latestMarker })), 'user')).resolves.toBe('applied')
    expect(calls()).toHaveLength(2)
  }, 60_000)

  it('a hold met right before the launch is waited out, the upload already on the host', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    let asked = 0
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ holdWaitMs: 5_000, beforeLaunch: () => (++asked < 3 ? '1 write in flight' : null) })), 'user')
    expect(asked).toBe(3)
    expect(calls()).toHaveLength(1)
    expect(host.writes.filter((p) => /\/update\.sh$/.test(p))).toHaveLength(1)
  }, 60_000)

  it('a hold asked of the host right before the launch (a host_exec run there) is awaited and waited out the same way', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    let asked = 0
    const beforeLaunch = async () => { await new Promise((r) => setTimeout(r, 5)); return ++asked < 2 ? '1 host_exec run on the host would end with the daemon' : null }
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ holdWaitMs: 5_000, beforeLaunch })), 'user')
    expect(asked).toBe(2)
    expect(calls()).toHaveLength(1)
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ holdWaitMs: 300, beforeLaunch: async () => '1 host_exec run on the host would end with the daemon' })), 'user'))
      .rejects.toThrow('1 host_exec run on the host would end with the daemon')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('stops reading after its wait, or once nobody waits, says the update may still finish, and keeps the dir for its record', async () => {
    const cases: Array<[NetUpdateIoOptions, RegExp]> = [
      [{ waitMs: 500 }, /did not report back within 1 s; it may still finish there/],
      [{ cancelled: () => true }, /nobody waits for the update any more/],
    ]
    for (const [over, words] of cases) {
      const err = await updateRemoteDaemonService({ binary: fakeDaemon({ sleep: 3 }) }, VERSION, createNetUpdateIo(miniHost(), fast(over)), 'user')
        .then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(NetUpdateUnansweredError)
      expect(String(err)).toMatch(words)
      // The server reads it once the host is back (daemon-net-update-record.ts): the runner still finishes and writes it there.
      const dir = (err as NetUpdateUnansweredError).directory
      for (let i = 0; i < 200 && !fs.existsSync(`${dir}/update.done`); i++) await new Promise((r) => setTimeout(r, 100))
      expect(fs.readFileSync(`${dir}/update.done`, 'utf8')).toBe('rc=0 tries=1 tail=no-service\n')
      expect(fs.readFileSync(`${dir}/update.out`, 'utf8')).toContain('"ok":true')
      fs.rmSync(dir, { recursive: true, force: true })
      made.delete(dir)
    }
  }, 60_000)

  it('a hold that outlasts its wait starts nothing and removes the upload', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ beforeLaunch: () => '1 send in flight', holdWaitMs: 300 })), 'user'))
      .rejects.toThrow('1 send in flight')
    expect(calls()).toEqual([])
    expect(host.lines.some((l) => l.includes('update.sh'))).toBe(false)
    // The try's dir is gone; the chunks stay so the next try sends nothing again.
    expect(left()).toHaveLength(1)
    expect(left()[0]).toMatch(CHUNK_DIR)
  }, 60_000)
})

/** A bin dir with only these tools of the system (no setsid, perl or bash unless named), plus any fakes. */
function toolsDir(fakes: Record<string, string> = {}, extra: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(work, 'bin-'))
  for (const tool of ['ps', 'cat', 'tr', 'sleep', 'grep', 'rm', 'mv', 'mktemp', 'gzip', 'chmod', 'sha256sum', ...extra]) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(dir, tool))
  }
  for (const [name, body] of Object.entries(fakes)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 })
  return dir
}

describe('the detached start', () => {
  it('without setsid or perl, bash job control still leaves the job\'s group', async () => {
    const tools = toolsDir({}, ['bash'])
    const binary = fakeDaemon({ refusals: 1 })
    const host = miniHost({ path: guardedPath([tools], tools), signalGroup: 'always' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const updates = calls()
    expect(updates).toHaveLength(2)
    expect(host.jobGroups).not.toContain(Number(/pgid=(\d+)/.exec(updates[1])![1]))
  }, 60_000)

  it('with only sh, it runs detached or not at all, never inside the job\'s group', async () => {
    // dash (Debian's sh) refuses `set -m` without a terminal; bash as sh allows it.
    const tools = toolsDir()
    const binary = fakeDaemon()
    const host = miniHost({ path: guardedPath([tools], tools), signalGroup: 'always' })
    const done = await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user').then(() => true, (err: Error) => {
      expect(err.message).toContain('did not start detached')
      return false
    })
    await new Promise((r) => setTimeout(r, 300))
    const updates = calls()
    expect(updates).toHaveLength(done ? 1 : 0)
    for (const u of updates) expect(host.jobGroups).not.toContain(Number(/pgid=(\d+)/.exec(u)![1]))
  }, 60_000)

  it('a host with no sha256sum (a Mac) checks the upload with shasum', async () => {
    const real = spawnSync('/bin/sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim()
    const used = path.join(state, 'shasum-used')
    const tools = toolsDir({ shasum: `#!/bin/sh\n[ "$1 $2" = "-a 256" ] || exit 9\nshift 2\necho "$*" >> '${used}'\nexec '${real}' "$@"\n` }, ['bash'])
    fs.rmSync(path.join(tools, 'sha256sum'))
    const binary = fakeDaemon()
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost({ path: guardedPath([tools], tools) }), fast()), 'user')
    expect(fs.readFileSync(used, 'utf8').trim()).toBe('-c -')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a launch that stayed in the job\'s group stops the script before it changed anything', async () => {
    // A setsid that does not detach: the script would share the job's group.
    const tools = toolsDir({ setsid: '#!/bin/sh\nexec "$@"\n' })
    const binary = fakeDaemon()
    const host = miniHost({ path: guardedPath([tools], tools) })
    const err = await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user').then(() => null, (e: Error) => e)
    expect(err?.message).toContain('did not start detached')
    // Nothing signals it (its pipes were closed): told no go, the script itself exits at once.
    const pid = Number(/pid=(\d+)/.exec(err!.message)?.[1])
    expect(pid).toBeGreaterThan(1)
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
    expect(alive(pid)).toBe(false)
    expect(host.jobGroups).toEqual([])
    expect(calls()).toEqual([])
  }, 60_000)

  it('the scripts are plain sh and name the paths quoted', () => {
    const dir = '/tmp/open-walnut-update.Abc123'
    const runner = runnerScript({ directory: dir, command: `${dir}/daemon walnut daemon update --yes --scope user --executable ${dir}/daemon`, executable: `${dir}/daemon` })
    expect(spawnSync('/bin/sh', ['-n', '-c', runner]).status).toBe(0)
    expect(spawnSync('/bin/sh', ['-n', '-c', launcherScript(dir)]).status).toBe(0)
    expect(runner).toContain(`rm -f ${dir}/daemon`)
    expect(runner).toContain('L="/tmp/open-walnut-update-latest-$(id -u)"')
    expect(launcherScript(dir)).toContain('mv -f "$d/latest.tmp" "$L"')
    expect(runnerScript({ directory: dir, command: 'true', executable: '/elsewhere/daemon' })).not.toContain('rm -f /elsewhere')
    for (const scope of ['user', 'cron'] as const) {
      const tailed = runnerScript({ directory: dir, command: 'true', executable: `${dir}/daemon`, tail: { scope } })
      expect(spawnSync('/bin/sh', ['-n', '-c', tailed]).status).toBe(0)
      // The tail runs after the tries, unless a later launch took over, and the done line names its outcome.
      expect(tailed.indexOf('before.cfg')).toBeLessThan(tailed.indexOf('n=$((n+1))'))
      expect(tailed).toContain('if [ "$rc" != superseded ]; then')
      // The last done line (a refused build writes its own early, before anything is touched).
      expect(tailed.indexOf('update.tail')).toBeLessThan(tailed.lastIndexOf('update.done.tmp'))
    }
    expect(launcherScript("/tmp/open-walnut-update.a'b")).toContain(`d='/tmp/open-walnut-update.a'\\''b'`)
  })
})

/**
 * The runner's tail on a "Mac" (the stand-ins of tests/helpers/service-stubs.ts: uname says
 * Darwin, launchctl keeps one job in the case's state dir, a load of a plist naming a "good"
 * executable starts a stand-in daemon, a "bad" one starts nothing). 2026-11-04: an update
 * stopped the old daemon and the new job never got loaded, and the runner only wrote its done line.
 */
describe('the runner\'s tail after the update', () => {
  let stubs: ServiceStubs
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })
  afterEach(() => stubs.stop())

  const plistFor = (exe: string) => renderDaemonLaunchAgent({
    platform: 'darwin', home, executable: exe, args: ['--service'], runtimeDir: stubs.runtime, stateDir: daemonInstallRoot('darwin', home), path: '/usr/bin:/bin',
  })
  const config = () => path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
  function installed(exe: string): string {
    fs.mkdirSync(path.dirname(config()), { recursive: true })
    fs.mkdirSync(daemonInstallRoot('darwin', home), { recursive: true })
    fs.writeFileSync(config(), plistFor(exe), { mode: 0o600 })
    return config()
  }
  const FAST_TAIL = { tail: { waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0 } }

  it('loads a job the update answered ok for and left unloaded, and the update counts as applied', async () => {
    // The old job runs when the runner copies the config aside; the update boots it out and never loads the new one.
    stubs.setLoaded(true, installed('/opt/walnut/versions/good-new/open-walnut-daemon'))
    const host = miniHost({ path: guardedPath([stubs.bin]) })
    const binary = fakeDaemon({ onUpdate: [`rm -f '${stubs.state}/job'`] })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast(FAST_TAIL)), 'user')).resolves.toBe('applied')
    expect(stubs.calls()).toContain(`launchctl bootstrap gui/${process.getuid!()} ${config()}`)
    expect(stubs.daemonUp()).toBe(true)
  }, 60_000)

  it('puts the previous plist back when the new daemon never answers, the previous one serves, and the update fails with why', async () => {
    const before = fs.readFileSync(installed('/opt/walnut/versions/good-previous/open-walnut-daemon'), 'utf8')
    stubs.setLoaded(true, config())
    // The update writes the new plist and launchd runs it; its executable never answers.
    const next = path.join(work, 'next.plist')
    fs.writeFileSync(next, plistFor('/opt/walnut/versions/bad-new/open-walnut-daemon'))
    const binary = fakeDaemon({ onUpdate: [`cp '${next}' '${config()}'`, `echo '${config()}' > '${stubs.state}/job'`] })
    const host = miniHost({ path: guardedPath([stubs.bin]) })
    const err = await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast(FAST_TAIL)), 'user').then(() => null, (e: unknown) => e)
    expect(String(err)).toContain('the update answered ok, but afterwards on the host: no daemon answered within 2 s, so the previous service config was put back, and its daemon answers')
    expect(fs.readFileSync(config(), 'utf8')).toBe(before)
    expect(stubs.daemonUp()).toBe(true)
    // Not applied: only the chunk dir stays, for the next try.
    expect(left()).toHaveLength(1)
    expect(left()[0]).toMatch(CHUNK_DIR)
  }, 60_000)
})

