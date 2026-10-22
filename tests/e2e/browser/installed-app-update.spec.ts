import { test, expect } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: {
      walnutChrome: { postMessage: () => {} },
    } } })
  })
})

test('installed build info button confirms, cancels, protects drafts and restarts once', async ({ page }) => {
  let restarts = 0
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  await page.route('**/api/system/desktop-update/restart', r => {
    restarts++
    return r.fulfill({ status: 202, json: { accepted: true } })
  })
  await loadApp(page)
  const button = page.getByTestId('installed-app-update')
  await expect(button).toBeVisible()
  await page.locator('.sidebar-notification-area').screenshot({ path: `/tmp/mac-installed-update/info-${test.info().project.name}.png` })
  await button.click()
  await expect(page.getByRole('dialog', { name: 'Restart to use the installed update?' })).toBeVisible()
  await page.getByRole('button', { name: 'Not Now' }).click()
  expect(restarts).toBe(0)
  await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'unsent-probe'; t.value = 'unsent message'; document.body.append(t) })
  await button.click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Save your edits')
  expect(restarts).toBe(0)
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await page.evaluate(() => document.getElementById('unsent-probe')!.remove())
  await button.click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await button.click({ force: true })
  expect(restarts).toBe(1)
})

test('a pending Scratchpad save blocks restart until it succeeds', async ({ page }) => {
  let release: (() => void) | undefined
  let restarts = 0
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  await page.route('**/api/system/desktop-update/restart', r => { restarts++; return r.fulfill({ status: 202, json: { accepted: true } }) })
  await page.route('**/api/notes/global', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { content: 'Initial scratchpad', contentHash: 'initial' } })
    await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ json: { ok: true, contentHash: 'saved' } })
  })
  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'Scratchpad', exact: true }).click()
    const editor = page.locator('.global-notes-section .tiptap')
    await expect(editor).toBeVisible()
    await editor.fill('Pending scratchpad edit')
    await expect(page.locator('.global-notes-saving')).toBeVisible()
    await page.getByTestId('installed-app-update').click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Save your edits')
    expect(restarts).toBe(0)
    await expect.poll(() => !!release).toBe(true)
    release!()
    await expect(page.locator('.global-notes-saving')).toHaveCount(0)
  } finally { release?.() }
})

test('an unchanged installed app shows no restart info', async ({ page }) => {
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: false, token: null, version: null } }))
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(page.getByTestId('installed-app-update')).toHaveCount(0)
})

test('restart refusal keeps the update available for retry', async ({ page }) => {
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  await page.route('**/api/system/desktop-update/restart', r => r.fulfill({ status: 409, json: { error: 'The installed update changed.' } }))
  await loadApp(page)
  await page.getByTestId('installed-app-update').click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('The installed update changed.')
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(page.getByTestId('installed-app-update')).not.toHaveAttribute('aria-disabled', 'true')
})
