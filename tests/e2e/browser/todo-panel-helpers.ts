/**
 * Shared todo-panel UI helpers for browser specs.
 *
 * The panel has TWO independent visibility axes, and a spec that wants to see a
 * given task row usually has to set both:
 *
 *   • SECTION tab (`.todo-section-tabs`): which region owns the panel. Defaults
 *     to `Focus`, where the main task list (`.todo-panel-item` rows) is NOT
 *     mounted at all. `All` is the stacked view where every region renders.
 *   • PROJECT filter (the Display menu's Project row, `.fb-menu
 *     [data-filter-dim="project"]`): which project is in scope. Defaults to no
 *     project chip (every project). `Inbox` is the value for tasks with no
 *     project. The filter row `.fb-row` shows the chip while one is set.
 *
 * Before the section tabs existed everything was always mounted, so specs only
 * had to deal with the project axis. Any spec that locates `.todo-panel-item`
 * now needs `showAllSections()` (or an explicit tab) first.
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { addFilter, chooseDisplayOption, closeDisplayMenu, closeFilterMenu, filterChip, filterValue, openFilterPage, removeFilterChip } from './filter-bar-helpers'

/**
 * Open a Projects-list project the way a user does, with a click on its name, unless
 * it is open already. The list opens only what the user opened: a project that first
 * appears after the page loaded (a new one, a rename, a move target) starts folded.
 */
export async function openListProject(page: Page, project: string): Promise<void> {
  const exact = new RegExp('^' + project.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&') + '$')
  const header = page.locator('.todo-group-project-header').filter({
    has: page.locator('.todo-group-project-name').filter({ hasText: exact }),
  }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  const chevron = header.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) {
    await header.locator('.todo-group-name-btn').click()
    await expect(chevron).toHaveClass(/expanded/)
  }
}

/** A long list draws in batches: click `scope`'s "Show more" until `target` is drawn. */
export async function showMoreUntil(scope: Locator, target: Locator, maxClicks = 60): Promise<void> {
  for (let i = 0; i < maxClicks && (await target.count()) === 0; i++) {
    const more = scope.getByRole('button', { name: 'Show more', exact: true }).first()
    if ((await more.count()) === 0) break
    await more.click()
  }
  await expect(target.first()).toBeAttached()
}

/** A tab on the tab bar, by visible name. Projects is not a tab (it is picked from the Display menu). */
export function sectionTab(page: Page, name: 'All' | 'Pinned' | 'Focus' | 'Satellite' | 'Parked' | 'Recent') {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Section names to Display `data-view-option` keys. */
const SECTION_KEYS: Record<string, string> = {
  All: 'all', Pinned: 'pinned', Focus: 'focus', Satellite: 'satellite',
  Parked: 'wait', Recent: 'recent', Tasks: 'tasks',
}

/** Switch the panel's view (no-op when it's already on it): the tab when the bar shows it, else the Display menu. */
export async function selectSection(
  page: Page,
  name: 'All' | 'Pinned' | 'Focus' | 'Satellite' | 'Parked' | 'Recent' | 'Tasks',
): Promise<void> {
  if (name !== 'Tasks') {
    const tab = sectionTab(page, name)
    if (await tab.isVisible()) {
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
      return
    }
  }
  // Without the tab (bar off, the tab taken off it, or Projects) the view is chosen on
  // Display's View page; the pick closes the menu, so the close below is a no-op then.
  await chooseDisplayOption(page, SECTION_KEYS[name])
  await closeDisplayMenu(page)
}

/** Open the home Scratchpad from the rail (no-op when it is open) and return its editor. */
export async function openScratchpad(page: Page): Promise<Locator> {
  const pane = page.getByTestId('home-companion-scratchpad')
  if (!(await pane.isVisible())) await page.getByTestId('sidebar-toggle-scratchpad').click()
  await expect(pane).toBeVisible({ timeout: 10_000 })
  const editor = pane.locator('.notes-editor .tiptap')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  return editor
}

/**
 * Put the panel in the stacked "All" section view so every region: pinned tiers,
 * Recent, the main task list, Notes: is mounted at once. This is what specs
 * written against the pre-tabs layout implicitly assumed.
 */
export async function showAllSections(page: Page): Promise<void> {
  await selectSection(page, 'All')
}

/**
 * Scope the panel to one project through the Display menu's Project page. 'All' removes the
 * Project chip, 'Inbox' is the no-project bucket, anything else a project name.
 * A plain click replaces (6.2), so this always leaves exactly that one project.
 */
export async function selectProject(page: Page, project: string): Promise<void> {
  if (project === 'All') {
    if (await page.locator('.fb-menu').isVisible()) await closeFilterMenu(page)
    if ((await filterChip(page, 'project').count()) > 0) await removeFilterChip(page, 'project')
    return
  }
  await openFilterPage(page, 'project')
  const value = filterValue(page, 'project', project)
  if ((await value.count()) > 0 && (await value.getAttribute('aria-pressed')) === 'true') {
    const pressed = page.locator('.fb-menu .fb-page[data-filter-dim="project"] .fb-opt-body[aria-pressed="true"]')
    // Already the only project: a second click would remove it.
    if ((await pressed.count()) === 1) {
      await closeFilterMenu(page)
      return
    }
  }
  await addFilter(page, 'project', project)
}

/** Both axes wide open: stacked sections + the "All" project chip. */
export async function showEverything(page: Page): Promise<void> {
  await showAllSections(page)
  await selectProject(page, 'All')
}

/**
 * Preset BOTH panel axes in localStorage before the first render: call this
 * BEFORE `page.goto()`. Preferable to clicking when a spec just needs the rows to
 * exist on load (no post-load tab dance, no waiting for the strip to mount).
 *
 * Keys must match TodoPanel's `LS_SECTION_KEY` / `LS_TAB_KEY` and the Filter
 * bar's `walnut-todo-filters` (filter-bar-persist.ts): a project writes the
 * default chip set with `projects: [p]` (the tab key stays as the bookmark), and
 * `project: ''` (no scoping) writes the default record, so no chip is set and a
 * chip another spec left on the shared fixture is not adopted. Project groups start collapsed when no fold set is
 * saved, so a context without one starts with every project open; a fold the
 * spec makes itself is kept across reloads.
 */
export async function presetPanelView(
  page: Page,
  opts: { section?: string; project?: string } = {},
): Promise<void> {
  const section = opts.section ?? 'all'
  const project = opts.project ?? ''
  await page.addInitScript(([s, p]) => {
    try {
      localStorage.setItem('walnut-todo-active-section', s as string)
      localStorage.setItem('walnut-todo-active-tab', p as string)
      // Always write the record (the defaults when no project): an ABSENT key is the
      // one ui-prefs-sync fills from the server at boot, which hands this context
      // whatever chips another spec left on the shared fixture.
      localStorage.setItem('walnut-todo-filters', JSON.stringify({
        v: 1, status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION'], projects: p ? [p === '\uE000' ? '' : p] : [], date: 'now',
        sources: [], priorities: [], tagsAny: [], sprints: [],
        time: { basis: 'updated', preset: null, customValue: 24, customUnit: 'hours' },
      }))
      // No list fold state yet: open every project the server knows at this first load
      // (a user's list starts folded; these specs were written against an open one). A
      // project created after this load starts folded, as it does for a user.
      if (localStorage.getItem('walnut-todo-list-opened') === null && location.protocol.startsWith('http')) {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', '/api/tasks?fields=list', false)
        xhr.send()
        const tasks = (JSON.parse(xhr.responseText) as { tasks?: Array<{ project?: string }> }).tasks ?? []
        localStorage.setItem('walnut-todo-list-opened', JSON.stringify([...new Set(tasks.map((t) => t.project || ''))]))
      }
    } catch { /* ignore */ }
  }, [section, project])
}

/**
 * Cut this browser context off from the fixture server's SHARED preference mirror,
 * so the spec's layout / fold state is per-context localStorage and nothing else.
 * Call BEFORE the first `page.goto()`: a `beforeEach` is the usual home.
 *
 * Why a spec that drives collapse state needs this. `web/src/utils/ui-prefs-sync.ts`
 * mirrors every `open-walnut-*` / `walnut-todo-*` localStorage key to
 * `GET|PUT /api/ui-prefs` on the ONE fixture server a whole Playwright run shares,
 * and its boot merge adopts the server's value whenever this browser has nothing of
 * its own for that key (`localVal === null`). A Playwright context starts with EMPTY
 * localStorage, so a "fresh" context is NOT fresh for any mirrored key: it inherits
 * whatever some other spec last wrote. Measured against the fixture: one context
 * writing `walnut-todo-groupBy = 'project'` comes back in a brand-new context that
 * never touched it.
 *
 * That is invisible inside one file (these files are internally sequential) and
 * lands between FILES, which still run in parallel with each other:
 * project-collapse-menu and folder-collapse-menu were handing each other their fold
 * sets, so a "survives a reload" or a "Collapse project" assertion could read the
 * other file's value and report as a product bug.
 *
 * Stubbing the route is the smallest honest fix and cuts BOTH directions at once:
 * nothing is adopted from another spec, and nothing this spec writes ever reaches
 * the server for another spec to adopt. The alternatives are worse: narrowing the
 * allowlist in ui-prefs-sync.ts would change production sync behaviour to suit a
 * test, and pinning the two files into one parallel batch would only fix today's
 * two files while the next spec to touch a mirrored key breaks again. The real
 * round trip stays covered by tests/web/routes/ui-prefs.test.ts; `/api/ui-prefs`
 * has exactly one caller in the app, so nothing else is mocked away here.
 */
export async function isolateUiPrefs(page: Page): Promise<void> {
  await page.route('**/api/ui-prefs', async (route) => {
    // GET → the first-boot shape, so the merge has nothing to adopt.
    // PUT → accepted and dropped (the real route answers `{ ok: true }`).
    const body = route.request().method() === 'GET' ? '{"prefs":{}}' : '{"ok":true}'
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
}
