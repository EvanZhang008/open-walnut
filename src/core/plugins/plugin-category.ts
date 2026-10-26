/**
 * Which Apps page group a plugin is listed under. A closed set: a value the host does
 * not know is dropped (never shown as a group of its own), and a plugin that names
 * none is placed by what it does (`derivePluginCategory`).
 */

export const PLUGIN_CATEGORIES = ['communication', 'tasks', 'time', 'developer', 'other'] as const

export type PluginCategory = typeof PLUGIN_CATEGORIES[number]

const KNOWN = new Set<string>(PLUGIN_CATEGORIES)

/** A known category, or undefined for anything else (absent, wrong type, unknown word). */
export function parsePluginCategory(value: unknown): PluginCategory | undefined {
  if (typeof value !== 'string') return undefined
  const word = value.trim().toLowerCase()
  return KNOWN.has(word) ? word as PluginCategory : undefined
}

/** The group for a plugin that names none, from what it adds and what it needs. */
export function derivePluginCategory(input: {
  id: string
  capabilities?: string[]
  adds?: string[]
  dependencyIds?: string[]
}): PluginCategory {
  if (input.capabilities?.includes('sync') || input.adds?.includes('Task sync')) return 'tasks'
  if (input.id === 'mail' || input.id.startsWith('mail-') || input.dependencyIds?.includes('mail')) return 'communication'
  return 'other'
}
