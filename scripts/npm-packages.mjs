#!/usr/bin/env bun
/**
 * What `npm install -g open-walnut` installs: a small launcher package whose
 * optional dependencies are one package per platform, each holding that
 * platform's compiled Walnut (scripts/build-binary.mjs), the way esbuild and
 * the Codex CLI ship. npm installs only the platform package whose os, cpu and
 * libc match the machine; the launcher (scripts/npm-launcher/launch.js) runs it.
 *
 *   bun scripts/npm-packages.mjs build --files dist-bin --version 0.7.0 --out <dir> [--git-head <sha>]
 *   bun scripts/npm-packages.mjs pack --dir <dir> --out <tarballs>      (rehearsals)
 *   bun scripts/npm-packages.mjs publish --dir <dir> --tag latest [--provenance] [--dry-run]
 *
 * <dir> after build:
 *   @open-walnut/<target>/   package.json (os, cpu, libc), walnut, README.md, LICENSE
 *   open-walnut/             package.json (bin, optionalDependencies pinned to the
 *                            version, a postinstall that checks the file came too),
 *                            bin/open-walnut.js, lib/{launch,fetch-platform,postinstall}.js,
 *                            dist/cli.js, README.md, LICENSE
 *
 * dist/cli.js is for what started Walnut as `node <package>/dist/cli.js` before
 * the package was a launcher: an archive install's updater restarting into the
 * update, a Mac app of that time. It runs the same launcher.
 *
 * publish goes platform packages first, launcher last, and the launcher only
 * once installers see every platform package (waitUntilVisible): the launcher
 * moves the dist-tag every update check reads (update-check.ts), and npm
 * finishes an install without an optional dependency it cannot find yet. A
 * version already on the registry is skipped, so a re-run finishes a publish
 * that stopped half way.
 *
 * Every manifest carries `gitHead`, the commit it was built from (the checkout's
 * HEAD unless --git-head names one): the release scripts find a version's commit
 * by it (nightly-version.mjs, stable-promote.mjs), and npm fills it in only for
 * a package directory inside a git checkout.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { TARGETS, assertVersion, builtName } from './release-files.mjs'

// The launcher's own code is CommonJS (scripts/npm-launcher/package.json).
const { INSTALL_SH } = createRequire(import.meta.url)('./npm-launcher/launch.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LAUNCHER = 'open-walnut'
export const SCOPE = '@open-walnut'
export const platformName = (target) => `${SCOPE}/${target}`

/**
 * Every platform package name that exists on npm with this repo's release.yml as its trusted
 * publisher (docs/reference/releasing.md, "npm packages"). The workflow can publish only to a
 * name that exists, and creating one takes the owner's 2FA, so names are reserved ahead: the
 * release targets and the two Windows ones Bun also builds. A target added without its name here
 * would fail every release at its first publish; the release-files test refuses it first.
 */
export const NPM_RESERVED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'windows-x64', 'windows-arm64']

const OS_WORDS = { darwin: 'macOS', linux: 'Linux' }
const describeTarget = ({ os, cpu, libc }) => `${OS_WORDS[os]} ${cpu}${libc === 'musl' ? ' (musl)' : ''}`

/** The platform package's manifest: npm reads os, cpu and libc to decide whether it installs. */
export function platformManifest(entry, version, repo) {
  return {
    name: platformName(entry.target),
    version,
    description: `Open Walnut compiled for ${describeTarget(entry)}. Installed by the open-walnut package; not meant to be installed alone.`,
    license: repo.license,
    homepage: repo.homepage,
    repository: repo.repository,
    os: [entry.os],
    cpu: [entry.cpu],
    ...(entry.libc ? { libc: [entry.libc] } : {}),
    files: ['walnut'],
    // Yarn's Plug'n'Play must unpack it: a file inside a zip cannot be executed.
    preferUnplugged: true,
  }
}

export function launcherManifest(version, repo) {
  return {
    name: LAUNCHER,
    version,
    description: repo.description,
    license: repo.license,
    homepage: repo.homepage,
    repository: repo.repository,
    keywords: repo.keywords,
    // CommonJS on any Node npm installs it with: the compiled file needs no Node,
    // so the launcher must not need a new one (Debian 11's apt Node is 12).
    type: 'commonjs',
    bin: { 'open-walnut': 'bin/open-walnut.js', walnut: 'bin/open-walnut.js' },
    main: './dist/cli.js',
    engines: { node: `>=${LAUNCHER_NODE_FLOOR}` },
    optionalDependencies: Object.fromEntries(TARGETS.map(({ target }) => [platformName(target), version])),
    // The install is good only with this machine's file: fetched when npm left it
    // out, else the install fails and npm keeps the version before (lib/postinstall.js).
    scripts: { postinstall: 'node lib/postinstall.js' },
    files: ['bin', 'dist', 'lib', 'README.md', 'LICENSE'],
  }
}

/** The launcher's own code, scripts/npm-launcher/<name> -> lib/<name>. */
export const LAUNCHER_LIB = ['launch.js', 'fetch-platform.js', 'postinstall.js']

/** The oldest Node the launcher runs on: its code is CommonJS, ES2017 and Node 8 APIs. */
export const LAUNCHER_NODE_FLOOR = 8

/**
 * bin/open-walnut.js and dist/cli.js. ES5 up to the check, so a Node too old
 * for lib/ says so in one line instead of a SyntaxError. lib/launch.js by its
 * absolute path: Node 8 and 10 read the working directory to resolve a relative
 * require, and a Mac app's server starts in a directory an update deleted.
 */
export const ENTRY = () => `#!/usr/bin/env node
// Open Walnut: runs the compiled Walnut for this machine (lib/launch.js).
'use strict'
var node = process.versions.node
if (parseInt(node.split('.')[0], 10) < ${LAUNCHER_NODE_FLOOR}) {
  process.stderr.write('open-walnut: Node.js ' + node + ' is too old to start Walnut (npm\\'s launcher needs Node.js ${LAUNCHER_NODE_FLOOR} or newer). Walnut itself needs no Node: ${INSTALL_SH}\\n')
  process.exit(1)
}
require(require('path').join(__dirname, '..', 'lib', 'launch.js')).launch(__filename)
`

const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)

function headOf(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  return r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null
}

/** Lay out every platform package and the launcher under `out`. Returns their directories. */
export function buildPackages({ files, version, out, repoRoot = root, gitHead = headOf(repoRoot) }) {
  assertVersion(version)
  if (gitHead != null && !/^[0-9a-f]{40}$/.test(gitHead)) throw new Error(`${gitHead} is not a commit sha`)
  const head = gitHead ? { gitHead } : {}
  const repo = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const missing = TARGETS.filter(({ target }) => !fs.existsSync(path.join(files, builtName(target))))
  if (missing.length) throw new Error(`${files} has no ${missing.map(({ target }) => builtName(target)).join(', ')}`)
  fs.rmSync(out, { recursive: true, force: true })
  const dirs = { platforms: [], launcher: path.join(out, LAUNCHER) }
  for (const entry of TARGETS) {
    const dir = path.join(out, SCOPE, entry.target)
    fs.mkdirSync(dir, { recursive: true })
    writeJson(path.join(dir, 'package.json'), { ...platformManifest(entry, version, repo), ...head })
    fs.copyFileSync(path.join(files, builtName(entry.target)), path.join(dir, 'walnut'))
    fs.chmodSync(path.join(dir, 'walnut'), 0o755)
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${platformName(entry.target)}\n\nOpen Walnut ${version} compiled for ${describeTarget(entry)}. Install Walnut with \`npm install -g open-walnut\`, which picks the package for your machine: ${repo.homepage}\n`)
    fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(dir, 'LICENSE'))
    dirs.platforms.push(dir)
  }
  const launcher = dirs.launcher
  for (const sub of ['bin', 'lib', 'dist']) fs.mkdirSync(path.join(launcher, sub), { recursive: true })
  writeJson(path.join(launcher, 'package.json'), { ...launcherManifest(version, repo), ...head })
  for (const f of LAUNCHER_LIB) fs.copyFileSync(path.join(repoRoot, 'scripts', 'npm-launcher', f), path.join(launcher, 'lib', f))
  fs.writeFileSync(path.join(launcher, 'bin', 'open-walnut.js'), ENTRY(), { mode: 0o755 })
  fs.writeFileSync(path.join(launcher, 'dist', 'cli.js'), ENTRY(), { mode: 0o755 })
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(launcher, 'README.md'))
  fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(launcher, 'LICENSE'))
  return dirs
}

/** The package directories under a built `dir`, in publish order: platforms, then the launcher. */
export function publishOrder(dir) {
  const platforms = TARGETS.map(({ target }) => path.join(dir, SCOPE, target))
  for (const p of [...platforms, path.join(dir, LAUNCHER)]) {
    if (!fs.existsSync(path.join(p, 'package.json'))) throw new Error(`${p} is not a built package (run build first)`)
  }
  return [...platforms, path.join(dir, LAUNCHER)]
}

/** `npm pack` each package into `out`; returns the tarballs in publish order. */
export function packPackages(dir, out) {
  fs.mkdirSync(out, { recursive: true })
  return publishOrder(dir).map((pkg) => {
    const packed = JSON.parse(execFileSync('npm', ['pack', pkg, '--json', '--ignore-scripts', '--pack-destination', out], { encoding: 'utf8', maxBuffer: 64 << 20 }))
    // npm 12 answers an object keyed by package name, older npm an array.
    const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
    return path.join(out, entry.filename)
  })
}

const npmOut = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * npm's own word that it holds this very version, published or accepted and
 * still being processed (2026-10-09: 409 "Cannot publish over previously staged
 * version"). Not a refusal for another version that merely starts the same.
 */
export function npmHoldsVersion(output, version) {
  const v = escapeRe(version)
  return new RegExp(`previously staged version "${v}"|previously published versions: ${v}(?![0-9A-Za-z-]|\\.[0-9A-Za-z])`, 'i').test(output)
}

/** Is name@version on the registry already (published, or accepted and still being processed)? */
function onRegistry(name, version, extra) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', ...extra], { encoding: 'utf8', timeout: 120_000 })
  return r.status === 0 && r.stdout.trim() === version
}

/** False only when npm answers that the package has no version at all (E404). */
function packageExists(name, extra) {
  const r = spawnSync('npm', ['view', name, 'name', ...extra], { encoding: 'utf8', timeout: 120_000 })
  return !(r.status !== 0 && /\bE404\b/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`))
}

/** npm refused the publish for want of a login, as trusted publishing does for a package it cannot match. */
export function npmNeedsAuth(output) {
  return /\bENEEDAUTH\b|\bE401\b/.test(output)
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * A failure outside Walnut that a later try can pass: the signing service's transparency log
 * (2026-10-30: npm's own retry of a provenance upload met "409 an equivalent entry already
 * exists", TLOG_CREATE_ENTRY_ERROR, and stopped the stable promotion), a registry 5xx, or the
 * network. A refusal of the package itself is not one.
 */
export function npmTransient(output) {
  return /\bTLOG_CREATE_ENTRY_ERROR\b|\bE5\d\d\b|npm error (?:code )?5\d\d\b|\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/.test(output)
}

/** How often a transient publish failure is tried again, and the wait before each try (times the try). */
export const PUBLISH_RETRY = { tries: 3, delayMs: 30_000 }

/** The registry installers read: --registry, else npm's own environment setting, else npm's default. */
export function probeRegistry(registry = null, env = process.env) {
  return (registry || env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
}

/** What npm's install asks for: the abbreviated document (what lib/postinstall.js reads is the version's own). */
export const INSTALL_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

/** GET `url` with `accept`, from this synchronous script: { status, body } ({ status: 0 } when nothing answered). */
function getSync(url, accept) {
  const script = 'fetch(process.argv[1], { headers: { accept: process.argv[2] }, signal: AbortSignal.timeout(60000) })'
    + '.then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: r.ok ? await r.text() : "" })),'
    + ' (e) => process.stdout.write(JSON.stringify({ status: 0, body: String(e) })))'
  const r = spawnSync(process.execPath, ['-e', script, url, accept], { encoding: 'utf8', timeout: 90_000, maxBuffer: 256 << 20 })
  try { return JSON.parse(r.stdout) } catch { return { status: 0, body: r.stderr ?? '' } }
}

const jsonOf = (res) => { try { return res.status === 200 ? JSON.parse(res.body) : null } catch { return null } }

/**
 * Does an installer see name@version now? Each document a fresh install reads,
 * as it reads it (no cache-busting: the registry's CDN caches each document on
 * its own, and serves the copy it holds): the abbreviated document npm resolves
 * the launcher's optional dependencies from, and the version's own document
 * lib/postinstall.js fetches a left-out one by.
 */
export function installerSees(name, version, registry = probeRegistry(), get = getSync) {
  const at = `${registry}/${name.replace('/', '%2f')}`
  const index = jsonOf(get(at, INSTALL_ACCEPT))
  if (!index || !index.versions || !index.versions[version]) return false
  const doc = jsonOf(get(`${at}/${encodeURIComponent(version)}`, 'application/json'))
  return Boolean(doc && doc.version === version)
}

/** How long the launcher waits for its platform packages to be seen by installers. */
export const VISIBLE_WAIT = { everyMs: 15_000, forMs: 20 * 60_000 }

/**
 * Wait until installers see every package in `pkgs` ([name, version]). npm makes a
 * new version visible package by package over minutes, and npm finishes an
 * install without an optional dependency it cannot find yet: a launcher out
 * before its platform packages installs as a launcher with no file. Throws when
 * they are still not seen: the launcher is not published, and a re-run finishes.
 */
export function waitUntilVisible(pkgs, { sees = installerSees, registry = probeRegistry(), wait = VISIBLE_WAIT, sleep = sleepSync, log = () => {}, now = Date.now } = {}) {
  const deadline = now() + wait.forMs
  let missing = pkgs
  for (;;) {
    missing = missing.filter(([name, version]) => !sees(name, version, registry))
    if (missing.length === 0) return
    if (now() >= deadline) throw new Error(`installers still do not see ${missing.map(([n, v]) => `${n}@${v}`).join(', ')} after ${Math.round(wait.forMs / 60_000)} min; not publishing the launcher (run the publish again to finish it)`)
    log(`waiting for installers to see ${missing.map(([n, v]) => `${n}@${v}`).join(', ')}`)
    sleep(wait.everyMs)
  }
}

export function publishPackages({ dir, tag, provenance = false, dryRun = false, registry = null, run = spawnSync, log = (l) => process.stdout.write(`${l}\n`), waitVisible = waitUntilVisible, has = onRegistry, exists = packageExists, retry = PUBLISH_RETRY, sleep = sleepSync }) {
  if (!tag) throw new Error('publish needs --tag (latest or nightly)')
  const extra = registry ? ['--registry', registry] : []
  const platforms = []
  for (const pkg of publishOrder(dir)) {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
    // The launcher only once every file it names can be installed.
    if (name === LAUNCHER && !dryRun) waitVisible(platforms, { registry: probeRegistry(registry), log })
    // Every one, published now or by an earlier run: on the registry is not yet seen by installers.
    if (name !== LAUNCHER) platforms.push([name, version])
    if (!dryRun && has(name, version, extra)) { log(`${name}@${version} is already on npm; not publishing it again`); continue }
    const args = ['publish', pkg, '--tag', tag, '--access', 'public', ...(provenance ? ['--provenance'] : []), ...(dryRun ? ['--dry-run'] : []), ...extra]
    let r
    let output = ''
    let landed = false
    for (let attempt = 1; ; attempt++) {
      r = run('npm', args, { encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 << 20 })
      output = npmOut(r)
      if (r.status === 0 || attempt >= retry.tries || !npmTransient(output) || npmHoldsVersion(output, version)) break
      log(`npm publish ${name}@${version} failed outside Walnut (try ${attempt} of ${retry.tries}); trying again`)
      sleep(retry.delayMs * attempt)
      // The failed try may have been published after all.
      if (!dryRun && has(name, version, extra)) { landed = true; break }
    }
    if (landed) { log(`${name}@${version} reached npm on a failed try; not publishing it again`); continue }
    if (r.status !== 0) {
      if (npmHoldsVersion(output, version)) { log(`npm already holds ${name}@${version} (published, or still being processed); not publishing it again`); continue }
      // Trusted publishing only works for a package that exists and names this workflow:
      // a package npm has never held needs its owner's one-time setup first (2026-10-28,
      // the first nightly with the platform packages failed on a bare ENEEDAUTH).
      if (npmNeedsAuth(output) && !exists(name, extra)) {
        throw new Error(`npm publish ${name}@${version} needs a login: ${name} has never been published, and npm trusted publishing only works for a package that exists and names this workflow. Its owner sets it up once (docs/reference/releasing.md, "npm packages": create the npm organization, publish the package by hand with 2FA, set its trusted publisher), then re-runs this job. The launcher was not published, so no install changes.`)
      }
      throw new Error(`npm publish ${name}@${version} exited ${r.status}:\n${output.slice(-2000)}`)
    }
    log(`${dryRun ? 'would publish' : 'published'} ${name}@${version} (${tag})`)
  }
}

function parse(argv) {
  const opts = { files: null, version: null, out: null, dir: null, tag: null, provenance: false, dryRun: false, registry: null, gitHead: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--files') opts.files = path.resolve(argv[++i])
    else if (a === '--version') opts.version = argv[++i]
    else if (a === '--out') opts.out = path.resolve(argv[++i])
    else if (a === '--dir') opts.dir = path.resolve(argv[++i])
    else if (a === '--tag') opts.tag = argv[++i]
    else if (a === '--registry') opts.registry = argv[++i]
    else if (a === '--git-head') opts.gitHead = argv[++i]
    else if (a === '--provenance') opts.provenance = true
    else if (a === '--dry-run') opts.dryRun = true
    else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

function main([cmd, ...rest]) {
  const opts = parse(rest)
  if (cmd === 'build' && opts.files && opts.version && opts.out) {
    const { gitHead, ...rest } = opts
    const dirs = buildPackages(gitHead === undefined ? rest : opts)
    for (const d of [...dirs.platforms, dirs.launcher]) process.stdout.write(`${d}\n`)
  } else if (cmd === 'pack' && opts.dir && opts.out) {
    for (const f of packPackages(opts.dir, opts.out)) process.stdout.write(`${f}\n`)
  } else if (cmd === 'publish' && opts.dir) {
    publishPackages(opts)
  } else {
    throw new Error('usage: npm-packages.mjs build --files <dist-bin> --version <v> --out <dir> [--git-head <sha>] | pack --dir <dir> --out <dir> | publish --dir <dir> --tag <tag> [--provenance] [--dry-run] [--registry <url>]')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`npm-packages: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
