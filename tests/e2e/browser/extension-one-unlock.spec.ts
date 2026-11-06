/**
 * One unlock on the computer Walnut runs on, for the extension too (review round 3, R3-1 and R3-2):
 * unlocking in a Walnut window unlocks an extension side panel that is already open, with no input
 * there, and a popup opened afterwards; Lock all in Walnut's Settings replaces an open popup's list
 * with the lock screen and its password field at once, with no reload, and a search made after
 * Walnut ended the unlock shows that lock screen, never a bare error. And the other way round
 * (review D02 round 1, R1-1): an unlock in the extension's popup opens a Walnut window's locked
 * Passwords page that is already open, with no input and no reload there.
 * (packages/browser-extension/src/bg-vault.ts liveState, popup.ts followVault; POST /vault/join;
 * web/src/api/vault.ts status() and the browser key, src/core/vault/browser-keys.ts.)
 * Shares the fixture's vault (the same master password as the other specs). Fake data only.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openPanel, startPanelLab, sw, type PanelLab } from './extension-panel-harness'
import { ensureVaultSetUp, VAULT_MASTER } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It names its extension and window for sharing an unlock and ends every unlock: alone on the vault.
holdVaultLock('exclusive', 'file')

const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/extension-one-unlock'
let lab: PanelLab
let web: Page
let device = ''
let windowKey = ''

/** This lab's extension device (its record in the background's IndexedDB, secret-store.ts). */
async function extensionDevice(): Promise<string> {
  return sw(lab).evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('walnut', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const get = open.result.transaction('kv', 'readonly').objectStore('kv').get('connection')
      get.onsuccess = () => { resolve(String((get.result as { deviceId?: string } | undefined)?.deviceId ?? '')); open.result.close() }
      get.onerror = () => reject(get.error)
    }
  }))
}

/** The fixture shares an unlock only with the extensions a spec names (WALNUT_TEST_VAULT_JOIN=named). */
async function nameForJoin(on: boolean): Promise<void> {
  const r = await web.request.post(`${lab.base}/api/test/vault-join`, { data: { device, on } })
  expect(r.ok()).toBe(true)
}

async function openPasswords(page: Page): Promise<void> {
  await page.goto(`${lab.base}/`)
  await page.waitForLoadState('domcontentloaded')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href="/passwords"]').first().click()
  await expect(page.getByTestId('pw-unlock').or(page.getByTestId('pw-app'))).toBeVisible({ timeout: 30_000 })
}

/** The web window locks every window (its Lock), so each test starts with nothing unlocked. */
async function lockEverywhere(page: Page): Promise<void> {
  await openPasswords(page)
  if (await page.getByTestId('pw-app').isVisible()) await page.getByTestId('pw-lock').click()
  // An unlock another spec left on the shared fixture (an API session, another extension's) ends too:
  // this window being locked says nothing about the others.
  else await page.evaluate(() => fetch('/api/v1/vault/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ everywhere: true }) }))
  await expect(page.getByTestId('pw-unlock')).toBeVisible({ timeout: 20_000 })
}

async function unlockWeb(page: Page): Promise<void> {
  await page.getByLabel('Master password').fill(VAULT_MASTER)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByTestId('pw-app')).toBeVisible({ timeout: 30_000 })
}

async function popup(): Promise<Page> {
  const p = await lab.ctx.newPage()
  await p.goto(`chrome-extension://${lab.extId}/popup.html`)
  return p
}

// The toolbar popup's box, or the side panel Passwords view's (which says it searches logins).
const listOf = (v: Page | FrameLocator) => v.getByLabel(/^Search (Walnut|logins)$/)
const lockOf = (v: Page | FrameLocator) => v.getByTestId('popup-unlock')

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'one-unlock')
  web = await lab.ctx.newPage()
  await web.goto(`${lab.base}/`)
  await ensureVaultSetUp(web, lab.base, { password: VAULT_MASTER })
  device = await extensionDevice()
  expect(device).toMatch(/^extension-[0-9a-f]+$/)
  await nameForJoin(true)
})
test.afterAll(async () => {
  if (device) await nameForJoin(false).catch(() => undefined)
  if (windowKey) await web.request.post(`${lab.base}/api/test/vault-join`, { data: { browserKey: windowKey, on: false } }).catch(() => undefined)
  await lab?.close()
})

test('an unlock in a Walnut window unlocks the open side panel, with no input there', async () => {
  test.setTimeout(180_000)
  await lockEverywhere(web)
  const { panel } = await openPanel(lab, 'passwords')
  const pw = panel.frameLocator('iframe.panel-frame-passwords')
  await expect(lockOf(pw)).toBeVisible({ timeout: 30_000 })

  await unlockWeb(web)
  // The panel follows by itself: no click, no typing, no reload there.
  await expect(listOf(pw)).toBeVisible({ timeout: 15_000 })
  await expect(lockOf(pw)).toHaveCount(0)
  await panel.screenshot({ path: `${SHOTS}/panel-after-web-unlock.png` })

  // A popup opened now is unlocked too.
  const p = await popup()
  await expect(listOf(p)).toBeVisible({ timeout: 20_000 })
  await p.close()
  await panel.close()
})

test('Lock all in Walnut reaches an open popup at once: its list goes, the lock screen with the password field shows', async () => {
  test.setTimeout(180_000)
  await openPasswords(web)
  if (await web.getByTestId('pw-unlock').isVisible()) await unlockWeb(web)
  const p = await popup()
  await expect(listOf(p)).toBeVisible({ timeout: 20_000 })

  await web.locator('.sidebar-nav a[href^="/settings"]').click()
  await web.getByTestId('settings-nav-passwords').click()
  const lockAll = web.locator('#passwords').getByRole('button', { name: 'Lock all' })
  await lockAll.scrollIntoViewIfNeeded()
  await lockAll.click()
  await expect(web.getByText('Every window is locked.')).toBeVisible({ timeout: 15_000 })

  await expect(lockOf(p)).toBeVisible({ timeout: 10_000 })
  await expect(p.getByLabel('Master password')).toBeVisible()
  await expect(listOf(p)).toHaveCount(0)
  await p.screenshot({ path: `${SHOTS}/popup-after-lock-all.png` })
  await p.close()
})

test('a search after Walnut ended the unlock shows the lock screen, never a bare error', async () => {
  test.setTimeout(180_000)
  const p = await popup()
  await expect(lockOf(p)).toBeVisible({ timeout: 20_000 })
  await p.getByLabel('Master password').fill(VAULT_MASTER)
  await lockOf(p).click()
  await expect(listOf(p)).toBeVisible({ timeout: 30_000 })

  // Walnut ends every unlock behind the popup's back, and the search goes out before the popup's
  // next look at the vault: the background's refusal brings the lock screen.
  await web.evaluate(async () => {
    await fetch('/api/v1/vault/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) })
  })
  await listOf(p).fill('example')
  await expect(lockOf(p)).toBeVisible({ timeout: 10_000 })
  await expect(p.getByText('The vault is locked in this window')).toHaveCount(0)
  await p.close()
})

test('an unlock in the extension popup opens the Walnut window\'s locked Passwords page, with no input there', async () => {
  test.setTimeout(180_000)
  // This browser typed the master password in a Walnut window once (the browser key it keeps),
  // then the person locked everything.
  await openPasswords(web)
  if (await web.getByTestId('pw-unlock').isVisible()) await unlockWeb(web)
  await web.getByTestId('pw-lock').click()
  await expect(web.getByTestId('pw-unlock')).toBeVisible({ timeout: 20_000 })
  windowKey = String(await web.evaluate(() => localStorage.getItem('walnut.vault.browser')) ?? '')
  expect(windowKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const named = await web.request.post(`${lab.base}/api/test/vault-join`, { data: { browserKey: windowKey, on: true } })
  expect(named.ok()).toBe(true)

  const p = await popup()
  await expect(lockOf(p)).toBeVisible({ timeout: 20_000 })
  await p.getByLabel('Master password').fill(VAULT_MASTER)
  await lockOf(p).click()
  await expect(listOf(p)).toBeVisible({ timeout: 30_000 })

  // The open page follows by itself: no click, no typing, no reload there.
  await expect(web.getByTestId('pw-app')).toBeVisible({ timeout: 15_000 })
  await expect(web.getByTestId('pw-unlock')).toHaveCount(0)
  await web.screenshot({ path: `${SHOTS}/web-after-popup-unlock.png` })

  // The person's Lock in the window locks the popup too.
  await web.getByTestId('pw-lock').click()
  await expect(lockOf(p)).toBeVisible({ timeout: 10_000 })
  await p.close()
})
