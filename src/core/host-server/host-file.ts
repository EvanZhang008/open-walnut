/**
 * The walnut file a host server runs: THIS server's build, compiled for the
 * host's target (host-target.ts), gzipped for the upload
 * (docs/plan/walnut-servers-everywhere.md, "Runtime"). Where it comes from:
 *
 *   the walnut-<target> files beside the running build, when one build-binary
 *     run made them and this build: the compiled file runs as
 *     <stage>/dist-bin/walnut-<mac target> with its siblings in the same dir; a
 *     dist has them in <root>/dist-bin. One run gives every file the same asset
 *     archive, whose id is a plain string in each file;
 *   a build of a git checkout that has scripts/build-binary.mjs (also a deploy's
 *     staged copy of one: its `.walnut-source-root` names the checkout, as for
 *     WALNUT_INSTALL_DIR in src/constants.ts): built for the target in a clone of
 *     the build's commit (host-file-build.ts), about a minute, once per build;
 *     targets asked together are one build;
 *   any other build (the compiled file, an npm install) of a published version:
 *     the release asset walnut-<version>-<target>.gz (the release's
 *     SHA256SUMS checks it). The host needs no network: this computer downloads
 *     it once and sends it;
 *   anything else (running from source, a build with uncommitted changes, a
 *     version that was never released, a build that names no commit): an error
 *     that says so. There is no fallback to installing anything on the host.
 *
 * The host's install checks that the file answers `<version> (<commit>, ...`,
 * so a release built from another commit than this server is refused there.
 *
 *   <data>/cache/host-server/files/<id>/walnut-<target>.gz    the newest few builds
 *   <data>/cache/host-server/files/<id>/walnut-<target>.json  its sha256s, written last
 */

import { spawn } from 'node:child_process'
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
import {
  buildFileInClone, findBun, packageJsonAt, pinnedBun, pruneAbandonedWork, WORK_OWNER, type BunPick, type CloneBuild,
} from './host-file-build.js'
import type { HostFileTarget } from './host-target.js'
import { readRunningBuild, runningDist } from './package.js'

export interface HostFile {
  id: string
  version: string
  /** The commit the file was built from: the host's install checks the file says it. */
  commit: string | null
  target: HostFileTarget
  gz: Buffer
  /** sha256 of the unpacked file (the install checks it on the host). */
  sha256: string
  /** sha256 of `gz` (the upload checks it, and skips a gz already on the host). */
  gzSha256: string
}

export interface HostFileSource {
  /** The id this server's build installs under on a host, and the commit its file says: no build, no download. */
  buildId(): Promise<{ id: string; version: string; commit: string | null }>
  /** This server's build as the file for `target`: from the cache, else built or downloaded (`say` tells how it goes). */
  file(target: HostFileTarget, say?: (message: string) => void): Promise<HostFile>
}

/**
 * A dir that may hold walnut-<target> files of this build: `assetsId` is the
 * asset archive id they must carry (the running compiled file's own), or absent:
 * learned from the file in the dir that runs on this machine, checked by its `--version`.
 */
export interface SiblingDir { dir: string; assetsId?: string }

/** Where this server's build came from. `siblings`: where files of this very build may already be. */
export type BuildOrigin =
  /** `distDir`: its web/static goes into a clone build (--reuse-web). */
  | { kind: 'checkout'; checkout: string; distDir: string; info: BuildInfo; id: string; siblings?: SiblingDir[] }
  | { kind: 'release'; info: BuildInfo; id: string; what: string; siblings?: SiblingDir[] }
  | { kind: 'none'; why: string }

/** What a walnut file says when it runs here: its `--version` line and its asset archive id. */
export interface FileVersion { line: string; assetsId: string | null }

export interface HostFileSourceOptions {
  /** <data>/cache/host-server */
  cacheDir: string
  origin?: () => Promise<BuildOrigin>
  fetch?: typeof fetch
  /** Like install.sh's OPEN_WALNUT_RELEASE_BASE_URL: `<base>/v<version>/<asset>`; `file://<dir>` is a directory laid out the same way. */
  releaseBase?: string
  /** Builds the files in a clone (host-file-build.ts); returns each built file's path. */
  build?: (b: CloneBuild) => Promise<Partial<Record<HostFileTarget, string>>>
  /** A bun of `min` or newer to build with (host-file-build.ts findBun). */
  bun?: (min: string | null) => Promise<BunPick>
  /** package.json as of a commit (host-file-build.ts packageJsonAt). */
  packageJsonAt?: (checkout: string, commit: string) => Promise<string>
  /** What a walnut file built for `target` says when it runs on THIS machine, or null when it cannot run here. */
  versionHere?: (file: string, target: HostFileTarget) => Promise<FileVersion | null>
  /** Where clone builds run (default the temp dir: its volume is outside the on-access scanners). */
  workDir?: string
  /** Asks this close together are one build (default 1.5 s). */
  batchWindowMs?: number
}

const KEEP_BUILDS = 3
const LOG_KEEP_MS = 7 * 24 * 3_600_000
const SUMS_MS = 30_000
const DOWNLOAD_MS = 10 * 60_000
const MAX_FILE_BYTES = 400 * 1024 * 1024
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const WORK_PREFIX = 'walnut-host-file-'
export const SOURCE_ROOT_MARKER = '.walnut-source-root'
/** src/binary/runtime-tree.ts RUNTIME_MARKER: an unpacked runtime tree's file naming its asset archive id. */
const RUNTIME_MARKER = '.walnut-runtime'

export function defaultReleaseBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_WALNUT_RELEASE_BASE_URL?.trim().replace(/\/+$/, '') || `${WALNUT_REPO_URL.replace(/\.git$/, '')}/releases/download`
}

async function isCheckout(root: string): Promise<boolean> {
  const has = (rel: string) => fs.promises.access(path.join(root, rel)).then(() => true, () => false)
  const all = await Promise.all(['.git', 'scripts/build-binary.mjs', 'src/binary/main.ts', 'node_modules'].map(has))
  return all.every(Boolean)
}

/**
 * The checkout a package root was built from: itself, or the one its
 * `.walnut-source-root` names (scripts/dev-prod.sh writes it into the staged
 * copy production runs from, and into the rollback snapshot). Checked, never
 * trusted: a marker naming anything that is not a checkout counts for nothing.
 */
export async function sourceCheckoutOf(root: string): Promise<string | null> {
  if (await isCheckout(root)) return root
  const named = (await fs.promises.readFile(path.join(root, SOURCE_ROOT_MARKER), 'utf8').catch(() => '')).trim()
  if (named && path.isAbsolute(named) && await isCheckout(named)) return named
  return null
}

/**
 * Where the running process's build came from (`dist`, `compiled`, `execPath`: tests).
 * The compiled file first: its own runtime tree also looks like a dist.
 */
export async function runningOrigin(
  dist = runningDist(),
  compiled: { root: string } | null = singleFile(),
  execPath = process.execPath,
): Promise<BuildOrigin> {
  if (compiled) {
    const info = getBuildInfo()
    const id = buildIdOf(info)
    const bin = path.dirname(execPath)
    const assetsId = (await fs.promises.readFile(path.join(compiled.root, RUNTIME_MARKER), 'utf8').catch(() => '')).trim()
    const siblings = assetsId ? [{ dir: bin, assetsId }] : []
    // <checkout or stage>/dist-bin/walnut-<target>
    const root = path.basename(bin) === 'dist-bin' ? path.dirname(bin) : null
    const checkout = root ? await sourceCheckoutOf(root) : null
    if (checkout) return { kind: 'checkout', checkout, distDir: path.join(compiled.root, 'dist'), info, id, siblings }
    return { kind: 'release', info, id, what: 'this compiled walnut file', siblings }
  }
  if (dist) {
    const { id, info } = await readRunningBuild(dist)
    const checkout = await sourceCheckoutOf(dist.root)
    const siblings = [...new Set([dist.root, checkout].filter((r): r is string => !!r))].map((r) => ({ dir: path.join(r, 'dist-bin') }))
    if (checkout) return { kind: 'checkout', checkout, distDir: dist.distDir, info, id, siblings }
    return { kind: 'release', info, id, what: 'this install of Walnut', siblings }
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

/** Whether a `--version` line names this build: `<version> (<commit>, <date>)` or `<version> (<commit>)`. */
export function versionLineMatches(line: string, version: string, commit: string): boolean {
  return line.startsWith(`${version} (${commit}, `) || line === `${version} (${commit})`
}

/**
 * What a walnut file says when it can run on this machine (same system: a
 * macOS file on a Mac, a Linux file on Linux): its `--version` line and the
 * asset archive id of the runtime tree it unpacks, into a temp dir removed after.
 */
export async function versionHere(file: string, target: HostFileTarget): Promise<FileVersion | null> {
  const here = process.platform === 'darwin' ? 'darwin-' : process.platform === 'linux' ? 'linux-' : null
  if (!here || !target.startsWith(here)) return null
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-file-version-'))
  try {
    const runtime = path.join(tmp, 'runtime')
    const line = await new Promise<string | null>((resolve) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, OPEN_WALNUT_HOME: tmp, WALNUT_RUNTIME_DIR: runtime }
      const child = spawn(file, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (c: Buffer) => { out = (out + c.toString()).slice(0, 4000) })
      const timer = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
      child.once('error', () => { clearTimeout(timer); resolve(null) })
      child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? (out.split('\n')[0] ?? '').trim() : null) })
    })
    if (line === null) return null
    // WALNUT_RUNTIME_DIR is the tree itself, or (newer files) the dir that holds one tree per build.
    const trees = [runtime, ...(await fs.promises.readdir(runtime).catch(() => [] as string[])).map((n) => path.join(runtime, n))]
    let assetsId: string | null = null
    for (const t of trees) {
      assetsId = (await fs.promises.readFile(path.join(t, RUNTIME_MARKER), 'utf8').catch(() => '')).trim() || null
      if (assetsId) break
    }
    return { line, assetsId }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Whether `file` carries `needle` (read in chunks: a file of 150 MB never sits in memory). */
export async function fileContains(file: string, needle: string): Promise<boolean> {
  const want = Buffer.from(needle)
  let tail = Buffer.alloc(0)
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    const buf = Buffer.concat([tail, chunk as Buffer])
    if (buf.includes(want)) return true
    tail = buf.subarray(Math.max(0, buf.length - want.length + 1))
  }
  return false
}

/** The target of the files this machine runs (the one a dist-bin dir's own file is for). */
function ownTargets(): HostFileTarget[] {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!arch) return []
  if (process.platform === 'darwin') return [`darwin-${arch}`]
  if (process.platform === 'linux') return [`linux-${arch}`, `linux-${arch}-musl`]
  return []
}

interface Batch { targets: Set<HostFileTarget>; done: Promise<Map<HostFileTarget, HostFile>> }

export function createHostFileSource(opts: HostFileSourceOptions): HostFileSource {
  const origin = opts.origin ?? (() => runningOrigin())
  const build = opts.build ?? buildFileInClone
  const bun = opts.bun ?? ((min: string | null) => findBun(process.env, min))
  const readPackageJsonAt = opts.packageJsonAt ?? packageJsonAt
  const askVersion = opts.versionHere ?? versionHere
  const workDir = opts.workDir ?? os.tmpdir()
  const batchWindowMs = opts.batchWindowMs ?? 1_500
  const fetchImpl = opts.fetch ?? fetch
  const filesDir = path.join(opts.cacheDir, 'files')
  /** One ask per target at a time; every host waiting on it hears its messages. */
  const inflight = new Map<HostFileTarget, { promise: Promise<HostFile>; listeners: Set<(m: string) => void> }>()
  const tell = (target: HostFileTarget, message: string) => { for (const l of inflight.get(target)?.listeners ?? []) l(message) }
  let originOnce: Promise<BuildOrigin> | null = null
  // A deploy replaces the build this process runs only by restarting it.
  const getOrigin = (): Promise<BuildOrigin> => (originOnce ??= origin().catch((err) => { originOnce = null; throw err }))
  let swept: Promise<unknown> | null = null
  let open: Batch | null = null
  let previous: Promise<unknown> = Promise.resolve()

  const paths = (id: string, target: string) => {
    const dir = path.join(filesDir, id)
    return { dir, gz: path.join(dir, `walnut-${target}.gz`), meta: path.join(dir, `walnut-${target}.json`) }
  }

  async function cached(id: string, version: string, commit: string | null, target: HostFileTarget): Promise<HostFile | null> {
    const p = paths(id, target)
    try {
      const meta = JSON.parse(await fs.promises.readFile(p.meta, 'utf8')) as { sha256?: unknown; gzSha256?: unknown; gzBytes?: unknown }
      if (typeof meta.sha256 !== 'string' || typeof meta.gzSha256 !== 'string') return null
      if ((await fs.promises.stat(p.gz)).size !== meta.gzBytes || (await hashFile(p.gz)) !== meta.gzSha256) return null
      const gz = await fs.promises.readFile(p.gz)
      const now = new Date()
      await fs.promises.utimes(p.dir, now, now).catch(() => undefined)
      return { id, version, commit, target, gz, sha256: meta.sha256, gzSha256: meta.gzSha256 }
    } catch {
      return null
    }
  }

  /** Move a finished gz into the cache (meta last) and keep the newest few builds. */
  async function store(id: string, version: string, commit: string | null, target: HostFileTarget, gzTmp: string, fileSha: string): Promise<HostFile> {
    const p = paths(id, target)
    const gzSha = await hashFile(gzTmp)
    const gz = await fs.promises.readFile(gzTmp)
    await fs.promises.mkdir(p.dir, { recursive: true })
    // Written beside its place (the build's own dir may be on another file system), then renamed.
    const gzPart = `${p.gz}.${process.pid}.tmp`
    await fs.promises.writeFile(gzPart, gz)
    await fs.promises.rename(gzPart, p.gz)
    const metaTmp = `${p.meta}.${process.pid}.tmp`
    await fs.promises.writeFile(metaTmp, JSON.stringify({ version, commit, sha256: fileSha, gzSha256: gzSha, gzBytes: gz.length }))
    await fs.promises.rename(metaTmp, p.meta)
    await prune(id)
    return { id, version, commit, target, gz, sha256: fileSha, gzSha256: gzSha }
  }

  /** A plain file gzipped into the cache. */
  async function storeFile(id: string, info: BuildInfo, target: HostFileTarget, file: string, work: string): Promise<HostFile> {
    const fileHash = crypto.createHash('sha256')
    const gzTmp = path.join(work, `walnut-${target}.gz`)
    await pipeline(fs.createReadStream(file), hasher(fileHash, MAX_FILE_BYTES, `the walnut file for ${target}`), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzTmp))
    return store(id, info.version, info.commit, target, gzTmp, fileHash.digest('hex'))
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

  /** A build in a checkout must be of a commit, so that the host runs exactly what this server runs. */
  function checkCommitted(o: Extract<BuildOrigin, { kind: 'checkout' }>, target?: HostFileTarget): string {
    if (!o.info.commit) throw new Error(`This server's build (${formatBuildVersion(o.info)}) names no commit, so the walnut file${target ? ` for ${target}` : ''} cannot be built from its checkout.`)
    if (o.info.dirty) {
      throw new Error(`This server was built from a tree with uncommitted changes (${formatBuildVersion(o.info)}). A host gets only a build of a commit, so that it runs exactly what this server runs: deploy a commit (scripts/deploy-committed.sh), then press Retry.`)
    }
    return o.info.commit
  }

  /** Per sibling dir: the asset archive id its files must carry (or null: none of this build), learned once. */
  const dirIds = new Map<string, Promise<string | null>>()

  /** The id a dir's files of this build carry: given, or its own-system file's when that says this build. */
  function idOfDir(o: Exclude<BuildOrigin, { kind: 'none' }>, sib: SiblingDir, commit: string): Promise<string | null> {
    if (sib.assetsId) return Promise.resolve(sib.assetsId)
    let p = dirIds.get(sib.dir)
    if (!p) {
      p = (async () => {
        for (const t of ownTargets()) {
          const file = path.join(sib.dir, `walnut-${t}`)
          if (!(await fs.promises.stat(file).then((st) => st.isFile(), () => false))) continue
          const said = await askVersion(file, t).catch(() => null)
          if (said && said.assetsId && versionLineMatches(said.line, o.info.version, commit)) return said.assetsId
        }
        return null
      })()
      dirIds.set(sib.dir, p)
    }
    return p
  }

  /** A walnut-<target> file beside the running build, made by the same build-binary run as this build. */
  async function sibling(o: Exclude<BuildOrigin, { kind: 'none' }>, commit: string, target: HostFileTarget): Promise<HostFile | null> {
    for (const sib of o.siblings ?? []) {
      const file = path.join(sib.dir, `walnut-${target}`)
      if (!(await fs.promises.stat(file).then((st) => st.isFile(), () => false))) continue
      const assetsId = await idOfDir(o, sib, commit)
      if (!assetsId || !(await fileContains(file, JSON.stringify(assetsId)).catch(() => false))) continue
      tell(target, `Using the walnut file for ${target} built with this server.`)
      await fs.promises.mkdir(opts.cacheDir, { recursive: true })
      const work = await fs.promises.mkdtemp(path.join(opts.cacheDir, 'download-'))
      try {
        return await storeFile(o.id, o.info, target, file, work)
      } finally {
        await fs.promises.rm(work, { recursive: true, force: true })
      }
    }
    return null
  }

  /** One clone build for every target in the batch. */
  async function buildBatch(o: Extract<BuildOrigin, { kind: 'checkout' }>, commit: string, targets: HostFileTarget[]): Promise<Map<HostFileTarget, HostFile>> {
    const sayAll = (m: string) => { for (const t of targets) tell(t, m) }
    const min = pinnedBun(await readPackageJsonAt(o.checkout, commit).catch(() => ''))
    const pick = await bun(min)
    if ('why' in pick) throw new Error(pick.why)
    sayAll(`Building Walnut ${o.id} for ${targets.join(', ')} on this computer (about a minute, once per build).`)
    await fs.promises.mkdir(opts.cacheDir, { recursive: true })
    const work = await fs.promises.mkdtemp(path.join(workDir, WORK_PREFIX))
    try {
      // Who made it, so a server that starts after this one stopped mid-build removes it.
      await fs.promises.writeFile(path.join(work, WORK_OWNER), JSON.stringify({ pid: process.pid, at: Date.now() }))
      const built = await build({
        checkout: o.checkout, distDir: o.distDir, commit, targets, work,
        log: path.join(opts.cacheDir, `build-${o.id}.log`), bun: pick.path,
      })
      const out = new Map<HostFileTarget, HostFile>()
      for (const t of targets) {
        const file = built[t]
        if (!file) throw new Error(`the build made no walnut file for ${t}`)
        out.set(t, await storeFile(o.id, o.info, t, file, work))
      }
      return out
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true })
    }
  }

  /** Join the build that collects now; it starts after the window and after the one before it. */
  function fromCheckout(o: Extract<BuildOrigin, { kind: 'checkout' }>, commit: string, target: HostFileTarget): Promise<HostFile> {
    let b = open
    if (!b) {
      const batch: Batch = { targets: new Set(), done: null as unknown as Batch['done'] }
      const before = previous
      batch.done = (async () => {
        await new Promise((r) => setTimeout(r, batchWindowMs))
        await before.catch(() => undefined)
        if (open === batch) open = null
        // Sorted: callers join the batch in whatever order their own awaits finish.
        return buildBatch(o, commit, [...batch.targets].sort())
      })()
      previous = batch.done
      open = batch
      b = batch
    }
    b.targets.add(target)
    return b.done.then((files) => {
      const f = files.get(target)
      if (!f) throw new Error(`the build made no walnut file for ${target}`)
      return f
    })
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

  async function fromRelease(o: Extract<BuildOrigin, { kind: 'release' }>, target: HostFileTarget): Promise<HostFile> {
    const { version, commit } = o.info
    const noCheckout = `${o.what} has no checkout to build the walnut file for ${target} from`
    if (o.info.dirty) {
      throw new Error(`This Walnut (${formatBuildVersion(o.info)}) was built from a tree with uncommitted changes, and ${noCheckout}. Install a released Walnut, or run Walnut from a checkout.`)
    }
    if (!RELEASE_VERSION.test(version)) throw new Error(`This Walnut's version (${version}) is not a release version, and ${noCheckout}.`)
    // The host checks the file names this commit: without one, nothing could tell a release of another commit.
    if (!commit) throw new Error(`This Walnut's build (${formatBuildVersion(o.info)}) names no commit, and ${noCheckout}.`)
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
    tell(target, `Downloading Walnut ${version} for ${target} (${asset}).`)
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
      const plain = path.join(work, `walnut-${target}`)
      await pipeline(fs.createReadStream(gzTmp), zlib.createGunzip(), hasher(fileHash, MAX_FILE_BYTES, 'the walnut file'), fs.createWriteStream(plain))
      const fileSha = fileHash.digest('hex')
      if (sums.file && sums.file !== fileSha) throw new Error(`${asset} does not unpack to the file its SHA256SUMS names.`)
      // A release of the same version from another commit is not this server's build. Seen here
      // when the file runs on this machine; the host's install checks it either way.
      await fs.promises.chmod(plain, 0o755)
      const said = await askVersion(plain, target).catch(() => null)
      if (said && !versionLineMatches(said.line, version, commit)) {
        throw new Error(`Release ${version} was built from another commit than this Walnut (its file says "${said.line}", this is ${formatBuildVersion(o.info)}), and ${noCheckout}.`)
      }
      return await store(o.id, version, commit, target, gzTmp, fileSha)
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true })
    }
  }

  async function resolve(target: HostFileTarget): Promise<HostFile> {
    // Build dirs a server left when it stopped mid-build (each a clone plus its files).
    await (swept ??= pruneAbandonedWork(workDir, WORK_PREFIX).catch(() => undefined))
    const o = await getOrigin()
    if (o.kind === 'none') throw new Error(o.why)
    if (o.kind === 'release') {
      const hit = await cached(o.id, o.info.version, o.info.commit, target)
      if (hit) return hit
      // The file beside it: only a build of a commit, not one of uncommitted changes.
      const near = o.info.commit && !o.info.dirty ? await sibling(o, o.info.commit, target) : null
      return near ?? fromRelease(o, target)
    }
    const commit = checkCommitted(o, target)
    return (await cached(o.id, o.info.version, commit, target)) ?? (await sibling(o, commit, target)) ?? fromCheckout(o, commit, target)
  }

  return {
    async buildId() {
      const o = await getOrigin()
      if (o.kind === 'none') throw new Error(o.why)
      if (o.kind === 'checkout') checkCommitted(o)
      return { id: o.id, version: o.info.version, commit: o.info.commit }
    },
    file(target, say) {
      const current = inflight.get(target)
      if (current) {
        if (say) current.listeners.add(say)
        return current.promise
      }
      const entry = { listeners: new Set<(m: string) => void>(say ? [say] : []), promise: null as unknown as Promise<HostFile> }
      inflight.set(target, entry)
      entry.promise = resolve(target).finally(() => { if (inflight.get(target) === entry) inflight.delete(target) })
      return entry.promise
    },
  }
}
