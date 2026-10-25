import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'
import { openDraft } from './draft-helpers'

const pill = (page: Page) => page.locator('.stale-build-pill')
const action = (page: Page) => page.locator('.stale-build-pill-action')

test.describe.configure({ timeout: 90_000 })
const SHOTS = '/tmp/mac-update-fix/shots'
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))
test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.setViewportSize({ width: 1200, height: 800 })
})

async function installed(page: Page, available: boolean) {
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { walnutChrome: { postMessage() {} } } } })
  })
  await page.route(/\/api\/system\/desktop-update(\?|$)/, r => r.fulfill({ json: { available, token: available ? '12:old:new' : null } }))
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
  await page.screenshot({ path: `${SHOTS}/web-only-${test.info().project.name}.png` })
  await action(page).click()
  await expect(pill(page)).toHaveCount(0)
})

test('both installed app and web drift have one Restart, never a competing Reload, and it restarts on one click', async ({ page }) => {
  await drift(page)
  await installed(page, true)
  const bodies: unknown[] = []
  await page.route('**/api/system/desktop-update/restart', r => { bodies.push(r.request().postDataJSON()); return r.fulfill({ status: 202, json: { accepted: true } }) })
  await loadApp(page)
  await showDrift(page)
  await expect(pill(page)).toHaveCount(1)
  await expect(action(page)).toHaveText('Restart')
  await expect(pill(page)).toHaveAttribute('data-served', 'new-notice-build')
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/both-${test.info().project.name}.png` })
  await action(page).click()
  await expect.poll(() => bodies).toEqual([{ token: '12:old:new', force: false }])
  await expect(action(page)).toHaveText('Restarting…')
})

test('web reload: a saved session draft never holds it and comes back; a new-session draft is listed first', async ({ page }) => {
  await drift(page)
  await loadApp(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: 'pw-vscode-session' } })))
  const sessionBox = page.locator('.main-page-session-column [data-session-id="pw-vscode-session"] .session-panel-input textarea')
  await expect(sessionBox).toBeVisible()
  await sessionBox.fill('Comes back after the reload')
  const draft = await openDraft(page)
  const input = draft.locator('textarea')
  await input.fill('A new session nobody started yet')
  await showDrift(page)
  await action(page).click()
  const held = page.getByRole('dialog', { name: 'Reload anyway?' })
  await expect(held).toContainText('Unsent text in the new session draft')
  await expect(held).not.toContainText('pw-vscode')
  await expect(held.locator('.unsaved-work-item')).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/reload-held-${test.info().project.name}.png` })
  await held.getByRole('button', { name: 'Cancel' }).click()
  await expect(input).toHaveValue('A new session nobody started yet')
  await input.fill('')
  const loaded = page.waitForEvent('load')
  await action(page).click()
  await loaded
  await expect(page.locator('.main-page-session-column [data-session-id="pw-vscode-session"] .session-panel-input textarea')).toHaveValue('Comes back after the reload', { timeout: 30_000 })
  // The reloaded page still asks for /api/config while the test ends.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('home and popout share the update notice; a popout draft, which a restart does not reopen, is listed; drafts survive a refusal', async ({ page }) => {
  await installed(page, true)
  const bodies: unknown[] = []
  await page.context().route(/\/api\/system\/desktop-update(\?|$)/, r => r.fulfill({ json: { available: true, token: '12:old:new' } }))
  await page.context().route('**/api/system/desktop-update/restart', r => { bodies.push(r.request().postDataJSON()); return r.fulfill({ status: 409, json: { error: 'The installed update changed. Check again before restarting.' } }) })
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
  const held = child.getByRole('dialog', { name: 'Restart Walnut anyway?' })
  await expect(held).toContainText('Unsent text in session')
  await expect(held.locator('.unsaved-work-item')).toHaveCount(1)
  expect(bodies).toEqual([])
  await held.getByRole('button', { name: 'Restart Anyway' }).click()
  const failed = child.getByRole('dialog', { name: 'Could not restart Walnut' })
  await expect(failed).toContainText('The installed update changed')
  expect(bodies).toEqual([{ token: '12:old:new', force: true }])
  await child.screenshot({ path: `${SHOTS}/popout-${test.info().project.name}.png` })
  await failed.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(input).toHaveValue('Keep the child message')
  await expect(action(child)).toHaveText('Restart')
  await expect(parent.locator('.session-panel-input textarea')).toHaveValue('Keep the parent message')
  expect(await child.evaluate(() => localStorage.getItem('draft:session:pw-vscode-session:popout'))).toBe('Keep the child message')
  expect(errors).toEqual([])
  await child.close()
})
