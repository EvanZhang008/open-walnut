/**
 * A plugin App beside a session's chat (AppContribution.sessionPane, the split's App view).
 *
 * The fixture plugin (fixtures/plugin-session-pane-plugin/web.mjs) brings two Apps with a pane
 * (Sketch, Notes) and one without (Plain). The flow, from the session's ⋮ menu only (the header
 * gets no chip for it):
 *
 *   1. Open → Apps opens the App view in the split; the pane gets the session, its task, its own
 *      path, and the focus (a person opened it). Plain is never offered.
 *   2. The pane picks a document; a reload brings the same App on the same document back, and a
 *      restore does not take the focus.
 *   3. Tabs switch Apps; each App keeps its own document.
 *   4. The Apps row again closes the view (as every view row does); the chat stays.
 *   5. A pane that throws shows the plugin's error under the bar; Close works; reopening mounts
 *      it fresh.
 *   6. The pane's navigate(basePath) opens the standalone App.
 *
 * Runs on a Linux dev host (never the Mac): `walnut-dev webkit tests/e2e/browser/session-app-pane.spec.ts`,
 * or Chromium with `bun x playwright test tests/e2e/browser/session-app-pane.spec.ts`.
 */
import fs from 'node:fs/promises'
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { usePluginFixture } from './plugin-fixture'
import { openKebabGroup } from './kebab-group-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

const PLUGIN_ID = 'plugin-session-pane-fixture'
const SKETCH_PATH = `/apps/${PLUGIN_ID}~sketch`
const SHOTS = process.env.SESSION_APP_PANE_SHOTS ?? '/tmp/session-app-pane'

test.setTimeout(300_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const fixture = usePluginFixture('session-pane')
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

/** Home with the seeded session open in a column, the Ask slot off (the column has the room). */
async function openSession(page: Page): Promise<{ panel: Locator; errors: string[] }> {
  const errors: string[] = []
  page.on('pageerror', (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message) })
  // Once per tab: a reload keeps the columns (the reload is what the first test checks).
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('pw-session-app-pane-seeded')) return
      sessionStorage.setItem('pw-session-app-pane-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
      localStorage.removeItem('open-walnut-layout:home-columns')
    } catch { /* storage off */ }
  })
  await page.goto(`${fixture.base()}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]')
  if (!(await panel.isVisible())) {
    await page.locator('.todo-search-input').fill('Home column round')
    await page.locator('.todo-panel-item[data-task-id="pw-task-home-session"] .todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return { panel, errors }
}

const menuOf = (page: Page): Locator => page.locator('.task-kebab-menu:visible')

async function openViewsMenu(panel: Locator): Promise<Locator> {
  await panel.getByRole('button', { name: 'More actions' }).click()
  const menu = menuOf(panel.page())
  await expect(menu).toBeVisible({ timeout: 15_000 })
  return openKebabGroup(menu, 'session-kebab-open')
}

const pane = (page: Page) => page.getByTestId('session-app-pane')
const insidePane = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-testid="session-app-pane"]'))

async function shot(page: Page, name: string): Promise<void> {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

test('the ⋮ menu opens a plugin App beside the chat, kept across a reload, per App', async ({ page }) => {
  const { panel, errors } = await openSession(page)

  // No resident chip: the header offers nothing for Apps.
  await expect(panel.locator('.session-panel-header').getByText(/Sketch Fixture|Apps/)).toHaveCount(0)

  const group = await openViewsMenu(panel)
  // The row shows once the plugin's Apps have registered (the menu follows the registry).
  const row = group.getByTestId('session-menu-apps')
  await expect(row).toHaveText(/Apps/, { timeout: 60_000 })
  await expect(group.getByText('Plain Fixture')).toHaveCount(0)
  await row.click()

  await expect(pane(page)).toBeVisible({ timeout: 30_000 })
  const sketch = page.getByTestId('pane-fixture-sketch')
  await expect(sketch).toBeVisible()
  await expect(sketch).toHaveAttribute('data-session-id', 'pw-home-session')
  await expect(sketch).toHaveAttribute('data-task-id', 'pw-task-home-session')
  await expect(sketch).toHaveAttribute('data-base-path', SKETCH_PATH)
  await expect(page.getByTestId('pane-fixture-doc')).toHaveText('none')
  // The person opened it: the focus is in the pane.
  await expect.poll(() => insidePane(page)).toBe(true)
  // The chat is still there beside it.
  await expect(panel.locator('.session-panel-chat-col')).toBeVisible()
  await shot(page, '1-sketch-open')

  // A document, then a reload: the same App on the same document, and the focus left alone.
  await page.getByTestId('pane-fixture-pick-b').click()
  await expect(page.getByTestId('pane-fixture-doc')).toHaveText('plans/b.sketch')
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('pane-fixture-doc')).toHaveText('plans/b.sketch', { timeout: 60_000 })
  await page.waitForTimeout(500)
  expect(await insidePane(page)).toBe(false)
  await shot(page, '2-restored-after-reload')

  // Tabs: Notes, then back to Sketch, whose document is still b.
  const tabs = pane(page).getByRole('tab')
  await expect(tabs).toHaveText(['Sketch Fixture', 'Notes Fixture'])
  await tabs.nth(1).click()
  await expect(page.getByTestId('pane-fixture-notes')).toHaveText('Notes for pw-home-session')
  await tabs.nth(0).click()
  await expect(page.getByTestId('pane-fixture-doc')).toHaveText('plans/b.sketch')

  // The Apps row again closes the view; the chat stays.
  const again = await openViewsMenu(panel)
  await expect(again.getByTestId('session-menu-apps')).toHaveAttribute('aria-pressed', 'true')
  await again.getByTestId('session-menu-apps').click()
  await expect(pane(page)).toHaveCount(0)
  await expect(panel.locator('.session-panel-chat-col')).toBeVisible()
  expect(errors).toEqual([])
})

test('a pane that throws stays in its box, closes, and reopens fresh; navigate opens the standalone App', async ({ page }) => {
  const { panel } = await openSession(page)
  const group = await openViewsMenu(panel)
  await group.getByTestId('session-menu-apps').click({ timeout: 60_000 })
  await expect(page.getByTestId('pane-fixture-sketch')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('pane-fixture-crash').click()
  await expect(pane(page).locator('.plugin-error-boundary')).toContainText('fixture pane crashed')
  // The rest of Walnut is untouched: the chat column still renders.
  await expect(panel.locator('.session-panel-chat-col')).toBeVisible()
  await shot(page, '3-crash-in-box')
  await page.getByTestId('session-app-pane-close').click()
  await expect(pane(page)).toHaveCount(0)

  const reopen = await openViewsMenu(panel)
  await reopen.getByTestId('session-menu-apps').click()
  await expect(page.getByTestId('pane-fixture-sketch')).toBeVisible({ timeout: 30_000 })
  await expect(pane(page).locator('.plugin-error-boundary')).toHaveCount(0)

  await page.getByTestId('pane-fixture-standalone').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(SKETCH_PATH)
  await expect(page.getByTestId('pane-fixture-sketch-page')).toBeVisible({ timeout: 30_000 })
})
