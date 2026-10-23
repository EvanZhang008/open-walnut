/**
 * The compiled file's own update (src/core/self-update/binary-install.ts),
 * against a local registry that serves platform packages the way npm does:
 * stand-in files (shell scripts that print a version) packed as npm packs them,
 * so each case is real downloads, real tarballs and real renames in a temp root.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  extractTarEntry, installFileVersion, markRunning, pidAlive, processesRunFrom, pruneVersions, registryBaseFor, rollBack, swapLink, takeLock, undoRollBack, versionInUse, versionsRunning,
} from '../../../src/core/self-update/binary-install.js'
import { processStart } from '../../../src/core/self-update/install-lock.js'
import { BINARY_MARKER, type BinaryInstall } from '../../../src/core/self-update/install-kind.js'

const TARGET = 'darwin-arm64'
let scratch = ''
let server: http.Server
let base = ''
/** version -> { tgz bytes, integrity }; `integrityOverride` serves a wrong one. */
const served = new Map<string, { bytes: Buffer; integrity: string }>()
const hits: string[] = []

function standIn(version: string, printed = `${version} (abc12345, standin)`): Buffer {
  const dir = fs.mkdtempSync(path.join(scratch, 'pkg-'))
  fs.mkdirSync(path.join(dir, 'package'))
  fs.writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify({ name: `@open-walnut/${TARGET}`, version }))
  fs.writeFileSync(path.join(dir, 'package', 'walnut'), `#!/bin/sh\n[ "$1" = --version ] && echo '${printed}'\n`, { mode: 0o755 })
  const out = path.join(dir, 'p.tgz')
  execFileSync('tar', ['-czf', out, '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return fs.readFileSync(out)
}

function publish(version: string, bytes = standIn(version)): void {
  served.set(version, { bytes, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` })
}

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binary-install-')))
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    hits.push(url)
    const meta = /^\/@open-walnut\/([^/]+)\/([^/]+)$/.exec(url)
    if (meta && meta[1] === TARGET && served.has(meta[2]!)) {
      const v = meta[2]!
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ name: `@open-walnut/${TARGET}`, version: v, dist: { tarball: `${base}/tgz/${v}`, integrity: served.get(v)!.integrity } }))
    }
    const tgz = /^\/tgz\/(.+)$/.exec(url)
    if (tgz && served.has(tgz[1]!)) {
      res.writeHead(200, { 'content-length': served.get(tgz[1]!)!.bytes.length })
      return res.end(served.get(tgz[1]!)!.bytes)
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => { served.clear(); hits.length = 0 })

/** A root laid out as install.sh leaves it, with `version` in use. */
function layout(version: string): BinaryInstall {
  const root = fs.mkdtempSync(path.join(scratch, 'root-'))
  fs.mkdirSync(path.join(root, 'versions', version), { recursive: true })
  fs.writeFileSync(path.join(root, 'versions', version, 'walnut'), `#!/bin/sh\necho '${version} (old)'\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, BINARY_MARKER), JSON.stringify({ layout: 'versions', target: TARGET }))
  swapLink(root, version)
  return { root, target: TARGET, version }
}
const run = (root: string) => execFileSync(path.join(root, 'bin', 'walnut'), ['--version'], { encoding: 'utf8' }).trim()
/** The pid of a process that has exited (a shell that printed its own pid). */
const deadPid = () => Number(spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
const listVersions = (root: string) => fs.readdirSync(path.join(root, 'versions')).sort()

describe('registryBaseFor', () => {
  it('is the registry whose dist-tags the update check reads, else npm', () => {
    expect(registryBaseFor('http://127.0.0.1:4873/-/package/open-walnut/dist-tags')).toBe('http://127.0.0.1:4873')
    expect(registryBaseFor('https://registry.npmjs.org/-/package/open-walnut/dist-tags')).toBe('https://registry.npmjs.org')
    expect(registryBaseFor(undefined)).toBe('https://registry.npmjs.org')
    expect(registryBaseFor('http://stub/tags.json')).toBe('https://registry.npmjs.org')
  })
})

describe('installFileVersion', () => {
  it('downloads the platform package, checks it, and swaps the link; the old version stays for a rollback', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const logs: string[] = []
    const out = await installFileVersion({ install, version: '0.8.0', registry: base, log: (l) => logs.push(l) })
    expect(out).toMatchObject({ from: '0.7.0', to: '0.8.0', removed: [] })
    expect(run(install.root)).toBe('0.8.0 (abc12345, standin)')
    expect(fs.readlinkSync(path.join(install.root, 'bin', 'walnut'))).toBe(path.join('..', 'versions', '0.8.0', 'walnut'))
    expect(listVersions(install.root)).toEqual(['0.7.0', '0.8.0'])
    expect(fs.readdirSync(path.join(install.root, 'versions', '0.8.0'))).toEqual(['walnut'])
    expect(fs.statSync(path.join(install.root, 'versions', '0.8.0', 'walnut')).mode & 0o777).toBe(0o755)
    // The scoped name goes out encoded, as npm sends it.
    expect(hits[0]).toBe('/@open-walnut/darwin-arm64/0.8.0')
    expect(logs.at(-1)).toMatch(/^Installed Open Walnut 0\.8\.0/)
    expect(versionInUse(install.root)).toBe('0.8.0')
  })

  it('a third version removes the oldest', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    publish('0.9.0')
    await installFileVersion({ install, version: '0.8.0', registry: base })
    const out = await installFileVersion({ install, version: '0.9.0', registry: base })
    expect(out.from).toBe('0.8.0')
    expect(out.removed).toEqual([path.join('versions', '0.7.0')])
    expect(listVersions(install.root)).toEqual(['0.8.0', '0.9.0'])
  })

  it('the archive an older install.sh put in place stays while it is the one replaced, and goes after', async () => {
    const install = layout('0.7.0')
    fs.mkdirSync(path.join(install.root, 'app', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(install.root, 'app', 'bin', 'walnut'), '#!/bin/sh\necho 0.6.9 archive\n', { mode: 0o755 })
    fs.rmSync(path.join(install.root, 'bin', 'walnut'))
    fs.symlinkSync(path.join('..', 'app', 'bin', 'walnut'), path.join(install.root, 'bin', 'walnut'))
    publish('0.8.0')
    publish('0.9.0')
    const first = await installFileVersion({ install, version: '0.8.0', registry: base })
    expect(first).toMatchObject({ from: 'app', removed: [path.join('versions', '0.7.0')] })
    expect(fs.existsSync(path.join(install.root, 'app', 'bin', 'walnut'))).toBe(true)
    const second = await installFileVersion({ install, version: '0.9.0', registry: base })
    expect(second.removed).toEqual(['app'])
    expect(listVersions(install.root)).toEqual(['0.8.0', '0.9.0'])
  })

  it('a download that does not match its integrity changes nothing and leaves nothing behind', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    served.set('0.8.0', { ...served.get('0.8.0')!, integrity: `sha512-${crypto.createHash('sha512').update('other').digest('base64')}` })
    await expect(installFileVersion({ install, version: '0.8.0', registry: base })).rejects.toThrow(/does not match its integrity/)
    expect(run(install.root)).toBe('0.7.0 (old)')
    expect(listVersions(install.root)).toEqual(['0.7.0'])
    expect(fs.existsSync(path.join(install.root, '.update.lock'))).toBe(false)
  })

  it('a file that does not run here, or reports another version, changes nothing', async () => {
    const install = layout('0.7.0')
    publish('0.8.0', standIn('0.8.0', 'exec format error'))
    await expect(installFileVersion({ install, version: '0.8.0', registry: base })).rejects.toThrow(/does not run here/)
    publish('0.8.1', standIn('0.8.1', '0.8.0 (abc, standin)'))
    await expect(installFileVersion({ install, version: '0.8.1', registry: base })).rejects.toThrow(/does not run here/)
    expect(run(install.root)).toBe('0.7.0 (old)')
    expect(listVersions(install.root)).toEqual(['0.7.0'])
  })

  it('a version the registry does not have, or that is no version, changes nothing', async () => {
    const install = layout('0.7.0')
    await expect(installFileVersion({ install, version: '0.8.0', registry: base })).rejects.toThrow('@open-walnut/darwin-arm64@0.8.0 is not published')
    await expect(installFileVersion({ install, version: '../0.8.0', registry: base })).rejects.toThrow('is not a version')
    expect(listVersions(install.root)).toEqual(['0.7.0'])
  })

  it('one update at a time per root: a live holder keeps the lock however long it takes', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const lock = path.join(install.root, '.update.lock')
    // Just made, its owner line not written yet: a lock being taken.
    fs.mkdirSync(lock)
    await expect(installFileVersion({ install, version: '0.8.0', registry: base })).rejects.toThrow(/another update .* is running/)
    // A live owner (this test process, as install.sh writes it) holds it, two hours on.
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} install.sh ${await processStart(process.pid)}\n`)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    fs.utimesSync(lock, old, old)
    await expect(installFileVersion({ install, version: '0.8.0', registry: base })).rejects.toThrow(/another update .* is running/)
    expect(run(install.root)).toBe('0.7.0 (old)')
    // The same pid with another start time: the holder is gone and its pid was handed on.
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} install.sh Mon Jan  1 00:00:00 2001\n`)
    await installFileVersion({ install, version: '0.8.0', registry: base })
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
    expect(fs.readdirSync(install.root).filter((n) => n.startsWith('.update.lock'))).toEqual([])
  })

  it('a lock whose owner line was never written is taken over after a minute', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const lock = path.join(install.root, '.update.lock')
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 61_000)
    fs.utimesSync(lock, old, old)
    await installFileVersion({ install, version: '0.8.0', registry: base })
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
  })

  it('an update told to stop (a signal, the startup budget) cleans up and changes nothing', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const stop = new AbortController()
    stop.abort(new Error('stopped by SIGTERM'))
    await expect(installFileVersion({ install, version: '0.8.0', registry: base, signal: stop.signal })).rejects.toThrow()
    expect(run(install.root)).toBe('0.7.0 (old)')
    expect(listVersions(install.root)).toEqual(['0.7.0'])
    expect(fs.existsSync(path.join(install.root, '.update.lock'))).toBe(false)
    // Stopped half way through the download: the same.
    const slow = new AbortController()
    publish('0.9.0')
    const pending = installFileVersion({ install, version: '0.9.0', registry: base, signal: slow.signal, fetchImpl: async (url, init) => {
      if (String(url).includes('/tgz/')) slow.abort(new Error('it took longer than 60 s'))
      return fetch(url, init)
    } })
    await expect(pending).rejects.toThrow()
    expect(run(install.root)).toBe('0.7.0 (old)')
    expect(listVersions(install.root)).toEqual(['0.7.0'])
    expect(fs.existsSync(path.join(install.root, '.update.lock'))).toBe(false)
  })

  it('goes back to the version before after a failed start, holds the new one back, and can undo that', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    await installFileVersion({ install, version: '0.8.0', registry: base })
    await rollBack(install.root, '0.7.0', '0.8.0', 'exited with 1 before it served')
    expect(run(install.root)).toBe('0.7.0 (old)')
    expect(fs.readFileSync(path.join(install.root, 'bad', '0.8.0'), 'utf8')).toContain('exited with 1 before it served')
    await undoRollBack(install.root, '0.8.0')
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
    expect(fs.existsSync(path.join(install.root, 'bad', '0.8.0'))).toBe(false)
    // A version that is gone cannot be gone back to; nothing changes.
    await expect(rollBack(install.root, '0.6.0', '0.8.0', 'x')).rejects.toThrow(/is gone/)
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
    // Installing a held-back version on purpose clears its mark.
    await rollBack(install.root, '0.7.0', '0.8.0', 'exited with 1 before it served')
    await installFileVersion({ install, version: '0.8.0', registry: base })
    expect(fs.existsSync(path.join(install.root, 'bad', '0.8.0'))).toBe(false)
  })

  it('a lock whose owner is gone (an update stopped with Ctrl-C) is taken over at once', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const lock = path.join(install.root, '.update.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${deadPid()} 1a2b3c\n`)
    await installFileVersion({ install, version: '0.8.0', registry: base })
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('a server still running from a version keeps it through any number of updates, until it exits', async () => {
    const install = layout('0.7.0')
    for (const v of ['0.8.0', '0.9.0', '0.10.0']) publish(v)
    // The server started on 0.7.0 (web.ts marks it), then two updates ran without a restart.
    const unmark = markRunning(install.root, '0.7.0')
    await installFileVersion({ install, version: '0.8.0', registry: base })
    const third = await installFileVersion({ install, version: '0.9.0', registry: base })
    expect(third.removed).toEqual([])
    expect(listVersions(install.root)).toEqual(['0.7.0', '0.8.0', '0.9.0'])
    expect(fs.readFileSync(path.join(install.root, 'versions', '0.7.0', 'walnut'), 'utf8')).toContain('0.7.0 (old)')
    // Once it exits, the next update removes it.
    unmark()
    const fourth = await installFileVersion({ install, version: '0.10.0', registry: base })
    expect(fourth.removed.sort()).toEqual([path.join('versions', '0.7.0'), path.join('versions', '0.8.0')])
    expect(listVersions(install.root)).toEqual(['0.10.0', '0.9.0'])
  })

  it('two updates started together: one installs, the other is refused, the link is whole', async () => {
    const install = layout('0.7.0')
    publish('0.8.0')
    const both = await Promise.allSettled([
      installFileVersion({ install, version: '0.8.0', registry: base }),
      installFileVersion({ install, version: '0.8.0', registry: base }),
    ])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(run(install.root)).toMatch(/^0\.8\.0 /)
    expect(listVersions(install.root)).toEqual(['0.7.0', '0.8.0'])
  })
})

describe('the layout helpers', () => {
  it('reads the version in use off the link, the archive as "app"', () => {
    const install = layout('0.7.0')
    expect(versionInUse(install.root)).toBe('0.7.0')
    fs.rmSync(path.join(install.root, 'bin', 'walnut'))
    fs.symlinkSync(path.join('..', 'app', 'bin', 'walnut'), path.join(install.root, 'bin', 'walnut'))
    expect(versionInUse(install.root)).toBe('app')
    fs.rmSync(path.join(install.root, 'bin', 'walnut'))
    expect(versionInUse(install.root)).toBeNull()
  })

  it('prune keeps what it is told and its own work, and removes only what the layout puts there', () => {
    const install = layout('0.7.0')
    for (const v of ['0.6.0', '0.8.0']) {
      fs.mkdirSync(path.join(install.root, 'versions', v))
      fs.writeFileSync(path.join(install.root, 'versions', v, 'walnut'), '')
    }
    // Not a version of this layout (no walnut in it), and a dot directory it never makes.
    for (const v of ['notes', '.cache', '.download-0.9.0-aaaa', '.download-0.9.0-bbbb']) fs.mkdirSync(path.join(install.root, 'versions', v))
    const own = path.join(install.root, 'versions', '.download-0.9.0-bbbb')
    const removed = pruneVersions(install.root, ['0.8.0', '0.7.0'], { running: [], ownWork: own })
    // Under the update lock, another update's work directory is a leftover.
    expect(removed.sort()).toEqual([path.join('versions', '.download-0.9.0-aaaa'), path.join('versions', '0.6.0')])
    expect(listVersions(install.root)).toEqual(['.cache', '.download-0.9.0-bbbb', '0.7.0', '0.8.0', 'notes'])
  })

  it('the Node archive goes only while nothing runs from it', async () => {
    const install = layout('0.7.0')
    const app = path.join(install.root, 'app')
    fs.mkdirSync(path.join(app, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(app, 'bin', 'walnut'), '#!/bin/sh\n', { mode: 0o755 })
    const runner = path.join(app, 'bin', 'runner')
    fs.writeFileSync(runner, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 })
    expect(await processesRunFrom(app)).toBe(false)
    const child = spawn(runner, [], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      expect(await processesRunFrom(app)).toBe(true)
      expect(pruneVersions(install.root, ['0.7.0'], { running: [], appInUse: true })).toEqual([])
      // ps not asked (the default): kept too.
      expect(pruneVersions(install.root, ['0.7.0'], { running: [] })).toEqual([])
    } finally {
      child.kill()
    }
    expect(pruneVersions(install.root, ['0.7.0'], { running: [], appInUse: false })).toEqual(['app'])
  })

  it('a running marker counts while its process lives; a dead one is removed and keeps nothing', () => {
    const install = layout('0.7.0')
    for (const v of ['0.6.0', '0.5.0']) {
      fs.mkdirSync(path.join(install.root, 'versions', v))
      fs.writeFileSync(path.join(install.root, 'versions', v, 'walnut'), '')
    }
    const unmark = markRunning(install.root, '0.6.0')
    const dead = deadPid()
    fs.writeFileSync(path.join(install.root, 'running', String(dead)), '0.5.0\n')
    fs.writeFileSync(path.join(install.root, 'running', 'notes'), '0.5.0\n')
    expect(versionsRunning(install.root)).toEqual(['0.6.0'])
    expect(fs.existsSync(path.join(install.root, 'running', String(dead)))).toBe(false)
    expect(pruneVersions(install.root, ['0.7.0'])).toEqual([path.join('versions', '0.5.0')])
    expect(listVersions(install.root)).toEqual(['0.6.0', '0.7.0'])
    unmark()
    expect(versionsRunning(install.root)).toEqual([])
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(dead)).toBe(false)
    // Never a probe of every process (-1) or this group (0).
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(0)).toBe(false)
  })

  it('the lock is released only by the update holding it, and names its owner and when it started', async () => {
    const root = fs.mkdtempSync(path.join(scratch, 'lock-'))
    const release = await takeLock(root)
    const owner = path.join(root, '.update.lock', 'owner')
    const started = await processStart(process.pid)
    expect(started).toMatch(/\d{4}$/)
    expect(fs.readFileSync(owner, 'utf8')).toBe(`${process.pid} ${fs.readFileSync(owner, 'utf8').split(' ')[1]} ${started}\n`)
    await expect(takeLock(root)).rejects.toThrow(/another update .* is running/)
    // Taken over meanwhile (this one ran too long): its release leaves the new holder's lock alone.
    fs.writeFileSync(owner, `${process.pid} ffffffffffff ${started}\n`)
    release()
    expect(fs.existsSync(owner)).toBe(true)
    fs.rmSync(path.join(root, '.update.lock'), { recursive: true })
    const mine = await takeLock(root)
    mine()
    expect(fs.existsSync(path.join(root, '.update.lock'))).toBe(false)
    // An owner not written yet is a lock being made: it holds until it is a minute old.
    fs.mkdirSync(path.join(root, '.update.lock'))
    await expect(takeLock(root, { alive: () => false })).rejects.toThrow(/another update .* is running/)
    // Another taker inside the takeover directory: this one does not race it.
    fs.writeFileSync(path.join(root, '.update.lock', 'owner'), `${deadPid()} 1a2b3c\n`)
    fs.mkdirSync(path.join(root, '.update.lock.takeover'))
    await expect(takeLock(root)).rejects.toThrow(/another update .* is running/)
    // One that died in there: its takeover directory goes after a minute.
    const old = new Date(Date.now() - 61_000)
    fs.utimesSync(path.join(root, '.update.lock.takeover'), old, old)
    ;(await takeLock(root))()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('takes the one file out of a tarball with long names and pax headers', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'tar-'))
    const deep = path.join(dir, 'package', 'a'.repeat(60), 'b'.repeat(60))
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'x.txt'), 'deep')
    fs.writeFileSync(path.join(dir, 'package', 'walnut'), 'the file é')
    const tar = path.join(dir, 'p.tar')
    execFileSync('tar', ['-cf', tar, '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    extractTarEntry(tar, `package/${'a'.repeat(60)}/${'b'.repeat(60)}/x.txt`, path.join(dir, 'out1'))
    expect(fs.readFileSync(path.join(dir, 'out1'), 'utf8')).toBe('deep')
    extractTarEntry(tar, 'package/walnut', path.join(dir, 'out2'))
    expect(fs.readFileSync(path.join(dir, 'out2'), 'utf8')).toBe('the file é')
    expect(() => extractTarEntry(tar, 'package/missing', path.join(dir, 'out3'))).toThrow('holds no package/missing')
  })
})
