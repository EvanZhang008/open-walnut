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
import {
  DEFAULT_HIDDEN_TABS, DISPLAY_FIRST_LAYER_LIMIT, ROOMY_TAB_LIMIT, allViews, displayViewLayers, tabBarTabs,
  tabMenuGroups, viewLabel, viewTitle, visibleTabBarTabs,
} from '@/components/tasks/tab-bar-model'

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

const TIER_WORDS = /tier|focus|satellite|backlog|parked/i

describe('view titles (one source for Display, the flyout and the tabs)', () => {
  it('words All and Pinned without any tier name', () => {
    expect(viewTitle('all')).toBe('All: every open task on your board')
    expect(viewTitle('pinned')).toBe('Pinned: tasks you pinned to keep in front of you')
    for (const id of ['all', 'pinned']) {
      expect(viewTitle(id)).not.toMatch(TIER_WORDS)
      expect(viewLabel(id)).not.toMatch(TIER_WORDS)
    }
  })

  it('has a Projects entry that the bar itself never draws', () => {
    expect(viewTitle('tasks')).toBe('Projects: every task grouped by project, with filters applied')
    expect(viewLabel('tasks')).toBe('Projects')
    expect(ids(tabBarTabs(customs))).not.toContain('tasks')
    expect(ids(allViews(customs)).at(-1)).toBe('tasks')
  })

  it('gives every view a non-empty title, custom tiers included', () => {
    for (const view of allViews(customs)) expect(viewTitle(view.id, customs)).not.toBe('')
    expect(viewTitle('ct_a', customs)).toBe('Reading: a list of pins you made')
    // F30: no first-level title uses the word tier.
    for (const id of ['all', 'pinned', 'ct_a']) expect(viewTitle(id, customs)).not.toMatch(/tier/i)
    expect(viewTitle('nope')).toBe('')
  })

  it('keeps tabs and viewTitle on the same sentence', () => {
    for (const tab of tabBarTabs(customs)) expect(viewTitle(tab.id, customs)).toBe(tab.title)
  })
})

describe('displayViewLayers', () => {
  it('puts only All and Pinned on the first layer by default, everything else in More views', () => {
    const { first, more } = displayViewLayers([], DEFAULT_HIDDEN_TABS)
    expect(ids(first)).toEqual(['all', 'pinned'])
    expect(ids(more)).toEqual(['focus', 'satellite', 'wait', 'recent', 'tasks'])
    expect(first.map((v) => `${v.label} ${v.title}`).join(' ')).not.toMatch(TIER_WORDS)
  })

  it('follows the bar: a tab the user keeps moves to the first layer in bar order, and leaves More views', () => {
    const hidden = DEFAULT_HIDDEN_TABS.filter((id) => id !== 'focus')
    const { first, more } = displayViewLayers(customs, hidden)
    expect(ids(first)).toEqual(['all', 'pinned', 'focus', 'ct_a', 'ct_b'])
    expect(ids(more)).toEqual(['satellite', 'wait', 'recent', 'tasks'])
  })

  it('caps the first layer so 30 custom tiers spill into the flyout, keeping menu order', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `ct_${i}`, label: `Tier ${i}` }))
    const { first, more } = displayViewLayers(many, DEFAULT_HIDDEN_TABS)
    expect(first).toHaveLength(DISPLAY_FIRST_LAYER_LIMIT)
    expect(ids(first).slice(0, 3)).toEqual(['all', 'pinned', 'ct_0'])
    expect(ids(more).slice(0, 4)).toEqual(['focus', 'satellite', 'wait', `ct_${DISPLAY_FIRST_LAYER_LIMIT - 2}`])
    expect(ids(more).slice(-2)).toEqual(['recent', 'tasks'])
    expect(first.length + more.length).toBe(allViews(many).length)
  })

  it('never lists a view twice and keeps Projects out of the first layer even when nothing is hidden', () => {
    const { first, more } = displayViewLayers(customs, [])
    expect(new Set([...ids(first), ...ids(more)]).size).toBe(allViews(customs).length)
    expect(ids(first)).not.toContain('tasks')
  })
})

describe('tabMenuGroups (the bar chevron menu)', () => {
  it('lists All, Pinned and Recent above the divider and every tier under More views', () => {
    const { top, tiers } = tabMenuGroups(tabBarTabs(customs))
    expect(ids(top)).toEqual(['all', 'pinned', 'recent'])
    expect(ids(tiers)).toEqual(['focus', 'satellite', 'wait', 'ct_a', 'ct_b'])
    expect(top.map((t) => `${t.label} ${t.title}`).join(' ')).not.toMatch(TIER_WORDS)
    for (const tier of tiers) expect(tier.title).not.toBe('')
  })
})
