/**
 * Every plugin's settings, read and changed by an AI the way a person does on the plugin's page:
 * one generic reader and writer over `plugins.<id>` in config.yaml, driven by the plugin's own
 * manifest (src/core/plugins/plugin-settings-plan.ts decides what may change). No plugin writes
 * code for it; a new plugin is covered the day it ships.
 *
 * Served by src/web/routes/plugin-settings-v1.ts to the `plugin_settings` and
 * `plugin_settings_set` ops (src/ops/plugin-settings.ts), which every agent has.
 */

import { getConfig, editPluginConfig } from '../config-manager.js'
import { emitConfigChanged } from '../config-broadcast.js'
import { maskPluginFormValues } from '../config-secret-shape.js'
import { registry } from '../integration-registry.js'
import { getUnconfiguredPlugins } from '../integration-loader.js'
import type { RegisteredPlugin, UnconfiguredPlugin } from '../integration-types.js'
import { opNamesOwnedBy } from '../../ops/registry.js'
import { describePluginFields, planPluginSettings, type PluginSchemaInput, type PluginSettingsField, type SettingsChange, type SettingsPlan } from './plugin-settings-plan.js'

export type PluginSettingsStatus = 'loaded' | 'needs-config'

/** The shared row of GET /api/integrations/settings and GET /api/v1/integrations/settings. */
export interface PluginSettingsEntry {
  id: string
  name: string
  description?: string
  status: PluginSettingsStatus
  missing: string[]
  configSchema: Record<string, unknown> | null
  uiHints: Record<string, { label?: string; help?: string }> | null
  values: Record<string, unknown>
}

type Known = { kind: 'loaded'; plugin: RegisteredPlugin } | { kind: 'needs-config'; plugin: UnconfiguredPlugin }

function knownPlugins(): Known[] {
  return [
    ...registry.getAll().filter((p) => p.id !== 'local').map((plugin) => ({ kind: 'loaded' as const, plugin })),
    ...getUnconfiguredPlugins().map((plugin) => ({ kind: 'needs-config' as const, plugin })),
  ]
}

/**
 * Every plugin a settings form can be drawn for (loaded, or waiting for required settings), with
 * its schema and its values masked. `listTails` as maskPluginFormValues takes it.
 */
export async function pluginSettingsEntries(opts: { listTails?: boolean } = {}): Promise<Array<PluginSettingsEntry & { plugin: RegisteredPlugin | null }>> {
  const stored = ((await getConfig()).plugins ?? {}) as Record<string, Record<string, unknown>>
  return knownPlugins().map(({ kind, plugin }) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    status: kind,
    missing: kind === 'needs-config' ? plugin.missing : [],
    configSchema: plugin.configSchema ?? null,
    uiHints: plugin.uiHints ?? null,
    values: maskPluginFormValues(stored[plugin.id] ?? {}, opts),
    plugin: kind === 'loaded' ? plugin : null,
  }))
}

/** Find a plugin by id, else by name (any case). Null when none or more than one matches. */
function findPlugin(ref: string): Known | { ambiguous: string[] } | null {
  const all = knownPlugins()
  const exact = all.find((k) => k.plugin.id === ref)
  if (exact) return exact
  const needle = ref.trim().toLowerCase()
  const byName = all.filter((k) => k.plugin.id.toLowerCase() === needle || k.plugin.name.toLowerCase() === needle)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) return { ambiguous: byName.map((k) => k.plugin.id) }
  return null
}

export class PluginSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

function resolve(ref: string): Known {
  const found = findPlugin(ref)
  if (found && 'ambiguous' in found) {
    throw new PluginSettingsError(409, 'ambiguous_plugin', `"${ref}" names more than one plugin: ${found.ambiguous.join(', ')}. Use its id.`, { candidates: found.ambiguous })
  }
  if (!found) {
    const ids = knownPlugins().map((k) => k.plugin.id)
    throw new PluginSettingsError(404, 'unknown_plugin',
      `No running plugin is called "${ref}". Running or waiting for settings: ${ids.join(', ') || 'none'}. A plugin that is off is turned on on its page in Apps first.`,
      { plugins: ids })
  }
  return found
}

/** Where a person finds the plugin's settings in the console. */
function placesOf(k: Known): { page: string; app?: string } {
  const page = `/apps?plugin=${encodeURIComponent(k.plugin.id)}`
  if (k.kind === 'loaded' && k.plugin.uiApp) return { page, app: `/apps/${encodeURIComponent(k.plugin.id)}` }
  return { page }
}

export interface PluginSettingsView {
  id: string
  name: string
  description?: string
  status: PluginSettingsStatus
  /** Required settings it still waits for before it runs. */
  missing: string[]
  /** Where its settings form is drawn: `app` when its own App draws it. */
  settingsIn: 'plugins' | 'app'
  page: string
  app?: string
  fields: PluginSettingsField[]
  /** Its own ops (`<id>_<name>`): some plugins change more of themselves through these. */
  tools: string[]
  skills: boolean
  /** It has an account sign-in the person completes on its page. */
  signIn: boolean
}

function schemaOf(k: Known): PluginSchemaInput {
  return { configSchema: k.plugin.configSchema ?? null, uiHints: k.plugin.uiHints ?? null }
}

function viewOf(k: Known, stored: Record<string, unknown>): PluginSettingsView {
  const loaded = k.kind === 'loaded' ? k.plugin : null
  return {
    id: k.plugin.id,
    name: k.plugin.name,
    ...(k.plugin.description ? { description: k.plugin.description } : {}),
    status: k.kind,
    missing: k.kind === 'needs-config' ? k.plugin.missing : [],
    settingsIn: loaded?.settingsIn === 'app' ? 'app' : 'plugins',
    ...placesOf(k),
    fields: describePluginFields(schemaOf(k), stored),
    tools: [...new Set([...(loaded?.tools?.map((t) => t.name) ?? []), ...(loaded ? opNamesOwnedBy(loaded.id) : [])])],
    skills: !!(loaded?.hasSkills || loaded?.registeredSkills),
    signIn: !!loaded?.connection,
  }
}

function sectionOf(plugins: Record<string, unknown>, id: string): Record<string, unknown> {
  const section = Object.hasOwn(plugins, id) ? plugins[id] : undefined
  return section && typeof section === 'object' && !Array.isArray(section) ? section as Record<string, unknown> : {}
}

async function storedOf(id: string): Promise<Record<string, unknown>> {
  return sectionOf(((await getConfig()).plugins ?? {}) as Record<string, unknown>, id)
}

/** Every plugin, one line each: what an AI picks from. */
export async function listPluginSettings(): Promise<Array<Pick<PluginSettingsView, 'id' | 'name' | 'status' | 'missing' | 'page'> & { settings: number }>> {
  const config = ((await getConfig()).plugins ?? {}) as Record<string, unknown>
  return knownPlugins().map((k) => {
    const v = viewOf(k, sectionOf(config, k.plugin.id))
    return { id: v.id, name: v.name, status: v.status, missing: v.missing, page: v.page, settings: v.fields.length }
  })
}

export async function readPluginSettings(ref: string): Promise<PluginSettingsView> {
  const k = resolve(ref)
  return viewOf(k, await storedOf(k.plugin.id))
}

export interface PluginSettingsResult extends Omit<SettingsPlan, 'next'> {
  plugin: string
  name: string
  written: boolean
  page: string
}

/**
 * Apply one change to a plugin's settings, all or nothing, under the config write lock. A refusal
 * (`refused` or `needsPerson` not empty) writes nothing. A write tells every open console and the
 * plugin itself (`config:changed`), the same event a Save on the page sends.
 */
export async function applyPluginSettings(ref: string, change: SettingsChange, opts: { by: string }): Promise<PluginSettingsResult> {
  const k = resolve(ref)
  const id = k.plugin.id
  let plan: SettingsPlan | null = null
  const { config: next, changed } = await editPluginConfig(id, (current) => {
    plan = planPluginSettings(id, schemaOf(k), current, change)
    return plan.next
  })
  const done = plan as SettingsPlan | null
  if (!done) throw new Error('plugin settings plan did not run')
  if (changed) emitConfigChanged({ plugins: { [id]: next } }, ['web-ui', 'plugin-config-reload'], { source: opts.by })
  const { next: _next, ...rest } = done
  return { plugin: id, name: k.plugin.name, written: changed, page: placesOf(k).page, ...rest }
}
