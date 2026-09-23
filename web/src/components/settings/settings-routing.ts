/**
 * Pane routing for /settings (pure; re-exported from SettingsNav).
 *
 * A pane is one visible nav entry plus every navHidden section folded under it
 * (NAV_OWNER). The URL hash names either a pane, a folded section (open its
 * owner, then scroll to it) or a plugin panel key. Anything else opens General
 * and is logged, never an error screen.
 */
import { log } from '@/utils/log'
import { CORE_SETTINGS_CONTRIBUTIONS, type CoreSettingsContribution } from './core-settings-registry'
import type { FilterEntry } from './settings-filter'

export const DEFAULT_PANE_ID = 'general'

/** Section id -> the visible entry it renders under (itself when visible). */
export const NAV_OWNER: Readonly<Record<string, string>> = (() => {
  const owner: Record<string, string> = {}
  let lastVisible = ''
  for (const entry of CORE_SETTINGS_CONTRIBUTIONS) {
    if (!entry.navHidden) lastVisible = entry.id
    owner[entry.id] = lastVisible
  }
  return owner
})()

/** Visible core panes in registry order. */
export const CORE_PANE_IDS: readonly string[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => !entry.navHidden)
  .map((entry) => entry.id)

/** Every section a core pane mounts: the lead first, then its folded sections. */
export function sectionsForPane(paneId: string): CoreSettingsContribution[] {
  return CORE_SETTINGS_CONTRIBUTIONS.filter((entry) => NAV_OWNER[entry.id] === paneId)
}

export function isCorePane(paneId: string): boolean {
  return CORE_PANE_IDS.includes(paneId)
}

export interface ResolvedPane {
  paneId: string
  /** Element to scroll to after the pane mounts; null means "top of the pane". */
  targetId: string | null
  /** False when the hash named nothing known (the General fallback). */
  known: boolean
}

function decodeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * `hash` -> which pane shows and what to scroll to.
 * `silent` skips the unknown-hash warning (used before the plugin runtime is
 * ready, when a plugin key may simply not have registered yet).
 */
export function resolvePane(
  hash: string,
  pluginKeys: readonly string[] = [],
  opts: { silent?: boolean } = {},
): ResolvedPane {
  const id = decodeHash(hash)
  if (!id) return { paneId: DEFAULT_PANE_ID, targetId: null, known: true }
  const owner = NAV_OWNER[id]
  if (owner) return { paneId: owner, targetId: owner === id ? null : id, known: true }
  if (pluginKeys.includes(id)) return { paneId: id, targetId: null, known: true }
  if (!opts.silent) log.warn('settings', 'unknown settings hash', { hash })
  return { paneId: DEFAULT_PANE_ID, targetId: null, known: false }
}

/** The plugin id half of a plugin panel key (`<pluginId>:<panelId>`). */
export function pluginIdOfKey(key: string): string | null {
  const i = key.indexOf(':')
  return i > 0 ? key.slice(0, i) : null
}

/**
 * Find-a-setting metadata for one core pane: the lead's label, title,
 * description and keywords plus every folded section's, counted under the
 * owner (a folded label or title ranks at keyword level unless the query starts it).
 */
export function corePaneFilterEntry(paneId: string): FilterEntry {
  const [lead, ...folded] = sectionsForPane(paneId)
  const names = [lead.title].filter((n) => n && n !== lead.label)
  const foldedNames = folded.flatMap((s) => [s.label, s.title]).filter((n) => n && n !== lead.label && !names.includes(n))
  return {
    key: paneId,
    kind: 'pane',
    label: lead.label,
    names,
    foldedNames: [...new Set(foldedNames)],
    descriptions: [lead.description, ...folded.map((s) => s.description)],
    keywords: [...lead.keywords, ...folded.flatMap((s) => s.keywords)],
  }
}
