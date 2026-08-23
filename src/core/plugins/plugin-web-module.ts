import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IntegrationRegistry } from '../integration-registry.js'
import type { RegisteredPlugin } from '../integration-types.js'
import type { PluginLifecycleRecord } from './plugin-manager.js'

export const MAX_PLUGIN_WEB_MODULE_BYTES = 2 * 1024 * 1024

export interface PluginWebModule {
  id: string
  name: string
  version?: string
  hash: string
  size: number
  content: Buffer
}

interface CachedModule {
  mtimeMs: number
  ctimeMs: number
  ino: number
  size: number
  module: PluginWebModule
}

const cache = new Map<string, CachedModule>()

function validateWebEntry(entry: string): string {
  const normalized = entry.trim().replace(/\\/g, '/')
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('Plugin web entry must be a safe relative path')
  }
  return normalized
}

export async function readPluginWebModule(plugin: RegisteredPlugin): Promise<PluginWebModule> {
  if (plugin.apiVersion !== 1 || !plugin.webEntry || !plugin.pluginDir) {
    throw new Error(`Plugin "${plugin.id}" has no native Web entry`)
  }

  const root = await fs.realpath(plugin.pluginDir)
  const declared = path.resolve(root, validateWebEntry(plugin.webEntry))
  if (!declared.startsWith(root + path.sep)) {
    throw new Error(`Plugin "${plugin.id}" Web entry escapes its root`)
  }

  const absolute = await fs.realpath(declared)
  if (!absolute.startsWith(root + path.sep)) {
    throw new Error(`Plugin "${plugin.id}" Web entry escapes its root`)
  }

  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`Plugin "${plugin.id}" Web entry is not a file`)
  if (stat.size > MAX_PLUGIN_WEB_MODULE_BYTES) {
    throw new Error(`Plugin "${plugin.id}" Web entry exceeds ${MAX_PLUGIN_WEB_MODULE_BYTES} bytes`)
  }

  const cached = cache.get(absolute)
  if (
    cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.ino === stat.ino
    && cached.size === stat.size
  ) {
    return {
      id: plugin.id,
      name: plugin.name,
      ...(plugin.version ? { version: plugin.version } : {}),
      hash: cached.module.hash,
      size: cached.module.size,
      content: cached.module.content,
    }
  }

  const content = await fs.readFile(absolute)
  if (content.byteLength > MAX_PLUGIN_WEB_MODULE_BYTES) {
    throw new Error(`Plugin "${plugin.id}" Web entry exceeds ${MAX_PLUGIN_WEB_MODULE_BYTES} bytes`)
  }
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  const module: PluginWebModule = {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.version ? { version: plugin.version } : {}),
    hash,
    size: content.byteLength,
    content,
  }
  cache.set(absolute, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino,
    size: stat.size,
    module,
  })
  return module
}

export interface PluginWebModuleInfo {
  id: string
  name: string
  version?: string
  hash: string
  size: number
}

export async function listPluginWebModules(
  registry: IntegrationRegistry,
  records: PluginLifecycleRecord[],
): Promise<{ modules: PluginWebModuleInfo[]; errors: Array<{ id: string; error: string }> }> {
  const active = new Set(
    records
      .filter((plugin) => plugin.state === 'active')
      .map((plugin) => plugin.id),
  )
  const modules: PluginWebModuleInfo[] = []
  const errors: Array<{ id: string; error: string }> = []
  for (const plugin of registry.getAll()) {
    if (!active.has(plugin.id) || plugin.apiVersion !== 1 || !plugin.webEntry) continue
    try {
      const module = await readPluginWebModule(plugin)
      modules.push({
        id: module.id,
        name: module.name,
        ...(module.version ? { version: module.version } : {}),
        hash: module.hash,
        size: module.size,
      })
    } catch (error) {
      errors.push({
        id: plugin.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { modules, errors }
}

export function clearPluginWebModuleCache(): void {
  cache.clear()
}
