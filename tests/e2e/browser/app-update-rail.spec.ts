import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

const SHOTS = '/tmp/mac-update-unified/shots'
test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
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

/** Each window gets its own shell stand-in; requests wait for the test's answer. */
async function installShell(page: Page, initial: State): Promise<void> {
  await page.context().addInitScript((first) => {
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
const pill = (page: Page) => page.locator('.stale-build-pill')
const action = (page: Page) => pill(page).locator('button.stale-build-pill-action')
const toast = (page: Page, title: string) => page.locator('.notification-toast', { hasText: title })

async function expectNoSidebarUpdates(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-app-update')).toHaveCount(0)
  await expect(page.getByTestId('installed-app-update')).toHaveCount(0)
}

async function expectNotice(page: Page, status: Status, label: string): Promise<void> {
  await expect(pill(page)).toHaveCount(1)
  await expect(pill(page)).toBeVisible()
  await expect(page.locator('body > .stale-build-pill')).toHaveCount(1)
  await expect(pill(page)).toHaveAttribute('data-update-kind', 'release')
  await expect(action(page)).toHaveAttribute('data-status', status)
  await expect(action(page)).toHaveText(label)
  await expectNoSidebarUpdates(page)
}

async function expectBottomCentered(page: Page): Promise<void> {
  const viewport = page.viewportSize()!
  await expect.poll(async () => pill(page).evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  await expect.poll(async () => {
    const box = await pill(page).boundingBox()
    return box ? Math.abs(box.x + box.width / 2 - viewport.width / 2) : Infinity
  }).toBeLessThanOrEqual(1)
  await expect.poll(async () => pill(page).evaluate((el) => {
    const box = el.getBoundingClientRect()
    return Math.abs(box.bottom + parseFloat(getComputedStyle(el).bottom) - window.innerHeight)
  })).toBeLessThanOrEqual(1)
  const box = (await pill(page).boundingBox())!
  expect(box.y).toBeGreaterThan(viewport.height / 2)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(viewport.height - box.y - box.height).toBeGreaterThan(0)
  expect(viewport.height - box.y - box.height).toBeLessThanOrEqual(128)
}

async function openSessionPopout(page: Page): Promise<Page> {
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  const input = finder.locator('.session-search-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  const query = 'Editor fixture session'
  const answered = page.waitForResponse((res) => {
    const url = new URL(res.url())
    return url.pathname === '/api/sessions/recent' && url.searchParams.get('q') === query
  })
  await input.fill(query)
  await answered
  await expect(finder.locator('.todo-search-spinner')).toHaveCount(0)
  await finder.getByRole('option').filter({ hasText: query }).click()
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]')
  await expect(panel).toBeVisible()
  const opened = page.context().waitForEvent('page')
  const button = panel.locator('.session-panel-popout')
  if (await button.isVisible()) await button.click()
  else {
    await panel.getByTestId('session-header-more-btn').click()
    await page.getByTestId('session-header-more-item-popout').click()
  }
  const child = await opened
  await child.setViewportSize({ width: 1280, height: 840 })
  await expect(child.locator('.popout-session')).toBeVisible({ timeout: 30_000 })
  return child
}

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.context().route('**/api/system/desktop-update', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({ json: { available: false, token: null, version: null } })
  })
})

test('UC-1: a browser tab has no app shell: no update notice, no Settings row', async ({ page }) => {
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
  await expectNoSidebarUpdates(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('#general')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('settings-app-update-row')).toHaveCount(0)
})

test('UC-2: up to date: no update notice; Settings shows the version and checks for updates', async ({ page, browserName }) => {
  await installShell(page, IDLE)
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
  await expectNoSidebarUpdates(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  const row = page.getByTestId('settings-app-update-row')
  await expect(row).toContainText('Walnut app 0.6.8')
  await expect(row).toContainText('Current version of the app.')
  await expect(page.getByTestId('settings-app-update-btn')).toHaveText('Up to Date')
  await page.getByTestId('settings-app-update-btn').click()
  await expect.poll(() => shell.calls(page)).toContain('check')
  await row.screenshot({ path: `${SHOTS}/uc2-settings-row-${browserName}.png` })
})

test('UC-3: available, download progress, Read more, and Restart with native cancel and confirmation', async ({ page, browserName }) => {
  await installShell(page, IDLE)
  await loadApp(page)
  await expect.poll(() => shell.calls(page)).toContain('getState')
  await expect(pill(page)).toHaveCount(0)

  await shell.push(page, AVAILABLE)
  await expectNotice(page, 'available', 'Download')
  await expect(action(page)).toHaveAttribute('title', 'Update 0.6.9 ready to download')
  await expectBottomCentered(page)
  await pill(page).screenshot({ path: `${SHOTS}/uc3-available-${browserName}.png` })

  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(0))
  await expectNotice(page, 'downloading', 'Downloading 0%')
  await shell.push(page, at(42.7))
  await expectNotice(page, 'downloading', 'Downloading 42%')
  await expect(action(page)).toHaveAttribute('title', 'Downloading update (42%)')
  await expect(action(page)).toHaveAttribute('aria-disabled', 'true')
  await action(page).click({ force: true })
  expect((await shell.calls(page)).filter((c) => c === 'download')).toHaveLength(1)
  await pill(page).screenshot({ path: `${SHOTS}/uc3-downloading-${browserName}.png` })

  await shell.push(page, DOWNLOADED)
  await shell.answer(page, 'download', { accepted: true, completed: true, state: DOWNLOADED })
  await expect(toast(page, 'Update downloaded')).toBeVisible()
  await expect(toast(page, 'Update downloaded')).toContainText('Use Restart in the update notice to install it.')
  await expectNotice(page, 'downloaded', 'Restart')
  await expect(action(page)).toHaveAttribute('title', 'Update 0.6.9 downloaded. Click to restart and install.')
  await expect(action(page)).not.toHaveAttribute('aria-disabled', 'true')
  await page.screenshot({ path: `${SHOTS}/uc3-downloaded-${browserName}.png` })
  await toast(page, 'Update downloaded').getByRole('button', { name: 'Read more' }).click()
  await expect.poll(() => shell.calls(page)).toContain('openRelease')

  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await expect(action(page)).toHaveText('Restarting…')
  await shell.answer(page, 'confirmInstall', false)
  await expect(action(page)).not.toHaveAttribute('aria-disabled', 'true')
  await expectNotice(page, 'downloaded', 'Restart')
  expect(await shell.calls(page)).not.toContain('install')

  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  await expectNotice(page, 'downloaded', 'Restarting…')
  await expect(action(page)).toHaveAttribute('aria-disabled', 'true')
  await action(page).click({ force: true })
  expect((await shell.calls(page)).filter((c) => c === 'install')).toHaveLength(1)
  await shell.answer(page, 'install', { accepted: true, completed: true, state: DOWNLOADED })
})

test('UC-4: download errors show a home toast or a popout dialog, and both allow retry', async ({ page, browserName }) => {
  await installShell(page, AVAILABLE)
  await loadApp(page)
  await expectNotice(page, 'available', 'Download')
  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(30))
  await expectNotice(page, 'downloading', 'Downloading 30%')
  const failed: State = { ...AVAILABLE, message: 'The download stopped: The network connection was lost.', errorContext: 'download', canRetry: true }
  await shell.push(page, failed)
  await shell.answer(page, 'download', { accepted: true, completed: false, state: failed })
  await expect(toast(page, 'Could not download update')).toBeVisible()
  await expect(toast(page, 'Could not download update')).toContainText('The network connection was lost.')
  await expect(page.getByRole('dialog', { name: 'Could not update Walnut', exact: true })).toHaveCount(0)
  await expectNotice(page, 'available', 'Download')
  await expect(action(page)).toHaveAttribute('title', 'Update 0.6.9 ready to download')
  await expect(action(page)).not.toHaveAttribute('aria-disabled', 'true')
  await action(page).click()
  await expect.poll(async () => (await shell.calls(page)).filter((c) => c === 'download').length).toBe(2)
  await shell.push(page, DOWNLOADED)
  await shell.answer(page, 'download', { accepted: true, completed: true, state: DOWNLOADED })
  await expectNotice(page, 'downloaded', 'Restart')
  await expect(toast(page, 'Update downloaded')).toBeVisible()

  const child = await openSessionPopout(page)
  try {
    await expectNotice(child, 'available', 'Download')
    await expectBottomCentered(child)
    await action(child).click()
    await expect.poll(() => shell.waiting(child, 'download')).toBe(true)
    await shell.push(child, at(30))
    await expectNotice(child, 'downloading', 'Downloading 30%')
    await shell.push(child, failed)
    await shell.answer(child, 'download', { accepted: true, completed: false, state: failed })
    const dialog = child.getByRole('dialog', { name: 'Could not update Walnut', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('The network connection was lost.')
    await expect(toast(child, 'Could not download update')).toHaveCount(0)
    await child.screenshot({ path: `${SHOTS}/uc4-popout-download-error-${browserName}.png` })
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expectNotice(child, 'available', 'Download')
    await expect(action(child)).not.toHaveAttribute('aria-disabled', 'true')
    await action(child).click()
    await expect.poll(async () => (await shell.calls(child)).filter((c) => c === 'download').length).toBe(2)
    await expect.poll(() => shell.waiting(child, 'download')).toBe(true)
    await shell.answer(child, 'download', { accepted: false, completed: false, state: AVAILABLE })
    await expect(action(child)).not.toHaveAttribute('aria-disabled', 'true')
    await expect(dialog).toHaveCount(0)
  } finally {
    await child.close()
  }
})

test('unsent input arriving during native confirmation prevents installation', async ({ page }) => {
  await installShell(page, DOWNLOADED)
  await loadApp(page)
  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await page.evaluate(() => {
    const draft = document.createElement('textarea')
    draft.id = 'late-update-draft'
    draft.value = 'Keep input written while the confirmation is open'
    document.body.append(draft)
  })
  await shell.answer(page, 'confirmInstall', true)
  await expect(toast(page, 'Could not install update')).toContainText('Save your edits')
  expect(await shell.calls(page)).not.toContain('install')
  await expect(page.locator('#late-update-draft')).toHaveValue('Keep input written while the confirmation is open')
  await page.evaluate(() => document.querySelector('#late-update-draft')!.remove())
  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  await shell.answer(page, 'install', { accepted: true, completed: true, state: DOWNLOADED })
})

test('UC-5: install errors keep Restart available and a second native confirmation retries', async ({ page }) => {
  await installShell(page, DOWNLOADED)
  await loadApp(page)
  await expectNotice(page, 'downloaded', 'Restart')
  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  const failed: State = { ...DOWNLOADED, message: 'Walnut cannot replace itself in /Volumes/Walnut. Move Walnut to the Applications folder, or download it again from the release page.', errorContext: 'install' }
  await shell.push(page, failed)
  await shell.answer(page, 'install', { accepted: true, completed: false, failed: true, state: failed })
  await expect(toast(page, 'Could not install update')).toContainText('Move Walnut to the Applications folder')
  await expect(action(page)).toHaveAttribute('title', 'Update 0.6.9 downloaded. Click to restart and install.')
  await expectNotice(page, 'downloaded', 'Restart')
  await expect(action(page)).not.toHaveAttribute('aria-disabled', 'true')
  await action(page).click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(async () => (await shell.calls(page)).filter((c) => c === 'install').length).toBe(2)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  await shell.answer(page, 'install', { accepted: true, completed: true, state: DOWNLOADED })
})

test('UC-6: one bottom-centered pill stays put when the sidebar expands; Settings drives the same flow', async ({ page, browserName }) => {
  await installShell(page, AVAILABLE)
  await loadApp(page)
  await expect(page.locator('#primary-sidebar')).toHaveClass(/collapsed/)
  await expectNotice(page, 'available', 'Download')
  await expectBottomCentered(page)
  const collapsed = (await pill(page).boundingBox())!
  await page.screenshot({ path: `${SHOTS}/uc6-collapsed-available-${browserName}.png` })
  await shell.push(page, at(64))
  await expectNotice(page, 'downloading', 'Downloading 64%')
  await expectBottomCentered(page)
  await pill(page).screenshot({ path: `${SHOTS}/uc6-collapsed-downloading-${browserName}.png` })
  await shell.push(page, AVAILABLE)
  await expectNotice(page, 'available', 'Download')

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.locator('#primary-sidebar')).not.toHaveClass(/collapsed/)
  await expectNotice(page, 'available', 'Download')
  await expectBottomCentered(page)
  await expect.poll(async () => {
    const box = (await pill(page).boundingBox())!
    return Math.max(Math.abs(box.x - collapsed.x), Math.abs(box.y - collapsed.y))
  }).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/uc6-expanded-${browserName}.png` })

  await page.getByTestId('sidebar-core-app-settings').click()
  const settings = page.getByTestId('settings-app-update-btn')
  await expect(settings).toHaveText('Download')
  await expectNotice(page, 'available', 'Download')
  await expectBottomCentered(page)
  await settings.click()
  await expect.poll(() => shell.waiting(page, 'download')).toBe(true)
  await shell.push(page, at(10))
  await expect(settings).toHaveText('Downloading…')
  await expect(settings).toBeDisabled()
  await expect(page.getByTestId('settings-app-update-row')).toContainText('Downloading update (10%).')
  await expectNotice(page, 'downloading', 'Downloading 10%')
  await expect(action(page)).toHaveAttribute('aria-disabled', 'true')
  await action(page).click({ force: true })
  expect((await shell.calls(page)).filter((c) => c === 'download')).toHaveLength(1)
  await page.getByTestId('settings-app-update-row').screenshot({ path: `${SHOTS}/uc6-settings-downloading-${browserName}.png` })
  await shell.push(page, DOWNLOADED)
  await shell.answer(page, 'download', { accepted: true, completed: true, state: DOWNLOADED })
  await expect(settings).toHaveText('Restart to Update')
  await expect(settings).toBeEnabled()
  await expectNotice(page, 'downloaded', 'Restart')
  await settings.click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', false)
  await expect(settings).toBeEnabled()
  expect(await shell.calls(page)).not.toContain('install')
  await settings.click()
  await expect.poll(() => shell.waiting(page, 'confirmInstall')).toBe(true)
  await shell.answer(page, 'confirmInstall', true)
  await expect.poll(() => shell.waiting(page, 'install')).toBe(true)
  await shell.answer(page, 'install', { accepted: true, completed: true, state: DOWNLOADED })
})

test('UC-7: an app that cannot update itself explains why in Settings and offers no update notice', async ({ page }) => {
  await installShell(page, { ...IDLE, enabled: false, status: 'disabled', disabledReason: 'Move Walnut to the Applications folder to get updates.' })
  await loadApp(page)
  await expect(page.locator('.sidebar-voice-btn')).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
  await expectNoSidebarUpdates(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-app-update-row')).toContainText('Move Walnut to the Applications folder to get updates.')
  await expect(page.getByTestId('settings-app-update-btn')).toBeDisabled()
})
