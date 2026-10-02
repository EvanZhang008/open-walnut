/**
 * Playwright helpers for the home task panel's Filter bar and Display menu.
 *
 * DOM contract (spec section 6): Filter button `aria-label="Filter"`; the menu
 * `.fb-menu` (`data-page="home"` or the open property's dim) with one search box
 * (`Search filters`); page one `.fb-home` with `Most used` rows
 * `.fb-quick[data-recent-dim]` and property rows `.fb-prop[data-filter-dim]`
 * (value summary in `.fb-prop-summary`), the folded properties behind the
 * `More filters` row; page two `.fb-page[data-filter-dim]` with a `Back to all
 * filters` button and value rows `.fb-opt-body[data-filter-value="<visible text>"]`
 * (Date values also carry `data-date-value`, `aria-pressed` = selected). The
 * filter row `.fb-row` has chips `[data-chip-dim]` with remove buttons
 * `.fb-chip-x`, the count `[data-testid="filter-count"]` and Clear in its tail.
 * Display button `aria-label="Display"`, menu `.dm-menu` with
 * `[data-view-option]` rows, `More views` in `.dm-views-flyout`.
 *
 * Every spec that changes a filter must call isolateUiPrefs in beforeEach:
 * `walnut-todo-filters` is mirrored by ui-prefs-sync and would leak between files.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export type FilterDimKey =
  | 'status' | 'project' | 'date' | 'source' | 'priority' | 'blocked' | 'tags' | 'sprint' | 'time'

export const STATUS_LABELS = ['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'] as const

/** Date labels to their `data-date-value` ids (4.1); ids pass through unchanged. */
const DATE_IDS: Record<string, string> = {
  'Available now': 'now', 'Any date': '', Overdue: 'overdue', 'Starting within 7 days': 'this-week', 'No dates': 'no-date',
}

const TOOLBAR = '#home-task-navigation .todo-panel-toolbar'
export const filterButton = (page: Page) => page.locator(TOOLBAR).getByRole('button', { name: 'Filter', exact: true })
export const displayButton = (page: Page) => page.locator(TOOLBAR).getByRole('button', { name: 'Display', exact: true })
export const filterMenu = (page: Page) => page.locator('.fb-menu')
export const displayMenu = (page: Page) => page.locator('.dm-menu')
export const filterRow = (page: Page) => page.locator('.fb-row')
export const viewsFlyout = (page: Page) => page.locator('.dm-views-flyout')
export const filterChip = (page: Page, dim: FilterDimKey) => page.locator(`.fb-row [data-chip-dim="${dim}"]`)
/** The property row on page one. */
export const filterDimRow = (page: Page, dim: FilterDimKey) => page.locator(`.fb-menu .fb-prop[data-filter-dim="${dim}"]`)
/** Page two while it shows `dim`. */
export const filterPage = (page: Page, dim: FilterDimKey) => page.locator(`.fb-menu .fb-page[data-filter-dim="${dim}"]`)
export const filterSearch = (page: Page) => filterMenu(page).getByRole('textbox', { name: 'Search filters' })

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Open the Filter menu on its first page (no-op when open; goes back from a property page). */
export async function openFilterMenu(page: Page): Promise<void> {
  if (!(await filterMenu(page).isVisible())) await filterButton(page).click()
  await expect(filterMenu(page)).toBeVisible()
  if ((await filterMenu(page).getAttribute('data-page')) !== 'home') {
    if (await filterSearch(page).inputValue()) await filterSearch(page).fill('')
    await filterMenu(page).getByRole('button', { name: 'Back to all filters' }).click()
  }
  await expect(filterDimRow(page, 'status')).toBeVisible()
  await settled(filterMenu(page))
}

/** Wait out a popover's 120ms entry animation (a translateY), so positions read are final. */
export async function settled(popover: Locator): Promise<void> {
  await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined))
}

/** Close the Filter menu: a chip menu first, then the search text, then the menu. */
export async function closeFilterMenu(page: Page): Promise<void> {
  const chipMenu = page.locator('.fb-chip-menu')
  if (await chipMenu.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(chipMenu).toHaveCount(0)
  }
  if ((await filterMenu(page).count()) === 0) return
  if ((await filterSearch(page).count()) && (await filterSearch(page).inputValue())) await filterSearch(page).fill('')
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
}

/** Expand `More filters` on page one (no-op when expanded or when nothing is folded). */
export async function expandMoreFilters(page: Page): Promise<void> {
  const toggle = filterMenu(page).getByRole('button', { name: /^More filters/ })
  if ((await toggle.count()) === 0) return
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Open `dim`'s page (page two) from wherever the menu is; the menu is opened when shut. */
export async function openFilterPage(page: Page, dim: FilterDimKey): Promise<Locator> {
  if ((await filterPage(page, dim).count()) > 0) return filterPage(page, dim)
  await openFilterMenu(page)
  if ((await filterDimRow(page, dim).count()) === 0 || !(await filterDimRow(page, dim).isVisible())) await expandMoreFilters(page)
  await filterDimRow(page, dim).click()
  await expect(filterPage(page, dim)).toBeVisible()
  return filterPage(page, dim)
}

function valueSelector(dim: FilterDimKey, value: string): string {
  if (dim === 'date') return `[data-date-value="${cssString(DATE_IDS[value] ?? value)}"]`
  return `[data-filter-value="${cssString(value)}"]`
}

/** The value row for `value` on `dim`'s page (page two must be open). */
export function filterValue(page: Page, dim: FilterDimKey, value: string): Locator {
  return filterPage(page, dim).locator(`.fb-opt-body${valueSelector(dim, value)}`)
}

/** Turn one value on (never off) on its page; types into the search box when the row is not drawn. */
async function turnOn(page: Page, dim: FilterDimKey, value: string): Promise<void> {
  const row = filterValue(page, dim, value)
  if ((await row.count()) === 0) {
    await filterSearch(page).fill(value)
    await expect(row).toBeVisible()
  }
  if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click()
  if (dim !== 'date' && dim !== 'blocked' && dim !== 'time') await expect(row).toHaveAttribute('aria-pressed', 'true')
}

/**
 * Set one value through the menu the way a user does: open the property's
 * page, tick the value. Without `add`, the other values of a multi-select
 * property are unticked first, so the property ends up with exactly this value
 * (`add: true` keeps them). Date takes a label or a `data-date-value` id; a
 * single-select pick closes the menu by itself. Closes the menu unless `keepOpen`.
 */
export async function addFilter(
  page: Page,
  dim: FilterDimKey,
  value: string,
  opts: { add?: boolean; keepOpen?: boolean } = {},
): Promise<void> {
  const pane = await openFilterPage(page, dim)
  if (!opts.add && dim !== 'date' && dim !== 'blocked' && dim !== 'time') {
    const on = pane.locator('.fb-opt-body[aria-pressed="true"]')
    const target = valueSelector(dim, value)
    for (const row of await on.all()) {
      const isTarget = (await row.evaluate((el, sel) => el.matches(sel), target))
      if (isTarget) continue
      if (dim === 'status' && (await on.count()) === 1) break
      await row.click()
      await expect(row).toHaveAttribute('aria-pressed', 'false')
    }
  }
  await turnOn(page, dim, value)
  if (!opts.add && dim === 'status') {
    // The value is on: now drop the ones that were locked while it was the only one.
    for (const row of await pane.locator('.fb-opt-body[aria-pressed="true"]').all()) {
      if (await row.evaluate((el, sel) => el.matches(sel), valueSelector(dim, value))) continue
      await row.click()
      await expect(row).toHaveAttribute('aria-pressed', 'false')
    }
  }
  if (!opts.keepOpen) await closeFilterMenu(page)
}

/** Remove one dimension's chip with its x; waits for the row to settle. */
export async function removeFilterChip(page: Page, dim: FilterDimKey): Promise<void> {
  const chip = filterChip(page, dim)
  await expect(chip).toHaveCount(1)
  await chip.locator('.fb-chip-x').click()
  await expect(chip).toHaveCount(0)
  // G30: a pointer removal keeps the row's height until the pointer leaves it.
  await page.mouse.move(1, 1)
}

/** Make the Status set exactly `labels` (never passes through the empty set). */
export async function setStatus(page: Page, labels: readonly string[], opts: { keepOpen?: boolean } = {}): Promise<void> {
  if (!labels.length) throw new Error('setStatus: at least one status stays on')
  await openFilterPage(page, 'status')
  const pressed = async (label: string) => (await filterValue(page, 'status', label).getAttribute('aria-pressed')) === 'true'
  for (const label of STATUS_LABELS) {
    if (labels.includes(label) && !(await pressed(label))) {
      await filterValue(page, 'status', label).click()
      await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', 'true')
    }
  }
  for (const label of STATUS_LABELS) {
    if (!labels.includes(label) && (await pressed(label))) {
      await filterValue(page, 'status', label).click()
      await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', 'false')
    }
  }
  if (!opts.keepOpen) await closeFilterMenu(page)
}

/** The filter row's `N tasks` count, or null while it is not shown. */
export async function filterRowCount(page: Page): Promise<number | null> {
  const count = page.getByTestId('filter-count')
  if ((await count.count()) === 0) return null
  const text = (await count.first().textContent()) ?? ''
  const m = text.match(/\d+/)
  return m ? Number(m[0]) : null
}

/** Open the Display menu (no-op when open). */
export async function openDisplayMenu(page: Page): Promise<void> {
  if (!(await displayMenu(page).isVisible())) await displayButton(page).click()
  await expect(displayMenu(page).locator('[data-view-group="Show"]')).toBeVisible()
  await settled(displayMenu(page))
}

/** Close the Display menu (its More views flyout first). */
export async function closeDisplayMenu(page: Page): Promise<void> {
  if (await viewsFlyout(page).isVisible()) {
    await page.keyboard.press('Escape')
    await expect(viewsFlyout(page)).toHaveCount(0)
  }
  if ((await displayMenu(page).count()) === 0) return
  await page.keyboard.press('Escape')
  await expect(displayMenu(page)).toHaveCount(0)
}

/** The `More views` row of the open Display menu. */
export const moreViewsRow = (page: Page) => displayMenu(page).getByRole('button', { name: /^More views/ })

/**
 * Click one Display option by its `data-view-option` key, opening the More
 * views flyout when the key lives there. With `choice`, clicks that segment
 * (`[data-choice]`) of a choice row. Leaves the menu open.
 */
export async function chooseDisplayOption(page: Page, key: string, choice?: string): Promise<void> {
  await openDisplayMenu(page)
  let target = displayMenu(page).locator(`[data-view-option="${cssString(key)}"]`)
  if ((await target.count()) === 0) {
    if (!(await viewsFlyout(page).isVisible())) await moreViewsRow(page).click()
    await expect(viewsFlyout(page)).toBeVisible()
    target = viewsFlyout(page).locator(`[data-view-option="${cssString(key)}"]`)
  }
  if (choice !== undefined) await target.first().locator(`[data-choice="${cssString(choice)}"]`).click()
  else await target.first().click()
}
