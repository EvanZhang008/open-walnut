/**
 * The walnut file a host server runs: THIS server's build, compiled for the
 * host's target (host-target.ts), gzipped for the upload
 * (docs/plan/walnut-servers-everywhere.md, "Runtime"). Where it comes from:
 *
 *   a dist of a git checkout that has scripts/build-binary.mjs: built for the
 *     target in a clone of the dist's commit (host-file-build.ts), about a
 *     minute, once per build and target;
 *   any other build (the compiled file, an npm install) of a published version:
 *     the release asset walnut-<version>-<target>.gz (scripts/release-files.mjs),
 *     checked against the release's SHA256SUMS. The host needs no network: this
 *     computer downloads it once and sends it;
 *   anything else (running from source, a build with uncommitted changes and no
 *     checkout, a version that was never released): an error that says so. There
 *     is no fallback to installing anything on the host.
 *
 *   <data>/cache/host-server/files/<id>/walnut-<target>.gz    the newest few builds
 *   <data>/cache/host-server/files/<id>/walnut-<target>.json  its sha256s, written last
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { WALNUT_REPO_URL } from '../../constants.js'
import { formatBuildVersion, getBuildInfo, type BuildInfo } from '../../lib/build-info.js'
import { singleFile } from '../../lib/single-file.js'
import { buildIdOf } from '../companion-build/wire.js'
import { buildFileInClone, findBun, pinnedBun, type BunPick, type CloneBuild } from './host-file-build.js'
import type { HostFileTarget } from './host-target.js'
import { readRunningBuild, runningDist } from './package.js'

export interface HostFile {
  id: string
  version: string
  target: HostFileTarget
  gz: Buffer
  /** sha256 of the unpacked file (the install checks it on the host). */
  sha256: string
}

export interface HostFileSource {
  /** The id this server's build installs under on a host: no build, no download. */
  buildId(): Promise<{ id: string; version: string }>
  /** This server's build as the file for `target`: from the cache, else built or downloaded (`say` tells how it goes). */
  file(target: HostFileTarget, say?: (message: string) => void): Promise<HostFile>
}

/** Where this server's build came from. */
export type BuildOrigin =
  | { kind: 'checkout'; checkout: string; distDir: string; info: BuildInfo; id: string }
  | { kind: 'release'; info: BuildInfo; id: string; what: string }
  | { kind: 'none'; why: string }

export interface HostFileSourceOptions {
  /** <data>/cache/host-server */
  cacheDir: string
  origin?: () => Promise<BuildOrigin>
  fetch?: typeof fetch
  /** Like install.sh's OPEN_WALNUT_RELEASE_BASE_URL: `<base>/v<version>/<asset>`; `file://<dir>` is a directory laid out the same way. */
  releaseBase?: string
  /** Builds the file in a clone (host-file-build.ts); returns the built file's path. */
  build?: (b: CloneBuild) => Promise<string>
  /** A bun of `min` or newer to build with (host-file-build.ts findBun). */
  bun?: (min: string | null) => Promise<BunPick>
}

const KEEP_BUILDS = 3
const LOG_KEEP_MS = 7 * 24 * 3_600_000
const SUMS_MS = 30_000
const DOWNLOAD_MS = 10 * 60_000
const MAX_FILE_BYTES = 400 * 1024 * 1024
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function defaultReleaseBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_WALNUT_RELEASE_BASE_URL?.trim().replace(/\/+$/, '') || `${WALNUT_REPO_URL.replace(/\.git$/, '')}/releases/download`
}

async function isCheckout(root: string): Promise<boolean> {
  const has = (rel: string) => fs.promises.access(path.join(root, rel)).then(() => true, () => false)
  const all = await Promise.all(['.git', 'scripts/build-binary.mjs', 'src/binary/main.ts', 'node_modules'].map(has))
  return all.every(Boolean)
}

/** Where the running process's build came from (`dist`, `compiled`: tests). */
export async function runningOrigin(dist = runningDist(), compiled = singleFile() !== null): Promise<BuildOrigin> {
  if (dist) {
    const { id, info } = await readRunningBuild(dist)
    if (await isCheckout(dist.root)) return { kind: 'checkout', checkout: dist.root, distDir: dist.distDir, info, id }
    return { kind: 'release', info, id, what: 'this install of Walnut' }
  }
  if (compiled) {
    const info = getBuildInfo()
    return { kind: 'release', info, id: buildIdOf(info), what: 'this compiled walnut file' }
  }
  return {
    kind: 'none',
    why: 'This server runs from source, not from a build, so it has no build to send to a host. Build it (`bun run build`) and run the server from dist.',
  }
}

/** sha256 of a file, read in chunks (a file of 60 MB hashed at once would hold the event loop). */
async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hasher(hash, MAX_FILE_BYTES, file), new Writable({ write(_c, _e, cb) { cb() } }))
  return hash.digest('hex')
}

/** Hashes what passes through. */
function hasher(hash: crypto.Hash, limit: number, what: string): Transform {
  let n = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      if (n > limit) { cb(new Error(`${what} is larger than ${Math.round(limit / 2 ** 20)} MB`)); return }
      hash.update(chunk)
      cb(null, chunk)
    },
  })
}

/** `{ gz, file }` sha256s of `walnut-<version>-<target>` in a SHA256SUMS text (release-files.mjs writes both). */
export function sumsFor(text: string, version: string, target: string): { gz?: string; file?: string } {
  const out: { gz?: string; file?: string } = {}
  const name = `walnut-${version}-${target}`
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim())
    if (!m) continue
    if (m[2] === `${name}.gz`) out.gz = m[1]
    else if (m[2] === name) out.file = m[1]
  }
  return out
}

export function createHostFileSource(opts: HostFileSourceOptions): HostFileSource {
  const origin = opts.origin ?? (() => runningOrigin())
  const build = opts.build ?? buildFileInClone
  const bun = opts.bun ?? ((min: string | null) => findBun(process.env, min))
  const fetchImpl = opts.fetch ?? fetch
  const filesDir = path.join(opts.cacheDir, 'files')
  const inflight = new Map<string, Promise<HostFile>>()
  let originOnce: Promise<BuildOrigin> | null = null
  // A deploy replaces the build this process runs only by restarting it.
  const getOrigin = (): Promise<BuildOrigin> => (originOnce ??= origin().catch((err) => { originOnce = null; throw err }))

  const paths = (id: string, target: string) => {
    const dir = path.join(filesDir, id)
    return { dir, gz: path.join(dir, `walnut-${target}.gz`), meta: path.join(dir, `walnut-${target}.json`) }
  }

  async function cached(id: string, version: string, target: HostFileTarget): Promise<HostFile | null> {
    const p = paths(id, target)
    try {
      const meta = JSON.parse(await fs.promises.readFile(p.meta, 'utf8')) as { sha256?: unknown; gzSha256?: unknown; gzBytes?: unknown }
      if (typeof meta.sha256 !== 'string' || (await fs.promises.stat(p.gz)).size !== meta.gzBytes || (await hashFile(p.gz)) !== meta.gzSha256) return null
      const gz = await fs.promises.readFile(p.gz)
      const now = new Date()
      await fs.promises.utimes(p.dir, now, now).catch(() => undefined)
      return { id, version, target, gz, sha256: meta.sha256 }
    } catch {
      return null
    }
  }

  /** Move a finished gz into the cache (meta last) and keep the newest few builds. */
  async function store(id: string, version: string, target: HostFileTarget, gzTmp: string, fileSha: string): Promise<HostFile> {
    const p = paths(id, target)
    const gzSha = await hashFile(gzTmp)
    const gz = await fs.promises.readFile(gzTmp)
    await fs.promises.mkdir(p.dir, { recursive: true })
    // Written beside its place (the build's own dir may be on another file system), then renamed.
    const gzPart = `${p.gz}.${process.pid}.tmp`
    await fs.promises.writeFile(gzPart, gz)
    await fs.promises.rename(gzPart, p.gz)
    const metaTmp = `${p.meta}.${process.pid}.tmp`
    await fs.promises.writeFile(metaTmp, JSON.stringify({ version, sha256: fileSha, gzSha256: gzSha, gzBytes: gz.length }))
    await fs.promises.rename(metaTmp, p.meta)
    await prune(id)
    return { id, version, target, gz, sha256: fileSha }
  }

  async function prune(keepId: string): Promise<void> {
    try {
      const names = await fs.promises.readdir(filesDir)
      const aged = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(filesDir, n)).catch(() => null))?.mtimeMs ?? 0 })))
      const old = aged.filter((a) => a.n !== keepId).sort((a, b) => b.t - a.t).slice(KEEP_BUILDS - 1)
      for (const { n } of old) await fs.promises.rm(path.join(filesDir, n), { recursive: true, force: true })
      // The host packages of the Node layout (package.ts's host family): nothing sends them any more.
      for (const n of await fs.promises.readdir(opts.cacheDir)) {
        const file = path.join(opts.cacheDir, n)
        if (n.endsWith('.tgz') && !/-companion-[a-z0-9]+-[a-z0-9]+\.tgz$/.test(n)) await fs.promises.rm(file, { force: true })
        else if (/^build-.+\.log$/.test(n) || /^download-/.test(n)) {
          // Build logs: a week, long enough to read why one failed. A download's dir: a process that died in it.
          const age = Date.now() - ((await fs.promises.stat(file).catch(() => null))?.mtimeMs ?? Date.now())
          if (age > (n.startsWith('download-') ? DOWNLOAD_MS * 6 : LOG_KEEP_MS)) await fs.promises.rm(file, { recursive: true, force: true })
        }
      }
    } catch { /* hygiene only */ }
  }

  async function fromCheckout(o: Extract<BuildOrigin, { kind: 'checkout' }>, target: HostFileTarget, say: (m: string) => void): Promise<HostFile> {
    if (!o.info.commit) throw new Error(`This server's build (${formatBuildVersion(o.info)}) names no commit, so the walnut file for ${target} cannot be built from its checkout.`)
    const min = pinnedBun(await fs.promises.readFile(path.join(o.checkout, 'package.json'), 'utf8').catch(() => ''))
    const pick = await bun(min)
    if ('why' in pick) throw new Error(pick.why)
    say(`Building Walnut ${o.id} for ${target} on this computer (about a minute, once per build).`)
    await fs.promises.mkdir(opts.cacheDir, { recursive: true })
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-host-file-'))
    try {
      const built = await build({
        checkout: o.checkout, distDir: o.distDir, commit: o.info.commit, dirty: o.info.dirty, target, work,
        log: path.join(opts.cacheDir, `build-${o.id}-${target}.log`), bun: pick.path,
      })
      const fileHash = crypto.createHash('sha256')
      const gzTmp = path.join(work, 'walnut.gz')
      await pipeline(fs.createReadStream(built), hasher(fileHash, MAX_FILE_BYTES, 'the built file'), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzTmp))
      return await store(o.id, o.info.version, target, gzTmp, fileHash.digest('hex'))
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true })
    }
  }

  async function body(url: string, timeoutMs: number): Promise<Readable | null> {
    if (url.startsWith('file://')) {
      const file = decodeURI(url.slice('file://'.length))
      return (await fs.promises.access(file).then(() => true, () => false)) ? fs.createReadStream(file) : null
    }
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (res.status === 404) return null
    if (!res.ok || !res.body) throw new Error(`${url} answered HTTP ${res.status}`)
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  }

  async function fromRelease(o: Extract<BuildOrigin, { kind: 'release' }>, target: HostFileTarget, say: (m: string) => void): Promise<HostFile> {
    const { version } = o.info
    const noCheckout = `${o.what} has no checkout to build the walnut file for ${target} from`
    if (o.info.dirty) {
      throw new Error(`This Walnut (${formatBuildVersion(o.info)}) was built from a tree with uncommitted changes, and ${noCheckout}. Install a released Walnut, or run Walnut from a checkout.`)
    }
    if (!RELEASE_VERSION.test(version)) throw new Error(`This Walnut's version (${version}) is not a release version, and ${noCheckout}.`)
    const base = (opts.releaseBase ?? defaultReleaseBase()).replace(/\/+$/, '')
    const sumsUrl = `${base}/v${version}/SHA256SUMS`
    const asset = `walnut-${version}-${target}.gz`
    let sums: { gz?: string; file?: string }
    try {
      const stream = await body(sumsUrl, SUMS_MS)
      if (!stream) throw Object.assign(new Error('absent'), { absent: true })
      const parts: Buffer[] = []
      for await (const c of stream) parts.push(c as Buffer)
      sums = sumsFor(Buffer.concat(parts).toString('utf8'), version, target)
    } catch (err) {
      if ((err as { absent?: boolean }).absent) {
        throw new Error(`Walnut ${version} is not a published release (${sumsUrl} is not there), and ${noCheckout}. Install a released Walnut, or run Walnut from a checkout.`)
      }
      throw new Error(`Could not read the release's checksums (${sumsUrl}: ${(err as Error).message}); this computer downloads the walnut file for the host once.`)
    }
    if (!sums.gz) throw new Error(`Release ${version} has no walnut file for ${target} (${asset} is not in its SHA256SUMS).`)
    say(`Downloading Walnut ${version} for ${target} (${asset}).`)
    await fs.promises.mkdir(opts.cacheDir, { recursive: true })
    const work = await fs.promises.mkdtemp(path.join(opts.cacheDir, 'download-'))
    try {
      const gzTmp = path.join(work, asset)
      const gzHash = crypto.createHash('sha256')
      const stream = await body(`${base}/v${version}/${asset}`, DOWNLOAD_MS)
      if (!stream) throw new Error(`Release ${version} lists ${asset} but does not have it.`)
      await pipeline(stream, hasher(gzHash, MAX_FILE_BYTES, asset), fs.createWriteStream(gzTmp))
      if (gzHash.digest('hex') !== sums.gz) throw new Error(`${asset} does not match its SHA256SUMS entry (a broken or tampered download).`)
      // The file inside, hashed for the host's own check (and against the release's line for it).
      const fileHash = crypto.createHash('sha256')
      await pipeline(fs.createReadStream(gzTmp), zlib.createGunzip(), hasher(fileHash, MAX_FILE_BYTES, 'the walnut file'), new Writable({ write(_c, _e, cb) { cb() } }))
      const fileSha = fileHash.digest('hex')
      if (sums.file && sums.file !== fileSha) throw new Error(`${asset} does not unpack to the file its SHA256SUMS names.`)
      return await store(o.id, version, target, gzTmp, fileSha)
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true })
    }
  }

  return {
    async buildId() {
      const o = await getOrigin()
      if (o.kind === 'none') throw new Error(o.why)
      return { id: o.id, version: o.info.version }
    },
    file(target, say = () => {}) {
      const run = async (): Promise<HostFile> => {
        const o = await getOrigin()
        if (o.kind === 'none') throw new Error(o.why)
        const hit = await cached(o.id, o.info.version, target)
        if (hit) return hit
        return o.kind === 'checkout' ? fromCheckout(o, target, say) : fromRelease(o, target, say)
      }
      const key = target
      const current = inflight.get(key)
      if (current) return current
      const p = run().finally(() => inflight.delete(key))
      inflight.set(key, p)
      return p
    },
  }
}
