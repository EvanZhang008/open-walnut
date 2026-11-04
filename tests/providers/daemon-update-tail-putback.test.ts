/**
 * The tail's put-back and its checks (src/providers/daemon-update-tail.ts), run for real in /bin/sh
 * against the init system stand-ins (tests/helpers/service-stubs.ts), for what the 2026-11-04
 * review 5 found:
 *   - a put-back took the daemon it had just booted out (still finishing its work) for the
 *     restored one, and loaded no job;
 *   - one spawn probe that launchd answered late stood the put-back down;
 *   - a cron put-back reloaded nothing;
 *   - a pid file the next process reused read as a daemon serving;
 *   - the install lock outlived a tail that was killed, and a lock from before a reboot held;
 *   - the revive had no way back when the update's own dir was lost (a power loss).
 *
 * MACHINE SAFETY: HOME, the configs, the runtime dir and the record dir are under this file's
 * temp dir; launchctl, systemctl and uname are the stubs (PATH has nothing else first); the
 * only processes are /bin/sh, the stubs' `sleep`s and the fake supervisor here, all stopped.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonInstallRoot, renderDaemonLaunchAgent, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { parseUpdateTail, reviveScript, updateSnapshotScript, updateTailScript, type UpdateTailOptions } from '../../src/providers/daemon-update-tail.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { guardedPath } from '../setup/exec-guard.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-putback-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let record: string
let stubs: ServiceStubs | null = null
const extraPids: number[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  record = path.join(work, 'record')
  fs.mkdirSync(home)
  fs.mkdirSync(record)
})
// Cases here run /bin/sh synchronously for seconds: the event loop is let run between them (vitest's own worker calls time out at 60 s).
afterEach(async () => {
  for (const pid of extraPids.splice(0)) if (pid > 1) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  stubs?.stop(); stubs = null
  await new Promise((r) => setTimeout(r, 0))
})

const GOOD_PREVIOUS = '/opt/walnut/versions/good-previous/open-walnut-daemon'
const GOOD_NEW = '/opt/walnut/versions/good-new/open-walnut-daemon'
const BAD_NEW = '/opt/walnut/versions/bad-new/open-walnut-daemon'
const FAST: Omit<UpdateTailOptions, 'scope'> = { waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0 }
const uid = process.getuid!()

function sh(script: string, timeout = 90_000): string {
  const out = spawnSync('/bin/sh', ['-c', script], { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout })
  if (out.status !== 0) throw new Error(`sh exited ${out.status}: ${out.stderr}`)
  return out.stdout
}

function install(platform: 'darwin' | 'linux', exe: string): { config: string; owners: string } {
  const stateDir = daemonInstallRoot(platform, home)
  fs.mkdirSync(stateDir, { recursive: true })
  const config = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    : path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const c = { platform, home, executable: exe, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }
  fs.writeFileSync(config, platform === 'darwin' ? renderDaemonLaunchAgent(c) : renderDaemonSystemdUnit(c, 'user'), { mode: 0o600 })
  const owners = path.join(stateDir, 'service-configs.json')
  fs.writeFileSync(owners, `{"${config}":"${exe.includes('previous') ? 'a'.repeat(64) : 'b'.repeat(64)}"}\n`, { mode: 0o600 })
  return { config, owners }
}

const pidFile = () => path.join(stubs!.runtime, 'daemon.pid')
const readPid = () => Number(fs.readFileSync(pidFile(), 'utf8').trim())

describe('a LaunchAgent put-back', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })

  // Review 5, finding 1: the booted-out daemon finishes its work (up to the job's ExitTimeOut)
  // before it exits; the put-back took it for the restored one, so no job was loaded once it went.
  it('waits for the job it booted out, never takes that daemon for the restored one, and loads the previous job', async () => {
    const before = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    // The update loaded the new job, and its daemon serves.
    install('darwin', GOOD_NEW)
    stubs!.startDaemon(GOOD_NEW)
    // A second on, launchd started it again (KeepAlive after a crash): another pid serves, the job's.
    const st = stubs!.state, rt = stubs!.runtime
    spawn('/bin/sh', ['-c', `sleep 1; sleep 300 </dev/null >/dev/null 2>&1 & echo $! > '${rt}/daemon.pid'; echo $! > '${st}/jobpid'; echo $! >> '${st}/pids'`], { detached: true, stdio: 'ignore' }).unref()
    // A bootout returns at once; its process finishes for 6 s more, and launchd lists the job till then.
    stubs!.setBootoutLinger(6)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', waitSeconds: 14, goneSeconds: 2, staySeconds: 3, probationSeconds: 0 })))
    expect(tail).toEqual({ outcome: 'restored', words: 'the new daemon answered and then did not stay serving for 3 s, so the previous service config was put back, and its daemon answers' })
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousPlist)
    // Long after the booted-out process is gone: the previous job is loaded, and its daemon serves.
    await vi.waitFor(() => expect(fs.existsSync(path.join(st, 'lingering'))).toBe(false), { timeout: 15_000 })
    await new Promise((r) => setTimeout(r, 500))
    expect(fs.readFileSync(path.join(st, 'job'), 'utf8').trim()).toBe(before.config)
    expect(stubs!.daemonUp()).toBe(true)
    expect(stubs!.calls()).toContain(`launchctl bootstrap gui/${uid} ${before.config}`)
  }, 90_000)

  // Review 5, finding 2: a new job crash looping read idle, and one spawn probe that launchd answered
  // after its 5 s read "none": nothing was put back, and the stand-in ran the broken new build.
  it('a new build that crashes at once is put back, however slowly launchd runs the spawn probe (it ran the job: runs = 1)', () => {
    const before = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const { config } = install('darwin', '/opt/walnut/versions/crash-new/open-walnut-daemon')
    sh(`launchctl bootout gui/${uid}/dev.openwalnut.session-daemon; launchctl bootstrap gui/${uid} '${config}'`)
    expect(sh(`launchctl print gui/${uid}/dev.openwalnut.session-daemon`)).toMatch(/state = not running[\s\S]*runs = 1/)
    stubs!.setProbeDelay(7)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST, standInCheckSeconds: 1 })))
    expect(tail).toEqual({ outcome: 'restored', words: 'no daemon answered within 2 s, so the previous service config was put back, and its daemon answers' })
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousPlist)
    expect(stubs!.daemonUp()).toBe(true)
    // No stand-in: launchd starts jobs.
    expect(fs.existsSync(path.join(stubs!.runtime, 'daemon.standin'))).toBe(false)
  }, 90_000)

  /** A daemon program that runs here (as the stand-in starts it): it serves the dir, and writes down which build it is. */
  function program(name: string): string {
    const exe = path.join(work, name, 'open-walnut-daemon')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, [
      '#!/bin/sh',
      '[ "$1" = walnut ] && exit 2',
      'h=$(cat "$WALNUT_DAEMON_DIR/daemon.pid" 2>/dev/null)',
      'if [ -n "$h" ] && [ "$h" != $$ ] && kill -0 "$h" 2>/dev/null; then exit 1; fi',
      `echo $$ >> '${stubs!.state}/pids'`, 'echo $$ > "$WALNUT_DAEMON_DIR/daemon.pid"', 'echo 40998 > "$WALNUT_DAEMON_DIR/daemon.port"',
      `echo ${name} > '${work}/standin-who'`, 'exec sleep 300', '',
    ].join('\n'), { mode: 0o755 })
    return exe
  }

  // Review 5, finding 2: in a dark wake the new build never ran, and the stand-in ran it all the same
  // (it may be the broken one); the config from before goes back first, and its build stands in.
  it('in a dark wake after an update, the previous config goes back first, and the stand-in runs the build that served before', async () => {
    const previous = program('good-previous')
    const before = install('darwin', previous)
    const previousPlist = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    stubs!.startDaemon(previous)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const { config } = install('darwin', program('good-new'))
    stubs!.setSpawning(false)
    // The update: the old job booted out, the new one loaded and never run.
    sh(`launchctl bootout gui/${uid}/dev.openwalnut.session-daemon; launchctl bootstrap gui/${uid} '${config}'`)
    const tail = parseUpdateTail(sh(`L='${path.join(work, 'latest')}'\n${updateTailScript(record, { scope: 'user', ...FAST, probeSeconds: 1, standInCheckSeconds: 1 })}`))
    expect(tail).toEqual({ outcome: 'standin', words: "launchd starts no jobs in this login session now (a dark wake, or a login not finished), so the new daemon never ran: the previous service config was put back, and its daemon runs outside launchd until launchd starts jobs, and launchd's job takes over then" })
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousPlist)
    // launchd has the previous job loaded for when it starts jobs.
    expect(fs.readFileSync(path.join(stubs!.state, 'job'), 'utf8').trim()).toBe(before.config)
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: 10_000 })
    expect(fs.readFileSync(path.join(work, 'standin-who'), 'utf8').trim()).toBe('good-previous')
  }, 60_000)

  // Review 5, finding 10: t_up trusted any live pid, so a daemon that died left its pid file, and
  // whatever process got that pid next read as the daemon serving.
  it('a pid file naming a process that started after it was written is no daemon serving', () => {
    const { config } = install('darwin', GOOD_NEW)
    stubs!.setLoaded(true, config)
    // A process of another kind under the pid the dead daemon wrote an hour ago.
    const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    extraPids.push(other.pid!)
    fs.writeFileSync(pidFile(), `${other.pid}\n`)
    fs.writeFileSync(path.join(stubs!.runtime, 'daemon.port'), '40999\n')
    const hourAgo = new Date(Date.now() - 3600_000)
    fs.utimesSync(pidFile(), hourAgo, hourAgo)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))
    expect(tail?.outcome).not.toBe('serving')
  }, 60_000)
})

describe('the install lock', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })
  const lockOf = () => path.join(daemonInstallRoot('linux', home), 'service-configs.json.lock')

  // Review 5, finding 10: the tail held the lock with no trap, so a tail that was killed left it.
  it('a tail that is killed while it holds the lock lets go of it', async () => {
    const { config } = install('linux', BAD_NEW)
    stubs!.setLoaded(true, config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const tail = spawn('/bin/sh', ['-c', updateTailScript(record, { scope: 'user', ...FAST, waitSeconds: 30 })], { env: { HOME: home, ...stubs!.env }, stdio: 'ignore' })
    extraPids.push(tail.pid!)
    await vi.waitFor(() => expect(fs.existsSync(path.join(lockOf(), 'pid'))).toBe(true), { timeout: 10_000 })
    expect(fs.readFileSync(path.join(lockOf(), 'pid'), 'utf8').trim()).toBe(String(tail.pid))
    tail.kill('SIGTERM')
    await vi.waitFor(() => expect(fs.existsSync(lockOf())).toBe(false), { timeout: 10_000 })
  }, 60_000)

  // Review 5, finding 10: a lock a power loss left, whose pid a process after the boot got, held the
  // snapshot and every `walnut daemon` off for as long as that process lived.
  it('a lock written before this boot is taken over, whatever process has its pid now', () => {
    install('linux', GOOD_NEW)
    fs.mkdirSync(lockOf())
    fs.writeFileSync(path.join(lockOf(), 'pid'), `${process.pid}\n`)
    const boot = Date.now() - os.uptime() * 1000
    const longBefore = new Date(boot - 3600_000)
    fs.utimesSync(path.join(lockOf(), 'pid'), longBefore, longBefore)
    sh(updateSnapshotScript(record, { scope: 'user', lockWaitSeconds: 20 }))
    // Taken, and let go of after the snapshot: no lock is left, and the snapshot ran under it.
    expect(fs.existsSync(lockOf())).toBe(false)
    expect(fs.existsSync(path.join(record, 'before.cfg'))).toBe(true)
  }, 60_000)

  it('the Node locker takes over such a lock too, and still waits for one written in this boot', async () => {
    const { withFileLock } = await import('../../src/utils/file-lock.js')
    install('linux', GOOD_NEW)
    const owners = path.join(daemonInstallRoot('linux', home), 'service-configs.json')
    fs.mkdirSync(lockOf())
    fs.writeFileSync(path.join(lockOf(), 'pid'), `${process.pid}\n`)
    await expect(withFileLock(owners, async () => 'got it', { timeoutMs: 1_000 })).rejects.toThrow(/lock/i)
    const boot = Date.now() - os.uptime() * 1000
    const longBefore = new Date(boot - 3600_000)
    fs.utimesSync(path.join(lockOf(), 'pid'), longBefore, longBefore)
    await expect(withFileLock(owners, async () => 'got it', { timeoutMs: 3_000 })).resolves.toBe('got it')
  }, 30_000)
})

describe('a cron put-back', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })

  /**
   * A boot script as the supervisor runs it: its pid, the daemon of its build as its own child (one
   * that writes no port file never answers), and when that child exits, the script read again.
   */
  function bootScript(answers: boolean): string {
    const stateDir = daemonInstallRoot('linux', home)
    const rt = stubs!.runtime, st = stubs!.state
    return [
      '#!/bin/sh',
      `export WALNUT_DAEMON_DIR='${rt}'`,
      `echo $$ > '${stateDir}/daemon-boot.pid'`,
      `echo $$ >> '${st}/pids'`,
      `n=$(cat '${st}/boots' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${st}/boots'; [ "$n" -gt 4 ] && exit 0`,
      `sh -c 'echo $$ > "$1/daemon.pid"; ${answers ? 'echo 40999 > "$1/daemon.port"; ' : 'rm -f "$1/daemon.port"; '}exec sleep 300' sh '${rt}' </dev/null >/dev/null 2>&1 &`,
      'c=$!',
      `echo $c >> '${st}/pids'`,
      'wait $c',
      'exec /bin/sh "$0"',
      '',
    ].join('\n')
  }

  // Review 5, finding 10: the cron put-back wrote the previous boot script and reloaded nothing, so
  // the daemon of the new one kept running.
  it('puts the previous boot script back and has the supervisor run it: its own child is asked to exit', () => {
    const stateDir = daemonInstallRoot('linux', home)
    fs.mkdirSync(stateDir, { recursive: true })
    const script = path.join(stateDir, 'daemon-boot.sh')
    fs.writeFileSync(script, bootScript(true), { mode: 0o700 })
    const previous = fs.readFileSync(script, 'utf8')
    // The supervisor ran it before the update.
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: { PATH: guardedPath([], '/usr/bin:/bin') } }).unref()
    const ready = Date.now() + 5_000
    while (!stubs!.daemonUp() && Date.now() < ready) spawnSync('sleep', ['0.1'])
    expect(stubs!.daemonUp()).toBe(true)
    sh(updateSnapshotScript(record, { scope: 'cron' }))
    // The update wrote the new script; the supervisor restarted its daemon, which never answers.
    fs.writeFileSync(script, bootScript(false), { mode: 0o700 })
    spawnSync('/bin/sh', ['-c', `kill $(cat '${pidFile()}')`])
    const gone = Date.now() + 5_000
    while (stubs!.daemonUp() && Date.now() < gone) spawnSync('sleep', ['0.1'])
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'cron', ...FAST, waitSeconds: 6 })))
    expect(tail).toEqual({ outcome: 'restored', words: 'no daemon answered within 6 s, so the previous service config was put back, and its daemon answers' })
    expect(fs.readFileSync(script, 'utf8')).toBe(previous)
    expect(stubs!.daemonUp()).toBe(true)
  }, 60_000)
})

describe('the revive, after a power loss in the middle of an update', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })

  // Review 5, finding 6: the update's copies lived in /tmp only, so a power loss between the new
  // config and the tail's verdict left nothing to go back to, and the revive loaded the new one again.
  it('puts the copies the snapshot kept in the install root back when the config on disk does not serve, and holds that build', () => {
    const before = install('linux', GOOD_PREVIOUS)
    const previousUnit = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    stubs!.startDaemon(GOOD_PREVIOUS)
    sh(`tvb=walnut-daemon-bad00001\n${updateSnapshotScript(record, { scope: 'user' })}`)
    install('linux', BAD_NEW)
    // The power went: /tmp (the update's dir) is empty after the boot, and no daemon runs.
    fs.rmSync(record, { recursive: true, force: true })
    stubs!.stop()
    stubs!.setLoaded(false)
    fs.rmSync(pidFile(), { force: true })
    const revived = parseUpdateTail(sh(reviveScript({ scope: 'user', waitSeconds: 3, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, latest: path.join(work, 'latest') })))
    expect(revived?.outcome).toBe('restored')
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousUnit)
    expect(stubs!.daemonUp()).toBe(true)
    const root = daemonInstallRoot('linux', home)
    // The build is written down for the next runner of it, and the copies are done with.
    expect(fs.readFileSync(path.join(root, 'update-probation.failed'), 'utf8').split('\n')[0]).toBe('walnut-daemon-bad00001')
    expect(fs.existsSync(path.join(root, 'update-before'))).toBe(false)
  }, 60_000)

  it('a config that serves and stays keeps itself, and no build is written down', () => {
    const before = install('linux', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    stubs!.startDaemon(GOOD_PREVIOUS)
    sh(`tvb=walnut-daemon-good0001\n${updateSnapshotScript(record, { scope: 'user' })}`)
    install('linux', GOOD_NEW)
    const newUnit = fs.readFileSync(before.config, 'utf8')
    fs.rmSync(record, { recursive: true, force: true })
    stubs!.stop()
    stubs!.setLoaded(false)
    fs.rmSync(pidFile(), { force: true })
    const revived = parseUpdateTail(sh(reviveScript({ scope: 'user', waitSeconds: 3, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, latest: path.join(work, 'latest') })))
    expect(revived?.outcome).toBe('loaded')
    expect(fs.readFileSync(before.config, 'utf8')).toBe(newUnit)
    expect(fs.existsSync(path.join(daemonInstallRoot('linux', home), 'update-probation.failed'))).toBe(false)
  }, 60_000)
})
