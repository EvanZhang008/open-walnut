import fs from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

const SHOTS = '/tmp/mac-update-fix/shots'
const STATUS = /\/api\/system\/desktop-update(\?|$)/
const button = (page: Page) => page.locator('.stale-build-pill-action')
const unsaved = (page: Page) => page.getByRole('dialog', { name: 'Restart Walnut anyway?' })
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

type Status = { available: boolean; token: string | null; version?: string; restarting?: boolean; error?: string | null; windows?: number }

/** Restart requests the page sent, body by body. */
async function restartRoute(page: Page, answer: (n: number, route: Route) => Promise<void> | void = (_n, r) => r.fulfill({ status: 202, json: { accepted: true } })) {
  const bodies: Array<{ token: string; force: boolean }> = []
  await page.route('**/api/system/desktop-update/restart', (r) => { bodies.push(r.request().postDataJSON()); return answer(bodies.length, r) })
  return bodies
}

async function probeBox(page: Page, text = 'unsent message') {
  await page.evaluate((value) => {
    const t = document.createElement('textarea')
    t.id = 'unsent-probe'
    t.setAttribute('aria-label', 'Probe reply')
    t.value = value
    document.body.append(t)
  }, text)
}

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: {
      walnutChrome: { postMessage: () => {} },
    } } })
  })
})

test('Restart goes at once; a composer draft already saved never holds it, and comes back', async ({ page }) => {
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0', windows: 1 } }))
  const bodies = await restartRoute(page)
  await loadApp(page)
  await expect(button(page)).toHaveText('Restart')
  await expect(page.getByTestId('installed-app-update')).toHaveCount(0)
  // A real session composer (ChatInput with a draft key), typed into right before the click,
  // inside its 300 ms save debounce: the check saves it and the restart goes ahead.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: 'pw-vscode-session' } })))
  const composer = page.locator('.main-page-session-column [data-session-id="pw-vscode-session"] .session-panel-input textarea')
  await expect(composer).toBeVisible()
  await composer.fill('A half-written message the user expects back after the restart')
  await button(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({ token: '12:old:new', force: false })
  await expect(unsaved(page)).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toHaveCount(0)
  await expect(button(page)).toHaveText('Restarting…')
  expect(await page.evaluate(() => localStorage.getItem('draft:session:pw-vscode-session'))).toBe('A half-written message the user expects back after the restart')
  await page.locator('.stale-build-pill').screenshot({ path: `${SHOTS}/installed-restarting-${test.info().project.name}.png` })
})

test('text nobody saves is listed with where it is; Cancel keeps it, Go there focuses it, Restart Anyway forces', async ({ page }) => {
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0', windows: 1 } }))
  const bodies = await restartRoute(page)
  await loadApp(page)
  await probeBox(page)
  await button(page).click()
  await expect(unsaved(page)).toContainText('Unsent text in the “Probe reply” box')
  await expect(unsaved(page)).toContainText('Messages typed in session boxes are kept')
  await page.screenshot({ path: `${SHOTS}/installed-unsaved-${test.info().project.name}.png` })
  expect(bodies).toHaveLength(0)
  await unsaved(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('#unsent-probe')).toHaveValue('unsent message')
  expect(bodies).toHaveLength(0)
  await button(page).click()
  await unsaved(page).getByRole('button', { name: 'Go there' }).click()
  await expect(unsaved(page)).toHaveCount(0)
  await expect(page.locator('#unsent-probe')).toBeFocused()
  expect(bodies).toHaveLength(0)
  await button(page).click()
  await unsaved(page).getByRole('button', { name: 'Restart Anyway' }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({ token: '12:old:new', force: true })
  await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
  await button(page).click({ force: true })
  expect(bodies).toHaveLength(1)
})

test('a pending Scratchpad save is listed; once it lands Restart goes at once', async ({ page }) => {
  let release: (() => void) | undefined
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  const bodies = await restartRoute(page)
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
    await expect(unsaved(page)).toContainText('A note that is still saving in Scratchpad')
    await unsaved(page).getByRole('button', { name: 'Cancel' }).click()
    expect(bodies).toHaveLength(0)
    await expect.poll(() => !!release).toBe(true)
    release!()
    await expect(page.locator('.global-notes-saving')).toHaveCount(0)
    await button(page).click()
    await expect.poll(() => bodies.length).toBe(1)
  } finally { release?.() }
})

test('another app window that this app cannot check is named, and Restart Anyway closes it', async ({ page }) => {
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new', windows: 2 } }))
  const bodies = await restartRoute(page)
  await loadApp(page)
  await button(page).click()
  await expect(unsaved(page)).toContainText('Another Walnut window is open, and this version of the app cannot check it for unsent work.')
  await unsaved(page).getByRole('button', { name: 'Restart Anyway' }).click()
  await expect.poll(() => bodies).toEqual([{ token: '12:old:new', force: true }])
})

test('an unchanged installed app shows no restart notice, and a page without notice=1 hears nothing', async ({ page }) => {
  const asked: string[] = []
  await page.route(STATUS, r => { asked.push(new URL(r.request().url()).search); return r.fulfill({ json: { available: false, token: null, version: null } }) })
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(button(page)).toHaveCount(0)
  await expect.poll(() => asked[0]).toBe('?notice=1')
})

test('restart refusal shows Try Again, which retries', async ({ page }) => {
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new', version: '1.0' } }))
  const bodies = await restartRoute(page, (n, r) => n === 1
    ? r.fulfill({ status: 409, json: { error: 'The installed update changed.' } })
    : r.fulfill({ status: 202, json: { accepted: true } }))
  await loadApp(page)
  await button(page).click()
  const failed = page.getByRole('dialog', { name: 'Could not restart Walnut' })
  await expect(failed).toContainText('The installed update changed.')
  await expect(failed.getByRole('button', { name: 'Close' })).toBeVisible()
  await failed.getByRole('button', { name: 'Try Again' }).click()
  await expect.poll(() => bodies.length).toBe(2)
  await expect(failed).toHaveCount(0)
})

test('a restart timeout reports failure and allows a fresh attempt', async ({ page }) => {
  let release: (() => void) | undefined
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token: '12:old:new' } }))
  const bodies = await restartRoute(page, async (n, r) => {
    if (n === 1) await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ status: 202, json: { accepted: true } }).catch(() => {})
  })
  try {
    await loadApp(page)
    await button(page).click()
    const failed = page.getByRole('dialog', { name: 'Could not restart Walnut' })
    await expect(failed).toBeVisible({ timeout: 15_000 })
    await failed.getByRole('button', { name: 'Close' }).click()
    await button(page).click()
    await expect.poll(() => bodies.length).toBe(2)
  } finally { release?.() }
})

test('Later hides only this installed build, and a new token closes a stale question', async ({ page }) => {
  await page.clock.install()
  let token = '12:old:new'
  await page.route(STATUS, r => r.fulfill({ json: { available: true, token } }))
  await loadApp(page)
  await page.locator('.stale-build-pill-later').click()
  await expect(button(page)).toHaveCount(0)
  token = '12:old:newer'
  await page.clock.fastForward(30_000)
  await expect(button(page)).toHaveText('Restart')
  await probeBox(page)
  await button(page).click()
  await expect(unsaved(page)).toBeVisible()
  token = '12:old:newest'
  await page.clock.fastForward(30_000)
  await expect(unsaved(page)).toHaveCount(0)
  await expect(button(page)).toHaveText('Restart')
})

test('polling stays paused while the restart request is being validated', async ({ page }) => {
  await page.clock.install()
  let reads = 0
  let release: (() => void) | undefined
  await page.route(STATUS, r => { reads++; return r.fulfill({ json: { available: true, token: '12:old:new', error: 'Older failure' } }) })
  await restartRoute(page, async (_n, r) => {
    await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ status: 202, json: { accepted: true } })
  })
  try {
    await loadApp(page)
    await expect(button(page)).toHaveText('Restart')
    await page.clock.fastForward(25_000)
    await button(page).click()
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
  await page.route(STATUS, async r => {
    reads++
    if (reads > 1) await new Promise<void>(resolve => { release = resolve })
    await r.fulfill({ json: { available: true, token: '12:old:new', restarting: false, error: 'Older failure' } })
  })
  await restartRoute(page)
  try {
    await loadApp(page)
    // The next look is armed once the first answer is in.
    await expect(button(page)).toHaveText('Restart')
    await page.clock.fastForward(30_000)
    await expect.poll(() => !!release).toBe(true)
    await button(page).click()
    await expect(button(page)).toHaveText('Restarting…')
    release!()
    await expect(page.getByRole('dialog', { name: 'Could not restart Walnut' })).toHaveCount(0)
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true')
  } finally { release?.() }
})

test('another window restarting is pending, then exposes failure and can retry', async ({ page }) => {
  await page.clock.install()
  let status: Status = { available: true, token: '12:old:new', restarting: true, error: null }
  await page.route(STATUS, r => r.fulfill({ json: status }))
  const bodies = await restartRoute(page)
  await loadApp(page)
  await expect(button(page)).toHaveText('Restarting…')
  await button(page).click({ force: true })
  expect(bodies).toHaveLength(0)
  status = { ...status, restarting: false, error: 'Walnut did not restart. Try again.' }
  await page.clock.fastForward(30_000)
  const failed = page.getByRole('dialog', { name: 'Could not restart Walnut' })
  await expect(failed).toContainText(status.error!)
  await failed.getByRole('button', { name: 'Try Again' }).click()
  await expect.poll(() => bodies.length).toBe(1)
})
