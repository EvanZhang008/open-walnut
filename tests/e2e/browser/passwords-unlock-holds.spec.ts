/**
 * One unlock for every tab (web/src/api/vault.ts keeps the vault session in localStorage): unlock
 * in one tab and a second tab opens unlocked; Lock in one and the other shows the lock screen with
 * no reload; unlock again and the other follows. Settings says how long it stays unlocked.
 * Shares the fixture's vault with passwords.spec.ts (same master password). Fake data only.
 * Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test passwords-unlock-holds --project webkit
 */
import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/passwords-unlock-holds'

async function openPasswords(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href="/passwords"]').first().click()
}

async function ensureVault(page: Page) {
  const base = new URL(page.url()).origin
  const st = await (await page.request.get(`${base}/api/v1/vault/status`)).json()
  if (!st.setUp) expect((await page.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })).ok()).toBe(true)
}

async function unlock(page: Page) {
  const form = page.getByTestId('pw-unlock')
  await expect(form.or(page.getByTestId('pw-app'))).toBeVisible({ timeout: 20_000 })
  if (await form.isVisible()) {
    await page.getByLabel('Master password').fill(MASTER)
    await page.getByRole('button', { name: 'Unlock' }).click()
  }
  await expect(page.getByTestId('pw-app')).toBeVisible({ timeout: 30_000 })
}

test('an unlock in one tab is every tab\'s, and a Lock in one locks the others', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await ensureVault(page)
  await openPasswords(page)
  await unlock(page)

  // A second tab of the same browser opens unlocked: no master password asked.
  const second = await context.newPage()
  await openPasswords(second)
  await expect(second.getByTestId('pw-app')).toBeVisible({ timeout: 20_000 })
  await expect(second.getByTestId('pw-unlock')).toHaveCount(0)

  // Lock in the second: the first shows the lock screen without a reload.
  await second.getByTestId('pw-lock').click()
  await expect(second.getByTestId('pw-unlock')).toBeVisible()
  await expect(page.getByTestId('pw-unlock')).toBeVisible({ timeout: 10_000 })

  // Unlock in the first: the second follows.
  await unlock(page)
  await expect(second.getByTestId('pw-app')).toBeVisible({ timeout: 10_000 })

  // A reload keeps it too.
  await second.reload()
  await expect(second.getByTestId('pw-app')).toBeVisible({ timeout: 20_000 })
  await second.close()
})

test('Settings says plainly how long Passwords stays unlocked', async ({ page }) => {
  await page.goto('/')
  await ensureVault(page)
  await openPasswords(page)
  await unlock(page)
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-passwords').click()
  const row = page.locator('#passwords')
  await row.scrollIntoViewIfNeeded()
  // The fixture's config may hold any choice; with the default it is 48 hours after the last use.
  await expect(row.getByText(/Stays unlocked|Locks again/).first()).toBeVisible({ timeout: 20_000 })
  const help = await row.getByText(/Stays unlocked|Locks again/).first().textContent()
  if (/48 hours/.test(help ?? '')) expect(help).toContain('48 hours after you last use it, until you lock it or restart the Mac.')
  await page.setViewportSize({ width: 1280, height: 800 })
  await row.screenshot({ path: `${SHOTS}/settings-passwords.png` })
})
