/**
 * scripts/lib/daemon-dir.sh is the shell copy of src/lib/daemon-dir.ts (where the server's logs
 * and the local session daemon's files are). Both are run here on the same real directories, case
 * by case, and must name the same dir: a script that looks for the daemon somewhere else than the
 * server does reads another daemon's files, or none.
 *
 * MACHINE SAFETY: every path is inside a mkdtemp dir. The shell takes its shared dir, its /etc and
 * its boot time from test seams (_WD_SHARED, _WD_ETC, _WD_BOOT); the TypeScript rule reads the same
 * dirs through remapped deps. The real /tmp/open-walnut and the real home are never named.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { SHARED_DAEMON_DIR, chooseLocalDaemonDir, chooseLocalLogDir, realDaemonDirDeps, type DaemonDirDeps } from '../../src/lib/daemon-dir.js'
import { guardedPath } from '../setup/exec-guard.js'

const SCRIPT = path.join(__dirname, '../../scripts/lib/daemon-dir.sh')
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const NOW_S = Math.floor(Date.now() / 1000)
/** The machine "booted" an hour ago. */
const BOOT_S = NOW_S - 3600

let root = ''
let shared = ''
let home = ''
let cache = ''
let etc = ''

beforeEach(() => {
  // A short root: the home dir's socket paths must fit, as on a real machine.
  root = fs.mkdtempSync(path.join(os.tmpdir().length < 40 ? os.tmpdir() : '/tmp', 'wd-'))
  shared = path.join(root, 'shared')
  home = path.join(root, 'home')
  cache = path.join(home, '.cache', 'open-walnut')
  etc = path.join(root, 'etc')
  fs.mkdirSync(home)
  fs.mkdirSync(etc)
})

afterEach(() => {
  for (const d of [home, root]) { try { fs.chmodSync(d, 0o700) } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true })
})

type Where = 'shared' | 'home' | string

/** The shell's answer for both dirs. */
function shell(env: Record<string, string> = {}): { daemon: Where; log: Where } {
  const out = execFileSync('/bin/sh', ['-c', `. "${SCRIPT}"; walnut_daemon_dir; walnut_log_dir`], {
    encoding: 'utf-8',
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, _WD_SHARED: shared, _WD_ETC: etc, _WD_BOOT: String(BOOT_S), ...env },
  }).trim().split('\n')
  const name = (dir: string): Where => (dir === shared ? 'shared' : dir === cache ? 'home' : dir)
  return { daemon: name(out[0]), log: name(out[1]) }
}

/** The server's answer on the same dirs. */
function server(env: Record<string, string> = {}, platform = 'linux'): { daemon: Where; log: Where } {
  const map = (p: string): string => {
    if (p === SHARED_DAEMON_DIR || p.startsWith(SHARED_DAEMON_DIR + '/')) return shared + p.slice(SHARED_DAEMON_DIR.length)
    if (p.startsWith('/etc/systemd/system/')) return path.join(etc, p.slice('/etc/systemd/system/'.length))
    return p
  }
  const deps: DaemonDirDeps = {
    ...realDaemonDirDeps,
    lstat: (p) => realDaemonDirDeps.lstat(map(p)),
    readFile: (p) => realDaemonDirDeps.readFile(map(p)),
    bootTimeMs: () => BOOT_S * 1000,
    platform,
  }
  const e = { HOME: home, ...env }
  const name = (dir: string): Where => (dir === SHARED_DAEMON_DIR ? 'shared' : dir === cache ? 'home' : dir)
  return { daemon: name(chooseLocalDaemonDir(e, deps).dir), log: name(chooseLocalLogDir(e, deps).dir) }
}

function write(dir: string, name: string, text = 'x', ageS = 0): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), text)
  if (ageS) { const at = new Date((NOW_S - ageS) * 1000); fs.utimesSync(path.join(dir, name), at, at) }
}

const unit = (dir: string, user?: string) => `[Service]\n${user ? `User=${user}\n` : ''}Environment="WALNUT_DAEMON_DIR=${dir}"\n`

/** Both rules must agree, and say what the case expects. */
function both(expected: { daemon: Where; log: Where }, env: Record<string, string> = {}): void {
  const sh = shell(env)
  expect(sh, 'the shell copy and the server disagree').toEqual(server(env))
  expect(sh).toEqual(expected)
}

describe.skipIf(process.platform === 'win32' || asRoot)('scripts/lib/daemon-dir.sh names the dirs the server names', () => {
  it('a fresh machine: the daemon in the home dir, the logs in the shared temp dir', () => {
    both({ daemon: 'home', log: 'shared' })
  })

  it('a shared dir that holds only logs does not hold the daemon', () => {
    write(shared, 'open-walnut-2026-11-26.log')
    both({ daemon: 'home', log: 'shared' })
  })

  it('WALNUT_DAEMON_DIR names both', () => {
    both({ daemon: '/somewhere/else', log: '/somewhere/else' }, { WALNUT_DAEMON_DIR: '/somewhere/else' })
  })

  it('a WALNUT_DAEMON_DIR that names a production daemon dir (a session inherits its daemon\'s) names no log dir', () => {
    expect(shell({ WALNUT_DAEMON_DIR: cache })).toEqual({ daemon: 'home', log: 'shared' })
    expect(server({ WALNUT_DAEMON_DIR: cache })).toEqual({ daemon: 'home', log: 'shared' })
    expect(shell({ WALNUT_DAEMON_DIR: shared })).toEqual({ daemon: 'shared', log: 'shared' })
    expect(server({ WALNUT_DAEMON_DIR: SHARED_DAEMON_DIR })).toEqual({ daemon: 'shared', log: 'shared' })
  })

  it('a daemon that runs keeps its dir, the shared one first', () => {
    write(cache, 'daemon.pid', String(process.pid))
    write(cache, 'daemon.port', '41234')
    both({ daemon: 'home', log: 'shared' })
    write(shared, 'daemon.pid', String(process.pid))
    write(shared, 'daemon.port', '41234')
    both({ daemon: 'shared', log: 'shared' })
  })

  it('a daemon that stopped, or runs inside the server, keeps the dir it wrote in since the boot', () => {
    write(shared, 'daemon.pid', '999999999')
    write(shared, 'daemon.port', '41234')
    both({ daemon: 'shared', log: 'shared' })
    fs.rmSync(shared, { recursive: true })
    write(shared, 'sessions.json')
    write(shared, 'daemon.instance')
    both({ daemon: 'shared', log: 'shared' })
  })

  it('the socket the temp cleanup leaves is enough', async () => {
    fs.mkdirSync(shared)
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(path.join(shared, 'agent-gateway.sock'), resolve))
    try {
      both({ daemon: 'shared', log: 'shared' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('files from before the boot keep nothing', () => {
    write(shared, 'sessions.json', 'x', 7200)
    write(shared, 'daemon.instance', 'x', 7200)
    both({ daemon: 'home', log: 'shared' })
  })

  it('both dirs used since the boot: the one written last', () => {
    write(shared, 'sessions.json', 'x', 1800)
    write(cache, 'sessions.json', 'x', 600)
    both({ daemon: 'home', log: 'shared' })
    write(shared, 'daemon.instance', 'x', 60)
    both({ daemon: 'shared', log: 'shared' })
  })

  it('a login service of ours keeps the dir it pins, either one', () => {
    write(path.join(home, '.config', 'systemd', 'user'), 'open-walnut-daemon.service', unit(SHARED_DAEMON_DIR))
    // The shell reads the unit for its own shared dir's name.
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service'), unit(SHARED_DAEMON_DIR).replace(SHARED_DAEMON_DIR, shared))
    expect(shell().daemon).toBe('shared')
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service'), unit(SHARED_DAEMON_DIR))
    expect(server().daemon).toBe('shared')
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service'), unit(cache))
    write(shared, 'sessions.json')
    both({ daemon: 'home', log: 'shared' })
  })

  // The three places review found the two rules apart (2026-11-26).
  it('the cron boot script pins a dir as a unit does', () => {
    write(shared, 'sessions.json')
    write(path.join(home, '.local', 'share', 'open-walnut', 'daemon'), 'daemon-boot.sh', `#!/bin/sh\nexport WALNUT_DAEMON_DIR='${cache}'\nexec daemon\n`)
    both({ daemon: 'home', log: 'shared' })
  })

  it('a LaunchAgent pins only by its WALNUT_DAEMON_DIR key, on one line or two', () => {
    write(shared, 'sessions.json')
    const agents = path.join(home, 'Library', 'LaunchAgents')
    const plist = (body: string) => write(agents, 'dev.openwalnut.session-daemon.plist', `<plist><dict>${body}</dict></plist>`)
    // The home dir only as another key's value: no pin.
    plist(`<key>WorkingDirectory</key><string>${cache}</string>`)
    expect(shell().daemon).toBe('shared')
    expect(server({}, 'darwin').daemon).toBe('shared')
    plist(`<key>EnvironmentVariables</key>\n<dict>\n\t<key>WALNUT_DAEMON_DIR</key>\n\t<string>${cache}</string>\n</dict>`)
    expect(shell().daemon).toBe('home')
    expect(server({}, 'darwin').daemon).toBe('home')
  })

  it('two dirs written in the same second are a tie: the home dir', () => {
    const second = (NOW_S - 600) * 1000
    write(cache, 'sessions.json')
    write(shared, 'sessions.json')
    fs.utimesSync(path.join(cache, 'sessions.json'), new Date(second + 100), new Date(second + 100))
    fs.utimesSync(path.join(shared, 'sessions.json'), new Date(second + 600), new Date(second + 600))
    both({ daemon: 'home', log: 'shared' })
  })

  it('a free shared dir that another account\'s system unit runs its daemon from is left to it', () => {
    fs.writeFileSync(path.join(etc, 'open-walnut-daemon.service'), unit(shared, 'someone-else'))
    expect(shell()).toEqual({ daemon: 'home', log: 'home' })
    fs.writeFileSync(path.join(etc, 'open-walnut-daemon.service'), unit(SHARED_DAEMON_DIR, 'someone-else'))
    expect(server()).toEqual({ daemon: 'home', log: 'home' })
  })

  it('a symlink or a file in place of the shared dir is never used', () => {
    fs.mkdirSync(path.join(root, 'elsewhere'))
    write(path.join(root, 'elsewhere'), 'sessions.json')
    fs.symlinkSync(path.join(root, 'elsewhere'), shared)
    both({ daemon: 'home', log: 'home' })
    fs.rmSync(shared)
    fs.writeFileSync(shared, 'not a dir')
    both({ daemon: 'home', log: 'home' })
  })

  it('a home dir that cannot hold the daemon leaves it in the shared dir', () => {
    fs.chmodSync(home, 0o500)
    both({ daemon: 'shared', log: 'shared' })
    fs.chmodSync(home, 0o700)
    const deep = path.join(home, 'd'.repeat(90))
    const sh = shell({ HOME: deep })
    expect(sh.daemon).toBe('shared')
    expect(server({ HOME: deep }).daemon).toBe('shared')
  })
})
