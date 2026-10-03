/**
 * Which workspace providers exist: the built-in git-worktree, plus every plugin
 * provider declared in a LOCAL plugin manifest (`capabilities.workspace.providers`).
 *
 * This module is the only source of the allowlist the server pushes to a daemon
 * (`workspace.configure`): an argv per provider, plus at most one adapter script
 * read from the plugin's own folder. Nothing a browser, a phone or the cloud
 * bridge sends can add or change an entry. Protocol: docs/reference/workspace-providers.md.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { WorkspaceProviderSpec, WorkspaceConfig } from '../../providers/workspace-core.js'
import type { WorkspaceInputSchema, WorkspaceInputField } from './types.js'
import { log } from '../../logging/index.js'

export const GIT_WORKTREE_ID = 'git-worktree'
const SCRIPT_MAX_BYTES = 512 * 1024
const CACHE_MS = 2_000

export interface ProviderInfo {
  id: string
  displayName: string
  priority: number
  builtin: boolean
  pluginId?: string
  markers?: string[]
  inputSchema?: WorkspaceInputSchema
}

export interface ProviderCatalog {
  providers: ProviderInfo[]
  /** What the daemon gets: plugin providers only (git-worktree is built into it). */
  config: WorkspaceConfig
  warnings: string[]
}

const GIT_PROVIDER: ProviderInfo = {
  id: GIT_WORKTREE_ID,
  displayName: 'Git worktree',
  priority: 10,
  builtin: true,
  inputSchema: {
    type: 'object',
    properties: {
      baseRef: {
        type: 'string',
        title: 'Base branch',
        description: 'Branch or commit the new branch starts from. Empty: the folder\'s current commit.',
        placeholder: 'current commit',
      },
    },
  },
}

/** A plugin as this module needs it (the registry's RegisteredPlugin, narrowed). */
export interface PluginSource { id: string; pluginDir?: string; capabilities?: string[] }

let listPlugins: () => Promise<PluginSource[]> = async () => {
  const { registry } = await import('../integration-registry.js')
  return registry.getAll().map((p) => ({ id: p.id, pluginDir: p.pluginDir, capabilities: p.capabilities }))
}

/** Test-only: the plugin list (null restores the registry). */
export function __setWorkspacePluginSourceForTesting(fn: (() => Promise<PluginSource[]>) | null): void {
  listPlugins = fn ?? (async () => {
    const { registry } = await import('../integration-registry.js')
    return registry.getAll().map((p) => ({ id: p.id, pluginDir: p.pluginDir, capabilities: p.capabilities }))
  })
  cache = null
}

let cache: { at: number; value: ProviderCatalog } | null = null

function sanitizeField(raw: unknown): WorkspaceInputField | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  if (f.type !== 'string' && f.type !== 'boolean' && f.type !== 'array') return null
  const str = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
  const out: WorkspaceInputField = { type: f.type }
  const title = str(f.title, 80); if (title) out.title = title
  const description = str(f.description, 400); if (description) out.description = description
  const placeholder = str(f.placeholder, 120); if (placeholder) out.placeholder = placeholder
  if (f.type === 'string' && Array.isArray(f.enum)) {
    const choices = f.enum.filter((v): v is string => typeof v === 'string' && v.length <= 120).slice(0, 32)
    if (choices.length) out.enum = choices
  }
  if (f.type === 'array') out.items = { type: 'string' }
  if (f.default !== undefined && ['string', 'boolean'].includes(typeof f.default)) out.default = f.default
  if (f.type === 'array' && Array.isArray(f.default)) out.default = f.default.filter((v) => typeof v === 'string').slice(0, 64)
  return out
}

export function sanitizeInputSchema(raw: unknown): WorkspaceInputSchema | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Record<string, unknown>
  const props = s.properties && typeof s.properties === 'object' ? s.properties as Record<string, unknown> : {}
  const properties: Record<string, WorkspaceInputField> = {}
  for (const [key, val] of Object.entries(props).slice(0, 16)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue
    const field = sanitizeField(val)
    if (field) properties[key] = field
  }
  if (Object.keys(properties).length === 0) return undefined
  const required = Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string' && k in properties) : []
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** One manifest provider → the daemon spec, or a reason it was skipped. */
async function compileProvider(pluginId: string, pluginDir: string, raw: unknown): Promise<{ spec: WorkspaceProviderSpec; info: ProviderInfo } | string> {
  if (!raw || typeof raw !== 'object') return 'not an object'
  const p = raw as Record<string, unknown>
  const id = typeof p.id === 'string' ? p.id : ''
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id === GIT_WORKTREE_ID) return `invalid provider id "${String(p.id)}"`
  if (!Array.isArray(p.command) || p.command.length === 0 || p.command.length > 32
    || p.command.some((t) => typeof t !== 'string' || !t || t.includes('\0'))) {
    return `${id}: command must be a non-empty argv (a list of strings, no shell)`
  }
  const command = (p.command as string[]).slice()
  let script: WorkspaceProviderSpec['script']
  if (p.script !== undefined) {
    if (typeof p.script !== 'string' || !p.script || path.isAbsolute(p.script)) return `${id}: script must be a path inside the plugin folder`
    const dirReal = await fsp.realpath(pluginDir).catch(() => pluginDir)
    const file = path.resolve(dirReal, p.script)
    const fileReal = await fsp.realpath(file).catch(() => '')
    if (!fileReal || (fileReal !== dirReal && !fileReal.startsWith(dirReal + path.sep))) return `${id}: script ${p.script} is not a file inside the plugin folder`
    const st = await fsp.stat(fileReal).catch(() => null)
    if (!st?.isFile() || st.size > SCRIPT_MAX_BYTES) return `${id}: script ${p.script} is missing or larger than 512 KB`
    script = { name: path.basename(fileReal), content: await fsp.readFile(fileReal, 'utf8') }
  } else if (command.includes('{script}')) {
    return `${id}: command names {script} but the provider declares no script`
  }
  const strList = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).slice(0, max) : undefined)
  const markers = strList(p.markers, 16)
  const roots = strList(p.roots, 16)
  const operations = strList(p.operations, 8)
  const t = p.timeouts && typeof p.timeouts === 'object' ? p.timeouts as Record<string, unknown> : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(1800, Math.floor(v)) : undefined)
  const timeouts = { createSec: num(t.createSec), removeSec: num(t.removeSec), otherSec: num(t.otherSec) }
  const displayName = typeof p.displayName === 'string' && p.displayName ? p.displayName.slice(0, 80) : id
  const priority = typeof p.priority === 'number' && Number.isFinite(p.priority) ? p.priority : 50
  const inputSchema = sanitizeInputSchema(p.inputSchema)
  const spec: WorkspaceProviderSpec = {
    id, displayName, priority, command,
    ...(markers?.length ? { markers } : {}),
    ...(roots?.length ? { roots } : {}),
    ...(operations?.length ? { operations } : {}),
    ...(script ? { script } : {}),
    timeouts,
  }
  return {
    spec,
    info: { id, displayName, priority, builtin: false, pluginId, ...(markers?.length ? { markers } : {}), ...(inputSchema ? { inputSchema } : {}) },
  }
}

async function readManifestProviders(pluginDir: string): Promise<unknown[]> {
  const text = await fsp.readFile(path.join(pluginDir, 'manifest.json'), 'utf8')
  const obj = JSON.parse(text) as Record<string, unknown>
  const caps = obj.capabilities && typeof obj.capabilities === 'object' ? obj.capabilities as Record<string, unknown> : {}
  const ws = caps.workspace && typeof caps.workspace === 'object' ? caps.workspace as Record<string, unknown> : {}
  return Array.isArray(ws.providers) ? ws.providers.slice(0, 8) : []
}

/** Every provider, highest priority first, and the daemon allowlist with its hash. */
export async function workspaceProviderCatalog(): Promise<ProviderCatalog> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const providers: ProviderInfo[] = [GIT_PROVIDER]
  const specs: WorkspaceProviderSpec[] = []
  const warnings: string[] = []
  const seen = new Set<string>([GIT_WORKTREE_ID])
  for (const plugin of await listPlugins()) {
    if (!plugin.pluginDir || !plugin.capabilities?.includes('workspace')) continue
    let entries: unknown[]
    try {
      entries = await readManifestProviders(plugin.pluginDir)
    } catch (err) {
      warnings.push(`${plugin.id}: manifest unreadable (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    for (const raw of entries) {
      const compiled = await compileProvider(plugin.id, plugin.pluginDir, raw).catch((err) => String(err))
      if (typeof compiled === 'string') { warnings.push(`${plugin.id}: ${compiled}`); continue }
      if (seen.has(compiled.spec.id)) { warnings.push(`${plugin.id}: provider id ${compiled.spec.id} is already taken`); continue }
      seen.add(compiled.spec.id)
      specs.push(compiled.spec)
      providers.push(compiled.info)
    }
  }
  if (warnings.length) log.web.warn('workspace providers skipped', { warnings })
  specs.sort((a, b) => a.id.localeCompare(b.id))
  providers.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  const hash = crypto.createHash('sha256').update(JSON.stringify(specs)).digest('hex').slice(0, 16)
  const value: ProviderCatalog = { providers, config: { version: 1, hash, providers: specs }, warnings }
  cache = { at: Date.now(), value }
  return value
}

export async function findProvider(id: string): Promise<ProviderInfo | null> {
  return (await workspaceProviderCatalog()).providers.find((p) => p.id === id) ?? null
}

/**
 * Inputs as the provider's schema allows them: unknown keys dropped, types
 * enforced, required fields present. Returns the clean object or a sentence.
 */
export function validateInputs(schema: WorkspaceInputSchema | undefined, raw: unknown): Record<string, unknown> | string {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  const props = schema?.properties ?? {}
  for (const [key, field] of Object.entries(props)) {
    const v = input[key]
    if (v === undefined || v === null || v === '') continue
    const label = field.title ?? key
    if (field.type === 'boolean') {
      if (typeof v !== 'boolean') return `${label} must be on or off`
      out[key] = v
    } else if (field.type === 'string') {
      if (typeof v !== 'string' || v.length > 500) return `${label} must be text (at most 500 characters)`
      if (field.enum && !field.enum.includes(v)) return `${label} must be one of: ${field.enum.join(', ')}`
      out[key] = v.trim()
    } else {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null
      if (!list || list.some((x) => typeof x !== 'string' || x.length > 200)) return `${label} must be a list of names`
      const clean = (list as string[]).map((x) => x.trim()).filter(Boolean).slice(0, 64)
      if (clean.length) out[key] = clean
    }
  }
  for (const key of schema?.required ?? []) {
    if (out[key] === undefined) return `${props[key]?.title ?? key} is required`
  }
  return out
}
