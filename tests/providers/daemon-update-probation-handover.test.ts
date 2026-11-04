/**
 * The probation of a service update and the copies it keeps (daemon-update-probation.ts,
 * daemon-update-tail.ts), run for real in /bin/sh against the init system stand-ins
 * (tests/helpers/service-stubs.ts), for what the 2026-11-04 review 6 found:
 *   - a later update launched inside a put-back's bootout wait stood it down before it loaded the
 *     config it put back: no job loaded, and that update read the service as stopped;
 *   - an update that installed nothing (the old build still serving) had the old build watched,
 *     and its restart written down as the new build's failure;
 *   - copies a reboot left after a probation's end were put back days later;
 *   - the copies were removed outside the install lock, where a later snapshot writes them;
 *   - a wall clock set forward read a healthy daemon as gone (Linux counts etime on the boot clock).
 *
 * MACHINE SAFETY: HOME, the configs, the runtime dir and the record dir are under this file's temp
 * dir, and a later runner's dir is a /tmp/open-walnut-update.* dir of this file's own, removed
 * after; launchctl, systemctl, uname (and in two cases rm and date, which hand on to the real
 * ones) are stubs first on PATH; the only processes are /bin/sh, the probation script (killed by
 * its own path), the stubs' `sleep`s and the fake runner's `sleep`, all stopped after each case.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonInstallRoot, renderDaemonLaunchAgent, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { parseUpdateTail, reviveScript, updateSnapshotScript, updateTailScript, type UpdateTailOptions } from '../../src/providers/daemon-update-tail.js'
import { UP_LINE } from '../../src/providers/daemon-update-shell.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { endRecordedProbations } from '../helpers/probation-cleanup.js'
import { guardedPath } from '../setup/exec-guard.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-handover-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let record: string
let stubs: ServiceStubs | null = null
let extraBin: string | null = null
const extraPids: number[] = []
const extraDirs: string[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  record = path.join(work, 'record')
  fs.mkdirSync(home)
  fs.mkdirSync(record)
  extraBin = null
})
afterEach(() => {
  endRecordedProbations([daemonInstallRoot('darwin', home), daemonInstallRoot('linux', home)])
  for (const pid of extraPids.splice(0)) if (pid > 1) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  stubs?.stop(); stubs = null
})

const GOOD_PREVIOUS = '/opt/walnut/versions/good-previous/open-walnut-daemon'
const GOOD_NEW = '/opt/walnut/versions/good-new/open-walnut-daemon'
const BAD_NEW = '/opt/walnut/versions/bad-new/open-walnut-daemon'
const BUILD = 'walnut-daemon-new00001'
const latest = () => path.join(work, 'latest')

function env(): Record<string, string> {
  const e = { HOME: home, ...stubs!.env }
  return extraBin ? { ...e, PATH: guardedPath([extraBin], e.PATH) } : e
}
function sh(script: string, timeout = 90_000): string {
  const out = spawnSync('/bin/sh', ['-c', `L='${latest()}'\n${script}`], { env: env(), encoding: 'utf8', timeout })
  if (out.status !== 0) throw new Error(`sh exited ${out.status}: ${out.stderr}`)
  return out.stdout
}
const tb = (platform: 'darwin' | 'linux') => daemonInstallRoot(platform, home)

function install(platform: 'darwin' | 'linux', exe: string): string {
  const stateDir = tb(platform)
  fs.mkdirSync(stateDir, { recursive: true })
  const config = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    : path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const c = { platform, home, executable: exe, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }
  fs.writeFileSync(config, platform === 'darwin' ? renderDaemonLaunchAgent(c) : renderDaemonSystemdUnit(c, 'user'), { mode: 0o600 })
  fs.writeFileSync(path.join(stateDir, 'service-configs.json'), `{"${config}":"${exe.includes('previous') ? 'a'.repeat(64) : 'b'.repeat(64)}"}\n`, { mode: 0o600 })
  return config
}
const jobPid = () => Number(fs.readFileSync(path.join(stubs!.state, 'jobpid'), 'utf8').trim())
const daemonPid = () => Number(fs.readFileSync(path.join(stubs!.runtime, 'daemon.pid'), 'utf8').trim())
const failed = (platform: 'darwin' | 'linux') => path.join(tb(platform), 'update-probation.failed')
const copies = (platform: 'darwin' | 'linux') => path.join(tb(platform), 'update-before')
const probationAlive = () => (spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout ?? '').split('\n').some((a) => a.includes(path.join(home, '.')) && a.includes('daemon-probation.sh'))

/** A later update's runner at work: its dir (where t_later looks), its pid alive as its update.sh. */
function laterRunner(): string {
  const later = fs.mkdtempSync('/tmp/open-walnut-update.')
  extraDirs.push(later)
  fs.writeFileSync(path.join(later, 'update.sh'), 'sleep 120\n', { mode: 0o700 })
  const runner = spawn('/bin/sh', [path.join(later, 'update.sh')], { detached: true, stdio: 'ignore' })
  runner.unref()
  extraPids.push(runner.pid!)
  fs.writeFileSync(path.join(later, 'update.pid'), `${runner.pid}\n`)
  fs.writeFileSync(latest(), `${later}\n`)
  return later
}

/** Commands named `name` first on PATH, each a sh script (the real one is `real`). */
function shim(name: string, body: (real: string) => string[]): void {
  extraBin ??= fs.mkdtempSync(path.join(work, 'shim-'))
  const real = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
  fs.writeFileSync(path.join(extraBin, name), ['#!/bin/sh', ...body(real), ''].join('\n'), { mode: 0o755 })
}

describe('a LaunchAgent put-back that a later update interrupts', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })

  it('loads the config it put back before the later update takes over, and writes the build down', async () => {
    const config = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(config, 'utf8')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD_PREVIOUS)
    fs.writeFileSync(latest(), `${record}\n`)
    sh(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`)
    // The update: the old job's daemon stops, the new plist is loaded, its daemon serves.
    process.kill(jobPid(), 'SIGKILL')
    fs.rmSync(path.join(stubs!.runtime, 'daemon.pid'))
    install('darwin', GOOD_NEW)
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD_NEW)
    const o: UpdateTailOptions = { scope: 'user', waitSeconds: 6, goneSeconds: 12, staySeconds: 1, probationSeconds: 120, probationEverySeconds: 1, lockWaitSeconds: 30 }
    expect(parseUpdateTail(sh(updateTailScript(record, o)))?.outcome).toBe('serving')
    fs.writeFileSync(path.join(record, 'update.done'), 'rc=0\n')
    await vi.waitFor(() => expect(fs.existsSync(path.join(copies('darwin'), 'probation.pid'))).toBe(true), { timeout: 10_000 })
    // The new build dies inside its probation; the put-back's bootout lingers (the job's ExitTimeOut).
    stubs!.setBootoutLinger(4)
    process.kill(jobPid(), 'SIGKILL')
    await vi.waitFor(() => expect(fs.existsSync(path.join(stubs!.state, 'lingering'))).toBe(true), { timeout: 20_000, interval: 100 })
    // A later update launches right then.
    const later = laterRunner()
    await vi.waitFor(() => expect(probationAlive()).toBe(false), { timeout: 40_000, interval: 250 })
    // The previous job is loaded (its plist on disk), and its daemon serves.
    expect(fs.readFileSync(config, 'utf8')).toBe(previousPlist)
    expect(fs.existsSync(path.join(stubs!.state, 'job')) ? fs.readFileSync(path.join(stubs!.state, 'job'), 'utf8').trim() : null).toBe(config)
    await vi.waitFor(() => expect(stubs!.daemonUp()).toBe(true), { timeout: 10_000 })
    expect(fs.readFileSync(failed('darwin'), 'utf8').split('\n')[0]).toBe(BUILD)
    // The later update's snapshot reads the service as running: its CLI goes ahead, its tail can put this back.
    sh(updateSnapshotScript(later, { scope: 'user' }))
    expect(fs.readFileSync(path.join(later, 'before.state'), 'utf8')).toBe('running\n')
  }, 120_000)
  // 2026-11-04 review 7: a put-back that held the lock past a later snapshot's wait removed the
  // copies that snapshot wrote meanwhile, so that update had no way back.
  it('removes the copies at its end only while they are still its own', async () => {
    const config = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(config, 'utf8')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD_PREVIOUS)
    fs.writeFileSync(latest(), `${record}\n`)
    sh(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`)
    process.kill(jobPid(), 'SIGKILL')
    fs.rmSync(path.join(stubs!.runtime, 'daemon.pid'))
    install('darwin', GOOD_NEW)
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD_NEW)
    const o: UpdateTailOptions = { scope: 'user', waitSeconds: 6, goneSeconds: 12, staySeconds: 1, probationSeconds: 120, probationEverySeconds: 1, lockWaitSeconds: 30 }
    expect(parseUpdateTail(sh(updateTailScript(record, o)))?.outcome).toBe('serving')
    fs.writeFileSync(path.join(record, 'update.done'), 'rc=0\n')
    await vi.waitFor(() => expect(fs.existsSync(path.join(copies('darwin'), 'probation.pid'))).toBe(true), { timeout: 10_000 })
    stubs!.setBootoutLinger(4)
    process.kill(jobPid(), 'SIGKILL')
    await vi.waitFor(() => expect(fs.existsSync(path.join(stubs!.state, 'lingering'))).toBe(true), { timeout: 20_000, interval: 100 })
    // A later update's snapshot wrote its own copies there meanwhile (its lock wait ran out).
    const theirs = '/tmp/open-walnut-update.later-snapshot'
    fs.writeFileSync(path.join(copies('darwin'), 'before.dir'), `${theirs}\n`)
    await vi.waitFor(() => expect(probationAlive()).toBe(false), { timeout: 40_000, interval: 250 })
    expect(fs.readFileSync(config, 'utf8')).toBe(previousPlist)
    expect(fs.readFileSync(path.join(copies('darwin'), 'before.dir'), 'utf8')).toBe(`${theirs}\n`)
    expect(fs.readFileSync(failed('darwin'), 'utf8').split('\n')[0]).toBe(BUILD)
  }, 120_000)
})

describe('the copies of a systemd update', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })
  const WATCH: Omit<UpdateTailOptions, 'scope'> = { waitSeconds: 4, goneSeconds: 2, staySeconds: 1, lockWaitSeconds: 10, probationSeconds: 30, probationEverySeconds: 1 }

  /** The old unit serving, its snapshot taken for BUILD. */
  function before(): string {
    const unit = install('linux', GOOD_PREVIOUS)
    stubs!.setLoaded(true, unit)
    stubs!.startDaemon(GOOD_PREVIOUS)
    sh(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`)
    return unit
  }

  it('an update that installed nothing (the old build still serving) starts no probation, and writes no build down', async () => {
    before()
    // The CLI refused (busy, a trial that failed): the config and the daemon are the ones from before.
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...WATCH })))).toEqual({ outcome: 'serving', words: 'a daemon answers' })
    expect(fs.existsSync(copies('linux'))).toBe(false)
    // The old daemon started again twice (the user's own restarts) is no one's failure.
    for (let n = 0; n < 2; n++) {
      const next = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      next.unref()
      extraPids.push(next.pid!)
      const old = daemonPid()
      fs.writeFileSync(path.join(stubs!.state, 'jobpid'), `${next.pid}\n`)
      fs.writeFileSync(path.join(stubs!.runtime, 'daemon.pid'), `${next.pid}\n`)
      process.kill(old, 'SIGKILL')
      await new Promise((r) => setTimeout(r, 1_500))
    }
    expect(fs.existsSync(failed('linux'))).toBe(false)
    expect(probationAlive()).toBe(false)
  }, 60_000)

  it('copies whose probation ended (a reboot cut its watch short) are no way back: dropped, nothing put back', () => {
    const unit = before()
    // The update installed the new unit, its probation began and was cut short; its end passed since.
    install('linux', BAD_NEW)
    stubs!.setLoaded(false)
    process.kill(daemonPid(), 'SIGKILL')
    fs.rmSync(path.join(stubs!.runtime, 'daemon.pid'))
    fs.writeFileSync(path.join(copies('linux'), 'before.until'), `${Math.floor(Date.now() / 1000) - 60}\n`)
    const revived = parseUpdateTail(sh(reviveScript({ scope: 'user', waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, latest: latest() })))
    expect(revived?.outcome).toBe('down')
    expect(fs.readFileSync(unit, 'utf8')).toContain('bad-new')
    expect(fs.existsSync(copies('linux'))).toBe(false)
    expect(fs.existsSync(failed('linux'))).toBe(false)
  }, 60_000)

  // 2026-11-04 review 7: copies with no probation (an update cut short before its verdict) were a
  // way back for 7 days, so a good build that then served for days was put back at a slow start.
  it.each([
    ['a daemon kept the runtime dir fresh well past the update: the copies are dropped', 2 * 3600, false],
    ['nothing since the update: they are the way back still', 60, true],
  ] as const)('copies with no probation, %s', (_what, freshFor, back) => {
    const unit = before()
    install('linux', BAD_NEW)
    stubs!.setLoaded(false)
    process.kill(daemonPid(), 'SIGKILL')
    const at = Math.floor(Date.now() / 1000) - 3 * 3600
    fs.writeFileSync(path.join(copies('linux'), 'before.at'), `${at}\n`)
    // The pid file a daemon touched last that long after the update.
    const touched = new Date((at + freshFor) * 1000)
    fs.utimesSync(path.join(stubs!.runtime, 'daemon.pid'), touched, touched)
    const revived = parseUpdateTail(sh(reviveScript({ scope: 'user', waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, latest: latest() })))
    if (back) {
      expect(revived?.outcome).toBe('restored')
      expect(fs.readFileSync(unit, 'utf8')).toContain('good-previous')
    } else {
      expect(revived?.outcome).toBe('down')
      expect(fs.readFileSync(unit, 'utf8')).toContain('bad-new')
      expect(fs.existsSync(failed('linux'))).toBe(false)
    }
    expect(fs.existsSync(copies('linux'))).toBe(false)
  }, 60_000)

  it('every removal of the copies holds the install lock (a later snapshot writes them under it)', async () => {
    // rm of the copies logs whether the shell that ran it held the lock then.
    const log = path.join(work, 'rm.log')
    const lockPid = path.join(tb('linux'), 'service-configs.json.lock', 'pid')
    shim('rm', (real) => [
      'for a in "$@"; do case "$a" in */update-before)',
      `  if [ "$(cat '${lockPid}' 2>/dev/null)" = "$PPID" ]; then echo locked >> '${log}'; else echo "unlocked $PPID" >> '${log}'; fi;; esac; done`,
      `exec ${real} "$@"`,
    ])
    // A probation that passes.
    before()
    install('linux', GOOD_NEW)
    sh('systemctl --user restart open-walnut-daemon.service')
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...WATCH, probationSeconds: 3 })))?.outcome).toBe('serving')
    await vi.waitFor(() => expect(fs.existsSync(copies('linux'))).toBe(false), { timeout: 20_000 })
    // A revive that finds copies past their probation.
    sh(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`)
    fs.writeFileSync(path.join(copies('linux'), 'before.until'), `${Math.floor(Date.now() / 1000) - 60}\n`)
    sh(reviveScript({ scope: 'user', waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, latest: latest() }))
    expect(fs.existsSync(copies('linux'))).toBe(false)
    // A tail whose service the user stopped meanwhile.
    stubs!.setLoaded(false)
    fs.rmSync(path.join(record, 'before.state'), { force: true })
    sh(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`)
    expect(fs.existsSync(copies('linux'))).toBe(true)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...WATCH })))?.outcome).toBe('stopped')
    expect(fs.existsSync(copies('linux'))).toBe(false)
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines.filter((l) => l !== 'locked')).toEqual([])
  }, 90_000)
})

describe('t_up across a wall clock set forward', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })

  it.skipIf(!fs.existsSync('/proc/uptime'))('a healthy daemon still serves after the clock jumps 10 minutes ahead', () => {
    stubs!.startDaemon(GOOD_NEW)
    const offset = path.join(work, 'clock-offset')
    shim('date', (real) => [
      `if [ "$1" = "+%s" ]; then o=$(cat '${offset}' 2>/dev/null || echo 0); echo $(( $(${real} +%s) + o )); else exec ${real} "$@"; fi`,
    ])
    const out = sh([`tr='${stubs!.runtime}'`, UP_LINE, 't_up && echo up-before', `echo 600 > '${offset}'`, 't_up && echo up-after'].join('\n'))
    expect(out.trim().split('\n')).toEqual(['up-before', 'up-after'])
  })
})
