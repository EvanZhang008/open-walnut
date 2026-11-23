/**
 * The Apps home screen's model (experiment `apps_home`): every installed thing, built in or a
 * plugin, as ONE kind of item, and the rules that decide what the Installed view shows.
 *
 * Two levels (Evan, 2026-11-23, design option A): the Sidebar is the first level, the apps he
 * keeps at hand; the Apps page's Installed is the second, everything installed, like Launchpad,
 * opening on Recently used. Each item has ONE main action (Open, or Set up / Settings when it has
 * nothing to open now) and the same menu; its details page holds everything else.
 *
 * No React here: unit tested in tests/web/apps-home-model.test.ts.
 */
import { PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER, type PluginCategoryId } from './categories'
import type { CardTone } from './plugin-store-model'

export type AppsTab = 'installed' | 'store'
export type AppsScope = 'recent' | 'all'
export type AppsLayout = 'icons' | 'list'
export type AppsSort = 'name' | 'category'
/** The Installed view's chips: everything, one kind, where it sits, or one plugin category. */
export type InstalledFilter = 'all' | 'plugins' | 'builtin' | 'sidebar' | 'background' | PluginCategoryId

export const isAppsTab = (v: unknown): v is AppsTab => v === 'installed' || v === 'store'
export const isAppsScope = (v: unknown): v is AppsScope => v === 'recent' || v === 'all'
export const isAppsLayout = (v: unknown): v is AppsLayout => v === 'icons' || v === 'list'
export const isAppsSort = (v: unknown): v is AppsSort => v === 'name' || v === 'category'
export function isInstalledFilter(v: unknown): v is InstalledFilter {
  return v === 'all' || v === 'plugins' || v === 'builtin' || v === 'sidebar' || v === 'background'
    || (PLUGIN_CATEGORY_ORDER as readonly unknown[]).includes(v)
}

/** How many apps Recently used shows (the activity record keeps as many). */
export const RECENT_SHOWN = 12

/** What a press on the item does: open its screen, or its details page under one of two names. */
export type HomePrimary = 'open' | 'setup' | 'settings'

export const PRIMARY_LABEL: Readonly<Record<HomePrimary, string>> = {
  open: 'Open',
  setup: 'Set up',
  settings: 'Settings',
}

export interface HomeItem {
  /** Stable per item: a built-in entry's id (`notes`, `org`) or a plugin's id. */
  id: string
  kind: 'builtin' | 'plugin'
  title: string
  line: string
  /** A plugin's category, or the category of the plugin a built-in holds (Calendar: time). */
  category?: PluginCategoryId
  /** Where Open goes; absent when there is nothing to open (a plugin without a screen, one that is off). */
  openPath?: string
  /** The activity keys that count as using it, the first one recorded when it is opened here. */
  useKeys: readonly string[]
  /** Some part of it is on the Sidebar. */
  onSidebar: boolean
  /** It can never leave the Sidebar (Home, Settings). */
  locked: boolean
  /** How many parts can sit on the Sidebar, and how many do: a menu toggles one, the details page several. */
  sidebarParts: { total: number; shown: number }
  /** Its details page. */
  detail: { kind: 'plugin' | 'app'; id: string }
  /** The one status, as the card had it. */
  status: { text: string; tone: CardTone }
  /** A plugin with no screen: it works in the background (task sync, a tunnel). */
  background: boolean
  /** Off, or not runnable here: drawn quieter. */
  dim: boolean
  /** What a search finds it by besides its title and line (a held plugin's words, its parts). */
  searchText: readonly string[]
}

/** Needs the person: drawn as one small dot on its icon (UI rule 17). */
export function needsAttention(item: Pick<HomeItem, 'status'>): boolean {
  return item.status.tone === 'warn' || item.status.tone === 'bad'
}

/** The one main action: Open while there is a screen to open, else its details page. */
export function primaryOf(item: Pick<HomeItem, 'openPath' | 'status'>): HomePrimary {
  if (item.status.tone === 'warn') return 'setup'
  if (item.openPath && item.status.tone !== 'bad') return 'open'
  return 'settings'
}

export function matchesQuery(item: Pick<HomeItem, 'title' | 'line' | 'searchText' | 'id'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.title, item.line, item.id, ...item.searchText].some((text) => text.toLowerCase().includes(q))
}

export function matchesFilter(item: HomeItem, filter: InstalledFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'plugins': return item.kind === 'plugin'
    case 'builtin': return item.kind === 'builtin'
    case 'sidebar': return item.onSidebar
    case 'background': return item.background
    default: return item.category === filter
  }
}

/** The category chips worth drawing: only categories some item has. */
export function presentCategories(items: readonly HomeItem[]): PluginCategoryId[] {
  return PLUGIN_CATEGORY_ORDER.filter((category) => items.some((item) => item.category === category))
}

/** A kept chip whose items are gone for now (a category with no plugin left) shows All; the choice stays kept. */
export function effectiveFilter(kept: InstalledFilter, items: readonly HomeItem[], loaded: boolean): InstalledFilter {
  if (!loaded || !(PLUGIN_CATEGORY_ORDER as readonly string[]).includes(kept)) return kept
  return presentCategories(items).includes(kept as PluginCategoryId) ? kept : 'all'
}

const byTitle = (a: HomeItem, b: HomeItem) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)

/**
 * Recently used: the pinned ones first (experiment apps_stay_open's page pins, in their order),
 * then the used ones, most recent first, each item once however many of its keys were used.
 * Installing is not using: an item nobody opened is not here.
 */
export function recentItems(items: readonly HomeItem[], recentKeys: readonly string[], pinnedKeys: readonly string[] = [], limit = RECENT_SHOWN): HomeItem[] {
  const byKey = new Map<string, HomeItem>()
  for (const item of items) for (const key of item.useKeys) if (!byKey.has(key)) byKey.set(key, item)
  const out: HomeItem[] = []
  const seen = new Set<string>()
  for (const key of [...pinnedKeys, ...recentKeys]) {
    const item = byKey.get(key)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

export interface HomeGroup { id: string; title: string; items: HomeItem[] }

/**
 * All, sorted: by name as one group, or by category, the built-ins first (as the Sidebar draws
 * them), then each plugin category in the store's order.
 */
export function sortedGroups(items: readonly HomeItem[], sort: AppsSort): HomeGroup[] {
  if (sort === 'name') return [{ id: 'all', title: '', items: [...items].sort(byTitle) }]
  const groups: HomeGroup[] = []
  const builtins = items.filter((item) => item.kind === 'builtin' && !item.category)
  // Built-ins of no category ("General"), not "Built-in": Calendar and Mail are built-ins too, under their categories, as their chips have them.
  if (builtins.length) groups.push({ id: 'general', title: 'General', items: builtins })
  for (const category of PLUGIN_CATEGORY_ORDER) {
    const inIt = items.filter((item) => item.category === category)
    if (inIt.length) groups.push({ id: category, title: PLUGIN_CATEGORY_LABELS[category], items: [...inIt].sort(byTitle) })
  }
  return groups
}
