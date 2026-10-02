/**
 * Playwright helpers for the home task panel's Filter bar and Display menu.
 *
 * DOM contract (spec section 6): Filter button `aria-label="Filter"`, popover
 * `.fb-menu` with rows `[data-filter-dim]` and values
 * `.fb-val[data-filter-value="<visible text>"]` (Date values also carry
 * `data-date-value`), overflow values behind `N more` / `More dates` in the
 * portalled `.fb-values-flyout`, the filter row `.fb-row` with chips
 * `[data-chip-dim]` and remove buttons `.fb-chip-x`, the count
 * `[data-testid="filter-count"]`. Display button `aria-label="Display"`, menu
 * `.dm-menu` with `[data-view-option]` rows, `More views` in `.dm-views-flyout`.
 *
 * Every spec that changes a filter must call isolateUiPrefs in beforeEach:
 * `walnut-todo-filters` is mirrored by ui-prefs-sync and would leak between files.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export type FilterDimKey =
  | 'status' | 'project' | 'date' | 'source' | 'priority' | 'blocked' | 'tags' | 'sprint' | 'time'

const MORE_DIMS: readonly FilterDimKey[] = ['priority', 'blocked', 'tags', 'sprint', 'time']
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
export const valuesFlyout = (page: Page) => page.locator('.fb-values-flyout')
export const viewsFlyout = (page: Page) => page.locator('.dm-views-flyout')
export const filterChip = (page: Page, dim: FilterDimKey) => page.locator(`.fb-row [data-chip-dim="${dim}"]`)
export const filterDimRow = (page: Page, dim: FilterDimKey) => page.locator(`.fb-menu [data-filter-dim="${dim}"]`)

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Open the Filter popover (no-op when open). */
export async function openFilterMenu(page: Page): Promise<void> {
  if (!(await filterMenu(page).isVisible())) await filterButton(page).click()
  await expect(filterMenu(page)).toBeVisible()
  await expect(filterDimRow(page, 'status')).toBeVisible()
  await settled(filterMenu(page))
}

/** Wait out a popover's 120ms entry animation (a translateY), so positions read are final. */
export async function settled(popover: Locator): Promise<void> {
  await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined))
}

/** Close the Filter popover: child flyouts first, then the search text, then the popover. */
export async function closeFilterMenu(page: Page): Promise<void> {
  for (const fly of [valuesFlyout(page), page.locator('.fb-chip-menu')]) {
    if (await fly.isVisible()) {
      await page.keyboard.press('Escape')
      await expect(fly).toHaveCount(0)
    }
  }
  if ((await filterMenu(page).count()) === 0) return
  const search = filterMenu(page).getByRole('textbox', { name: 'Search filters' })
  if ((await search.count()) && (await search.inputValue())) await search.fill('')
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
}

/** Expand `More filters` inside the open popover (no-op when expanded). */
export async function expandMoreFilters(page: Page): Promise<void> {
  const toggle = filterMenu(page).getByRole('button', { name: /^More filters/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

function valueSelector(dim: FilterDimKey, value: string): string {
  if (dim === 'date') return `[data-date-value="${cssString(DATE_IDS[value] ?? value)}"]`
  return `[data-filter-value="${cssString(value)}"]`
}

/** The value button for `value` in `dim`'s popover row (may be absent when behind `N more`). */
export function filterValue(page: Page, dim: FilterDimKey, value: string): Locator {
  return filterDimRow(page, dim).locator(`.fb-val${valueSelector(dim, value)}`)
}

/** Open the `N more` / `More dates` flyout of a row and return the flyout. */
async function openValuesFlyout(page: Page, dim: FilterDimKey): Promise<Locator> {
  const more = filterDimRow(page, dim).locator('.fb-val').filter({ hasText: /^\s*(\d+ more|More dates)\s*$/ })
  await more.first().click()
  await expect(valuesFlyout(page)).toBeVisible()
  return valuesFlyout(page)
}

/**
 * Set one value through the popover the way a user does. A plain click is the
 * replace/toggle of 6.2; `add: true` appends (Cmd/Ctrl-click) on Project and
 * Source. Values past the first 8 go through the `N more` flyout; Date takes a
 * label or a `data-date-value` id. Closes the popover unless `keepOpen`.
 */
export async function addFilter(
  page: Page,
  dim: FilterDimKey,
  value: string,
  opts: { add?: boolean; keepOpen?: boolean } = {},
): Promise<void> {
  await openFilterMenu(page)
  if (MORE_DIMS.includes(dim)) await expandMoreFilters(page)
  await expect(filterDimRow(page, dim)).toBeVisible()
  const modifiers = opts.add ? (['ControlOrMeta'] as const) : undefined
  const direct = filterValue(page, dim, value)
  if ((await direct.count()) > 0) {
    await direct.first().click({ modifiers: modifiers ? [...modifiers] : undefined })
  } else {
    const fly = await openValuesFlyout(page, dim)
    const search = fly.getByRole('textbox')
    if (dim !== 'date' && (await search.count())) await search.first().fill(value)
    await fly.locator(valueSelector(dim, value)).first().click({ modifiers: modifiers ? [...modifiers] : undefined })
    await page.keyboard.press('Escape')
    await expect(valuesFlyout(page)).toHaveCount(0)
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
  await openFilterMenu(page)
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
