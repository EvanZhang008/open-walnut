/**
 * Update a `binary` install (install-kind.ts): the compiled file in install.sh's
 * versions layout, the way Claude Code's native installer keeps its own.
 *
 *   <root>/versions/<version>/walnut   one directory per installed version
 *   <root>/bin/walnut                  link to the one in use (relative); every
 *                                      `walnut` on PATH links here
 *   <root>/open-walnut-install.json    install.sh's marker, naming the target
 *
 * The new file comes from npm, from the same platform package an npm install
 * gets (`@open-walnut/<target>`, scripts/npm-packages.mjs), checked against the
 * integrity the registry gives for it. npm is where the update check already
 * looks (update-check.ts), and a release moves its dist-tag only after its
 * platform packages are up, so a version the check reports always has its
 * file; the nightly channel, which has no GitHub Release, works the same way.
 *
 * Steps: download beside the versions, check the sha512, unpack the one file,
 * run its `--version`, rename it into versions/<version>, then swap the link
 * with one rename. Until that rename nothing a user runs has changed; a failure
 * at any step leaves the old version in use and nothing behind. The version it
 * replaced stays for a rollback (rollBack, or the link pointed back by hand);
 * older ones go, except a version a running server still sits in
 * (`<root>/running/<pid>`, markRunning), and only what this layout puts there.
 * One update at a time per root (install-lock.ts), and install.sh takes the
 * same lock. A caller's AbortSignal ends it cleanly up to the swap.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { binaryLinkOf, type BinaryInstall } from './install-kind.js'
import { clearBad, markBad } from './held-versions.js'
import { pidAlive, takeLock } from './install-lock.js'

export { pidAlive, takeLock }

export const PLATFORM_SCOPE = '@open-walnut'
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
/** Where the file sits in its platform package (npm packs everything under `package/`). */
export const PACKAGE_FILE = 'package/walnut'
const DIST_TAGS_SUFFIX = '/-/package/open-walnut/dist-tags'
const VERSION_TIMEOUT_MS = 60_000
const META_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

/** The registry the update check reads (its dist-tags URL) is the one the file comes from. */
export function registryBaseFor(distTagsUrl: string | undefined): string {
  const url = distTagsUrl?.trim()
  if (url && url.endsWith(DIST_TAGS_SUFFIX)) return url.slice(0, -DIST_TAGS_SUFFIX.length)
  return DEFAULT_NPM_REGISTRY
}

/** `@open-walnut/<target>` in a registry URL path (the slash encoded, as npm sends it). */
export const platformPackage = (target: string): string => `${PLATFORM_SCOPE}/${target}`
const registryPath = (target: string): string => `${PLATFORM_SCOPE}%2f${target}`

export interface PlatformDist { tarball: string; integrity: string }

/** A deadline of its own, ended early by the caller's `signal` (a startup's budget, a Ctrl-C). */
const deadline = (ms: number, signal?: AbortSignal): AbortSignal => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms))

/** The tarball URL and sha512 integrity of `@open-walnut/<target>@<version>`. */
export async function fetchPlatformDist(registry: string, target: string, version: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<PlatformDist> {
  const url = `${registry.replace(/\/$/, '')}/${registryPath(target)}/${encodeURIComponent(version)}`
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: deadline(META_TIMEOUT_MS, signal) })
  if (res.status === 404) throw new Error(`${platformPackage(target)}@${version} is not published`)
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for ${platformPackage(target)}@${version}`)
  const body = (await res.json()) as { dist?: { tarball?: unknown; integrity?: unknown } } | null
  const tarball = body?.dist?.tarball
  const integrity = body?.dist?.integrity
  if (typeof tarball !== 'string' || !tarball) throw new Error(`the registry names no tarball for ${platformPackage(target)}@${version}`)
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity.split(/\s+/).find((s) => s.startsWith('sha512-')) ?? '')) {
    throw new Error(`the registry gives no sha512 for ${platformPackage(target)}@${version}`)
  }
  return { tarball, integrity: integrity.split(/\s+/).find((s) => s.startsWith('sha512-'))! }
}

/** Download `url` to `dest`, refusing it unless its sha512 is `integrity`. Returns its size. */
export async function downloadVerified(url: string, dest: string, integrity: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<number> {
  const res = await fetchImpl(url, { signal: deadline(DOWNLOAD_TIMEOUT_MS, signal) })
  if (!res.ok || !res.body) throw new Error(`GET ${url} answered HTTP ${res.status}`)
  const hash = crypto.createHash('sha512')
  const out = await fs.promises.open(dest, 'w', 0o600)
  let bytes = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      bytes += chunk.byteLength
      await out.write(chunk)
    }
  } finally {
    await out.close()
  }
  if (`sha512-${hash.digest('base64')}` !== integrity) throw new Error(`the download of ${url} does not match its integrity (a broken or tampered download)`)
  return bytes
}

/**
 * Copy one regular file out of a tar (ustar, with pax and GNU long names), by
 * positional reads: an npm tarball holds a few files, the one wanted is large.
 */
export function extractTarEntry(tarPath: string, entry: string, outPath: string): void {
  const fd = fs.openSync(tarPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const header = Buffer.alloc(512)
    let offset = 0
    let longName: string | null = null
    while (offset + 512 <= size) {
      fs.readSync(fd, header, 0, 512, offset)
      if (header.every((b) => b === 0)) break
      const field = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '')
      const bodySize = parseInt(field(124, 12).trim() || '0', 8)
      const type = field(156, 1) || '0'
      const prefix = field(345, 155)
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
      longName = null
      const body = offset + 512
      if (type === 'x' || type === 'L') {
        const data = Buffer.alloc(bodySize)
        fs.readSync(fd, data, 0, bodySize, body)
        if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '')
        else {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
          if (m) longName = m[1]!
        }
      } else if ((type === '0' || type === '\0') && name === entry) {
        const out = fs.openSync(outPath, 'w', 0o700)
        try {
          const chunk = Buffer.alloc(1 << 20)
          for (let done = 0; done < bodySize;) {
            const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bodySize - done), body + done)
            if (n <= 0) throw new Error(`the tarball ends inside ${entry}`)
            fs.writeSync(out, chunk, 0, n)
            done += n
          }
        } finally {
          fs.closeSync(out)
        }
        return
      }
      offset = body + Math.ceil(bodySize / 512) * 512
    }
  } finally {
    fs.closeSync(fd)
  }
  throw new Error(`the package holds no ${entry}`)
}

/** `<file> --version`, as a person runs it: its first word must be `version`. */
export function versionOfFile(file: string, timeoutMs = VERSION_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  const env = { ...process.env }
  // A file told to be bun would run `--version` as bun's own.
  delete env.BUN_BE_BUN
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { env, timeout: timeoutMs, encoding: 'utf8', signal }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} --version failed: ${(stderr || err.message).trim().slice(0, 300)}`))
      else resolve(stdout.trim())
    })
  })
}

const runningDirOf = (root: string): string => path.join(root, 'running')

/**
 * Mark `version` as the one this process runs from, until it exits: a server
 * keeps starting its own file (each session's Walnut tools, the daemon), so no
 * update may remove that file while it runs. Returns the unmark.
 */
export function markRunning(root: string, version: string, pid = process.pid): () => void {
  const marker = path.join(runningDirOf(root), String(pid))
  try {
    fs.mkdirSync(runningDirOf(root), { recursive: true })
    fs.writeFileSync(marker, `${version}\n`)
  } catch {
    return () => {}
  }
  const unmark = () => { try { fs.rmSync(marker, { force: true }) } catch { /* gone */ } }
  process.once('exit', unmark)
  return unmark
}

/** The versions a live process marked (markRunning); a dead process's marker is removed. */
export function versionsRunning(root: string, alive: (pid: number) => boolean = pidAlive): string[] {
  const dir = runningDirOf(root)
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = new Set<string>()
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const marker = path.join(dir, name)
    if (!alive(Number(name))) {
      fs.rmSync(marker, { force: true })
      continue
    }
    try {
      const version = fs.readFileSync(marker, 'utf8').trim()
      if (version) out.add(version)
    } catch { /* just removed */ }
  }
  return [...out]
}

/** Where `<root>/bin/walnut` points now, as a version directory name ('app' for the archive), or null. */
export function versionInUse(root: string): string | null {
  let target: string
  try {
    target = fs.readlinkSync(binaryLinkOf(root))
  } catch {
    return null
  }
  const abs = path.resolve(path.dirname(binaryLinkOf(root)), target)
  const rel = path.relative(root, abs).split(path.sep)
  if (rel[0] === 'versions' && rel.length === 3) return rel[1]!
  if (rel[0] === 'app') return 'app'
  return null
}

/** Point `<root>/bin/walnut` at a version with one rename, so a reader sees the old link or the new one. */
export function swapLink(root: string, version: string): void {
  const link = binaryLinkOf(root)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const tmp = `${link}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  fs.symlinkSync(path.join('..', 'versions', version, 'walnut'), tmp)
  try {
    fs.renameSync(tmp, link)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Does any process run from `dir`? A Walnut from the Node archive marks nothing,
 * so its own command line (`<root>/app/runtime/bin/node ...`) is what says so.
 * When ps cannot answer, the answer is yes: nothing is removed on a guess.
 */
export function processesRunFrom(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'command='], { timeout: 10_000, encoding: 'utf8', maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) return resolve(true)
      resolve(stdout.split('\n').some((line) => line.includes(`${dir}${path.sep}`)))
    })
  })
}

export interface PruneOptions {
  /** The versions running Walnut servers sit in (versionsRunning). */
  running?: string[]
  /** This update's own work directory, never a leftover. */
  ownWork?: string
  /** Does a process still run from the Node archive (processesRunFrom)? Default: yes, keep it. */
  appInUse?: boolean
}

/**
 * Remove every version but `keep` and the ones a running Walnut sits in, and
 * leftovers of an update that stopped half way. Runs under the update lock, so
 * a `.download-*` directory that is not this update's own is a leftover. Only
 * what this layout puts there goes: a version directory holding a `walnut`
 * file, and the Node archive while nothing runs from it.
 */
export function pruneVersions(root: string, keep: Array<string | null>, opts: PruneOptions = {}): string[] {
  const kept = [...keep, ...(opts.running ?? versionsRunning(root))]
  const removed: string[] = []
  const versions = path.join(root, 'versions')
  let names: string[] = []
  try { names = fs.readdirSync(versions) } catch { /* none */ }
  for (const name of names) {
    const full = path.join(versions, name)
    if (name.startsWith('.')) {
      if (!name.startsWith('.download-') || full === opts.ownWork) continue
    } else if (kept.includes(name) || !fs.existsSync(path.join(full, 'walnut'))) continue
    fs.rmSync(full, { recursive: true, force: true })
    removed.push(path.join('versions', name))
  }
  // The self-contained archive install.sh used to put here, once it is neither and nothing runs from it.
  const app = path.join(root, 'app')
  if (!kept.includes('app') && opts.appInUse === false && fs.existsSync(path.join(app, 'bin', 'walnut'))) {
    fs.rmSync(app, { recursive: true, force: true })
    removed.push('app')
  }
  return removed
}

/**
 * Point the link back at `from` after `to` failed to start, and hold `to` back
 * (held-versions.ts) until a newer release is published. Under the update lock.
 */
export async function rollBack(root: string, from: string, to: string, reason: string): Promise<void> {
  const release = await takeLock(root)
  try {
    if (!fs.existsSync(path.join(root, 'versions', from, 'walnut'))) throw new Error(`${path.join(root, 'versions', from)} is gone`)
    swapLink(root, from)
    markBad(path.join(root, 'bad'), to, reason)
  } finally {
    release()
  }
}

/** Undo rollBack: `to` was not the cause after all (`from` failed to start as well). */
export async function undoRollBack(root: string, to: string): Promise<void> {
  const release = await takeLock(root)
  try {
    if (fs.existsSync(path.join(root, 'versions', to, 'walnut'))) swapLink(root, to)
    clearBad(path.join(root, 'bad'), to)
  } finally {
    release()
  }
}

export interface InstallFileOptions {
  install: BinaryInstall
  version: string
  registry: string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  now?: () => number
  /** Ends the update early (a startup's time budget, a signal); it then cleans up and throws. */
  signal?: AbortSignal
}

export interface InstallFileResult { from: string | null; to: string; file: string; removed: string[] }

/**
 * Install `version` of the file into the layout and make it the one in use.
 * Throws with a one-line reason; the version in use is then unchanged.
 */
export async function installFileVersion(opts: InstallFileOptions): Promise<InstallFileResult> {
  const { install, version } = opts
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${version} is not a version`)
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const signal = opts.signal
  const versions = path.join(install.root, 'versions')
  const release = await takeLock(install.root, { now })
  const work = path.join(versions, `.download-${version}-${crypto.randomBytes(4).toString('hex')}`)
  try {
    fs.mkdirSync(work, { recursive: true })
    const dist = await fetchPlatformDist(opts.registry, install.target, version, fetchImpl, signal)
    log(`Downloading Open Walnut ${version} (${install.target})...`)
    const tgz = path.join(work, 'package.tgz')
    const bytes = await downloadVerified(dist.tarball, tgz, dist.integrity, fetchImpl, signal)
    const tar = path.join(work, 'package.tar')
    await pipeline(fs.createReadStream(tgz), zlib.createGunzip(), fs.createWriteStream(tar), { signal })
    fs.rmSync(tgz)
    const staged = path.join(work, 'walnut')
    extractTarEntry(tar, PACKAGE_FILE, staged)
    fs.rmSync(tar)
    fs.chmodSync(staged, 0o755)
    const printed = await versionOfFile(staged, VERSION_TIMEOUT_MS, signal)
    if (printed.split(/\s/)[0] !== version) throw new Error(`the downloaded Walnut does not run here (it printed: ${printed.slice(0, 200) || 'nothing'})`)
    // Nothing a user runs has changed yet: the last moment to give up cleanly.
    signal?.throwIfAborted()
    const from = versionInUse(install.root)
    const running = versionsRunning(install.root)
    const dir = path.join(versions, version)
    // A directory of this version that is not in use is a leftover; the new copy replaces it.
    // One a server runs from is kept as it is (the same version, already checked when it went in).
    const keepDir = from === version || (running.includes(version) && fs.existsSync(path.join(dir, 'walnut')))
    if (!keepDir) fs.rmSync(dir, { recursive: true, force: true })
    const placed = !fs.existsSync(dir)
    if (placed) fs.renameSync(work, dir)
    try {
      swapLink(install.root, version)
    } catch (err) {
      // A newer version installed and not linked reads as one the user moved back from (held-versions.ts).
      if (placed) fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
    // The same version again replaced nothing: whatever was kept before stays.
    clearBad(path.join(install.root, 'bad'), version)
    const appInUse = fs.existsSync(path.join(install.root, 'app')) ? await processesRunFrom(path.join(install.root, 'app')) : false
    const removed = from === version ? [] : pruneVersions(install.root, [version, from], { running, ownWork: work, appInUse })
    log(`Installed Open Walnut ${version} (${Math.round(bytes / 1048576)} MB download).`)
    return { from, to: version, file: path.join(dir, 'walnut'), removed }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    release()
  }
}
