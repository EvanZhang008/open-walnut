/**
 * Build dist/cli-fast.js, the entry every data command runs (`walnut tools call`,
 * `tasks`, `add`, `--version`; src/cli-fast.ts), with bun as CommonJS plus
 * bytecode (dist/cli-fast.js.jsc), so a call loads compiled code instead of
 * parsing ~20 MB of JavaScript first.
 *
 *   bun scripts/build-cli-fast.mjs [<outDir>]        (default: dist)
 *
 * tsup.config.ts runs this from onSuccess, so every path that runs tsup (`bun run
 * build`, `web:build`, a deploy, a release rehearsal's `npx tsup`, `tsup --watch`)
 * writes it; tsup builds every other entry. Why bun and CommonJS: bun writes
 * bytecode for a plain .js only as CommonJS (ESM bytecode needs `compile`, as
 * scripts/build-binary.mjs does), and CommonJS has no top-level await, which is
 * why src/cli-fast.ts runs as one async main().
 *
 * The .jsc is only a cache. bun checks it against the .js beside it and against
 * its own JavaScriptCore, and parses the source when either differs (another bun
 * version, a .jsc from another build, none at all), so a mismatch costs speed,
 * never correctness. The files still land in an order where a reader never meets
 * an old .jsc: the old one goes first, the new one last, each by rename. Before
 * that the new entry is run where it will run (scripts/cli-fast-probe.mjs): one
 * that cannot answer `--version` and `tools list` fails the build, and the CLI
 * in place stays.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPathsIn, moduleRoots } from './binary-build-checks.mjs'
import { probeCliFast } from './cli-fast-probe.mjs'

export const CLI_FAST_ENTRY = 'src/cli-fast.ts'
/** What this build writes into the out dir: the entry, its bytecode and its source map. */
export const CLI_FAST_FILES = ['cli-fast.js', 'cli-fast.js.jsc', 'cli-fast.js.map']
/** First line of a bun CommonJS bundle that carries bytecode. */
export const CLI_FAST_PRAGMA = '// @bun @bytecode @bun-cjs'

// What `#ws` is in a bundle: the ws package found from the bundle's own place
// (dist/ beside node_modules, or a host build's linked node_modules) and loaded
// by its file path, which bun does not swap for its built-in WebSocket. Its
// package.json is the one subpath the package exports. tsup.config.ts uses it too.
export const WS_ON_BUN = `
import { createRequire as __wsRequire } from 'node:module';
import __wsPath from 'node:path';
const __wsReq = __wsRequire(import.meta.url);
const ws = __wsReq(__wsPath.join(__wsPath.dirname(__wsReq.resolve('ws/package.json')), 'index.js'));
export default ws;
export const WebSocket = ws.WebSocket;
export const WebSocketServer = ws.WebSocketServer;
export const createWebSocketStream = ws.createWebSocketStream;
export const Receiver = ws.Receiver;
export const Sender = ws.Sender;
`

// 'bun:sqlite' exists only at runtime (src/lib/sqlite.ts loads it); the rest
// are optional or downloaded components, loaded where they are installed.
export const BUNDLE_EXTERNAL = ['bun:sqlite', 'sharp', '@anthropic-ai/claude-agent-sdk', 'screencapturekit-audio-capture', '@huggingface/transformers']

/**
 * Direct dependencies cli-fast loads from node_modules instead of carrying, as
 * tsup's bundles load every dependency. Everything else is bundled, as in the
 * compiled file, so bun's own interop joins ES and CommonJS modules. These are
 * CommonJS packages that find their own files through `__dirname`, or sit over
 * one that does (tiktoken's wasm, pino's workers), which bun would bake in as
 * the build machine's path. Each must be CommonJS: bun reads a default import of
 * an external the Node way, and an ES-only package (chalk) does not answer it.
 */
export const CLI_FAST_FROM_DISK = ['@anthropic-ai/tokenizer', 'imapflow']

/** Refuses a CLI_FAST_FROM_DISK entry that is not a CommonJS dependency of `repo`. */
export function checkFromDisk(repo, pkg, fromDisk = CLI_FAST_FROM_DISK) {
  for (const name of fromDisk) {
    if (!pkg.dependencies?.[name]) throw new Error(`build-cli-fast: ${name} is loaded from node_modules but is not in package.json dependencies`)
    const own = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', name, 'package.json'), 'utf8'))
    if (own.type === 'module') throw new Error(`build-cli-fast: ${name} is an ES module package; bundle it instead (see CLI_FAST_FROM_DISK)`)
  }
}

// bun's CommonJS output replaces `import.meta.url` with the SOURCE file's URL,
// fixed at build time (file:///<build dir>/src/lib/build-info.ts), which names a
// clone a deploy deletes. In an ES bundle every module's import.meta.url is the
// bundle's own URL; this keeps that: one variable, set from __filename at load.
// Only Walnut's own files may read it (foreignBundleUrlReaders).
const BUNDLE_URL = '__walnutBundleUrl'
// "use strict" first: bun's CommonJS wrapper has none, and every ES module (the
// tsup build, the tests, the compiled file) runs strict.
const BANNER = `"use strict";var ${BUNDLE_URL} = require("node:url").pathToFileURL(__filename).href;`

// A file's section in a bun bundle starts with a comment line naming it: its path
// relative to the build's working directory, or a plugin's `namespace:path`.
const SECTION = /^\/\/ ((?:[\w@.+-]+\/)+[\w@.+-]+|[\w-]+:[^\s/]\S*)$/

/**
 * The bundled files, not Walnut's own, that read the bundle URL: their
 * import.meta.url. A dependency that finds a file beside itself that way
 * (`new URL('./asset.txt', import.meta.url)`) would look in dist/ and fail when
 * it runs. Walnut's own are `repo`'s src/ and the walnut-ws module; each other
 * file is named relative to `repo` when it is inside it. Fails closed: code
 * outside any section counts too.
 */
export function foreignBundleUrlReaders(js, { repo = root, cwd = process.cwd() } = {}) {
  const repos = [...new Set([repo, fs.realpathSync(repo)])]
  const bases = [...new Set([cwd, fs.realpathSync(cwd)])]
  const own = (section) => {
    if (section.startsWith('walnut-ws:')) return true
    if (/^[\w-]+:/.test(section)) return false
    return bases.some((base) => repos.some((r) => /^src\//.test(path.relative(r, path.resolve(base, section)))))
  }
  const name = (section) => {
    if (/^[\w-]+:/.test(section)) return section
    const rel = path.relative(repo, path.resolve(cwd, section))
    return rel.startsWith('..') ? path.resolve(cwd, section) : rel
  }
  const found = new Set()
  let section = null
  for (const line of js.split('\n')) {
    const head = SECTION.exec(line)
    if (head) { section = head[1]; continue }
    if (!line.includes(BUNDLE_URL) || line.includes(`var ${BUNDLE_URL} = `)) continue
    if (!section) found.add('(code before the first file)')
    else if (!own(section)) found.add(name(section))
  }
  return [...found]
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Build cli-fast in memory; returns its files by name. Throws on any build error.
 * `entry` and `fromDisk` exist for the tests' fixture builds.
 */
export async function bundleCliFast({ repo = root, entry = CLI_FAST_ENTRY, fromDisk = CLI_FAST_FROM_DISK } = {}) {
  if (typeof Bun === 'undefined') throw new Error('build-cli-fast: run this with bun')
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  checkFromDisk(repo, pkg, fromDisk)
  const result = await Bun.build({
    entrypoints: [path.join(repo, entry)],
    target: 'bun',
    format: 'cjs',
    // The names CLI_FAST_FILES lists, whatever the entry is called (the tests build fixtures).
    naming: { entry: 'cli-fast.[ext]' },
    // Bytecode for each module's top-level code only, as build-binary.mjs does;
    // deeper functions compile from source when first called. Measured against
    // full depth: the same start (`--version` ~160 ms either way, `tools call`
    // within noise), a .jsc of 5 MB instead of 37 MB, a build of 1.5 s, not 10 s.
    bytecode: true,
    bytecodeDepth: 0,
    sourcemap: 'linked',
    banner: BANNER,
    define: { __WALNUT_VERSION__: JSON.stringify(pkg.version), 'import.meta.url': BUNDLE_URL },
    external: [...BUNDLE_EXTERNAL, ...fromDisk],
    plugins: [{
      name: 'ws-on-bun',
      setup(build) {
        build.onResolve({ filter: /^#ws$/ }, () => ({ path: 'ws', namespace: 'walnut-ws' }))
        build.onLoad({ filter: /.*/, namespace: 'walnut-ws' }, () => ({ contents: WS_ON_BUN, loader: 'js' }))
      },
    }],
    throw: false,
  })
  if (!result.success) throw new Error(`build-cli-fast: bun build failed:\n${result.logs.map(String).join('\n')}`)
  const files = new Map()
  for (const out of result.outputs) files.set(path.basename(out.path), Buffer.from(await out.arrayBuffer()))
  const missing = CLI_FAST_FILES.filter((name) => !files.get(name)?.length)
  if (missing.length) throw new Error(`build-cli-fast: bun wrote no ${missing.join(', ')}`)
  const js = files.get('cli-fast.js').toString('utf8')
  if (!js.startsWith(CLI_FAST_PRAGMA)) throw new Error(`build-cli-fast: cli-fast.js does not start with "${CLI_FAST_PRAGMA}", so bun would not load its bytecode`)
  // A path of this machine exists on no other one: the checkout, where its modules
  // really are (a deploy clone links each to the checkout's), the builder's home.
  const roots = [repo, fs.realpathSync(repo), ...moduleRoots(repo).map((r) => r.real), os.homedir()]
  const baked = buildPathsIn(files.get('cli-fast.js'), roots)
  if (baked.size > 0) {
    throw new Error(`build-cli-fast: cli-fast.js carries paths of the build machine; load the dependency that names them from disk (CLI_FAST_FROM_DISK):\n${[...baked.keys()].map((p) => `  ${p}`).join('\n')}`)
  }
  const foreign = foreignBundleUrlReaders(js, { repo })
  if (foreign.length > 0) {
    throw new Error(`build-cli-fast: these bundled files read import.meta.url, which in cli-fast.js is the bundle's own URL, so they would look for their files in dist/; load their package from disk (CLI_FAST_FROM_DISK):\n${foreign.map((f) => `  ${f}`).join('\n')}`)
  }
  return files
}

/** A killed build's staging dir (`cli-fast.<pid>.tmp`, ~70 MB): a package or a publish would carry it. */
function removeDeadStages(outDir) {
  for (const name of fs.readdirSync(outDir)) {
    const m = /^cli-fast\.(\d+)\.tmp$/.exec(name)
    if (!m || Number(m[1]) === process.pid) continue
    try {
      process.kill(Number(m[1]), 0)
    } catch (err) {
      if (err?.code === 'ESRCH') fs.rmSync(path.join(outDir, name), { recursive: true, force: true })
    }
  }
}

/**
 * Put the built files into `outDir`. They are written to a staging dir inside it
 * and `probe` runs the staged entry there (beside the same node_modules, its
 * bytecode beside it); then each is renamed into place, the old .jsc removed
 * first and the new one placed last (see header). A failed write or probe leaves
 * the old files. Returns what the probe said.
 */
export function installCliFast(files, outDir, { probe = probeCliFast, stageName = `cli-fast.${process.pid}.tmp` } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  removeDeadStages(outDir)
  const [js, jsc, map] = CLI_FAST_FILES
  const stage = path.join(outDir, stageName)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage)
  try {
    for (const name of CLI_FAST_FILES) fs.writeFileSync(path.join(stage, name), files.get(name))
    const probed = probe ? probe(path.join(stage, js)) : null
    fs.rmSync(path.join(outDir, jsc), { force: true })
    for (const name of [map, js, jsc]) fs.renameSync(path.join(stage, name), path.join(outDir, name))
    return probed
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist'))
  try {
    const t0 = Date.now()
    const probed = installCliFast(await bundleCliFast(), outDir)
    const size = (name) => `${(fs.statSync(path.join(outDir, name)).size / 1024 / 1024).toFixed(1)} MB`
    console.log(`build-cli-fast: ${path.join(outDir, 'cli-fast.js')} (${size('cli-fast.js')}, bytecode ${size('cli-fast.js.jsc')}) in ${Date.now() - t0}ms; it answered ${probed.version}`)
    // Speed only: the same bun just wrote this bytecode, so a miss means a build problem.
    if (!probed.fromBytecode) console.warn('build-cli-fast: warning: the probe ran cli-fast.js from source, not from its bytecode (slow start)')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
