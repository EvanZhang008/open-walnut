/**
 * Owner-scoped registry for plugin-contributed slash commands.
 *
 * A plugin command is host-NAMED `<pluginId>:<localId>` — the host owns the name,
 * the plugin only picks the local id. That namespace is deliberately a shape the
 * user/builtin `.md` slug pattern rejects, so a plugin can never claim `/compact`
 * or silently shadow a user command, and `command-store` can tell the two apart
 * from the name alone.
 *
 * Leaf module on purpose: only owned-registry + ids + disposable. `command-store`
 * (fs, on the prompt/REST path) imports this, so it must never pull in the plugin
 * loader, config, or the task DB.
 */
import { OwnedRegistry } from './owned-registry.js'
import { namespacePluginId, validatePluginId } from './ids.js'
import type { Disposable } from './disposable.js'

/** What a plugin passes to `walnut.registry.command(...)`. */
export interface PluginCommandDefinition {
  id: string
  description: string
  content: string
}

/** What the host stores and serves — same shape as a `.md` command, with source 'plugin'. */
export interface PluginCommandRecord {
  name: string
  description: string
  content: string
  source: 'plugin'
}

const pluginCommands = new OwnedRegistry<PluginCommandRecord>()

/**
 * Local id: no `/`. A command name is addressed as one URL path segment
 * (`/api/commands/<name>`) and typed after a `/` in the palette, so a slash inside the
 * id would produce a command that exists but cannot be fetched, updated, or deleted.
 * Rejecting it at registration beats shipping an unreachable command.
 */
const COMMAND_LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/

/** `<pluginId>:<localId>` — the only name shape a plugin command can have. */
const PLUGIN_COMMAND_NAME = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/

/**
 * True when `name` is addressed to the plugin namespace. Callers use this to route
 * a lookup BEFORE the user/builtin slug validation runs (that pattern has no `:`).
 */
export function isPluginCommandName(name: string): boolean {
  return typeof name === 'string' && PLUGIN_COMMAND_NAME.test(name)
}

export function registerOwnedCommand(owner: string, definition: PluginCommandDefinition): Disposable {
  validatePluginId(owner)
  if (typeof definition?.id !== 'string' || !COMMAND_LOCAL_ID.test(definition.id)) {
    throw new Error(`Invalid plugin command id: ${JSON.stringify(definition?.id)}`)
  }
  const name = namespacePluginId(owner, definition.id)
  if (typeof definition.description !== 'string') {
    throw new Error(`Plugin command "${name}" requires a string description`)
  }
  if (typeof definition.content !== 'string' || !definition.content.trim()) {
    throw new Error(`Plugin command "${name}" requires non-empty content`)
  }
  return pluginCommands.register(owner, name, {
    name,
    description: definition.description,
    content: definition.content,
    source: 'plugin',
  })
}

/** Every registered plugin command, sorted by name so callers get a stable list. */
export function listOwnedCommands(): PluginCommandRecord[] {
  return pluginCommands.values().sort((a, b) => a.name.localeCompare(b.name))
}

export function getOwnedCommand(name: string): PluginCommandRecord | null {
  return pluginCommands.get(name) ?? null
}

export function removeOwnedCommands(owner: string): number {
  return pluginCommands.removeOwner(owner)
}

/** Test-only reset — production disposal goes through the per-plugin Disposable. */
export function resetOwnedCommandsForTesting(): void {
  pluginCommands.clear()
}
