/**
 * Building the walnut file for a host from this server's checkout
 * (host-file.ts says when). Never in the checkout itself: build-binary.mjs
 * rebuilds dist/web/static, the shipped plugins and dist-bin/ where it runs,
 * and this checkout's dist is the one the running server serves (a deploy that
 * wiped its assets is a known outage), while its working tree may hold other
 * people's unfinished changes. So the build runs in a clone of the commit the
 * running dist was built from, the way scripts/deploy-committed.sh deploys:
 *
 *   git clone --shared --no-checkout <checkout> <work>/tree; checkout <commit>
 *   a dist built from uncommitted changes: the checkout's changes against that
 *     commit and its untracked files are applied too (the closest copy of what
 *     the dist was built from)
 *   node_modules: every entry linked to the checkout's, except the workspace
 *     packages, which are the clone's own (as deploy-committed.sh links them)
 *   dist/web/static: a copy of the running server's, so the file serves the same
 *     web app and the web build is skipped (--reuse-web)
 *   bun scripts/build-binary.mjs --target <t>   in the utility QoS band, output to a log
 *
 * Every step is a child process with a deadline: nothing here holds the event loop.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitChildEnv } from '../../lib/git-env.js'
import { withUtilityQosClamp } from '../../lib/background-qos.js'
import type { HostFileTarget } from './host-target.js'

export interface CloneBuild {
  /** The git checkout this server's dist was built in. */
  checkout: string
  /** The running dist: its web/static goes into the file. */
  distDir: string
  commit: string
  /** The dist was built from uncommitted changes: apply the checkout's own on top of the commit. */
  dirty: boolean
  target: HostFileTarget
  /** An empty dir to build in; the caller removes it. */
  work: string
  /** The build's output (appended). */
  log: string
  bun: string
  timeoutMs?: number
}

const STEP_MS = 120_000
const BUILD_MS = 15 * 60_000

interface Ran { code: number | null; stdout: Buffer; stderr: string }

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number; logFd?: number }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const stdio: Array<'pipe' | 'ignore' | number> = [opts.input ? 'pipe' : 'ignore', opts.logFd ?? 'pipe', opts.logFd ?? 'pipe']
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? gitChildEnv(), stdio })
    const out: Buffer[] = []
    let err = ''
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-4000) })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, opts.timeoutMs ?? STEP_MS)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }) })
    if (opts.input) child.stdin!.end(opts.input)
  })
}

async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const r = await run('git', args, { cwd, ...(input ? { input } : {}) })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`)
  return r.stdout
}

/** The workspace packages of the clone (package.json `workspaces`), by name. */
async function workspaces(tree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const pkg = JSON.parse(await fs.promises.readFile(path.join(tree, 'package.json'), 'utf8')) as { workspaces?: unknown }
  for (const dir of Array.isArray(pkg.workspaces) ? pkg.workspaces : []) {
    if (typeof dir !== 'string') continue
    try {
      const name = (JSON.parse(await fs.promises.readFile(path.join(tree, dir, 'package.json'), 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string') out.set(name, path.join(tree, dir))
    } catch { /* a workspace that is not in this commit */ }
  }
  return out
}

/** node_modules of the clone: links to the checkout's entries, the workspace packages to the clone's own. */
export async function linkDependencies(checkout: string, tree: string): Promise<void> {
  const src = path.join(checkout, 'node_modules')
  const dst = path.join(tree, 'node_modules')
  const ws = await workspaces(tree)
  const scopes = new Set([...ws.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]!))
  // A node_modules already there (a link to the checkout's) would get these links written into the checkout.
  if (await fs.promises.lstat(dst).then(() => true, () => false)) throw new Error(`${dst} already exists`)
  await fs.promises.mkdir(dst)
  for (const entry of await fs.promises.readdir(src)) {
    if (!scopes.has(entry)) { await fs.promises.symlink(path.join(src, entry), path.join(dst, entry)); continue }
    await fs.promises.mkdir(path.join(dst, entry), { recursive: true })
    for (const child of await fs.promises.readdir(path.join(src, entry))) {
      const name = `${entry}/${child}`
      await fs.promises.symlink(ws.get(name) ?? path.join(src, entry, child), path.join(dst, entry, child))
    }
  }
  for (const [name, dir] of ws) {
    const link = path.join(dst, name)
    if (!fs.existsSync(link)) { await fs.promises.mkdir(path.dirname(link), { recursive: true }); await fs.promises.symlink(dir, link) }
  }
  const webModules = path.join(checkout, 'web', 'node_modules')
  if (fs.existsSync(webModules) && fs.existsSync(path.join(tree, 'web'))) await fs.promises.symlink(webModules, path.join(tree, 'web', 'node_modules'))
}

/** The checkout's changes against `commit` and its untracked files, laid onto the clone. */
async function applyWorkingTree(checkout: string, tree: string, commit: string): Promise<void> {
  const diff = await git(checkout, ['diff', '--binary', commit, '--'])
  if (diff.length > 0) await git(tree, ['apply', '--binary', '--whitespace=nowarn', '-'], diff)
  // Never dependencies or build output: the clone links its own, and a build writes its own.
  const untracked = (await git(checkout, ['ls-files', '-o', '--exclude-standard', '-z'])).toString().split('\0')
    .filter((rel) => rel && !/(^|\/)node_modules(\/|$)/.test(rel) && !/^dist(-bin)?(\/|$)/.test(rel))
  for (const rel of untracked) {
    const from = path.join(checkout, rel)
    const to = path.join(tree, rel)
    try {
      const st = await fs.promises.lstat(from)
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      if (st.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(from), to)
      else if (st.isFile()) await fs.promises.copyFile(from, to)
    } catch { /* gone since git listed it */ }
  }
}

/** Build the file in a clone; returns its path (inside `work`). */
export async function buildFileInClone(b: CloneBuild): Promise<string> {
  const tree = path.join(b.work, 'tree')
  await git(b.work, ['clone', '--quiet', '--shared', '--no-checkout', b.checkout, tree])
  await git(tree, ['checkout', '--quiet', '--detach', b.commit])
  if (b.dirty) await applyWorkingTree(b.checkout, tree, b.commit)
  await linkDependencies(b.checkout, tree)
  const args = ['scripts/build-binary.mjs', '--target', b.target]
  const statics = path.join(b.distDir, 'web', 'static')
  if (fs.existsSync(path.join(statics, 'index.html'))) {
    await fs.promises.cp(statics, path.join(tree, 'dist', 'web', 'static'), { recursive: true, dereference: true })
    args.push('--reuse-web')
  }
  const log = await fs.promises.open(b.log, 'a')
  try {
    await log.write(`${new Date().toISOString()} building the walnut file for ${b.target} from ${b.commit}${b.dirty ? ' and the checkout\'s changes' : ''}\n`)
    const env = gitChildEnv({ PATH: `${path.dirname(b.bun)}${path.delimiter}${process.env.PATH ?? ''}` })
    const [cmd, cmdArgs] = withUtilityQosClamp(b.bun, args)
    const r = await run(cmd, cmdArgs, { cwd: tree, env, timeoutMs: b.timeoutMs ?? BUILD_MS, logFd: log.fd })
    if (r.code !== 0) {
      const tail = (await fs.promises.readFile(b.log, 'utf8').catch(() => '')).trim().split('\n').slice(-3).join(' ')
      throw new Error(`building the walnut file for ${b.target} failed (${r.code === null ? 'it took too long' : `exit ${r.code}`}): ${tail.slice(-300)}; the whole log is ${b.log}`)
    }
  } finally {
    await log.close()
  }
  const file = path.join(tree, 'dist-bin', `walnut-${b.target}`)
  if (!fs.existsSync(file)) throw new Error(`the build left no dist-bin/walnut-${b.target}; see ${b.log}`)
  return file
}

/** `bun@1.4.4` (package.json packageManager) as `1.4.4`, or null. */
export function pinnedBun(packageJson: string): string | null {
  try {
    const pm = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager
    const m = typeof pm === 'string' ? /^bun@(\d+\.\d+\.\d+)/.exec(pm) : null
    return m ? m[1]! : null
  } catch {
    return null
  }
}

function newerOrSame(v: string, min: string): boolean {
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

export type BunPick = { path: string; version: string } | { why: string }

/**
 * A bun on this computer to build with: $WALNUT_BUN, the one running this
 * process, PATH, then the usual install places, the first of `min` or newer
 * (the file carries the runtime of the bun that built it, so an older one would
 * ship an older runtime than the code was written for).
 */
export async function findBun(
  env: NodeJS.ProcessEnv = process.env,
  min: string | null = null,
  places: string[] = [path.join(os.homedir(), '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'],
  self: string | null = process.versions.bun && path.basename(process.execPath).startsWith('bun') ? process.execPath : null,
): Promise<BunPick> {
  const candidates: string[] = []
  if (env.WALNUT_BUN && path.isAbsolute(env.WALNUT_BUN)) candidates.push(env.WALNUT_BUN)
  if (self) candidates.push(self)
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'bun'))
  candidates.push(...places)
  const older: string[] = []
  for (const c of [...new Set(candidates)]) {
    try { await fs.promises.access(c, fs.constants.X_OK) } catch { continue }
    const r = await run(c, ['--version'], { cwd: os.tmpdir(), env: { PATH: env.PATH ?? '', HOME: os.homedir() }, timeoutMs: 10_000 }).catch(() => null)
    const version = r?.code === 0 ? r.stdout.toString().trim() : ''
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    if (!min || newerOrSame(version, min)) return { path: c, version }
    older.push(`${version} at ${c}`)
  }
  return {
    why: older.length
      ? `Building the walnut file needs bun ${min} or newer (package.json packageManager); this computer has only ${older.join(', ')}. Run \`bun upgrade\`, or set WALNUT_BUN to a newer bun.`
      : 'Building the walnut file needs bun on this computer (https://bun.sh); none was found ($WALNUT_BUN, PATH, ~/.bun/bin).',
  }
}
