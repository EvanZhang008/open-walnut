/**
 * E2E: the task panel's Display menu shows how many session columns sit side by side,
 * and changes it.
 *
 * The count is ONE app-wide setting (`ui.session_panels`, also in Settings, General);
 * the Display menu is its in-context surface because the task panel is where the user
 * is when the strip needs more or fewer panels (2026-09-23: "this should show the
 * number of session panels we can adjust"). The session ⋮ menu's Panels row is gone
 * (2026-10-27): the count is the whole strip's setting, not one session's. So the
 * assertions are about the shared setting, not a local copy: the menu reads the current
 * value, a pick moves the strip at once and reaches config, Settings agrees (both ways),
 * and under Auto the row names the count Auto means in this window.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { closeViewMenu, openHome, openViewMenu } from './home-navigation-helpers'

const SHOTS = '/tmp/filterbar/shots'
const SIDS = ['pw-normal-session', 'pw-plan-session-completed', 'pw-vscode-session'] as const

test.describe.configure({ mode: 'serial' })
// Config writes are a read-modify-write under a file lock that queues behind the fixture's
// session health monitor; several steps below wait on one.
test.setTimeout(150_000)

const readMode = async (page: Page) => (await (await page.request.get('/api/config')).json())?.config?.ui?.session_panels
async function writeMode(page: Page, mode: string | undefined) {
  const config = (await (await page.request.get('/api/config')).json()).config
  const ui = { ...config.ui }
  if (mode === undefined) delete ui.session_panels
  else ui.session_panels = mode
  expect((await page.request.put('/api/config', { data: { ui } })).ok()).toBe(true)
  await expect.poll(() => readMode(page), { timeout: 30_000 }).toBe(mode)
}

/** Boot home with `sids` as open session columns (the queue lives in sessionStorage). */
async function bootWithColumns(page: Page, baseURL: string, sids: readonly string[]) {
  await isolateUiPrefs(page)
  await page.addInitScript((ids) => {
    try {
      if (!sessionStorage.getItem('pw-columns-seeded')) {
        sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify((ids as string[]).map((id) => ({ id, locked: false }))))
        sessionStorage.setItem('pw-columns-seeded', '1')
      }
    } catch { /* ignore */ }
  }, sids as unknown as string[])
  await openHome(page, baseURL, 90_000)
}

const columns = (page: Page) => page.locator('.main-page-sessions-area > .main-page-session-column')
const panelsRow = (page: Page) => page.locator('.fb-menu [data-view-option="session-panels"]')
const choice = (page: Page, key: string) => panelsRow(page).locator(`[data-choice="${key}"]`)
const checked = (page: Page) => panelsRow(page).locator('button[aria-pressed="true"]')
/** The session panel's own kebab, open. */
async function openSessionKebab(page: Page) {
  const kebab = page.locator('.main-page-session-column .session-panel').first().getByRole('button', { name: 'More actions' })
  await expect(kebab).toBeVisible({ timeout: 20_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu:visible').first()
  await expect(menu).toBeVisible()
  return menu
}
/** Settings, General's picker for the same setting. */
const settingsChoice = (page: Page, label: string) =>
  page.locator('#settings-session-panels .settings-segment').filter({ hasText: new RegExp(`^${label}$`) })
/** Pick a count in Settings (sidebar click), wait for config, and come back home. */
async function pickInSettings(page: Page, label: string) {
  await page.locator('.sidebar a[href^="/settings"]').click()
  const btn = settingsChoice(page, label)
  await expect(btn).toBeVisible({ timeout: 20_000 })
  await btn.click()
  await expect(btn).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => readMode(page), { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe(label === 'Auto' ? 'auto' : label)
  await page.locator('.sidebar a[href="/"]').first().click()
  await expect(page.locator('#home-task-navigation .todo-panel-toolbar button[aria-label="Display"]')).toBeVisible({ timeout: 30_000 })
}
/** The Display menu shows whole, its Session columns row included, with nothing to scroll (the body is what scrolls). */
const viewFits = (page: Page) => page.locator('.fb-menu').evaluate((el) => {
  const body = el.querySelector('.fb-menu-body')!
  const row = el.querySelector('[data-view-option="session-panels"]')!.getBoundingClientRect()
  return body.scrollHeight <= body.clientHeight + 1 && row.bottom <= el.getBoundingClientRect().bottom + 1
})
/** The strip's budget under Auto, from the same breakpoints the home page uses. */
const autoBudget = (page: Page) => page.locator('.main-page-content-row').evaluate((el) => {
  const width = el.getBoundingClientRect().width
  return width >= 2100 ? 3 : width >= 1400 ? 2 : 1
})

let original: string | undefined
test.beforeAll(async ({ request }) => {
  original = (await (await request.get('/api/config')).json())?.config?.ui?.session_panels
})
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  try { await writeMode(page, original) } finally { await page.close() }
})

test('the Display menu shows the column count and a pick moves the strip at once', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message) })
  await page.setViewportSize({ width: 2400, height: 1000 })
  await writeMode(page, '3')
  await bootWithColumns(page, baseURL!, SIDS)
  await expect(columns(page)).toHaveCount(3, { timeout: 30_000 })

  // The row sits right under the tab bar switch (the View row above both) and reads the current value.
  await openViewMenu(page)
  const keys = await page.locator('.fb-menu .dm-settings > [data-view-option]').evaluateAll((els) => els.map((el) => el.getAttribute('data-view-option')))
  expect(keys).toEqual(['view', 'quick-views', 'session-panels'])
  await expect(panelsRow(page)).toContainText('Session columns')
  await expect(panelsRow(page).locator('button')).toHaveText(['1', '2', '3', '4', '5', 'Auto'])
  await expect(checked(page)).toHaveText(['3'])
  expect(await viewFits(page)).toBe(true)
  await page.locator('.fb-menu').screenshot({ path: `${SHOTS}/${test.info().project.name}-display-menu-columns.png` })

  // A pick moves the strip without waiting for the config round-trip, and the menu stays open on it.
  await choice(page, '2').click()
  await expect(columns(page)).toHaveCount(2, { timeout: 3000 })
  await expect(checked(page)).toHaveText(['2'])
  await expect.poll(() => readMode(page), { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe('2')
  // Picking the current value again writes nothing.
  const writes: string[] = []
  page.on('request', (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/config') writes.push(req.url()) })
  await choice(page, '2').click()
  await page.waitForTimeout(1500)
  expect(writes).toEqual([])
  await closeViewMenu(page)

  // Reopened, it is still a readout of the setting.
  await openViewMenu(page)
  await expect(checked(page)).toHaveText(['2'])
  await closeViewMenu(page)
  // The session kebab no longer carries the count: the Display menu is its home.
  const kebab = await openSessionKebab(page)
  await expect(kebab.getByText('Panels', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // C58: 1 from Settings: the strip drops to one column and Display shows 1.
  await pickInSettings(page, '1')
  // Home re-reads the setting on the way back (the same budget Settings round trips get
  // in session-panel-count.spec.ts); the immediate path is the Display pick above.
  await expect(columns(page)).toHaveCount(1, { timeout: 25_000 })
  await openViewMenu(page)
  await expect(checked(page)).toHaveText(['1'])
  await closeViewMenu(page)
  expect(errors).toEqual([])
})

test('a change made in Settings shows in the Display menu, and Auto names its count', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 840 })
  await writeMode(page, '2')
  await bootWithColumns(page, baseURL!, SIDS.slice(0, 1))
  await expect(columns(page)).toHaveCount(1, { timeout: 30_000 })

  // 4 from Settings: the Display menu shows 4.
  await pickInSettings(page, '4')
  await openViewMenu(page)
  await expect(checked(page)).toHaveText(['4'])
  expect(await viewFits(page)).toBe(true)

  // Auto: the row says how many panels Auto means at this window width.
  await choice(page, 'auto').click()
  await expect(checked(page)).toHaveText([`Auto (${await autoBudget(page)})`])
  await expect.poll(() => readMode(page), { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe('auto')
  await page.locator('.fb-menu').screenshot({ path: `${SHOTS}/${test.info().project.name}-display-menu-auto.png` })
  await closeViewMenu(page)

  // A short window caps the menu to the space below its button; the body scrolls instead.
  await page.setViewportSize({ width: 1280, height: 560 })
  await openViewMenu(page)
  expect(await page.locator('.fb-menu').evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  await panelsRow(page).scrollIntoViewIfNeeded()
  await expect(choice(page, 'auto')).toBeInViewport()
  await closeViewMenu(page)

  // A wider window changes what Auto means, and the row follows.
  await page.setViewportSize({ width: 2400, height: 1000 })
  const wide = await autoBudget(page)
  expect(wide).toBeGreaterThan(1)
  await openViewMenu(page)
  await expect(checked(page)).toHaveText([`Auto (${wide})`])
  await closeViewMenu(page)

  // Settings holds the same state (its Auto carries no count).
  await page.locator('.sidebar a[href^="/settings"]').click()
  await expect(settingsChoice(page, 'Auto')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
  await page.locator('.sidebar a[href="/"]').first().click()

  // The choice survives a reload.
  await page.reload()
  await expect(page.locator('#home-task-navigation .todo-panel-toolbar button[aria-label="Display"]')).toBeVisible({ timeout: 90_000 })
  await openViewMenu(page)
  await expect(checked(page)).toHaveText([`Auto (${wide})`], { timeout: 30_000 })
})
