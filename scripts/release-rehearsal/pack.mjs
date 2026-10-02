#!/usr/bin/env node
/**
 * Pack this checkout as open-walnut tarballs at chosen versions, for a release
 * rehearsal (scripts/release-rehearsal/run.mjs).
 *
 *   node scripts/release-rehearsal/pack.mjs --out <dir> --version 0.6.1 [--version 0.6.1-rehearsal.1 ...]
 *   node scripts/release-rehearsal/pack.mjs --out <dir> --rehearsal
 *
 * `--rehearsal` packs what run.mjs needs: the next patch of package.json (the
 * release candidate, "current") and a lower prerelease of the same code ("older",
 * which must update itself to current), and writes <dir>/packs.json naming both.
 *
 * The version is baked into the bundles at build time (tsup `define`), so each
 * tarball is its own tsup build, not a renamed copy. Run it after the full
 * build (`npm run build` and the web build), which this does not repeat:
 * prepublishOnly's tarball check (scripts/check-publish.mjs) runs on each one.
 *
 * It rewrites package.json, package-lock.json and dist/, then puts the two
 * manifests back. That is why it refuses to run in a git clone outside CI:
 * the shared worktree's dist/ is what a running server serves.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nextVersion, setManifestVersion } from '../release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function args() {
  const versions = []
  let out = null
  let allowCheckout = false
  let rehearsal = false
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') versions.push(argv[++i])
    else if (argv[i] === '--out') out = argv[++i]
    else if (argv[i] === '--allow-checkout') allowCheckout = true
    else if (argv[i] === '--rehearsal') rehearsal = true
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (rehearsal) {
    const current = nextVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, 'patch')
    versions.push(current, `${current}-rehearsal.1`)
  }
  if (!out || versions.length === 0) throw new Error('usage: pack.mjs --out <dir> (--version <x.y.z> ... | --rehearsal)')
  return { versions, out: path.resolve(out), allowCheckout, rehearsal }
}

const run = (cmd, argv, env = {}) => execFileSync(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, ...env } })

function main() {
  const { versions, out, allowCheckout, rehearsal } = args()
  if (fs.existsSync(path.join(root, '.git')) && !process.env.CI && !allowCheckout) {
    throw new Error('this rebuilds dist/ and rewrites package.json: run it in CI or in a copy of the tree (git archive), or pass --allow-checkout')
  }
  fs.mkdirSync(out, { recursive: true })
  const manifests = ['package.json', 'package-lock.json'].map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')])
  const files = []
  let restamped = false
  try {
    for (const version of versions) {
      for (const [f, text] of manifests) fs.writeFileSync(path.join(root, f), setManifestVersion(text, version))
      restamped = true
      // The stamp is the only edit, so the build must not call itself dirty.
      run('npx', ['tsup'], { WALNUT_VERSION_STAMPED: '1' })
      run(process.execPath, ['scripts/check-publish.mjs'])
      // No lifecycle scripts: `prepare` (husky) prints to stdout, which is the JSON.
      const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out]))
      // npm 12 answers an object keyed by package name, older npm an array.
      const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
      const file = path.join(out, entry.filename)
      files.push(file)
      process.stdout.write(`${version}\t${file}\n`)
    }
  } finally {
    for (const [f, text] of manifests) fs.writeFileSync(path.join(root, f), text)
    // The bundles may carry a stamped version (even after a failure); rebuild them as package.json says.
    if (restamped) run('npx', ['tsup'])
  }
  if (rehearsal) fs.writeFileSync(path.join(out, 'packs.json'), `${JSON.stringify({ current: files[0], older: files[1] }, null, 2)}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`pack: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
