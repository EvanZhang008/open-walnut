/**
 * The Apps home screen's model (experiment apps_home): one kind of item for a built-in app and a
 * plugin, the chips, Recently used (only what was opened, the page's pins first), the sorts and
 * the one main action; and the activity record's used-only write the page relies on.
 */
import { describe, expect, it } from 'vitest'
import {
  effectiveFilter, isInstalledFilter, matchesFilter, matchesQuery, needsAttention, presentCategories, primaryOf,
  recentItems, sortedGroups, type HomeItem,
} from '../../web/src/components/apps-page/apps-home-model.js'
import { builtinHomeEntry, homeEntries, pluginHomeEntry, pluginUseKey } from '../../web/src/components/apps-page/home-items.js'
import type { BuiltinEntry } from '../../web/src/components/apps-page/builtin-apps.js'
import type { RegistryRow } from '../../web/src/components/apps-page/plugin-store-model.js'
import type { RegisteredApp } from '../../web/src/apps/registry.js'
import { createAppActivity, noteAppUsed, openAppActivity } from '../../web/src/apps/preferences.js'
import { EXPERIMENTAL_FEATURES, experimentalEnabled } from '../../src/core/experimental.js'

function item(id: string, over: Partial<HomeItem> = {}): HomeItem {
  return {
    id, kind: 'plugin', title: id[0].toUpperCase() + id.slice(1), line: '', useKeys: [`plugin:${id}:main`, `plugin:${id}`],
    onSidebar: false, locked: false, sidebarParts: { total: 1, shown: 0 }, detail: { kind: 'plugin', id },
    status: { text: 'On', tone: 'on' }, background: false, dim: false, searchText: [], openPath: `/apps/${id}`, category: 'other',
    ...over,
  }
}

const entry = (over: Partial<BuiltinEntry> = {}): BuiltinEntry => ({
  key: 'core:notes', id: 'notes', title: 'Notes', line: 'Your notes vault', tint: '#E8A800', openPath: '/notes', shown: true,
  parts: [
    { key: 'core:notes', id: 'notes', title: 'Notes', kind: 'page', shown: true, path: '/notes' },
    { key: 'rail:home-scratchpad', id: 'home-scratchpad', title: 'Scratchpad', kind: 'side-bar', shown: false, path: '/', line: 'A quick note pad' },
  ],
  ...over,
})

const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
  id: 'jira', name: 'Jira', description: 'Two-way task sync with Jira', source: { kind: 'builtin' }, installed: true, status: 'active',
  builtin: true, configurable: true, catalog: false, toggleable: true, category: 'tasks', ...over,
})

describe('the experiment', () => {
  it('is registered off: an install that never chose it keeps the page it has', () => {
    expect(EXPERIMENTAL_FEATURES.find((f) => f.id === 'apps_home')?.default).toBe(false)
    expect(experimentalEnabled(undefined, 'apps_home')).toBe(false)
  })
})

describe('items', () => {
  it('a built-in app is one item with every part: its sidebar count, its search words, its use keys', () => {
    const { item: notes } = builtinHomeEntry(entry(), undefined, undefined, undefined)
    expect(notes).toMatchObject({ kind: 'builtin', openPath: '/notes', onSidebar: true, sidebarParts: { total: 2, shown: 1 }, detail: { kind: 'app', id: 'core:notes' } })
    expect(notes.useKeys).toEqual(['core:notes', 'rail:home-scratchpad'])
    expect(matchesQuery(notes, 'scratch')).toBe(true)
  })

  it('a built-in whose plugin is off has nothing to open, and one that holds a plugin opens the plugin\'s page', () => {
    expect(builtinHomeEntry(entry({ pluginOff: true }), undefined, undefined, undefined).item.openPath).toBeUndefined()
    const held = builtinHomeEntry(entry({ key: 'core:calendar', id: 'calendar' }), row({ id: 'calendar', category: 'time' }), { status: { text: 'Needs setup', tone: 'warn' }, parts: [] }, { category: 'time', text: ['Calendar plugin'] })
    expect(held.item).toMatchObject({ category: 'time', detail: { kind: 'plugin', id: 'calendar' }, status: { tone: 'warn' } })
    expect(held.item.useKeys).toContain(pluginUseKey('calendar'))
  })

  it('a plugin without a screen works in the background and goes to its page', () => {
    const jira = pluginHomeEntry(row({ hasUi: false }), [], { status: { text: 'On', tone: 'on' }, parts: [] }, new Set()).item
    expect(jira).toMatchObject({ background: true, category: 'tasks' })
    expect(jira.openPath).toBeUndefined()
    expect(primaryOf(jira)).toBe('settings')
    // One that has a screen while it runs is not background, even while it is off.
    const off = pluginHomeEntry(row({ id: 'time', status: 'disabled', hasUi: true }), [], { status: { text: 'Off', tone: 'off' }, parts: [] }, new Set()).item
    expect(off).toMatchObject({ background: false, dim: true })
    // The registry names only the plugins with a screen: one it does not name works in the background.
    expect(pluginHomeEntry(row({ id: 'quiet' }), [], { status: { text: 'On', tone: 'on' }, parts: [] }, new Set()).item.background).toBe(true)
    // An App that registered makes it a plugin with a screen, whatever the row says.
    expect(pluginHomeEntry(row({ id: 'live' }), [{ key: 'plugin:live:main', path: '/apps/live', title: 'Live' } as RegisteredApp], { status: { text: 'On', tone: 'on' }, parts: [] }, new Set()).item.background).toBe(false)
  })

  it('a plugin with an App opens it, and the App on the Sidebar marks the item', () => {
    const app = { key: 'plugin:time:main', path: '/apps/time', title: 'Time' } as RegisteredApp
    const time = pluginHomeEntry(row({ id: 'time', name: 'Time' }), [app], { status: { text: 'On', tone: 'on' }, parts: [] }, new Set([app.key])).item
    expect(time).toMatchObject({ openPath: '/apps/time', onSidebar: true, sidebarParts: { total: 1, shown: 1 } })
    expect(primaryOf(time)).toBe('open')
  })

  it('the Apps page is no item of itself', () => {
    const all = homeEntries({
      builtins: [entry(), entry({ key: 'core:apps', id: 'apps', title: 'Apps' })], folded: new Map(), heldFacts: new Map(), held: new Map(),
      plugins: [row()], appsOf: () => [], factsOf: () => ({ status: { text: 'On', tone: 'on' }, parts: [] }), onSidebar: new Set(),
    })
    expect(all.map((e) => e.item.id)).toEqual(['notes', 'jira'])
  })
})

describe('chips and search', () => {
  const items = [
    item('notes', { kind: 'builtin', category: undefined, onSidebar: true }),
    item('jira', { background: true, category: 'tasks', openPath: undefined }),
    item('slack', { category: 'communication', searchText: ['Slack MCP'] }),
  ]
  it('each chip keeps its own kind', () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) => items.filter((i) => matchesFilter(i, f)).map((i) => i.id)
    expect(pick('all')).toEqual(['notes', 'jira', 'slack'])
    expect(pick('plugins')).toEqual(['jira', 'slack'])
    expect(pick('builtin')).toEqual(['notes'])
    expect(pick('sidebar')).toEqual(['notes'])
    expect(pick('background')).toEqual(['jira'])
    expect(pick('communication')).toEqual(['slack'])
  })
  it('a category chip shows only while something has that category; a kept one with none reads All', () => {
    expect(presentCategories(items)).toEqual(['communication', 'tasks'])
    expect(effectiveFilter('time', items, true)).toBe('all')
    expect(effectiveFilter('time', items, false)).toBe('time')
    expect(effectiveFilter('plugins', items, true)).toBe('plugins')
    expect(isInstalledFilter('get')).toBe(false)
  })
  it('a search finds an item by its parts too', () => {
    expect(items.filter((i) => matchesQuery(i, 'mcp')).map((i) => i.id)).toEqual(['slack'])
  })
})

describe('Recently used', () => {
  const items = [item('time'), item('slack'), item('notes', { kind: 'builtin', useKeys: ['core:notes', 'rail:home-scratchpad'] })]
  it('is what was used, most recent first, each item once, and installing is not using', () => {
    const keys = ['rail:home-scratchpad', 'plugin:time:main', 'core:notes', 'gone:app']
    expect(recentItems(items, keys).map((i) => i.id)).toEqual(['notes', 'time'])
    expect(recentItems(items, []).map((i) => i.id)).toEqual([])
  })
  it('leads with the page\'s pins, and stops at its limit', () => {
    expect(recentItems(items, ['plugin:time:main', 'core:notes'], ['plugin:slack:main']).map((i) => i.id)).toEqual(['slack', 'time', 'notes'])
    expect(recentItems(items, ['plugin:time:main', 'core:notes'], [], 1).map((i) => i.id)).toEqual(['time'])
  })
  it('the record\'s used-only write moves Recently used and never opens a Sidebar row', () => {
    const used = noteAppUsed(createAppActivity(), 'plugin:jira')
    expect(used).toMatchObject({ open: [], recent: ['plugin:jira'] })
    expect(noteAppUsed(used, 'plugin:jira')).toBe(used)
    expect(noteAppUsed(openAppActivity(used, 'core:notes'), 'plugin:jira').recent).toEqual(['plugin:jira', 'core:notes'])
  })
})

describe('sorts and the main action', () => {
  const items = [item('zeta'), item('alpha', { category: 'tasks' }), item('notes', { kind: 'builtin', category: undefined })]
  it('by name is one list; by category puts the built-ins of no category first (General), then the store\'s order', () => {
    expect(sortedGroups(items, 'name')[0].items.map((i) => i.id)).toEqual(['alpha', 'notes', 'zeta'])
    expect(sortedGroups(items, 'category').map((g) => [g.id, g.title, g.items.map((i) => i.id)])).toMatchObject([['general', 'General', ['notes']], ['tasks', expect.any(String), ['alpha']], ['other', expect.any(String), ['zeta']]])
  })
  it('Open while there is a screen; Set up when it needs setup; Settings otherwise', () => {
    expect(primaryOf(item('a'))).toBe('open')
    expect(primaryOf(item('a', { status: { text: 'Needs setup', tone: 'warn' } }))).toBe('setup')
    expect(primaryOf(item('a', { status: { text: 'Failed', tone: 'bad' } }))).toBe('settings')
    expect(needsAttention(item('a', { status: { text: 'Failed', tone: 'bad' } }))).toBe(true)
    expect(needsAttention(item('a', { status: { text: 'Update available', tone: 'update' } }))).toBe(false)
  })
})
