/**
 * The bundled plugin store: `plugin-store/<id>/` in the repo, `dist/plugin-store/<id>/`
 * in a build (scripts/ship-store-plugins.mjs copies it there).
 *
 * A plugin in this folder SHIPS with Walnut but is not loaded until the user installs it
 * from Settings, Plugins. Installing writes `plugins.<id>.enabled: true`; that explicit
 * `true` is the only thing discovery accepts (an absent key means "not installed", not
 * "on by default", which is the whole difference from a builtin). Removing deletes the
 * `plugins.<id>` key, so the next discovery (a restart included) skips the folder again.
 *
 * Two readers share this module, and neither may block the event loop, so every read is
 * async fs:
 *
 *   - the catalog (plugin-catalog.ts) turns each readable manifest into an `available` row;
 *   - the loader (integration-loader.ts) asks which folders are installed and runnable.
 *
 * Nothing here throws. A folder with no readable manifest, an unsafe id, or a declared
 * entry that was never built is skipped and reported back as a reason, never an error.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginCatalogEntry } from './plugin-catalog.js'

/** Test and ephemeral servers only: point discovery and the catalog at another folder. */
export const BUNDLED_STORE_DIR_ENV = 'WALNUT_BUNDLED_STORE_DIR'

/** Repo-relative home of the source folder, which is also what a catalog row names. */
export const BUNDLED_STORE_REL = 'plugin-store'

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** What a manifest may say about how the store describes it. */
export interface ManifestCatalogField {
  adds?: string[]
  homepage?: string
  docs?: string
}

/**
 * The override is honoured only where it cannot redirect a real install: a vitest run or
 * an ephemeral child server (`--_ephemeral-child`, what every browser fixture boots with).
 * Read per call, not at import, so a test can set it after this module loads.
 */
function overrideDir(): string | null {
  const value = process.env[BUNDLED_STORE_DIR_ENV]?.trim()
  if (!value) return null
  const testRun = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')
  if (!testRun && !process.argv.includes('--_ephemeral-child')) return null
  return path.resolve(value)
}

async function isDir(candidate: string): Promise<boolean> {
  try { return (await fsp.stat(candidate)).isDirectory() }
  catch { return false }
}

async function isFile(candidate: string): Promise<boolean> {
  try { return (await fsp.stat(candidate)).isFile() }
  catch { return false }
}

let resolvedDefault: Promise<string | null> | null = null

/**
 * Same walk-up as resolveBuiltinDir (integration-loader.ts): a build finds
 * `dist/plugin-store` next to its bundle; a source run finds `<repo>/dist/plugin-store`
 * when the repo was built, else `<repo>/plugin-store`. The source folder counts only
 * beside a `package.json`, so a stray `plugin-store` directory above an npm install is
 * never mistaken for this one. Memoised: the running code does not move.
 */
async function resolveDefaultDir(): Promise<string | null> {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    const built = path.join(dir, 'dist', BUNDLED_STORE_REL)
    if (await isDir(built)) return built
    if (path.basename(dir) === 'dist' && await isDir(path.join(dir, BUNDLED_STORE_REL))) {
      return path.join(dir, BUNDLED_STORE_REL)
    }
    const source = path.join(dir, BUNDLED_STORE_REL)
    if (await isDir(source) && await isFile(path.join(dir, 'package.json'))) return source
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** The bundled store folder, or null when this build carries none. Never throws. */
export async function resolveBundledStoreDir(): Promise<string | null> {
  const override = overrideDir()
  if (override) return override
  resolvedDefault ??= resolveDefaultDir().catch(() => null)
  return resolvedDefault
}

/** Tests: forget the memoised default so the next call walks up again. */
export function resetBundledStoreDirForTesting(): void {
  resolvedDefault = null
}

/** The manifest `catalog` field, or nothing. Junk values are dropped one by one. */
export function parseManifestCatalog(raw: unknown): ManifestCatalogField | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const field = raw as Record<string, unknown>
  const adds = Array.isArray(field.adds)
    ? field.adds.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : []
  const out: ManifestCatalogField = {
    ...(adds.length > 0 ? { adds } : {}),
    ...(typeof field.homepage === 'string' && field.homepage.trim() ? { homepage: field.homepage.trim() } : {}),
    ...(typeof field.docs === 'string' && field.docs.trim() ? { docs: field.docs.trim() } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

interface StoreManifest {
  dirName: string
  dir: string
  raw: Record<string, unknown>
  id: string
}

export interface BundledStoreSkip {
  dir: string
  reason: string
}

/** Every sub-folder with a manifest that parses and names a safe id. */
async function readStoreManifests(storeDir: string): Promise<{ manifests: StoreManifest[]; skipped: BundledStoreSkip[] }> {
  const manifests: StoreManifest[] = []
  const skipped: BundledStoreSkip[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(storeDir, { withFileTypes: true })
  } catch {
    return { manifests, skipped }
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(storeDir, entry.name)
    let raw: unknown
    try {
      raw = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    } catch (error) {
      skipped.push({ dir, reason: `manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.push({ dir, reason: 'manifest.json is not an object' })
      continue
    }
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!PLUGIN_ID_PATTERN.test(id) || id === 'local' || id === 'core') {
      skipped.push({ dir, reason: `unusable id ${JSON.stringify(record.id)}` })
      continue
    }
    manifests.push({ dirName: entry.name, dir, raw: record, id })
  }
  return { manifests, skipped }
}

const stringField = (raw: Record<string, unknown>, key: string): string | undefined =>
  typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined

/**
 * One `bundled` catalog entry per plugin folder. First folder wins a duplicate id, the
 * same rule discovery applies. `storeDir` null means "this build has no store".
 */
export async function scanBundledStore(storeDir: string | null): Promise<PluginCatalogEntry[]> {
  if (!storeDir) return []
  const { manifests } = await readStoreManifests(storeDir)
  const seen = new Set<string>()
  const out: PluginCatalogEntry[] = []
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) continue
    seen.add(manifest.id)
    const catalog = parseManifestCatalog(manifest.raw.catalog)
    const description = stringField(manifest.raw, 'description')
    const version = stringField(manifest.raw, 'version')
    out.push({
      id: manifest.id,
      name: stringField(manifest.raw, 'name') ?? manifest.id,
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(catalog?.adds ? { adds: catalog.adds } : {}),
      ...(catalog?.homepage ? { homepage: catalog.homepage } : {}),
      ...(catalog?.docs ? { docs: catalog.docs } : {}),
      source: { kind: 'bundled', path: `${BUNDLED_STORE_REL}/${manifest.dirName}` },
    })
  }
  return out
}

/**
 * The bundled scan under the curated catalog. The folder is the truth about WHAT ships
 * (id, source, version), so a catalog entry with the same id may only reword it: name,
 * description, adds, homepage, docs and requires. A catalog entry that claims `bundled`
 * for a folder this build does not carry is dropped, because its Install could only fail.
 */
export function overlayBundledCatalog(
  bundled: readonly PluginCatalogEntry[],
  curated: readonly PluginCatalogEntry[],
): PluginCatalogEntry[] {
  const bundledById = new Map(bundled.map((entry) => [entry.id, entry]))
  const out = new Map<string, PluginCatalogEntry>()
  for (const entry of bundled) out.set(entry.id, entry)
  for (const entry of curated) {
    const shipped = bundledById.get(entry.id)
    if (!shipped) {
      if (entry.source.kind !== 'bundled') out.set(entry.id, entry)
      continue
    }
    out.set(entry.id, {
      ...shipped,
      // The parser defaults a missing name to the id; that default must not rename the folder's plugin.
      name: entry.name && entry.name !== entry.id ? entry.name : shipped.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.adds !== undefined ? { adds: entry.adds } : {}),
      ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
      ...(entry.docs !== undefined ? { docs: entry.docs } : {}),
      ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
    })
  }
  return [...out.values()]
}

/** A manifest entry path, relative and inside the plugin folder, or null. */
function safeEntry(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, '/'))
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

/**
 * The installed folders discovery should load: an explicit `enabled: true`, a readable
 * manifest, and every declared `server`/`web` artifact present on disk. A folder whose
 * build never ran (a source checkout that skipped the ship step) is skipped with a
 * reason rather than loaded into a `failed` row it could not get out of.
 */
export async function listInstalledBundledDirs(
  storeDir: string | null,
  pluginConfigs: Readonly<Record<string, { enabled?: unknown } | undefined>>,
): Promise<{ dirs: Array<{ id: string; dir: string }>; skipped: BundledStoreSkip[] }> {
  if (!storeDir) return { dirs: [], skipped: [] }
  const { manifests, skipped } = await readStoreManifests(storeDir)
  const dirs: Array<{ id: string; dir: string }> = []
  const seen = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) continue
    seen.add(manifest.id)
    if (pluginConfigs[manifest.id]?.enabled !== true) continue
    let missing: string | null = null
    for (const key of ['server', 'web'] as const) {
      if (manifest.raw[key] === undefined) continue
      const rel = safeEntry(manifest.raw[key])
      if (!rel) { missing = `${key} entry is not a relative path inside the plugin`; break }
      if (!(await isFile(path.join(manifest.dir, rel)))) { missing = `${key} artifact ${rel} is missing (not built)`; break }
    }
    if (missing) {
      skipped.push({ dir: manifest.dir, reason: missing })
      continue
    }
    dirs.push({ id: manifest.id, dir: manifest.dir })
  }
  return { dirs, skipped }
}
