/**
 * Every Walnut window follows the vault live (web/src/api/vault-live.ts, `vault:changed` from
 * src/core/vault/sessions.ts), review D02 round 2:
 *
 *  - R2-1: a Lock made elsewhere (the extension's Lock, another tab's) reaches an open, unlocked
 *    Passwords page within about a second, and its items go at once (it took 13.6 s, listing
 *    every item meanwhile);
 *  - R2-3: an unlock made elsewhere on this computer reaches an open Settings → Passwords with no
 *    reload (it stayed "Unlock Passwords in this window to change this" until one);
 *  - R2-2: an approval card never waits on Passwords (2026-11-21: a tap on any device the person is
 *    signed in on approves): an older guarded ask reads Approve with Passwords locked here, and no
 *    "Unlock to approve" ever shows.
 *
 * "Elsewhere on this computer" is a second browser (its own storage) on the same Walnut, which is
 * what the extension is to the server. Only this spec's window shares an unlock in the fixture
 * (WALNUT_TEST_VAULT_JOIN=named, the browser key named below), and it locks only its own sessions,
 * never every window, so specs running beside it keep theirs. Fake data only.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { holdApprovalsLock } from './approvals-lock'
import { ensureVaultSetUp, vaultSession, VAULT_MASTER } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'
import { isolateUiPrefsContext } from './status-section-helpers'

test.describe.configure({ mode: 'serial' })
// It names its window for sharing an unlock, so another file's unlock (or Lock) would reach it:
// alone on the vault, and the vault lock before the approvals lock.
holdVaultLock('exclusive', 'file')
// The guarded card below takes the corner: no other file's approval may show beside it.
holdApprovalsLock('file')

const SHOTS = process.env.VAULT_LIVE_SHOTS ?? (process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots', 'd02r2') : 'test-results/vault-live')
fs.mkdirSync(SHOTS, { recursive: true })
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let base = ''
let ctx: BrowserContext
let page: Page
let browserKey = ''
let other: BrowserContext | null = null

async function openPasswords(p: Page): Promise<void> {
  if ((await p.locator('.sidebar.collapsed').count()) > 0) await p.locator('.sidebar-collapse-btn').click()
  await p.locator('.sidebar-nav a[href="/passwords"]').first().click()
  await expect(p.getByTestId('pw-unlock').or(p.getByTestId('pw-app'))).toBeVisible({ timeout: 30_000 })
}

async function unlockHere(p: Page): Promise<void> {
  await p.getByLabel('Master password').fill(VAULT_MASTER)
  await p.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(p.getByTestId('pw-app')).toBeVisible({ timeout: 30_000 })
}

/**
 * This window's own Lock, made from outside its page code (as another tab's auto-lock is): its
 * session ends and the browser stops sharing older unlocks. The page hears it only from Walnut.
 */
async function lockThisBrowserBehindItsBack(p: Page): Promise<void> {
  const r = await p.evaluate(async () => {
    const s = localStorage.getItem('walnut.vault.session') ?? ''
    const k = localStorage.getItem('walnut.vault.browser') ?? ''
    const res = await fetch('/api/v1/vault/lock', { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-vault-session': s, 'x-walnut-vault-browser': k }, body: '{}' })
    return res.status
  })
  expect(r).toBe(200)
}

/** A second browser on this computer unlocks with the master password: an unlock made here. */
async function unlockInAnotherBrowser(browser: Browser): Promise<Page> {
  if (!other) {
    other = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 800 } })
    await isolateUiPrefsContext(other)
  }
  const p = await other.newPage()
  await p.goto('/')
  await expect(p.locator('.app-shell > .sidebar')).toBeVisible({ timeout: 20_000 })
  await openPasswords(p)
  if (await p.getByTestId('pw-app').isVisible()) {
    // Still unlocked from before: lock only itself and unlock anew, so this unlock is newer than the window's own Lock.
    await lockThisBrowserBehindItsBack(p)
    await expect(p.getByTestId('pw-unlock')).toBeVisible({ timeout: 10_000 })
  }
  await unlockHere(p)
  return p
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(180_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 800 } })
  // It opens the sidebar, a synced layout pref: kept off the shared fixture.
  await isolateUiPrefsContext(ctx)
  page = await ctx.newPage()
  await page.goto('/')
  await expect(page.locator('.app-shell > .sidebar')).toBeVisible({ timeout: 20_000 })
  await ensureVaultSetUp(page.request, base)
  // The person types the master password in this window once: it keeps a browser key.
  await openPasswords(page)
  if (await page.getByTestId('pw-unlock').isVisible()) await unlockHere(page)
  await nameThisWindow()
})

/** Only this spec's window shares an unlock in the fixture: name its browser key (a new one after a recovery). */
async function nameThisWindow(): Promise<void> {
  const key = String(await page.evaluate(() => localStorage.getItem('walnut.vault.browser')) ?? '')
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  if (browserKey && browserKey !== key) await page.request.post(`${base}/api/test/vault-join`, { data: { browserKey, on: false } })
  browserKey = key
  const named = await page.request.post(`${base}/api/test/vault-join`, { data: { browserKey, on: true } })
  expect(named.ok()).toBe(true)
}

test.afterAll(async () => {
  if (browserKey) await page.request.post(`${base}/api/test/vault-join`, { data: { browserKey, on: false } }).catch(() => undefined)
  await other?.close().catch(() => undefined)
  await ctx?.close().catch(() => undefined)
})

test('R2-1: a Lock elsewhere reaches an open Passwords page within a second, and its items go at once', async () => {
  const title = `Live lock probe ${stamp()}`
  const token = await vaultSession(page.request, base)
  const made = await page.request.post(`${base}/api/v1/vault/items`, { headers: { 'x-walnut-vault-session': token }, data: { item: { type: 'login', title, username: 'probe@example.test', password: 'not-a-real-one' } } })
  expect(made.ok(), await made.text()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('pw-app')).toBeVisible({ timeout: 30_000 })
  // The page's own search: a hidden "Search tasks" field of the task panel comes first in the page.
  await page.getByTestId('pw-app').getByLabel('Search passwords').fill(title)
  await expect(page.getByTestId('pw-row').filter({ hasText: title })).toBeVisible({ timeout: 10_000 })

  const t0 = Date.now()
  await lockThisBrowserBehindItsBack(page)
  await expect(page.getByTestId('pw-unlock')).toBeVisible({ timeout: 5_000 })
  const ms = Date.now() - t0
  await expect(page.getByTestId('pw-row')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/r2-1-locked-at-once.png` })
  expect(ms, `the lock screen showed ${ms} ms after the Lock`).toBeLessThan(1_500)
})

test('R2-3: an unlock made elsewhere on this computer reaches an open Settings → Passwords, with no reload', async ({ browser }) => {
  test.setTimeout(120_000)
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-passwords').click()
  const vault = page.locator('.main-content')
  // Locked here, from a known start: a spec beside this one may have unlocked meanwhile (an unlock
  // on this computer, which this window shares at once).
  if (await page.evaluate(() => !!localStorage.getItem('walnut.vault.session'))) await lockThisBrowserBehindItsBack(page)
  await expect(vault.getByText(/^Locked · \d+ items$/)).toBeVisible({ timeout: 15_000 })
  await expect(vault.getByText('Unlock Passwords in this window to change this.').first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/r2-3-settings-locked.png` })

  const p2 = await unlockInAnotherBrowser(browser)
  const t0 = Date.now()
  await expect(vault.getByText(/^Unlocked in this window · \d+ items$/)).toBeVisible({ timeout: 5_000 })
  const ms = Date.now() - t0
  await expect(vault.getByText('Unlock Passwords in this window to change this.')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/r2-3-settings-joined.png` })
  expect(ms, `Settings showed the unlock ${ms} ms after it was made`).toBeLessThan(3_000)
  await p2.close()
})

test('R2-2: an older guarded approval card offers Approve with Passwords locked here, never Unlock to approve', async () => {
  test.setTimeout(60_000)
  const now = Date.now()
  const approval = {
    id: `apr-live-${stamp()}`, what: 'Let a Walnut agent click button "Place order" on shop.example.test', digest: 'd', mode: 'biometric', guard: 'person',
    requester: { host: '__local__', command: 'walnut browser click', local: true },
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), status: 'pending',
  }
  // This window's list holds one ask as an older Walnut wrote it (Face ID, guarded by the person's Passwords).
  await page.route(/\/api\/v1\/approvals(\?.*)?$/, (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { approvals: [approval], keys: [] } })
    : route.continue())
  // Seen at any moment, even for one frame.
  await page.addInitScript(() => {
    const w = window as unknown as { __sawUnlockToApprove?: boolean }
    new MutationObserver(() => { if (document.querySelector('[data-testid="approval-unlock-to-approve"]')) w.__sawUnlockToApprove = true })
      .observe(document, { subtree: true, childList: true })
  })
  const card = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${approval.id}"]`)
  // Passwords locked in this window.
  await openPasswords(page)
  if (await page.getByTestId('pw-unlock').isVisible()) await unlockHere(page)
  await lockThisBrowserBehindItsBack(page)
  await expect(page.getByTestId('pw-unlock')).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => localStorage.removeItem('walnut.vault.session'))
  await page.reload()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled({ timeout: 5_000 })
  await expect(card.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { __sawUnlockToApprove?: boolean }).__sawUnlockToApprove ?? false)).toBe(false)
  await card.screenshot({ path: `${SHOTS}/r2-2-card-approve-locked.png` })
  await page.unroute(/\/api\/v1\/approvals(\?.*)?$/)
})
