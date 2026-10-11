/**
 * scripts/install.sh, run as `curl ... | sh` runs it, against a local server
 * laid out like GitHub Releases (scripts/release-rehearsal/runtime.mjs): stand-in
 * archives whose `bin/walnut` prints a version, so each case takes milliseconds.
 * The real archive is installed this way by the CI rehearsal and by
 * release-archives.yml before upload.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publishLocally, serveReleases } from '../../scripts/release-rehearsal/runtime.mjs'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/install.sh')
const TARGET = `${process.platform}-${process.arch}`
let scratch = ''
let releases = ''
let server: { url: string; close: () => Promise<void> }

/** A stand-in archive: `bin/walnut` prints `printed` (default: its own version). */
function fakeArchive(version: string, { target = TARGET, printed = `${version} (abc12345, 2026-10-04)` } = {}): Promise<string> {
  const stem = `open-walnut-${version}-${target}`
  const dir = fs.mkdtempSync(path.join(scratch, 'pack-'))
  fs.mkdirSync(path.join(dir, stem, 'bin'), { recursive: true })
  for (const name of ['walnut', 'open-walnut']) {
    fs.writeFileSync(path.join(dir, stem, 'bin', name), `#!/bin/sh\necho '${printed}'\n`, { mode: 0o755 })
  }
  const file = path.join(dir, `${stem}.tar.gz`)
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', file, '-C', dir, stem], { env: { ...process.env, COPYFILE_DISABLE: '1' } }, (err) => (err ? reject(err) : resolve(file)))
  })
}

async function release(version: string, archive: Promise<string>, latest = true): Promise<void> {
  publishLocally(releases, version, await archive, { latest })
}

interface Run { code: number; out: string; home: string }
function install(home: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile('/bin/sh', [SCRIPT], {
      env: {
        // A system PATH with no Node, behind the test guard (which holds no Node either).
        PATH: guardedPath([], '/usr/bin:/bin:/usr/sbin:/sbin'), HOME: home,
        OPEN_WALNUT_RELEASE_BASE_URL: server.url,
        OPEN_WALNUT_RELEASES_API: `${server.url}/api.json`,
        ...env,
      },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`, home }))
  })
}

const freshHome = () => fs.mkdtempSync(path.join(scratch, 'home-'))
const appDir = (home: string) => path.join(home, '.local/share/open-walnut/app')
const walnut = (home: string) => path.join(home, '.local/bin/walnut')
function printed(home: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(walnut(home), ['--version'], (err, out) => (err ? reject(err) : resolve(out.trim()))))
}
function leftovers(home: string): string[] {
  return fs.readdirSync(path.join(home, '.local/share/open-walnut')).filter((n) => n !== 'app')
}

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-sh-')))
  releases = path.join(scratch, 'releases')
  fs.mkdirSync(releases)
  server = await serveReleases(releases)
})
afterAll(async () => {
  await server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(releases, { recursive: true, force: true })
  fs.mkdirSync(releases)
})

describe('install.sh', () => {
  it('installs the newest release, named by its checksums, and links walnut into ~/.local/bin', async () => {
    await release('0.7.0', fakeArchive('0.7.0'), false)
    await release('0.8.0', fakeArchive('0.8.0'))
    const r = await install(freshHome())
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Installed Open Walnut 0.8.0')
    expect(await printed(r.home)).toBe('0.8.0 (abc12345, 2026-10-04)')
    expect(fs.readlinkSync(walnut(r.home))).toBe(path.join(appDir(r.home), 'bin/walnut'))
    expect(fs.existsSync(path.join(r.home, '.local/bin/open-walnut'))).toBe(true)
    // ~/.local/bin is not on this PATH, and the user is told so.
    expect(r.out).toContain(`Add ${path.join(r.home, '.local/bin')} to your PATH`)
    expect(leftovers(r.home)).toEqual([])
  })

  // The Mac app reads the percentage off the bar to fill its own (BundledRuntime.swift).
  it('prints the download\'s progress bar to a reader that is not a terminal only when asked', async () => {
    await release('0.8.0', fakeArchive('0.8.0'))
    const asked = await install(freshHome(), { OPEN_WALNUT_PROGRESS: '1' })
    expect(asked.code, asked.out).toBe(0)
    expect(asked.out).toMatch(/100\.0%/)
    const quiet = await install(freshHome())
    expect(quiet.code, quiet.out).toBe(0)
    expect(quiet.out).not.toMatch(/\d\.\d%/)
  })

  it('a pinned version installs that one', async () => {
    await release('0.7.0', fakeArchive('0.7.0'), false)
    await release('0.8.0', fakeArchive('0.8.0'))
    const r = await install(freshHome(), { OPEN_WALNUT_VERSION: 'v0.7.0' })
    expect(r.code, r.out).toBe(0)
    expect(await printed(r.home)).toMatch(/^0\.7\.0 /)
  })

  it('while the newest release has no archives yet, takes the newest one with this platform\'s', async () => {
    await release('0.7.0', fakeArchive('0.7.0'), false)
    await release('0.8.0', fakeArchive('0.8.0', { target: 'plan9-mips' }), false)
    // 0.9.0 is out with no archives: its latest/download/SHA256SUMS is a 404.
    fs.writeFileSync(path.join(releases, 'latest'), '0.9.0\n')
    const asset = (name: string) => ({ name, browser_download_url: `${server.url}/x/${name}` })
    // The API's shape (pretty-printed, newest first), with a body that mentions a tag.
    fs.writeFileSync(path.join(releases, 'api.json'), JSON.stringify([
      { tag_name: 'v0.9.0', name: 'Open Walnut 0.9.0', body: 'Fixes "tag_name": "v9.9.9", and more', assets: [] },
      { tag_name: 'v0.8.0', name: 'Open Walnut 0.8.0', assets: [asset('open-walnut-0.8.0-plan9-mips.tar.gz'), asset('SHA256SUMS')] },
      { tag_name: 'v0.7.0', name: 'Open Walnut 0.7.0', assets: [asset(`open-walnut-0.7.0-${TARGET}.tar.gz`), asset('SHA256SUMS')] },
    ], null, 2))
    const r = await install(freshHome())
    expect(r.code, r.out).toBe(0)
    expect(await printed(r.home)).toMatch(/^0\.7\.0 /)
  })

  it('installs over an older copy and leaves nothing behind', async () => {
    const home = freshHome()
    await release('0.7.0', fakeArchive('0.7.0'))
    expect((await install(home)).code).toBe(0)
    await release('0.8.0', fakeArchive('0.8.0'))
    const r = await install(home)
    expect(r.code, r.out).toBe(0)
    expect(await printed(home)).toMatch(/^0\.8\.0 /)
    expect(leftovers(home)).toEqual([])
  })

  it('a download that does not match its checksum changes nothing', async () => {
    const home = freshHome()
    await release('0.7.0', fakeArchive('0.7.0'))
    expect((await install(home)).code).toBe(0)
    await release('0.8.0', fakeArchive('0.8.0'))
    const sums = path.join(releases, 'v0.8.0', 'SHA256SUMS')
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')))
    const r = await install(home)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('does not match its SHA256SUMS entry')
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
    expect(leftovers(home)).toEqual([])
  })

  it('an archive whose walnut does not run here changes nothing', async () => {
    const home = freshHome()
    await release('0.7.0', fakeArchive('0.7.0'))
    expect((await install(home)).code).toBe(0)
    await release('0.8.0', fakeArchive('0.8.0', { printed: 'exec format error' }))
    const r = await install(home)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('does not run here')
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
  })

  it('names npm when a release has no build for this platform', async () => {
    await release('0.8.0', fakeArchive('0.8.0', { target: 'plan9-mips' }))
    const r = await install(freshHome(), { OPEN_WALNUT_VERSION: '0.8.0' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`release 0.8.0 has no build for ${TARGET}; install it with npm: npm install -g open-walnut@0.8.0`)
  })

  // The release Walnut.app carries (desktop/BundledRuntime.swift): a directory
  // laid out like the releases, under a path with a space, as an app folder may be.
  it('installs a release from this disk with no network, checked against its SHA256SUMS', async () => {
    const carried = path.join(scratch, 'My Apps', 'Walnut.app', 'Contents', 'Resources', 'release')
    publishLocally(carried, '0.8.0', await fakeArchive('0.8.0'))
    // Every network address is dead: the release on disk is all there is.
    const r = await install(freshHome(), {
      OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0',
      OPEN_WALNUT_RELEASES_API: 'http://127.0.0.1:9/api.json', OPEN_WALNUT_PROGRESS: '1',
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`Unpacking the open-walnut-0.8.0-${TARGET}.tar.gz it came with...`)
    expect(r.out).not.toContain('Downloading')
    expect(await printed(r.home)).toMatch(/^0\.8\.0 /)
    // The carried copy is read, never moved or changed.
    expect(fs.existsSync(path.join(carried, 'v0.8.0', `open-walnut-0.8.0-${TARGET}.tar.gz`))).toBe(true)
    expect(leftovers(r.home)).toEqual([])
  })

  it('a release on this disk that does not match its checksum, or lacks this platform, changes nothing', async () => {
    const carried = path.join(scratch, 'carried-bad')
    fs.rmSync(carried, { recursive: true, force: true })
    publishLocally(carried, '0.8.0', await fakeArchive('0.8.0'))
    const sums = path.join(carried, 'v0.8.0', 'SHA256SUMS')
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')))
    const tampered = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0' })
    expect(tampered.code).not.toBe(0)
    expect(tampered.out).toContain('does not match its SHA256SUMS entry')
    expect(fs.existsSync(path.join(tampered.home, '.local/share/open-walnut'))).toBe(false)
    // The checksums name this platform's archive, but the file is not there.
    fs.rmSync(path.join(carried, 'v0.8.0', `open-walnut-0.8.0-${TARGET}.tar.gz`))
    const missing = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0' })
    expect(missing.code).not.toBe(0)
    expect(missing.out).toContain(`could not download open-walnut-0.8.0-${TARGET}.tar.gz`)
    const noSums = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.9.0' })
    expect(noSums.code).not.toBe(0)
    expect(noSums.out).toContain('release 0.9.0 has no self-contained build')
  })

  it('names npm when no release has a build at all', async () => {
    fs.writeFileSync(path.join(releases, 'api.json'), '[]')
    const r = await install(freshHome())
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('install with npm instead: npm install -g open-walnut')
    // Nothing is left behind by a first install that could not happen.
    expect(fs.existsSync(path.join(r.home, '.local/share/open-walnut'))).toBe(false)
  })
})
