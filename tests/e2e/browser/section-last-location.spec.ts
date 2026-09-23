/**
 * Sidebar links return the user to where they last were in a section.
 *
 * Calendar keeps its view and anchor day in `?view=&d=`, Settings keeps its pane in
 * `#hash`. Both survived reload and Back, but the sidebar linked to the bare path, so
 * the everyday way of coming back (click the icon) reset them (2026-09-23: "all panels
 * need to persist the choice … even after switch away and back"). App records each
 * section-root location (utils/last-location.ts); the sidebar links to it.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
test.setTimeout(150_000)

const rail = (page: Page, id: string) => page.getByTestId(`sidebar-core-app-${id}`)

async function gotoHome(page: Page): Promise<void> {
  await rail(page, 'home').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
}

test('Calendar comes back in the view the user left it in', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)

  await rail(page, 'calendar').click()
  await expect(page).toHaveURL(/\/calendar$/)
  const monthTab = page.getByRole('tab', { name: 'Month' })
  await expect(monthTab).toBeVisible({ timeout: 30_000 })
  await monthTab.click()
  await expect(page).toHaveURL(/\/calendar\?.*view=month/)

  // While ON Calendar, the rail icon points at the current URL (a no-op, not a reset).
  // (auto-retrying: the URL updates before React re-renders the sidebar.)
  await expect(rail(page, 'calendar')).toHaveAttribute('href', /view=month/)

  await gotoHome(page)
  // The link now carries the remembered state…
  await expect(rail(page, 'calendar')).toHaveAttribute('href', /\/calendar\?.*view=month/)
  await rail(page, 'calendar').click()
  // …and landing there shows Month, not the default Week.
  await expect(page).toHaveURL(/\/calendar\?.*view=month/)
  await expect(page.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'true')

  // Switching back to Week (the default, no param) is remembered as the cleared state.
  await page.getByRole('tab', { name: 'Week' }).click()
  await expect(page).toHaveURL(/\/calendar(\?(?!.*view=month).*)?$/)
  await gotoHome(page)
  await rail(page, 'calendar').click()
  await expect(page.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true')
})

test('Settings comes back on the pane the user left open', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)

  await rail(page, 'settings').click()
  await expect(page).toHaveURL(/\/settings/)
  const panes = page.locator('.settings-nav button[data-testid^="settings-nav-"]')
  await expect(panes.first()).toBeVisible({ timeout: 30_000 })
  // Pick a pane that is not the landing one, so the hash actually changes.
  const target = panes.nth(2)
  const targetId = await target.getAttribute('data-testid')
  await target.click()
  await expect(page).toHaveURL(/\/settings#.+/)
  const url = new URL(page.url())
  expect(url.hash.length).toBeGreaterThan(1)

  await gotoHome(page)
  await expect(rail(page, 'settings')).toHaveAttribute('href', `/settings${url.hash}`)
  await rail(page, 'settings').click()
  await expect(page).toHaveURL(new RegExp(`/settings${url.hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(page.locator(`.settings-nav [data-testid="${targetId}"]`)).toHaveAttribute('aria-current', 'page')
})

test('a task detail page is not remembered as "the tasks list"', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)

  await rail(page, 'tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.locator('[data-testid="tasks-table"]')).toBeVisible({ timeout: 30_000 })
  // Open a task's detail page through its title.
  const title = page.locator('[data-testid="tasks-table"] .tp-row[data-task-id="pw-tq-open-recent"] .tp-row-title')
  await title.click()
  await expect(page).toHaveURL(/\/tasks\/pw-tq-open-recent$/)

  await gotoHome(page)
  // The Tasks icon still leads to the list, not back into that one task.
  await expect(rail(page, 'tasks')).toHaveAttribute('href', '/tasks')
})
