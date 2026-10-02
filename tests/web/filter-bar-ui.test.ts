/**
 * Static render tests for the Filter bar UI (FilterButton, FilterDimRows,
 * FilterBar, FilterSearchResults) against a fake FilterBarController.
 * Portalled overlays are covered by tests/e2e/browser/filter-bar.spec.ts;
 * here every closed-state and row-level contract is pinned without a browser.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { parseHTML } from 'linkedom'
import type { TaskPhase } from '../../src/core/types'
import type {
  FilterBarController,
  FilterLists,
  FilterState,
  RecentEntry,
} from '../../web/src/components/tasks/filter-bar-types'
import { buildFilterChips, clearedState } from '../../web/src/components/tasks/filter-bar-model'
import { searchFilterDims } from '../../web/src/components/tasks/filter-bar-search'
import { FilterButton, badgeText, filterCountText } from '../../web/src/components/tasks/FilterMenu'
import { FilterDimRows, takeFilterSnapshot } from '../../web/src/components/tasks/FilterDimRows'
import { FilterBar } from '../../web/src/components/tasks/FilterBar'
import { FilterSearchResults, addFromSearch } from '../../web/src/components/tasks/FilterSearchResults'
import { STATUS_OPTIONS } from '../../web/src/components/tasks/TaskStatusControl'

const CHECK_POINTS = 'points="3 8.5 6.5 12 13 4.5"'

function lists(over: Partial<FilterLists> = {}): FilterLists {
  return {
    loading: false,
    projects: ['Home', 'Garden'],
    sources: [{ id: 'local', label: 'Local' }],
    tags: [],
    sprints: [],
    showPriority: false,
    tagLabel: (t: string) => t.replace(/^label:/, ''),
    ...over,
  }
}

function controller(over: Partial<FilterBarController> & { state?: FilterState; lists?: FilterLists } = {}): FilterBarController {
  const l = over.lists ?? lists()
  const state = over.state ?? clearedState()
  return {
    state,
    lists: l,
    chips: buildFilterChips(state, l),
    facets: { project: { Home: 3, Garden: 2 } },
    count: 5,
    archiveLoading: false,
    search: { active: false, includeComplete: null },
    viewItem: null,
    recent: [],
    apply: vi.fn(),
    clearAll: vi.fn(),
    openDisplay: vi.fn(),
    menuOpen: false,
    setMenuOpen: vi.fn(),
    buttonRef: { current: null },
    rowRef: { current: null },
    listScrollRef: { current: null },
    ...over,
  }
}

function dom(html: string): Document {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document
}

function rows(c: FilterBarController, moreOpen = false): Document {
  const html = renderToStaticMarkup(createElement(FilterDimRows, {
    controller: c,
    snap: takeFilterSnapshot(c),
    flyout: null,
    onOpenFlyout: () => {},
    moreOpen,
    onMoreOpenChange: () => {},
  }))
  return dom(html)
}

function bar(c: FilterBarController): Document {
  return dom(renderToStaticMarkup(createElement(FilterBar, { controller: c })))
}

function pressed(doc: Document, dim: string, value: string): string | null {
  return doc.querySelector(`[data-filter-dim="${dim}"] .fb-val[data-filter-value="${value}"]`)?.getAttribute('aria-pressed') ?? null
}

function withState(patch: Partial<FilterState>): FilterState {
  return { ...clearedState(), ...patch }
}

describe('FilterDimRows: the popover rows', () => {
  it('C3: defaults press the three open statuses and Available now', () => {
    const doc = rows(controller())
    expect(pressed(doc, 'status', 'To Do')).toBe('true')
    expect(pressed(doc, 'status', 'In Progress')).toBe('true')
    expect(pressed(doc, 'status', 'Need Action')).toBe('true')
    expect(pressed(doc, 'status', 'Waiting')).toBe('false')
    expect(pressed(doc, 'status', 'Complete')).toBe('false')
    expect(doc.querySelector('[data-filter-dim="date"] [data-date-value="now"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('C4: first layer is Status, Project, Date, then More filters; no Pinned dimension; More dims folded', () => {
    const doc = rows(controller({ lists: lists({ sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }] }) }))
    const dims = Array.from(doc.querySelectorAll('.fb-dims > .fb-dim')).map((el) => el.getAttribute('data-filter-dim'))
    expect(dims).toEqual(['status', 'project', 'date', 'source'])
    expect(doc.querySelectorAll('[data-filter-dim="pinned"]').length).toBe(0)
    const more = doc.querySelector('.fb-more-body')
    expect(more?.hasAttribute('hidden')).toBe(true)
    expect(Array.from(more!.querySelectorAll('.fb-dim')).map((el) => el.getAttribute('data-filter-dim'))).toEqual(['blocked', 'time'])
    expect(doc.querySelector('.fb-more-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('C34: Source shows only with two sources, by display name; Priority only with show_priority', () => {
    expect(rows(controller()).querySelector('[data-filter-dim="source"]')).toBeNull()
    const two = rows(controller({ lists: lists({ sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }] }) }))
    expect(two.querySelector('[data-filter-dim="source"] [data-filter-value="Microsoft To Do"]')).not.toBeNull()
    expect(rows(controller()).querySelector('[data-filter-dim="priority"]')).toBeNull()
    expect(rows(controller({ lists: lists({ showPriority: true }) })).querySelector('[data-filter-dim="priority"]')).not.toBeNull()
  })

  it('C28: 30 projects draw 8 values + "22 more"; with Inbox, Inbox first and "23 more"', () => {
    const names = Array.from({ length: 30 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`)
    const doc = rows(controller({ lists: lists({ projects: names }) }))
    const vals = doc.querySelectorAll('[data-filter-dim="project"] .fb-val[data-filter-value]')
    expect(vals.length).toBe(8)
    expect(vals[0].getAttribute('data-filter-value')).toBe('Project 01')
    expect(doc.querySelector('[data-filter-dim="project"] .fb-more-btn')?.textContent).toBe('22 more')
    const inbox = rows(controller({ lists: lists({ projects: ['', ...names] }) }))
    const first = inbox.querySelector('[data-filter-dim="project"] .fb-val[data-filter-value]')
    expect(first?.getAttribute('data-filter-value')).toBe('Inbox')
    expect(inbox.querySelector('[data-filter-dim="project"] .fb-more-btn')?.textContent).toBe('23 more')
  })

  it('G13: Project values carry an "Add X" checkbox square and facet counts in a fixed slot', () => {
    const doc = rows(controller({ state: withState({ projects: ['Garden'] }) }))
    const add = doc.querySelector('[aria-label="Add Garden"]')
    expect(add?.getAttribute('role')).toBe('checkbox')
    expect(add?.getAttribute('aria-checked')).toBe('true')
    expect(doc.querySelector('[aria-label="Add Home"]')?.getAttribute('aria-checked')).toBe('false')
    expect(doc.querySelector('[data-filter-value="Home"] .tp-count')?.textContent).toBe('3')
  })

  it('C11: the last selected status is aria-disabled with the explaining title', () => {
    const doc = rows(controller({ state: withState({ status: ['COMPLETE'] as TaskPhase[] }) }))
    const v = doc.querySelector('[data-filter-dim="status"] [data-filter-value="Complete"]')
    expect(v?.getAttribute('aria-disabled')).toBe('true')
    expect(v?.getAttribute('title')).toBe('At least one status stays on')
  })

  it('C61 + C50 + F04: check only on selected values; the STATUS_OPTIONS words and no phase icon; Open label over the open block', () => {
    const doc = rows(controller())
    const complete = doc.querySelector('[data-filter-dim="status"] [data-filter-value="Complete"]')!
    expect(complete.innerHTML).not.toContain(CHECK_POINTS)
    expect(complete.querySelector('svg')).toBeNull()
    const todo = doc.querySelector('[data-filter-dim="status"] [data-filter-value="To Do"]')!
    expect(todo.innerHTML.split(CHECK_POINTS).length - 1).toBe(1)
    // F04: the check is the one selected signal, so no phase icon sits beside a value
    // (Complete's own icon read as a tick on an unselected value).
    for (const o of STATUS_OPTIONS) {
      const el = doc.querySelector(`[data-filter-dim="status"] [data-filter-value="${o.label}"]`)
      expect(el?.textContent).toBe(o.label)
      expect(el?.querySelector('.fb-val-icon')).toBeNull()
    }
    const open = doc.querySelector('.fb-status-open')!
    expect(open.querySelector('.fb-open-label')?.textContent).toBe('Open')
    expect(Array.from(open.querySelectorAll('.fb-val')).map((v) => v.getAttribute('data-filter-value'))).toEqual(['To Do', 'In Progress', 'Need Action'])
  })

  it('C29: More filters title counts the set dims; Loading projects placeholder while loading', () => {
    const doc = rows(controller({ state: withState({ blocked: false, tagsAny: ['label:urgent'] }), lists: lists({ tags: ['label:urgent'] }) }), true)
    expect(doc.querySelector('.fb-more-toggle')?.textContent).toBe('More filters (2 set)')
    expect(doc.querySelector('[data-filter-dim="tags"] [data-filter-value="urgent"]')?.getAttribute('aria-pressed')).toBe('true')
    const loading = rows(controller({ lists: lists({ loading: true, projects: [] }) }))
    expect(loading.querySelector('[data-filter-dim="project"] .fb-loading')?.textContent).toBe('Loading projects')
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
    // C47: the open popover holds both chip lines, so the row never grows under it.
    expect(row.className).toContain('is-menu-open')
    expect(bar(controller({ state: withState({ projects: ['Garden'] }) })).querySelector('.fb-row')?.className).not.toContain('is-menu-open')
    expect(row.querySelector('.fb-row-empty')?.textContent).toBe('No filters yet')
    expect(row.querySelector('.fb-clear')).toBeNull()
  })

  it('C5 + C25: a Project chip with body, x, Clear and the count', () => {
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
  it('C2 + C3: no badge at 0, plain title, dialog popup; badge counts chips, 9+ past nine', () => {
    const idle = dom(renderToStaticMarkup(createElement(FilterButton, { controller: controller() })))
    const btn = idle.querySelector('button')!
    expect(btn.getAttribute('aria-label')).toBe('Filter')
    expect(btn.getAttribute('title')).toBe('Filter tasks')
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.className).toContain('tp-btn')
    expect(btn.textContent).toBe('Filter')
    expect(idle.querySelector('[data-testid="filter-badge"]')).toBeNull()
    const two = dom(renderToStaticMarkup(createElement(FilterButton, {
      controller: controller({ state: withState({ projects: ['Garden'], date: '' }) }),
    })))
    expect(two.querySelector('button')?.getAttribute('title')).toBe('Filter tasks (2 active)')
    expect(two.querySelector('[data-testid="filter-badge"]')?.textContent).toBe('2')
    expect(badgeText(12)).toBe('9+')
    expect(filterCountText(1)).toBe('1 task')
    expect(filterCountText(37)).toBe('37 tasks')
  })
})

describe('FilterSearchResults and Recent', () => {
  const two = lists({ sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }] })
  function results(c: FilterBarController, query: string): Document {
    const r = searchFilterDims(query, c.state, c.lists)
    return dom(renderToStaticMarkup(createElement(FilterSearchResults, {
      controller: c, query, hits: r.hits, pinHint: r.pinHint, activeIndex: 0, alreadyOnIndex: null, onActiveIndexChange: () => {},
    })))
  }

  it('C26: "gard" lists only Project Garden; "doing" finds In Progress; no match and pin hint lines', () => {
    const c = controller()
    const hits = Array.from(results(c, 'gard').querySelectorAll('[role="option"]'))
    expect(hits.map((h) => h.textContent)).toEqual(['ProjectGarden'])
    expect(hits[0].getAttribute('aria-selected')).toBe('true')
    const doing = results(c, 'doing').querySelector('[role="option"]')
    expect(doing?.getAttribute('data-filter-value')).toBe('In Progress')
    expect(results(c, 'xyz').querySelector('.fb-empty')?.textContent).toBe('No filter matches "xyz"')
    expect(results(c, 'pin').querySelector('.fb-pin-hint')?.textContent).toBe('Pinned is a view: open Display')
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

  it('C33 + C68: Recent row draws ids through the registry, pressed when active; absent with no history', () => {
    const recent: RecentEntry[] = [
      { dim: 'project', value: 'Garden' },
      { dim: 'status', value: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] },
      { dim: 'date', value: 'this-week' },
    ]
    const doc = rows(controller({ recent, state: withState({ projects: ['Garden'] }) }))
    const vals = Array.from(doc.querySelectorAll('[data-filter-dim="recent"] .fb-val'))
    expect(vals.map((v) => v.textContent)).toEqual(['Project: Garden', 'Status: Open, Complete', 'Date: Starting within 7 days'])
    expect(vals.map((v) => v.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(rows(controller()).querySelector('[data-filter-dim="recent"]')).toBeNull()
  })

  it('C12 + C13 + C22: no native checkbox or select, no tier words, no dashes or multiplication sign in the first layer', () => {
    const doc = rows(controller({ lists: two }), true)
    const html = doc.body.innerHTML
    expect(doc.querySelectorAll('input[type="checkbox"], select').length).toBe(0)
    const first = Array.from(doc.querySelectorAll('.fb-dims > .fb-dim')).map((el) => el.textContent ?? '').join(' ')
    for (const word of ['Focus', 'Satellite', 'Backlog', 'Parked', 'tier']) expect(first).not.toContain(word)
    for (const el of Array.from(doc.querySelectorAll('.fb-dims > .fb-dim [title]'))) {
      expect(el.getAttribute('title') ?? '').not.toMatch(/tier|focus|satellite|backlog|parked/i)
    }
    // En dash, em dash, multiplication sign, check mark glyph.
    expect(html).not.toMatch(/[\u2013\u2014\u00D7\u2713]/)
  })
})
