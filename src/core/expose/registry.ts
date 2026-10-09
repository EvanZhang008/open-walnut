/**
 * The tunnel providers this server knows: the built-in `command` provider (a
 * command the person writes in config.yaml) and every definition a plugin
 * registered through `walnut.expose.register`. A plugin's definition belongs to
 * the plugin: disabling or reloading it removes it, and the runtime stops a
 * tunnel whose provider went away.
 */

import {
  COMMAND_PROVIDER_ID, EXPOSE_PROVIDER_ID,
  type ExposeProviderDefinition, type ExposeProviderInfo,
} from './types.js'

export interface CommandProviderConfig {
  command?: string
  args?: string[]
  url_pattern?: string
  ready_pattern?: string
}

/** Any https URL a tunnel prints, when the person did not name a narrower pattern. */
export const DEFAULT_URL_PATTERN = 'https://[^\\s"\'<>]+'

const providers = new Map<string, { owner: string; def: ExposeProviderDefinition }>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) {
    try { listener() } catch { /* a listener must not break registration */ }
  }
}

export function validateExposeDefinition(def: ExposeProviderDefinition): void {
  if (!def || typeof def !== 'object') throw new Error('A tunnel provider definition is an object')
  if (typeof def.id !== 'string' || !EXPOSE_PROVIDER_ID.test(def.id)) {
    throw new Error(`Tunnel provider id "${String(def.id)}" must be lowercase letters, digits, ".", "_" or "-"`)
  }
  if (def.id === COMMAND_PROVIDER_ID) throw new Error(`Tunnel provider id "${COMMAND_PROVIDER_ID}" is the built-in one`)
  if (typeof def.title !== 'string' || !def.title.trim()) throw new Error(`Tunnel provider "${def.id}" needs a title`)
  if (typeof def.command !== 'string' || !def.command.trim()) throw new Error(`Tunnel provider "${def.id}" needs a command`)
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string'))) {
    throw new Error(`Tunnel provider "${def.id}": args must be strings`)
  }
  if (def.env !== undefined && (typeof def.env !== 'object' || Object.values(def.env).some((v) => typeof v !== 'string'))) {
    throw new Error(`Tunnel provider "${def.id}": env values must be strings`)
  }
  if (typeof def.urlPattern !== 'string' || !def.urlPattern) throw new Error(`Tunnel provider "${def.id}" needs a urlPattern`)
  for (const p of [def.urlPattern, def.readyPattern ?? '', ...(def.signInPatterns ?? []), ...(def.options ?? []).map((o) => o.pattern ?? '')]) {
    try { new RegExp(p) } catch { throw new Error(`Tunnel provider "${def.id}": "${p}" is not a valid pattern`) }
  }
  for (const option of def.options ?? []) {
    if (!option || typeof option.key !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(option.key) || option.key === 'port') {
      throw new Error(`Tunnel provider "${def.id}": option keys are letters, digits and "_" (and not "port")`)
    }
  }
}

/** Register `def` for `owner` (a plugin id). Throws when another owner holds the id. */
export function registerExposeProvider(owner: string, def: ExposeProviderDefinition): { dispose(): void } {
  validateExposeDefinition(def)
  const existing = providers.get(def.id)
  if (existing && existing.owner !== owner) {
    throw new Error(`Tunnel provider "${def.id}" is already registered by ${existing.owner}`)
  }
  const entry = { owner, def: structuredClone(def) }
  providers.set(def.id, entry)
  changed()
  return {
    dispose() {
      if (providers.get(def.id) === entry) {
        providers.delete(def.id)
        changed()
      }
    },
  }
}

/** The built-in provider, from config.yaml's `expose.command`; null until a command is written. */
export function commandProvider(cfg: CommandProviderConfig | undefined): ExposeProviderDefinition | null {
  const command = cfg?.command?.trim()
  if (!command) return null
  return {
    id: COMMAND_PROVIDER_ID,
    title: 'Custom command',
    description: 'A tunnel command you set in config.yaml (expose.command).',
    command,
    args: Array.isArray(cfg?.args) ? cfg!.args.filter((a): a is string => typeof a === 'string') : [],
    urlPattern: cfg?.url_pattern?.trim() || DEFAULT_URL_PATTERN,
    ...(cfg?.ready_pattern?.trim() ? { readyPattern: cfg.ready_pattern.trim() } : {}),
  }
}

export function getExposeProvider(id: string, commandCfg?: CommandProviderConfig): ExposeProviderDefinition | null {
  if (id === COMMAND_PROVIDER_ID) return commandProvider(commandCfg)
  return providers.get(id)?.def ?? null
}

export function listExposeProviders(commandCfg?: CommandProviderConfig): ExposeProviderInfo[] {
  const list: ExposeProviderInfo[] = [...providers.values()].map(({ owner, def }) => ({
    id: def.id,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    owner,
    options: def.options ?? [],
  }))
  const builtIn = commandProvider(commandCfg)
  if (builtIn) list.push({ id: builtIn.id, title: builtIn.title, description: builtIn.description, owner: 'core', options: [] })
  return list.sort((a, b) => a.title.localeCompare(b.title))
}

export function onExposeProvidersChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Tests only. */
export function _resetExposeProvidersForTesting(): void {
  providers.clear()
  listeners.clear()
}
