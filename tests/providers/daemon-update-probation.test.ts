/**
 * The probation of a service update (src/providers/daemon-update-probation.ts), run for real in
 * /bin/sh against the systemd stand-in (tests/helpers/service-stubs.ts). 2026-11-04 review 5: a
 * build that died after the CLI's 30 s and the tail's 15 s (at its first session spawn, on a 60 s
 * timer) was restarted in a loop for good, with nothing to go back to. Now a daemon that served
 * is watched on: gone, or started again twice, and the config from before (kept in the install
 * root) goes back, and the build is written down for the next runner of it.
 *
 * MACHINE SAFETY: HOME, the configs, the runtime dir and the record dir are under this file's
 * temp dir; systemctl and uname are the stubs (PATH has nothing else first); the only processes
 * are /bin/sh, the probation script (killed after each case by its own path) and the stubs' `sleep`s.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonInstallRoot, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { parseUpdateTail, updateSnapshotScript, updateTailScript, type UpdateTailOptions } from '../../src/providers/daemon-update-tail.js'
import { answerOfRecord, LAUNCHED, launcherScript, PROBATION_BUSY, readNetUpdateRecord, RUNNER_BUSY, runnerScript } from '../../src/providers/daemon-net-update-io.js'
import { parseProbing, PROBATION_GRACE_SECONDS, PROBATION_SECONDS, PROBATION_STARTING_NAME, PROBATION_STARTING_SECONDS, probationRecordLines, probingCheckScript } from '../../src/providers/daemon-update-probation.js'
import { servicePreamble } from '../../src/providers/daemon-update-shell.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { endRecordedProbations } from '../helpers/probation-cleanup.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-probation-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let record: string
let stubs: ServiceStubs
const extraPids: number[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  record = path.join(work, 'record')
  fs.mkdirSync(home)
  fs.mkdirSync(record)
  stubs = createServiceStubs(work, 'Linux')
})
afterEach(() => {
  // The probation of this case only: a sh whose command line names this case's script.
  endRecordedProbations([daemonInstallRoot('linux', home)])
  for (const pid of extraPids.splice(0)) if (pid > 1) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  for (const dir of runnerDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  stubs.stop()
})
const runnerDirs: string[] = []

const GOOD_PREVIOUS = '/opt/walnut/versions/good-previous/open-walnut-daemon'
const GOOD_NEW = '/opt/walnut/versions/good-new/open-walnut-daemon'
const BUILD = 'walnut-daemon-new00001'
const WATCH: Omit<UpdateTailOptions, 'scope'> = { waitSeconds: 4, goneSeconds: 2, staySeconds: 1, lockWaitSeconds: 10, probationSeconds: 30, probationEverySeconds: 1 }

function sh(script: string): string {
  const out = spawnSync('/bin/sh', ['-c', script], { env: { HOME: home, ...stubs.env }, encoding: 'utf8', timeout: 60_000 })
  if (out.status !== 0) throw new Error(`sh exited ${out.status}: ${out.stderr}`)
  return out.stdout
}
const withMarker = (script: string) => `L='${path.join(work, 'latest')}'\n${script}`

const unit = () => path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
function install(exe: string): void {
  const stateDir = daemonInstallRoot('linux', home)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(path.dirname(unit()), { recursive: true })
  fs.writeFileSync(unit(), renderDaemonSystemdUnit({ platform: 'linux', home, executable: exe, args: ['--service'], runtimeDir: stubs.runtime, stateDir, path: '/usr/bin:/bin' }, 'user'), { mode: 0o600 })
  fs.writeFileSync(path.join(stateDir, 'service-configs.json'), `{"${unit()}":"${exe.includes('previous') ? 'a'.repeat(64) : 'b'.repeat(64)}"}\n`, { mode: 0o600 })
}
const tb = () => daemonInstallRoot('linux', home)
const daemonPid = () => Number(fs.readFileSync(path.join(stubs.runtime, 'daemon.pid'), 'utf8').trim())
const failedFile = () => path.join(tb(), 'update-probation.failed')

/** The previous unit serving, the snapshot taken for BUILD, then the update: the new unit, its daemon serving. */
function updated(): { previousUnit: string; newUnit: string } {
  install(GOOD_PREVIOUS)
  const previousUnit = fs.readFileSync(unit(), 'utf8')
  stubs.setLoaded(true, unit())
  stubs.startDaemon(GOOD_PREVIOUS)
  sh(withMarker(`tvb=${BUILD}\n${updateSnapshotScript(record, { scope: 'user' })}`))
  install(GOOD_NEW)
  sh('systemctl --user restart open-walnut-daemon.service')
  expect(stubs.daemonUp()).toBe(true)
  return { previousUnit, newUnit: fs.readFileSync(unit(), 'utf8') }
}

/** The tail found it serving, and the probation of it runs. */
async function probationRuns(o: Partial<UpdateTailOptions> = {}): Promise<void> {
  expect(parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...WATCH, ...o })))))
    .toEqual({ outcome: 'serving', words: 'a daemon answers' })
  // The tail does not wait for it (its start mark holds updates meanwhile): a loaded detach takes seconds.
  await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before', 'probation.pid'))).toBe(true), { timeout: 20_000, interval: 100 })
}

/**
 * Another daemon of the new build in its place, as systemd's Restart= brings one back: the new
 * one first, so no look of the probation (a loaded machine stretches every step) falls between.
 */
function restart(): void {
  const next = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  next.unref()
  extraPids.push(next.pid!)
  const old = daemonPid()
  fs.writeFileSync(path.join(stubs.state, 'jobpid'), `${next.pid}\n`)
  fs.writeFileSync(path.join(stubs.runtime, 'daemon.pid'), `${next.pid}\n`)
  process.kill(old, 'SIGKILL')
}

describe('the probation of a service update that came to serve', () => {
  it('a new daemon that dies inside its probation is followed by the config from before, and its build is written down', async () => {
    const { previousUnit } = updated()
    await probationRuns()
    // It dies a while after the tail's verdict, and nothing starts it again.
    process.kill(daemonPid(), 'SIGKILL')
    // Written down as soon as it is found, then with what the put-back did.
    await vi.waitFor(() => {
      expect(fs.readFileSync(unit(), 'utf8')).toBe(previousUnit)
      expect(stubs.daemonUp()).toBe(true)
      expect(fs.existsSync(failedFile()) && fs.readFileSync(failedFile(), 'utf8').split('\n')[2]).toMatch(/^no daemon answered \d+ s into the new daemon's probation, so the previous service config was put back, and its daemon answers$/)
    }, { timeout: 30_000, interval: 250 })
    const [build, at] = fs.readFileSync(failedFile(), 'utf8').split('\n')
    expect(build).toBe(BUILD)
    expect(Math.abs(Number(at) - Date.now() / 1000)).toBeLessThan(60)
    await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before'))).toBe(false), { timeout: 5_000 })
  }, 60_000)

  it('one started again twice (a crash loop under Restart=) is put back too; once is not enough', async () => {
    const { previousUnit, newUnit } = updated()
    await probationRuns()
    restart()
    await new Promise((r) => setTimeout(r, 3_000))
    expect(fs.readFileSync(unit(), 'utf8')).toBe(newUnit)
    expect(fs.existsSync(failedFile())).toBe(false)
    restart()
    await vi.waitFor(() => {
      expect(fs.readFileSync(unit(), 'utf8')).toBe(previousUnit)
      expect(fs.existsSync(failedFile())).toBe(true)
    }, { timeout: 30_000, interval: 250 })
    expect(fs.readFileSync(failedFile(), 'utf8').split('\n')[2]).toMatch(/^the new daemon stopped and was started again 2 times within \d+ s of its probation/)
  }, 60_000)

  it('a daemon that stays through it is kept: the copies go, nothing is written down', async () => {
    const { newUnit } = updated()
    await probationRuns({ probationSeconds: 3 })
    await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before'))).toBe(false), { timeout: 15_000 })
    expect(fs.readFileSync(unit(), 'utf8')).toBe(newUnit)
    expect(fs.existsSync(failedFile())).toBe(false)
    expect(stubs.daemonUp()).toBe(true)
  }, 60_000)

  it('a `walnut daemon` transaction of the user stands it down: theirs to decide, nothing is put back', async () => {
    const { newUnit } = updated()
    await probationRuns()
    // The user's own `walnut daemon` holds the install lock for a moment (an older build's form).
    const holder = spawn('sleep', ['3'], { stdio: 'ignore' })
    extraPids.push(holder.pid!)
    const lock = path.join(tb(), 'service-configs.json.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`)
    await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before'))).toBe(false), { timeout: 15_000 })
    // Its daemon dies after that: no probation is there to put anything back.
    process.kill(daemonPid(), 'SIGKILL')
    await new Promise((r) => setTimeout(r, 3_000))
    expect(fs.readFileSync(unit(), 'utf8')).toBe(newUnit)
    expect(fs.existsSync(failedFile())).toBe(false)
  }, 60_000)
})

// 2026-11-05 review 6: a later update launched inside the probation took its copies (or, refused
// at once, stood it down all the same), so a build that then failed late had no way back.
describe('a later update while the probation runs', () => {
  const probationPid = () => Number(fs.readFileSync(path.join(tb(), 'update-before', 'probation.pid'), 'utf8').trim())
  /** The revive's rule (t_probing): a probation of the copies at work, or one the tail just started. */
  const probing = () => sh([...servicePreamble('user'), ...probationRecordLines(), 'tsb="$tb/update-before"', 't_probing && echo at-work || echo none'].join('\n')).trim() === 'at-work'
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const latest = () => path.join(work, 'latest')
  /** A later update's dir in /tmp (the runners' own), its runner script for build C, a CLI that leaves a mark. */
  function laterUpdate(): { dir: string; ran: string } {
    const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
    runnerDirs.push(dir)
    const ran = path.join(work, 'later-cli-ran')
    fs.writeFileSync(path.join(dir, 'update.sh'), runnerScript({
      directory: dir, command: `touch '${ran}'`, executable: '/elsewhere/daemon', settleSeconds: 3, latest: latest(),
      tail: { scope: 'user', ...WATCH }, build: 'walnut-daemon-c0000001',
    }), { mode: 0o700 })
    return { dir, ran }
  }
  /** That runner started directly (as an older launcher would, or one that raced the probation's start), named the latest. */
  function startLater(dir: string): void {
    fs.writeFileSync(latest(), `${dir}\n`)
    fs.writeFileSync(path.join(dir, 'update.go'), '')
    const child = spawn('/bin/sh', [path.join(dir, 'update.sh')], { env: { HOME: home, ...stubs.env }, stdio: 'ignore', detached: true })
    child.unref()
    extraPids.push(child.pid!)
  }

  it('the host reads as busy: the check names the probation\'s end, and the launcher starts nothing', async () => {
    updated()
    await probationRuns()
    const left = parseProbing(sh(probingCheckScript('user')))
    expect(left).toBeGreaterThan(20)
    expect(left).toBeLessThanOrEqual(30)
    const { dir, ran } = laterUpdate()
    const said = sh(launcherScript(dir, latest()))
    expect(said).toContain(`${RUNNER_BUSY} probation pid=${probationPid()}`)
    expect(fs.existsSync(path.join(dir, 'update.nogo'))).toBe(true)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(fs.existsSync(ran)).toBe(false)
    expect(fs.existsSync(latest())).toBe(false)
    expect(alive(probationPid())).toBe(true)
    // Its process gone (a reboot), its copies still hold updates till their end; past it, nothing to wait for.
    process.kill(probationPid(), 'SIGKILL')
    expect(parseProbing(sh(probingCheckScript('user')))).not.toBeNull()
    fs.writeFileSync(path.join(tb(), 'update-before', 'before.until'), `${Math.floor(Date.now() / 1000) - 1}\n`)
    expect(parseProbing(sh(probingCheckScript('user')))).toBeNull()
  }, 60_000)

  it('a runner that finds it at work changes nothing, its record is a hold, and the probation goes on: a death after it is still put back', async () => {
    const { previousUnit, newUnit } = updated()
    await probationRuns()
    const watcher = probationPid()
    const { dir, ran } = laterUpdate()
    startLater(dir)
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'update.done'))).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.readFileSync(path.join(dir, 'update.done'), 'utf8')).toBe('rc=probation tries=0 tail=none\n')
    expect(fs.existsSync(ran)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'before.cfg'))).toBe(false)
    const record = await readNetUpdateRecord((file) => fs.promises.readFile(file, 'utf8').catch(() => null), dir)
    expect(() => answerOfRecord(record!)).toThrow(PROBATION_BUSY)
    expect(fs.readFileSync(unit(), 'utf8')).toBe(newUnit)
    await new Promise((r) => setTimeout(r, 2_000))
    expect(alive(watcher)).toBe(true)
    process.kill(daemonPid(), 'SIGKILL')
    await vi.waitFor(() => {
      expect(fs.readFileSync(unit(), 'utf8')).toBe(previousUnit)
      expect(fs.existsSync(failedFile()) && fs.readFileSync(failedFile(), 'utf8').split('\n')[0]).toBe(BUILD)
    }, { timeout: 30_000, interval: 250 })
  }, 60_000)

  it('a runner refused at once (its build failed here lately) leaves it watching too', async () => {
    const { previousUnit } = updated()
    await probationRuns()
    const watcher = probationPid()
    fs.writeFileSync(failedFile(), `walnut-daemon-c0000001\n${Math.floor(Date.now() / 1000) - 60}\nearlier\n`)
    const { dir, ran } = laterUpdate()
    startLater(dir)
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'update.done'))).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.readFileSync(path.join(dir, 'update.done'), 'utf8')).toBe('rc=refused tries=0 tail=none\n')
    expect(fs.existsSync(ran)).toBe(false)
    await new Promise((r) => setTimeout(r, 2_000))
    expect(alive(watcher)).toBe(true)
    process.kill(daemonPid(), 'SIGKILL')
    await vi.waitFor(() => {
      expect(fs.readFileSync(unit(), 'utf8')).toBe(previousUnit)
      expect(fs.readFileSync(failedFile(), 'utf8').split('\n')[0]).toBe(BUILD)
    }, { timeout: 30_000, interval: 250 })
  }, 60_000)

  it('another config than the one it watched (written outside any lock) stands it down, its copies dropped', async () => {
    updated()
    await probationRuns()
    const watcher = probationPid()
    install('/opt/walnut/versions/user-own/open-walnut-daemon')
    await vi.waitFor(() => expect(alive(watcher)).toBe(false), { timeout: 15_000, interval: 200 })
    await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before'))).toBe(false), { timeout: 15_000 })
    expect(fs.existsSync(failedFile())).toBe(false)
  }, 60_000)

  // 2026-11-05 reviews 7 and 8: the tail waited 5 s for the probation's pid, and a detach under load
  // takes longer (20 s seen at load 140, 75 s in review 8's sim, past the start mark's 60 s). A
  // launch in that gap found nothing at work and took the copies.
  it('one slow to start (a loaded detach) is at work from the tail\'s end: where the detach is the probation, its pid is known at once', async () => {
    updated()
    // The detach takes 10 s before the probation's sh runs (setsid execs it in place).
    fs.writeFileSync(path.join(stubs.bin, 'setsid'), '#!/bin/sh\nsleep 10\nexec "$@"\n', { mode: 0o755 })
    expect(parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...WATCH, probationSeconds: 120 })))))
      .toEqual({ outcome: 'serving', words: 'a daemon answers' })
    const copies = path.join(tb(), 'update-before')
    const mark = path.join(copies, PROBATION_STARTING_NAME)
    const detached = probationPid()
    expect(alive(detached)).toBe(true)
    expect(probing()).toBe(true)
    // However long its start takes: with the mark past its PROBATION_STARTING_SECONDS, still at work.
    fs.writeFileSync(mark, `${Math.floor(Date.now() / 1000) - PROBATION_STARTING_SECONDS - 60}\n`)
    expect(probing()).toBe(true)
    const { dir, ran } = laterUpdate()
    expect(sh(launcherScript(dir, latest()))).toContain(`${RUNNER_BUSY} probation pid=${detached}`)
    expect(fs.existsSync(path.join(dir, 'update.nogo'))).toBe(true)
    expect(fs.existsSync(ran)).toBe(false)
    // Then it runs, as that pid, and the mark goes.
    await vi.waitFor(() => expect(fs.existsSync(mark)).toBe(false), { timeout: 30_000, interval: 250 })
    expect(probationPid()).toBe(detached)
    expect(alive(detached)).toBe(true)
  }, 90_000)

  it('a start mark alone (a detach whose process is not the probation) counts as at work for PROBATION_STARTING_SECONDS only', () => {
    const copies = path.join(tb(), 'update-before')
    fs.mkdirSync(copies, { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    fs.writeFileSync(path.join(copies, PROBATION_STARTING_NAME), `${now - 20}\n`)
    expect(probing()).toBe(true)
    expect(parseProbing(sh(probingCheckScript('user')))).toBeGreaterThan(30)
    fs.writeFileSync(path.join(copies, PROBATION_STARTING_NAME), `${now - PROBATION_STARTING_SECONDS - 5}\n`)
    expect(probing()).toBe(false)
    expect(parseProbing(sh(probingCheckScript('user')))).toBeNull()
  })

  // 2026-11-05 review 8: a reboot ended the probation and the service brought the new build back (it
  // answers, so no revive runs): the next update found nothing at work, and its snapshot took the
  // only copy of the build before it.
  it('copies whose probation a reboot ended hold every later update until their end; an end further ahead than a probation is not believed', async () => {
    const { previousUnit, newUnit } = updated()
    await probationRuns({ probationSeconds: 300 })
    const copies = path.join(tb(), 'update-before')
    // A probation that runs: the tail writes its pid at the detach, the probation takes its start mark
    // away once it started (a reboot inside that minute is the start mark's own case, tested above).
    await vi.waitFor(() => expect(fs.existsSync(path.join(copies, PROBATION_STARTING_NAME))).toBe(false), { timeout: 30_000, interval: 100 })
    const watcher = probationPid()
    process.kill(watcher, 'SIGKILL')
    await vi.waitFor(() => expect(alive(watcher)).toBe(false))
    // The revive's own rule: it takes these copies up, so they do not hold it.
    expect(probing()).toBe(false)
    expect(parseProbing(sh(probingCheckScript('user')))).toBeGreaterThan(200)
    const first = laterUpdate()
    expect(sh(launcherScript(first.dir, latest()))).toContain(`${RUNNER_BUSY} probation`)
    // A runner started anyway (as an older launcher would) changes nothing either.
    const second = laterUpdate()
    startLater(second.dir)
    await vi.waitFor(() => expect(fs.existsSync(path.join(second.dir, 'update.done'))).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.readFileSync(path.join(second.dir, 'update.done'), 'utf8')).toBe('rc=probation tries=0 tail=none\n')
    expect(fs.existsSync(second.ran)).toBe(false)
    expect(fs.readFileSync(path.join(copies, 'before.cfg'), 'utf8')).toBe(previousUnit)
    expect(fs.readFileSync(path.join(copies, 'before.dir'), 'utf8')).toBe(`${record}\n`)
    expect(fs.readFileSync(unit(), 'utf8')).toBe(newUnit)
    // A clock stepped back: an end further ahead than a probation lasts holds nothing.
    fs.writeFileSync(path.join(copies, 'before.until'), `${Math.floor(Date.now() / 1000) + PROBATION_SECONDS + 120}\n`)
    expect(parseProbing(sh(probingCheckScript('user')))).toBeNull()
  }, 60_000)

  it('a runner that found nothing before the install lock looks again under it: a probation started meanwhile keeps its copies', async () => {
    const { previousUnit } = updated()
    // The install lock is held, as by a tail that starts a probation of these copies under it.
    const holder = spawn('sleep', ['120'], { stdio: 'ignore' })
    extraPids.push(holder.pid!)
    const lock = path.join(tb(), 'service-configs.json.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`)
    const { dir, ran } = laterUpdate()
    startLater(dir)
    const runner = extraPids[extraPids.length - 1]
    // Its own look found nothing (no probation yet): it waits for the lock in its snapshot.
    const waitsForLock = () => (spawnSync('ps', ['-o', 'args=', '--ppid', String(runner)], { encoding: 'utf8' }).stdout ?? '').split('\n').some((l) => l.trim() === 'sleep 1')
    await vi.waitFor(() => expect(waitsForLock()).toBe(true), { timeout: 30_000, interval: 100 })
    // The holder starts the probation (its end written), then lets go.
    fs.writeFileSync(path.join(tb(), 'update-before', 'before.until'), `${Math.floor(Date.now() / 1000) + 300}\n`)
    fs.rmSync(lock, { recursive: true, force: true })
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'update.done'))).toBe(true), { timeout: 30_000, interval: 200 })
    expect(fs.readFileSync(path.join(dir, 'update.done'), 'utf8')).toBe('rc=probation tries=0 tail=none\n')
    expect(fs.existsSync(ran)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'before.cfg'))).toBe(false)
    expect(fs.readFileSync(path.join(tb(), 'update-before', 'before.cfg'), 'utf8')).toBe(previousUnit)
    expect(fs.readFileSync(path.join(tb(), 'update-before', 'before.dir'), 'utf8')).toBe(`${record}\n`)
  }, 60_000)

  it('a config written while it starts (during the detach) is not taken for the update\'s: it stands down at its first look', async () => {
    updated()
    fs.writeFileSync(path.join(stubs.bin, 'setsid'), '#!/bin/sh\nsleep 4\nexec "$@"\n', { mode: 0o755 })
    expect(parseUpdateTail(sh(withMarker(updateTailScript(record, { scope: 'user', ...WATCH, probationSeconds: 120 })))))
      .toEqual({ outcome: 'serving', words: 'a daemon answers' })
    // The user's own install lands before the probation runs.
    install('/opt/walnut/versions/user-own/open-walnut-daemon')
    const userUnit = fs.readFileSync(unit(), 'utf8')
    await vi.waitFor(() => expect(fs.existsSync(path.join(tb(), 'update-before'))).toBe(false), { timeout: 30_000, interval: 250 })
    expect(fs.readFileSync(unit(), 'utf8')).toBe(userUnit)
    expect(fs.existsSync(failedFile())).toBe(false)
  }, 60_000)
})

// 2026-11-05 review 6b: a probation's process counted as at work for as long as it lived, so one
// that hung (a launchctl in its put-back that never answered) held every later update for good.
describe('a probation that is past its time', () => {
  it('counts as at work only up to its end and a grace after it; a hung one stops holding updates', async () => {
    const copies = path.join(tb(), 'update-before')
    fs.mkdirSync(copies, { recursive: true })
    const script = path.join(work, 'daemon-probation.sh')
    fs.writeFileSync(script, 'sleep 120\n:\n', { mode: 0o700 })
    const hung = spawn('/bin/sh', [script], { stdio: 'ignore', detached: true })
    hung.unref()
    extraPids.push(hung.pid!)
    fs.writeFileSync(path.join(copies, 'probation.pid'), `${hung.pid}\n`)
    const now = Math.floor(Date.now() / 1000)
    const until = (at: number | null) => at === null ? fs.rmSync(path.join(copies, 'before.until'), { force: true }) : fs.writeFileSync(path.join(copies, 'before.until'), `${at}\n`)
    const check = () => parseProbing(sh(probingCheckScript('user')))
    until(now + 300)
    expect(check()).toBeGreaterThan(290)
    // Past its end, inside the grace (its last looks, a put-back): still at work.
    until(now - PROBATION_GRACE_SECONDS + 120)
    expect(check()).toBe(0)
    // Past the grace: hung, or a pid another process got. The launcher starts the update.
    until(now - PROBATION_GRACE_SECONDS - 60)
    expect(check()).toBeNull()
    const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
    runnerDirs.push(dir)
    // A runner that only says it runs, then ends.
    fs.writeFileSync(path.join(dir, 'update.sh'), `echo $$ > '${dir}/update.pid'\nsleep 2\n`, { mode: 0o700 })
    expect(sh(launcherScript(dir, path.join(work, 'latest')))).toContain(LAUNCHED)
    // No end written: its pid file's age stands in, a probation and the grace.
    until(null)
    expect(check()).toBe(0)
    const old = new Date(Date.now() - 30 * 60_000)
    fs.utimesSync(path.join(copies, 'probation.pid'), old, old)
    expect(check()).toBeNull()
  }, 60_000)
})
