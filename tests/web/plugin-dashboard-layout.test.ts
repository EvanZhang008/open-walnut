import { describe, expect, it } from 'vitest'
import {
  cyclePluginDashboardSpan,
  loadPluginDashboardLayout,
  movePluginDashboardCell,
  normalizePluginDashboardLayout,
  removePluginDashboardCell,
  PLUGIN_DASHBOARD_LAYOUT_KEY,
  reconcilePluginDashboardLayout,
  savePluginDashboardLayout,
} from '../../web/src/pages/pluginDashboardLayout.js'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('Plugin Dashboard layout', () => {
  it('normalizes malformed, duplicate, and unsafe cells', () => {
    expect(normalizePluginDashboardLayout({
      version: 99,
      cells: [
        { key: 'sample:one', span: 3 },
        { key: 'sample:one', span: 1 },
        { key: '../escape:two', span: 2 },
        { key: 'sample:two', span: 99 },
      ],
    })).toEqual({
      version: 1,
      cells: [
        { key: 'sample:one', span: 3 },
        { key: 'sample:two', span: 1 },
      ],
    })
  })

  it('appends live panels while retaining missing Plugin placeholders', () => {
    const before = {
      version: 1 as const,
      cells: [{ key: 'removed:panel', span: 2 as const }],
    }
    expect(reconcilePluginDashboardLayout(before, [
      { key: 'sample:first', defaultSpan: 3 },
      { key: 'sample:second' },
    ])).toEqual({
      version: 1,
      cells: [
        { key: 'removed:panel', span: 2 },
        { key: 'sample:first', span: 3 },
        { key: 'sample:second', span: 1 },
      ],
    })
  })

  it('moves cells and cycles widths without losing identity', () => {
    const layout = {
      version: 1 as const,
      cells: [
        { key: 'sample:first', span: 1 as const },
        { key: 'sample:second', span: 3 as const },
      ],
    }
    const moved = movePluginDashboardCell(layout, 'sample:second', -1)
    expect(moved.cells.map((cell) => cell.key)).toEqual(['sample:second', 'sample:first'])
    expect(cyclePluginDashboardSpan(moved, 'sample:second').cells[0].span).toBe(1)
    expect(movePluginDashboardCell(moved, 'sample:second', -1)).toBe(moved)
    expect(removePluginDashboardCell(moved, 'sample:first').cells).toEqual([
      { key: 'sample:second', span: 3 },
    ])
    expect(removePluginDashboardCell(moved, 'missing:panel')).toBe(moved)
  })

  it('round-trips through the synced localStorage key', () => {
    const store = storage()
    const layout = {
      version: 1 as const,
      cells: [{ key: 'sample:panel', span: 2 as const }],
    }
    savePluginDashboardLayout(layout, store)

    expect(store.getItem(PLUGIN_DASHBOARD_LAYOUT_KEY)).toBe(JSON.stringify(layout))
    expect(loadPluginDashboardLayout(store)).toEqual(layout)
  })
})
