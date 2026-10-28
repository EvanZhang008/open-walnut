/**
 * scripts/install.sh, run as `curl ... | sh` runs it, against a local server
 * laid out like GitHub Releases (scripts/release-rehearsal/runtime.mjs): stand-in
 * files (shell scripts that print a version) gzipped and listed the way
 * scripts/release-files.mjs lists a release's, so each case takes milliseconds.
 * Every case runs under /bin/sh and, where the system has it, dash (a strict
 * POSIX shell). tests/scripts/file-distribution.e2e.test.ts installs a real
 * compiled file this way.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publishLocally, serveReleases } from '../../scripts/release-rehearsal/runtime.mjs'
import { guardedPath } from '../setup/exec-guard.js'
import { processStart } from '../../src/core/self-update/install-lock.js'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/install.sh')
const HOST = `${process.platform}-${process.arch}`
const SHELLS = ['/bin/sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])]
let scratch = ''
let releases = ''
let server: { url: string; close: () => Promise<void> }

const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const standIn = (printed: string) => Buffer.from(`#!/bin/sh\necho '${printed}'\n`)

/**
 * Put a release's compiled file where serveReleases finds it: the .gz and the
 * SHA256SUMS lines for both forms, as release-files.mjs writes them.
 */
function releaseFile(version: string, { target = HOST, printed = `${version} (abc12345, 2026-10-22)`, latest = true, root = releases, plain = false, script = '' } = {}): void {
  const dir = path.join(root, `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = script ? Buffer.from(script) : standIn(printed)
  const name = `walnut-${version}-${target}`
  const gz = zlib.gzipSync(file)
  fs.writeFileSync(path.join(dir, `${name}.gz`), gz)
  if (plain) fs.writeFileSync(path.join(dir, name), file)
  fs.appendFileSync(path.join(dir, 'SHA256SUMS'), `${sha(gz)}  ${name}.gz\n${sha(file)}  ${name}\n`)
  if (latest) fs.writeFileSync(path.join(root, 'latest'), `${version}\n`)
}

/** An older release's self-contained Node archive: `bin/walnut` prints its version. */
function releaseArchive(version: string, { target = HOST, latest = true } = {}): Promise<void> {
  const stem = `open-walnut-${version}-${target}`
  const dir = fs.mkdtempSync(path.join(scratch, 'pack-'))
  fs.mkdirSync(path.join(dir, stem, 'bin'), { recursive: true })
  for (const name of ['walnut', 'open-walnut']) fs.writeFileSync(path.join(dir, stem, 'bin', name), `#!/bin/sh\necho '${version} (archive)'\n`, { mode: 0o755 })
  const file = path.join(dir, `${stem}.tar.gz`)
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', file, '-C', dir, stem], { env: { ...process.env, COPYFILE_DISABLE: '1' } }, (err) => {
      if (err) return reject(err)
      publishLocally(releases, version, file, { latest })
      resolve()
    })
  })
}

interface Run { code: number; out: string; home: string }
let shell = '/bin/sh'
function install(home: string, env: Record<string, string> = {}, extraPath: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    execFile(shell, [SCRIPT], {
      env: {
        // A system PATH with no Node, behind the test guard (which holds no Node either).
        PATH: guardedPath(extraPath, '/usr/bin:/bin:/usr/sbin:/sbin'), HOME: home,
        OPEN_WALNUT_RELEASE_BASE_URL: server.url,
        OPEN_WALNUT_RELEASES_API: `${server.url}/api.json`,
        ...env,
      },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`, home }))
  })
}

/** install.sh read from a pipe the way `curl ... | sh` feeds it, cut to `text`. */
function installPiped(home: string, text: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-s'], {
      env: { PATH: guardedPath([], '/usr/bin:/bin:/usr/sbin:/sbin'), HOME: home, OPEN_WALNUT_RELEASE_BASE_URL: server.url, OPEN_WALNUT_RELEASES_API: `${server.url}/api.json` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code: code ?? 1, out, home }))
    child.stdin.end(text)
  })
}

const freshHome = () => fs.mkdtempSync(path.join(scratch, 'home-'))
/** The pid of a process that has exited (a shell that printed its own pid). */
const deadPid = () => Number(spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
const share = (home: string) => path.join(home, '.local/share/open-walnut')
const walnut = (home: string) => path.join(home, '.local/bin/walnut')
function printed(home: string, bin = walnut(home)): Promise<string> {
  return new Promise((resolve, reject) => execFile(bin, ['--version'], (err, out) => (err ? reject(err) : resolve(out.trim()))))
}
const versionsOf = (home: string) => (fs.existsSync(path.join(share(home), 'versions')) ? fs.readdirSync(path.join(share(home), 'versions')).sort() : [])
const entries = (home: string) => fs.readdirSync(share(home)).sort()
const marker = (home: string) => JSON.parse(fs.readFileSync(path.join(share(home), 'open-walnut-install.json'), 'utf8'))

/** A directory of commands that make install.sh see Linux on x86_64, with `ldd` saying `libc`. */
function linuxTools(libc: 'musl' | 'glibc' | 'none'): string {
  const dir = fs.mkdtempSync(path.join(scratch, 'linux-'))
  fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n', { mode: 0o755 })
  if (libc === 'musl') fs.writeFileSync(path.join(dir, 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)" >&2\necho "Version 1.2.4" >&2\nexit 1\n', { mode: 0o755 })
  if (libc === 'glibc') fs.writeFileSync(path.join(dir, 'ldd'), '#!/bin/sh\necho "ldd (GNU libc) 2.26"\n', { mode: 0o755 })
  return dir
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

describe.each(SHELLS)('install.sh under %s', (sh) => {
  beforeAll(() => { shell = sh })

  it('installs the newest release\'s file into its version directory and links walnut into ~/.local/bin', async () => {
    releaseFile('0.7.0', { latest: false })
    releaseFile('0.8.0')
    const r = await install(freshHome())
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`Installing Open Walnut 0.8.0 (${HOST})...`)
    expect(r.out).toContain(`Downloading walnut-0.8.0-${HOST}.gz...`)
    expect(r.out).toContain('Installed Open Walnut 0.8.0')
    expect(await printed(r.home)).toBe('0.8.0 (abc12345, 2026-10-22)')
    expect(await printed(r.home, path.join(r.home, '.local/bin/open-walnut'))).toMatch(/^0\.8\.0 /)
    // The layout the updater knows (install-kind.ts): one link to swap, its marker, the versions.
    expect(fs.readlinkSync(walnut(r.home))).toBe(path.join(share(r.home), 'bin/walnut'))
    expect(fs.readlinkSync(path.join(share(r.home), 'bin/walnut'))).toBe('../versions/0.8.0/walnut')
    expect(marker(r.home)).toEqual({ layout: 'versions', target: HOST })
    expect(versionsOf(r.home)).toEqual(['0.8.0'])
    expect(fs.readdirSync(path.join(share(r.home), 'versions/0.8.0'))).toEqual(['walnut'])
    expect(entries(r.home)).toEqual(['bin', 'open-walnut-install.json', 'versions'])
    // ~/.local/bin is not on this PATH, and the user is told so.
    expect(r.out).toContain(`Add ${path.join(r.home, '.local/bin')} to your PATH`)
  })

  // Plain `walnut` after `curl ... | sh`: one PATH line in the login shell's rc file, written once,
  // only for a person at a terminal (forced here with OPEN_WALNUT_MODIFY_PATH=1; no tty in tests).
  it('puts ~/.local/bin on PATH in the login shell\'s rc file once, and prints the full path to start now', async () => {
    releaseFile('0.8.0')
    const bin = (home: string) => path.join(home, '.local/bin')
    const zsh = freshHome()
    const first = await install(zsh, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/bin/zsh' })
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain(`Added ${bin(zsh)} to your PATH in ${path.join(zsh, '.zshrc')}`)
    expect(first.out).toContain(`Start it now with:  ${bin(zsh)}/walnut web`)
    expect(fs.readFileSync(path.join(zsh, '.zshrc'), 'utf8')).toBe('\n# Added by the Open Walnut installer\nexport PATH="$HOME/.local/bin:$PATH"\n')
    // The rc line works: a login of that shell finds walnut.
    const found = spawnSync('/bin/sh', ['-c', `. "${path.join(zsh, '.zshrc')}" && command -v walnut`], { env: { HOME: zsh, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(found.stdout.trim()).toBe(path.join(bin(zsh), 'walnut'))
    // Again: nothing added twice.
    const again = await install(zsh, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/bin/zsh' })
    expect(again.out).toContain(`${path.join(zsh, '.zshrc')} already puts ${bin(zsh)} on your PATH`)
    expect(fs.readFileSync(path.join(zsh, '.zshrc'), 'utf8').match(/Open Walnut installer/g)).toHaveLength(1)

    // A line another installer wrote (Claude Code's) counts as there.
    const claude = freshHome()
    fs.writeFileSync(path.join(claude, '.zshrc'), 'export PATH="$HOME/.local/bin:$PATH"\n')
    const had = await install(claude, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/bin/zsh' })
    expect(had.out).toContain('already puts')
    expect(fs.readFileSync(path.join(claude, '.zshrc'), 'utf8')).toBe('export PATH="$HOME/.local/bin:$PATH"\n')

    const fish = freshHome()
    await install(fish, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/usr/bin/fish' })
    expect(fs.readFileSync(path.join(fish, '.config/fish/conf.d/open-walnut.fish'), 'utf8')).toContain(`contains "${bin(fish)}" $PATH; or set -gx PATH "${bin(fish)}" $PATH`)

    // Any other shell (bash run as sh fills in an unset SHELL itself, so name one) gets ~/.profile.
    const none = freshHome()
    const plain = await install(none, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/bin/ksh' })
    expect(plain.code, plain.out).toBe(0)
    expect(fs.readFileSync(path.join(none, '.profile'), 'utf8')).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  it('never edits a dotfile with no terminal or with OPEN_WALNUT_MODIFY_PATH=0, and says what to do', async () => {
    releaseFile('0.8.0')
    for (const env of [{ SHELL: '/bin/zsh' }, { SHELL: '/bin/zsh', OPEN_WALNUT_MODIFY_PATH: '0' }]) {
      const home = freshHome()
      const r = await install(home, env)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`Add ${path.join(home, '.local/bin')} to your PATH`)
      expect(r.out).toContain(`Start it now with:  ${path.join(home, '.local/bin')}/walnut web`)
      expect(fs.readdirSync(home).filter((f) => f.startsWith('.') && f !== '.local')).toEqual([])
    }
  })

  // On PATH already: the short command, and nothing written.
  it('says walnut web when ~/.local/bin is already on PATH', async () => {
    releaseFile('0.8.0')
    const home = freshHome()
    const r = await install(home, { OPEN_WALNUT_MODIFY_PATH: '1', SHELL: '/bin/zsh' }, [path.join(home, '.local/bin')])
    expect(r.out).toContain('Start it with:  walnut web')
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
  })

  // The Mac app reads the percentage off the bar to fill its own (BundledRuntime.swift).
  it('prints the download\'s progress bar to a reader that is not a terminal only when asked', async () => {
    releaseFile('0.8.0')
    const asked = await install(freshHome(), { OPEN_WALNUT_PROGRESS: '1' })
    expect(asked.code, asked.out).toBe(0)
    expect(asked.out).toMatch(/100\.0%/)
    const quiet = await install(freshHome())
    expect(quiet.code, quiet.out).toBe(0)
    expect(quiet.out).not.toMatch(/\d\.\d%/)
  })

  it('a pinned version installs that one', async () => {
    releaseFile('0.7.0', { latest: false })
    releaseFile('0.8.0')
    const home = freshHome()
    // A version held back (held-versions.ts) that is installed on purpose is held back no more.
    fs.mkdirSync(path.join(share(home), 'bad'), { recursive: true })
    fs.writeFileSync(path.join(share(home), 'bad', '0.7.0'), 'exited with 1 before it served\n')
    const r = await install(home, { OPEN_WALNUT_VERSION: 'v0.7.0' })
    expect(r.code, r.out).toBe(0)
    expect(await printed(r.home)).toMatch(/^0\.7\.0 /)
    expect(fs.existsSync(path.join(share(home), 'bad', '0.7.0'))).toBe(false)
  })

  it('a newer version goes in beside the old one, which stays for a rollback; a third removes the oldest', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    releaseFile('0.8.0')
    const second = await install(home)
    expect(second.code, second.out).toBe(0)
    expect(await printed(home)).toMatch(/^0\.8\.0 /)
    expect(versionsOf(home)).toEqual(['0.7.0', '0.8.0'])
    releaseFile('0.9.0')
    expect((await install(home)).code).toBe(0)
    expect(versionsOf(home)).toEqual(['0.8.0', '0.9.0'])
    expect(entries(home)).toEqual(['bin', 'open-walnut-install.json', 'versions'])
  })

  it('a version a running server sits in stays through the prune, until that server is gone', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    await install(home)
    // The server started on 0.7.0 marks it (binary-install.ts markRunning); this test process stands in for it.
    fs.mkdirSync(path.join(share(home), 'running'))
    fs.writeFileSync(path.join(share(home), 'running', String(process.pid)), '0.7.0\n')
    releaseFile('0.8.0')
    await install(home)
    releaseFile('0.9.0')
    const third = await install(home)
    expect(third.code, third.out).toBe(0)
    expect(versionsOf(home)).toEqual(['0.7.0', '0.8.0', '0.9.0'])
    // The server exited without removing its marker (killed): the marker keeps nothing and goes.
    fs.renameSync(path.join(share(home), 'running', String(process.pid)), path.join(share(home), 'running', String(deadPid())))
    releaseFile('0.10.0')
    expect((await install(home)).code).toBe(0)
    expect(versionsOf(home)).toEqual(['0.10.0', '0.9.0'])
    expect(fs.readdirSync(path.join(share(home), 'running'))).toEqual([])
  })

  it('a link pointed back by hand at a version\'s full path counts as the version in use', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    await install(home)
    releaseFile('0.8.0')
    await install(home)
    const link = path.join(share(home), 'bin', 'walnut')
    fs.rmSync(link)
    fs.symlinkSync(path.join(share(home), 'versions', '0.7.0', 'walnut'), link)
    releaseFile('0.9.0')
    const r = await install(home)
    expect(r.code, r.out).toBe(0)
    expect(versionsOf(home)).toEqual(['0.7.0', '0.9.0'])
  })

  it('waits for another update of the install to finish, and takes over one whose process is gone', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    await install(home)
    const lock = path.join(share(home), '.update.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} 1a2b3c4d5e6f\n`)
    releaseFile('0.8.0')
    const released = setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 2500)
    const waited = await install(home)
    clearTimeout(released)
    expect(waited.code, waited.out).toBe(0)
    expect(waited.out).toContain(`Waiting for another update of ${share(home)} to finish...`)
    expect(await printed(home)).toMatch(/^0\.8\.0 /)
    // Stopped with Ctrl-C: its owner is gone, so nothing waits for it.
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${deadPid()} install.sh\n`)
    releaseFile('0.9.0')
    const over = await install(home)
    expect(over.code, over.out).toBe(0)
    expect(over.out).not.toContain('Waiting')
    expect(await printed(home)).toMatch(/^0\.9\.0 /)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('takes over a lock whose pid now belongs to a process that started at another time, and waits for its real holder', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    await install(home)
    const lock = path.join(share(home), '.update.lock')
    // This test process is alive, but the owner line was written by one that started in 2001: a reused pid.
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} 1a2b3c4d5e6f Mon Jan  1 00:00:00 2001\n`)
    releaseFile('0.8.0')
    const over = await install(home)
    expect(over.code, over.out).toBe(0)
    expect(over.out).not.toContain('Waiting')
    expect(await printed(home)).toMatch(/^0\.8\.0 /)
    // Its own start time, as the updater writes it (install-lock.ts): the holder, waited for.
    const started = await processStart(process.pid)
    expect(started).not.toBe('')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} 1a2b3c4d5e6f ${started}\n`)
    releaseFile('0.9.0')
    const released = setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 2500)
    const waited = await install(home)
    clearTimeout(released)
    expect(waited.code, waited.out).toBe(0)
    expect(waited.out).toContain('Waiting for another update')
  })

  it('a script cut short anywhere does nothing at all', async () => {
    releaseFile('0.8.0')
    const text = fs.readFileSync(SCRIPT, 'utf8')
    const lastLine = text.lastIndexOf('main "$@"')
    // Up to the last line, and into its quote (`main` alone is the whole script: it installs).
    const cuts = [...Array.from({ length: 24 }, (_, i) => Math.floor((text.length * (i + 1)) / 25)), lastLine, lastLine + 6]
    for (const cut of cuts) {
      const home = freshHome()
      await installPiped(home, text.slice(0, cut))
      expect(fs.existsSync(path.join(home, '.local')), `cut at ${cut} of ${text.length}`).toBe(false)
    }
    // The whole of it installs.
    const whole = await installPiped(freshHome(), text)
    expect(whole.code, whole.out).toBe(0)
    expect(await printed(whole.home)).toMatch(/^0\.8\.0 /)
  })

  it('refuses an OPEN_WALNUT_VERSION that is not a version before it touches anything', async () => {
    releaseFile('0.8.0')
    for (const bad of ['../../../tmp/x', '0.8', '0.8.0/../0.7.0', '0.8.0 ']) {
      const r = await install(freshHome(), { OPEN_WALNUT_VERSION: bad })
      expect(r.code, bad).not.toBe(0)
      expect(r.out).toContain(`OPEN_WALNUT_VERSION=${bad} is not a version`)
      expect(fs.existsSync(share(r.home))).toBe(false)
    }
  })

  it('names GitHub\'s limit when its API refuses the list of releases', async () => {
    const refusing = http.createServer((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"API rate limit exceeded"}') })
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', () => resolve()))
    const port = (refusing.address() as { port: number }).port
    try {
      // No release is marked newest, so the list is the only way to find one.
      const r = await install(freshHome(), { OPEN_WALNUT_RELEASES_API: `http://127.0.0.1:${port}/releases` })
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('GitHub refused the list of releases (its API allows 60 requests an hour')
      expect(r.out).toContain('OPEN_WALNUT_VERSION=<version>')
    } finally {
      await new Promise((resolve) => refusing.close(resolve))
    }
  })

  it('in a directory it did not make, removes nothing; after that, only what its layout puts there', async () => {
    const home = freshHome()
    const dir = path.join(home, 'stuff')
    fs.mkdirSync(path.join(dir, 'versions', 'notes'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'versions', 'notes', 'todo.txt'), 'keep')
    fs.mkdirSync(path.join(dir, 'versions', '0.1.0'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'versions', '0.1.0', 'walnut'), '#!/bin/sh\n')
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'app', 'keep.txt'), 'keep')
    const env = { OPEN_WALNUT_INSTALL_DIR: dir }
    releaseFile('0.7.0')
    const first = await install(home, env)
    expect(first.code, first.out).toBe(0)
    // No marker before this run: not known to be a Walnut install, so nothing goes.
    expect(fs.readdirSync(path.join(dir, 'versions')).sort()).toEqual(['0.1.0', '0.7.0', 'notes'])
    releaseFile('0.8.0')
    expect((await install(home, env)).code).toBe(0)
    // Its own now: an old version (a directory holding a walnut) goes; what is not its own stays.
    expect(fs.readdirSync(path.join(dir, 'versions')).sort()).toEqual(['0.7.0', '0.8.0', 'notes'])
    expect(fs.readFileSync(path.join(dir, 'versions', 'notes', 'todo.txt'), 'utf8')).toBe('keep')
    expect(fs.readFileSync(path.join(dir, 'app', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('keeps the Node archive while a process still runs from it', async () => {
    const home = freshHome()
    await releaseArchive('0.6.9')
    expect((await install(home, { OPEN_WALNUT_VERSION: '0.6.9' })).code).toBe(0)
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    // A server from the archive marks nothing; its command line names app/.
    const runner = path.join(share(home), 'app', 'bin', 'runner')
    fs.writeFileSync(runner, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 })
    const child = spawn(runner, [], { stdio: 'ignore' })
    try {
      releaseFile('0.8.0')
      const kept = await install(home)
      expect(kept.code, kept.out).toBe(0)
      expect(entries(home)).toContain('app')
    } finally {
      child.kill()
    }
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.on('exit', resolve)))
    releaseFile('0.9.0')
    expect((await install(home)).code).toBe(0)
    expect(entries(home)).not.toContain('app')
  })

  it('keeps the Node archive a process runs from when HOME is reached through a link', async () => {
    // The archive's launcher finds its root with `pwd -P`, so its processes name the
    // physical path (macOS /tmp is /private/tmp; Fedora Atomic's /home is /var/home).
    const real = freshHome()
    const home = path.join(scratch, `link-${crypto.randomBytes(4).toString('hex')}`)
    fs.symlinkSync(real, home)
    await releaseArchive('0.6.9')
    expect((await install(home, { OPEN_WALNUT_VERSION: '0.6.9' })).code).toBe(0)
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    const runner = path.join(share(real), 'app', 'bin', 'runner')
    fs.writeFileSync(runner, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 })
    const child = spawn(runner, [], { stdio: 'ignore' })
    try {
      releaseFile('0.8.0')
      const kept = await install(home)
      expect(kept.code, kept.out).toBe(0)
      expect(entries(home)).toContain('app')
    } finally {
      child.kill()
    }
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.on('exit', resolve)))
    releaseFile('0.9.0')
    expect((await install(home)).code).toBe(0)
    expect(entries(home)).not.toContain('app')
  })

  it('going back to a release from before the file says how to stay there', async () => {
    // Its Node archive updates itself to the newest release when it starts, and knows
    // nothing of the versions held back (src/core/self-update/held-versions.ts).
    const home = freshHome()
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    await releaseArchive('0.6.9', { latest: false })
    const back = await install(home, { OPEN_WALNUT_VERSION: '0.6.9' })
    expect(back.code, back.out).toBe(0)
    expect(await printed(home)).toBe('0.6.9 (archive)')
    expect(back.out).toContain('Open Walnut 0.6.9 updates itself to the newest release when it starts')
    expect(back.out).toContain('set updates.auto: false in ~/.open-walnut/config.yaml')
    expect(back.out).toContain('Remove that setting again when you want updates.')
    // A data home of its own: the note names its config.yaml.
    const elsewhere = await install(home, { OPEN_WALNUT_VERSION: '0.6.9', OPEN_WALNUT_HOME: '/srv/walnut-data' })
    expect(elsewhere.code, elsewhere.out).toBe(0)
    expect(elsewhere.out).toContain('set updates.auto: false in /srv/walnut-data/config.yaml')
    // A release with the file holds a move back by itself: no such note.
    const forward = await install(home, { OPEN_WALNUT_VERSION: '0.7.0' })
    expect(forward.code, forward.out).toBe(0)
    expect(forward.out).not.toContain('updates itself to the newest release')
  })

  it('installing the version in use again changes nothing and keeps the one before it', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    await install(home)
    releaseFile('0.8.0')
    await install(home)
    const again = await install(home)
    expect(again.code, again.out).toBe(0)
    expect(await printed(home)).toMatch(/^0\.8\.0 /)
    expect(versionsOf(home)).toEqual(['0.7.0', '0.8.0'])
  })

  it('a download that does not match its checksum changes nothing', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    releaseFile('0.8.0')
    const sums = path.join(releases, 'v0.8.0', 'SHA256SUMS')
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')))
    const r = await install(home)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('does not match its SHA256SUMS entry')
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
    expect(versionsOf(home)).toEqual(['0.7.0'])
    expect(entries(home)).toEqual(['bin', 'open-walnut-install.json', 'versions'])
  })

  it('a file that does not run here changes nothing', async () => {
    const home = freshHome()
    releaseFile('0.7.0')
    expect((await install(home)).code).toBe(0)
    releaseFile('0.8.0', { printed: 'exec format error' })
    const r = await install(home)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('does not run here')
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
    expect(versionsOf(home)).toEqual(['0.7.0'])
  })

  it('on a musl Linux takes the musl file, on glibc the plain one, and an unanswering ldd means glibc', async () => {
    releaseFile('0.8.0', { target: 'linux-x64', latest: false })
    releaseFile('0.8.0', { target: 'linux-x64-musl', printed: '0.8.0 (musl)' })
    const musl = await install(freshHome(), {}, [linuxTools('musl')])
    expect(musl.code, musl.out).toBe(0)
    expect(musl.out).toContain('Installing Open Walnut 0.8.0 (linux-x64-musl)...')
    expect(await printed(musl.home)).toBe('0.8.0 (musl)')
    expect(marker(musl.home).target).toBe('linux-x64-musl')
    const glibc = await install(freshHome(), {}, [linuxTools('glibc')])
    expect(glibc.code, glibc.out).toBe(0)
    expect(glibc.out).toContain('(linux-x64)...')
    expect(marker(glibc.home).target).toBe('linux-x64')
    const none = await install(freshHome(), {}, [linuxTools('none')])
    expect(none.out).toContain('(linux-x64)...')
  })

  it('on a musl system without the C++ runtime, names the packages to add and changes nothing', async () => {
    // What musl's loader prints for the musl build on a bare Alpine (no libstdc++, no libgcc).
    const missing = "#!/bin/sh\necho 'Error relocating /x/walnut: __cxa_guard_acquire: symbol not found' >&2\nexit 127\n"
    releaseFile('0.8.0', { target: 'linux-x64-musl', script: missing })
    const r = await install(freshHome(), {}, [linuxTools('musl')])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("Walnut's musl build needs the C++ runtime, which this system lacks. Install it (Alpine: apk add libstdc++ libgcc), then run this again; nothing was changed")
    expect(fs.existsSync(share(r.home))).toBe(false)
    // Elsewhere a file that cannot start says what it printed, from stderr when stdout is empty.
    releaseFile('0.8.1', { script: "#!/bin/sh\necho 'cannot execute binary file' >&2\nexit 126\n" })
    const other = await install(freshHome())
    expect(other.out).toContain('the downloaded Walnut does not run here (it printed: cannot execute binary file')
  })

  it('OPEN_WALNUT_TARGET picks the file, and refuses a word that is not a target', async () => {
    releaseFile('0.8.0', { target: 'linux-arm64-musl', printed: '0.8.0 (arm musl)' })
    const r = await install(freshHome(), { OPEN_WALNUT_TARGET: 'linux-arm64-musl' })
    expect(r.code, r.out).toBe(0)
    expect(await printed(r.home)).toBe('0.8.0 (arm musl)')
    const bad = await install(freshHome(), { OPEN_WALNUT_TARGET: 'plan9-mips' })
    expect(bad.code).not.toBe(0)
    expect(bad.out).toContain('OPEN_WALNUT_TARGET=plan9-mips is not a target')
  })

  it('while the newest release has no files yet, takes the newest one with this target\'s', async () => {
    releaseFile('0.7.0', { latest: false })
    releaseFile('0.8.0', { target: 'linux-arm64-musl', latest: false })
    // 0.9.0 is out with no files: its latest/download/SHA256SUMS is a 404.
    fs.writeFileSync(path.join(releases, 'latest'), '0.9.0\n')
    const asset = (name: string) => ({ name, browser_download_url: `${server.url}/x/${name}` })
    // The API's shape (pretty-printed, newest first), with a body that mentions a tag.
    fs.writeFileSync(path.join(releases, 'api.json'), JSON.stringify([
      { tag_name: 'v0.9.0', name: 'Open Walnut 0.9.0', body: 'Fixes "tag_name": "v9.9.9", and more', assets: [] },
      // Half way through its upload: this target's file is up, its SHA256SUMS (uploaded last) is not.
      { tag_name: 'v0.8.5', name: 'Open Walnut 0.8.5', assets: [asset(`walnut-0.8.5-${HOST}.gz`)] },
      { tag_name: 'v0.8.0', name: 'Open Walnut 0.8.0', assets: [asset('walnut-0.8.0-linux-arm64-musl.gz'), asset('SHA256SUMS')] },
      { tag_name: 'v0.7.0', name: 'Open Walnut 0.7.0', assets: [asset(`walnut-0.7.0-${HOST}.gz`), asset(`open-walnut-0.7.0-${HOST}.tar.gz`), asset('SHA256SUMS')] },
    ], null, 2))
    const r = await install(freshHome())
    expect(r.code, r.out).toBe(0)
    expect(await printed(r.home)).toMatch(/^0\.7\.0 /)
  })

  it('a release from before the compiled file installs its Node archive the way it always did', async () => {
    await releaseArchive('0.6.9')
    const r = await install(freshHome(), { OPEN_WALNUT_VERSION: '0.6.9' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`Downloading open-walnut-0.6.9-${HOST}.tar.gz...`)
    expect(await printed(r.home)).toBe('0.6.9 (archive)')
    expect(fs.readlinkSync(path.join(share(r.home), 'bin/walnut'))).toBe('../app/bin/walnut')
    expect(entries(r.home)).toEqual(['app', 'bin', 'open-walnut-install.json'])
    // With nothing newer that has a file, the newest pick is the archive too.
    fs.writeFileSync(path.join(releases, 'api.json'), JSON.stringify([{ tag_name: 'v0.6.9', assets: [{ name: `open-walnut-0.6.9-${HOST}.tar.gz` }, { name: 'SHA256SUMS' }] }], null, 2))
    fs.writeFileSync(path.join(releases, 'latest'), '0.7.0\n')
    const newest = await install(freshHome())
    expect(newest.code, newest.out).toBe(0)
    expect(await printed(newest.home)).toBe('0.6.9 (archive)')
  })

  it('a newest release from before the compiled file is found from its checksums alone, with no release list', async () => {
    // The release rehearsal's local server answers no API: the newest SHA256SUMS
    // names only this machine's Node archive, and that is the release to install.
    await releaseArchive('0.6.9')
    fs.rmSync(path.join(releases, 'api.json'), { force: true })
    fs.writeFileSync(path.join(releases, 'latest'), '0.6.9\n')
    const r = await install(freshHome())
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`Downloading open-walnut-0.6.9-${HOST}.tar.gz...`)
    expect(await printed(r.home)).toBe('0.6.9 (archive)')
  })

  it('moves an archive install to the file: the archive stays as the version before, then goes', async () => {
    const home = freshHome()
    await releaseArchive('0.6.9')
    expect((await install(home, { OPEN_WALNUT_VERSION: '0.6.9' })).code).toBe(0)
    releaseFile('0.7.0')
    const r = await install(home)
    expect(r.code, r.out).toBe(0)
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
    expect(entries(home)).toEqual(['app', 'bin', 'open-walnut-install.json', 'versions'])
    releaseFile('0.8.0')
    expect((await install(home)).code).toBe(0)
    expect(entries(home)).toEqual(['bin', 'open-walnut-install.json', 'versions'])
    expect(versionsOf(home)).toEqual(['0.7.0', '0.8.0'])
  })

  it('takes over an install made by the install.sh before the versions layout', async () => {
    // Its layout: the archive in app/, ~/.local/bin/walnut linked straight to app/bin/walnut.
    const home = freshHome()
    fs.mkdirSync(path.join(share(home), 'app/bin'), { recursive: true })
    fs.writeFileSync(path.join(share(home), 'app/bin/walnut'), '#!/bin/sh\necho "0.6.8 (archive)"\n', { mode: 0o755 })
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
    fs.symlinkSync(path.join(share(home), 'app/bin/walnut'), walnut(home))
    releaseFile('0.7.0')
    const r = await install(home)
    expect(r.code, r.out).toBe(0)
    expect(await printed(home)).toMatch(/^0\.7\.0 /)
    expect(fs.readlinkSync(walnut(home))).toBe(path.join(share(home), 'bin/walnut'))
    // The archive it replaced is the rollback.
    expect(entries(home)).toEqual(['app', 'bin', 'open-walnut-install.json', 'versions'])
  })

  // The release Walnut.app carries (desktop/BundledRuntime.swift): a directory laid
  // out like the releases, under a path with a space, as an app folder may be.
  it('installs a release from this disk with no network: the plain file it carries, or its .gz', async () => {
    const carried = path.join(scratch, 'My Apps', 'Walnut.app', 'Contents', 'Resources', 'release')
    fs.rmSync(carried, { recursive: true, force: true })
    releaseFile('0.8.0', { root: carried, plain: true })
    // Every network address is dead: the release on disk is all there is.
    const dead = { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0', OPEN_WALNUT_RELEASES_API: 'http://127.0.0.1:9/api.json', OPEN_WALNUT_PROGRESS: '1' }
    const plain = await install(freshHome(), dead)
    expect(plain.code, plain.out).toBe(0)
    expect(plain.out).toContain(`Installing the walnut-0.8.0-${HOST} it came with...`)
    expect(plain.out).not.toContain('Downloading')
    expect(await printed(plain.home)).toMatch(/^0\.8\.0 /)
    // The carried copy is read, never moved or changed.
    expect(fs.existsSync(path.join(carried, 'v0.8.0', `walnut-0.8.0-${HOST}`))).toBe(true)
    fs.rmSync(path.join(carried, 'v0.8.0', `walnut-0.8.0-${HOST}`))
    const gz = await install(freshHome(), dead)
    expect(gz.code, gz.out).toBe(0)
    expect(gz.out).toContain(`Unpacking the walnut-0.8.0-${HOST}.gz it came with...`)
    expect(await printed(gz.home)).toMatch(/^0\.8\.0 /)
  })

  it('installs the plain file of a release on this disk whose SHA256SUMS lists only it (the Mac app\'s, signed for it)', async () => {
    const carried = path.join(scratch, 'Signed App', 'release')
    fs.rmSync(carried, { recursive: true, force: true })
    const dir = path.join(carried, 'v0.8.0')
    fs.mkdirSync(dir, { recursive: true })
    const file = standIn('0.8.0 (signed)')
    fs.writeFileSync(path.join(dir, `walnut-0.8.0-${HOST}`), file)
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha(file)}  walnut-0.8.0-${HOST}\n`)
    const r = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0', OPEN_WALNUT_RELEASES_API: 'http://127.0.0.1:9/api.json' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`Installing the walnut-0.8.0-${HOST} it came with...`)
    expect(await printed(r.home)).toBe('0.8.0 (signed)')
    // Without the file beside it, the line alone is no build.
    fs.rmSync(path.join(dir, `walnut-0.8.0-${HOST}`))
    const gone = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0' })
    expect(gone.code).not.toBe(0)
    expect(gone.out).toContain(`release 0.8.0 has no build for ${HOST}`)
  })

  it('a release on this disk that does not match its checksum, or lacks the file, changes nothing', async () => {
    const carried = path.join(scratch, 'carried-bad')
    fs.rmSync(carried, { recursive: true, force: true })
    releaseFile('0.8.0', { root: carried, plain: true })
    const sums = path.join(carried, 'v0.8.0', 'SHA256SUMS')
    const good = fs.readFileSync(sums, 'utf8')
    fs.writeFileSync(sums, good.split('\n').map((l) => (l.endsWith(HOST) ? l.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')) : l)).join('\n'))
    const tampered = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0' })
    expect(tampered.code).not.toBe(0)
    expect(tampered.out).toContain('does not match its SHA256SUMS entry')
    expect(fs.existsSync(share(tampered.home))).toBe(false)
    // The checksums name this target's file, but neither form is there.
    fs.writeFileSync(sums, good)
    fs.rmSync(path.join(carried, 'v0.8.0', `walnut-0.8.0-${HOST}`))
    fs.rmSync(path.join(carried, 'v0.8.0', `walnut-0.8.0-${HOST}.gz`))
    const missing = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.8.0' })
    expect(missing.code).not.toBe(0)
    expect(missing.out).toContain(`could not download walnut-0.8.0-${HOST}.gz`)
    const noSums = await install(freshHome(), { OPEN_WALNUT_RELEASE_BASE_URL: `file://${carried}`, OPEN_WALNUT_VERSION: '0.9.0' })
    expect(noSums.code).not.toBe(0)
    expect(noSums.out).toContain('release 0.9.0 has no build to install here')
  })

  it('names the target when a release, or every release, has no build for it', async () => {
    releaseFile('0.8.0', { target: 'linux-arm64-musl' })
    const one = await install(freshHome(), { OPEN_WALNUT_VERSION: '0.8.0' })
    expect(one.code).not.toBe(0)
    expect(one.out).toContain(`release 0.8.0 has no build for ${HOST}`)
    // A musl system never takes a Node archive (there was never a musl one).
    await releaseArchive('0.6.9', { latest: false })
    const musl = await install(freshHome(), { OPEN_WALNUT_VERSION: '0.6.9' }, [linuxTools('musl')])
    expect(musl.out).toContain('release 0.6.9 has no build for linux-x64-musl')
    fs.writeFileSync(path.join(releases, 'api.json'), '[]')
    fs.rmSync(path.join(releases, 'latest'))
    const none = await install(freshHome())
    expect(none.code).not.toBe(0)
    expect(none.out).toContain(`found no release with a build for ${HOST}`)
    // Nothing is left behind by a first install that could not happen.
    expect(fs.existsSync(share(none.home))).toBe(false)
  })
})
