import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WALNUT_HOME } from '../../constants.js'

// A copied module graph refreshes Node's cache without changing resource-relative paths.

const EXCLUDED = new Set(['.git', '.plugin-cache'])
const STAMP = '.walnut-generation.json'

export interface PluginGeneration {
  id: string
  root: string
  entry: string
  /** Set when this copy could not become self-contained, so a reload cannot fully replace the old code. */
  unsafeReason?: string
}

export interface PluginTreeProbe {
  /** Native addons the plugin's runtime code can load: its own, or one inside a runtime dependency. */
  native: string[]
  /** Links leaving the plugin directory are never followed: the target is not ours to copy. */
  external: string[]
}

const liveRoots = new Map<string, Set<string>>()
const prunedIds = new Set<string>()

function generationsRoot(cacheRoot?: string): string {
  return cacheRoot ?? path.join(WALNUT_HOME, 'cache', 'plugin-generations')
}

export function liveGenerations(id: string): string[] {
  return [...(liveRoots.get(id) ?? [])]
}

export function resetGenerationStateForTesting(): void {
  liveRoots.clear()
  prunedIds.clear()
}

interface WalkContext {
  srcRoot: string
  destRoot: string | null
  probe: PluginTreeProbe
  stopEarly: boolean
  /** Decides whether a `.node` file is runtime code. Absent: native addons are not recorded (the copy never reads them). */
  loadsAddon?: (file: string) => Promise<boolean>
}

async function walk(src: string, dest: string | null, ctx: WalkContext): Promise<void> {
  if (dest) await fs.mkdir(dest, { recursive: true })
  // A directory we cannot read is a failed load, never a silently smaller tree.
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (ctx.stopEarly && (ctx.probe.native.length || ctx.probe.external.length)) return
    if (EXCLUDED.has(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = dest ? path.join(dest, entry.name) : null
    if (entry.isSymbolicLink()) {
      await copyLink(from, to, ctx)
      continue
    }
    if (entry.isDirectory()) {
      await walk(from, to, ctx)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.node') && ctx.loadsAddon && await ctx.loadsAddon(from)) ctx.probe.native.push(from)
    if (to) await fs.copyFile(from, to)
  }
}

async function copyLink(from: string, to: string | null, ctx: WalkContext): Promise<void> {
  const real = await fs.realpath(from).catch(() => null)
  if (!real) return
  if (real !== ctx.srcRoot && !real.startsWith(ctx.srcRoot + path.sep)) {
    // Outside the plugin directory: not followed, not copied, not scanned.
    ctx.probe.external.push(path.relative(ctx.srcRoot, from))
    return
  }
  // Relink inside the copy — pointing at the original would resolve to the old module graph.
  if (!to || !ctx.destRoot) return
  const target = path.join(ctx.destRoot, path.relative(ctx.srcRoot, real))
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.symlink(path.relative(path.dirname(to), target), to)
}

/** Reasons this tree cannot be copied into a replaceable generation. Stops at the first one. */
export async function probePluginTree(dir: string): Promise<PluginTreeProbe> {
  const root = await fs.realpath(dir).catch(() => dir)
  const ctx: WalkContext = {
    srcRoot: root,
    destRoot: null,
    probe: { native: [], external: [] },
    stopEarly: true,
    loadsAddon: runtimeAddonFilter(root),
  }
  await walk(root, null, ctx)
  return ctx.probe
}

// A `.node` file only pins the process when runtime code can load it. A devDependency (a test
// runner's bundler binary, a file watcher) never runs from the built entry, and a Plugin Store
// install omits it entirely, so it must not block every later hot reload.

const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

function runtimeAddonFilter(root: string): (file: string) => Promise<boolean> {
  let closure: Promise<Set<string> | null> | undefined
  return async (file) => {
    const owner = owningPackageDir(root, file)
    // The plugin's own addon (`build/Release/x.node`, `addon.node`) is always runtime code.
    if (!owner) return true
    // Resolved once, and only for a tree that has an addon inside node_modules.
    closure ??= runtimeClosure(root)
    const packages = await closure
    if (!packages) return true // no readable manifest: every addon counts, as before
    return packages.has(await fs.realpath(owner).catch(() => owner))
  }
}

/** The innermost node_modules package directory holding `file`, or null when it is the plugin's own file. */
function owningPackageDir(root: string, file: string): string | null {
  const parts = path.relative(root, file).split(path.sep)
  for (let index = parts.length - 2; index >= 0; index--) {
    if (parts[index] !== 'node_modules') continue
    const scoped = parts[index + 1]?.startsWith('@')
    const end = index + (scoped ? 2 : 1)
    // `node_modules/x.node` or `node_modules/@scope/x.node` sits in no package: look further out.
    if (end < parts.length - 1) return path.join(root, ...parts.slice(0, end + 1))
  }
  return null
}

interface PackageManifest {
  dependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
}

async function readManifest(dir: string): Promise<PackageManifest | null> {
  const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PackageManifest : null
  } catch { return null }
}

function runtimeNames(manifest: PackageManifest): string[] {
  const names = new Set<string>()
  for (const field of RUNTIME_FIELDS) {
    const value = manifest[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const name of Object.keys(value)) if (isPackageName(name)) names.add(name)
  }
  return [...names]
}

/** `name` or `@scope/name`, never a path that could walk out of node_modules. */
function isPackageName(name: string): boolean {
  const segments = name.split('/')
  if (segments.length !== (name.startsWith('@') ? 2 : 1)) return false
  return segments.every(segment => segment && segment !== '.' && segment !== '..' && segment !== '@' && !segment.includes('\\'))
}

/**
 * Real paths of every package the root's runtime fields reach, transitively, resolved the way Node
 * does and never above the plugin root. Null when a manifest on the way is missing or unreadable:
 * then nobody can say which addon is runtime code.
 */
async function runtimeClosure(root: string): Promise<Set<string> | null> {
  const rootManifest = await readManifest(root)
  if (!rootManifest) return null
  const found = new Set<string>()
  const queue: Array<{ dir: string; manifest: PackageManifest }> = [{ dir: root, manifest: rootManifest }]
  while (queue.length) {
    const { dir, manifest } = queue.shift()!
    for (const name of runtimeNames(manifest)) {
      const resolved = await resolvePackage(root, dir, name)
      if (!resolved || found.has(resolved)) continue
      found.add(resolved)
      const next = await readManifest(resolved)
      if (!next) return null
      queue.push({ dir: resolved, manifest: next })
    }
  }
  return found
}

/** `<dir>/node_modules/<name>`, then each parent's, up to and including the plugin root. A miss is fine: optional and peer packages may be absent. */
async function resolvePackage(root: string, from: string, name: string): Promise<string | null> {
  let dir = from
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name)
      const real = await fs.realpath(candidate).catch(() => null)
      if (real && await fs.stat(real).then(stat => stat.isDirectory()).catch(() => false)) {
        // A link out of the tree is reported on its own; its contents are not walked, so not followed here either.
        return real === root || real.startsWith(root + path.sep) ? real : null
      }
    }
    if (dir === root) return null
    const parent = path.dirname(dir)
    if (parent !== root && !parent.startsWith(root + path.sep)) return null
    dir = parent
  }
}

async function sourceSignature(root: string): Promise<string> {
  const parts: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED.has(entry.name)) continue
      const target = path.join(dir, entry.name)
      const stat = await fs.lstat(target, { bigint: true })
      parts.push(`${path.relative(root, target)}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
      if (entry.isDirectory()) await visit(target)
    }
  }
  await visit(root)
  return JSON.stringify(parts)
}

export async function createPluginGeneration(options: {
  id: string
  dir: string
  entryRelative: string
  cacheRoot?: string
}): Promise<PluginGeneration> {
  const { id, dir, entryRelative } = options
  const root = path.join(generationsRoot(options.cacheRoot), id, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  const srcRoot = await fs.realpath(dir).catch(() => dir)
  if (root === srcRoot || root.startsWith(srcRoot + path.sep)) throw new Error('generation cache must live outside the plugin directory')
  const before = await sourceSignature(srcRoot)
  const ctx: WalkContext = { srcRoot, destRoot: root, probe: { native: [], external: [] }, stopEarly: false }
  try {
    await walk(srcRoot, root, ctx)
    if (await sourceSignature(srcRoot) !== before) throw new Error('plugin source changed while it was being copied')
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
  await fs.writeFile(path.join(root, STAMP), JSON.stringify({ pid: process.pid, dir, createdAt: Date.now() }))
  await preserveModuleType(srcRoot, root)
  const generation: PluginGeneration = {
    id,
    root,
    entry: path.join(root, entryRelative),
    unsafeReason: describeUnsafe(await dependenciesOutsideCopy(srcRoot, root), ctx.probe.external),
  }
  const set = liveRoots.get(id) ?? new Set<string>()
  set.add(root)
  liveRoots.set(id, set)
  return generation
}

function describeUnsafe(shared: string[], external: string[]): string | undefined {
  const parts: string[] = []
  if (shared.length) parts.push(`dependencies resolve outside the plugin directory and keep their loaded state (${shared.slice(0, 3).join(', ')})`)
  if (external.length) parts.push(`links leave the plugin directory and were not copied (${external.slice(0, 3).join(', ')})`)
  return parts.length ? parts.join('; ') : undefined
}

/** Node reads .js semantics from the nearest package.json, and the copy sits elsewhere in the tree. */
async function preserveModuleType(dir: string, root: string): Promise<void> {
  let current = dir
  let type = 'commonjs'
  for (;;) {
    const raw = await fs.readFile(path.join(current, 'package.json'), 'utf8').catch(() => null)
    if (raw !== null) {
      if (current === dir) return // copied verbatim, so the boundary already moved with the tree
      try {
        if ((JSON.parse(raw) as { type?: string })?.type === 'module') type = 'module'
      } catch { /* Node falls back to commonjs on an unreadable package.json too */ }
      break
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type }))
}

async function dependenciesOutsideCopy(dir: string, root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null)
  if (!raw) return []
  let names: string[] = []
  try {
    names = Object.keys((JSON.parse(raw) as { dependencies?: Record<string, string> })?.dependencies ?? {})
  } catch { return [] }
  const outside: string[] = []
  for (const name of names) {
    const present = await fs.stat(path.join(root, 'node_modules', name)).then(() => true).catch(() => false)
    if (!present) outside.push(name)
  }
  return outside
}

async function readStamp(root: string): Promise<{ pid?: number } | null> {
  const raw = await fs.readFile(path.join(root, STAMP), 'utf8').catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) as { pid?: number } } catch { return null }
}

/** Removes one generation this process created and still tracks. Never a sibling, never the source. */
export async function disposePluginGeneration(generation: PluginGeneration): Promise<void> {
  const set = liveRoots.get(generation.id)
  if (!set?.has(generation.root)) return
  set.delete(generation.root)
  if (set.size === 0) liveRoots.delete(generation.id)
  if ((await readStamp(generation.root))?.pid !== process.pid) return
  await fs.rm(generation.root, { recursive: true, force: true })
}

export async function pruneOrphanGenerations(id: string, cacheRoot?: string): Promise<void> {
  if (prunedIds.has(id)) return
  prunedIds.add(id)
  const base = path.join(generationsRoot(cacheRoot), id)
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
  const mine = liveRoots.get(id) ?? new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = path.join(base, entry.name)
    if (mine.has(root)) continue
    const pid = (await readStamp(root))?.pid
    if (!Number.isInteger(pid) || (pid as number) <= 0) continue
    if (!processGone(pid as number)) continue
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** Only a confirmed ESRCH counts as gone: an unknown answer or EPERM keeps the directory. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
