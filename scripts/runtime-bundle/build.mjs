#!/usr/bin/env node
/**
 * The self-contained Open Walnut: one archive per platform that runs on a
 * machine with no Node, no npm and no build tools. What install.sh downloads
 * (`curl -fsSL .../install.sh | sh`) and what the desktop app and the Homebrew
 * formula are made of.
 *
 *   node scripts/runtime-bundle/build.mjs --spec open-walnut@0.6.2 --out <dir>
 *   node scripts/runtime-bundle/build.mjs --spec <open-walnut-0.6.2.tgz> --out <dir>
 *
 * Builds for THIS machine's platform and architecture only: the native modules
 * (better-sqlite3, node-pty, sharp) are fetched for the Node that runs them.
 *
 * open-walnut-<version>-<platform>-<arch>.tar.gz
 *   open-walnut-<version>-<platform>-<arch>/
 *     bin/walnut, bin/open-walnut   launchers: this runtime's Node, this package
 *     runtime/                      the official Node release, used as an npm prefix:
 *       bin/node, bin/npm
 *       lib/node_modules/open-walnut    installed with that Node's npm
 *       open-walnut-runtime.json        the marker the updater reads
 *
 * The updater (src/core/self-update/install-kind.ts) recognizes the marker and
 * installs newer releases with runtime/bin/node and its npm into runtime/, so an
 * archive keeps itself current the way an npm install does.
 *
 * Prints the archive's path and sha256 as JSON on the last line.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const RUNTIME_MARKER = 'open-walnut-runtime.json'
export const NODE_MAJOR = 22
const NODE_DIST = (process.env.WALNUT_RUNTIME_NODE_DIST ?? 'https://nodejs.org/dist').replace(/\/$/, '')

/** The platform and architecture words the archive and Node's own releases use. */
export function targetOf(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`no self-contained build for ${platform} (macOS and Linux only)`)
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`no self-contained build for ${arch} (arm64 and x64 only)`)
  return { platform, arch, name: `${platform}-${arch}` }
}

/** The newest release of a Node major in Node's index (newest first). */
export function newestOfMajor(index, major = NODE_MAJOR) {
  const hit = index.find((r) => typeof r.version === 'string' && r.version.startsWith(`v${major}.`))
  if (!hit) throw new Error(`no Node ${major} release in the index`)
  return hit.version.slice(1)
}

/** The expected sha256 of one file in a SHASUMS256.txt. */
export function shaFromSums(sums, file) {
  for (const line of sums.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/)
    if (name === file) return sha
  }
  throw new Error(`${file} is not listed in SHASUMS256.txt`)
}

/**
 * The archive's npm global config (runtime/etc/npmrc, which its npm reads for
 * every install it runs: this build and each update after it). Walnut's
 * embedder runs on the CPU, so onnxruntime-node's install script must not fetch
 * its CUDA provider (about 240 MB on Linux x64, where it is the default).
 */
export const NPMRC = `onnxruntime-node-install=skip
update-notifier=false
fund=false
audit=false
`

/** GPU execution providers onnxruntime-node may carry; Walnut never loads one. */
export const GPU_PROVIDER_LIBS = ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so']

/** The launcher every entry point is: this archive's Node, this archive's package. */
export const LAUNCHER = `#!/bin/sh
# Open Walnut, self-contained: it runs on the Node beside it and updates itself
# into the npm prefix beside it (src/core/self-update/install-kind.ts).
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
root="$(cd "$(dirname "$self")/.." && pwd -P)"
# Last on PATH: a tool that asks for node or npm by name still finds one on a
# machine without Node, and a Node the user installed keeps winning.
PATH="$PATH:$root/runtime/bin"
export PATH
exec "$root/runtime/bin/node" "$root/runtime/lib/node_modules/open-walnut/bin/open-walnut.js" "$@"
`

/**
 * Drop the native binaries a dependency ships for OTHER platforms: an npm install
 * carries every platform's copy (onnxruntime-node alone is 290 MB, two thirds of
 * it Linux and Windows), and this archive only ever runs on one. Each package
 * here loads `<platform>/<arch>` (or `<arch>-<platform>`) by name, and that copy stays.
 * Returns the paths removed.
 */
export function pruneForeignBinaries(modules, { platform, arch }) {
  const removed = []
  const keepOnly = (dir, keep) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (!fs.statSync(full).isDirectory() || keep(name)) continue
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(path.relative(modules, full))
    }
  }
  const onnx = path.join(modules, 'onnxruntime-node', 'bin')
  for (const napi of fs.existsSync(onnx) ? fs.readdirSync(onnx) : []) {
    keepOnly(path.join(onnx, napi), (os) => os === platform)
    keepOnly(path.join(onnx, napi, platform), (a) => a === arch)
    for (const lib of GPU_PROVIDER_LIBS) {
      const file = path.join(onnx, napi, platform, arch, lib)
      if (fs.existsSync(file)) { fs.rmSync(file); removed.push(path.relative(modules, file)) }
    }
  }
  keepOnly(path.join(modules, '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep'), (name) => name === `${arch}-${platform}`)
  for (const pkg of [['@homebridge', 'node-pty-prebuilt-multiarch'], ['screencapturekit-audio-capture']]) {
    keepOnly(path.join(modules, ...pkg, 'prebuilds'), (name) => name.startsWith(`${platform}-${arch}`))
  }
  return removed
}

/**
 * Does this package's updater know the archive? One that does not would update
 * an archive with whatever `npm` is first on PATH, into that npm's own prefix,
 * and leave the archive behind on the old version forever.
 */
export function updaterKnowsArchive(pkgRoot) {
  const stack = [path.join(pkgRoot, 'dist')]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'web') stack.push(full) } else if (e.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes(RUNTIME_MARKER)) return true
    }
  }
  return false
}

/** GET with three tries: one dropped connection to nodejs.org must not fail a release. */
async function fetchOk(url, as) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
      if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`)
      return as === 'json' ? await res.json() : as === 'text' ? await res.text() : Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt === 3) throw err
      process.stdout.write(`${err instanceof Error ? err.message : String(err)}; trying again\n`)
      await new Promise((r) => setTimeout(r, attempt * 5_000))
    }
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function parseArgs(argv) {
  const out = { spec: null, out: null, node: process.env.WALNUT_RUNTIME_NODE_VERSION ?? null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--spec') out.spec = argv[++i]
    else if (a === '--out') out.out = path.resolve(argv[++i])
    else if (a === '--node') out.node = argv[++i]
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.spec || !out.out) throw new Error('usage: build.mjs --spec <open-walnut@x.y.z | tarball> --out <dir> [--node <x.y.z>]')
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const target = targetOf()
  const spec = fs.existsSync(opts.spec) ? path.resolve(opts.spec) : opts.spec
  const nodeVersion = opts.node ?? newestOfMajor(await fetchOk(`${NODE_DIST}/index.json`, 'json'))
  const nodeFile = `node-v${nodeVersion}-${target.name}.tar.gz`
  process.stdout.write(`building open-walnut (${spec}) on Node ${nodeVersion} for ${target.name}\n`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-'))
  try {
    // Node, as nodejs.org ships it, checked against its own published sums.
    const sums = await fetchOk(`${NODE_DIST}/v${nodeVersion}/SHASUMS256.txt`, 'text')
    const tarball = await fetchOk(`${NODE_DIST}/v${nodeVersion}/${nodeFile}`)
    const expected = shaFromSums(sums, nodeFile)
    if (sha256(tarball) !== expected) throw new Error(`${nodeFile} does not match its SHASUMS256.txt entry`)
    const staging = path.join(work, 'stage')
    const runtime = path.join(staging, 'runtime')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(work, nodeFile), tarball)
    execFileSync('tar', ['-xzf', path.join(work, nodeFile), '-C', runtime, '--strip-components=1'])
    for (const extra of ['include', 'share', 'CHANGELOG.md', 'README.md']) fs.rmSync(path.join(runtime, extra), { recursive: true, force: true })
    fs.mkdirSync(path.join(runtime, 'etc'))
    fs.writeFileSync(path.join(runtime, 'etc', 'npmrc'), NPMRC)

    // The package, installed by that Node's npm the way the updater installs it.
    const node = path.join(runtime, 'bin', 'node')
    const npmCli = path.join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    // npm 12 runs only the install scripts it is told to (the updater's list).
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    const allow = [pkg.name, ...Object.entries(pkg.allowScripts ?? {}).filter(([, v]) => v === true).map(([k]) => k)]
    const env = {
      ...process.env,
      PATH: `${path.join(runtime, 'bin')}${path.delimiter}${process.env.PATH}`,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Read from runtime/etc/npmrc as well; said here so a caller's npm config cannot undo it.
      ONNXRUNTIME_NODE_INSTALL: 'skip',
    }
    const args = [npmCli, 'install', '-g', '--prefix', runtime, spec]
    args.push(`--allow-scripts=${allow.join(',')}`)
    execFileSync(node, args, { env, cwd: work, stdio: 'inherit', timeout: 20 * 60_000 })
    const pkgRoot = path.join(runtime, 'lib', 'node_modules', 'open-walnut')
    const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version
    if (!updaterKnowsArchive(pkgRoot)) throw new Error(`open-walnut@${version} predates the self-contained archive: its updater would not update one`)
    const pruned = pruneForeignBinaries(path.join(pkgRoot, 'node_modules'), target)
    process.stdout.write(`dropped ${pruned.length} other-platform binary folders\n`)
    // The native modules that stayed load on this runtime's Node.
    const loads = {
      'better-sqlite3': "new (require('better-sqlite3'))(':memory:').close()",
      'onnxruntime-node': "require('onnxruntime-node')",
    }
    for (const [mod, probe] of Object.entries(loads)) {
      if (!fs.existsSync(path.join(pkgRoot, 'node_modules', mod))) continue
      execFileSync(node, ['-e', probe], { cwd: pkgRoot, env, stdio: 'inherit', timeout: 120_000 })
    }
    fs.writeFileSync(path.join(runtime, RUNTIME_MARKER), `${JSON.stringify({ node: nodeVersion, target: target.name, built: version }, null, 2)}\n`)

    fs.mkdirSync(path.join(staging, 'bin'))
    for (const name of ['walnut', 'open-walnut']) fs.writeFileSync(path.join(staging, 'bin', name), LAUNCHER, { mode: 0o755 })
    const printed = execFileSync(path.join(staging, 'bin', 'walnut'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: work } }).trim()
    if (printed.split(/\s/)[0] !== version) throw new Error(`the built launcher reports "${printed}", expected ${version}`)

    const stem = `open-walnut-${version}-${target.name}`
    fs.renameSync(staging, path.join(work, stem))
    fs.mkdirSync(opts.out, { recursive: true })
    const archive = path.join(opts.out, `${stem}.tar.gz`)
    // No AppleDouble files from macOS tar.
    execFileSync('tar', ['-czf', archive, '-C', work, stem], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const result = { archive, sha256: sha256(fs.readFileSync(archive)), version, node: nodeVersion, target: target.name, bytes: fs.statSync(archive).size }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    if (!opts.keep) fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`runtime-bundle: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
