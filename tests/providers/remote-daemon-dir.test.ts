/**
 * The daemon dir probe (remote-daemon-dir.ts): which dir the remote daemon
 * uses ($HOME/.cache/open-walnut; a dir a daemon runs in, or wrote its files in since the
 * boot, is kept; /tmp/open-walnut when the home dir cannot take it). The probe script is EXECUTED under
 * /bin/sh against temp dirs standing in for /tmp/open-walnut and
 * $HOME/.cache/open-walnut, so its shell (mkdir, write, exec test, df, the live
 * daemon check) is what is tested, not a string.
 *
 * MACHINE SAFETY: every path is inside a mkdtemp dir; the real /tmp/open-walnut
 * and the real ~/.cache are never named. The "live daemon" is a child of this
 * test whose command line runs `<dir>/daemon-linux-x64 --start`, its pid written
 * into that dir's pid file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MIN_DAEMON_FREE_MB, buildDaemonDirProbeScript, buildLiveDaemonScanScript, chooseDaemonDir, daemonDirEnv, daemonDirWarning,
  parseDaemonDirProbe, parseLiveDaemonScan, productionDaemonDirs, type DaemonDirProbe,
} from '../../src/providers/remote-daemon-dir.js'
import { guardedPath } from '../setup/exec-guard.js'

let root = ''
let tmpDir = ''
let cacheDir = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dir-probe-'))
  tmpDir = path.join(root, 'tmp', 'open-walnut')
  cacheDir = path.join(root, 'home', '.cache', 'open-walnut')
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })
})

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  // Undo the permission tricks first, or rm cannot enter the dirs.
  for (const d of [path.join(root, 'tmp'), tmpDir, path.join(root, 'home')]) { try { fs.chmodSync(d, 0o700) } catch { /* absent */ } }
  fs.rmSync(root, { recursive: true, force: true })
})

function probe(opts: { writeTest?: boolean; minFreeMb?: number; tmpDir?: string; cacheDir?: string } = {}): { raw: string; parsed: DaemonDirProbe } {
  const raw = execFileSync('/bin/sh', ['-s'], {
    input: buildDaemonDirProbeScript({ tmpDir, cacheDir, ...opts }),
    encoding: 'utf-8',
    env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home') },
  })
  const parsed = parseDaemonDirProbe(raw)
  expect(parsed).not.toBeNull()
  return { raw, parsed: parsed! }
}

/** This test's own children: the stand-in daemons (a daemon's command line) and other processes. */
const children: ChildProcess[] = []
function child(args: string[]): number {
  // `; true` keeps sh from exec'ing sleep, so the command line stays the one given.
  const c = spawn('/bin/sh', ['-c', 'sleep 600; true', ...args], { stdio: 'ignore' })
  children.push(c)
  return c.pid!
}
/** A daemon of `dir` the way the Mac starts one (`<dir>/daemon-linux-x64 --start`, or another command line), alive, in its files. */
function fakeLiveDaemon(dir: string, args: string[] = [path.join(dir, 'daemon-linux-x64'), '--start']): number {
  const pid = child(args)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(pid))
  fs.writeFileSync(path.join(dir, 'daemon.port'), '41234')
  return pid
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** The files a daemon writes when it starts (no live process): what is left of one that stopped, or whose pid file the cleanup took. */
function daemonFilesIn(dir: string, at?: Date): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['daemon.instance', 'sessions.json']) {
    fs.writeFileSync(path.join(dir, name), 'x')
    if (at) fs.utimesSync(path.join(dir, name), at, at)
  }
}

describe('daemon dir probe, executed', () => {
  it('a fresh host: the home dir is used and /tmp/open-walnut is never created', () => {
    const { parsed } = probe()
    expect(parsed.cache.status).toBe('ok')
    expect(typeof parsed.cache.freeMb).toBe('number')
    expect(parsed.tmp.status).toBe('unchecked')
    expect(fs.existsSync(tmpDir)).toBe(false)
    expect(chooseDaemonDir(parsed)).toEqual({ path: cacheDir, fallback: true, freeMb: parsed.cache.freeMb })
    expect(daemonDirWarning(chooseDaemonDir(parsed), path.join(root, 'home'))).toBeUndefined()
    // The probe leaves nothing behind but the dir itself, created owner-only.
    expect(fs.readdirSync(cacheDir)).toEqual([])
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700)
  })

  it('our own open-walnut dir left read-only is put back to owner-only and used', () => {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.chmodSync(cacheDir, 0o500)
    const { parsed } = probe()
    expect(parsed.cache.status).toBe('ok')
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700)
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: cacheDir, fallback: true })
  })

  it.skipIf(asRoot)('a home dir that cannot take the daemon (it refuses the dir) leaves it on /tmp/open-walnut, and says so', () => {
    fs.chmodSync(path.join(root, 'home'), 0o500)
    const { parsed } = probe()
    expect(parsed.cache.status).toBe('permission-denied')
    expect(parsed.tmp.status).toBe('ok')
    const choice = chooseDaemonDir(parsed)
    expect(choice).toMatchObject({ path: tmpDir, fallback: false, reason: '~/.cache/open-walnut is not writable (permission denied)' })
    expect(daemonDirWarning(choice)).toBe(`Using \`${tmpDir}\` for the session daemon because \`~/.cache/open-walnut\` is not writable (permission denied). The system's temp cleanup removes files there that nobody touched for days.`)
    expect(fs.existsSync(tmpDir)).toBe(true)
  })

  it('a symlink planted in place of the home dir is never used, even though it is writable', () => {
    const elsewhere = path.join(root, 'planted-target')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    fs.symlinkSync(elsewhere, cacheDir)
    const { parsed } = probe()
    expect(parsed.cache.status).toBe('not-owned')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: tmpDir, fallback: false, reason: '~/.cache/open-walnut belongs to another user (or is a symlink)' })
    expect(fs.readdirSync(elsewhere)).toEqual([])  // nothing was written through the link
  })

  // The class of 2026-11-25: whoever decides "no daemon here" must not move away from sessions that may still run.
  it('a daemon that wrote its files in /tmp/open-walnut since the boot keeps the host there, alive or not', () => {
    daemonFilesIn(tmpDir)
    const { parsed } = probe()
    expect(parsed.tmp.live).toBe(false)
    expect(parsed.tmp.usedAt).toBeGreaterThan(0)
    expect(parsed.cache.usedAt).toBe(0)
    expect(fs.existsSync(cacheDir)).toBe(false)
    const choice = chooseDaemonDir(parsed)
    expect(choice).toMatchObject({ path: tmpDir, fallback: false })
    expect(choice.reason).toBeUndefined()
  })

  it('only the socket the temp cleanup leaves behind is enough to keep the host on /tmp/open-walnut', async () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    const net = await import('node:net')
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(path.join(tmpDir, 'agent-gateway.sock'), resolve))
    try {
      const { parsed } = probe()
      expect(parsed.tmp.usedAt).toBeGreaterThan(0)
      expect(chooseDaemonDir(parsed).path).toBe(tmpDir)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('files from before the boot keep nothing: the home dir', () => {
    daemonFilesIn(tmpDir, new Date(Date.now() - 400 * 24 * 3600_000))
    const { parsed } = probe()
    expect(parsed.tmp.usedAt).toBe(0)
    expect(chooseDaemonDir(parsed).path).toBe(cacheDir)
  })

  it('both dirs used since the boot: the one written last', () => {
    daemonFilesIn(tmpDir, new Date(Date.now() - 3600_000))
    daemonFilesIn(cacheDir, new Date(Date.now() - 60_000))
    expect(chooseDaemonDir(probe().parsed).path).toBe(cacheDir)
    daemonFilesIn(tmpDir)
    expect(chooseDaemonDir(probe().parsed).path).toBe(tmpDir)
  })

  it('a daemon pid planted behind a symlink does not count as a live daemon', () => {
    const elsewhere = path.join(root, 'planted-live')
    fakeLiveDaemon(elsewhere)
    fs.symlinkSync(elsewhere, tmpDir)
    const { parsed } = probe()
    expect(parsed.tmp.live).toBe(false)
    expect(parsed.tmp.usedAt).toBe(0)
    expect(chooseDaemonDir(parsed).path).toBe(cacheDir)
  })

  it.skipIf(asRoot)('an existing dir another user owns (world-writable or not) is not-owned: /tmp/open-walnut', () => {
    // /usr exists and belongs to root: the probe must refuse it before writing anything.
    const { parsed } = probe({ cacheDir: '/usr' })
    expect(parsed.cache.status).toBe('not-owned')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: tmpDir, fallback: false })
  })

  it('a file squatting on the dir name is reported as such', () => {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    fs.writeFileSync(cacheDir, 'not a dir')
    const { parsed } = probe()
    expect(parsed.cache.status).toBe('not-a-directory')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: tmpDir, fallback: false, reason: '~/.cache/open-walnut is a file, not a directory' })
  })

  it('a daemon alive in the home dir wins, and reads as nothing unusual', () => {
    fakeLiveDaemon(cacheDir)
    daemonFilesIn(tmpDir)
    const { parsed } = probe()
    expect(parsed.cache.live).toBe(true)
    const choice = chooseDaemonDir(parsed)
    expect(choice).toMatchObject({ path: cacheDir, fallback: true })
    expect(choice.reason).toBeUndefined()
  })

  it('a daemon alive in /tmp wins over everything', () => {
    fakeLiveDaemon(tmpDir)
    fakeLiveDaemon(cacheDir)
    expect(chooseDaemonDir(probe().parsed)).toMatchObject({ path: tmpDir, fallback: false })
  })

  // 2026-10-23: a restarted container reuses pids, so a dead daemon's pid file can
  // name another live process; taking it for the daemon pointed every connect at
  // the dead daemon's port until that process ended.
  it('a pid file naming a live process that is no daemon is not a live daemon', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), String(child(['sshd:', 'walnut'])))
    fs.writeFileSync(path.join(tmpDir, 'daemon.port'), '41000')
    expect(probe().parsed.tmp.live).toBe(false)
    const out = execFileSync('/bin/sh', ['-s'], { input: buildLiveDaemonScanScript([tmpDir]), encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(out.trim()).toBe('walnut-live none')
    // The same files naming a daemon's pid: live.
    fakeLiveDaemon(tmpDir)
    expect(probe().parsed.tmp.live).toBe(true)
  })

  // A daemon is this dir's daemon file run as `--start` (or an OS service's
  // `.../daemon --service`), not any command line that happens to say `--start`.
  it.each([
    ['another program started with --start', (): string[] => ['some-tool', '--start'], false],
    ["another dir's daemon", (): string[] => [path.join(root, 'other', 'daemon-linux-x64'), '--start'], false],
    ['this dir\'s daemon file with more after --start', (): string[] => [path.join(tmpDir, 'daemon-linux-x64'), '--start', '--extra'], false],
    ['the source under bun', (): string[] => ['/home/me/.bun/bin/bun', path.join(tmpDir, 'daemon.cjs'), '--start'], true],
    ['the source under node', (): string[] => ['node', path.join(tmpDir, 'daemon.cjs'), '--start'], true],
    ["an OS service's daemon", (): string[] => [path.join(root, 'svc', 'versions', 'abc', 'daemon'), '--service'], true],
  ] as const)('the identity check: %s → live %s', (_label, args, live) => {
    fakeLiveDaemon(tmpDir, args())
    expect(probe().parsed.tmp.live).toBe(live)
    const out = execFileSync('/bin/sh', ['-s'], { input: buildLiveDaemonScanScript([tmpDir]), encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(out.trim() === 'walnut-live none').toBe(!live)
  })

  it('a stale pid file is not a live daemon', () => {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'daemon.pid'), '999999')
    fs.writeFileSync(path.join(cacheDir, 'daemon.port'), '41234')
    const { parsed } = probe()
    expect(parsed.cache.live).toBe(false)
    // Written just now, so since the boot: sessions it started may still run there.
    expect(chooseDaemonDir(parsed).path).toBe(cacheDir)
  })

  it('a home dir below the free-space floor leaves the daemon on a /tmp with room', () => {
    // A floor above any real disk's free space makes the home dir "full" without filling a disk.
    const { parsed } = probe({ minFreeMb: 1e9 })
    expect(parsed.cache.status).toBe('ok')
    expect(parsed.tmp.status).toBe('ok')  // checked, because the home dir is below the floor
    expect(chooseDaemonDir(parsed, 1e9)).toMatchObject({ path: cacheDir, fallback: true })  // both "full": the home dir
    expect(chooseDaemonDir({ ...parsed, cache: { ...parsed.cache, freeMb: 120 }, tmp: { ...parsed.tmp, freeMb: 5_000 } }))
      .toMatchObject({ path: tmpDir, fallback: false, reason: 'the home dir is nearly full (120 MB free)' })
  })

  it('attach-only (no write test) never creates either dir', () => {
    const { parsed } = probe({ writeTest: false })
    expect(parsed.tmp.status).toBe('unchecked')
    expect(parsed.cache.status).toBe('unchecked')
    expect(fs.existsSync(tmpDir)).toBe(false)
    expect(fs.existsSync(cacheDir)).toBe(false)
    expect(chooseDaemonDir(parsed).path).toBe(cacheDir)
  })

  it('reports arch and home for the rest of the connect', () => {
    const { parsed } = probe()
    expect(parsed.arch).toBe(execFileSync('uname', ['-m'], { encoding: 'utf-8' }).trim())
    expect(parsed.home).toBe(path.join(root, 'home'))
    // uname -s, so a machine that is not Linux is told apart before any upload.
    expect(parsed.os).toBe(execFileSync('uname', ['-s'], { encoding: 'utf-8' }).trim())
  })
})

describe('live daemon scan across both production dirs, executed', () => {
  function scan(dirs: string[]): ReturnType<typeof parseLiveDaemonScan> {
    const out = execFileSync('/bin/sh', ['-s'], { input: buildLiveDaemonScanScript(dirs), encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })
    return parseLiveDaemonScan(out, dirs)
  }

  it('finds the live one, the chosen dir first, with the runtime from its command line', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '999999')  // stale
    fs.writeFileSync(path.join(tmpDir, 'daemon.port'), '41000')
    const cachePid = fakeLiveDaemon(cacheDir)
    expect(scan([tmpDir, cacheDir])).toMatchObject({ dir: cacheDir, pid: cachePid, port: 41234, runtime: 'binary' })
    fakeLiveDaemon(tmpDir)
    expect(scan([tmpDir, cacheDir])?.dir).toBe(tmpDir)
    expect(scan([cacheDir, tmpDir])?.dir).toBe(cacheDir)
  })

  it('nothing live (or only behind a symlink) reads as none; a HOME with a space still works', () => {
    expect(scan([tmpDir, cacheDir])).toBeNull()
    const spaced = path.join(root, 'John Smith', '.cache', 'open-walnut')
    fakeLiveDaemon(spaced)
    expect(scan([tmpDir, spaced])?.dir).toBe(spaced)
    const link = path.join(root, 'linked')
    fs.symlinkSync(spaced, link)
    expect(scan([link])).toBeNull()
  })

  it('productionDaemonDirs: the chosen dir first, then the other production one; a test dir stands alone', () => {
    expect(productionDaemonDirs('/tmp/open-walnut', '/home/me')).toEqual(['/tmp/open-walnut', '/home/me/.cache/open-walnut'])
    expect(productionDaemonDirs('/home/me/.cache/open-walnut', '/home/me')).toEqual(['/home/me/.cache/open-walnut', '/tmp/open-walnut'])
    expect(productionDaemonDirs('/tmp/open-walnut', null)).toEqual(['/tmp/open-walnut'])
    expect(productionDaemonDirs('/tmp/walnut-test-x', '/home/me')).toEqual(['/tmp/walnut-test-x'])
    expect(parseLiveDaemonScan('walnut-live dir=5 pid=1 port=2 runtime=bun', ['/a'])).toBeNull()
    expect(parseLiveDaemonScan('walnut-live dir=0 pid=1 port=99999 runtime=bun', ['/a'])).toBeNull()
  })
})

describe('daemon dir choice (pure)', () => {
  const base: DaemonDirProbe = {
    home: '/home/me',
    tmp: { path: '/tmp/open-walnut', status: 'ok', freeMb: 9000, live: false, usedAt: 0 },
    cache: { path: '/home/me/.cache/open-walnut', status: 'ok', freeMb: 4000, live: false, usedAt: 0 },
  }

  it.each([
    ['read-only', '~/.cache/open-walnut is read-only', '`~/.cache/open-walnut` is read-only'],
    ['noexec', 'the home dir is mounted noexec', 'the home dir is mounted noexec'],
    ['full', 'the home dir is full', 'the home dir is full'],
    ['no-home', 'this account has no home dir', 'this account has no home dir'],
  ] as const)('the home dir %s → /tmp/open-walnut, with the reason', (status, reason, shown) => {
    const choice = chooseDaemonDir({ ...base, cache: { ...base.cache, status } })
    expect(choice).toEqual({ path: '/tmp/open-walnut', fallback: false, reason, freeMb: 9000 })
    expect(daemonDirWarning(choice, '/home/me')).toBe(`Using \`/tmp/open-walnut\` for the session daemon because ${shown}. The system's temp cleanup removes files there that nobody touched for days.`)
  })

  it('no $HOME at all (no home dir path): /tmp/open-walnut', () => {
    expect(chooseDaemonDir({ ...base, cache: { status: 'no-home', live: false } })).toMatchObject({ path: '/tmp/open-walnut', fallback: false, reason: 'this account has no home dir' })
  })

  it('an older reply without the used-since-boot lines reads as not used', () => {
    const raw = ['walnut-dir-probe v1', 'tmp_path=/tmp/open-walnut', 'tmp_live=0', 'tmp=ok', 'cache_path=/home/me/.cache/open-walnut', 'cache_live=0', 'cache=ok', 'walnut-dir-probe-done'].join('\n')
    const parsed = parseDaemonDirProbe(raw)!
    expect(parsed.tmp.usedAt).toBe(0)
    expect(chooseDaemonDir(parsed).path).toBe('/home/me/.cache/open-walnut')
  })

  it('neither dir usable: stays on /tmp, flagged, so the start error says why', () => {
    const choice = chooseDaemonDir({ ...base, tmp: { ...base.tmp, status: 'read-only' }, cache: { ...base.cache, status: 'read-only' } })
    expect(choice).toMatchObject({ path: '/tmp/open-walnut', fallback: false, unusable: true })
    expect(daemonDirWarning(choice)).toMatch(/Neither/)
  })

  it('the start env pins the dir and the production streams dir; /tmp keeps an env-free start', () => {
    expect(daemonDirEnv({ path: '/tmp/open-walnut', fallback: false })).toEqual({})
    expect(daemonDirEnv({ path: '/home/me/.cache/open-walnut', fallback: true }, '/home/me/')).toEqual({
      WALNUT_DAEMON_DIR: '/home/me/.cache/open-walnut',
      WALNUT_STREAMS_DIR: '/home/me/.open-walnut/tmp/streams',
    })
  })

  it('an unparseable reply (old stub, cut off) keeps the default', () => {
    expect(parseDaemonDirProbe('')).toBeNull()
    expect(parseDaemonDirProbe('walnut-dir-probe v1\ntmp=ok\n')).toBeNull()
  })

  it('the floor is 200 MB', () => {
    expect(MIN_DAEMON_FREE_MB).toBe(200)
  })
})
