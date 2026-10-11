/**
 * The Mac app's update item in the rail and its row in Settings → General
 * (T3 Code's update flow; the shell side is desktop/AppUpdater.swift).
 *
 * The page talks to the app shell through `webkit.messageHandlers.walnutUpdate`
 * (a promise per request) and hears its state as `walnut:app-update` events.
 * A browser has no shell, so each test installs a stand-in for that handler
 * before the page loads; the test plays the shell, pushing states and answering
 * requests the way AppUpdater does. scripts/desktop-update-e2e.mjs runs the
 * same clicks against the real app.
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test app-update-rail --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test app-update-rail --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

const SHOTS = '/tmp/walnut-app-update/shots'
test.describe.configure({ timeout: 90_000 })
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

type Status = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
interface State {
  enabled: boolean; status: Status; currentVersion: string; hostArch: string; appArch: string
  runningUnderArm64Translation: boolean; availableVersion: string | null; downloadedVersion: string | null
  downloadPercent: number | null; checkedAt: string | null; message: string | null
  errorContext: 'check' | 'download' | 'install' | null; canRetry: boolean; disabledReason: string | null
}
const IDLE: State = {
  enabled: true, status: 'up-to-date', currentVersion: '0.6.8', hostArch: 'arm64', appArch: 'arm64',
  runningUnderArm64Translation: false, availableVersion: null, downloadedVersion: null, downloadPercent: null,
  checkedAt: '2026-10-11T00:00:00Z', message: null, errorContext: null, canRetry: false, disabledReason: null,
}
const AVAILABLE: State = { ...IDLE, status: 'available', availableVersion: '0.6.9' }
const at = (pct: number): State => ({ ...AVAILABLE, status: 'downloading', downloadPercent: pct })
const DOWNLOADED: State = { ...AVAILABLE, status: 'downloaded', downloadedVersion: '0.6.9', downloadPercent: 100, canRetry: true }

/**
 * The stand-in shell: records every request; `download` and `confirmInstall`
 * wait until the test answers them (window.__shell.answer(op, value)).
 */
async function installShell(page: Page, initial: State): Promise<void> {
  await page.addInitScript((first) => {
    const w = window as unknown as Record<string, unknown>
    let state = first as Record<string, unknown>
    const calls: string[] = []
    const waiting: Record<string, (v: unknown) => void> = {}
    const push = (s: Record<string, unknown>) => {
      state = s
      window.dispatchEvent(new CustomEvent('walnut:app-update', { detail: s }))
    }
    const handler = {
      postMessage(body: { op: string }) {
        calls.push(body.op)
        if (body.op === 'getState') return Promise.resolve({ state })
        if (body.op === 'check') return Promise.resolve({ checked: true, state })
        if (body.op === 'download' || body.op === 'confirmInstall' || body.op === 'install') {
          return new Promise((resolve) => { waiting[body.op] = resolve })
        }
        if (body.op === 'openRelease') return Promise.resolve(true)
        return Promise.reject(new Error(`unknown op ${body.op}`))
      },
    }
    const wk = (w.webkit as { messageHandlers?: Record<string, unknown> } | undefined)
    if (wk && wk.messageHandlers) Object.defineProperty(wk.messageHandlers, 'walnutUpdate', { value: handler, configurable: true })
    else Object.defineProperty(window, 'webkit', { value: { messageHandlers: { walnutUpdate: handler } }, configurable: true })
    w.__shell = {
      calls,
      push,
      state: () => state,
      answer(op: string, value: unknown) { const r = waiting[op]; delete waiting[op]; r?.(value) },
      waitingFor: (op: string) => op in waiting,
    }
  }, initial)
}

const shell = {
  push: (page: Page, s: State) => page.evaluate((st) => (window as any).__shell.push(st), s),
  calls: (page: Page) => page.evaluate(() => [...(window as any).__shell.calls] as string[]),
  waiting: (page: Page, op: string) => page.evaluate((o) => (window as any).__shell.waitingFor(o), op),
  answer: (page: Page, op: string, value: unknown) => page.evaluate(([o, v]) => (window as any).__shell.answer(o, v), [op, value] as const),
}
const item = (page: Page) => page.getByTestId('sidebar-app-update')
const toast = (page: Page, title: string) => page.locator('.notification-toast', { hasText: title })

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
})

test('UC-1: a browser tab has no app shell: no rail item, no Settings row', async ({ page }) => {
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(item(page)).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('#general')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('settings-app-update-row')).toHaveCount(0)
})

test('UC-2: up to date: the rail stays as it is; Settings shows the version and Check for Updates', async ({ page, browserName }) => {
  await installShell(page, IDLE)
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(item(page)).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-settings').click()
  const row = page.getByTestId('settings-app-update-row')
  await expect(row).toContainText('Walnut app 0.6.8')
  await expect(row).toContainText('Current version of the app.')
  await expect(page.getByTestId('settings-app-update-btn')).toHaveText('Up to Date')
  await page.getByTestId('settings-app-update-btn').click()
  await expect.poll(() => shell.calls(page)).toContain('check')
  await row.screenshot({ path: `${SHOTS}/uc2-settings-row-${browserName}.png` })
})

test('UC-3: available, download with progress, downloaded toast, then Restart to update after the confirmation', async ({ page, browserName }) => {
  await installShell(page, IDLE)
  await loadApp(page)
  await expect(item(page)).toHaveCount(0)

  // The check finds 0.6.9: the item appears above Voice.
  await shell.push(page, AVAILABLE)
  await expect(item(page)).toBeVisible()
  await expect(item(page)).toHaveAttribute('data-status', 'available')
  await expect(item(page)).toHaveAttribute('title', 'Update 0.6.9 ready to download')
  await expect(item(page).locator('.sidebar-label')).toHaveText('Update available')
  const voice = await page.locator('.sidebar-voice-btn').boundingBox()
  const box = await item(page).boundingBox()
  expect(box!.y).toBeLessThan(voice!.y)
  expect(Math.abs(box!.height - voice!.height)).toBeLessThanOrEqual(1)
  await page.locator('.sidebar-notification-area').screenshot({ path: `${SHOTS}/uc3-available-${browserName}.png` })

  // One click downloads; the item answers at once and a second click does nothing.
  await item(page).click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(0))
  await shell.push(page, at(42.7))
  await expect(item(page).locator('.sidebar-label')).toHaveText('Downloading 42%')
  await expect(item(page)).toHaveAttribute('aria-disabled', 'true')
  await item(page).click({ force: true })
  expect((await shell.calls(page)).filter((c) => c === 'download')).toHaveLength(1)
  await page.locator('.sidebar-notification-area').screenshot({ path: `${SHOTS}/uc3-downloading-${browserName}.png` })

  // Downloaded: the toast says where to restart, the item turns into the restart.
  await shell.push(page, DOWNLOADED)
  await shell.answer(page, 'download', { accepted: true, completed: true, state: DOWNLOADED })
  await expect(toast(page, 'Update downloaded')).toBeVisible()
  await expect(toast(page, 'Update downloaded')).toContainText('Restart from the update button in the sidebar')
  await expect(item(page).locator('.sidebar-label')).toHaveText('Restart to update')
  await expect(item(page)).toHaveAttribute('title', 'Update 0.6.9 downloaded. Click to restart and install.')
  await page.screenshot({ path: `${SHOTS}/uc3-downloaded-${browserName}.png` })
  await toast(page, 'Update downloaded').getByRole('button', { name: 'Read more' }).click()
  await expect.poll(() => shell.calls(page)).toContain('openRelease')

  // Restart asks the app's confirmation first; Cancel installs nothing.
  await item(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', false)
  await expect(item(page)).not.toHaveClass(/is-pending/)
  expect(await shell.calls(page)).not.toContain('install')

  // Yes: the install request goes to the shell (which quits the app from here).
  await item(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.calls(page)).toContain('install')
})

test('UC-4: a download that breaks off: an error toast with the reason, and the item offers the retry', async ({ page }) => {
  await installShell(page, AVAILABLE)
  await loadApp(page)
  await item(page).click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(30))
  const failed: State = { ...AVAILABLE, message: 'The download stopped: The network connection was lost.', errorContext: 'download', canRetry: true }
  await shell.push(page, failed)
  await shell.answer(page, 'download', { accepted: true, completed: false, state: failed })
  await expect(toast(page, 'Could not download update')).toBeVisible()
  await expect(toast(page, 'Could not download update')).toContainText('The network connection was lost.')
  await expect(item(page).locator('.sidebar-label')).toHaveText('Retry update')
  // T3's words for a failed download: the state is back to "available".
  await expect(item(page)).toHaveAttribute('title', 'Update 0.6.9 ready to download')
  await item(page).click()
  await expect.poll(async () => (await shell.calls(page)).filter((c) => c === 'download').length).toBe(2)
})

test('UC-5: an install that cannot replace the app: the error toast, and the restart stays offered', async ({ page }) => {
  await installShell(page, DOWNLOADED)
  await loadApp(page)
  await item(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  const failed: State = { ...DOWNLOADED, message: 'Walnut cannot replace itself in /Volumes/Walnut. Move Walnut to the Applications folder, or download it again from the release page.', errorContext: 'install' }
  await shell.push(page, failed)
  await shell.answer(page, 'install', { accepted: true, completed: false, failed: true, state: failed })
  await expect(toast(page, 'Could not install update')).toContainText('Move Walnut to the Applications folder')
  await expect(item(page)).toHaveAttribute('title', 'Update 0.6.9 downloaded. Click to restart and install.')
  await expect(item(page).locator('.sidebar-label')).toHaveText('Restart to update')
})

test('UC-6: the collapsed rail shows the icon alone, inside the rail; expanded it names the step; Settings drives the same flow', async ({ page, browserName }) => {
  await installShell(page, AVAILABLE)
  await loadApp(page)
  // The rail starts collapsed (icons only).
  await expect(page.locator('#primary-sidebar')).toHaveClass(/collapsed/)
  await expect(item(page)).toBeVisible()
  await expect(item(page).locator('.sidebar-label')).toBeHidden()
  const rail = await page.locator('#primary-sidebar').boundingBox()
  const icon = await item(page).locator('svg').boundingBox()
  expect(icon!.x).toBeGreaterThanOrEqual(rail!.x)
  expect(icon!.x + icon!.width).toBeLessThanOrEqual(rail!.x + rail!.width)
  await page.locator('.sidebar-notification-area').screenshot({ path: `${SHOTS}/uc6-collapsed-available-${browserName}.png` })
  await shell.push(page, at(64))
  await expect(item(page).locator('svg')).toHaveAttribute('data-icon', 'downloading')
  await page.locator('.sidebar-notification-area').screenshot({ path: `${SHOTS}/uc6-collapsed-downloading-${browserName}.png` })
  await shell.push(page, AVAILABLE)

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.locator('#primary-sidebar')).not.toHaveClass(/collapsed/)
  await expect(item(page).locator('.sidebar-label')).toBeVisible()
  await expect(item(page).locator('.sidebar-label')).toHaveText('Update available')
  // The row lines up with its neighbour Voice (the rail's own row width), once
  // the expanded rail has settled.
  const rightEdge = async (sel: ReturnType<typeof item>) => { const b = await sel.boundingBox(); return b ? b.x + b.width : NaN }
  await expect.poll(async () => Math.abs(await rightEdge(item(page)) - await rightEdge(page.locator('.sidebar-voice-btn')))).toBeLessThanOrEqual(1)
  await page.locator('.sidebar-notification-area').screenshot({ path: `${SHOTS}/uc6-expanded-${browserName}.png` })

  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-app-update-btn')).toHaveText('Download')
  await page.getByTestId('settings-app-update-btn').click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(10))
  await expect(page.getByTestId('settings-app-update-btn')).toHaveText('Downloading…')
  await expect(page.getByTestId('settings-app-update-btn')).toBeDisabled()
  await expect(page.getByTestId('settings-app-update-row')).toContainText('Downloading update (10%).')
  await page.getByTestId('settings-app-update-row').screenshot({ path: `${SHOTS}/uc6-settings-downloading-${browserName}.png` })
})

test('UC-7: an app that does not update itself says why in Settings and offers nothing in the rail', async ({ page }) => {
  await installShell(page, { ...IDLE, enabled: false, status: 'disabled', disabledReason: 'Move Walnut to the Applications folder to get updates.' })
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(item(page)).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-app-update-row')).toContainText('Move Walnut to the Applications folder to get updates.')
  await expect(page.getByTestId('settings-app-update-btn')).toBeDisabled()
})
