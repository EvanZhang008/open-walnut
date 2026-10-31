/**
 * Home never draws nothing (web/src/pages/home-panel-flags.ts homeTaskPanelShown).
 * 2026-10-31: the user's synced prefs said the task panel, the chat, the agenda and
 * the scratchpad were all hidden; a fresh browser adopted them and showed an empty
 * Home (the task panel 0 px wide, nothing beside it). The rule is checked through the
 * real boot path: the prefs come from /api/ui-prefs, as the server serves them.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const nav = (page: Page) => page.locator('#home-task-navigation')
const taskToggle = (page: Page) => page.locator('.sidebar-home-group .app-task-panel-toggle')

async function expectPanelShown(page: Page) {
  await expect(nav(page)).not.toHaveAttribute('inert', '', { timeout: 30_000 })
  await expect(page.locator('.todo-panel').first()).toBeVisible()
  await expect.poll(async () => (await nav(page).boundingBox())?.width ?? 0).toBeGreaterThan(200)
}

/** Serve these synced prefs at boot and keep what the page writes back. */
async function servePrefs(page: Page, prefs: Record<string, string>) {
  const served = Object.fromEntries(Object.entries(prefs).map(([k, v]) => [k, { v, ts: 1 }]))
  await page.route('**/api/ui-prefs', async (route) => {
    const body = route.request().method() === 'GET' ? JSON.stringify({ prefs: served }) : '{"ok":true}'
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
}

test.describe('Home never draws nothing', () => {
  test.describe.configure({ timeout: 120_000 })

  test('a fresh browser opens Home with the task panel', async ({ page }) => {
    await isolateUiPrefs(page, { newInstall: true })
    await page.goto('/')
    await expectPanelShown(page)
  })

  test('synced prefs that hide every panel still show the task panel, and keep it shown', async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('pw-fresh')) { sessionStorage.setItem('pw-fresh', '1'); localStorage.clear() } })
    await servePrefs(page, {
      'open-walnut-home-todo-visible': 'false',
      'open-walnut-home-chat-visible': 'false',
      'open-walnut-home-calendar-visible': 'false',
      'open-walnut-home-scratchpad-visible': 'false',
      'open-walnut-todo-width': '31.2',
      'walnut-todo-panel-design': 'project',
    })
    await page.goto('/')
    await expectPanelShown(page)
    // The flag says shown again, so it survives a reload and the first column opened from it.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('open-walnut-home-todo-visible'))).toBe('true')
    await expect(taskToggle(page)).toHaveAttribute('aria-expanded', 'true')

    // With something else on Home, hiding the panel is honoured; closing that brings it back.
    await page.getByTestId('sidebar-toggle-scratchpad').click()
    await expect(page.getByTestId('home-companion-scratchpad')).toBeVisible()
    await taskToggle(page).click()
    await expect(nav(page)).toHaveAttribute('inert', '')
    await page.getByTestId('sidebar-toggle-scratchpad').click()
    await expectPanelShown(page)
  })
})
