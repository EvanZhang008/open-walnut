/**
 * The task panel's tab bar: which tabs exist and which ones draw.
 *
 * The bar lost its Projects and Scratchpad tabs (Projects lives in the filter menu, the
 * Scratchpad in the rail), and the user now chooses the tabs that stay. Two rules keep it
 * honest: the tab the panel is on always draws, and "Hide empty tabs" follows the All
 * view's rule for tiers (an empty built-in goes, a custom tier stays findable).
 */
import { describe, expect, it } from 'vitest'
import { tabBarTabs, visibleTabBarTabs } from '@/components/tasks/tab-bar-model'

const customs = [{ id: 'ct_a', label: 'Reading' }, { id: 'ct_b', label: 'Errands' }]
const ids = (tabs: { id: string }[]) => tabs.map((tab) => tab.id)

describe('tabBarTabs', () => {
  it('lists All, the tiers, custom tiers before Recent, and neither Projects nor the Scratchpad', () => {
    expect(ids(tabBarTabs(customs))).toEqual(['all', 'focus', 'satellite', 'backlog', 'wait', 'ct_a', 'ct_b', 'recent'])
    expect(ids(tabBarTabs())).toEqual(['all', 'focus', 'satellite', 'backlog', 'wait', 'recent'])
    expect(tabBarTabs(customs).filter((tab) => tab.custom).map((tab) => tab.label)).toEqual(['Reading', 'Errands'])
  })
})

describe('visibleTabBarTabs', () => {
  const tabs = tabBarTabs(customs)
  const full = { focus: 3, satellite: 2, backlog: 1, wait: 4, recent: 9, ct_a: 1, ct_b: 1 }

  it('draws every tab while nothing is hidden or empty', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: full, hidden: [], hideEmpty: true }))).toEqual(ids(tabs))
  })

  it('drops the tabs the user took off the bar', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: full, hidden: ['backlog', 'ct_b', 'recent'], hideEmpty: false })))
      .toEqual(['all', 'focus', 'satellite', 'wait', 'ct_a'])
  })

  it('hides an empty built-in tier and Recent, never All or a custom tier', () => {
    const counts = { focus: 0, satellite: 2, wait: 0, recent: 0, ct_a: 0 }
    expect(ids(visibleTabBarTabs(tabs, { active: 'satellite', counts, hidden: [], hideEmpty: true })))
      .toEqual(['all', 'satellite', 'ct_a', 'ct_b'])
    expect(ids(visibleTabBarTabs(tabs, { active: 'satellite', counts, hidden: [], hideEmpty: false }))).toEqual(ids(tabs))
  })

  it('always draws the tab the panel is on, hidden or empty', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'backlog', counts: { backlog: 0 }, hidden: ['backlog', 'all'], hideEmpty: true })))
      .toEqual(['backlog', 'ct_a', 'ct_b'])
  })

  it('highlights nothing on the Projects view, which is not a tab', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'tasks', counts: full, hidden: [], hideEmpty: true }))).not.toContain('tasks')
  })
})
