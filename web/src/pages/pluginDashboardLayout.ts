export const PLUGIN_DASHBOARD_LAYOUT_KEY = 'open-walnut-plugin-dashboard-layout'

export type PluginDashboardSpan = 1 | 2 | 3

export interface PluginDashboardCell {
  key: string
  span: PluginDashboardSpan
}

export interface PluginDashboardLayout {
  version: 1
  cells: PluginDashboardCell[]
}

interface ReadableStorage {
  getItem(key: string): string | null
}

interface WritableStorage extends ReadableStorage {
  setItem(key: string, value: string): void
}

const PANEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_CELLS = 100

function span(value: unknown): PluginDashboardSpan {
  return value === 2 || value === 3 ? value : 1
}

export function normalizePluginDashboardLayout(value: unknown): PluginDashboardLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, cells: [] }
  }
  const cells = Array.isArray((value as Record<string, unknown>).cells)
    ? (value as Record<string, unknown>).cells as unknown[]
    : []
  const seen = new Set<string>()
  const normalized: PluginDashboardCell[] = []
  for (const candidate of cells) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as Record<string, unknown>
    if (typeof item.key !== 'string' || !PANEL_KEY_PATTERN.test(item.key) || seen.has(item.key)) continue
    seen.add(item.key)
    normalized.push({ key: item.key, span: span(item.span) })
    if (normalized.length >= MAX_CELLS) break
  }
  return { version: 1, cells: normalized }
}

export function loadPluginDashboardLayout(storage: ReadableStorage): PluginDashboardLayout {
  try {
    const raw = storage.getItem(PLUGIN_DASHBOARD_LAYOUT_KEY)
    return normalizePluginDashboardLayout(raw ? JSON.parse(raw) : null)
  } catch {
    return { version: 1, cells: [] }
  }
}

export function savePluginDashboardLayout(
  layout: PluginDashboardLayout,
  storage: WritableStorage,
): void {
  try {
    storage.setItem(
      PLUGIN_DASHBOARD_LAYOUT_KEY,
      JSON.stringify(normalizePluginDashboardLayout(layout)),
    )
  } catch {
    // Storage can be unavailable in private mode; the in-memory layout still works.
  }
}

export function reconcilePluginDashboardLayout(
  layout: PluginDashboardLayout,
  live: Array<{ key: string; defaultSpan?: PluginDashboardSpan }>,
): PluginDashboardLayout {
  const normalized = normalizePluginDashboardLayout(layout)
  const seen = new Set(normalized.cells.map((cell) => cell.key))
  const cells = [...normalized.cells]
  for (const panel of live) {
    if (seen.has(panel.key) || !PANEL_KEY_PATTERN.test(panel.key) || cells.length >= MAX_CELLS) continue
    seen.add(panel.key)
    cells.push({ key: panel.key, span: panel.defaultSpan ?? 1 })
  }
  if (
    cells.length === layout.cells.length
    && cells.every((cell, index) => cell.key === layout.cells[index]?.key && cell.span === layout.cells[index]?.span)
  ) return layout
  return { version: 1, cells }
}

export function movePluginDashboardCell(
  layout: PluginDashboardLayout,
  key: string,
  delta: -1 | 1,
): PluginDashboardLayout {
  const index = layout.cells.findIndex((cell) => cell.key === key)
  const nextIndex = index + delta
  if (index < 0 || nextIndex < 0 || nextIndex >= layout.cells.length) return layout
  const cells = [...layout.cells]
  ;[cells[index], cells[nextIndex]] = [cells[nextIndex], cells[index]]
  return { version: 1, cells }
}

export function removePluginDashboardCell(
  layout: PluginDashboardLayout,
  key: string,
): PluginDashboardLayout {
  const cells = layout.cells.filter((cell) => cell.key !== key)
  return cells.length === layout.cells.length ? layout : { version: 1, cells }
}

export function cyclePluginDashboardSpan(
  layout: PluginDashboardLayout,
  key: string,
): PluginDashboardLayout {
  const cells = layout.cells.map((cell) => cell.key === key
    ? { ...cell, span: (cell.span === 3 ? 1 : cell.span + 1) as PluginDashboardSpan }
    : cell)
  return cells.every((cell, index) => cell === layout.cells[index])
    ? layout
    : { version: 1, cells }
}
