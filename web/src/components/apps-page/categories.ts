/**
 * The Apps page's groups. A plugin's category comes from the server's registry row
 * (its manifest `category`, else the catalog's, else what it does: see
 * src/core/plugins/plugin-category.ts); an older server sends none, which reads as
 * `other`. The chips at the top filter the page to one group.
 */
export const PLUGIN_CATEGORY_ORDER = ['communication', 'tasks', 'time', 'developer', 'other'] as const
export type PluginCategoryId = typeof PLUGIN_CATEGORY_ORDER[number]

export const PLUGIN_CATEGORY_LABELS: Readonly<Record<PluginCategoryId, string>> = {
  communication: 'Mail & chat',
  tasks: 'Tasks & sync',
  time: 'Time & focus',
  developer: 'Developer',
  other: 'More',
}

/** What the page shows: everything, one section, or one plugin group. */
export type AppsFilter = 'all' | 'builtin' | 'get' | PluginCategoryId

export function categoryOf(row: { category?: string }): PluginCategoryId {
  return (PLUGIN_CATEGORY_ORDER as readonly string[]).includes(row.category ?? '')
    ? row.category as PluginCategoryId
    : 'other'
}

/** Case-insensitive match on what a person would type: the name, the id, the description. */
export function pluginMatches(row: { id: string; name: string; description?: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q)
    || (row.description ?? '').toLowerCase().includes(q)
}
