/**
 * One unlock in this browser, with no second prompt (the person's report: "why it keep ask password
 * for everywhere"): after an unlock in the extension popup, the first visit to Walnut's Passwords
 * page in that same browser is unlocked with no typing, because the extension hands the page its
 * browser key (packages/browser-extension/src/hand-browser-key.ts, page-browser-key.ts;
 * POST /vault/browser-key; web/src/api/vault-live.ts). A Lock in either then locks the other, and a
 * Walnut tab open while the extension unlocks gets its key at once too. Another site gets nothing.
 * Shares the fixture's vault (the same master password as the other specs). Fake data only.
 */
import { expect, test, type Page } from '@playwright/test'
import { startPanelLab, sw, type PanelLab } from './extension-panel-harness'
import { ensureVaultSetUp, VAULT_MASTER } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It names its extension for sharing an unlock and ends every unlock: alone on the vault.
holdVaultLock('exclusive', 'file')

const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/extension-hand-browser-key'
const KEY = 'walnut.vault.browser'
let lab: PanelLab
let device = ''
const handed = new Set<string>()

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

const keyOf = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY)

async function openPasswords(page: Page): Promise<void> {
  await page.goto(`${lab.base}/`)
  await page.waitForLoadState('domcontentloaded')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href="/passwords"]').first().click()
  await expect(page.getByTestId('pw-unlock').or(page.getByTestId('pw-app'))).toBeVisible({ timeout: 30_000 })
}

async function popup(): Promise<Page> {
  const p = await lab.ctx.newPage()
  await p.goto(`chrome-extension://${lab.extId}/popup.html`)
  return p
}

const listOf = (p: Page) => p.getByLabel(/^Search (Walnut|logins)$/)
const unlockOf = (p: Page) => p.getByTestId('popup-unlock')

async function unlockInPopup(p: Page): Promise<void> {
  await expect(unlockOf(p)).toBeVisible({ timeout: 20_000 })
  await p.getByLabel('Master password').fill(VAULT_MASTER)
  await unlockOf(p).click()
  await expect(listOf(p)).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'hand-key')
  await ensureVaultSetUp(lab.doc, lab.base, { password: VAULT_MASTER })
  device = await extensionDevice()
  expect(device).toMatch(/^extension-[0-9a-f]+$/)
  // The fixture shares an unlock only with what a spec names (WALNUT_TEST_VAULT_JOIN=named); a key
  // this extension hands is named with it by the server.
  expect((await lab.doc.request.post(`${lab.base}/api/test/vault-join`, { data: { device, on: true } })).ok()).toBe(true)
  // Nothing unlocked anywhere: whatever another spec left on the shared fixture ends.
  expect((await lab.doc.request.post(`${lab.base}/api/v1/vault/lock`, { data: { everywhere: true } })).ok()).toBe(true)
})

test.afterAll(async () => {
  if (lab) {
    if (device) await lab.doc.request.post(`${lab.base}/api/test/vault-join`, { data: { device, on: false } }).catch(() => undefined)
    for (const browserKey of handed) await lab.doc.request.post(`${lab.base}/api/test/vault-join`, { data: { browserKey, on: false } }).catch(() => undefined)
  }
  await lab?.close()
})

test('after an unlock in the extension popup, Walnut\'s Passwords page in a new tab opens unlocked with no typing', async () => {
  test.setTimeout(180_000)
  // A fresh browser: the master password was never typed in a Walnut window here.
  const before = await lab.ctx.newPage()
  await openPasswords(before)
  await expect(before.getByTestId('pw-unlock')).toBeVisible()
  expect(await keyOf(before)).toBeNull()
  await before.close()

  const p = await popup()
  await unlockInPopup(p)

  const web = await lab.ctx.newPage()
  const t0 = Date.now()
  await openPasswords(web)
  await expect(web.getByTestId('pw-app')).toBeVisible({ timeout: 15_000 })
  await expect(web.getByTestId('pw-unlock')).toHaveCount(0)
  console.log(`[hand-key] Passwords unlocked ${Date.now() - t0} ms after the tab opened`)
  const key = String(await keyOf(web))
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  handed.add(key)
  await web.screenshot({ path: `${SHOTS}/passwords-unlocked-first-visit.png` })

  // Another site in this browser holds no key: the extension hands it to the paired Walnut only.
  expect(await lab.doc.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()

  // The person's Lock in the Walnut window locks the popup.
  await web.getByTestId('pw-lock').click()
  await expect(web.getByTestId('pw-unlock')).toBeVisible({ timeout: 15_000 })
  await expect(unlockOf(p)).toBeVisible({ timeout: 10_000 })

  // And the other way round: an unlock in the popup opens the page (it keeps its key), and the popup's Lock locks it.
  await unlockInPopup(p)
  await expect(web.getByTestId('pw-app')).toBeVisible({ timeout: 15_000 })
  expect(await keyOf(web)).toBe(key)
  await p.getByTestId('popup-lock').click()
  await expect(unlockOf(p)).toBeVisible({ timeout: 10_000 })
  await expect(web.getByTestId('pw-unlock')).toBeVisible({ timeout: 15_000 })
  await expect(web.getByTestId('pw-app')).toHaveCount(0)
  await web.screenshot({ path: `${SHOTS}/passwords-locked-by-popup.png` })
  await web.close()
  await p.close()
})

test('a Walnut tab open and locked while the extension unlocks gets its key at once and opens', async () => {
  test.setTimeout(180_000)
  const web = await lab.ctx.newPage()
  await openPasswords(web)
  await expect(web.getByTestId('pw-unlock')).toBeVisible()
  // This browser has no key (as if Walnut forgot it): the open page cannot share anything yet.
  await web.evaluate((k) => localStorage.removeItem(k), KEY)

  const p = await popup()
  await unlockInPopup(p)
  // No click, no typing, no reload in the Walnut tab.
  await expect(web.getByTestId('pw-app')).toBeVisible({ timeout: 15_000 })
  const key = String(await keyOf(web))
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  handed.add(key)
  await web.screenshot({ path: `${SHOTS}/open-tab-unlocked-by-popup.png` })

  await web.getByTestId('pw-lock').click()
  await expect(unlockOf(p)).toBeVisible({ timeout: 10_000 })
  await web.close()
  await p.close()
})
