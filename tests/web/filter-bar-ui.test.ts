/**
 * Static render tests for the Filter bar UI (FilterButton, FilterHome,
 * FilterValuesPage, FilterBar, FilterSearchResults) against a fake
 * FilterBarController. The portalled menu itself (two pages, focus, Escape)
 * is covered by tests/e2e/browser/filter-bar*.spec.ts; here every page-level
 * and row-level contract is pinned without a browser.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { parseHTML } from 'linkedom'
import type { TaskPhase } from '../../src/core/types'
import type {
  FilterBarController,
  FilterDim,
  FilterLists,
  FilterState,
  RecentEntry,
} from '../../web/src/components/tasks/filter-bar-types'
import { buildFilterChips, clearedState, dimValues } from '../../web/src/components/tasks/filter-bar-model'
import { searchFilterDims } from '../../web/src/components/tasks/filter-bar-search'
import { FilterButton, badgeText, filterCountText, searchPlaceholder } from '../../web/src/components/tasks/FilterMenu'
import { FilterHome, takeHomeSnapshot } from '../../web/src/components/tasks/FilterHome'
import { FilterValuesPage } from '../../web/src/components/tasks/FilterValuesPage'
import { clickMode, filterOptions, type FilterWriter } from '../../web/src/components/tasks/FilterValueList'
import { FilterBar } from '../../web/src/components/tasks/FilterBar'
import { FilterSearchResults, addFromSearch } from '../../web/src/components/tasks/FilterSearchResults'
import { STATUS_OPTIONS } from '../../web/src/components/tasks/TaskStatusControl'

const CHECK_POINTS = 'points="3 8.5 6.5 12 13 4.5"'
const TWO_SOURCES = [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }]

function lists(over: Partial<FilterLists> = {}): FilterLists {
  return {
    loading: false, projects: ['Home', 'Garden'], sources: [{ id: 'local', label: 'Local' }], tags: [], sprints: [],
    showPriority: false, tagLabel: (t: string) => t.replace(/^label:/, ''), ...over,
  }
}

function controller(over: Partial<FilterBarController> & { state?: FilterState; lists?: FilterLists } = {}): FilterBarController {
  const l = over.lists ?? lists()
  const state = over.state ?? clearedState()
  return {
    state, lists: l, chips: buildFilterChips(state, l), facets: { project: { Home: 3, Garden: 2 } },
    count: 5, archiveLoading: false, search: { active: false, includeComplete: null }, viewItem: null, recent: [],
    apply: vi.fn(), clearAll: vi.fn(), openDisplay: vi.fn(), menuOpen: false, setMenuOpen: vi.fn(),
    buttonRef: { current: null }, rowRef: { current: null }, listScrollRef: { current: null },
    ...over,
  }
}

/** A static render never writes; the stub only has to satisfy the prop. */
function writer(c: FilterBarController): FilterWriter {
  return { state: () => c.state, write: vi.fn() }
}

function dom(html: string): Document {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document
}

/** Page one of the menu. */
function home(c: FilterBarController, moreOpen = false): Document {
  return dom(renderToStaticMarkup(createElement(FilterHome, {
    controller: c,
    writer: writer(c),
    snap: takeHomeSnapshot(c),
    moreOpen,
    onMoreOpenChange: () => {},
    onOpenDim: () => {},
  })))
}

/** Page two of the menu for `dim`, rows in the order the menu freezes at open. */
function page(c: FilterBarController, dim: FilterDim, query = ''): Document {
  return dom(renderToStaticMarkup(createElement(FilterValuesPage, {
    controller: c,
    writer: writer(c),
    dim,
    options: dimValues(dim, c.state, c.lists),
    query,
    onBack: () => {},
  })))
}

function bar(c: FilterBarController): Document {
  return dom(renderToStaticMarkup(createElement(FilterBar, { controller: c })))
}

const shownDims = (doc: Document) =>
  Array.from(doc.querySelectorAll('.fb-group[data-section="properties"] > .fb-prop')).map((el) => el.getAttribute('data-filter-dim'))
const foldedDims = (doc: Document) =>
  Array.from(doc.querySelectorAll('#fb-more-body .fb-prop')).map((el) => el.getAttribute('data-filter-dim'))
const summary = (doc: Document, dim: string) => doc.querySelector(`.fb-prop[data-filter-dim="${dim}"] .fb-prop-summary`)
const opt = (doc: Document, value: string) => doc.querySelector(`.fb-opt-body[data-filter-value="${value}"]`)
const pressed = (doc: Document, value: string) => opt(doc, value)?.getAttribute('aria-pressed') ?? null
const labels = (doc: Document) => Array.from(doc.querySelectorAll('.fb-opt-label')).map((el) => el.textContent)

function withState(patch: Partial<FilterState>): FilterState {
  return { ...clearedState(), ...patch }
}

describe('FilterHome: the first page', () => {
  it('C3: the defaults read Open, Any and Available now, drawn muted', () => {
    const doc = home(controller())
    expect(summary(doc, 'status')?.textContent).toBe('Open')
    expect(summary(doc, 'project')?.textContent).toBe('Any')
    expect(summary(doc, 'date')?.textContent).toBe('Available now')
    for (const dim of ['status', 'project', 'date']) expect(summary(doc, dim)?.className).toContain('is-default')
    expect(doc.querySelector('.fb-prop[data-filter-dim="status"]')?.getAttribute('title')).toBe('Status: Open')
  })

  it('C4: Status, Project, Date, Source rows, then More filters with the folded names; no Pinned; fold closed', () => {
    const doc = home(controller({ lists: lists({ sources: TWO_SOURCES }) }))
    expect(shownDims(doc)).toEqual(['status', 'project', 'date', 'source'])
    expect(doc.querySelectorAll('[data-filter-dim="pinned"]').length).toBe(0)
    const more = doc.querySelector('#fb-more-body')!
    expect(more.hasAttribute('hidden')).toBe(true)
    expect(foldedDims(doc)).toEqual(['blocked', 'time'])
    const toggle = doc.querySelector('.fb-item.fb-more-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('fb-more-body')
    expect(toggle.querySelector('.fb-item-text')?.textContent).toBe('More filters')
    expect(toggle.querySelector('.fb-prop-summary')?.textContent).toBe('Blocked, Time window')
    expect(home(controller(), true).querySelector('#fb-more-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('C4 fresh user: one group, no Most used, no group title, nothing else', () => {
    const doc = home(controller({ lists: lists({ sources: TWO_SOURCES }) }))
    expect(doc.querySelectorAll('.fb-home > .fb-group').length).toBe(1)
    expect(doc.querySelector('[data-section="most-used"]')).toBeNull()
    expect(doc.querySelector('.fb-group-title')).toBeNull()
    const items = Array.from(doc.querySelectorAll('.fb-item')).filter((el) => !el.closest('#fb-more-body'))
    expect(items.map((el) => el.getAttribute('data-filter-dim') ?? 'more')).toEqual(['status', 'project', 'date', 'source', 'more'])
  })

  it('C34: Source shows only with two sources; Priority only with show_priority, folded', () => {
    expect(home(controller()).querySelector('[data-filter-dim="source"]')).toBeNull()
    expect(home(controller({ lists: lists({ sources: TWO_SOURCES }) })).querySelector('.fb-prop[data-filter-dim="source"]')).not.toBeNull()
    expect(home(controller()).querySelector('[data-filter-dim="priority"]')).toBeNull()
    expect(foldedDims(home(controller({ lists: lists({ showPriority: true }) })))).toEqual(['priority', 'blocked', 'time'])
  })

  it('C29: a folded property that is set is promoted to the first rows, with its value; Loading while projects load', () => {
    const c = controller({ state: withState({ blocked: false, tagsAny: ['label:urgent'] }), lists: lists({ tags: ['label:urgent'] }) })
    const doc = home(c, true)
    expect(shownDims(doc)).toEqual(['status', 'project', 'date', 'blocked', 'tags'])
    expect(foldedDims(doc)).toEqual(['time'])
    expect(summary(doc, 'blocked')?.textContent).toBe('Not blocked')
    expect(summary(doc, 'tags')?.textContent).toBe('urgent')
    expect(summary(doc, 'tags')?.className).not.toContain('is-default')
    expect(doc.querySelector('.fb-more-toggle .fb-prop-summary')?.textContent).toBe('Time window')
    const loading = home(controller({ lists: lists({ loading: true, projects: [] }) }))
    expect(summary(loading, 'project')?.textContent).toBe('Loading')
  })

  it('summaries use the chip words: Home, Garden; To Do, Need Action', () => {
    const doc = home(controller({ state: withState({ projects: ['Home', 'Garden'], status: ['TODO', 'NEED_ACTION'] as TaskPhase[] }) }))
    expect(summary(doc, 'project')?.textContent).toBe('Home, Garden')
    expect(summary(doc, 'status')?.textContent).toBe('To Do, Need Action')
    expect(summary(doc, 'project')?.className).not.toContain('is-default')
  })

  it('C33 + C68: Most used rows draw ids in words, ranked by uses, pressed when on; Filter by heads the properties', () => {
    const recent: RecentEntry[] = [
      { dim: 'date', value: 'this-week' },
      { dim: 'project', value: 'Garden', uses: 3 },
      { dim: 'status', value: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] },
      { dim: 'blocked', value: 'false', uses: 2 },
      { dim: 'project', value: 'Home' },
    ]
    const doc = home(controller({ recent, state: withState({ projects: ['Garden'] }) }))
    const group = doc.querySelector('.fb-group[data-section="most-used"]')!
    expect(group.querySelector('.fb-group-title')?.textContent).toBe('Most used')
    const rows = Array.from(group.querySelectorAll('.fb-item.fb-quick'))
    expect(rows.map((r) => r.getAttribute('data-filter-value'))).toEqual([
      'Project: Garden', 'Not blocked', 'Date: Starting within 7 days', 'Status: Open, Complete',
    ])
    expect(rows.map((r) => r.getAttribute('data-recent-dim'))).toEqual(['project', 'blocked', 'date', 'status'])
    expect(rows.map((r) => r.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
    expect(rows[0].querySelector('.fb-quick-dim')?.textContent).toBe('Project')
    expect(rows[0].querySelector('.fb-quick-val')?.textContent).toBe('Garden')
    expect(rows[0].querySelector('.fb-item-check svg')).not.toBeNull()
    expect(rows[1].querySelector('.fb-item-check svg')).toBeNull()
    // Blocked names itself: no property word in front of the value.
    expect(rows[1].querySelector('.fb-quick-dim')).toBeNull()
    expect(doc.querySelector('.fb-group[data-section="properties"] .fb-group-title')?.textContent).toBe('Filter by')
    const fresh = home(controller())
    expect(fresh.querySelector('[data-section="most-used"]')).toBeNull()
    expect(fresh.body.textContent).not.toContain('Filter by')
  })

  it('C12 + C13 + C22: no native checkbox or select, no tier words, no dashes or multiplication sign', () => {
    const doc = home(controller({ lists: lists({ sources: TWO_SOURCES }), recent: [{ dim: 'project', value: 'Home' }] }), true)
    expect(doc.querySelectorAll('input[type="checkbox"], select').length).toBe(0)
    const text = doc.body.textContent ?? ''
    for (const word of ['Focus', 'Satellite', 'Backlog', 'Parked', 'tier']) expect(text).not.toContain(word)
    for (const el of Array.from(doc.querySelectorAll('[title]'))) {
      expect(el.getAttribute('title') ?? '').not.toMatch(/tier|focus|satellite|backlog|parked/i)
    }
    // En dash, em dash, multiplication sign, check mark glyph.
    expect(doc.body.innerHTML).not.toMatch(/[\u2013\u2014\u00D7\u2713]/)
  })
})

describe('FilterValuesPage: the second page', () => {
  it('C3: defaults press the three open statuses; Available now on the Date page', () => {
    const doc = page(controller(), 'status')
    expect(['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'].map((v) => pressed(doc, v)))
      .toEqual(['true', 'true', 'true', 'false', 'false'])
    const date = page(controller(), 'date')
    expect(date.querySelector('[data-date-value="now"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(Array.from(date.querySelectorAll('.fb-opt-body')).map((el) => el.getAttribute('data-date-value')))
      .toEqual(['now', '', 'overdue', 'this-week', 'no-date'])
  })

  it('head: Back to all filters, the property name, Reset only while the property is set', () => {
    const doc = page(controller(), 'project')
    const head = doc.querySelector('.fb-page[data-filter-dim="project"] .fb-page-head')!
    expect(head.querySelector('.fb-back')?.getAttribute('aria-label')).toBe('Back to all filters')
    expect(head.querySelector('.fb-page-title')?.textContent).toBe('Project')
    expect(head.querySelector('.fb-page-reset')).toBeNull()
    const set = page(controller({ state: withState({ projects: ['Garden'] }) }), 'project')
    expect(set.querySelector('.fb-page-head .fb-text-btn.fb-page-reset')?.textContent).toBe('Reset')
    expect(page(controller(), 'time').querySelector('.fb-page-title')?.textContent).toBe('Time window')
  })

  it('C28: 30 projects are 30 rows in board order, no "N more"; with Inbox, Inbox first with its title', () => {
    const names = Array.from({ length: 30 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`)
    const doc = page(controller({ lists: lists({ projects: names }) }), 'project')
    expect(labels(doc)).toEqual(names)
    expect(doc.body.textContent).not.toMatch(/\d+ more/)
    const inbox = page(controller({ lists: lists({ projects: ['', ...names] }) }), 'project')
    const first = inbox.querySelector('.fb-opt-body')!
    expect(first.getAttribute('data-filter-value')).toBe('Inbox')
    expect(first.getAttribute('title')).toBe('Tasks with no project')
    expect(inbox.querySelectorAll('.fb-opt-body').length).toBe(31)
  })

  it('G13: checklist rows draw a square, a count slot and an Only button out of the Tab order; no add square', () => {
    const doc = page(controller({ state: withState({ projects: ['Garden'] }) }), 'project')
    const garden = opt(doc, 'Garden')!
    expect(garden.getAttribute('aria-pressed')).toBe('true')
    expect(garden.querySelector('.fb-check.fb-check-box svg')).not.toBeNull()
    expect(opt(doc, 'Home')?.querySelector('.fb-check.fb-check-box svg')).toBeNull()
    expect(opt(doc, 'Home')?.querySelector('.tp-count')?.textContent).toBe('3')
    expect(garden.closest('.fb-opt')?.className).toContain('is-selected')
    const only = doc.querySelector('[aria-label="Only Home"]')!
    expect(only.className).toContain('fb-only')
    expect(only.getAttribute('tabindex')).toBe('-1')
    expect(doc.querySelectorAll('[role="checkbox"], .fb-val-add').length).toBe(0)
  })

  it('single-select rows draw a bare tick slot, no count and no Only', () => {
    const doc = page(controller(), 'date')
    expect(doc.querySelectorAll('.fb-check').length).toBe(5)
    expect(doc.querySelectorAll('.fb-check-box').length).toBe(0)
    expect(doc.querySelectorAll('.fb-only, .tp-count').length).toBe(0)
    expect(doc.querySelector('[data-date-value="now"] .fb-check svg')).not.toBeNull()
    expect(opt(doc, 'Available now')?.getAttribute('title')).toBe('Hide tasks that start later. Tasks with no start date stay.')
    const blocked = page(controller(), 'blocked')
    expect(labels(blocked)).toEqual(['Blocked', 'Not blocked'])
    expect(blocked.querySelectorAll('.fb-check-box, .fb-only').length).toBe(0)
  })

  it('C11: the last selected status is aria-disabled with the explaining title and has no Only', () => {
    const doc = page(controller({ state: withState({ status: ['COMPLETE'] as TaskPhase[] }) }), 'status')
    const v = opt(doc, 'Complete')!
    expect(v.getAttribute('aria-disabled')).toBe('true')
    expect(v.getAttribute('title')).toBe('At least one status stays on')
    expect(doc.querySelector('[aria-label="Only Complete"]')).toBeNull()
    expect(doc.querySelector('[aria-label="Only To Do"]')).not.toBeNull()
  })

  it('C61 + C50 + F04: a tick only on selected values; the STATUS_OPTIONS words; no phase icon', () => {
    const doc = page(controller(), 'status')
    const complete = opt(doc, 'Complete')!
    expect(complete.innerHTML).not.toContain(CHECK_POINTS)
    expect(complete.querySelector('svg')).toBeNull()
    const todo = opt(doc, 'To Do')!
    expect(todo.innerHTML.split(CHECK_POINTS).length - 1).toBe(1)
    expect(todo.querySelectorAll('svg').length).toBe(1)
    for (const o of STATUS_OPTIONS) {
      const el = opt(doc, o.label)
      expect(el?.textContent).toBe(o.label)
      expect(el?.querySelector('.fb-val-icon, .fb-item-icon')).toBeNull()
    }
    expect(labels(doc)).toEqual(['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'])
  })

  it('the search text filters the rows by label, case-insensitive; a miss says so', () => {
    const names = ['Walnut', 'iOS App', 'Project 20', 'Project 21']
    const c = controller({ lists: lists({ projects: names }) })
    expect(labels(page(c, 'project', 'project 2'))).toEqual(['Project 20', 'Project 21'])
    expect(labels(page(c, 'project', 'IOS'))).toEqual(['iOS App'])
    expect(page(c, 'project', 'zzqq').querySelector('.fb-empty')?.textContent).toBe('No match for "zzqq"')
    const opts = dimValues('project', c.state, c.lists)
    expect(filterOptions(opts, '  ').map((o) => o.label)).toEqual(names)
    expect(filterOptions(opts, 'nut').map((o) => o.label)).toEqual(['Walnut'])
  })

  it('Time: basis segments above the presets; the Custom editor only while Custom is on', () => {
    const doc = page(controller(), 'time')
    const basis = Array.from(doc.querySelectorAll('.fb-page-sub [data-time-basis]'))
    expect(basis.map((b) => b.getAttribute('role'))).toEqual(['radio', 'radio', 'radio'])
    expect(labels(doc)).toEqual(['1h', '6h', '24h', '7d', '30d', 'Custom'])
    expect(doc.querySelector('.fb-custom-time')).toBeNull()
    const custom = page(controller({ state: withState({ time: { basis: 'updated', preset: 'custom', customValue: 3, customUnit: 'days' } }) }), 'time')
    expect(custom.querySelector('.fb-custom-time input[aria-label="Custom window length"]')).not.toBeNull()
    expect(pressed(custom, 'Custom')).toBe('true')
  })

  it('C12 + C22: no native checkbox or select and no dash glyphs on any page', () => {
    const c = controller({ lists: lists({ sources: TWO_SOURCES, tags: ['label:urgent'], showPriority: true }) })
    for (const dim of ['status', 'project', 'date', 'source', 'priority', 'blocked', 'tags', 'time'] as FilterDim[]) {
      const doc = page(c, dim)
      expect(doc.querySelectorAll('input[type="checkbox"], select').length, dim).toBe(0)
      expect(doc.body.innerHTML, dim).not.toMatch(/[\u2013\u2014\u00D7\u2713]/)
    }
  })

  it('a plain click toggles a multi-select row and replaces a single-select one; placeholders name the property', () => {
    for (const dim of ['status', 'project', 'source', 'priority', 'tags', 'sprint'] as FilterDim[]) expect(clickMode(dim)).toBe('toggle')
    for (const dim of ['date', 'blocked', 'time'] as FilterDim[]) expect(clickMode(dim)).toBe('replace')
    expect(searchPlaceholder(null)).toBe('Search filters')
    expect(searchPlaceholder('project')).toBe('Search projects')
    expect(searchPlaceholder('tags')).toBe('Search tags')
    expect(searchPlaceholder('source')).toBe('Search sources')
    expect(searchPlaceholder('sprint')).toBe('Search sprints')
    expect(searchPlaceholder('status')).toBe('Search status')
  })
})

describe('FilterBar: the filter row', () => {
  it('renders nothing with no chip, menu closed, no view item, no search', () => {
    expect(renderToStaticMarkup(createElement(FilterBar, { controller: controller() }))).toBe('')
  })

  it('C55: menu open with no chips draws the "No filters yet" placeholder and no Clear', () => {
    const doc = bar(controller({ menuOpen: true }))
    const row = doc.querySelector('.fb-row')!
    expect(row.getAttribute('role')).toBe('toolbar')
    expect(row.getAttribute('aria-label')).toBe('Active filters')
    // C47: the open menu holds both chip lines, so the row never grows under it.
    expect(row.className).toContain('is-menu-open')
    expect(bar(controller({ state: withState({ projects: ['Garden'] }) })).querySelector('.fb-row')?.className).not.toContain('is-menu-open')
    expect(row.querySelector('.fb-row-empty')?.textContent).toBe('No filters yet')
    expect(row.querySelector('.fb-clear')).toBeNull()
  })

  it('C5 + C25: a Project chip with body, x, then the count and Clear in the tail outside the chips', () => {
    const doc = bar(controller({ state: withState({ projects: ['Garden'] }), count: 2 }))
    const chip = doc.querySelector('.fb-row [data-chip-dim="project"]')!
    const body = chip.querySelector('.fb-chip-body')!
    expect(body.getAttribute('aria-haspopup')).toBe('menu')
    expect(body.getAttribute('aria-label')).toBe('Project: Garden, change')
    expect(body.textContent).toBe('Project: Garden')
    const x = chip.querySelector('.fb-chip-x')!
    expect(x.getAttribute('aria-label')).toBe('Remove Project filter')
    expect(x.getAttribute('title')).toBe('Remove')
    expect(x.textContent).not.toContain('\u00D7')
    expect(x.querySelector('svg')).not.toBeNull()
    expect(doc.querySelector('[aria-label="Clear all filters"]')?.textContent).toBe('Clear')
    const count = doc.querySelector('[data-testid="filter-count"]')!
    expect(count.textContent).toBe('2 tasks')
    expect(count.getAttribute('aria-live')).toBe('polite')
    const tail = doc.querySelector('.fb-row > .fb-row-tail')!
    expect(Array.from(tail.children).map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label'))).toEqual(['filter-count', 'Clear all filters'])
    expect(doc.querySelector('.fb-row-chips [data-testid="filter-count"], .fb-row-chips .fb-clear')).toBeNull()
    expect(bar(controller({ state: withState({ projects: ['Garden'] }), count: 1 })).querySelector('[data-testid="filter-count"]')?.textContent).toBe('1 task')
  })

  it('count is empty while loading and says Loading completed while the archive arrives', () => {
    const s = withState({ projects: ['Garden'] })
    expect(bar(controller({ state: s, count: null })).querySelector('[data-testid="filter-count"]')?.textContent).toBe('')
    expect(bar(controller({ state: s, archiveLoading: true })).querySelector('[data-testid="filter-count"]')?.textContent).toBe('Loading completed')
  })

  it('C60: Blocked and Time window chips show only the value; tags drop the label: prefix', () => {
    const doc = bar(controller({
      state: withState({ blocked: false, time: { basis: 'updated', preset: '24h', customValue: 24, customUnit: 'hours' }, tagsAny: ['label:urgent'] }),
      lists: lists({ tags: ['label:urgent'] }),
    }))
    expect(doc.querySelector('[data-chip-dim="blocked"] .fb-chip-body')?.textContent).toBe('Not blocked')
    expect(doc.querySelector('[data-chip-dim="blocked"] .fb-chip-body')?.getAttribute('aria-label')).toBe('Blocked: Not blocked, change')
    expect(doc.querySelector('[data-chip-dim="time"] .fb-chip-body')?.textContent).toBe('Updated in 24h')
    expect(doc.querySelector('[data-chip-dim="tags"] .fb-chip-val')?.textContent).toBe('urgent')
    expect(doc.body.textContent).not.toContain('label:')
  })

  it('C40: a chip whose value no task has is muted with the explaining title', () => {
    const doc = bar(controller({ state: withState({ projects: ['Gone'] }) }))
    const val = doc.querySelector('[data-chip-dim="project"] .fb-chip-val')!
    expect(val.className).toContain('is-missing')
    expect(val.getAttribute('title')).toBe('No task has this value now')
  })

  it('C70: View item has no x and is not a chip; search mode leads with the sentence and the Include Complete toggle', () => {
    const view = bar(controller({ viewItem: { label: 'Pinned' } }))
    const item = view.querySelector('.fb-view-item')!
    expect(item.getAttribute('aria-label')).toBe('View: Pinned, change in Display')
    expect(item.textContent).toBe('View: Pinned')
    expect(view.querySelector('.fb-chip-x')).toBeNull()
    expect(view.querySelector('.fb-clear')).toBeNull()
    const search = bar(controller({ search: { active: true, includeComplete: { count: 3, on: false, toggle: () => {} } } }))
    // F26: with no chip the lead says the search covers every task; with chips, that it uses them.
    expect(search.querySelector('.fb-row-lead')?.textContent).toBe('Searching all tasks')
    const scoped = bar(controller({ state: withState({ projects: ['Garden'] }), search: { active: true, includeComplete: null } }))
    expect(scoped.querySelector('.fb-row-lead')?.textContent).toBe('Search uses these filters')
    const toggle = search.querySelector('.fb-toggle')!
    expect(toggle.textContent).toBe('Include Complete (3)')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('FilterButton', () => {
  it('C2 + C3: no badge at 0, plain title, dialog popup; badge counts chips, 9+ past nine; is-active while set', () => {
    const idle = dom(renderToStaticMarkup(createElement(FilterButton, { controller: controller() })))
    const btn = idle.querySelector('button')!
    expect(btn.getAttribute('aria-label')).toBe('Filter')
    expect(btn.getAttribute('title')).toBe('Filter tasks')
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.className).toContain('tp-btn')
    expect(btn.className).toContain('fb-filter-btn')
    expect(btn.className).not.toContain('is-active')
    expect(btn.textContent).toBe('Filter')
    expect(idle.querySelector('[data-testid="filter-badge"]')).toBeNull()
    const two = dom(renderToStaticMarkup(createElement(FilterButton, {
      controller: controller({ state: withState({ projects: ['Garden'], date: '' }) }),
    })))
    expect(two.querySelector('button')?.getAttribute('title')).toBe('Filter tasks (2 active)')
    expect(two.querySelector('button')?.className).toContain('is-active')
    expect(two.querySelector('.tp-badge[data-testid="filter-badge"]')?.textContent).toBe('2')
    expect(badgeText(12)).toBe('9+')
    expect(filterCountText(1)).toBe('1 task')
    expect(filterCountText(37)).toBe('37 tasks')
  })
})

describe('FilterSearchResults: the first page while the search box has text', () => {
  const two = lists({ sources: TWO_SOURCES })
  function results(c: FilterBarController, query: string): Document {
    const r = searchFilterDims(query, c.state, c.lists)
    return dom(renderToStaticMarkup(createElement(FilterSearchResults, {
      controller: c, query, hits: r.hits, pinHint: r.pinHint, viewHint: r.viewHint, activeIndex: 0, alreadyOnIndex: null,
      onActiveIndexChange: () => {}, writer: writer(c),
    })))
  }

  it('C26: "gard" lists only Project Garden; "doing" finds In Progress; no match and pin hint lines', () => {
    const c = controller()
    const hits = Array.from(results(c, 'gard').querySelectorAll('[role="option"]'))
    expect(hits.map((h) => h.textContent)).toEqual(['ProjectGarden'])
    expect(hits[0].getAttribute('aria-selected')).toBe('true')
    expect(hits[0].className).toContain('fb-hit')
    expect(hits[0].className).toContain('is-active')
    expect(hits[0].getAttribute('data-filter-dim')).toBe('project')
    expect(hits[0].getAttribute('data-filter-value')).toBe('Garden')
    expect(hits[0].querySelector('.fb-item-icon svg')).not.toBeNull()
    expect(hits[0].querySelector('.fb-hit-dim')?.textContent).toBe('Project')
    expect(hits[0].querySelector('.fb-hit-value')?.textContent).toBe('Garden')
    const doing = results(c, 'doing').querySelector('[role="option"]')
    expect(doing?.getAttribute('data-filter-value')).toBe('In Progress')
    expect(results(c, 'xyz').querySelector('.fb-empty')?.textContent).toBe('No filter matches "xyz"')
    expect(results(c, 'pin').querySelector('.fb-pin-hint')?.textContent).toBe('Pinned is a view: open Display')
  })

  it('a selected hit carries is-selected and a check at the right; Blocked hits name no property', () => {
    const c = controller({ state: withState({ projects: ['Garden'] }) })
    const garden = results(c, 'gard').querySelector('[role="option"]')!
    expect(garden.className).toContain('is-selected')
    expect(garden.querySelector('.fb-item-check svg')).not.toBeNull()
    const home = results(c, 'home').querySelector('[role="option"]')!
    expect(home.className).not.toContain('is-selected')
    expect(home.querySelector('.fb-item-check svg')).toBeNull()
    const blocked = Array.from(results(c, 'blocked').querySelectorAll('[role="option"][data-filter-dim="blocked"]'))
    expect(blocked.map((h) => h.getAttribute('data-filter-value'))).toEqual(['Blocked', 'Not blocked'])
    for (const h of blocked) expect(h.querySelector('.fb-hit-dim')).toBeNull()
  })

  it('C26b: "todo" puts Source Microsoft To Do first; Enter adds it and leaves Status alone; Enter on a selected hit is a no-op', () => {
    const c = controller({ lists: two })
    const r = searchFilterDims('todo', c.state, c.lists)
    expect(r.hits[0]).toMatchObject({ dim: 'source', value: 'ms-todo' })
    const next = addFromSearch(c.state, r.hits[0])
    expect(next.sources).toEqual(['ms-todo'])
    expect(next.status).toEqual(c.state.status)
    const todo = r.hits.find((h) => h.dim === 'status')!
    expect(todo.selected).toBe(true)
    expect(addFromSearch(c.state, todo)).toBe(c.state)
  })
})
