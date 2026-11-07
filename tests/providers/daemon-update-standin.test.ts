/**
 * A LaunchAgent update whose launchd starts no jobs (src/providers/daemon-update-tail.ts and its
 * stand-in, src/providers/daemon-update-standin.ts), and the spawn probe that tells
 * (src/providers/daemon-service-launchd.ts), run for real in /bin/sh against the launchd stand-in
 * (tests/helpers/service-stubs.ts): the service's own daemon runs outside launchd until launchd
 * starts jobs, then hands back through `walnut daemon handback`; one loop per runtime dir; each
 * probe its own job.
 *
 * MACHINE SAFETY: HOME, the configs, the runtime dir and the record dir are under this file's
 * temp dir; launchctl and uname are the stubs (PATH has nothing else first); the probe's own
 * /tmp/walnut-spawn-probe.<id> dirs are made and removed by it; the only processes are /bin/sh,
 * the stand-in loop and the stubs' `sleep`s, stopped after each case.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchdSpawnProbeLines, launchdSpawnsJobs } from '../../src/providers/daemon-service-launchd.js'
import { daemonInstallRoot, renderDaemonLaunchAgent, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { parseUpdateTail, updateSnapshotScript, updateTailScript, type UpdateTailOptions } from '../../src/providers/daemon-update-tail.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { fakeUpdateRunner } from '../helpers/fake-update-runner.js'
import { standInStartLines } from '../../src/providers/daemon-update-standin.js'

// Each wait is for a process to start, stop or be started again, which a full test run on a
// host at load 100 and more stretched past 10 s (2026-11-07); a wait ends as soon as it holds.
const UP_MS = 40_000

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-standin-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let record: string
let stubs: ServiceStubs | null = null
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  record = path.join(work, 'record')
  fs.mkdirSync(home)
  fs.mkdirSync(record)
})
afterEach(() => { stubs?.stop(); stubs = null })

const GOOD_PREVIOUS = '/opt/walnut/versions/good-previous/open-walnut-daemon'
const FAST: Omit<UpdateTailOptions, 'scope'> = { waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, probeSeconds: 2 }

function sh(script: string): string {
  const out = spawnSync('/bin/sh', ['-c', script], { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout: 60_000 })
  if (out.status !== 0) throw new Error(`sh exited ${out.status}: ${out.stderr}`)
  return out.stdout
}

/** A LaunchAgent (or a user unit) for `exe`, and the ownership record that names it as Walnut's. */
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

describe('a LaunchAgent update in a dark wake (launchd loads jobs and starts none)', () => {
  // 2026-11-04: "pending spawn, domain in on-demand-only mode" for the new job and the restored one;
  // the Mac had no daemon until a reboot and login 1 h 45 min later.
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })

  /**
   * A LaunchAgent whose program is a real stand-in daemon here: it writes its pid and port and stays.
   * `walnut daemon handback` (daemon-service-handback.ts, which has tests of its own) is played by
   * the same program: refused while launchd has no job loaded or `handback-busy` is there, else the
   * stand-in exits and launchd's job is kickstarted, as the real one does through the service.update RPC.
   */
  function installRunnable(): { config: string; exe: string } {
    const exe = path.join(work, 'good-new', 'open-walnut-daemon')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    const rt = stubs!.runtime
    fs.writeFileSync(exe, [
      '#!/bin/sh',
      'if [ "$1" = walnut ]; then',
      `  echo "$*" >> '${work}/handback-calls'`,
      `  launchctl print "gui/$(id -u)/dev.openwalnut.session-daemon" >/dev/null 2>&1 || { echo '{"ok": false, "failure": {"code": "notLoaded", "message": "handback deferred"}}'; exit 1; }`,
      `  if [ -f '${work}/handback-busy' ]; then echo '{"ok": false, "failure": {"code": "updateRefused", "message": "the stand-in keeps serving: 1 ACP turn must finish first"}}'; exit 1; fi`,
      `  sp=$(cat '${rt}/daemon.standin'); kill "$sp"; while kill -0 "$sp" 2>/dev/null; do sleep 0.1; done`,
      '  launchctl kickstart "gui/$(id -u)/dev.openwalnut.session-daemon"',
      `  rm -f '${rt}/daemon.standin'; echo '{"ok": true}'; exit 0`,
      'fi',
      // The instance lock, as a real daemon has it: another daemon serving the dir means this one exits.
      'h=$(cat "$WALNUT_DAEMON_DIR/daemon.pid" 2>/dev/null)',
      `if [ -n "$h" ] && [ "$h" != $$ ] && kill -0 "$h" 2>/dev/null; then echo "$h" >> '${work}/standin-refusals'; exit 1; fi`,
      `echo $$ >> '${stubs!.state}/pids'`, 'echo $$ > "$WALNUT_DAEMON_DIR/daemon.pid"', 'echo 40998 > "$WALNUT_DAEMON_DIR/daemon.port"', `env > '${work}/standin-env'`, 'exec sleep 300', '',
    ].join('\n'), { mode: 0o755 })
    const stateDir = daemonInstallRoot('darwin', home)
    fs.mkdirSync(stateDir, { recursive: true })
    const config = path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, renderDaemonLaunchAgent({ platform: 'darwin', home, executable: exe, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }), { mode: 0o600 })
    return { config, exe }
  }
  /** The runners' latest marker of this case, not the account's own (the tail hands it to the stand-in). */
  const marker = () => path.join(work, 'latest')
  const withMarker = (script: string) => `L='${marker()}'\n${script}`
  const pidOf = () => Number(fs.readFileSync(path.join(stubs!.runtime, 'daemon.pid'), 'utf8').trim())
  const alive = (pid: number) => { try { return process.kill(pid, 0) } catch { return false } }
  const standInFile = () => path.join(stubs!.runtime, 'daemon.standin')
  const lines = (name: string) => (fs.existsSync(path.join(work, name)) ? fs.readFileSync(path.join(work, name), 'utf8').trim().split('\n') : [])
  const handbacks = () => lines('handback-calls')

  /** The update left the new job loaded and never started; the tail then runs. */
  function darkWakeUpdate(): { config: string; tail: ReturnType<typeof parseUpdateTail> } {
    const before = install('darwin', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    stubs!.startDaemon(GOOD_PREVIOUS)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const { config } = installRunnable()
    stubs!.setSpawning(false)
    sh(`launchctl bootout "gui/$(id -u)/dev.openwalnut.session-daemon"; launchctl bootstrap "gui/$(id -u)" '${config}'`)
    expect(stubs!.daemonUp()).toBe(false)
    return { config, tail: parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...FAST, standInCheckSeconds: 1 })))) }
  }

  it('runs the service\'s own daemon outside launchd until launchd starts jobs again, then hands back to launchd\'s job, never two at once', async () => {
    const { config, tail } = darkWakeUpdate()
    expect(tail).toEqual({ outcome: 'standin', words: "launchd starts no jobs in this login session now (a dark wake, or a login not finished), so the service's daemon runs outside launchd until it does, and launchd's job takes over then" })
    // No put-back: launchd starting nothing says nothing about the build.
    expect(fs.readFileSync(config, 'utf8')).toContain('good-new')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const standIn = pidOf()
    expect(fs.readFileSync(standInFile(), 'utf8').trim()).toBe(String(standIn))
    // As launchd starts it: the plist's own env, nothing of the tail's.
    const env = fs.readFileSync(path.join(work, 'standin-env'), 'utf8')
    expect(env).toContain(`WALNUT_DAEMON_DIR=${stubs!.runtime}`)
    expect(env).toMatch(/^PATH=\/usr\/bin:\/bin$/m)
    expect(env).not.toContain('stub-bin')
    // While launchd starts nothing, nobody is asked to hand back.
    await new Promise((r) => setTimeout(r, 2_500))
    expect(handbacks()).toEqual([])
    expect(alive(standIn)).toBe(true)

    // A full wake: launchd starts jobs again. The stand-in hands back (never a signal from the
    // loop: 2026-11-04 review), and launchd's job is started.
    stubs!.setSpawning(true)
    await vi.waitFor(() => {
      expect(alive(standIn)).toBe(false)
      expect(stubs!.daemonUp()).toBe(true)
      expect(pidOf()).not.toBe(standIn)
    }, { timeout: 30_000, interval: 200 })
    expect(handbacks()).toEqual(['walnut daemon handback --yes --scope user'])
    expect(stubs!.calls()).toContain(`launchctl kickstart gui/${process.getuid!()}/dev.openwalnut.session-daemon`)
    await vi.waitFor(() => expect(fs.existsSync(standInFile())).toBe(false), { timeout: UP_MS })
    await vi.waitFor(() => expect(fs.existsSync(path.join(stubs!.runtime, '.standin-loop'))).toBe(false), { timeout: UP_MS })
    // launchd started its pending job when it resumed; that daemon waited behind the stand-in, and nobody was refused the dir.
    expect(pidOf()).toBe(Number(fs.readFileSync(path.join(stubs!.state, 'jobpid'), 'utf8').trim()))
    expect(stubs!.lockRefusals()).toEqual([])
    expect(lines('standin-refusals')).toEqual([])
  }, 150_000)

  // 2026-11-04 review: the stand-in starts after the rollback put the previous plist back, so both
  // CLIs it asked were the previous build; one without `handback` answered nothing, and the
  // stand-in served outside launchd until logout. The update's own build is staged in the install root.
  it('after a rollback (the previous build, with no handback, in the plist), the staged new build hands back, and launchd\'s job takes over', async () => {
    const tb = daemonInstallRoot('darwin', home)
    const previous = path.join(work, 'good-previous', 'open-walnut-daemon')
    fs.mkdirSync(path.dirname(previous), { recursive: true })
    const rt = stubs!.runtime
    fs.writeFileSync(previous, [
      '#!/bin/sh',
      // An older build: no `daemon handback` action, so no JSON.
      `if [ "$1" = walnut ]; then echo "$*" >> '${work}/previous-walnut-calls'; echo 'Expected daemon status, install, update, uninstall, or restart' >&2; exit 2; fi`,
      'h=$(cat "$WALNUT_DAEMON_DIR/daemon.pid" 2>/dev/null)',
      `if [ -n "$h" ] && [ "$h" != $$ ] && kill -0 "$h" 2>/dev/null; then echo "$h" >> '${work}/standin-refusals'; exit 1; fi`,
      `echo $$ >> '${stubs!.state}/pids'`, 'echo $$ > "$WALNUT_DAEMON_DIR/daemon.pid"', 'echo 40998 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 300', '',
    ].join('\n'), { mode: 0o755 })
    const staged = path.join(tb, 'versions', 'a'.repeat(64), 'daemon')
    fs.mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 })
    fs.writeFileSync(staged, [
      '#!/bin/sh',
      '[ "$1" = walnut ] || exit 1',
      `echo "$*" >> '${work}/handback-calls'`,
      `sp=$(cat '${rt}/daemon.standin'); kill "$sp"; while kill -0 "$sp" 2>/dev/null; do sleep 0.1; done`,
      '  launchctl kickstart "gui/$(id -u)/dev.openwalnut.session-daemon"',
      `rm -f '${rt}/daemon.standin'; echo '{"ok": true}'; exit 0`, '',
    ].join('\n'), { mode: 0o755 })
    const config = path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, renderDaemonLaunchAgent({ platform: 'darwin', home, executable: previous, args: ['--service'], runtimeDir: rt, stateDir: tb, path: '/usr/bin:/bin' }), { mode: 0o600 })
    // The snapshot took the previous plist; the update wrote the new one, failed and put the
    // previous one back; launchd (a dark wake) loaded it and ran nothing.
    stubs!.setLoaded(true, config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    stubs!.setSpawning(false)
    stubs!.setLoaded(true, config, true)
    const tail = parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...FAST, standInCheckSeconds: 1 }))))
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const standIn = pidOf()
    expect(fs.readFileSync(standInFile(), 'utf8').trim()).toBe(String(standIn))
    // launchd starts jobs again, and starts the pending job: its daemon waits behind the stand-in.
    stubs!.setSpawning(true)
    await vi.waitFor(() => {
      expect(alive(standIn)).toBe(false)
      expect(stubs!.daemonUp()).toBe(true)
      expect(pidOf()).not.toBe(standIn)
    }, { timeout: 30_000, interval: 200 })
    // The previous build was asked first and had no answer; the staged one handed back, once.
    expect(lines('previous-walnut-calls').length).toBeGreaterThanOrEqual(1)
    expect(handbacks()).toEqual(['walnut daemon handback --yes --scope user'])
    expect(pidOf()).toBe(Number(fs.readFileSync(path.join(stubs!.state, 'jobpid'), 'utf8').trim()))
    await vi.waitFor(() => expect(fs.existsSync(path.join(rt, '.standin-loop'))).toBe(false), { timeout: UP_MS })
    // Never two at once: no start found another daemon serving the dir.
    expect(stubs!.lockRefusals()).toEqual([])
    expect(lines('standin-refusals')).toEqual([])
  }, 150_000)

  it('a stand-in with work open refuses the handback and keeps serving; it is asked again later', async () => {
    fs.writeFileSync(path.join(work, 'handback-busy'), '')
    const { tail } = darkWakeUpdate()
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const standIn = pidOf()
    stubs!.setSpawning(true)
    await vi.waitFor(() => expect(handbacks().length).toBeGreaterThanOrEqual(2), { timeout: UP_MS, interval: 200 })
    expect(alive(standIn)).toBe(true)
    expect(pidOf()).toBe(standIn)
    fs.rmSync(path.join(work, 'handback-busy'))
    await vi.waitFor(() => {
      expect(alive(standIn)).toBe(false)
      expect(stubs!.daemonUp()).toBe(true)
    }, { timeout: UP_MS, interval: 200 })
  }, 150_000)

  it('a stand-in that exits on its own is started again while launchd starts nothing, and there is one loop per runtime dir', async () => {
    const { tail } = darkWakeUpdate()
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const first = pidOf()
    // A second start of the loop (another tail, a revive) finds the first one at work and leaves.
    const script = path.join(daemonInstallRoot('darwin', home), 'daemon-standin.sh')
    const again = spawnSync('/bin/sh', [script, stubs!.runtime], { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout: UP_MS })
    expect(again.status).toBe(0)
    expect(pidOf()).toBe(first)
    process.kill(first, 'SIGTERM')
    await vi.waitFor(() => {
      expect(stubs!.daemonUp()).toBe(true)
      expect(pidOf()).not.toBe(first)
    }, { timeout: UP_MS, interval: 200 })
    expect(fs.readFileSync(standInFile(), 'utf8').trim()).toBe(String(pidOf()))
  }, 150_000)

  // 2026-11-04 review: a loop killed with the Mac (a power loss, a SIGKILL) left its pid in
  // .standin-loop/pid, and while any process had that pid every later stand-in exited at once.
  it('a loop pid that another process has now (a loop killed with the Mac) does not keep the stand-in from starting', async () => {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      fs.mkdirSync(path.join(stubs!.runtime, '.standin-loop'), { recursive: true })
      fs.writeFileSync(path.join(stubs!.runtime, '.standin-loop', 'pid'), `${other.pid}\n`)
      const { tail } = darkWakeUpdate()
      expect(tail?.outcome).toBe('standin')
      await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
      expect(fs.readFileSync(path.join(stubs!.runtime, '.standin-loop', 'pid'), 'utf8').trim()).not.toBe(String(other.pid))
    } finally { other.kill() }
  }, 150_000)

  it('a stand-in an update stopped is not started again while that update\'s runner is at work; its tail decides', async () => {
    const { tail } = darkWakeUpdate()
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const first = pidOf()
    // A later update's runner is at work and stops the stand-in.
    const runner = fakeUpdateRunner('alive', marker())
    try {
      process.kill(first, 'SIGTERM')
      await new Promise((r) => setTimeout(r, 3_000))
      expect(stubs!.daemonUp()).toBe(false)
      // Its runner done: the loop takes over again.
      fs.writeFileSync(path.join(runner.dir, 'update.done'), 'rc=0 tries=1 tail=down\n')
      await vi.waitFor(() => {
        expect(stubs!.daemonUp()).toBe(true)
        expect(pidOf()).not.toBe(first)
      }, { timeout: UP_MS, interval: 200 })
    } finally { runner.stop() }
  }, 150_000)

  // 2026-11-04 review: the tail of that runner then asks for a stand-in, and the loop already at
  // work (its stand-in stopped) both kept the new one from starting and skipped it while that
  // runner was still at work: the host had no daemon until the runner's record was written.
  it('a tail that wants a stand-in while its own runner is still at work gets one from the loop already at work', async () => {
    const { tail } = darkWakeUpdate()
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const first = pidOf()
    const runner = fakeUpdateRunner('alive', marker())
    try {
      process.kill(first, 'SIGTERM')
      await new Promise((r) => setTimeout(r, 2_500))
      expect(stubs!.daemonUp()).toBe(false)
      // The runner's own tail (its update.done not written yet) starts a stand-in: t_standin.
      const tb = daemonInstallRoot('darwin', home)
      sh(`tb='${tb}'; tr='${stubs!.runtime}'; tsx0=; L='${marker()}'\n${standInStartLines(1).join('\n')}\nt_standin`)
      await vi.waitFor(() => {
        expect(stubs!.daemonUp()).toBe(true)
        expect(pidOf()).not.toBe(first)
      }, { timeout: UP_MS, interval: 200 })
    } finally { runner.stop() }
  }, 150_000)

  // 2026-11-04 review: the loop restarted its stand-in in the middle of a `walnut daemon` transaction (an uninstall, an update from a terminal).
  it('a stand-in that exits is not started again while a `walnut daemon` transaction holds the install lock', async () => {
    const { tail } = darkWakeUpdate()
    expect(tail?.outcome).toBe('standin')
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const first = pidOf()
    const lock = path.join(daemonInstallRoot('darwin', home), 'service-configs.json.lock')
    fs.mkdirSync(lock)
    try {
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
      process.kill(first, 'SIGTERM')
      await new Promise((r) => setTimeout(r, 3_000))
      expect(stubs!.daemonUp()).toBe(false)
    } finally { fs.rmSync(lock, { recursive: true, force: true }) }
    await vi.waitFor(() => {
      expect(stubs!.daemonUp()).toBe(true)
      expect(pidOf()).not.toBe(first)
    }, { timeout: UP_MS, interval: 200 })
  }, 150_000)

  // 2026-11-04 review: a stand-in that dies at once was started again every tick, for good.
  it('a stand-in that exits at once is started again less and less often', async () => {
    const exe = path.join(work, 'crashes', 'open-walnut-daemon')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, ['#!/bin/sh', `echo start >> '${work}/starts'`, 'exit 3', ''].join('\n'), { mode: 0o755 })
    const stateDir = daemonInstallRoot('darwin', home)
    fs.mkdirSync(stateDir, { recursive: true })
    const config = path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, renderDaemonLaunchAgent({ platform: 'darwin', home, executable: exe, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }), { mode: 0o600 })
    stubs!.setSpawning(false)
    sh(`tb='${stateDir}'; tr='${stubs!.runtime}'; tsx0=; L='${marker()}'\n${standInStartLines(1).join('\n')}\nt_standin`)
    await new Promise((r) => setTimeout(r, 9_000))
    const starts = fs.readFileSync(path.join(work, 'starts'), 'utf8').trim().split('\n').length
    // Ticks of 1 s: started at 0, 2 and 7 s (1, 3, 7 ... ticks between); every tick would be 9 or 10.
    expect(starts).toBeGreaterThanOrEqual(2)
    expect(starts).toBeLessThanOrEqual(4)
  }, 150_000)

  // 2026-11-04 review: a job launchd would not load at all never set tn, so the tail ended down with no daemon.
  it('a job launchd will not load at all, with nothing to put back, still leaves a daemon serving outside launchd', async () => {
    const { config } = installRunnable()
    stubs!.setLoaded(false)
    stubs!.setBootstrapFails(true)
    const tail = parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...FAST, standInCheckSeconds: 1 }))))
    expect(tail?.outcome).toBe('standin')
    expect(tail?.words).toBe("no daemon answered within 2 s, and there was no earlier service config to go back to, so the service's daemon runs outside launchd until launchd's job can start, and that job takes over then")
    expect(stubs!.calls().filter((c) => c.startsWith(`launchctl bootstrap gui/${process.getuid!()} ${config}`)).length).toBeGreaterThan(0)
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    const standIn = pidOf()
    expect(fs.readFileSync(standInFile(), 'utf8').trim()).toBe(String(standIn))
    // launchd starts jobs, and has none of the service loaded: the stand-in is not handed back into nothing.
    await vi.waitFor(() => expect(handbacks().length).toBeGreaterThanOrEqual(1), { timeout: UP_MS, interval: 200 })
    expect(alive(standIn)).toBe(true)
  }, 150_000)

  // 2026-11-04 review: the stand-in ran the daemon outside launchd past the user's `launchctl disable`.
  it('a job the user turned off is never stood in for, and the record says why', async () => {
    const { config } = installRunnable()
    stubs!.setLoaded(false)
    stubs!.setDisabled(true)
    const tail = parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...FAST, standInCheckSeconds: 1 }))))
    expect(tail?.outcome).toBe('down')
    expect(tail?.words).toContain('the service is turned off in launchd (launchctl disable), so Walnut left it alone and started no daemon outside it')
    await new Promise((r) => setTimeout(r, 1_500))
    expect(fs.existsSync(path.join(stubs!.runtime, '.standin-loop'))).toBe(false)
    expect(fs.existsSync(standInFile())).toBe(false)
    expect(stubs!.daemonUp()).toBe(false)
    expect(fs.readFileSync(config, 'utf8')).toContain('good-new')
  }, 150_000)

  it('a stand-in loop at work stops standing in once the user turns the job off', async () => {
    darkWakeUpdate()
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    stubs!.setDisabled(true)
    // The stand-in exits on its own; the loop does not start it again, and ends.
    process.kill(pidOf(), 'SIGTERM')
    await vi.waitFor(() => expect(fs.existsSync(path.join(stubs!.runtime, '.standin-loop'))).toBe(false), { timeout: UP_MS })
    expect(stubs!.daemonUp()).toBe(false)
  }, 150_000)

  it('the service uninstalled meanwhile ends the stand-in loop', async () => {
    const { config } = darkWakeUpdate()
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: UP_MS })
    fs.rmSync(config)
    await vi.waitFor(() => expect(fs.existsSync(path.join(stubs!.runtime, '.standin-loop'))).toBe(false), { timeout: UP_MS })
  }, 150_000)
})

describe('the spawn probe (whether launchd starts jobs now)', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })
  const run = async (program: string, args: string[]) => {
    const out = spawnSync(program, args, { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout: 30_000 })
    return { code: out.status ?? 1, stdout: out.stdout, stderr: out.stderr }
  }
  const asyncRun = (program: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(program, args, { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }))
  })

  it('tells a launchd that starts jobs from one that does not, touching only its own throwaway job', async () => {
    expect(await launchdSpawnsJobs(run, process.getuid!(), 'dev.openwalnut.session-daemon')).toBe('ok')
    stubs!.setSpawning(false)
    expect(await launchdSpawnsJobs(run, process.getuid!(), 'dev.openwalnut.session-daemon')).toBe('none')
    expect(stubs!.calls().every((c) => c.includes('spawn-probe') || c === 'launchctl list')).toBe(true)
    // Each probe its own label, booted out after (none is left loaded).
    const probes = stubs!.probes()
    expect(probes).toHaveLength(2)
    expect(new Set(probes).size).toBe(2)
    for (const label of probes) expect(label).toMatch(/^dev\.openwalnut\.session-daemon\.spawn-probe\.[0-9a-f]{12}$/)
    expect(fs.readdirSync(stubs!.state).filter((n) => n.startsWith('probe.'))).toEqual([])
  }, 30_000)

  // 2026-11-04 review: one fixed label, so two probes at once (a server's and a stand-in's) made the second's load fail.
  it('two probes at once each get their own answer', async () => {
    stubs!.setProbeDelay(0.5)
    const both = await Promise.all([launchdSpawnsJobs(asyncRun, process.getuid!(), 'dev.openwalnut.session-daemon'), launchdSpawnsJobs(asyncRun, process.getuid!(), 'dev.openwalnut.session-daemon')])
    expect(both).toEqual(['ok', 'ok'])
  }, 30_000)

  it('a probe that could not load its job is no answer, never "starts no jobs"', async () => {
    fs.writeFileSync(path.join(stubs!.state, 'probe-fails'), '')
    expect(await launchdSpawnsJobs(run, process.getuid!(), 'dev.openwalnut.session-daemon')).toBe('unknown')
    // Its dir is gone all the same.
    expect(fs.readdirSync('/tmp').filter((n) => n.startsWith('walnut-spawn-probe.') && stubs!.calls().some((c) => c.includes(n)))).toEqual([])
  }, 30_000)

  it('a probe that gave no answer in time is unknown, and its job and dir are removed from outside', async () => {
    const id = 'fedcba654321'
    const dir = `/tmp/walnut-spawn-probe.${id}`
    fs.mkdirSync(dir, { recursive: true })
    const seen: string[] = []
    const killed = async (program: string, args: string[]) => {
      seen.push([program, ...args].join(' '))
      if (program === '/bin/sh') return { code: 143, stdout: '', stderr: 'killed' }
      return run(program, args)
    }
    try {
      expect(await launchdSpawnsJobs(killed, process.getuid!(), 'dev.openwalnut.session-daemon', id)).toBe('unknown')
      expect(seen).toContain(`launchctl bootout gui/${process.getuid!()}/dev.openwalnut.session-daemon.spawn-probe.${id}`)
      expect(seen).toContain(`/bin/rm -rf ${dir}`)
      expect(fs.existsSync(dir)).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)

  // 2026-11-04 review: the probe counted in tq, where the tail keeps its failure words, so a
  // launchd tail that probed (a job idle past 15 s) wrote "3, nor after ..." on the host's status.
  it.each([true, false])('leaves the shell it runs in alone: the tail keeps its words in tq (launchd starts jobs: %s)', (spawning) => {
    stubs!.setSpawning(spawning)
    const script = [`tu=${process.getuid!()}`, 'tq="no daemon answered within 30 s"', 'ts="a daemon answers"',
      ...launchdSpawnProbeLines('dev.openwalnut.session-daemon'), 't_spawns', 'printf "%s|%s|%s\\n" "$ts_sp" "$tq" "$ts"'].join('\n')
    expect(sh(script).trim()).toBe(`${spawning ? 'ok' : 'none'}|no daemon answered within 30 s|a daemon answers`)
  }, 30_000)

  it('a probe job a dead run left loaded (its dir gone) is booted out by the next probe', async () => {
    stubs!.setListed(['dev.openwalnut.session-daemon.spawn-probe.0123456789ab', 'com.example.other'])
    expect(await launchdSpawnsJobs(run, process.getuid!(), 'dev.openwalnut.session-daemon')).toBe('ok')
    expect(stubs!.calls()).toContain(`launchctl bootout gui/${process.getuid!()}/dev.openwalnut.session-daemon.spawn-probe.0123456789ab`)
    expect(stubs!.calls().some((c) => c.includes('com.example.other'))).toBe(false)
  }, 30_000)
})
