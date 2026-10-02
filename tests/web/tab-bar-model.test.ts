/**
 * The task panel's tab bar: which tabs exist and which ones draw.
 *
 * The bar lost its Projects and Scratchpad tabs (Projects lives in the filter menu, the
 * Scratchpad in the rail), and the user now chooses the tabs that stay. Two rules keep it
 * honest: the tab the panel is on always draws, and "Hide empty tabs" follows the All
 * view's rule for tiers (an empty built-in goes, a custom tier stays findable). A bar
 * nobody has customised is All and Pinned alone, and Pinned never hides for being empty.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_HIDDEN_TABS, ROOMY_TAB_LIMIT, tabBarTabs, visibleTabBarTabs } from '@/components/tasks/tab-bar-model'

const customs = [{ id: 'ct_a', label: 'Reading' }, { id: 'ct_b', label: 'Errands' }]
const ids = (tabs: { id: string }[]) => tabs.map((tab) => tab.id)

describe('tabBarTabs', () => {
  it('lists All, Pinned, the tiers, custom tiers before Recent, and neither Projects nor the Scratchpad', () => {
    expect(ids(tabBarTabs(customs))).toEqual(['all', 'pinned', 'focus', 'satellite', 'wait', 'ct_a', 'ct_b', 'recent'])
    expect(ids(tabBarTabs())).toEqual(['all', 'pinned', 'focus', 'satellite', 'wait', 'recent'])
    expect(tabBarTabs(customs).filter((tab) => tab.custom).map((tab) => tab.label)).toEqual(['Reading', 'Errands'])
  })
})

describe('visibleTabBarTabs', () => {
  const tabs = tabBarTabs(customs)
  const full = { pinned: 10, focus: 3, satellite: 2, wait: 4, recent: 9, ct_a: 1, ct_b: 1 }

  it('draws every tab while nothing is hidden or empty', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: full, hidden: [], hideEmpty: true }))).toEqual(ids(tabs))
  })

  it('drops the tabs the user took off the bar', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: full, hidden: ['wait', 'ct_b', 'recent'], hideEmpty: false })))
      .toEqual(['all', 'pinned', 'focus', 'satellite', 'ct_a'])
    // A hidden-list entry for a tab that no longer exists (the retired Backlog
    // tier, still in an old browser's storage) is simply ignored.
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: full, hidden: ['backlog'], hideEmpty: false }))).toEqual(ids(tabs))
  })

  it('hides an empty built-in tier and Recent, never All, Pinned or a custom tier', () => {
    const counts = { pinned: 2, focus: 0, satellite: 2, wait: 0, recent: 0, ct_a: 0 }
    expect(ids(visibleTabBarTabs(tabs, { active: 'satellite', counts, hidden: [], hideEmpty: true })))
      .toEqual(['all', 'pinned', 'satellite', 'ct_a', 'ct_b'])
    expect(ids(visibleTabBarTabs(tabs, { active: 'satellite', counts, hidden: [], hideEmpty: false }))).toEqual(ids(tabs))
  })

  it('a tier whose only tasks are parked (held, hidden by default) is not empty', () => {
    const counts = { pinned: 2, focus: 0, satellite: 2, wait: 0, recent: 0, ct_a: 0 }
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts, held: { focus: 1 }, hidden: [], hideEmpty: true })))
      .toEqual(['all', 'pinned', 'focus', 'satellite', 'ct_a', 'ct_b'])
    // A held count never brings back a tab the user took off the bar.
    expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts, held: { focus: 1 }, hidden: ['focus'], hideEmpty: true })))
      .toEqual(['all', 'pinned', 'satellite', 'ct_a', 'ct_b'])
  })

  it('always draws the tab the panel is on, hidden or empty', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'wait', counts: { wait: 0 }, hidden: ['wait', 'all', 'pinned'], hideEmpty: true })))
      .toEqual(['wait', 'ct_a', 'ct_b'])
  })

  it('highlights nothing on the Projects view, which is not a tab', () => {
    expect(ids(visibleTabBarTabs(tabs, { active: 'tasks', counts: full, hidden: [], hideEmpty: true }))).not.toContain('tasks')
  })

  describe('the bar nobody customised', () => {
    it('is All and Pinned, with Pinned there even when nothing is pinned', () => {
      const fresh = { active: 'all', counts: {}, hidden: DEFAULT_HIDDEN_TABS, hideEmpty: true }
      expect(ids(visibleTabBarTabs(tabBarTabs(), fresh))).toEqual(['all', 'pinned'])
    })

    it('still shows a custom tier, which the user made on purpose', () => {
      expect(ids(visibleTabBarTabs(tabs, { active: 'all', counts: {}, hidden: DEFAULT_HIDDEN_TABS, hideEmpty: true })))
        .toEqual(['all', 'pinned', 'ct_a', 'ct_b'])
    })

    it('is short enough to name every tab', () => {
      expect(visibleTabBarTabs(tabBarTabs(), { active: 'all', counts: {}, hidden: DEFAULT_HIDDEN_TABS, hideEmpty: true }).length)
        .toBeLessThanOrEqual(ROOMY_TAB_LIMIT)
    })

    it('leaves the tiers in the bar menu so they can be put back', () => {
      expect(ids(tabBarTabs()).filter((id) => !DEFAULT_HIDDEN_TABS.includes(id))).toEqual(['all', 'pinned'])
    })
  })
})
