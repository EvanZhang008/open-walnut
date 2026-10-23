#!/usr/bin/env bun
/**
 * Build Walnut as one compiled file per platform (docs/plan/walnut-single-binary.md).
 *
 *   bun scripts/build-binary.mjs                      this machine's target
 *   bun scripts/build-binary.mjs --all                every release target
 *   bun scripts/build-binary.mjs --target linux-x64   one target (repeatable)
 *   --reuse-web        keep an existing dist/web/static instead of rebuilding the web app
 *   --sourcemap        embed a source map (bigger file, readable stacks)
 *
 * Output: dist-bin/walnut-<target>, nothing else (staging is dist/binary-stage/).
 *
 * What goes in the file:
 *  - the code: src/binary/main.ts and everything it imports, bundled and minified;
 *  - one compressed archive (src/binary/asset-archive.ts) of the files Walnut reads
 *    from disk, laid out like an installed package. The file unpacks it once per
 *    build (src/binary/runtime-root.ts), and `import.meta.url` of every module is
 *    defined to point into that tree, so the code's own resolvers find it.
 *
 * What stays out (NOT_IN_FILE): sharp, the embedding runtime
 * (@huggingface/transformers, onnxruntime-*), the macOS audio capture module,
 * node-pty, esbuild, the Claude agent SDK and the Codex binary. Each load site
 * already degrades when its module is missing; the big ones become downloaded
 * components (src/core/components/).
 *
 * `walnut __selftest` checks a built file's own parts without starting a server.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { assertNoBuildPaths, runtimeDirname } from './binary-build-checks.mjs'
import { writeBuildInfo } from './build-info.mjs'

if (typeof Bun === 'undefined') {
  console.error('build-binary: run this with bun (bun scripts/build-binary.mjs)')
  process.exit(1)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { packArchive } = await import(path.join(repo, 'src/binary/asset-archive.ts'))
const { MODULE_PLACEHOLDER, BUNDLED_MODULES } = await import(path.join(repo, 'src/binary/bundled-modules.ts'))

/** Release target to bun compile target. Linux x64 uses the baseline build (no AVX2). */
export const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl-baseline',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
}

/**
 * Never in the file: optional or big (the big ones become downloaded components).
 * Not marked external: with autoloadPackageJson on, a bare external resolves from
 * the CURRENT DIRECTORY's node_modules, so `walnut web` started inside some
 * project would load that project's copy. Each import becomes a module that
 * throws "not installed", which every load site already handles.
 */
export const NOT_IN_FILE = [
  'sharp',
  '@huggingface/transformers',
  'onnxruntime-node',
  'onnxruntime-web',
  'onnxruntime-common',
  'screencapturekit-audio-capture',
  '@homebridge/node-pty-prebuilt-multiarch',
  'esbuild',
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex',
]

/**
 * CommonJS packages that find their own files through `__dirname`. bun bakes
 * the build machine's absolute path in for it, which exists on no other
 * machine (and names the builder's home), so runtimeDirnamePlugin points them
 * at their place in the runtime tree instead, and the files listed here are
 * copied there.
 */
const DIRNAME_PACKAGES = {
  // @anthropic-ai/tokenizer's encoder (token counts): read at its first use.
  tiktoken: ['lite/tiktoken_bg.wasm'],
  // Mail's logger (imapflow): only its transports read files, and Walnut starts none.
  pino: [],
  'thread-stream': [],
}

/** Size budget for one file (docs/plan/walnut-single-binary.md). */
const BUDGET = { raw: 150 * 2 ** 20, gzip: 64 * 2 ** 20 }

function parseArgs(argv) {
  const out = { targets: [], reuseWeb: false, sourcemap: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') out.targets.push(...Object.keys(TARGETS))
    else if (a === '--target') out.targets.push(argv[++i])
    else if (a === '--reuse-web') out.reuseWeb = true
    else if (a === '--sourcemap') out.sourcemap = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (out.targets.length === 0) out.targets.push(`${process.platform}-${process.arch}`)
  for (const t of out.targets) if (!TARGETS[t]) throw new Error(`unknown target ${t} (known: ${Object.keys(TARGETS).join(', ')})`)
  out.targets = [...new Set(out.targets)]
  return out
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })
}

const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`

// ── Inputs the archive needs ────────────────────────────────────────────────

function buildWeb(reuse) {
  const index = path.join(repo, 'dist/web/static/index.html')
  if (reuse && fs.existsSync(index)) return
  const vite = path.join(repo, 'web/node_modules/vite/bin/vite.js')
  if (!fs.existsSync(vite)) throw new Error('web dependencies are missing (web/node_modules/vite): install them first')
  // The native config loader writes no temp file into node_modules; bun runs the TS config itself.
  run(process.execPath, ['--bun', vite, 'build', '--configLoader', 'native'], { cwd: path.join(repo, 'web') })
  if (!fs.existsSync(index)) throw new Error('the web build left no dist/web/static/index.html')
}

/** The two first-party plugins a stock install ships (walnut-time, the plugin store), as `npm run build` makes them. */
function buildShippedPlugins() {
  run(process.execPath, ['scripts/ship-builtin-plugins.mjs'])
  run(process.execPath, ['scripts/ship-store-plugins.mjs'])
}

/** Daemon sidecars, ACP worker and pi-acp (scripts/build-daemon.sh); returns the daemon version. */
function buildDaemonSidecars(outdir) {
  fs.rmSync(outdir, { recursive: true, force: true })
  run('bash', ['scripts/build-daemon.sh'], {
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, WALNUT_DAEMON_SIDECARS_ONLY: '1', WALNUT_DAEMON_OUTDIR: outdir },
  })
  return fs.readFileSync(path.join(outdir, 'daemon.version'), 'utf8').trim()
}

async function bundleTo(outfile, entry, { format = 'esm', target = 'bun', external = [] } = {}) {
  const result = await Bun.build({ entrypoints: [entry], target, format, minify: true, external, throw: false })
  if (!result.success) throw new Error(`bundle ${entry} failed:\n${result.logs.map(String).join('\n')}`)
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  fs.writeFileSync(outfile, await result.outputs[0].text())
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true })
}

/**
 * The runtime tree: what an installed package has on disk, minus the code.
 * Paths mirror dist/ so the resolvers in src/ find them unchanged.
 */
async function stageTree(root, { version, sidecars }) {
  fs.rmSync(root, { recursive: true, force: true })
  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'open-walnut', version, type: 'module', private: true }, null, 2) + '\n')
  // import.meta.url of every bundled module points here; nothing runs it.
  fs.writeFileSync(path.join(dist, 'cli.js'), MODULE_PLACEHOLDER)
  writeBuildInfo(repo, dist)

  copyDir(path.join(repo, 'src/data'), path.join(dist, 'data'))
  copyDir(path.join(repo, 'dist/web/static'), path.join(dist, 'web/static'))
  copyDir(sidecars, path.join(dist, 'daemon-binaries'))
  for (const f of ['daemon.version']) fs.rmSync(path.join(dist, 'daemon-binaries', f), { force: true })

  // Built-in plugins: manifest, icon and skills from disk; their code is in the
  // host bundle (src/integrations/host-modules.ts), so the server entry the
  // manifest names is only a placeholder that keeps the existence check true.
  const integrations = path.join(repo, 'src/integrations')
  for (const id of fs.readdirSync(integrations)) {
    const src = path.join(integrations, id)
    const manifestFile = path.join(src, 'manifest.json')
    if (!fs.existsSync(manifestFile)) continue
    const out = path.join(dist, 'integrations', id)
    fs.mkdirSync(out, { recursive: true })
    fs.copyFileSync(manifestFile, path.join(out, 'manifest.json'))
    if (fs.existsSync(path.join(src, 'icon.svg'))) fs.copyFileSync(path.join(src, 'icon.svg'), path.join(out, 'icon.svg'))
    for (const sub of ['skills', 'agent-skills']) if (fs.existsSync(path.join(src, sub))) copyDir(path.join(src, sub), path.join(out, sub))
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (manifest.server && fs.existsSync(path.join(src, 'index.ts'))) fs.writeFileSync(path.join(out, manifest.server), MODULE_PLACEHOLDER)
  }
  for (const shipped of ['dist/integrations/walnut-time', 'dist/plugin-store']) {
    const from = path.join(repo, shipped)
    if (!fs.existsSync(from)) throw new Error(`${shipped} is missing after the plugin build`)
    copyDir(from, path.join(root, shipped))
  }

  // Dist files the file carries as bundled modules: placeholders on disk.
  for (const rel of Object.keys(BUNDLED_MODULES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), MODULE_PLACEHOLDER)
  }

  // Code that runs from disk, loaded by path rather than imported:
  //  - SQLite for the plugin database worker (src/core/plugins/plugin-storage.ts
  //    requires the driver by path inside a worker thread);
  //  - `diff` for the offline-merge workers (they require it by resolved path);
  //  - the Codex ACP adapter, started as `<file> <its path>` (src/providers/acp-session.ts).
  await bundleTo(path.join(dist, 'lib/sqlite.js'), path.join(repo, 'src/lib/sqlite.ts'))
  // Temporary, like sqliteMapPlugin: plugin-storage.ts still resolves the name
  // 'better-sqlite3' at runtime, so a package of that name hands it src/lib/sqlite.ts.
  const sqliteShim = path.join(root, 'node_modules/better-sqlite3')
  fs.mkdirSync(sqliteShim, { recursive: true })
  fs.writeFileSync(path.join(sqliteShim, 'package.json'), JSON.stringify({ name: 'better-sqlite3', private: true, main: 'index.cjs' }) + '\n')
  fs.writeFileSync(path.join(sqliteShim, 'index.cjs'), "module.exports = require('../../dist/lib/sqlite.js').default\n")
  const diffDir = path.join(root, 'node_modules/diff')
  await bundleTo(path.join(diffDir, 'index.cjs'), path.join(repo, 'node_modules/diff/libcjs/index.js'), { format: 'cjs', target: 'node' })
  fs.writeFileSync(path.join(diffDir, 'package.json'), JSON.stringify({ name: 'diff', version: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/diff/package.json'), 'utf8')).version, main: 'index.cjs' }) + '\n')
  fs.copyFileSync(path.join(repo, 'node_modules/diff/LICENSE'), path.join(diffDir, 'LICENSE'))
  const codexAcp = path.join(repo, 'node_modules/@agentclientprotocol/codex-acp')
  const codexOut = path.join(root, 'node_modules/@agentclientprotocol/codex-acp')
  fs.mkdirSync(path.join(codexOut, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(codexAcp, 'dist/index.js'), path.join(codexOut, 'dist/index.js'))
  for (const f of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(codexAcp, f), path.join(codexOut, f))

  for (const [name, files] of Object.entries(DIRNAME_PACKAGES)) {
    for (const rel of files) {
      const to = path.join(root, 'node_modules', name, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(repo, 'node_modules', name, rel), to)
    }
  }
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

function packTree(root) {
  const entries = listFiles(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    mode: fs.statSync(file).mode & 0o777,
    data: fs.readFileSync(file),
  }))
  return { archive: packArchive(entries), files: entries.length, bytes: entries.reduce((n, e) => n + e.data.length, 0) }
}

// ── The compile ─────────────────────────────────────────────────────────────

/** Temporary: until every module imports src/lib/sqlite.ts, map the bare better-sqlite3 specifier to it. */
function sqliteMapPlugin() {
  const sqliteModule = path.join(repo, 'src/lib/sqlite.ts')
  return {
    name: 'walnut-better-sqlite3-to-lib-sqlite',
    setup(build) {
      build.onResolve({ filter: /^better-sqlite3$/ }, (args) => (args.importer === sqliteModule ? { path: 'better-sqlite3', external: true } : { path: sqliteModule }))
    },
  }
}

/** `__dirname` in DIRNAME_PACKAGES becomes the package's directory in the runtime tree (src/lib/single-file.ts). */
function runtimeDirnamePlugin() {
  const names = Object.keys(DIRNAME_PACKAGES).map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  const filter = new RegExp(`[\\\\/]node_modules[\\\\/](${names.join('|')})[\\\\/].*\\.c?js$`)
  return {
    name: 'walnut-runtime-dirname',
    setup(build) {
      build.onLoad({ filter }, (args) => ({
        loader: 'js',
        contents: runtimeDirname(fs.readFileSync(args.path, 'utf8'), path.relative(repo, path.dirname(args.path)).split(path.sep).join('/')),
      }))
    },
  }
}

/**
 * bun signs a darwin-arm64 file it compiles (ad-hoc, on any host), but a
 * darwin-x64 one keeps the signature of bun's own x64 runtime, which the
 * appended code invalidates (`codesign --verify`: "code or signature have been
 * modified"). Re-sign it ad-hoc, keeping that signature's flags and
 * entitlements (bun's JIT needs allow-jit): codesign on macOS, rcodesign
 * elsewhere (scripts/install-rcodesign.sh; `WALNUT_RCODESIGN` names another).
 */
function signDarwin(target, outfile) {
  if (target !== 'darwin-x64') return
  if (process.platform === 'darwin') {
    run('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags', outfile], { stdio: 'ignore' })
    run('codesign', ['--verify', outfile])
    return
  }
  const rcodesign = process.env.WALNUT_RCODESIGN || 'rcodesign'
  try {
    execFileSync(rcodesign, ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(`walnut-darwin-x64 needs an ad-hoc signature: build it on macOS, or put rcodesign on PATH (sh scripts/install-rcodesign.sh <dir>)`)
  }
  run(rcodesign, ['sign', outfile], { stdio: 'ignore' })
}

function notInFilePlugin(names) {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  const filter = new RegExp(`^(${escaped.join('|')})(/.*)?$`)
  return {
    name: 'walnut-not-in-file',
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'walnut-not-in-file' }))
      build.onLoad({ filter: /.*/, namespace: 'walnut-not-in-file' }, (args) => ({
        loader: 'js',
        contents: `throw Object.assign(new Error(${JSON.stringify(`Cannot find package '${args.path}': it is not part of the compiled walnut file`)}), { code: 'ERR_MODULE_NOT_FOUND' });\n`,
      }))
    },
  }
}

function assetsPlugin({ archivePath, id, daemonVersion }) {
  return {
    name: 'walnut-binary-assets',
    setup(build) {
      build.onResolve({ filter: /^walnut-binary:assets$/ }, () => ({ path: 'assets', namespace: 'walnut-binary' }))
      build.onLoad({ filter: /.*/, namespace: 'walnut-binary' }, () => ({
        loader: 'js',
        contents: [
          `import archive from ${JSON.stringify(archivePath)} with { type: "file" };`,
          'export const ASSETS_ARCHIVE = archive;',
          `export const ASSETS_ID = ${JSON.stringify(id)};`,
          `export const DAEMON_VERSION = ${JSON.stringify(daemonVersion)};`,
        ].join('\n'),
      }))
    },
  }
}

function buildOptions({ version, archivePath, id, daemonVersion, sourcemap }) {
  return {
    entrypoints: [path.join(repo, 'src/binary/main.ts')],
    // Whitespace and syntax only: getDaemonSource() ships core functions as their
    // own text (fn.toString()), and mangled names would break that text.
    minify: { whitespace: true, syntax: true, identifiers: false },
    sourcemap: sourcemap ? 'inline' : 'none',
    define: {
      __WALNUT_VERSION__: JSON.stringify(version),
      'import.meta.url': 'globalThis.__WALNUT_BUNDLE_URL__',
      'process.env.DAEMON_VERSION': JSON.stringify(daemonVersion),
    },
    plugins: [sqliteMapPlugin(), notInFilePlugin(NOT_IN_FILE), runtimeDirnamePlugin(), assetsPlugin({ archivePath, id, daemonVersion })],
    throw: false,
  }
}

async function compile(target, outfile, options, stage) {
  // Compiled as `walnut` so the virtual entry is /$bunfs/root/walnut whatever the
  // file is called later (src/core/sessions/profiles.ts accepts that name).
  const dir = fs.mkdtempSync(path.join(stage, 'compile-'))
  try {
    const tmp = path.join(dir, 'walnut')
    const result = await Bun.build({
      ...options,
      compile: {
        target: TARGETS[target],
        outfile: tmp,
        // A .env or bunfig.toml in the user's working directory must never configure Walnut.
        autoloadDotenv: false,
        autoloadBunfig: false,
        // Components (onnxruntime-node, sharp) resolve their own bare imports from disk.
        autoloadPackageJson: true,
      },
    })
    if (!result.success) throw new Error(`compile ${target} failed:\n${result.logs.map(String).join('\n')}`)
    fs.renameSync(tmp, outfile)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The bun runtime alone for a target: a compiled one-liner. Cached per target and bun version. */
async function runtimeSize(target, stage) {
  const cache = path.join(stage, `runtime-${TARGETS[target]}-${Bun.version}.size`)
  if (fs.existsSync(cache)) return Number(fs.readFileSync(cache, 'utf8'))
  const entry = path.join(stage, 'hello.js')
  fs.writeFileSync(entry, 'console.log(1)\n')
  const out = path.join(stage, `hello-${target}`)
  const r = await Bun.build({ entrypoints: [entry], compile: { target: TARGETS[target], outfile: out }, throw: false })
  if (!r.success) return NaN
  const size = fs.statSync(out).size
  fs.rmSync(out, { force: true })
  fs.writeFileSync(cache, String(size))
  return size
}

/** The bundled code without the runtime, with its biggest inputs. */
async function codeReport(options) {
  const result = await Bun.build({ ...options, target: 'bun', metafile: true })
  if (!result.success) return null
  const js = result.outputs.find((o) => o.kind === 'entry-point')
  const byPackage = new Map()
  const output = Object.values(result.metafile?.outputs ?? {})[0]
  for (const [file, info] of Object.entries(output?.inputs ?? {})) {
    const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
    const key = m ? m[1] : file.startsWith('src/') ? file.split('/').slice(0, 2).join('/') : file.split('/')[0]
    byPackage.set(key, (byPackage.get(key) ?? 0) + (info.bytesInOutput ?? 0))
  }
  return { bytes: js?.size ?? 0, top: [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 12) }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  const stage = path.join(repo, 'dist/binary-stage')
  const outDir = path.join(repo, 'dist-bin')
  fs.mkdirSync(stage, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })

  const t0 = Date.now()
  buildWeb(opts.reuseWeb)
  buildShippedPlugins()
  const daemonVersion = buildDaemonSidecars(path.join(stage, 'sidecars'))
  const root = path.join(stage, 'root')
  await stageTree(root, { version, sidecars: path.join(stage, 'sidecars') })
  const packed = packTree(root)
  const hash = crypto.createHash('sha256').update(packed.archive).digest('hex').slice(0, 12)
  const id = `${version}-${hash}`
  const archivePath = path.join(stage, 'assets.wna')
  fs.writeFileSync(archivePath, packed.archive)
  console.log(`build-binary: ${packed.files} files, ${mb(packed.bytes)} unpacked, ${mb(packed.archive.length)} archived (${id}); daemon ${daemonVersion}`)

  const options = buildOptions({ version, archivePath, id, daemonVersion, sourcemap: opts.sourcemap })
  const code = await codeReport(options)
  const rows = []
  for (const target of opts.targets) {
    const outfile = path.join(outDir, `walnut-${target}`)
    await compile(target, outfile, options, stage)
    assertNoBuildPaths(outfile, [repo, os.homedir()])
    signDarwin(target, outfile)
    const raw = fs.statSync(outfile).size
    const gzip = zlib.gzipSync(fs.readFileSync(outfile), { level: 6 }).length
    rows.push({ target, raw, gzip, runtime: await runtimeSize(target, stage) })
  }

  console.log('\nbuild-binary: sizes')
  for (const r of rows) {
    const over = r.raw > BUDGET.raw || r.gzip > BUDGET.gzip ? '  OVER BUDGET' : ''
    console.log(`  walnut-${r.target.padEnd(17)} ${mb(r.raw).padStart(9)}  gzip ${mb(r.gzip).padStart(8)}   (bun runtime ${mb(r.runtime)}, code ${mb(code?.bytes ?? 0)}, assets ${mb(packed.archive.length)})${over}`)
  }
  if (code) {
    console.log('  biggest code inputs (bytes in output):')
    for (const [k, v] of code.top) console.log(`    ${mb(v).padStart(8)}  ${k}`)
  }
  fs.writeFileSync(path.join(stage, 'sizes.json'), JSON.stringify({ id, daemonVersion, assets: { files: packed.files, unpacked: packed.bytes, archived: packed.archive.length }, code, rows }, null, 2) + '\n')
  console.log(`\nbuild-binary: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

if (import.meta.main) await main()
