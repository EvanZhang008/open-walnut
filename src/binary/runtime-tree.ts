/**
 * The unpacked runtime tree of the compiled Walnut file: where it lives, how a
 * build's archive becomes that tree exactly once, and how old builds' trees go.
 * src/binary/runtime-root.ts calls this at startup; the functions take their
 * inputs as arguments so tests can run them without a compiled file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unpackArchive } from './asset-archive.js'
import { isServiceSetRuntimeTreesDir } from '../providers/service-set.js'

/** Written last into an unpacked tree; its content is the build's id. */
export const RUNTIME_MARKER = '.walnut-runtime'
/**
 * Written just before the marker: the tree's top-level entries and its outermost node_modules
 * folders, one per line. A tree whose marker is there but one of these is gone (a cleaner took
 * node_modules for build output: 2026-11-10, a Demo's file died at boot, 'Missing
 * tiktoken_bg.wasm') is unpacked again. A tree an older build wrote has no list and is trusted as before.
 */
export const RUNTIME_FILES = '.walnut-runtime-files'
/** Unpacked trees of other builds kept beside this one (a server of the previous build may still run). */
const KEEP_OTHER_BUILDS = 2
/** A staging dir this old belongs to an unpack that died. */
const STALE_PARTIAL_MS = 60 * 60_000

/** Set by a boot proof's trial (daemon-boot-proof.ts): its tree ranks last and it prunes nothing. */
export const RUNTIME_TRIAL_ENV = 'WALNUT_RUNTIME_TRIAL'

/** The env keys that decide where a build's tree goes (runtimeRootsFor). */
export const RUNTIME_PLACE_ENV = ['WALNUT_RUNTIME_DIR', 'OPEN_WALNUT_HOME'] as const

/** The temp dir a leader's `walnut ... --walnut <id>` lines unpack into (isWalnutLineArgv): theirs alone. */
export function walnutLineRuntimeDir(): string {
  return path.join(os.tmpdir(), `open-walnut-line-runtime-${os.userInfo().uid}`)
}

/**
 * Where a run of the file with this env looks for build `id`'s tree, in order:
 * WALNUT_RUNTIME_DIR's tree alone when set, else for a leader's `--walnut` line the temp dir
 * those lines share, else the data home's, then the temp dir's (a data home that is not
 * writable). Reads only RUNTIME_PLACE_ENV.
 */
export function runtimeRootsFor(env: NodeJS.ProcessEnv, id: string, o: { walnutLine?: boolean } = {}): string[] {
  const override = env.WALNUT_RUNTIME_DIR
  if (override) return [path.join(path.resolve(override), id)]
  if (o.walnutLine) return [path.join(walnutLineRuntimeDir(), id)]
  const home = env.OPEN_WALNUT_HOME || path.join(os.homedir(), '.open-walnut')
  return [path.join(home, 'local', 'runtime', id), path.join(os.tmpdir(), `open-walnut-runtime-${os.userInfo().uid}`, id)]
}

/** True when `root` holds build `id`'s whole tree (its marker is written last, and what RUNTIME_FILES names is still there). */
export function isComplete(root: string, id: string): boolean {
  try {
    if (fs.readFileSync(path.join(root, RUNTIME_MARKER), 'utf8').trim() !== id) return false
  } catch {
    return false
  }
  let listed: string[]
  try {
    listed = fs.readFileSync(path.join(root, RUNTIME_FILES), 'utf8').split('\n').filter(Boolean)
  } catch {
    return true
  }
  return listed.every((rel) => fs.existsSync(path.join(root, rel)))
}

/** The entries RUNTIME_FILES lists for these archive paths: every top-level name and every outermost node_modules folder. */
export function runtimeFileList(paths: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    out.add(parts[0]!)
    const nm = parts.indexOf('node_modules')
    if (nm > 0 && nm < parts.length - 1) out.add(parts.slice(0, nm + 1).join('/'))
  }
  return [...out].sort()
}

/** Unpack `archive` into `root` through a staging dir and one rename, so no reader sees half a tree. */
export function unpackRuntime(root: string, archive: Buffer, id: string): void {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
  const staging = `${root}.partial-${process.pid}-${Date.now()}`
  try {
    const paths: string[] = []
    for (const entry of unpackArchive(archive)) {
      const target = path.join(staging, entry.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.data, { mode: entry.mode })
      paths.push(entry.path)
    }
    fs.writeFileSync(path.join(staging, RUNTIME_FILES), runtimeFileList(paths).map((p) => `${p}\n`).join(''))
    fs.writeFileSync(path.join(staging, RUNTIME_MARKER), `${id}\n`)
    try {
      fs.renameSync(staging, root)
    } catch {
      // Another process unpacked this build first: theirs is the same bytes.
      if (isComplete(root, id)) return
      // A tree without the marker is a leftover of a broken unpack, and one missing a listed
      // entry lost files to a cleaner: replace it.
      fs.rmSync(root, { recursive: true, force: true })
      fs.renameSync(staging, root)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * In a runtime place, the build its service runs (a `--service` start writes it, ensureRuntime):
 * never pruned, however many other builds start after it. One service per place: the default
 * set's in the data home, a set's in its own dir.
 */
export const RUNTIME_SERVICE_BUILD = '.walnut-runtime-service'

/**
 * Remove other builds' trees past the newest KEEP_OTHER_BUILDS (by marker mtime, which every start
 * of a build refreshes), and dead staging dirs; never the build RUNTIME_SERVICE_BUILD names. Never throws.
 */
export function pruneRuntimes(parent: string, keepId: string, now = Date.now()): void {
  try {
    let serviceBuild = ''
    try { serviceBuild = fs.readFileSync(path.join(parent, RUNTIME_SERVICE_BUILD), 'utf8').trim() } catch { /* no service here */ }
    const others: Array<{ dir: string; mtime: number }> = []
    for (const name of fs.readdirSync(parent)) {
      const dir = path.join(parent, name)
      if (name === keepId || name === serviceBuild) continue
      try {
        if (name.includes('.partial-')) {
          if (now - fs.statSync(dir).mtimeMs > STALE_PARTIAL_MS) fs.rmSync(dir, { recursive: true, force: true })
          continue
        }
        // Only trees this code unpacked: they carry the marker naming their own dir.
        const marker = path.join(dir, RUNTIME_MARKER)
        if (fs.readFileSync(marker, 'utf8').trim() !== name) continue
        others.push({ dir, mtime: fs.statSync(marker).mtimeMs })
      } catch { /* not ours, or already gone */ }
    }
    others.sort((a, b) => b.mtime - a.mtime)
    for (const { dir } of others.slice(KEEP_OTHER_BUILDS)) fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* hygiene only */ }
}

/**
 * Whether a start with this env prunes other builds' trees beside its own: in the data home's (or
 * the temp) dir, and in a service set's own dir (`<set install root>/runtime`, service-set.ts
 * serviceSetEnv), whose one owner is that set's service. Never in another WALNUT_RUNTIME_DIR.
 */
export function prunesRuntimePlace(env: NodeJS.ProcessEnv): boolean {
  const override = env.WALNUT_RUNTIME_DIR
  return !override || isServiceSetRuntimeTreesDir(override, { HOME: env.HOME || os.homedir(), WALNUT_SERVICE_SET: env.WALNUT_SERVICE_SET }, fs.realpathSync)
}

/**
 * A run that may be another Walnut's than this data home's: the on-host CLI (`<file> walnut ...`,
 * `wn` the old alias) on a line that names a Walnut (`--walnut <id>`, the experiment
 * host_service_sets: a leader's `walnut daemon ...` line for its own service set). Which set the
 * line acts on the host decides later, so it keeps out of the data home: its tree goes to the temp
 * dir only such lines use (walnutLineRuntimeDir), never beside the default Walnut's trees, whose
 * prune it would otherwise push them out of by mtime. `argv` is process.argv.
 */
export function isWalnutLineArgv(argv: readonly string[], execPath: string): boolean {
  const at = firstWordAt(argv, execPath)
  return (argv[at] === 'walnut' || argv[at] === 'wn') && argv.includes('--walnut')
}

/** The launcher's `--service` start (main.ts, `__daemon --service` too): the host's service for this place. */
export function isServiceArgv(argv: readonly string[], execPath: string): boolean {
  const at = firstWordAt(argv, execPath)
  return argv[at] === '--service' || (argv[at] === '__daemon' && argv[at + 1] === '--service')
}

/** Where the file's own words start in process.argv: after the program, and its own path when bun repeats it. */
function firstWordAt(argv: readonly string[], execPath: string): number {
  const at = 2
  return argv[at] !== undefined && (argv[at] === argv[1] || argv[at] === execPath) ? at + 1 : at
}

/**
 * Make sure this build's tree exists; returns its root. Falls back to the temp dir when the data home is not writable.
 *
 * WALNUT_RUNTIME_DIR names the PARENT of the per-build trees, never one tree: a
 * production deploy keeps its server's tree inside its stage dir (scripts/dev-prod.sh),
 * and every child the server starts inherits the variable. A different build
 * started from one of those children (another compiled file run from a session)
 * then unpacks beside it, instead of replacing the tree a running server serves
 * its web app from. Nothing is pruned there: the dir's owner removes it whole.
 * A service set's own dir is the exception (prunesRuntimePlace). A leader's `--walnut` line
 * (`walnutLine`, runtime-root.ts) unpacks into, and prunes, the temp dir only such lines use.
 * A `--service` start (`service`) names its build the place's RUNTIME_SERVICE_BUILD; a boot
 * proof's trial (RUNTIME_TRIAL_ENV) prunes nothing, names nothing and ranks its tree last.
 */
export function ensureRuntime(archivePath: string, id: string, o: { walnutLine?: boolean; service?: boolean } = {}): string {
  const trial = process.env[RUNTIME_TRIAL_ENV] === '1'
  const prune = !trial && prunesRuntimePlace(process.env)
  const roots = runtimeRootsFor(process.env, id, o)
  // In use from here on: the prune ranks by this mtime. A trial's tree ranks last until its
  // build really starts, so a failed trial never pushes the running build's tree out.
  const inUse = (root: string) => {
    const t = trial ? new Date(0) : new Date()
    try { fs.utimesSync(path.join(root, RUNTIME_MARKER), t, t) } catch { /* read-only place */ }
    if (o.service && !trial) try { fs.writeFileSync(path.join(path.dirname(root), RUNTIME_SERVICE_BUILD), `${id}\n`) } catch { /* read-only place */ }
    return root
  }
  let lastError: unknown = null
  for (const root of roots) {
    if (isComplete(root, id)) return trial ? root : inUse(root)
    try {
      unpackRuntime(root, fs.readFileSync(archivePath), id)
      inUse(root)
      if (prune) pruneRuntimes(path.dirname(root), id)
      return root
    } catch (err) {
      lastError = err
    }
  }
  process.stderr.write(`walnut: could not unpack its files (${lastError instanceof Error ? lastError.message : String(lastError)}); the web app and bundled data are unavailable\n`)
  return roots[0]!
}

