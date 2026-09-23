/**
 * E2E: the task panel's filter menu shows how many session panels sit side by side, and
 * changes it.
 *
 * The count is ONE app-wide setting (`ui.session_panels`, also in Settings → General and
 * the session kebab); the filter menu is a third surface for it because the task panel is
 * where the user is when the strip needs more or fewer panels (2026-09-23: "this should
 * show the number of session panels we can adjust"). So the assertions are about the
 * shared setting, not a local copy: the menu reads the current value, a pick moves the
 * strip at once and reaches config, the session kebab agrees (both ways), and under Auto
 * the row names the count Auto means in this window.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { closeViewMenu, openHome, openViewMenu } from './home-navigation-helpers'

const SHOTS = '/tmp/view-menu-session-panels'
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
const panelsRow = (page: Page) => page.locator('.vd-panel [data-view-group="Session panels"] [data-view-option="session-panels"]')
const choice = (page: Page, key: string) => panelsRow(page).locator(`[data-choice="${key}"]`)
const checked = (page: Page) => panelsRow(page).locator('button[aria-pressed="true"]')
/** The session panel's own kebab and its Panels row (the other in-context surface of the setting). */
async function kebabPanels(page: Page) {
  const kebab = page.locator('.main-page-session-column .session-panel').first().getByRole('button', { name: 'More actions' })
  await expect(kebab).toBeVisible({ timeout: 20_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu:visible').first()
  await expect(menu).toBeVisible()
  return menu.locator('.task-kebab-tier').filter({ has: page.getByText('Panels', { exact: true }) })
}
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

test('the filter menu shows the panel count and a pick moves the strip at once', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message) })
  await page.setViewportSize({ width: 2400, height: 1000 })
  await writeMode(page, '3')
  await bootWithColumns(page, baseURL!, SIDS)
  await expect(columns(page)).toHaveCount(3, { timeout: 30_000 })

  // The row sits in the View section, below the tab bar switch, and reads the current value.
  await openViewMenu(page)
  const groups = await page.locator('.vd-panel [data-view-group]').evaluateAll((els) => els.map((el) => el.getAttribute('data-view-group')))
  expect(groups.slice(-2)).toEqual(['Task panel', 'Session panels'])
  await expect(panelsRow(page)).toContainText('Side by side')
  await expect(panelsRow(page).locator('button')).toHaveText(['1', '2', '3', '4', '5', 'Auto'])
  await expect(checked(page)).toHaveText(['3'])
  await page.locator('.vd-panel').screenshot({ path: `${SHOTS}/${test.info().project.name}-filter-menu-panels.png` })

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

  // Reopened, it is still a readout of the setting, and the session kebab agrees.
  await openViewMenu(page)
  await expect(checked(page)).toHaveText(['2'])
  await closeViewMenu(page)
  await expect((await kebabPanels(page)).locator('.task-kebab-tier-btn.active')).toHaveText(['2'])
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('a change made in the session kebab shows in the filter menu, and Auto names its count', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 840 })
  await writeMode(page, '2')
  await bootWithColumns(page, baseURL!, SIDS.slice(0, 1))
  await expect(columns(page)).toHaveCount(1, { timeout: 30_000 })

  // 4 from the session kebab: the filter menu shows 4.
  await (await kebabPanels(page)).locator('.task-kebab-tier-btn').filter({ hasText: /^4$/ }).click()
  await expect.poll(() => readMode(page), { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe('4')
  await openViewMenu(page)
  await expect(checked(page)).toHaveText(['4'])

  // Auto: the row says how many panels Auto means at this window width.
  await choice(page, 'auto').click()
  await expect(checked(page)).toHaveText([`Auto (${await autoBudget(page)})`])
  await expect.poll(() => readMode(page), { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe('auto')
  await page.locator('.vd-panel').screenshot({ path: `${SHOTS}/${test.info().project.name}-filter-menu-auto.png` })
  await closeViewMenu(page)

  // A wider window changes what Auto means, and the row follows.
  await page.setViewportSize({ width: 2400, height: 1000 })
  const wide = await autoBudget(page)
  expect(wide).toBeGreaterThan(1)
  await openViewMenu(page)
  await expect(checked(page)).toHaveText([`Auto (${wide})`])
  await closeViewMenu(page)

  // The choice survives a reload.
  await page.reload()
  await expect(page.locator('#home-task-navigation .todo-panel-toolbar button[aria-label="View options"]')).toBeVisible({ timeout: 90_000 })
  await openViewMenu(page)
  await expect(checked(page)).toHaveText([`Auto (${wide})`], { timeout: 30_000 })
})
