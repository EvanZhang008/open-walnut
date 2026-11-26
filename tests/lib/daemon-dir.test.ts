import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAEMON_STATE_MARKERS,
  SHARED_DAEMON_DIR,
  chooseLocalDaemonDir,
  chooseLocalLogDir,
  exitTraceFileFor,
  isProductionDaemonDir,
  realDaemonDirDeps,
  userDaemonDir,
  type DaemonDirDeps,
} from '../../src/lib/daemon-dir.js'
import { GATEWAY_SOCKET_FILENAME } from '../../src/providers/gateway-core.js'

const ME = 501
const OTHER = 502
const HOME = '/home/me'
const CACHE = '/home/me/.cache/open-walnut'

type Entry = { kind: 'dir' | 'file' | 'link' | 'socket'; uid: number; text?: string; mtimeMs?: number }

/** This machine booted at BOOT; files are written after it unless a test says otherwise. */
const BOOT = 1_000_000_000_000

/** A fake filesystem and process table: paths to entries, live pids. `homeProblem`: why the home dir cannot hold the daemon. */
function deps(files: Record<string, Entry>, live: number[] = [], uid: number | null = ME, platform = 'linux', homeProblem: string | null = null): DaemonDirDeps {
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
    dirProblem: () => homeProblem,
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

/** What a daemon that ran in `dir` left there (no pid file: one that runs inside the server, or whose files the cleanup took). */
function stateIn(dir: string, names: string[] = ['daemon.instance', 'sessions.json'], mtimeMs = BOOT + 60_000, uid = ME): Record<string, Entry> {
  const out: Record<string, Entry> = { [dir]: { kind: 'dir', uid } }
  for (const name of names) out[`${dir}/${name}`] = { kind: name.endsWith('.sock') ? 'socket' : 'file', uid, mtimeMs }
  return out
}

const env = { HOME }

describe('chooseLocalDaemonDir: the session daemon\'s own dir', () => {
  it('uses WALNUT_DAEMON_DIR as given, whatever /tmp holds', () => {
    const c = chooseLocalDaemonDir({ HOME, WALNUT_DAEMON_DIR: '/tmp/x' }, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }))
    expect(c).toEqual({ dir: '/tmp/x', explicit: true, why: 'WALNUT_DAEMON_DIR names it' })
  })

  it('a fresh machine, and one whose /tmp/open-walnut holds only logs: the home dir, which no temp cleanup empties', () => {
    expect(chooseLocalDaemonDir(env, deps({}))).toEqual({ dir: CACHE, explicit: false, why: 'no temp cleanup empties it' })
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME } })).dir).toBe(CACHE)
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } })).dir).toBe(CACHE)
  })

  it('never uses a symlink or a file at /tmp/open-walnut', () => {
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'link', uid: ME } })).dir).toBe(CACHE)
    expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'file', uid: ME } }, [], ME, 'linux', 'it cannot be written')).dir).toBe(CACHE)
  })

  it('a running daemon keeps its dir: /tmp/open-walnut, or the home dir', () => {
    expect(chooseLocalDaemonDir(env, deps(daemonIn(SHARED_DAEMON_DIR, 11), [11]))).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, why: 'a session daemon is running there' })
    expect(chooseLocalDaemonDir(env, deps(daemonIn(CACHE, 4242), [4242]))).toEqual({ dir: CACHE, explicit: false, why: 'a session daemon is running there' })
  })

  it('a live daemon in /tmp/open-walnut wins over one in the home dir', () => {
    const c = chooseLocalDaemonDir(env, deps({ ...daemonIn(SHARED_DAEMON_DIR, 11), ...daemonIn(CACHE, 22) }, [11, 22]))
    expect(c.dir).toBe(SHARED_DAEMON_DIR)
  })

  it('another user\'s daemon in /tmp/open-walnut does not keep us there', () => {
    const c = chooseLocalDaemonDir(env, deps(daemonIn(SHARED_DAEMON_DIR, 77, OTHER), [77]))
    expect(c.dir).toBe(CACHE)
  })

  // The class of 2026-11-25: deciding "no daemon here" from files the cleanup took, then starting one elsewhere.
  describe('sessions started since this machine booted keep their dir', () => {
    const since = 'a session daemon ran there since this machine started, and its sessions may still run'

    it('a daemon that runs inside the server (no pid file) keeps /tmp/open-walnut across the server\'s restart', () => {
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR)))).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, why: since })
    })

    it('a daemon program that stopped (dead pid) keeps it too', () => {
      expect(chooseLocalDaemonDir(env, deps({ ...daemonIn(SHARED_DAEMON_DIR, 11), ...stateIn(SHARED_DAEMON_DIR) }, [])).dir).toBe(SHARED_DAEMON_DIR)
    })

    it.each(DAEMON_STATE_MARKERS.map((name) => [name]))('%s alone is enough', (name) => {
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR, [name]))).dir).toBe(SHARED_DAEMON_DIR)
    })

    it('the temp cleanup took every regular file of a running daemon: the socket it leaves is enough', () => {
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR, [GATEWAY_SOCKET_FILENAME]))).dir).toBe(SHARED_DAEMON_DIR)
    })

    it('files from before the last boot belong to nothing that runs: the home dir', () => {
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR, undefined, BOOT - 3_600_000))).dir).toBe(CACHE)
      // Within the uptime clock's slack of the boot: still counts.
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR, undefined, BOOT - 1_000))).dir).toBe(SHARED_DAEMON_DIR)
    })

    it('files of another user, a marker that is a dir or a link, or a dir that is not ours count for nothing', () => {
      expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME }, [`${SHARED_DAEMON_DIR}/sessions.json`]: { kind: 'file', uid: OTHER } })).dir).toBe(CACHE)
      expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME }, [`${SHARED_DAEMON_DIR}/sessions.json`]: { kind: 'dir', uid: ME } })).dir).toBe(CACHE)
      expect(chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME }, [`${SHARED_DAEMON_DIR}/daemon.instance`]: { kind: 'link', uid: ME } })).dir).toBe(CACHE)
      expect(chooseLocalDaemonDir(env, deps(stateIn(SHARED_DAEMON_DIR, undefined, undefined, OTHER))).dir).toBe(CACHE)
    })

    it('the home dir is kept the same way, and when both were used, the one written last', () => {
      expect(chooseLocalDaemonDir(env, deps(stateIn(CACHE)))).toEqual({ dir: CACHE, explicit: false, why: since })
      const both = { ...stateIn(SHARED_DAEMON_DIR, undefined, BOOT + 60_000), ...stateIn(CACHE, undefined, BOOT + 120_000) }
      expect(chooseLocalDaemonDir(env, deps(both)).dir).toBe(CACHE)
      const sharedLater = { ...stateIn(SHARED_DAEMON_DIR, undefined, BOOT + 180_000), ...stateIn(CACHE, undefined, BOOT + 120_000) }
      expect(chooseLocalDaemonDir(env, deps(sharedLater)).dir).toBe(SHARED_DAEMON_DIR)
    })

    it('a running daemon still wins over a dir that was only used', () => {
      expect(chooseLocalDaemonDir(env, deps({ ...stateIn(SHARED_DAEMON_DIR, undefined, BOOT + 999_000), ...daemonIn(CACHE, 22) }, [22])).dir).toBe(CACHE)
    })
  })

  it('a home dir that cannot hold the daemon leaves it in /tmp/open-walnut, and says why', () => {
    const c = chooseLocalDaemonDir(env, deps({}, [], ME, 'linux', 'its socket paths would be too long'))
    expect(c).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, why: `${CACHE} cannot hold it (its socket paths would be too long)` })
    // ... unless /tmp/open-walnut is another user's: the home dir, whose start then says what is wrong.
    const taken = chooseLocalDaemonDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }, [], ME, 'linux', 'it cannot be written'))
    expect(taken).toEqual({ dir: CACHE, explicit: false, why: '/tmp/open-walnut belongs to another user' })
  })

  it('without a uid (Windows), as root, or without a home there is only /tmp/open-walnut', () => {
    expect(chooseLocalDaemonDir(env, deps({}, [], null)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir(env, deps({}, [], 0)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir({ HOME: 'relative' }, deps({})).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir({}, deps({})).dir).toBe(SHARED_DAEMON_DIR)
    expect(userDaemonDir({})).toBeNull()
    expect(userDaemonDir({ HOME: 'relative' })).toBeNull()
  })

  it('a dead pid, a missing port file, a pid file of another user or from before the boot is no running daemon', () => {
    const noPort = daemonIn(SHARED_DAEMON_DIR, 4242)
    delete noPort[`${SHARED_DAEMON_DIR}/daemon.port`]
    // Not running, yet its pid file was written since the boot: its sessions may still run there.
    expect(chooseLocalDaemonDir(env, deps(noPort, [4242]))).toMatchObject({ dir: SHARED_DAEMON_DIR, why: expect.stringContaining('since this machine started') })
    const planted = { ...daemonIn(SHARED_DAEMON_DIR, 4242), [`${SHARED_DAEMON_DIR}/daemon.pid`]: { kind: 'file' as const, uid: OTHER, text: '4242' }, [`${SHARED_DAEMON_DIR}/daemon.port`]: { kind: 'file' as const, uid: OTHER, text: '1' } }
    expect(chooseLocalDaemonDir(env, deps(planted, [4242])).dir).toBe(CACHE)
    const old = daemonIn(SHARED_DAEMON_DIR, 4242)
    for (const f of ['daemon.pid', 'daemon.port']) old[`${SHARED_DAEMON_DIR}/${f}`] = { ...old[`${SHARED_DAEMON_DIR}/${f}`], mtimeMs: BOOT - 3_600_000 }
    expect(chooseLocalDaemonDir(env, deps(old, [4242])).dir).toBe(CACHE)
  })

  it('follows this user\'s login service to the dir it pins, either one', () => {
    const pinned = 'the login service runs the session daemon from there'
    expect(chooseLocalDaemonDir(env, deps({ [USER_UNIT]: { kind: 'file', uid: ME, text: unitPinning(CACHE) } }))).toEqual({ dir: CACHE, explicit: false, why: pinned })
    const mac = chooseLocalDaemonDir(env, deps({ [PLIST]: { kind: 'file', uid: ME, text: `<key>WALNUT_DAEMON_DIR</key>\n\t\t<string>${CACHE}</string>` } }, [], ME, 'darwin'))
    expect(mac.dir).toBe(CACHE)
    // An install from before the home dir was the default pins /tmp/open-walnut: its service starts there after a reboot.
    expect(chooseLocalDaemonDir(env, deps({ [USER_UNIT]: { kind: 'file', uid: ME, text: unitPinning(SHARED_DAEMON_DIR) } }))).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, why: pinned })
    // A system unit counts only when it runs this account.
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'me') } })).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalDaemonDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'someone') } })).dir).toBe(CACHE)
    // Pinned to /tmp/open-walnut, which another user now owns: the home dir, as for anyone else.
    const taken = { [SHARED_DAEMON_DIR]: { kind: 'dir' as const, uid: OTHER }, [USER_UNIT]: { kind: 'file' as const, uid: ME, text: unitPinning(SHARED_DAEMON_DIR) } }
    expect(chooseLocalDaemonDir(env, deps(taken)).dir).toBe(CACHE)
    // A daemon that runs wins over the pin.
    const files = { ...daemonIn(SHARED_DAEMON_DIR, 4242), [USER_UNIT]: { kind: 'file' as const, uid: ME, text: unitPinning(CACHE) } }
    expect(chooseLocalDaemonDir(env, deps(files, [4242])).dir).toBe(SHARED_DAEMON_DIR)
  })

  // Root always keeps /tmp/open-walnut, so this one needs an ordinary account.
  it.skipIf(process.getuid?.() === 0)('reads real files, a real live process and a real home dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-dir-'))
    try {
      const cache = path.join(home, '.cache', 'open-walnut')
      // This machine's own /tmp/open-walnut stays out of it.
      const real = { ...realDaemonDirDeps, lstat: (p: string) => (p.startsWith(SHARED_DAEMON_DIR) ? null : realDaemonDirDeps.lstat(p)) }
      // Nothing there yet: the home dir can be made, so it is the dir, and choosing made nothing.
      expect(chooseLocalDaemonDir({ HOME: home }, real)).toEqual({ dir: cache, explicit: false, why: 'no temp cleanup empties it' })
      expect(fs.existsSync(path.join(home, '.cache'))).toBe(false)
      fs.mkdirSync(cache, { recursive: true })
      fs.writeFileSync(path.join(cache, 'daemon.pid'), String(process.pid))
      fs.writeFileSync(path.join(cache, 'daemon.port'), '1')
      expect(chooseLocalDaemonDir({ HOME: home }, real).why).toBe('a session daemon is running there')
      fs.writeFileSync(path.join(cache, 'daemon.pid'), '999999999')
      expect(chooseLocalDaemonDir({ HOME: home }, real).why).toMatch(/since this machine started/)
      // A home dir this user cannot write, or one too deep for a socket path: /tmp/open-walnut.
      fs.rmSync(path.join(home, '.cache'), { recursive: true })
      fs.chmodSync(home, 0o500)
      expect(chooseLocalDaemonDir({ HOME: home }, real)).toMatchObject({ dir: SHARED_DAEMON_DIR, why: expect.stringContaining('cannot be written') })
      fs.chmodSync(home, 0o700)
      const deep = path.join(home, 'd'.repeat(90))
      expect(chooseLocalDaemonDir({ HOME: deep }, real)).toMatchObject({ dir: SHARED_DAEMON_DIR, why: expect.stringContaining('socket paths would be too long') })
    } finally {
      fs.chmodSync(home, 0o700)
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('the marker names are the daemon\'s own', () => {
    expect(DAEMON_STATE_MARKERS).toContain(GATEWAY_SOCKET_FILENAME)
    const daemon = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    for (const name of DAEMON_STATE_MARKERS.filter((n) => n !== GATEWAY_SOCKET_FILENAME)) expect(daemon).toContain(`'${name}')`)
  })
})

describe('chooseLocalLogDir: the server\'s scratch stays in /tmp/open-walnut', () => {
  it('uses WALNUT_DAEMON_DIR as given: one dir for everything in a test or an isolated server', () => {
    expect(chooseLocalLogDir({ HOME, WALNUT_DAEMON_DIR: '/tmp/x' }, deps({}))).toEqual({ dir: '/tmp/x', explicit: true, fallback: false })
  })

  // A daemon hands its own dir to every session it starts: a command run there must still find the server's logs.
  it('a WALNUT_DAEMON_DIR that names a production daemon dir names no log dir', () => {
    expect(chooseLocalLogDir({ HOME, WALNUT_DAEMON_DIR: CACHE }, deps({}))).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, fallback: false })
    expect(chooseLocalLogDir({ HOME, WALNUT_DAEMON_DIR: `${SHARED_DAEMON_DIR}/` }, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } })).dir).toBe(CACHE)
    // The daemon dir is still the one named.
    expect(chooseLocalDaemonDir({ HOME, WALNUT_DAEMON_DIR: CACHE }, deps({})).dir).toBe(CACHE)
  })

  it('/tmp/open-walnut on a fresh machine and for its owner, wherever the daemon is', () => {
    expect(chooseLocalLogDir(env, deps({})).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: ME } }))).toEqual({ dir: SHARED_DAEMON_DIR, explicit: false, fallback: false })
    expect(chooseLocalLogDir(env, deps(daemonIn(CACHE, 4242), [4242])).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir(env, deps({ [USER_UNIT]: { kind: 'file', uid: ME, text: unitPinning(CACHE) } })).dir).toBe(SHARED_DAEMON_DIR)
  })

  it('moves a second user to $HOME/.cache/open-walnut', () => {
    const c = chooseLocalLogDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'dir', uid: OTHER } }))
    expect(c).toEqual({ dir: CACHE, explicit: false, fallback: true, reason: '/tmp/open-walnut belongs to another user' })
  })

  it('never uses a symlink or a file at /tmp/open-walnut', () => {
    expect(chooseLocalLogDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'link', uid: ME } })).dir).toBe(CACHE)
    expect(chooseLocalLogDir(env, deps({ [SHARED_DAEMON_DIR]: { kind: 'file', uid: ME } }))).toMatchObject({ dir: CACHE, reason: '/tmp/open-walnut is not a directory' })
  })

  it('leaves a free /tmp/open-walnut to the account whose system unit runs its daemon there', () => {
    const c = chooseLocalLogDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'someone') } }))
    expect(c.dir).toBe(CACHE)
    expect(c.reason).toMatch(/another user's login service/)
    // Our own unit there, or another account's unit somewhere else: the shared dir as usual.
    expect(chooseLocalLogDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning(SHARED_DAEMON_DIR, 'me') } })).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir(env, deps({ [SYSTEM_UNIT]: { kind: 'file', uid: 0, text: unitPinning('/home/someone/.cache/open-walnut', 'someone') } })).dir).toBe(SHARED_DAEMON_DIR)
  })

  it('without a uid (Windows), as root, or without a home there is nothing to fall back to', () => {
    const takenByOther = { [SHARED_DAEMON_DIR]: { kind: 'dir' as const, uid: OTHER } }
    expect(chooseLocalLogDir(env, deps(takenByOther, [], null)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir(env, deps(takenByOther, [], 0)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir({ HOME: 'relative' }, deps(takenByOther)).dir).toBe(SHARED_DAEMON_DIR)
    expect(chooseLocalLogDir({}, deps(takenByOther)).dir).toBe(SHARED_DAEMON_DIR)
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
