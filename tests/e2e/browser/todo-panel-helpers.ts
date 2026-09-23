/**
 * Shared todo-panel UI helpers for browser specs.
 *
 * The panel has TWO independent visibility axes, and a spec that wants to see a
 * given task row usually has to set both:
 *
 *   • SECTION tab (`.todo-section-tabs`) — which region owns the panel. Defaults
 *     to `Focus`, where the main task list (`.todo-panel-item` rows) is NOT
 *     mounted at all. `All` is the stacked view where every region renders.
 *   • PROJECT chip (`.vd-cat`, inside the View dropdown) — which project is in
 *     scope. Defaults to `All` (no project scoping; before the starred system was
 *     retired this defaulted to ★, which hid non-starred rows). Project is now the
 *     ONLY grouping axis (the category layer was removed); `Inbox` is the chip for
 *     tasks with no project.
 *
 * Before the section tabs existed everything was always mounted, so specs only
 * had to deal with the project axis. Any spec that locates `.todo-panel-item`
 * now needs `showAllSections()` (or an explicit tab) first.
 */

import { expect, type Locator, type Page } from '@playwright/test'

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

/** A tab on the tab bar, by visible name. Projects is not a tab (it is picked from the filter menu). */
export function sectionTab(page: Page, name: 'All' | 'Focus' | 'Satellite' | 'Backlog' | 'Wait' | 'Recent') {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Switch the panel's view (no-op when it's already on it): the tab when the bar shows it, else the filter menu. */
export async function selectSection(
  page: Page,
  name: 'All' | 'Focus' | 'Satellite' | 'Backlog' | 'Wait' | 'Recent' | 'Tasks',
): Promise<void> {
  if (name !== 'Tasks') {
    const tab = sectionTab(page, name)
    if (await tab.isVisible()) {
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
      return
    }
  }
  // Without the tab (bar off, the tab taken off it, or Projects) the view is chosen in the filter menu's View section.
  const key = name.toLowerCase()
  await page.locator('#home-task-navigation .todo-panel-toolbar button[aria-label="View options"]').click()
  await page.locator(`.vd-panel [data-view-option="${key}"]`).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.vd-panel')).toHaveCount(0)
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
 * Put the panel in the stacked "All" section view so every region — pinned tiers,
 * Recent, the main task list, Notes — is mounted at once. This is what specs
 * written against the pre-tabs layout implicitly assumed.
 */
export async function showAllSections(page: Page): Promise<void> {
  await selectSection(page, 'All')
}

/**
 * Pick a PROJECT chip from the View dropdown. There is no top-level chip strip —
 * projects live inside the View dropdown — so specs clicking a bare
 * `.todo-panel-tab` time out. Pass 'All' for the unscoped chip, 'Inbox' for the
 * no-project bucket, or a project name.
 */
export async function selectProject(page: Page, project: string): Promise<void> {
  if (!(await page.locator('.vd-panel').isVisible())) {
    await page.getByRole('button', { name: 'View options' }).click()
  }
  // The panel is rail+detail now: the project chips render only while the
  // "Projects" rail section is active, so select it first. Re-selecting the
  // active section is a no-op state-wise, but it DOES clear any active search
  // (the detail pane swaps back from results to the section).
  await page.locator('.vd-rail-btn[data-rail-section="projects"]').click()
  // :not([data-filter-value]) — the query filter panel's project ChipGroup reuses
  // .vd-cat/.vd-cat-name markup; only the legacy nav grid chips lack data-filter-value.
  await page.locator('.vd-cat:not([data-filter-value])').filter({
    has: page.locator('.vd-cat-name').filter({ hasText: new RegExp(`^${project}$`) }),
  }).click()
  await page.keyboard.press('Escape')
}

/** Both axes wide open: stacked sections + the "All" project chip. */
export async function showEverything(page: Page): Promise<void> {
  await showAllSections(page)
  await selectProject(page, 'All')
}

/**
 * Preset BOTH panel axes in localStorage before the first render — call this
 * BEFORE `page.goto()`. Preferable to clicking when a spec just needs the rows to
 * exist on load (no post-load tab dance, no waiting for the strip to mount).
 *
 * Keys must match TodoPanel's `LS_SECTION_KEY` / `LS_TAB_KEY`. `project: ''` is
 * the All chip (no scoping). Project groups start collapsed when no fold set is
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
 * Call BEFORE the first `page.goto()` — a `beforeEach` is the usual home.
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
 * lands between FILES, which still run in parallel with each other —
 * project-collapse-menu and folder-collapse-menu were handing each other their fold
 * sets, so a "survives a reload" or a "Collapse project" assertion could read the
 * other file's value and report as a product bug.
 *
 * Stubbing the route is the smallest honest fix and cuts BOTH directions at once:
 * nothing is adopted from another spec, and nothing this spec writes ever reaches
 * the server for another spec to adopt. The alternatives are worse — narrowing the
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
