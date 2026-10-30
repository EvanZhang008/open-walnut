import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SHARED_DAEMON_DIR,
  chooseLocalDaemonDir,
  exitTraceFileFor,
  isProductionDaemonDir,
  realDaemonDirDeps,
  userDaemonDir,
  type DaemonDirDeps,
} from '../../src/lib/daemon-dir.js'

const ME = 501
const OTHER = 502
const HOME = '/home/me'
const CACHE = '/home/me/.cache/open-walnut'

type Entry = { kind: 'dir' | 'file' | 'link'; uid: number; text?: string; mtimeMs?: number }

/** This machine booted at BOOT; files are written after it unless a test says otherwise. */
const BOOT = 1_000_000_000_000

/** A fake filesystem and process table: paths to entries, live pids. */
function deps(files: Record<string, Entry>, live: number[] = [], uid: number | null = ME, platform = 'linux'): DaemonDirDeps {
  return {
    lstat: (p) => {
      const e = files[p]
      if (!e) return null
      return { uid: e.uid, mtimeMs: e.mtimeMs ?? BOOT + 60_000, isDirectory: () => e.kind === 'dir', isFile: () => e.kind === 'file', isSymbolicLink: () => e.kind === 'link' } as fs.Stats
    },
    readFile: (p) => (files[p]?.kind === 'file' ? files[p].text ?? '' : null),
    alive: (pid) => live.includes(pid),
    uid: () => uid,
    userName: () => 'me',
    platform,
    bootTimeMs: () => BOOT,
  }
}

const USER_UNIT = `${HOME}/.config/systemd/user/open-walnut-daemon.service`
const SYSTEM_UNIT = '/etc/systemd/system/open-walnut-daemon.service'
const PLIST = `${HOME}/Library/LaunchAgents/dev.openwalnut.session-daemon.plist`
const unitPinning = (dir: string, user?: string) => `[Service]\n${user ? `User=${user}\n` : ''}Environment="WALNUT_DAEMON_DIR=${dir}"\n`

/** A daemon's pid and port files in `dir`, owned by `uid`. */
function daemonIn(dir: string, pid: number, uid = ME): Record<string, Entry> {
  return {
    [dir]: { kind: 'dir', uid },
    [`${dir}/daemon.pid`]: { kind: 'file', uid, text: `${pid}\n` },
    [`${dir}/daemon.port`]: { kind: 'file', uid, text: '41234' },
  }
}

const env = { HOME }

describe('chooseLocalDaemonDir', () => {
  it('uses WALNUT_DAEMON_DIR as given, whatever /tmp holds', () => {
    const c = chooseLocalDaemonDir({ HOME, WALNUT_DAEMON_DIR: '/tmp/x' }, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }))
    expect(c).toEqual({ dir: '/tmp/x', explicit: true, fallback: false })
  })

  it('uses /tmp/open-walnut on a fresh machine and for its owner', () => {
    expect(chooseLocalDaemonDir(env, deps({})).dir).toBe(SHARED_DAEMON_DIR)
    const c = chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME } }))
    expect(c).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, fallback: false })
  })

  it('moves a second user to $HOME/.cache/open-walnut', () => {
    const c = chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }))
    expect(c).toEqual({ dir: CACHE, explicit: false, fallback: true, reason: '/tmp/open-walnut belongs to another user' })
  })

  it('never uses a symlink or a file at /tmp/open-walnut', () => {
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'link', uid: ME } })).dir).toBe(CACHE)
    const file = chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'file', uid: ME } }))
    expect(file).toMatchObject({ dir: CACHE, reason: '/tmp/open-walnut is not a directory' })
  })

  it('keeps a running daemon where it is: the home dir even after /tmp/open-walnut is free again', () => {
    const c = chooseLocalDaemonDir(env, deps(daemonIn(CACHE, 4242), [4242]))
    expect(c).toMatchObject({ dir: CACHE, fallback: true, reason: 'the session daemon is running from there' })
  })

  it('a live daemon in /tmp/open-walnut wins over one in the home dir', () => {
    const c = chooseLocalDaemonDir(env, deps({ ...daemonIn(SHARED_DAEMON_DIR, 11), ...daemonIn(CACHE, 22) }, [11, 22]))
    expect(c.dir).toBe(SHARED_DAEMON_DIR)
  })

  it('a dead pid, a missing port file or a pid file of another user is no live daemon', () => {
    expect(chooseLocalDaemonDir(env, deps(daemonIn(CACHE, 4242), [])).dir).toBe(SHARED_DAEMON_DIR)
    const noPort = daemonIn(CACHE, 4242)
    delete noPort[`${CACHE}/daemon.port`]
    expect(chooseLocalDaemonDir(env, deps(noPort, [4242])).dir).toBe(SHARED_DAEMON_DIR)
    const planted = { ...daemonIn(CACHE, 4242), [`${CACHE}/daemon.pid`]: { kind: 'file' as const, uid: OTHER, text: '4242' } }
    expect(chooseLocalDaemonDir(env, deps(planted, [4242])).dir).toBe(SHARED_DAEMON_DIR)
    const pidOne = daemonIn(CACHE, 1)
    expect(chooseLocalDaemonDir(env, deps(pidOne, [1])).dir).toBe(SHARED_DAEMON_DIR)
  })

  it('another user\'s daemon in /tmp/open-walnut does not keep us there', () => {
    const c = chooseLocalDaemonDir(env, deps(daemonIn(SHARED_DAEMON_DIR, 77, OTHER), [77]))
    expect(c.dir).toBe(CACHE)
  })

  it('without a uid (Windows) or a home there is nothing to fall back to', () => {
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }, [], null)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir({ HOME: 'relative' }, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } })).dir).toBe(SHARED_DAEMON_DIR)
  })
})

describe('chooseLocalDaemonDir on the real filesystem', () => {
  it('root keeps /tmp/open-walnut, and only $HOME names the home dir', () => {
    const takenByOther = { [SHARED_DAEMON_DIR]: { kind: 'dir' as const, uid: OTHER } }
    expect(chooseLocalDaemonDir(env, deps(takenByOther, [], 0)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir({}, deps(takenByOther)).dir).toBe(SHARED_DAEMON_DIR)
    expect(userDaemonDir({})).toBeNull()
    expect(userDaemonDir({ HOME: 'relative' })).toBeNull()
  })

  it('follows this user\'s login service to the home dir, even with /tmp/open-walnut free', () => {
    const c = chooseLocalDaemonDir(env, deps({ [USER_UNIT]: { kind: 'file', uid: ME, text: unitPinning(CACHE) } }))
    expect(c).toEqual({ dir: CACHE, explicit: false, fallback: true, reason: 'the login service runs the session daemon from there' })
    const mac = chooseLocalDaemonDir(env, deps({ [PLIST]: { kind: 'file', uid: ME, text: `<key>WALNUT_DAEMON_DIR</key>\n\t\t<string>${CACHE}</string>` } }, [], ME, 'darwin'))
    expect(mac.dir).toBe(CACHE)
    // A system unit counts only when it runs this account.
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(CACHE, 'me') } })).dir).toBe(CACHE)
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(CACHE, 'someone') } })).dir).toBe(SHARED_DAEMON_DIR)
  })

  it('a pid file from before the last boot is no live daemon, whoever holds that pid now', () => {
    const files = daemonIn(CACHE, 4242)
    files[`${CACHE}/daemon.pid`] = { ...files[`${CACHE}/daemon.pid`], mtimeMs: BOOT - 3_600_000 }
    expect(chooseLocalDaemonDir(env, deps(files, [4242])).dir).toBe(SHARED_DAEMON_DIR)
    files[`${CACHE}/daemon.pid`] = { ...files[`${CACHE}/daemon.pid`], mtimeMs: BOOT + 1_000 }
    expect(chooseLocalDaemonDir(env, deps(files, [4242])).dir).toBe(CACHE)
  })

  it('leaves a free /tmp/open-walnut to the account whose system unit runs its daemon there', () => {
    const c = chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'someone') } }))
    expect(c.dir).toBe(CACHE)
    expect(c.reason).toMatch(/another user's login service/)
    // Our own unit there, or another account's unit somewhere else: the shared dir as usual.
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'me') } })).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning('/home/someone/.cache/open-walnut', 'someone') } })).dir).toBe(SHARED_DAEMON_DIR)
  })

  it('a service pinned to /tmp/open-walnut, or a daemon running there, is not overruled by the pin', () => {
    expect(chooseLocalDaemonDir(env, deps({ [USER_UNIT]: { kind: 'file', uid: ME, text: unitPinning(SHARED_DAEMON_DIR) } })).dir).toBe(SHARED_DAEMON_DIR)
    const files = { ...daemonIn(SHARED_DAEMON_DIR, 4242), [USER_UNIT]: { kind: 'file' as const, uid: ME, text: unitPinning(CACHE) } }
    expect(chooseLocalDaemonDir(env, deps(files, [4242])).dir).toBe(SHARED_DAEMON_DIR)
    // Pinned to /tmp/open-walnut, which another user now owns: the home dir, as for anyone else.
    const taken = { [SHARED_DAEMON_DIR]: { kind: 'dir' as const, uid: OTHER }, [USER_UNIT]: { kind: 'file' as const, uid: ME, text: unitPinning(SHARED_DAEMON_DIR) } }
    expect(chooseLocalDaemonDir(env, deps(taken)).dir).toBe(CACHE)
  })

  // Root always keeps /tmp/open-walnut, so this one needs an ordinary account.
  it.skipIf(process.getuid?.() === 0)('reads a real pid file and a real live process', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-dir-'))
    try {
      const cache = path.join(home, '.cache', 'open-walnut')
      fs.mkdirSync(cache, { recursive: true })
      fs.writeFileSync(path.join(cache, 'daemon.pid'), String(process.pid))
      fs.writeFileSync(path.join(cache, 'daemon.port'), '1')
      // This machine's own /tmp/open-walnut stays out of it.
      const real = { ...realDaemonDirDeps, lstat: (p: string) => (p.startsWith(SHARED_DAEMON_DIR) ? null : realDaemonDirDeps.lstat(p)) }
      expect(chooseLocalDaemonDir({ HOME: home }, real).dir).toBe(cache)
      fs.writeFileSync(path.join(cache, 'daemon.pid'), '999999999')
      expect(chooseLocalDaemonDir({ HOME: home }, real).dir).toBe(SHARED_DAEMON_DIR)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isProductionDaemonDir and exitTraceFileFor', () => {
  it('counts /tmp/open-walnut and this user\'s home dir, nothing else', () => {
    expect(isProductionDaemonDir('/tmp/open-walnut', env)).toBe(true)
    expect(isProductionDaemonDir('/tmp/open-walnut/', env)).toBe(true)
    expect(isProductionDaemonDir(CACHE, env)).toBe(true)
    expect(isProductionDaemonDir('/home/other/.cache/open-walnut', env)).toBe(false)
    expect(isProductionDaemonDir('/tmp/open-walnut-demo', env)).toBe(false)
    expect(userDaemonDir(env)).toBe(CACHE)
  })

  it('keeps /tmp/open-walnut-exit.log for the shared dir and writes inside any other', () => {
    expect(exitTraceFileFor('/tmp/open-walnut')).toBe('/tmp/open-walnut-exit.log')
    expect(exitTraceFileFor(CACHE)).toBe(`${CACHE}/exit.log`)
  })
})
