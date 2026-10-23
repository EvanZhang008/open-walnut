#!/usr/bin/env node
/**
 * The compiled Walnut files a release ships, one per target, as GitHub Release
 * assets: what install.sh, the Homebrew formula and the Mac app install.
 *
 *   node scripts/release-files.mjs assets --files dist-bin --version 0.7.0 --out <dir>
 *   node scripts/release-files.mjs stamp 0.7.0          (package.json's version, before a build)
 *
 * `assets` reads dist-bin/walnut-<target> (scripts/build-binary.mjs) for every
 * target and writes, into <dir>:
 *
 *   walnut-<version>-<target>.gz    the file, gzip -9 (what install.sh downloads)
 *   SHA256SUMS                      sha256 of every .gz AND of the plain file
 *                                   inside it (`walnut-<version>-<target>`): a
 *                                   release carried on a disk (the Mac app) may
 *                                   hold the plain file, checked by its own line
 *
 * Every target must be there: a release with a platform missing would send that
 * platform's install.sh to an older release without saying why.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { setManifestVersion } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every target a release ships, in the words of install.sh, npm and Homebrew.
 * `libc` only on Linux: npm installs the package whose libc matches.
 */
export const TARGETS = [
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { target: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { target: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl' },
  { target: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl' },
]

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** dist-bin/walnut-<target> (build-binary.mjs's name for each file). */
export const builtName = (target) => `walnut-${target}`
/** The plain file's name in a release, and its gzip asset. */
export const fileName = (version, target) => `walnut-${version}-${target}`
export const assetName = (version, target) => `${fileName(version, target)}.gz`

export function assertVersion(version) {
  if (!VERSION.test(version ?? '')) throw new Error(`${version} is not a version`)
  return version
}

const sha256File = async (file) => {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/** Write every target's .gz and the SHA256SUMS naming both forms. Returns the lines written. */
export async function writeAssets({ files, version, out }) {
  assertVersion(version)
  const missing = TARGETS.filter(({ target }) => !fs.existsSync(path.join(files, builtName(target))))
  if (missing.length) throw new Error(`${files} has no ${missing.map(({ target }) => builtName(target)).join(', ')}`)
  fs.mkdirSync(out, { recursive: true })
  const lines = []
  for (const { target } of TARGETS) {
    const src = path.join(files, builtName(target))
    const gz = path.join(out, assetName(version, target))
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz))
    lines.push(`${await sha256File(gz)}  ${assetName(version, target)}`)
    lines.push(`${await sha256File(src)}  ${fileName(version, target)}`)
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return lines
}

/** `{ target: { gz, file } }` sha256s of one version's files in a SHA256SUMS text. */
export function filesIn(sums, version) {
  const out = {}
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]?walnut-(.+)-((?:darwin|linux)-(?:arm64|x64)(?:-musl)?)(\.gz)?$/.exec(line.trim())
    if (!m || m[2] !== version) continue
    out[m[3]] ??= {}
    out[m[3]][m[4] ? 'gz' : 'file'] = m[1]
  }
  return out
}

export function stamp(version) {
  assertVersion(version)
  for (const f of ['package.json', 'package-lock.json']) {
    const p = path.join(root, f)
    if (fs.existsSync(p)) fs.writeFileSync(p, setManifestVersion(fs.readFileSync(p, 'utf8'), version))
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'stamp') return stamp(rest[0])
  if (cmd !== 'assets') throw new Error('usage: release-files.mjs assets --files <dist-bin> --version <x.y.z> --out <dir> | stamp <x.y.z>')
  const opts = { files: null, version: null, out: null }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--files') opts.files = path.resolve(rest[++i])
    else if (rest[i] === '--version') opts.version = rest[++i]
    else if (rest[i] === '--out') opts.out = path.resolve(rest[++i])
    else throw new Error(`unknown argument ${rest[i]}`)
  }
  if (!opts.files || !opts.version || !opts.out) throw new Error('assets needs --files, --version and --out')
  for (const line of await writeAssets(opts)) process.stdout.write(`${line}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`release-files: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
