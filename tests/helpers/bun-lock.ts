/**
 * Read a text bun.lock (JSON with trailing commas) the way Bun resolves it:
 * `packages` is keyed by install path (`a`, `a/b` for a copy nested under a,
 * scoped names keep their slash), and each entry is
 * `[name@version, registry, meta, integrity]`.
 */
import fs from 'node:fs'

export interface BunLockPackageMeta {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  hasInstallScript?: boolean
  os?: string | string[]
  cpu?: string | string[]
}

export interface BunLock {
  lockfileVersion: number
  workspaces: Record<string, { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>
  packages: Record<string, [string, string?, BunLockPackageMeta?, string?]>
  patchedDependencies?: Record<string, string>
  trustedDependencies?: string[]
}

/** Trailing commas only ever stand before `}` or `]` in Bun's output. */
export function parseBunLock(text: string): BunLock {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as BunLock
}

export function readBunLock(file: string): BunLock {
  return parseBunLock(fs.readFileSync(file, 'utf8'))
}

/** `name@version` -> [name, version] (a scoped name keeps its leading @). */
export function splitSpec(spec: string): [string, string] {
  const at = spec.lastIndexOf('@')
  return [spec.slice(0, at), spec.slice(at + 1)]
}

/** The install path a dependency of the package at `fromKey` resolves to ('' = the root). */
export function resolveKey(lock: BunLock, fromKey: string, dep: string): string | null {
  let base = fromKey
  for (;;) {
    const candidate = base ? `${base}/${dep}` : dep
    if (lock.packages[candidate]) return candidate
    if (!base) return null
    const [name] = splitSpec(lock.packages[base]![0])
    base = base.length > name.length ? base.slice(0, base.length - name.length - 1) : ''
  }
}

/**
 * Every install path the root workspace needs at runtime: its dependencies and
 * optionalDependencies and theirs, never a devDependency.
 */
export function runtimeClosure(lock: BunLock): Set<string> {
  const root = lock.workspaces['']!
  const seen = new Set<string>()
  const queue: Array<[string, string]> = Object.keys({ ...root.dependencies, ...root.optionalDependencies }).map((d) => ['', d])
  while (queue.length) {
    const [from, dep] = queue.shift()!
    const key = resolveKey(lock, from, dep)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const meta = lock.packages[key]![2] ?? {}
    for (const d of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) queue.push([key, d])
  }
  return seen
}
