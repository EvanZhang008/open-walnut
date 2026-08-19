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

import type { Page } from '@playwright/test'

/** A section tab by visible name. */
export function sectionTab(page: Page, name: 'All' | 'Focus' | 'Satellite' | 'Backlog' | 'Wait' | 'Recent' | 'Tasks' | 'Notes') {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Switch to a section tab (no-op when it's already active). */
export async function selectSection(
  page: Page,
  name: 'All' | 'Focus' | 'Satellite' | 'Backlog' | 'Wait' | 'Recent' | 'Tasks' | 'Notes',
): Promise<void> {
  const tab = sectionTab(page, name)
  await tab.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
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
 * the All chip (no scoping).
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
    } catch { /* ignore */ }
  }, [section, project])
}
