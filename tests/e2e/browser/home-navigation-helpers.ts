import { expect, type Page } from '@playwright/test'
import {
  chooseDisplayOption,
  closeDisplayMenu,
  displayButton,
  displayMenu,
  moreViewsRow,
  openDisplayMenu,
  setStatus,
  STATUS_LABELS,
  filterValue,
  openFilterMenu,
  closeFilterMenu,
  viewsFlyout,
} from './filter-bar-helpers'

export const homeToolbar = (page: Page) => page.locator('#home-task-navigation .todo-panel-toolbar')
export const homeNavigation = (page: Page) => page.locator('#home-task-navigation')

/** SPA entry through a real link click; resolves once the task toolbar is interactive. */
export async function openHome(page: Page, baseURL: string, timeout = 45_000): Promise<void> {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(displayButton(page)).toBeVisible({ timeout })
}

/** Opens the Display menu (views, sort, group, layout) on its View group. */
export async function openViewMenu(page: Page): Promise<void> {
  await openDisplayMenu(page)
}

export async function closeViewMenu(page: Page): Promise<void> {
  await closeDisplayMenu(page)
  await expect(page.locator('.dm-menu')).toHaveCount(0)
}

/** Clicks one Display option (`data-view-option` key, More views aware) and closes the menu. */
export async function chooseViewOption(page: Page, key: string): Promise<void> {
  await chooseDisplayOption(page, key)
  await closeViewMenu(page)
}

/** Which list the panel shows, read from the Display menu itself. */
export async function activeView(page: Page): Promise<string | null> {
  await openViewMenu(page)
  const pressed = displayMenu(page).locator('[data-view-group="Show"] [aria-pressed="true"]')
  let key = (await pressed.count()) ? await pressed.first().getAttribute('data-view-option') : null
  if (!key) {
    await moreViewsRow(page).click()
    await expect(viewsFlyout(page)).toBeVisible()
    const inFlyout = viewsFlyout(page).locator('[aria-pressed="true"], [aria-checked="true"]')
    key = (await inFlyout.count()) ? await inFlyout.first().getAttribute('data-view-option') : null
  }
  await closeViewMenu(page)
  return key
}

/** Old Arrange labels to the Display rows that own them now. */
const ARRANGE: Record<string, [string, string]> = {
  Manual: ['sort', 'manual'],
  Priority: ['sort', 'priority'],
  Created: ['sort', 'date'],
  Updated: ['sort', 'updated'],
  'By project': ['group', 'project'],
  Flat: ['group', 'none'],
}

/** Sort or group the list through Display (`[data-view-option="sort"|"group"] [data-choice]`). */
export async function arrange(page: Page, label: string): Promise<void> {
  const target = ARRANGE[label]
  if (!target) throw new Error(`arrange: unknown label ${label}`)
  await chooseDisplayOption(page, target[0], target[1])
  // Projects with their own order ask before one sort replaces them (G12).
  const replace = displayMenu(page).getByRole('button', { name: 'Replace', exact: true })
  if (await replace.isVisible()) await replace.click()
  await closeViewMenu(page)
}

/** Show or hide completed tasks: Status gains or loses `Complete`. */
export async function setShowCompleted(page: Page, on: boolean): Promise<void> {
  await openFilterMenu(page)
  const current: string[] = []
  for (const label of STATUS_LABELS) {
    if ((await filterValue(page, 'status', label).getAttribute('aria-pressed')) === 'true') current.push(label)
  }
  const next = on ? [...new Set([...current, 'Complete'])] : current.filter((l) => l !== 'Complete')
  if (next.length === current.length && next.every((l) => current.includes(l))) {
    await closeFilterMenu(page)
    return
  }
  await setStatus(page, next.length ? next : ['To Do', 'In Progress', 'Need Action'])
}
