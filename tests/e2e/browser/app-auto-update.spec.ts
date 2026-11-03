/**
 * The Mac app's automatic update, driven by the page (useAppAutoUpdate): with
 * `updates.auto` on it downloads by itself, and once the server's idle gate is
 * ready and no window holds unsaved work it restarts into the download, once.
 * A shell stand-in records what the page asks; /api/system/update is routed for
 * the `live` answer (updatesAuto, idle.ready).
 */
import { test, expect, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

const BASE = {
  enabled: true, status: 'up-to-date', currentVersion: '0.6.8', hostArch: 'arm64', appArch: 'arm64',
  runningUnderArm64Translation: false, availableVersion: null as string | null, downloadedVersion: null as string | null, downloadPercent: null,
  checkedAt: '2026-10-11T00:00:00Z', message: null, errorContext: null, canRetry: false, disabledReason: null,
}
const AVAILABLE = { ...BASE, status: 'available', availableVersion: '0.6.9' }
const DOWNLOADED = { ...AVAILABLE, status: 'downloaded', downloadedVersion: '0.6.9', downloadPercent: 100, canRetry: true }

async function installShell(page: Page, initial: unknown): Promise<void> {
  await page.context().addInitScript((first) => {
    const w = window as unknown as Record<string, unknown>
    const state = first
    const bodies: Array<Record<string, unknown>> = []
    const handler = {
      postMessage(body: Record<string, unknown>) {
        bodies.push(body)
        if (body.op === 'getState') return Promise.resolve({ state })
        // Every other app window answered and holds nothing.
        if (body.op === 'unsavedWindows') return Promise.resolve({ windows: [{ id: 'w1', title: '', isSource: true, items: [] }] })
        if (body.op === 'download' || body.op === 'install') return new Promise(() => {})
        return Promise.reject(new Error(`unknown op ${String(body.op)}`))
      },
    }
    Object.defineProperty(window, 'webkit', { value: { messageHandlers: { walnutUpdate: handler } }, configurable: true })
    w.__shellBodies = bodies
  }, initial)
}

const ops = (page: Page, op: string) => page.evaluate((o) => ((window as unknown as { __shellBodies: Array<{ op: string }> }).__shellBodies)
  .filter((b) => b.op === o), op)

function liveStatus(updatesAuto: boolean, ready: boolean) {
  return {
    enabled: true, install: { kind: 'other', sourceDir: null, packageRoot: null, manager: null, updateCommand: null },
    current: '0.6.8', channel: 'stable', latest: '0.6.8', tags: { latest: '0.6.8', nightly: null }, available: false,
    checkedAt: null, error: null, checking: false, packageUrl: 'u',
    live: { state: 'off', version: null, error: null, canInstall: false, held: null, updatesAuto,
      idle: { ready, userIdleMs: ready ? 700_000 : 2_000, turnsRunning: 0, waitingSince: null } },
  }
}

async function routeStatus(page: Page, first: unknown): Promise<(next: unknown) => void> {
  let cur = first
  await page.route('**/api/system/update', (r) => r.fulfill({ json: cur }))
  return (next) => { cur = next }
}

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.context().route('**/api/system/desktop-update', (route) => route.fulfill({ json: { available: false, token: null, version: null } }))
})

test('updates.auto on: an available release downloads by itself, once', async ({ page }) => {
  await installShell(page, AVAILABLE)
  await routeStatus(page, liveStatus(true, false))
  await loadApp(page)
  await expect.poll(() => ops(page, 'download').then((b) => b.length), { timeout: 20_000 }).toBe(1)
  await page.waitForTimeout(1_000)
  expect(await ops(page, 'download')).toHaveLength(1)
})

test('updates.auto off: nothing downloads by itself; the notice offers Download', async ({ page }) => {
  await installShell(page, AVAILABLE)
  await routeStatus(page, liveStatus(false, true))
  await loadApp(page)
  await expect(page.locator('button.stale-build-pill-action')).toHaveText('Download', { timeout: 20_000 })
  await page.waitForTimeout(1_000)
  expect(await ops(page, 'download')).toHaveLength(0)
})

test('downloaded, idle and nothing unsaved: it restarts into the update once, every window checked', async ({ page }) => {
  await installShell(page, DOWNLOADED)
  await routeStatus(page, liveStatus(true, true))
  await loadApp(page)
  await expect.poll(() => ops(page, 'install').then((b) => b.length), { timeout: 20_000 }).toBe(1)
  expect(await ops(page, 'install')).toEqual([{ op: 'install', force: true }])
  expect(await ops(page, 'confirmInstall')).toHaveLength(0)
  const claim = await page.evaluate(() => JSON.parse(localStorage.getItem('open-walnut-app-auto-update-claim') ?? 'null'))
  expect(claim).toMatchObject({ step: 'restart', version: '0.6.9' })
})

test('downloaded but not idle, or idle with unsaved text: no restart; once both clear, the next look restarts', async ({ page }) => {
  await installShell(page, DOWNLOADED)
  const set = await routeStatus(page, liveStatus(true, false))
  await page.clock.install()
  await loadApp(page)
  await expect(page.locator('button.stale-build-pill-action')).toHaveText('Restart', { timeout: 20_000 })
  // Unsent text in this window.
  await page.evaluate(() => {
    const t = document.createElement('textarea')
    t.id = 'unsent-probe'
    t.setAttribute('aria-label', 'Probe reply')
    t.value = 'unsent message'
    document.body.append(t)
  })
  // The person is away now, but the text is unsaved: the next look still holds it.
  set(liveStatus(true, true))
  const held = page.waitForEvent('console', { predicate: (m) => m.text().includes('unsaved work holds the update') })
  await page.clock.fastForward(61_000)
  await held
  await page.waitForTimeout(500)
  expect(await ops(page, 'install')).toHaveLength(0)
  // The text is gone: the following look restarts.
  await page.evaluate(() => document.getElementById('unsent-probe')?.remove())
  await page.clock.fastForward(61_000)
  // The draft settle before the restart waits on the (fake) clock too.
  await expect.poll(async () => { await page.clock.fastForward(500); return (await ops(page, 'install')).length }, { timeout: 15_000 }).toBe(1)
})
