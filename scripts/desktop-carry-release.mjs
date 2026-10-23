#!/usr/bin/env bun
/**
 * Put a release's compiled Walnut for one Mac architecture inside Walnut.app,
 * so its first launch installs it with no network (desktop/BundledRuntime.swift,
 * `carriedRelease`):
 *
 *   Walnut.app/Contents/Resources/release/v<version>/SHA256SUMS
 *   Walnut.app/Contents/Resources/release/v<version>/walnut-<version>-darwin-<arch>
 *
 * the layout of the releases themselves (scripts/release-files.mjs), so the
 * install.sh the app carries takes it as a file:// base and checks it against
 * those checksums, as it checks a download. The app carries the plain file, not
 * the release's .gz: a Developer ID build signs it first (the hardened runtime
 * and the entitlements its JavaScript engine needs, desktop/walnut-file.entitlements),
 * because notarization looks at every binary in the app, and so carries a
 * checksum of its own for it. desktop/build-release.sh runs this once it has its
 * signing identity, then signs the app (one app, and one DMG, per architecture).
 *
 *   bun scripts/desktop-carry-release.mjs --app Walnut.app --file walnut-0.7.0-darwin-arm64.gz --sums SHA256SUMS \
 *     [--sign "Developer ID Application: ..." [--keychain k] --entitlements desktop/walnut-file.entitlements]
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const FILE = /^walnut-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-darwin-(arm64|x64)(\.gz)?$/

/** The version and architecture a release file's name gives (plain or .gz), or null. */
export function fileTarget(file) {
  const m = FILE.exec(path.basename(file))
  return m ? { version: m[1], arch: m[2], gz: Boolean(m[3]) } : null
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/**
 * Whether these first bytes start a Mach-O file (thin or fat). A fat header
 * shares 0xcafebabe with a Java class file; there the next word is the class
 * version (45 and up), here the number of architectures.
 */
export function isMachOHeader(buf) {
  if (buf.length < 8) return false
  const magic = buf.readUInt32BE(0)
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true
  if (magic === 0xcafebabe || magic === 0xcafebabf) return buf.readUInt32BE(4) > 0 && buf.readUInt32BE(4) < 30
  return false
}

/** The architecture of a thin 64-bit Mach-O (`arm64`, `x64`), or null. */
export function machOArch(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0xfeedfacf) return null
  const cpu = buf.readUInt32LE(4)
  return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : null
}

/** The sha256 SHA256SUMS gives `name`, or null. */
function listed(sums, name) {
  const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.trim().split(/\s+\*?/)[1] === name)
  return line ? line.trim().split(/\s+/)[0] : null
}

/**
 * Copy the release's file for one Mac into `app`. Refuses a file that is not a
 * Mac one, that its checksums do not name with its own sha256, or that is not a
 * Mach-O for the architecture its name gives: a build must not ship an app
 * whose first launch is bound to fail. With `identity` (a Developer ID build)
 * the carried file is signed with it, and the app carries a checksum of its own
 * for it, both sealed by the app's signature. Returns where it put it.
 */
export function carryRelease({ app, file, sums, identity, keychain, entitlements, codesign = (args) => execFileSync('codesign', args, { stdio: 'inherit' }) }) {
  const target = fileTarget(file)
  if (!target) throw new Error(`${path.basename(file)} is not a Mac build (walnut-<version>-darwin-<arm64|x64>, or its .gz)`)
  const resources = path.join(app, 'Contents', 'Resources')
  if (!fs.existsSync(resources)) throw new Error(`${app} has no Contents/Resources`)
  const name = path.basename(file)
  const given = fs.readFileSync(file)
  const sha = listed(sums, name)
  if (!sha) throw new Error(`${path.basename(sums)} names no ${name}`)
  if (sha !== sha256(given)) throw new Error(`${name} does not match its ${path.basename(sums)} entry`)
  const plainName = `walnut-${target.version}-darwin-${target.arch}`
  const plain = target.gz ? zlib.gunzipSync(given) : given
  // The release lists the file inside each .gz too: the two must agree.
  const plainSha = listed(sums, plainName)
  if (target.gz && plainSha && plainSha !== sha256(plain)) throw new Error(`the file inside ${name} does not match the ${plainName} entry of ${path.basename(sums)}`)
  const arch = machOArch(plain)
  if (arch !== target.arch) throw new Error(`${name} holds ${arch ? `an ${arch} Mach-O` : 'no 64-bit Mach-O'}, not the ${target.arch} build its name gives`)
  if (identity && !entitlements) throw new Error('a signed build needs --entitlements (desktop/walnut-file.entitlements): the hardened runtime stops a JavaScript engine without them')
  const root = path.join(resources, 'release')
  // One carried release per app: a rebuild never leaves an older one beside it.
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, `v${target.version}`)
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, plainName)
  fs.writeFileSync(out, plain, { mode: 0o755 })
  if (identity) {
    codesign(['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, ...(keychain ? ['--keychain', keychain] : []), '--sign', identity, out])
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256(fs.readFileSync(out))}  ${plainName}\n`)
  return { version: target.version, arch: target.arch, dir, file: out, signed: Boolean(identity) }
}

function main(argv) {
  const opts = { app: null, file: null, sums: null, identity: null, keychain: null, entitlements: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') opts.app = path.resolve(argv[++i])
    else if (a === '--file') opts.file = path.resolve(argv[++i])
    else if (a === '--sums') opts.sums = path.resolve(argv[++i])
    else if (a === '--sign') opts.identity = argv[++i]
    else if (a === '--keychain') opts.keychain = argv[++i]
    else if (a === '--entitlements') opts.entitlements = path.resolve(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!opts.app || !opts.file || !opts.sums) throw new Error('usage: desktop-carry-release.mjs --app <Walnut.app> --file <walnut-...-darwin-<arch>[.gz]> --sums <SHA256SUMS> [--sign <Developer ID identity> [--keychain <path>] --entitlements <plist>]')
  const out = carryRelease(opts)
  if (out.signed) process.stderr.write(`Signed ${path.basename(out.file)} with ${opts.identity}\n`)
  process.stdout.write(`${out.arch} ${out.version}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`desktop-carry-release: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
