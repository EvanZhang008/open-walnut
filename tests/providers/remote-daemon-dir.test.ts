/**
 * The daemon dir probe (remote-daemon-dir.ts): which dir the remote daemon
 * uses when /tmp/open-walnut cannot take it. The probe script is EXECUTED under
 * /bin/sh against temp dirs standing in for /tmp/open-walnut and
 * $HOME/.cache/open-walnut, so its shell (mkdir, write, exec test, df, the live
 * daemon check) is what is tested, not a string.
 *
 * MACHINE SAFETY: every path is inside a mkdtemp dir; the real /tmp/open-walnut
 * and the real ~/.cache are never named. The "live daemon" is this test's own
 * pid written into a temp pid file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MIN_DAEMON_FREE_MB, buildDaemonDirProbeScript, buildLiveDaemonScanScript, chooseDaemonDir, daemonDirEnv, daemonDirWarning,
  parseDaemonDirProbe, parseLiveDaemonScan, productionDaemonDirs, type DaemonDirProbe,
} from '../../src/providers/remote-daemon-dir.js'

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
  // Undo the permission tricks first, or rm cannot enter the dirs.
  for (const d of [path.join(root, 'tmp'), tmpDir, path.join(root, 'home')]) { try { fs.chmodSync(d, 0o700) } catch { /* absent */ } }
  fs.rmSync(root, { recursive: true, force: true })
})

function probe(opts: { writeTest?: boolean; minFreeMb?: number; tmpDir?: string } = {}): { raw: string; parsed: DaemonDirProbe } {
  const raw = execFileSync('/bin/sh', ['-s'], {
    input: buildDaemonDirProbeScript({ tmpDir, cacheDir, ...opts }),
    encoding: 'utf-8',
    env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home') },
  })
  const parsed = parseDaemonDirProbe(raw)
  expect(parsed).not.toBeNull()
  return { raw, parsed: parsed! }
}

function fakeLiveDaemon(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid))
  fs.writeFileSync(path.join(dir, 'daemon.port'), '41234')
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('daemon dir probe, executed', () => {
  it('a healthy /tmp is used and the home fallback is never created', () => {
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('ok')
    expect(typeof parsed.tmp.freeMb).toBe('number')
    expect(parsed.cache.status).toBe('unchecked')
    expect(fs.existsSync(cacheDir)).toBe(false)
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: tmpDir, fallback: false })
    // The probe leaves nothing behind but the dir itself, created owner-only.
    expect(fs.readdirSync(tmpDir)).toEqual([])
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700)
  })

  it('our own open-walnut dir left read-only is put back to owner-only and used', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.chmodSync(tmpDir, 0o500)
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('ok')
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700)
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: tmpDir, fallback: false })
  })

  it.skipIf(asRoot)('an open-walnut dir that cannot be created (the parent refuses) moves the daemon to the home fallback', () => {
    fs.chmodSync(path.join(root, 'tmp'), 0o500)
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('permission-denied')
    expect(parsed.cache.status).toBe('ok')
    const choice = chooseDaemonDir(parsed)
    expect(choice).toMatchObject({ path: cacheDir, fallback: true, reason: '/tmp/open-walnut is not writable (permission denied)' })
    expect(fs.existsSync(cacheDir)).toBe(true)
  })

  it('a symlink planted in place of the dir is never used, even though it is writable', () => {
    const elsewhere = path.join(root, 'planted-target')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, tmpDir)
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('not-owned')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: cacheDir, fallback: true, reason: '/tmp/open-walnut belongs to another user (or is a symlink)' })
    expect(fs.readdirSync(elsewhere)).toEqual([])  // nothing was written through the link
  })

  it('a daemon pid planted behind a symlink does not count as a live daemon', () => {
    const elsewhere = path.join(root, 'planted-live')
    fakeLiveDaemon(elsewhere)
    fs.symlinkSync(elsewhere, tmpDir)
    const { parsed } = probe()
    expect(parsed.tmp.live).toBe(false)
    expect(chooseDaemonDir(parsed).path).toBe(cacheDir)
  })

  it.skipIf(asRoot)('an existing dir another user owns (world-writable or not) is not-owned: fallback', () => {
    // /usr exists and belongs to root: the probe must refuse it before writing anything.
    const { parsed } = probe({ tmpDir: '/usr' })
    expect(parsed.tmp.status).toBe('not-owned')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: cacheDir, fallback: true })
  })

  it('a file squatting on the dir name is reported as such', () => {
    fs.writeFileSync(tmpDir, 'not a dir')
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('not-a-directory')
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: cacheDir, fallback: true })
  })

  it('a daemon already alive in the fallback wins, even once /tmp is fine again', () => {
    fakeLiveDaemon(cacheDir)
    const { parsed } = probe()
    expect(parsed.tmp.status).toBe('ok')
    expect(parsed.cache.live).toBe(true)
    expect(chooseDaemonDir(parsed)).toMatchObject({ path: cacheDir, fallback: true, reason: 'a daemon started there earlier is still running' })
  })

  it('a daemon alive in /tmp wins over everything', () => {
    fakeLiveDaemon(tmpDir)
    fakeLiveDaemon(cacheDir)
    expect(chooseDaemonDir(probe().parsed)).toMatchObject({ path: tmpDir, fallback: false })
  })

  it('a stale pid file is not a live daemon', () => {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'daemon.pid'), '999999')
    fs.writeFileSync(path.join(cacheDir, 'daemon.port'), '41234')
    const { parsed } = probe()
    expect(parsed.cache.live).toBe(false)
    expect(chooseDaemonDir(parsed).path).toBe(tmpDir)
  })

  it('a /tmp below the free-space floor moves to a home fallback with room', () => {
    // A floor above any real disk's free space makes /tmp "full" without filling a disk.
    const { parsed } = probe({ minFreeMb: 1e9 })
    expect(parsed.cache.status).toBe('ok')
    const tmpShaped = { ...parsed, cache: { ...parsed.cache, freeMb: 5_000 } }
    expect(chooseDaemonDir(tmpShaped, 1e9)).toMatchObject({ path: tmpDir, fallback: false })  // both "full": stay put
    expect(chooseDaemonDir({ ...parsed, tmp: { ...parsed.tmp, freeMb: 120 }, cache: { ...parsed.cache, freeMb: 5_000 } }))
      .toMatchObject({ path: cacheDir, fallback: true, reason: '/tmp is nearly full (120 MB free)' })
  })

  it('attach-only (no write test) never creates either dir', () => {
    const { parsed } = probe({ writeTest: false })
    expect(parsed.tmp.status).toBe('unchecked')
    expect(fs.existsSync(tmpDir)).toBe(false)
    expect(fs.existsSync(cacheDir)).toBe(false)
    expect(chooseDaemonDir(parsed).path).toBe(tmpDir)
  })

  it('reports arch and home for the rest of the connect', () => {
    const { parsed } = probe()
    expect(parsed.arch).toBe(execFileSync('uname', ['-m'], { encoding: 'utf-8' }).trim())
    expect(parsed.home).toBe(path.join(root, 'home'))
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
    fakeLiveDaemon(cacheDir)
    expect(scan([tmpDir, cacheDir])).toMatchObject({ dir: cacheDir, pid: process.pid, port: 41234 })
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
    tmp: { path: '/tmp/open-walnut', status: 'ok', freeMb: 9000, live: false },
    cache: { path: '/home/me/.cache/open-walnut', status: 'unchecked', live: false },
  }

  it.each([
    ['read-only', '/tmp is read-only'],
    ['noexec', '/tmp is mounted noexec'],
    ['full', '/tmp is full'],
  ] as const)('/tmp %s → the fallback, with the reason', (status, reason) => {
    const choice = chooseDaemonDir({ ...base, tmp: { ...base.tmp, status }, cache: { ...base.cache, status: 'ok', freeMb: 4000 } })
    expect(choice).toEqual({ path: '/home/me/.cache/open-walnut', fallback: true, reason, freeMb: 4000 })
    expect(daemonDirWarning(choice, '/home/me')).toBe(`Using \`~/.cache/open-walnut\` for the session daemon because ${reason.replace('/tmp', '`/tmp`')}.`)
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
