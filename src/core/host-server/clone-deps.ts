/**
 * Whether the checkout's installed dependencies can stand in for a commit's own
 * install in a clone build (host-file-build.ts), by the rules
 * scripts/deploy-committed.sh deploys with: a dependency the commit declares
 * that the checkout has not installed, or one the commit patches that the
 * checkout installed with an older patch or none, or one the checkout patched
 * that the commit no longer patches. Any of these means the commit's lockfile
 * is installed in the clone instead of linking the checkout's node_modules.
 *
 * 2026-11-11: the checkout's codex-acp still carried the patch before the one
 * 83b9c1011 ships. The deploy installed fresh and its daemon read
 * walnut-daemon-9f80db843b90; the darwin-x64 file built here from links read
 * walnut-daemon-8cc613a6c30f (the daemon's version hashes codex-acp's files), and
 * every update of an Intel Mac on the host network was refused on the host.
 *
 * Reads only: never writes into the checkout or the clone.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

interface PackageJson {
  name?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: unknown
  patchedDependencies?: Record<string, string>
}

async function readJson(file: string): Promise<PackageJson | null> {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) as PackageJson } catch { return null }
}

const exists = (p: string) => fs.promises.stat(p).then(() => true, () => false)

const declared = (p: PackageJson) => Object.keys({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) })

/** The workspace package names of a tree (package.json `workspaces`). */
async function workspaceNames(tree: string, pkg: PackageJson): Promise<Set<string>> {
  const out = new Set<string>()
  for (const dir of Array.isArray(pkg.workspaces) ? pkg.workspaces : []) {
    if (typeof dir !== 'string') continue
    const name = (await readJson(path.join(tree, dir, 'package.json')))?.name
    if (typeof name === 'string') out.add(name)
  }
  return out
}

/**
 * A patch file split into its files and hunks, each hunk as it reads once
 * applied (its context and added lines, in order).
 */
export function patchHunks(text: string): Array<{ name: string; hunks: string[][] }> {
  const files: Array<{ name: string; hunks: string[][] }> = []
  let file: { name: string; hunks: string[][] } | null = null
  let hunk: string[] | null = null
  for (const line of text.split('\n')) {
    const head = /^\+\+\+ b\/(.+)$/.exec(line)
    if (head) { file = { name: head[1]!, hunks: [] }; files.push(file); hunk = null; continue }
    if (!file) continue
    if (line.startsWith('@@')) { hunk = []; file.hunks.push(hunk); continue }
    if (!hunk) continue
    if (line.startsWith('+') || line.startsWith(' ')) hunk.push(line.slice(1))
    else if (line === '') hunk.push('')
  }
  return files
}

/** Whether a package dir lacks any hunk of the patch as applied (a file of it missing counts). */
export async function patchIsStale(dir: string, text: string): Promise<boolean> {
  for (const file of patchHunks(text)) {
    let have: string
    try { have = await fs.promises.readFile(path.join(dir, file.name), 'utf8') } catch { return true }
    for (const hunk of file.hunks) {
      const lines = [...hunk]
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      if (lines.length && !have.includes(lines.join('\n'))) return true
    }
  }
  return false
}

const nameOf = (spec: string) => spec.replace(/@[^@/]+$/, '')

/**
 * Why the checkout's node_modules cannot stand in for the commit checked out in
 * `tree`: `root <name>` / `web <name>` (declared, not installed), `root patched
 * <name>` (installed with another patch), `root unpatched <name>` (the commit
 * dropped its patch). Empty: linking the checkout's install builds what a fresh
 * install of the commit would.
 */
export async function staleDependencies(checkout: string, tree: string): Promise<string[]> {
  const pkg = await readJson(path.join(tree, 'package.json'))
  if (!pkg) return []
  const ws = await workspaceNames(tree, pkg)
  const rootModules = path.join(checkout, 'node_modules')
  const out: string[] = []
  for (const n of declared(pkg)) {
    if (!ws.has(n) && !(await exists(path.join(rootModules, n, 'package.json')))) out.push(`root ${n}`)
  }
  const webPkg = await readJson(path.join(tree, 'web', 'package.json'))
  if (webPkg) {
    for (const n of declared(webPkg)) {
      if (!ws.has(n) && !(await exists(path.join(checkout, 'web', 'node_modules', n, 'package.json')))) out.push(`web ${n}`)
    }
  }
  const patched = pkg.patchedDependencies ?? {}
  for (const [spec, rel] of Object.entries(patched)) {
    const dir = path.join(rootModules, nameOf(spec))
    let text: string
    try { text = await fs.promises.readFile(path.join(tree, rel), 'utf8') } catch { continue }
    if ((await exists(path.join(dir, 'package.json'))) && (await patchIsStale(dir, text))) out.push(`root patched ${nameOf(spec)}`)
  }
  const before = (await readJson(path.join(checkout, 'package.json')))?.patchedDependencies ?? {}
  for (const spec of Object.keys(before)) if (!(spec in patched)) out.push(`root unpatched ${nameOf(spec)}`)
  return out
}

/**
 * The daemon version a tree builds (scripts/build-daemon.sh, computeExpectedDaemonVersion
 * in daemon-version-check.ts: path, NUL, content, NUL per file, sha256, 12 hex), read
 * through its links; null when a file is missing.
 */
export async function daemonVersionAt(root: string, files: readonly string[]): Promise<string | null> {
  const hash = createHash('sha256')
  const NUL = Buffer.from([0])
  for (const rel of files) {
    let data: Buffer
    try { data = await fs.promises.readFile(path.join(root, rel)) } catch { return null }
    hash.update(Buffer.from(rel)); hash.update(NUL); hash.update(data); hash.update(NUL)
  }
  return `walnut-daemon-${hash.digest('hex').slice(0, 12)}`
}
