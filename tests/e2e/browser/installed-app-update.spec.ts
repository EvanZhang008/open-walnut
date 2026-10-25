import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

const SHOTS = '/tmp/mac-update-unified/shots'
const button = (page: Page) => page.locator('.stale-build-pill-action')
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))
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

test('installed update notice confirms, cancels, protects drafts and restarts once', async ({ page }) => {
  let restarts = 0
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  await page.route('**/api/system/desktop-update/restart', r => {
    restarts++
    return r.fulfill({ status: 202, json: { accepted: true } })
  })
  await loadApp(page)
  const action = button(page)
  await expect(action).toHaveText('Restart')
  await expect(page.locator('.stale-build-pill')).toHaveCount(1)
  await expect(page.getByTestId('installed-app-update')).toHaveCount(0)
  await page.locator('.stale-build-pill').screenshot({ path: `${SHOTS}/installed-${test.info().project.name}.png` })
  await action.click()
  await expect(page.getByRole('dialog', { name: 'Restart to use the installed update?' })).toBeVisible()
  await page.getByRole('button', { name: 'Not Now' }).click()
  expect(restarts).toBe(0)
  await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'unsent-probe'; t.value = 'unsent message'; document.body.append(t) })
  await action.click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Save your edits')
  expect(restarts).toBe(0)
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await page.evaluate(() => document.getElementById('unsent-probe')!.remove())
  await action.click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(action).toHaveAttribute('aria-disabled', 'true')
  await action.click({ force: true })
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
    await button(page).click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Save your edits')
    expect(restarts).toBe(0)
    await expect.poll(() => !!release).toBe(true)
    release!()
    await expect(page.locator('.global-notes-saving')).toHaveCount(0)
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await button(page).click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect.poll(() => restarts).toBe(1)
  } finally { release?.() }
})

test('an unchanged installed app shows no restart info', async ({ page }) => {
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: false, token: null, version: null } }))
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(button(page)).toHaveCount(0)
})

test('restart refusal keeps the update available for retry', async ({ page }) => {
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  let attempts = 0
  await page.route('**/api/system/desktop-update/restart', r => {
    attempts++
    return attempts === 1 ? r.fulfill({ status: 409, json: { error: 'The installed update changed.' } })
      : r.fulfill({ status: 202, json: { accepted: true } })
  })
  await loadApp(page)
  await button(page).click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('The installed update changed.')
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(button(page)).not.toHaveAttribute('aria-disabled', 'true')
  await button(page).click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect.poll(() => attempts).toBe(2)
})

test('a restart timeout reports failure and allows a fresh attempt', async ({ page }) => {
  let attempts = 0
  let release: (() => void) | undefined
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new' } }))
  await page.route('**/api/system/desktop-update/restart', async r => {
    attempts++
    if (attempts === 1) await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ status: 202, json: { accepted: true } }).catch(() => {})
  })
  try {
    await loadApp(page)
    await button(page).click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await button(page).click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect.poll(() => attempts).toBe(2)
  } finally { release?.() }
})

test('Later hides only this installed build and a new token dismisses stale confirmation', async ({ page }) => {
  await page.clock.install()
  let token = '12:old:new'
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token } }))
  await loadApp(page)
  await page.locator('.stale-build-pill-later').click()
  await expect(button(page)).toHaveCount(0)
  token = '12:old:newer'
  await page.clock.fastForward(30_000)
  await expect(button(page)).toHaveText('Restart')
  await button(page).click()
  await expect(page.getByRole('dialog', { name: 'Restart to use the installed update?' })).toBeVisible()
  token = '12:old:newest'
  await page.clock.fastForward(30_000)
  await expect(page.getByRole('dialog', { name: 'Restart to use the installed update?' })).toHaveCount(0)
  await expect(button(page)).toHaveText('Restart')
})

test('polling stays paused while the restart request is being validated', async ({ page }) => {
  await page.clock.install()
  let reads = 0
  let release: (() => void) | undefined
  await page.route('**/api/system/desktop-update', r => { reads++; return r.fulfill({ json: { available: true, token: '12:old:new', error: 'Older failure' } }) })
  await page.route('**/api/system/desktop-update/restart', async r => {
    await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ status: 202, json: { accepted: true } })
  })
  try {
    await loadApp(page)
    await page.clock.fastForward(25_000)
    await button(page).click()
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect.poll(() => !!release).toBe(true)
    await page.clock.fastForward(5_000)
    expect(reads).toBe(1)
    await expect(button(page)).toHaveText('Restarting…')
    release!()
  } finally { release?.() }
})

test('a status read dispatched before restart cannot release the pending action', async ({ page }) => {
  await page.clock.install()
  let reads = 0
  let release: (() => void) | undefined
  await page.route('**/api/system/desktop-update', async r => {
    reads++
    if (reads > 1) await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ json: { available: true, token: '12:old:new', restarting: false, error: 'Older failure' } })
  })
  await page.route('**/api/system/desktop-update/restart', r => r.fulfill({ status: 202, json: { accepted: true } }))
  try {
    await loadApp(page)
    await button(page).click()
    await page.clock.fastForward(30_000)
    await expect.poll(() => !!release).toBe(true)
    await page.getByRole('button', { name: 'Restart Now' }).click()
    await expect(button(page)).toHaveText('Restarting…')
    release!()
    await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toHaveCount(0)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
  } finally { release?.() }
})

test('another window restarting is pending, then exposes failure and can retry', async ({ page }) => {
  await page.clock.install()
  let status = { available: true, token: '12:old:new', restarting: true, error: null as string | null }
  let attempts = 0
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: status }))
  await page.route('**/api/system/desktop-update/restart', r => { attempts++; return r.fulfill({ status: 202, json: { accepted: true } }) })
  await loadApp(page)
  await expect(button(page)).toHaveText('Restarting…')
  await button(page).click({ force: true })
  expect(attempts).toBe(0)
  status = { ...status, restarting: false, error: 'Close extra app windows and try again.' }
  await page.clock.fastForward(30_000)
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText(status.error!)
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(button(page)).toHaveText('Restart')
  await button(page).click()
  await page.getByRole('button', { name: 'Restart Now' }).click()
  await expect.poll(() => attempts).toBe(1)
})
