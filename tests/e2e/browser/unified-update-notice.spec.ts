import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'
import { openDraft } from './draft-helpers'

const pill = (page: Page) => page.locator('.stale-build-pill')
const action = (page: Page) => page.locator('.stale-build-pill-action')

test.describe.configure({ timeout: 90_000 })
test.beforeAll(() => fs.mkdirSync('/tmp/mac-update-unified/shots', { recursive: true }))
test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.setViewportSize({ width: 1200, height: 800 })
})

async function installed(page: Page, available: boolean) {
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { walnutChrome: { postMessage() {} } } } })
  })
  await page.route('**/api/system/desktop-update', r => r.fulfill({ json: { available, token: available ? '12:old:new' : null } }))
}

async function drift(page: Page) {
  test.skip(process.env.PW_BUILT_SPA !== '1', 'Bundle drift needs the hashed production build')
  await page.clock.install()
  await page.route('**/api/config', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), webAssets: { bundle: 'new-notice-build' } } })
  })
}

async function showDrift(page: Page) {
  const compared = page.waitForEvent('console', { predicate: message => message.text().includes('server serves a newer build than this tab runs') })
  await page.clock.fastForward(10 * 60_000)
  await compared
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  await page.clock.fastForward(3 * 60_000)
}

test('web-only drift offers Reload, Later hides one build, and reload is explicit', async ({ page }) => {
  await drift(page)
  await loadApp(page)
  await expect(pill(page)).toHaveCount(0)
  await showDrift(page)
  await expect(action(page)).toHaveText('Reload')
  await expect(pill(page)).toHaveAttribute('data-update-kind', 'web')
  const box = (await pill(page).boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - 600)).toBeLessThan(2)
  await page.screenshot({ path: '/tmp/mac-update-unified/shots/web-only.png' })
  await action(page).click()
  await expect(pill(page)).toHaveCount(0)
})

test('both installed app and web drift have one Restart, never a competing Reload', async ({ page }) => {
  await drift(page)
  await installed(page, true)
  let restarts = 0
  await page.route('**/api/system/desktop-update/restart', r => { restarts++; return r.fulfill({ status: 202, json: { accepted: true } }) })
  await loadApp(page)
  await showDrift(page)
  await expect(pill(page)).toHaveCount(1)
  await expect(action(page)).toHaveText('Restart')
  await expect(pill(page)).toHaveAttribute('data-served', 'new-notice-build')
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0)
  await action(page).click()
  await page.getByRole('button', { name: 'Not Now' }).click()
  expect(restarts).toBe(0)
  await page.screenshot({ path: '/tmp/mac-update-unified/shots/both.png' })
  await pill(page).getByRole('button', { name: 'Later: hide this update notice' }).click()
  await expect(pill(page)).toHaveCount(0)
})

test('web reload keeps dirty text until the user confirms, and confirmation can expire', async ({ page }) => {
  await drift(page)
  await loadApp(page)
  const draft = await openDraft(page)
  const input = draft.locator('textarea')
  await input.fill('Keep this unsent message until I explicitly reload')
  await showDrift(page)
  await action(page).click()
  await expect(action(page)).toHaveText('Reload anyway')
  await expect(input).toHaveValue('Keep this unsent message until I explicitly reload')
  await page.clock.fastForward(8_000)
  await expect(action(page)).toHaveText('Reload')
  await action(page).click()
  await action(page).click()
  await expect(pill(page)).toHaveCount(0)
})

test('home and popout share the update priority and keep their drafts through cancel and refusal', async ({ page }) => {
  await installed(page, true)
  let restarts = 0
  await page.context().route('**/api/system/desktop-update', r => r.fulfill({ json: { available: true, token: '12:old:new' } }))
  await page.context().route('**/api/system/desktop-update/restart', r => { restarts++; return r.fulfill({ status: 409, json: { error: 'Close extra app windows and try again.' } }) })
  await loadApp(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: 'pw-vscode-session' } })))
  const parent = page.locator('.main-page-session-column [data-session-id="pw-vscode-session"]')
  await expect(parent).toBeVisible()
  await parent.locator('.session-panel-input textarea').fill('Keep the parent message')
  const opened = page.context().waitForEvent('page')
  await parent.locator('.session-panel-popout').click()
  const child = await opened
  const errors: string[] = []
  child.on('pageerror', e => errors.push(e.message))
  await expect(child.locator('.session-panel-input textarea')).toBeVisible()
  await expect(pill(child)).toHaveCount(1)
  await expect(action(child)).toHaveText('Restart')
  await expect(child.getByTestId('installed-app-update')).toHaveCount(0)
  const input = child.locator('.session-panel-input textarea')
  await input.fill('Keep the child message')
  await action(child).click()
  await child.getByRole('button', { name: 'Not Now' }).click()
  await action(child).click()
  await child.getByRole('button', { name: 'Restart Now' }).click()
  await expect(child.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Save your edits')
  expect(restarts).toBe(0)
  await child.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(input).toHaveValue('Keep the child message')
  await input.fill('')
  await action(child).click()
  await child.getByRole('button', { name: 'Restart Now' }).click()
  await expect(child.getByRole('dialog', { name: 'Could not restart Walnut' })).toContainText('Close extra app windows')
  expect(restarts).toBe(1)
  await child.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(action(child)).toHaveText('Restart')
  await expect(parent.locator('.session-panel-input textarea')).toHaveValue('Keep the parent message')
  await child.screenshot({ path: '/tmp/mac-update-unified/shots/popout.png' })
  expect(errors).toEqual([])
  await child.close()
})
