#!/usr/bin/env bun
/**
 * The release the field rehearsal updates installs to (run.mjs --field latest,
 * field.mjs): this checkout as a release publishes it now, the open-walnut
 * launcher plus one @open-walnut/<target> package per platform
 * (npm-packages.mjs), at a version above the one on npm today, so the update is
 * never skipped by a version skew. Two versions: the release, and the one after
 * it, which the release's own updater must take (an install keeps working).
 *
 *   bun scripts/release-rehearsal/field-packs.mjs versions
 *        prints the two versions (above the registry's `latest` and `nightly`, and package.json)
 *   bun scripts/release-rehearsal/field-packs.mjs build --out <dir> [--target <t> ...] [--reuse-web] [--allow-checkout]
 *        compiles this checkout at both versions (build-binary.mjs, this
 *        machine's target unless --target names others) and packs them
 *   bun scripts/release-rehearsal/field-packs.mjs pack --files <dir> --version <v> [--next-files <dir> --next <v2>] --out <dir>
 *        packs files compiled already (<dir>/walnut-<target>); the next release is optional
 *
 * Both leave <out>/field.json: { release: { version, tarballs }, next?: { version, tarballs } },
 * the tarballs in publish order. A target without a compiled file gets a
 * placeholder (only the machine's own platform package is ever installed);
 * every package the launcher names is on the registry, as on npm.
 *
 * `build` rewrites package.json and dist-bin/, then puts the manifest back, so
 * like pack.mjs it refuses a git checkout outside CI unless --allow-checkout.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPackages, packPackages } from '../npm-packages.mjs'
import { nextVersion, setManifestVersion } from '../release.mjs'
import { TARGETS, assertVersion, builtName } from '../release-files.mjs'
import { UPSTREAM } from './registry.mjs'
import { compareVersions } from './version-order.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The release and the one after it: prereleases of the patch above every
 * version given (the registry's `latest` and `nightly`, package.json), so the
 * release is newer than every install on either channel today, and the second
 * newer than the first.
 */
export function fieldVersions(versions) {
  const known = versions.filter((v) => v && compareVersions(v, v) !== null)
  if (known.length === 0) throw new Error('no version to go above')
  const base = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
  const next = nextVersion(base.replace(/-.*$/, ''), 'patch')
  return { release: `${next}-rehearsal.1`, next: `${next}-rehearsal.2` }
}

/** The registry's dist-tags for open-walnut (`latest`, and `nightly` when there is one). */
export async function publishedTags({ upstream = UPSTREAM, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${upstream}/-/package/open-walnut/dist-tags`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for open-walnut's dist-tags`)
  const tags = await res.json()
  if (typeof tags?.latest !== 'string' || compareVersions(tags.latest, tags.latest) === null) throw new Error(`the registry names no latest open-walnut (${JSON.stringify(tags)})`)
  return tags
}

/** A dist-bin for `version`: the compiled files `files` names, placeholders for every other target. */
export function fieldDistBin(dir, version, files) {
  fs.mkdirSync(dir, { recursive: true })
  for (const { target } of TARGETS) {
    const out = path.join(dir, builtName(target))
    if (files[target]) {
      fs.copyFileSync(files[target], out)
    } else {
      // Never installed: npm picks this machine's package. It says what it is if it ever runs.
      fs.writeFileSync(out, `#!/bin/sh\necho 'open-walnut ${version} rehearsal placeholder for ${target}: not a real build' >&2\nexit 1\n`)
    }
    fs.chmodSync(out, 0o755)
  }
  return dir
}

/** Lay out and pack the launcher and platform packages of one version; returns the tarballs, in publish order. */
export function packVersion({ files, version, out }) {
  assertVersion(version)
  const bin = fieldDistBin(path.join(out, `dist-bin-${version}`), version, files)
  const dirs = buildPackages({ files: bin, version, out: path.join(out, `npm-${version}`) })
  const tarballs = packPackages(path.dirname(dirs.launcher), path.join(out, `tgz-${version}`))
  fs.rmSync(bin, { recursive: true, force: true })
  fs.rmSync(path.join(out, `npm-${version}`), { recursive: true, force: true })
  return tarballs
}

/** The compiled files in `dir` (walnut-<target>), by target. */
export function filesIn(dir) {
  const out = {}
  for (const { target } of TARGETS) {
    const f = path.join(dir, builtName(target))
    if (fs.existsSync(f)) out[target] = f
  }
  if (Object.keys(out).length === 0) throw new Error(`${dir} holds no walnut-<target> file`)
  return out
}

/** field.json names its tarballs relative to itself, so the directory can move. `next` is optional. */
export function writeFieldJson(out, release, next = null) {
  const rel = (v) => ({ version: v.version, tarballs: v.tarballs.map((t) => path.relative(out, t)) })
  const doc = { release: rel(release), ...(next ? { next: rel(next) } : {}) }
  fs.writeFileSync(path.join(out, 'field.json'), `${JSON.stringify(doc, null, 2)}\n`)
  return doc
}

/** The field.json a run reads, with its tarballs resolved and checked. */
export function readFieldJson(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const key of ['release', 'next']) {
    const v = doc[key]
    if (key === 'next' && v === undefined) continue
    if (!v?.version || !Array.isArray(v.tarballs) || v.tarballs.length === 0) throw new Error(`${file} names no ${key} release`)
    v.tarballs = v.tarballs.map((t) => path.resolve(path.dirname(file), t))
    for (const t of v.tarballs) if (!fs.existsSync(t)) throw new Error(`${file}: ${t} is not there`)
  }
  if (doc.next && compareVersions(doc.next.version, doc.release.version) <= 0) throw new Error(`${file}: next ${doc.next.version} is not newer than ${doc.release.version}`)
  return doc
}

const hostTarget = () => TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch && !t.libc?.startsWith('musl'))?.target

/** Compile this checkout at `version` for `targets`; returns { target: file } copied into `keep`. */
function compileAt(version, targets, { reuseWeb, keep }) {
  const pkgFile = path.join(root, 'package.json')
  fs.writeFileSync(pkgFile, setManifestVersion(fs.readFileSync(pkgFile, 'utf8'), version))
  const bun = process.env.BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun')
  execFileSync(bun, ['scripts/build-binary.mjs', ...targets.flatMap((t) => ['--target', t]), ...(reuseWeb ? ['--reuse-web'] : [])], {
    cwd: root, stdio: 'inherit', env: { ...process.env, WALNUT_VERSION_STAMPED: '1' },
  })
  fs.mkdirSync(keep, { recursive: true })
  const files = {}
  for (const t of targets) {
    files[t] = path.join(keep, builtName(t))
    fs.copyFileSync(path.join(root, 'dist-bin', builtName(t)), files[t])
    fs.chmodSync(files[t], 0o755)
  }
  const host = hostTarget()
  if (files[host]) {
    const env = { ...process.env }
    delete env.BUN_BE_BUN
    const printed = execFileSync(files[host], ['--version'], { env, encoding: 'utf8', timeout: 120_000 }).trim()
    if (printed.split(/\s/)[0] !== version) throw new Error(`${builtName(host)} at ${version} prints "${printed}"`)
  }
  return files
}

async function main(argv) {
  const [cmd, ...rest] = argv
  const opts = { out: null, targets: [], reuseWeb: false, allowCheckout: false, files: null, version: null, nextFiles: null, next: null }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--out') opts.out = path.resolve(rest[++i])
    else if (a === '--target') opts.targets.push(rest[++i])
    else if (a === '--reuse-web') opts.reuseWeb = true
    else if (a === '--allow-checkout') opts.allowCheckout = true
    else if (a === '--files') opts.files = path.resolve(rest[++i])
    else if (a === '--version') opts.version = rest[++i]
    else if (a === '--next-files') opts.nextFiles = path.resolve(rest[++i])
    else if (a === '--next') opts.next = rest[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  const local = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const above = async () => { const t = await publishedTags(); return fieldVersions([t.latest, t.nightly, local]) }
  if (cmd === 'versions') {
    const v = await above()
    process.stdout.write(`${v.release} ${v.next}\n`)
    return
  }
  if (cmd === 'pack' && opts.files && opts.version && opts.out && !opts.next === !opts.nextFiles) {
    fs.mkdirSync(opts.out, { recursive: true })
    const release = { version: opts.version, tarballs: packVersion({ files: filesIn(opts.files), version: opts.version, out: opts.out }) }
    const next = opts.next ? { version: opts.next, tarballs: packVersion({ files: filesIn(opts.nextFiles), version: opts.next, out: opts.out }) } : null
    writeFieldJson(opts.out, release, next)
    process.stdout.write(`${path.join(opts.out, 'field.json')}\n`)
    return
  }
  if (cmd === 'build' && opts.out) {
    if (fs.existsSync(path.join(root, '.git')) && !process.env.CI && !opts.allowCheckout) {
      throw new Error('this rebuilds dist-bin/ and rewrites package.json: run it in CI or in a copy of the tree, or pass --allow-checkout')
    }
    const targets = opts.targets.length ? opts.targets : [hostTarget()]
    if (targets.some((t) => !t || !TARGETS.some((x) => x.target === t))) throw new Error(`no release target for ${targets.join(', ')}`)
    const v = await above()
    process.stdout.write(`field versions: ${v.release} (the release), ${v.next} (the one after)\n`)
    fs.mkdirSync(opts.out, { recursive: true })
    const pkgFile = path.join(root, 'package.json')
    const manifest = fs.readFileSync(pkgFile, 'utf8')
    let files
    try {
      files = {
        release: compileAt(v.release, targets, { reuseWeb: opts.reuseWeb, keep: path.join(opts.out, `files-${v.release}`) }),
        // The web app does not change with the version.
        next: compileAt(v.next, targets, { reuseWeb: true, keep: path.join(opts.out, `files-${v.next}`) }),
      }
    } finally {
      fs.writeFileSync(pkgFile, manifest)
    }
    const release = { version: v.release, tarballs: packVersion({ files: files.release, version: v.release, out: opts.out }) }
    const next = { version: v.next, tarballs: packVersion({ files: files.next, version: v.next, out: opts.out }) }
    for (const dir of [`files-${v.release}`, `files-${v.next}`]) fs.rmSync(path.join(opts.out, dir), { recursive: true, force: true })
    writeFieldJson(opts.out, release, next)
    process.stdout.write(`${path.join(opts.out, 'field.json')}\n`)
    return
  }
  throw new Error('usage: field-packs.mjs versions | build --out <dir> [--target <t> ...] [--reuse-web] [--allow-checkout] | pack --files <dir> --version <v> [--next-files <dir> --next <v2>] --out <dir>')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`field-packs: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
