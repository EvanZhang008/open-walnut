/**
 * The download half of host-file.ts: a published build's walnut file for a
 * host's target, from one of the two places a version is published.
 *
 *   the GitHub release: <base>/v<version>/walnut-<version>-<target>.gz, checked
 *     against the release's SHA256SUMS (scripts/release-files.mjs). Stable
 *     releases have one;
 *   npm: the platform package @open-walnut/<target>@<version>, whose tarball
 *     holds the file as package/walnut (scripts/npm-packages.mjs), checked
 *     against the registry's sha512 integrity. Every version is published
 *     there, nightlies only there (they have no tag and no GitHub release).
 *
 * Each source answers with the file, or `absent` (a sentence saying what is not
 * there) so that the caller tries the other one; any other failure (a network
 * error, a download that does not match its checksum) is thrown. Everything
 * streams: a 60 MB file is never held, hashed or unpacked in one piece.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { WALNUT_REPO_URL } from '../../constants.js'
import { extractTarGz } from '../../lib/tar.js'
import type { HostFileTarget } from './host-target.js'

/** Most bytes of a walnut file, or of the archive it comes in. */
export const MAX_FILE_BYTES = 400 * 1024 * 1024
/** A checksum list or a registry document. */
const META_MS = 30_000
const MAX_META_BYTES = 4 * 1024 * 1024
const DOWNLOAD_MS = 10 * 60_000
const NPM_SCOPE = '@open-walnut'

/** Where a download went: the plain file (its sha256), and the release's gz when it came as one. */
export interface Downloaded { file: string; sha256: string; gz: string | null; from: string }
export type Fetched = Downloaded | { absent: string }

export interface DownloadContext {
  fetch: typeof fetch
  /** An empty dir of the caller's, removed by it. */
  work: string
  say: (message: string) => void
}

export function defaultReleaseBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_WALNUT_RELEASE_BASE_URL?.trim().replace(/\/+$/, '') || `${WALNUT_REPO_URL.replace(/\.git$/, '')}/releases/download`
}

/** The registry the platform packages are read from (OPEN_WALNUT_NPM_REGISTRY: a mirror). */
export function defaultNpmRegistry(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_WALNUT_NPM_REGISTRY?.trim().replace(/\/+$/, '') || 'https://registry.npmjs.org'
}

export const npmPackageOf = (target: HostFileTarget): string => `${NPM_SCOPE}/${target}`

/** Hashes what passes through, and stops past `limit` bytes. */
export function hasher(hash: crypto.Hash, limit: number, what: string): Transform {
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

/** sha256 of a file, read in chunks (a file of 60 MB hashed at once would hold the event loop). */
export async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hasher(hash, MAX_FILE_BYTES, file), new Writable({ write(_c, _e, cb) { cb() } }))
  return hash.digest('hex')
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

/** The sha512 digests of a Subresource Integrity string (`sha512-<base64>`, maybe among others). */
export function sha512sOf(integrity: unknown): Buffer[] {
  if (typeof integrity !== 'string') return []
  return integrity.trim().split(/\s+/)
    .map((part) => /^sha512-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(part)?.[1])
    .filter((b): b is string => !!b)
    .map((b) => Buffer.from(b, 'base64'))
    .filter((d) => d.length === 64)
}

/** A body to read, or null for a 404 (`file://` reads a dir laid out like the URL: tests, mirrors). */
async function body(ctx: DownloadContext, url: string, timeoutMs: number): Promise<Readable | null> {
  if (url.startsWith('file://')) {
    const file = decodeURI(url.slice('file://'.length))
    return (await fs.promises.access(file).then(() => true, () => false)) ? fs.createReadStream(file) : null
  }
  const res = await ctx.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (res.status === 404) return null
  if (!res.ok || !res.body) throw new Error(`${url} answered HTTP ${res.status}`)
  return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
}

async function readSmall(stream: Readable, what: string): Promise<string> {
  const parts: Buffer[] = []
  let n = 0
  for await (const c of stream) {
    n += (c as Buffer).length
    if (n > MAX_META_BYTES) { stream.destroy(); throw new Error(`${what} is larger than ${MAX_META_BYTES / 2 ** 20} MB`) }
    parts.push(c as Buffer)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** The release asset, checked against SHA256SUMS. */
export async function fromGithubRelease(ctx: DownloadContext, base: string, version: string, target: HostFileTarget): Promise<Fetched> {
  const root = `${base.replace(/\/+$/, '')}/v${version}`
  const sumsUrl = `${root}/SHA256SUMS`
  const asset = `walnut-${version}-${target}.gz`
  let text: string
  try {
    const stream = await body(ctx, sumsUrl, META_MS)
    if (!stream) return { absent: `there is no GitHub release of it (${sumsUrl} is not there)` }
    text = await readSmall(stream, sumsUrl)
  } catch (err) {
    throw new Error(`Could not read the release's checksums (${sumsUrl}: ${(err as Error).message}); this computer downloads the walnut file for the host once.`)
  }
  const sums = sumsFor(text, version, target)
  if (!sums.gz) return { absent: `its GitHub release has no ${asset} (not in its SHA256SUMS)` }
  ctx.say(`Downloading Walnut ${version} for ${target} (${asset}).`)
  const gzTmp = path.join(ctx.work, asset)
  const gzHash = crypto.createHash('sha256')
  const stream = await body(ctx, `${root}/${asset}`, DOWNLOAD_MS)
  if (!stream) return { absent: `its GitHub release lists ${asset} but does not have it` }
  await pipeline(stream, hasher(gzHash, MAX_FILE_BYTES, asset), fs.createWriteStream(gzTmp))
  if (gzHash.digest('hex') !== sums.gz) throw new Error(`${asset} does not match its SHA256SUMS entry (a broken or tampered download).`)
  // The file inside, hashed for the host's own check (and against the release's line for it).
  const fileHash = crypto.createHash('sha256')
  const plain = path.join(ctx.work, `walnut-${target}`)
  await pipeline(fs.createReadStream(gzTmp), zlib.createGunzip(), hasher(fileHash, MAX_FILE_BYTES, 'the walnut file'), fs.createWriteStream(plain))
  const sha256 = fileHash.digest('hex')
  if (sums.file && sums.file !== sha256) throw new Error(`${asset} does not unpack to the file its SHA256SUMS names.`)
  return { file: plain, sha256, gz: gzTmp, from: asset }
}

/**
 * The platform package from npm: its version document (`dist.tarball`,
 * `dist.integrity`, `gitHead`), the tarball checked by its sha512 as it
 * streams in, and `package/walnut` unpacked from it. `commit`: the short
 * commit this server's build names; a package whose gitHead is another commit
 * is refused before its tarball is fetched.
 */
export async function fromNpm(ctx: DownloadContext, registry: string, version: string, commit: string, target: HostFileTarget): Promise<Fetched> {
  const name = npmPackageOf(target)
  const spec = `${name}@${version}`
  // `@scope%2fname`: the form npm itself asks for, which every registry answers.
  const docUrl = `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`
  let doc: { name?: unknown; version?: unknown; gitHead?: unknown; dist?: { tarball?: unknown; integrity?: unknown } }
  try {
    const stream = await body(ctx, docUrl, META_MS)
    if (!stream) return { absent: `npm has no ${spec} (${docUrl} is not there)` }
    doc = JSON.parse(await readSmall(stream, docUrl)) as typeof doc
  } catch (err) {
    throw new Error(`Could not read ${spec} from npm (${docUrl}: ${(err as Error).message}); this computer downloads the walnut file for the host once.`)
  }
  if (doc.name !== name || doc.version !== version) throw new Error(`npm answered ${docUrl} with another package (${String(doc.name)}@${String(doc.version)}).`)
  const tarball = doc.dist?.tarball
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) throw new Error(`npm's ${spec} names no tarball to download.`)
  const want = sha512sOf(doc.dist?.integrity)
  if (want.length === 0) throw new Error(`npm's ${spec} carries no sha512 integrity, so its download cannot be checked.`)
  if (typeof doc.gitHead === 'string' && /^[0-9a-f]{40}$/.test(doc.gitHead) && !doc.gitHead.startsWith(commit)) {
    throw new Error(`npm's ${spec} was built from commit ${doc.gitHead.slice(0, 12)}, not from this Walnut's ${commit}.`)
  }
  ctx.say(`Downloading Walnut ${version} for ${target} from npm (${spec}).`)
  const tgz = path.join(ctx.work, `${target}.tgz`)
  const hash = crypto.createHash('sha512')
  const stream = await body(ctx, tarball, DOWNLOAD_MS)
  if (!stream) throw new Error(`npm's ${spec} names a tarball that is not there (${tarball}).`)
  await pipeline(stream, hasher(hash, MAX_FILE_BYTES, `the tarball of ${spec}`), fs.createWriteStream(tgz))
  const got = hash.digest()
  if (!want.some((d) => d.equals(got))) throw new Error(`The download of ${spec} does not match its integrity on npm (a broken or tampered download).`)
  const out = path.join(ctx.work, 'npm')
  await extractTarGz(tgz, out, { maxBytes: MAX_FILE_BYTES, maxEntries: 100 })
  const plain = path.join(out, 'package', 'walnut')
  if (!(await fs.promises.lstat(plain).then((st) => st.isFile(), () => false))) throw new Error(`npm's ${spec} holds no walnut file (package/walnut).`)
  await fs.promises.chmod(plain, 0o755)
  return { file: plain, sha256: await hashFile(plain), gz: null, from: spec }
}
