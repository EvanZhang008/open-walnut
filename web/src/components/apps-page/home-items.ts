/**
 * The Apps home screen's items, built from what the page already reads: the built-in entries
 * (one per built-in app, a held plugin folded in: Calendar, Mail) and the installed plugins at
 * the top level (a part such as `slack-mcp` stays inside its parent). Each item keeps what its
 * tile draws and its menu acts on (`HomeEntry`); `HomeItem` is the part the model reasons on.
 */
import type { RegisteredApp } from '@/apps/registry'
import type { HomeItem } from './apps-home-model'
import { partsStatus, type BuiltinEntry, type HeldPlugin } from './builtin-apps'
import { categoryOf, type PluginCategoryId } from './categories'
import type { PluginCardFacts } from './plugin-card-facts'
import type { RegistryRow } from './plugin-store-model'

export interface HomeEntry {
  item: HomeItem
  /** A built-in app's entry, its parts and their sidebar switches. */
  entry?: BuiltinEntry
  /** The plugin row: the plugin's own, or the one a built-in holds. */
  row?: RegistryRow
  /** A plugin's Apps (registered only while it runs). */
  apps: readonly RegisteredApp[]
}

/** The page's own entry: Apps is this page, so it is no item of itself. */
const SELF = 'apps'

/** The activity key a plugin's page counts as when the plugin has no screen of its own. */
export const pluginUseKey = (pluginId: string) => `plugin:${pluginId}`

export function builtinHomeEntry(
  entry: BuiltinEntry,
  row: RegistryRow | undefined,
  facts: PluginCardFacts | undefined,
  held: HeldPlugin | undefined,
): HomeEntry {
  const status = facts && facts.status.tone !== 'on' ? facts.status : partsStatus(entry)
  return {
    entry,
    row,
    apps: [],
    item: {
      id: entry.id,
      kind: 'builtin',
      title: entry.title,
      line: entry.line,
      ...(held ? { category: held.category as PluginCategoryId } : {}),
      ...(entry.pluginOff ? {} : { openPath: entry.openPath }),
      useKeys: [entry.key, ...entry.parts.map((part) => part.key).filter((key) => key !== entry.key), ...(row ? [pluginUseKey(row.id)] : [])],
      onSidebar: entry.shown,
      locked: entry.parts.every((part) => !!part.lock),
      sidebarParts: { total: entry.parts.length, shown: entry.parts.filter((part) => part.shown).length },
      detail: row ? { kind: 'plugin', id: row.id } : { kind: 'app', id: entry.key },
      status,
      background: false,
      dim: row ? row.status === 'disabled' || row.status === 'unsupported' : false,
      searchText: [...entry.parts.flatMap((part) => [part.title, part.line ?? '']), ...(held?.text ?? [])],
    },
  }
}

export function pluginHomeEntry(
  row: RegistryRow,
  apps: readonly RegisteredApp[],
  facts: PluginCardFacts,
  onSidebar: ReadonlySet<string>,
): HomeEntry {
  const app = apps[0]
  return {
    row,
    apps,
    item: {
      id: row.id,
      kind: 'plugin',
      title: row.name,
      line: row.description ?? '',
      category: categoryOf(row),
      ...(app ? { openPath: app.path } : {}),
      useKeys: [...apps.map((target) => target.key), pluginUseKey(row.id)],
      onSidebar: apps.some((target) => onSidebar.has(target.key)),
      locked: false,
      sidebarParts: { total: apps.length, shown: apps.filter((target) => onSidebar.has(target.key)).length },
      detail: { kind: 'plugin', id: row.id },
      status: facts.status,
      // No screen now and none when on (the registry names only the plugins with one: hasUi): it
      // works in the background.
      background: apps.length === 0 && !row.hasUi,
      dim: row.status === 'disabled' || row.status === 'unsupported',
      searchText: facts.parts.flatMap((part) => [part.name, part.description ?? '']),
    },
  }
}

/** Every item of Installed, built-ins in the Sidebar's order, then the plugins. */
export function homeEntries(opts: {
  builtins: readonly BuiltinEntry[]
  folded: ReadonlyMap<string, RegistryRow>
  heldFacts: ReadonlyMap<string, PluginCardFacts>
  held: ReadonlyMap<string, HeldPlugin>
  /** Installed plugins that have an item of their own (not a part, not held by a built-in). */
  plugins: readonly RegistryRow[]
  appsOf: (pluginId: string) => readonly RegisteredApp[]
  factsOf: (row: RegistryRow) => PluginCardFacts
  onSidebar: ReadonlySet<string>
}): HomeEntry[] {
  const builtins = opts.builtins
    .filter((entry) => entry.id !== SELF)
    .map((entry) => builtinHomeEntry(entry, opts.folded.get(entry.key), opts.heldFacts.get(entry.key), opts.held.get(entry.key)))
  const plugins = opts.plugins.map((row) => pluginHomeEntry(row, opts.appsOf(row.id), opts.factsOf(row), opts.onSidebar))
  return [...builtins, ...plugins]
}
