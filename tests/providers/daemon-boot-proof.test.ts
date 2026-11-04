/**
 * The trial run before a service change (src/providers/daemon-boot-proof.ts), with fake
 * daemon executables: sh scripts that exit at once, listen and stay up, listen and then
 * die, or never listen. A refusal names why; a boot that holds proceeds; the trial runs
 * on dirs of its own with none of this process's env, and leaves no process and no dir.
 *
 * MACHINE SAFETY: every file is under this file's temp dir; the only processes are /bin/sh
 * and sleep, children of the code under test, which signals only its own child's group.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { proveDaemonBoot, STALE_PROOF_MS, sweepProofDirs, trialRuntimeDir } from '../../src/providers/daemon-boot-proof.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-proof-test-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
beforeEach(() => { work = fs.mkdtempSync(path.join(root, 'case-')) })

function fake(name: string, body: string[]): string {
  const file = path.join(work, name)
  fs.writeFileSync(file, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
  return file
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const opts = (executable: string) => ({ executable, args: ['--service'], path: '/usr/bin:/bin', base: work, waitMs: 3_000, aliveMs: 600 })
/** The fake writes what it saw here, outside the trial's own dir (which is removed). */
const seen = () => path.join(work, 'seen')

// Listens the way the daemon says it does: the port file in its daemon dir, then its pid.
const LISTEN = ['mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 40123 > "$WALNUT_DAEMON_DIR/daemon.port"', 'echo $$ > "$WALNUT_DAEMON_DIR/daemon.pid"']

describe('the trial run of a new daemon executable', () => {
  it('refuses one that exits at once, with what it said', async () => {
    const exe = fake('dies', ['echo "fatal: Host boot identity is unavailable" >&2', 'exit 3'])
    const why = await proveDaemonBoot(opts(exe))
    expect(why).toBe('it exited with 3 before it listened: fatal: Host boot identity is unavailable')
    expect(fs.readdirSync(work).filter((name) => name.startsWith('walnut-proof-'))).toEqual([])
  })

  it('proceeds with one that listens and stays up, then stops it and removes its dirs', async () => {
    const exe = fake('boots', [
      `env > '${seen()}'`, `echo "args=$*" >> '${seen()}'`, `echo "pid=$$" >> '${seen()}'`,
      ...LISTEN, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done',
    ])
    expect(await proveDaemonBoot(opts(exe))).toBeNull()

    const env = Object.fromEntries(fs.readFileSync(seen(), 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    expect(env.args).toBe('--service')
    // Its own dirs for everything the daemon derives at startup, all under one trial dir.
    const trial = path.dirname(env.HOME)
    expect(path.basename(trial)).toMatch(/^walnut-proof-/)
    for (const key of ['WALNUT_DAEMON_DIR', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_STREAMS_DIR', 'WALNUT_LEGACY_STREAMS_DIR', 'WALNUT_SPAWN_JOURNAL', 'WALNUT_JOURNAL_DIR', 'WALNUT_TASK_DIR_ROOT', 'XDG_STATE_HOME', 'TMPDIR']) {
      expect(env[key], key).toMatch(new RegExp(`^${trial}/`))
    }
    expect(env.PATH).toBe('/usr/bin:/bin')
    // Nothing of this process's own setup leaks in.
    for (const key of ['CLAUDE_CONFIG_DIR', 'WALNUT_HOME_OVERRIDE', 'WALNUT_DAEMON_SUPERVISOR', 'VITEST', 'NODE_ENV']) expect(env[key], key).toBeUndefined()
    expect(fs.existsSync(trial)).toBe(false)
    expect(alive(Number(env.pid))).toBe(false)
  })

  it('refuses one that listens and then dies', async () => {
    const exe = fake('flaps', [...LISTEN, 'sleep 0.2', 'echo "panic: the registry could not be read" >&2', 'exit 1'])
    expect(await proveDaemonBoot(opts(exe))).toBe('it listened, then exited with 1: panic: the registry could not be read')
  })

  it('refuses one that never listens, and stops it', async () => {
    const exe = fake('hangs', [`echo "pid=$$" > '${seen()}'`, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done'])
    expect(await proveDaemonBoot({ ...opts(exe), waitMs: 800 })).toBe('it did not listen within 1 s')
    expect(alive(Number(fs.readFileSync(seen(), 'utf8').trim().slice(4)))).toBe(false)
  })

  it('refuses a path that is not there', async () => {
    expect(await proveDaemonBoot(opts(path.join(work, 'missing')))).toMatch(/^it could not be started \(.*ENOENT/)
  })

  it('tries once more in a dir of another name when the lock port was taken', async () => {
    const exe = fake('locked', [`echo "$WALNUT_DAEMON_DIR" >> '${seen()}'`, 'echo "DaemonLockConflictError: lock port 23456 held by another dir" >&2', 'exit 1'])
    expect(await proveDaemonBoot(opts(exe))).toMatch(/^it exited with 1 before it listened: DaemonLockConflictError/)
    const dirs = fs.readFileSync(seen(), 'utf8').trim().split('\n')
    expect(dirs).toHaveLength(2)
    expect(new Set(dirs).size).toBe(2)
  })
})

// 2026-11-04 review 4: the CLI's trial (`walnut daemon update`) passed no WALNUT_RUNTIME_DIR, so
// the compiled walnut file unpacked its whole runtime into the throwaway HOME on every update.
describe('the trial of the compiled walnut file finds its runtime tree outside the throwaway HOME', () => {
  it('a trial given no runtime dir gets the one the account uses, never one under its HOME', async () => {
    const exe = fake('runtime', [`env > '${seen()}'`, ...LISTEN, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done'])
    expect(await proveDaemonBoot(opts(exe))).toBeNull()
    const env = Object.fromEntries(fs.readFileSync(seen(), 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    expect(env.WALNUT_RUNTIME_DIR).toBe(trialRuntimeDir())
    expect(env.WALNUT_RUNTIME_DIR.startsWith(path.dirname(env.HOME))).toBe(false)
    // One the caller names wins.
    expect(await proveDaemonBoot({ ...opts(exe), env: { WALNUT_RUNTIME_DIR: path.join(work, 'own-runtime') } })).toBeNull()
    expect(fs.readFileSync(seen(), 'utf8')).toMatch(new RegExp(`^WALNUT_RUNTIME_DIR=${path.join(work, 'own-runtime')}$`, 'm'))
  })

  it('beside the running compiled file\'s own tree, else this process\'s own dir, else the data home\'s', () => {
    expect(trialRuntimeDir({}, '/home/u', '/home/u/.open-walnut/local/runtime/1.2.3-abc')).toBe('/home/u/.open-walnut/local/runtime')
    expect(trialRuntimeDir({ WALNUT_RUNTIME_DIR: '/stage/runtime' }, '/home/u', null)).toBe('/stage/runtime')
    expect(trialRuntimeDir({ OPEN_WALNUT_HOME: '/data/walnut' }, '/home/u', null)).toBe('/data/walnut/local/runtime')
    expect(trialRuntimeDir({ OPEN_WALNUT_HOME: 'relative' }, '/home/u', null)).toBe('/home/u/.open-walnut/local/runtime')
  })
})

describe('a trial whose prover died leaves nothing for good (2026-11-04 review)', () => {
  it('tells the daemon its lifetime: a little past the wait, the alive check and the stop', async () => {
    const exe = fake('lifetime', [`env > '${seen()}'`, ...LISTEN, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done'])
    expect(await proveDaemonBoot(opts(exe))).toBeNull()
    // 3 s wait + 0.6 s alive, rounded up, plus the 30 s margin.
    expect(fs.readFileSync(seen(), 'utf8')).toMatch(/^WALNUT_DAEMON_LIFETIME_SECONDS=34$/m)
  })

  it('sweeps proof dirs older than the stale age whose daemon is gone, and keeps fresh ones and live ones', async () => {
    const make = (name: string, pid?: number) => {
      const dir = path.join(work, name)
      fs.mkdirSync(path.join(dir, 'd'), { recursive: true })
      if (pid) fs.writeFileSync(path.join(dir, 'd', 'daemon.pid'), String(pid))
      return dir
    }
    const dead = make('walnut-proof-Dead01', 2 ** 22 + 4242)
    const live = make('walnut-proof-Live01', process.pid)
    const fresh = make('walnut-proof-Frsh01')
    const other = make('walnut-proofish-xx')
    const old = new Date(Date.now() - STALE_PROOF_MS - 60_000)
    for (const dir of [dead, live, other]) fs.utimesSync(dir, old, old)
    expect(await sweepProofDirs(work)).toBe(1)
    expect(fs.existsSync(dead)).toBe(false)
    for (const dir of [live, fresh, other]) expect(fs.existsSync(dir)).toBe(true)
  })

  it('the next trial sweeps first', async () => {
    const left = path.join(work, 'walnut-proof-Left01')
    fs.mkdirSync(left)
    const old = new Date(Date.now() - STALE_PROOF_MS - 60_000)
    fs.utimesSync(left, old, old)
    const exe = fake('after-sweep', [...LISTEN, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done'])
    expect(await proveDaemonBoot(opts(exe))).toBeNull()
    expect(fs.existsSync(left)).toBe(false)
  })
})

// 2026-11-04 review: a Mac that slept mid-trial woke to a wall clock past every deadline and
// called a healthy build "did not listen within 60 s". Timers stop during sleep; Date.now does not.
describe('the trial\'s deadlines are monotonic', () => {
  it('a wall clock that jumps an hour ahead mid-trial (a sleep and a wake) does not end the wait', async () => {
    const exe = fake('slow-listen', ['sleep 1', ...LISTEN, 'trap "exit 0" TERM', 'while :; do sleep 0.1; done'])
    const real = Date.now
    // The first reads are before the sleep (the sweep, the deadline); every later one after the wake.
    let reads = 0
    const jump = vi.spyOn(Date, 'now').mockImplementation(() => real() + (++reads > 2 ? 60 * 60_000 : 0))
    try {
      expect(await proveDaemonBoot({ ...opts(exe), waitMs: 5_000 })).toBeNull()
    } finally { jump.mockRestore() }
  })
})
