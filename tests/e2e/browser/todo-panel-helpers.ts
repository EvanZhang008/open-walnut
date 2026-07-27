/**
 * Shared todo-panel UI helpers for browser specs.
 *
 * The panel has TWO independent visibility axes, and a spec that wants to see a
 * given task row usually has to set both:
 *
 *   • SECTION tab (`.todo-section-tabs`) — which region owns the panel. Defaults
 *     to `Focus`, where the main task list (`.todo-panel-item` rows) is NOT
 *     mounted at all. `All` is the stacked view where every region renders.
 *   • CATEGORY tab (`.todo-panel-tabs`, inside the View dropdown) — which
 *     category is in scope. Defaults to ★ (Starred), which hides non-starred tasks.
 *
 * Before the section tabs existed everything was always mounted, so specs only
 * had to deal with the category axis. Any spec that locates `.todo-panel-item`
 * now needs `showAllSections()` (or an explicit tab) first.
 */

import type { Page } from '@playwright/test'

/** A section tab by visible name. */
export function sectionTab(page: Page, name: 'All' | 'Focus' | 'Satellite' | 'Wait' | 'Recent' | 'Tasks' | 'Notes') {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Switch to a section tab (no-op when it's already active). */
export async function selectSection(
  page: Page,
  name: 'All' | 'Focus' | 'Satellite' | 'Wait' | 'Recent' | 'Tasks' | 'Notes',
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
 * Pick a CATEGORY from the View dropdown. The old top-level `.todo-panel-tabs`
 * category tab strip is long gone — categories moved inside the View dropdown —
 * so specs still clicking `.todo-panel-tab` time out.
 */
export async function selectCategory(page: Page, category: string): Promise<void> {
  if (!(await page.locator('.vd-panel').isVisible())) {
    await page.getByRole('button', { name: 'View options' }).click()
  }
  await page.locator('.vd-cat').filter({
    has: page.locator('.vd-cat-name').filter({ hasText: new RegExp(`^${category}$`) }),
  }).click()
  await page.keyboard.press('Escape')
}

/** Both axes wide open: stacked sections + the "All" category. */
export async function showEverything(page: Page): Promise<void> {
  await showAllSections(page)
  await selectCategory(page, 'All')
}

/**
 * Preset BOTH panel axes in localStorage before the first render — call this
 * BEFORE `page.goto()`. Preferable to clicking when a spec just needs the rows to
 * exist on load (no post-load tab dance, no waiting for the strip to mount).
 *
 * Keys must match TodoPanel's `LS_SECTION_KEY` / `LS_TAB_KEY`.
 */
export async function presetPanelView(
  page: Page,
  opts: { section?: string; category?: string } = {},
): Promise<void> {
  const section = opts.section ?? 'all'
  const category = opts.category ?? ''
  await page.addInitScript(([s, c]) => {
    try {
      localStorage.setItem('walnut-todo-active-section', s as string)
      localStorage.setItem('walnut-todo-active-tab', c as string)
    } catch { /* ignore */ }
  }, [section, category])
}
