/**
 * A daemon the server starts itself is replaced like a service (src/providers/local-daemon-replace.ts):
 * the new build serves in a trial run first, and the files of the old one are kept to start it
 * again. Real files and processes: a stand-in daemon (a shell script that writes its port file),
 * and a copy of /bin/sleep run as a "daemon binary"
 * whose own file the kept copy is read from (/proc, Linux only).
 *
 * MACHINE SAFETY: everything lives in this file's temp dir; the only processes are the trial's
 * stand-in (stopped by the boot proof, its own group) and one `sleep` this file starts and ends.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'
import {
  daemonLaunch, isDaemonScript, KeepFailedError, keepRunningBinary as keepRunningBinaryIn, keptPrevious, PREVIOUS_DIR,
  previousDaemon as previousDaemonIn, previousKeepDir, previousKeyOf, trialDaemon,
} from '../../src/providers/local-daemon-replace.js'
import { fileIdentity, setSingleFile } from '../../src/lib/single-file.js'

// As the production daemon dir keeps them (durable: the dir that survives a reboot); a throwaway dir's own tests pass false.
const keepRunningBinary = (o: Parameters<typeof keepRunningBinaryIn>[0]) => keepRunningBinaryIn({ durable: true, ...o })
const previousDaemon = (o: Parameters<typeof previousDaemonIn>[0]) => previousDaemonIn({ durable: true, ...o })

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-replace-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function fakeDaemon(name: string, body: string[]): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
  return file
}

describe('the trial run of a new build', () => {
  it('passes a build that listens and stays up', async () => {
    const good = fakeDaemon('daemon-good', ['mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 30'])
    expect(await trialDaemon(good, false, { PATH: guardedPath([], '/usr/bin:/bin') })).toBeNull()
  }, 30_000)

  it('refuses a build that dies in its startup, with what it said', async () => {
    const bad = fakeDaemon('daemon-bad', ['echo "SyntaxError: Unexpected token" >&2', 'exit 1'])
    expect(await trialDaemon(bad, false, { PATH: guardedPath([], '/usr/bin:/bin') })).toMatch(/exited with 1 before it listened: SyntaxError: Unexpected token/)
  }, 30_000)
})

describe('the old daemon kept to go back to', () => {
  // 2026-11-04 review: a copy that failed read as "nothing to keep", so the old daemon was stopped
  // with no way back, and a full disk is just what makes the new build fail on the real dir.
  it.runIf(process.platform === 'linux')('a copy of the running binary that fails (a full disk) is a failure to keep, never "nothing to keep"', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'full-'))
    const running = path.join(dir, 'run', 'daemon-linux-x64')
    fs.mkdirSync(path.dirname(running))
    fs.copyFileSync('/bin/sleep', running)
    fs.chmodSync(running, 0o755)
    const child = spawn(running, ['30'], { stdio: 'ignore' })
    const full = vi.spyOn(fsp, 'copyFile').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }))
    try {
      // The process runs that file (its own file is what is kept).
      await vi.waitFor(() => expect(fs.readlinkSync(`/proc/${child.pid}/exe`)).toBe(running), { timeout: 5_000, interval: 20 })
      // The disk is full in both places it may go (the kept dir, then beside the daemon's files).
      await expect(previousDaemon({ daemonDir: dir, binaryPath: path.join(dir, 'daemon-linux-x64'), compiledSelf: false, pid: child.pid!, version: 'walnut-daemon-old' }))
        .rejects.toBeInstanceOf(KeepFailedError)
      for (const keep of [previousKeepDir(dir), path.join(dir, PREVIOUS_DIR)]) expect(fs.existsSync(path.join(keep, 'daemon-linux-x64'))).toBe(false)
    } finally { full.mockRestore(); child.kill('SIGTERM') }
  })

  it('a Mac with no clone yet: one is made at the replacement while the file still is the running build; one that fails is a failure to keep', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'mac-first-'))
    const bin = path.join(dir, 'daemon-darwin-arm64')
    fs.writeFileSync(bin, 'build old', { mode: 0o755 })
    fs.writeFileSync(`${bin}.version`, 'walnut-daemon-old\n')
    const o = { daemonDir: dir, binaryPath: bin, compiledSelf: false, pid: null, version: 'walnut-daemon-old', platform: 'darwin' }
    // The disk is full in both places it may go (the kept dir, then beside the daemon's files).
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const full = vi.spyOn(fsp, 'copyFile').mockRejectedValueOnce(enospc()).mockRejectedValueOnce(enospc())
    try {
      await expect(previousDaemon(o)).rejects.toBeInstanceOf(KeepFailedError)
    } finally { full.mockRestore() }
    expect(await previousDaemon(o)).toBe(path.join(previousKeepDir(dir), 'daemon-darwin-arm64'))
    // The known gap: a deploy already put the new build there, so there is nothing to keep.
    fs.rmSync(previousKeepDir(dir), { recursive: true })
    fs.writeFileSync(`${bin}.version`, 'walnut-daemon-new\n')
    expect(await previousDaemon(o)).toBeNull()
  })

  it.runIf(process.platform === 'linux')('a daemon binary on Linux: the running process\'s own file, even after a deploy removed it', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'bin-'))
    const running = path.join(dir, 'run', 'daemon-linux-x64')
    fs.mkdirSync(path.dirname(running))
    fs.copyFileSync('/bin/sleep', running)
    fs.chmodSync(running, 0o755)
    const child = spawn(running, ['30'], { stdio: 'ignore' })
    try {
      // The process runs that file before the deploy removes it.
      await vi.waitFor(() => expect(fs.readlinkSync(`/proc/${child.pid}/exe`)).toBe(running), { timeout: 5_000, interval: 20 })
      fs.rmSync(running)
      const kept = await previousDaemon({ daemonDir: dir, binaryPath: path.join(dir, 'daemon-linux-x64'), compiledSelf: false, pid: child.pid!, version: 'walnut-daemon-old' })
      expect(kept).toBe(path.join(previousKeepDir(dir), 'daemon-linux-x64'))
      expect(fs.readFileSync(kept!).equals(fs.readFileSync('/bin/sleep'))).toBe(true)
      // A process that is not its own daemon file (node, bun running a script): nothing kept that way.
      expect(await previousDaemon({ daemonDir: dir, binaryPath: path.join(dir, 'daemon-darwin-arm64'), compiledSelf: false, pid: child.pid!, version: 'walnut-daemon-old' })).toBeNull()
    } finally { child.kill('SIGTERM') }
  })

  // 2026-11-04 review: the compiled walnut file kept none, so a release upgrade of a compiled
  // install without a service left the machine with no daemon when the new build died on the real data.
  it.runIf(process.platform === 'linux')('the compiled walnut file on Linux: the running daemon\'s own file, copied and stamped', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'walnut-'))
    const running = path.join(dir, 'run', 'walnut')
    fs.mkdirSync(path.dirname(running))
    fs.copyFileSync('/bin/sleep', running)
    fs.chmodSync(running, 0o755)
    const child = spawn(running, ['30'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      // An npm update replaced it on disk.
      fs.rmSync(running)
      const kept = await previousDaemon({ daemonDir: dir, binaryPath: path.join(dir, 'walnut'), compiledSelf: true, pid: child.pid!, version: 'walnut-daemon-old' })
      expect(kept).toBe(path.join(previousKeepDir(dir), 'walnut'))
      expect(fs.readFileSync(kept!).equals(fs.readFileSync('/bin/sleep'))).toBe(true)
      expect(await keptPrevious(dir, path.join(dir, 'walnut'))).toEqual({ file: kept, version: 'walnut-daemon-old' })
    } finally { child.kill('SIGTERM') }
  })

  it('the compiled walnut file on a Mac: a clone kept once its daemon served, judged by the file\'s identity, never a file an update replaced', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'mac-'))
    const walnut = path.join(dir, 'walnut')
    fs.writeFileSync(walnut, 'build one', { mode: 0o755 })
    const key = '__WALNUT_SINGLE_FILE__'
    const before = (globalThis as Record<string, unknown>)[key]
    setSingleFile({ root: dir, daemonVersion: 'walnut-daemon-one', modules: {}, execId: fileIdentity(walnut) })
    try {
      const o = { daemonDir: dir, binaryPath: walnut, compiledSelf: true, platform: 'darwin' }
      expect(await keepRunningBinary({ ...o, version: 'walnut-daemon-one' })).toBe(true)
      expect(fs.readFileSync(path.join(previousKeepDir(dir), 'walnut'), 'utf8')).toBe('build one')
      expect(await keptPrevious(dir, walnut)).toEqual({ file: path.join(previousKeepDir(dir), 'walnut'), version: 'walnut-daemon-one' })
      // An npm update writes the next build in its place (a new file): no copy of that is taken for this build.
      fs.writeFileSync(`${walnut}.new`, 'build two', { mode: 0o755 })
      fs.renameSync(`${walnut}.new`, walnut)
      fs.rmSync(previousKeepDir(dir), { recursive: true })
      expect(await keepRunningBinary({ ...o, version: 'walnut-daemon-one' })).toBe(false)
      expect(fs.existsSync(path.join(previousKeepDir(dir), 'walnut'))).toBe(false)
    } finally {
      if (before === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = before
    }
  })

  // 2026-11-04 review 4: the copies lived in <daemon dir>/previous, /tmp/open-walnut/previous by
  // default, so a reboot inside the build's day off lost them and the next start ran the refused build.
  it('the copies live in a dir that survives a reboot, one per daemon dir, never in the daemon dir', () => {
    const dir = fs.mkdtempSync(path.join(root, 'where-'))
    const keep = previousKeepDir(dir)
    expect(keep.startsWith(dir)).toBe(false)
    expect(path.basename(keep)).toBe(previousKeyOf(dir))
    expect(previousKeepDir(dir)).not.toBe(previousKeepDir(`${dir}-other`))
    expect(previousKeepDir('/tmp/open-walnut', { XDG_STATE_HOME: '/state' }, '/home/u')).toBe(path.join('/state/open-walnut/daemon-previous', previousKeyOf('/tmp/open-walnut')))
    expect(previousKeepDir('/tmp/open-walnut', {}, '/home/u')).toBe(path.join('/home/u/.local/state/open-walnut/daemon-previous', previousKeyOf('/tmp/open-walnut')))
    // Every machine and the SSH host's shell name a dir the same way.
    expect(previousKeyOf('/tmp/open-walnut')).toBe(previousKeyOf('/tmp//open-walnut/'))
  })

  it('a copy kept in <daemon dir>/previous by an older build is still read; a /tmp cleared by a reboot keeps the new ones', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'legacy-'))
    const bin = path.join(dir, 'daemon-darwin-arm64')
    fs.mkdirSync(path.join(dir, PREVIOUS_DIR))
    fs.writeFileSync(path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'), 'build old', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64.version'), 'walnut-daemon-old\n')
    expect(await keptPrevious(dir, bin)).toEqual({ file: path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'), version: 'walnut-daemon-old' })
    expect(await previousDaemon({ daemonDir: dir, binaryPath: bin, compiledSelf: false, pid: null, version: 'walnut-daemon-old', platform: 'darwin' })).toBe(path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'))
    // A clone kept now goes to the kept dir, and is what a start after a reboot (the daemon dir emptied) finds.
    fs.writeFileSync(bin, 'build old', { mode: 0o755 })
    fs.writeFileSync(`${bin}.version`, 'walnut-daemon-old\n')
    fs.rmSync(path.join(dir, PREVIOUS_DIR), { recursive: true })
    expect(await keepRunningBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-old', platform: 'darwin' })).toBe(true)
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    expect(await keptPrevious(dir, bin)).toEqual({ file: path.join(previousKeepDir(dir), 'daemon-darwin-arm64'), version: 'walnut-daemon-old' })
  })

  // 2026-11-04 review 5: every throwaway server (a deploy's smoke boot, an ephemeral server) left a
  // copy of its daemon in the real home, one per temp daemon dir, and nothing removed them.
  it('a throwaway daemon dir keeps its copies beside its files, gone with it, never in the home', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'throwaway-'))
    const bin = path.join(dir, 'daemon-darwin-arm64')
    fs.writeFileSync(bin, 'build old', { mode: 0o755 })
    fs.writeFileSync(`${bin}.version`, 'walnut-daemon-old\n')
    expect(await keepRunningBinaryIn({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-old', platform: 'darwin' })).toBe(true)
    expect(fs.readFileSync(path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'), 'utf8')).toBe('build old')
    expect(fs.existsSync(previousKeepDir(dir))).toBe(false)
  })

  // 2026-11-04 review 5: a home that could not take the copy (a quota, a full disk) failed the keep
  // every time, and the daemon was never replaced; the copy beside the daemon's files still works.
  it('a home that cannot take the copy keeps it beside the daemon\'s files, and the newest copy is the one read', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'nohome-'))
    const blocked = path.join(root, `blocked-${path.basename(dir)}`)
    fs.writeFileSync(blocked, 'a file where the kept root would be')
    const was = process.env.WALNUT_DAEMON_PREVIOUS_ROOT
    process.env.WALNUT_DAEMON_PREVIOUS_ROOT = path.join(blocked, 'daemon-previous')
    try {
      const bin = path.join(dir, 'daemon-darwin-arm64')
      fs.writeFileSync(bin, 'build two', { mode: 0o755 })
      fs.writeFileSync(`${bin}.version`, 'walnut-daemon-two\n')
      expect(await keepRunningBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-two', platform: 'darwin' })).toBe(true)
      expect(await previousDaemon({ daemonDir: dir, binaryPath: bin, compiledSelf: false, pid: null, version: 'walnut-daemon-two', platform: 'darwin' })).toBe(path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'))
    } finally {
      if (was === undefined) delete process.env.WALNUT_DAEMON_PREVIOUS_ROOT
      else process.env.WALNUT_DAEMON_PREVIOUS_ROOT = was
    }
    // An older build's copy left in the kept dir is not taken over the newer one beside the files.
    const old = path.join(previousKeepDir(dir), 'daemon-darwin-arm64')
    fs.mkdirSync(previousKeepDir(dir), { recursive: true })
    fs.writeFileSync(old, 'build one', { mode: 0o755 })
    fs.writeFileSync(`${old}.version`, 'walnut-daemon-one\n')
    const earlier = new Date(Date.now() - 3600_000)
    fs.utimesSync(`${old}.version`, earlier, earlier)
    const bin = path.join(dir, 'daemon-darwin-arm64')
    expect(await keptPrevious(dir, bin)).toEqual({ file: path.join(dir, PREVIOUS_DIR, 'daemon-darwin-arm64'), version: 'walnut-daemon-two' })
  })

  it('a daemon script (its source under bun, or the runtime bundle) starts on this runtime, a compiled copy as itself', () => {
    expect(isDaemonScript('/d/daemon-standalone.ts')).toBe(true)
    expect(isDaemonScript('/d/daemon-standalone.js')).toBe(true)
    expect(isDaemonScript('/d/daemon-linux-x64')).toBe(false)
    expect(isDaemonScript('/d/daemon.cjs')).toBe(false)
    expect(daemonLaunch('/d/daemon-standalone.ts', false)).toEqual({ cmd: process.execPath, args: ['/d/daemon-standalone.ts', '--start'] })
    expect(daemonLaunch('/d/daemon-linux-x64', false)).toEqual({ cmd: '/d/daemon-linux-x64', args: ['--start'] })
  })

  it('a kept copy of the compiled file starts as `<copy> --start`, so it unpacks its own tree', () => {
    expect(daemonLaunch('/d/previous/walnut', false)).toEqual({ cmd: '/d/previous/walnut', args: ['--start'] })
  })
})
