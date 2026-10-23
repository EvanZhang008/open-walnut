#!/usr/bin/env node
/**
 * What `npm install -g open-walnut` installs: a small launcher package whose
 * optional dependencies are one package per platform, each holding that
 * platform's compiled Walnut (scripts/build-binary.mjs), the way esbuild and
 * the Codex CLI ship. npm installs only the platform package whose os, cpu and
 * libc match the machine; the launcher (scripts/npm-launcher/launch.js) runs it.
 *
 *   node scripts/npm-packages.mjs build --files dist-bin --version 0.7.0 --out <dir> [--git-head <sha>]
 *   node scripts/npm-packages.mjs pack --dir <dir> --out <tarballs>      (rehearsals)
 *   node scripts/npm-packages.mjs publish --dir <dir> --tag latest [--provenance] [--dry-run]
 *
 * <dir> after build:
 *   @open-walnut/<target>/   package.json (os, cpu, libc), walnut, README.md, LICENSE
 *   open-walnut/             package.json (bin, optionalDependencies pinned to the
 *                            version), bin/open-walnut.js, lib/launch.js, dist/cli.js,
 *                            README.md, LICENSE
 *
 * dist/cli.js is for what started Walnut as `node <package>/dist/cli.js` before
 * the package was a launcher: an archive install's updater restarting into the
 * update, a Mac app of that time. It runs the same launcher.
 *
 * publish goes platform packages first, launcher last: the launcher moves the
 * dist-tag every update check reads (update-check.ts), so by then every file it
 * names is on the registry. A version already on the registry is skipped, so a
 * re-run finishes a publish that stopped half way.
 *
 * Every manifest carries `gitHead`, the commit it was built from (the checkout's
 * HEAD unless --git-head names one): the release scripts find a version's commit
 * by it (nightly-version.mjs, stable-promote.mjs), and npm fills it in only for
 * a package directory inside a git checkout.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS, assertVersion, builtName } from './release-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LAUNCHER = 'open-walnut'
export const SCOPE = '@open-walnut'
export const platformName = (target) => `${SCOPE}/${target}`

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
    type: 'module',
    bin: { 'open-walnut': 'bin/open-walnut.js', walnut: 'bin/open-walnut.js' },
    main: './dist/cli.js',
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(TARGETS.map(({ target }) => [platformName(target), version])),
    files: ['bin', 'dist', 'lib', 'README.md', 'LICENSE'],
  }
}

const ENTRY = (from) => `#!/usr/bin/env node
// Open Walnut: runs the compiled Walnut for this machine (lib/launch.js).
import { launch } from '${from}'

launch(import.meta.url)
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
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'npm-launcher', 'launch.js'), path.join(launcher, 'lib', 'launch.js'))
  fs.writeFileSync(path.join(launcher, 'bin', 'open-walnut.js'), ENTRY('../lib/launch.js'), { mode: 0o755 })
  fs.writeFileSync(path.join(launcher, 'dist', 'cli.js'), ENTRY('../lib/launch.js'), { mode: 0o755 })
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

export function publishPackages({ dir, tag, provenance = false, dryRun = false, registry = null, run = spawnSync, log = (l) => process.stdout.write(`${l}\n`) }) {
  if (!tag) throw new Error('publish needs --tag (latest or nightly)')
  const extra = registry ? ['--registry', registry] : []
  for (const pkg of publishOrder(dir)) {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
    if (!dryRun && onRegistry(name, version, extra)) { log(`${name}@${version} is already on npm; not publishing it again`); continue }
    const args = ['publish', pkg, '--tag', tag, '--access', 'public', ...(provenance ? ['--provenance'] : []), ...(dryRun ? ['--dry-run'] : []), ...extra]
    const r = run('npm', args, { encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 << 20 })
    const output = npmOut(r)
    if (r.status !== 0) {
      if (npmHoldsVersion(output, version)) { log(`npm already holds ${name}@${version} (published, or still being processed); not publishing it again`); continue }
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
