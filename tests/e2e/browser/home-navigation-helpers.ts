import { expect, type Page } from '@playwright/test'

export const homeToolbar = (page: Page) => page.locator('#home-task-navigation .todo-panel-toolbar')
export const homeNavigation = (page: Page) => page.locator('#home-task-navigation')

/** SPA entry through a real link click; resolves once the task toolbar is interactive. */
export async function openHome(page: Page, baseURL: string, timeout = 45_000): Promise<void> {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(homeToolbar(page).getByRole('button', { name: 'View options', exact: true })).toBeVisible({ timeout })
}

/** Opens the filter menu on its landing "View" section. */
export async function openViewMenu(page: Page): Promise<void> {
  await homeToolbar(page).getByRole('button', { name: 'View options', exact: true }).click()
  await expect(page.locator('.vd-panel [data-view-group="Show"]')).toBeVisible()
}

export async function closeViewMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.vd-panel')).toHaveCount(0)
}

/** Clicks one option of the View section (`data-view-option` key) and closes the menu. */
export async function chooseViewOption(page: Page, key: string): Promise<void> {
  await openViewMenu(page)
  await page.locator(`.vd-panel [data-view-option="${key}"]`).click()
  await closeViewMenu(page)
}

/** Which list the panel shows, read from the menu itself. */
export async function activeView(page: Page): Promise<string | null> {
  await openViewMenu(page)
  const key = await page.locator('.vd-panel [data-view-group="Show"] [aria-pressed="true"]').getAttribute('data-view-option')
  await closeViewMenu(page)
  return key
}

export async function arrange(page: Page, label: string): Promise<void> {
  await homeToolbar(page).getByRole('button', { name: 'View options', exact: true }).click()
  await page.locator('[data-rail-section="arrange"]').click()
  await page.locator('.vd-detail').getByRole('button', { name: label, exact: true }).click()
  await closeViewMenu(page)
}

export async function setShowCompleted(page: Page, on: boolean): Promise<void> {
  await homeToolbar(page).getByRole('button', { name: 'View options', exact: true }).click()
  const box = page.locator('.vd-footer .vd-check input')
  if ((await box.isChecked()) !== on) await box.click()
  await closeViewMenu(page)
}
