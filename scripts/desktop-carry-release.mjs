#!/usr/bin/env node
/**
 * Put a release's archive inside Walnut.app, so its first launch installs it
 * with no network (desktop/BundledRuntime.swift, `carriedRelease`):
 *
 *   Walnut.app/Contents/Resources/release/v<version>/SHA256SUMS
 *   Walnut.app/Contents/Resources/release/v<version>/open-walnut-<version>-darwin-<arch>.tar.gz
 *
 * the layout of the releases themselves, so install.sh takes it as a file://
 * base and checks it against the release's own checksums, as it checks a
 * download. desktop/build-release.sh runs this before it signs the app (one
 * app, and one DMG, per architecture); the CI rehearsal runs it on a copy of
 * the dev app with the archive it just built (scripts/desktop-smoke.mjs).
 *
 *   node scripts/desktop-carry-release.mjs --app Walnut.app --archive open-walnut-0.7.0-darwin-arm64.tar.gz --sums SHA256SUMS
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHIVE = /^open-walnut-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-darwin-(arm64|x64)\.tar\.gz$/

/** The version and architecture an archive's name gives, or null. */
export function archiveTarget(file) {
  const m = ARCHIVE.exec(path.basename(file))
  return m ? { version: m[1], arch: m[2] } : null
}

/**
 * Copy `archive` and the release's `sums` into `app`. Refuses an archive that
 * is not a Mac one, or that its checksums do not name with its own sha256: a
 * build must not ship an app whose first launch is bound to fail. Returns
 * where it put them.
 */
export function carryRelease({ app, archive, sums }) {
  const target = archiveTarget(archive)
  if (!target) throw new Error(`${path.basename(archive)} is not a Mac archive (open-walnut-<version>-darwin-<arm64|x64>.tar.gz)`)
  const resources = path.join(app, 'Contents', 'Resources')
  if (!fs.existsSync(resources)) throw new Error(`${app} has no Contents/Resources`)
  const name = path.basename(archive)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.trim().split(/\s+\*?/)[1] === name)
  if (!line) throw new Error(`${path.basename(sums)} names no ${name}`)
  if (line.trim().split(/\s+/)[0] !== sha) throw new Error(`${name} does not match its ${path.basename(sums)} entry`)
  const root = path.join(resources, 'release')
  // One carried release per app: a rebuild never leaves an older one beside it.
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, `v${target.version}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(archive, path.join(dir, name))
  fs.copyFileSync(sums, path.join(dir, 'SHA256SUMS'))
  return { ...target, dir }
}

function main(argv) {
  const opts = { app: null, archive: null, sums: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') opts.app = path.resolve(argv[++i])
    else if (a === '--archive') opts.archive = path.resolve(argv[++i])
    else if (a === '--sums') opts.sums = path.resolve(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!opts.app || !opts.archive || !opts.sums) throw new Error('usage: desktop-carry-release.mjs --app <Walnut.app> --archive <open-walnut-…-darwin-<arch>.tar.gz> --sums <SHA256SUMS>')
  const out = carryRelease(opts)
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
