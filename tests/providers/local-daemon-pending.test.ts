/**
 * The pending slot of the build on its probation (local-daemon-replace.ts keepPendingBinary,
 * keepPreviousSource 'next', promotePending, discardPending). 2026-11-04 review 6: the build was
 * kept as the way back only at its window's end, from the file on disk, which a deploy inside the
 * 15 minutes had replaced already, so the way back became the build before it, or none; and the
 * source daemon's files of a build on its probation took the way back's place at the next deploy.
 *
 * MACHINE SAFETY: real files in this file's temp dir only (the kept dir's root is the test
 * setup's own, WALNUT_DAEMON_PREVIOUS_ROOT); no process is started.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  discardPending, keepPendingBinary, keepPreviousSource, keepRunningBinary, keptPrevious, previousDaemon, previousKeepDir, promotePending,
} from '../../src/providers/local-daemon-replace.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A Mac's daemon dir: the daemon binary on disk is `build`; A was kept as the way back when it served. */
async function macWithA(): Promise<{ dir: string; bin: string; put(build: string): void }> {
  const dir = fs.mkdtempSync(path.join(root, 'mac-'))
  const bin = path.join(dir, 'daemon-darwin-arm64')
  const put = (build: string) => { fs.writeFileSync(bin, `file of ${build}`, { mode: 0o755 }); fs.writeFileSync(`${bin}.version`, `${build}\n`) }
  put('walnut-daemon-A')
  expect(await keepRunningBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-A', platform: 'darwin', durable: true })).toBe(true)
  return { dir, bin, put }
}
const previousOf = (dir: string, bin: string, version: string) => previousDaemon({ daemonDir: dir, binaryPath: bin, compiledSelf: false, pid: null, version, platform: 'darwin', durable: true })

describe('the pending slot of a Mac daemon binary on its probation', () => {
  it('a deploy inside the window does not lose it: kept at its start, the way back once it passed', async () => {
    const { dir, bin, put } = await macWithA()
    // B replaces A and starts on its probation: its file waits beside the way back, which stays A.
    put('walnut-daemon-B')
    expect(await keepPendingBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-B', platform: 'darwin', durable: true })).toBe(true)
    expect(await keptPrevious(dir, bin)).toMatchObject({ version: 'walnut-daemon-A' })
    // A deploy brings C inside B's window.
    put('walnut-daemon-C')
    // B passed: its own file is the way back now, though the file on disk is C's.
    expect(await promotePending(dir, 'walnut-daemon-B')).toBe(true)
    const kept = await previousOf(dir, bin, 'walnut-daemon-B')
    expect(kept).toBe(path.join(previousKeepDir(dir), 'daemon-darwin-arm64'))
    expect(fs.readFileSync(kept!, 'utf8')).toBe('file of walnut-daemon-B')
    expect(await keptPrevious(dir, bin)).toEqual({ file: kept, version: 'walnut-daemon-B' })
    // Done with: the slot is empty, and a second promote finds nothing.
    expect(fs.existsSync(`${previousKeepDir(dir)}.next`)).toBe(false)
    expect(await promotePending(dir, 'walnut-daemon-B')).toBe(false)
  })

  it('one that did not pass is dropped: the way back stays the build before it', async () => {
    const { dir, bin, put } = await macWithA()
    put('walnut-daemon-B')
    await keepPendingBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-B', platform: 'darwin', durable: true })
    // Another build's promote takes nothing.
    expect(await promotePending(dir, 'walnut-daemon-other')).toBe(false)
    await discardPending(dir, 'walnut-daemon-B')
    expect(fs.existsSync(`${previousKeepDir(dir)}.next`)).toBe(false)
    expect(await promotePending(dir, 'walnut-daemon-B')).toBe(false)
    expect(fs.readFileSync((await previousOf(dir, bin, 'walnut-daemon-A'))!, 'utf8')).toBe('file of walnut-daemon-A')
  })

  it('nothing on Linux (the running process\'s own file is read there at the replacement), nor for a file of another build', async () => {
    const { dir, bin, put } = await macWithA()
    put('walnut-daemon-B')
    expect(await keepPendingBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-B', platform: 'linux', durable: true })).toBe(false)
    expect(await keepPendingBinary({ daemonDir: dir, binaryPath: bin, compiledSelf: false, version: 'walnut-daemon-X', platform: 'darwin', durable: true })).toBe(false)
    expect(fs.existsSync(`${previousKeepDir(dir)}.next`)).toBe(false)
  })
})

describe('the source daemon\'s files of a build on its probation', () => {
  const NAMES = ['daemon-fallback.cjs', 'daemon-fallback.cjs.version', 'task-dir-core.cjs']
  function sourceOf(dir: string, build: string): void {
    fs.writeFileSync(path.join(dir, 'daemon-fallback.cjs'), `source of ${build}`)
    fs.writeFileSync(path.join(dir, 'daemon-fallback.cjs.version'), build)
    fs.writeFileSync(path.join(dir, 'task-dir-core.cjs'), `sidecar of ${build}`)
  }

  it('wait beside the way back when the next build is written, and become it once the build passed', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'src-'))
    sourceOf(dir, 'walnut-daemon-A')
    await keepPreviousSource(dir, NAMES, 'walnut-daemon-A', undefined, true)
    // B was written and runs, on its probation; C is written now.
    sourceOf(dir, 'walnut-daemon-B')
    await keepPreviousSource(dir, NAMES, 'walnut-daemon-B', undefined, true, 'next')
    const script = path.join(dir, 'daemon-fallback.cjs')
    expect(fs.readFileSync(path.join(previousKeepDir(dir), 'daemon-fallback.cjs'), 'utf8')).toBe('source of walnut-daemon-A')
    expect(fs.existsSync(script)).toBe(false)
    expect(await previousDaemon({ daemonDir: dir, binaryPath: script, compiledSelf: false, pid: null, version: 'walnut-daemon-A' })).toBe(path.join(previousKeepDir(dir), 'daemon-fallback.cjs'))
    sourceOf(dir, 'walnut-daemon-C')
    // A second deploy within the window moves nothing over it (C's files are no build that ran).
    await keepPreviousSource(dir, NAMES, 'walnut-daemon-B', undefined, true, 'next')
    expect(fs.readFileSync(script, 'utf8')).toBe('source of walnut-daemon-C')
    // B passed.
    expect(await promotePending(dir, 'walnut-daemon-B')).toBe(true)
    const kept = await previousDaemon({ daemonDir: dir, binaryPath: script, compiledSelf: false, pid: null, version: 'walnut-daemon-B' })
    expect(kept).toBe(path.join(previousKeepDir(dir), 'daemon-fallback.cjs'))
    expect(fs.readFileSync(kept!, 'utf8')).toBe('source of walnut-daemon-B')
    expect(fs.readFileSync(path.join(previousKeepDir(dir), 'task-dir-core.cjs'), 'utf8')).toBe('sidecar of walnut-daemon-B')
  })
})

describe('a promote cut between its two renames', () => {
  it('leaves the way back as <keep dir>.old, which goes back before anything reads the keep dir', async () => {
    const { dir, bin } = await macWithA()
    const keep = previousKeepDir(dir)
    fs.renameSync(keep, `${keep}.old`)
    expect(await keptPrevious(dir, bin)).toEqual({ file: path.join(keep, 'daemon-darwin-arm64'), version: 'walnut-daemon-A' })
    expect(fs.existsSync(`${keep}.old`)).toBe(false)
  })
})
