#!/usr/bin/env node
/**
 * Put a release's archive inside Walnut.app, so its first launch installs it
 * with no network (desktop/BundledRuntime.swift, `carriedRelease`):
 *
 *   Walnut.app/Contents/Resources/release/v<version>/SHA256SUMS
 *   Walnut.app/Contents/Resources/release/v<version>/open-walnut-<version>-darwin-<arch>.tar.gz
 *
 * the layout of the releases themselves, so install.sh takes it as a file://
 * base and checks it against those checksums, as it checks a download. A
 * Developer ID build signs every binary inside the archive first, because
 * notarization looks inside it, and so carries checksums of its own for it.
 * desktop/build-release.sh runs this once it has its signing identity, then
 * signs the app (one app, and one DMG, per architecture); the CI rehearsal runs
 * it on a copy of the dev app with the archive it just built
 * (scripts/desktop-smoke.mjs).
 *
 *   node scripts/desktop-carry-release.mjs --app Walnut.app --archive open-walnut-0.7.0-darwin-arm64.tar.gz --sums SHA256SUMS [--sign "Developer ID Application: …" [--keychain k]]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHIVE = /^open-walnut-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-darwin-(arm64|x64)\.tar\.gz$/

/** The version and architecture an archive's name gives, or null. */
export function archiveTarget(file) {
  const m = ARCHIVE.exec(path.basename(file))
  return m ? { version: m[1], arch: m[2] } : null
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

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

/** Every regular Mach-O file under `dir` (symlinks are not followed). */
export function machOFiles(dir) {
  const out = []
  const head = Buffer.alloc(8)
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const fd = fs.openSync(p, 'r')
        try {
          if (fs.readSync(fd, head, 0, 8, 0) === 8 && isMachOHeader(head)) out.push(p)
        } finally {
          fs.closeSync(fd)
        }
      }
    }
  }
  walk(dir)
  return out
}

/**
 * Whether `codesign -dvv` describes a signature notarization takes as it is: a
 * Developer ID, the hardened runtime and a secure timestamp. Node's own binary
 * is signed so by its project, with the entitlements it needs (JIT, and loading
 * add-ons signed by anyone): signing it again would drop them.
 */
export function notarizable(details) {
  return /^Authority=Developer ID Application: /m.test(details) && /^Timestamp=/m.test(details) && /flags=0x[0-9a-f]*\([^)]*runtime[^)]*\)/.test(details)
}

/**
 * Sign every Mach-O inside the archive that is not signed for notarization
 * already, with `identity`, the hardened runtime and a secure timestamp, and
 * pack it again as `out`. Apple's notary service opens the archives inside an
 * app and refuses it for any binary in them it cannot accept (2026-10-11: 27
 * native add-ons and tools in node_modules: ripgrep, esbuild, sharp, onnxruntime,
 * better-sqlite3, node-pty). Returns the files it signed, relative to the archive.
 */
export function signArchive({ archive, out, identity, keychain, codesign = runCodesign }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-carry-sign-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' })
    const top = path.basename(archive).replace(/\.tar\.gz$/, '')
    if (!fs.existsSync(path.join(work, top))) throw new Error(`${path.basename(archive)} holds no ${top}/`)
    const signed = []
    for (const file of machOFiles(path.join(work, top))) {
      if (notarizable(codesign(['-dvv', file], { probe: true }))) continue
      codesign(['--force', '--options', 'runtime', '--timestamp', ...(keychain ? ['--keychain', keychain] : []), '--sign', identity, file])
      signed.push(path.relative(work, file))
    }
    execFileSync('tar', ['-czf', out, '-C', work, top], { stdio: 'inherit' })
    return signed
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** codesign; with `probe`, its description of a file (printed on stderr), or why it has none. */
function runCodesign(args, { probe = false } = {}) {
  if (!probe) {
    execFileSync('codesign', args, { stdio: 'inherit' })
    return ''
  }
  const r = spawnSync('codesign', args, { encoding: 'utf8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/**
 * Copy `archive` and the release's `sums` into `app`. Refuses an archive that
 * is not a Mac one, or that its checksums do not name with its own sha256: a
 * build must not ship an app whose first launch is bound to fail. With
 * `identity` (a Developer ID build) the app carries the archive with its
 * binaries signed (signArchive) and checksums of its own for it, both sealed by
 * the app's signature. Returns where it put them.
 */
export function carryRelease({ app, archive, sums, identity, keychain, codesign }) {
  const target = archiveTarget(archive)
  if (!target) throw new Error(`${path.basename(archive)} is not a Mac archive (open-walnut-<version>-darwin-<arm64|x64>.tar.gz)`)
  const resources = path.join(app, 'Contents', 'Resources')
  if (!fs.existsSync(resources)) throw new Error(`${app} has no Contents/Resources`)
  const name = path.basename(archive)
  const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.trim().split(/\s+\*?/)[1] === name)
  if (!line) throw new Error(`${path.basename(sums)} names no ${name}`)
  if (line.trim().split(/\s+/)[0] !== sha256(archive)) throw new Error(`${name} does not match its ${path.basename(sums)} entry`)
  const root = path.join(resources, 'release')
  // One carried release per app: a rebuild never leaves an older one beside it.
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, `v${target.version}`)
  fs.mkdirSync(dir, { recursive: true })
  if (!identity) {
    fs.copyFileSync(archive, path.join(dir, name))
    fs.copyFileSync(sums, path.join(dir, 'SHA256SUMS'))
    return { ...target, dir, signed: [] }
  }
  const signed = signArchive({ archive, out: path.join(dir, name), identity, keychain, codesign })
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256(path.join(dir, name))}  ${name}\n`)
  return { ...target, dir, signed }
}

function main(argv) {
  const opts = { app: null, archive: null, sums: null, identity: null, keychain: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') opts.app = path.resolve(argv[++i])
    else if (a === '--archive') opts.archive = path.resolve(argv[++i])
    else if (a === '--sums') opts.sums = path.resolve(argv[++i])
    else if (a === '--sign') opts.identity = argv[++i]
    else if (a === '--keychain') opts.keychain = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  if (!opts.app || !opts.archive || !opts.sums) throw new Error('usage: desktop-carry-release.mjs --app <Walnut.app> --archive <open-walnut-…-darwin-<arch>.tar.gz> --sums <SHA256SUMS> [--sign <Developer ID identity> [--keychain <path>]]')
  const out = carryRelease(opts)
  if (opts.identity) process.stderr.write(`Signed ${out.signed.length} binaries inside it:\n${out.signed.map((f) => `  ${f}\n`).join('')}`)
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
