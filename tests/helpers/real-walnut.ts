/**
 * The real compiled Walnut (scripts/build-binary.mjs) of this checkout, at the
 * versions a test asks for. Built in a clone of HEAD with this tree's
 * uncommitted changes applied, so neither the version stamp nor the build's
 * output touches the checkout, and cached by content (the tree outside tests/
 * and docs/, the target, bun's version): only a change builds again. Needs bun:
 * `$BUN`, else `bun` on PATH.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const BUILD_TIMEOUT_MS = 20 * 60_000
/** Kept across runs (tests/setup/tmp-reaper.ts never reaps it); the newest few trees only. */
export const CACHE_DIR_NAME = 'walnut-real-file'
const CACHE_KEEP = 3

export function bunPath(): string {
  const bun = process.env.BUN || 'bun'
  const r = spawnSync(bun, ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`these tests build the compiled Walnut with bun: set BUN or put bun on PATH (${bun}: ${r.error?.message ?? r.stderr})`)
  return bun
}

/** The host's target in the release's words. */
export function hostTarget(): string {
  return `${process.platform}-${process.arch}`
}

const git = (args: string[], cwd = ROOT, input?: Buffer): Buffer => execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30 })

/** What the file is not built from: a change there (a test being written) builds nothing again. */
const NOT_BUILT_FROM = [':(exclude)tests', ':(exclude)docs']

/** HEAD, the tree's changes against it, and its untracked files that git does not ignore. */
function treeState(): { head: string; diff: Buffer; built: Buffer; untracked: string[] } {
  return {
    head: git(['rev-parse', 'HEAD']).toString().trim(),
    diff: git(['diff', 'HEAD', '--binary']),
    built: git(['diff', 'HEAD', '--binary', '--', '.', ...NOT_BUILT_FROM]),
    untracked: git(['ls-files', '-o', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean),
  }
}

/** Run `cmd` to its end without holding the event loop (a build takes minutes); rejects with its output's tail. */
function runAsync(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = ''
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-8000) }
    child.stdout!.on('data', keep)
    child.stderr!.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), BUILD_TIMEOUT_MS)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${what} failed (${code ?? signal}):\n${out.slice(-4000)}`))
    })
  })
}

/** Drop all but the newest CACHE_KEEP trees' files. */
function pruneCache(root: string): void {
  const entries = fs.readdirSync(root).map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs })).sort((a, b) => b.at - a.at)
  for (const { name } of entries.slice(CACHE_KEEP)) fs.rmSync(path.join(root, name), { recursive: true, force: true })
}

/** The compiled file of this tree at each of `versions`, by version: `<cache>/walnut-<version>-<target>`. */
export async function realWalnutFiles(versions: string[], target = hostTarget()): Promise<Record<string, string>> {
  const bun = bunPath()
  const state = treeState()
  const key = crypto.createHash('sha256').update(state.head).update(state.built)
  for (const f of state.untracked) {
    if (/^(tests|docs)\//.test(f)) continue
    const st = fs.lstatSync(path.join(ROOT, f))
    key.update(f).update(st.isSymbolicLink() ? fs.readlinkSync(path.join(ROOT, f)) : fs.readFileSync(path.join(ROOT, f)))
  }
  key.update(target).update(execFileSync(bun, ['--version'], { encoding: 'utf8' }))
  const cacheRoot = path.join(os.tmpdir(), CACHE_DIR_NAME)
  const cache = path.join(cacheRoot, key.digest('hex').slice(0, 16))
  const files = Object.fromEntries(versions.map((v) => [v, path.join(cache, `walnut-${v}-${target}`)]))
  const missing = versions.filter((v) => !fs.existsSync(files[v]!))
  if (missing.length === 0) {
    const now = new Date()
    fs.utimesSync(cache, now, now)
    return files
  }

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-'))
  try {
    git(['clone', '-q', '--shared', '--no-checkout', ROOT, clone])
    git(['checkout', '-q', '--detach', state.head], clone)
    if (state.diff.length) git(['apply', '--whitespace=nowarn'], clone, state.diff)
    for (const f of state.untracked) {
      fs.mkdirSync(path.dirname(path.join(clone, f)), { recursive: true })
      fs.cpSync(path.join(ROOT, f), path.join(clone, f), { verbatimSymlinks: true })
    }
    // The checkout's installed dependencies, read only: the build writes into the clone.
    for (const dir of ['node_modules', 'web/node_modules']) {
      if (fs.existsSync(path.join(ROOT, dir))) fs.symlinkSync(fs.realpathSync(path.join(ROOT, dir)), path.join(clone, dir))
    }
    fs.mkdirSync(cache, { recursive: true })
    for (const [i, version] of missing.entries()) {
      const pkgFile = path.join(clone, 'package.json')
      fs.writeFileSync(pkgFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')), version }, null, 2)}\n`)
      // The web app does not change with the version: the second build keeps the first's.
      await runAsync(bun, ['scripts/build-binary.mjs', '--target', target, ...(i > 0 ? ['--reuse-web'] : [])], clone,
        { ...process.env, WALNUT_VERSION_STAMPED: '1' }, `build-binary ${target} at ${version}`)
      const tmp = `${files[version]!}.${process.pid}`
      fs.copyFileSync(path.join(clone, 'dist-bin', `walnut-${target}`), tmp)
      fs.chmodSync(tmp, 0o755)
      fs.renameSync(tmp, files[version]!)
    }
  } finally {
    fs.rmSync(clone, { recursive: true, force: true })
  }
  pruneCache(cacheRoot)
  return files
}
