/**
 * Helpers for the host-problems specs that run against the SERVER's host
 * fixture (src/core/hosts/host-fixture.ts, POST /api/test/host-fixture): the
 * frames are the real buildHostStatus, Retry / Check again / Update and the
 * Start gate are the real routes, and fixture hosts list folders and spawn
 * sessions through the MockDaemon, so no ssh is ever dialed.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test'
import { draftComposer, draftCwdPill, openDraft, draftSend } from './draft-helpers'
import { hostFixture, isolatePrefs, resetServerHostFixture, waitForHome } from './host-problems-helpers'

export { hostFixture, isolatePrefs, resetServerHostFixture }

export interface WireHost {
  host: string; label: string; connected: boolean; phase: string; phaseLabel?: string
  kind?: string; hint?: string; error?: string; retryable?: boolean; retryAt?: number
  lastKind?: string; lastError?: string
  readiness?: {
    checkedAt: number
    problems: Array<{ kind: string; message: string; commands: string[] }>
    claude?: { version?: string; minVersion?: string; versionOk?: boolean }
  }
}

export interface FixtureCounters {
  connect: Record<string, number>; check: Record<string, number>; listDirs: Record<string, number>
  failureCacheCleared: Record<string, number>; readinessRpc: number; spawns: string[]
}

/** One host as GET /api/hosts/status reports it right now. */
export async function wireHost(request: APIRequestContext, host: string): Promise<WireHost> {
  const res = await request.get('/api/hosts/status')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { hosts: WireHost[] }
  const found = body.hosts.find((h) => h.host === host)
  expect(found, `${host} in /api/hosts/status`).toBeTruthy()
  return found!
}

export async function fixtureCounters(request: APIRequestContext): Promise<FixtureCounters> {
  const res = await request.get('/api/test/host-fixture/counters')
  expect(res.ok()).toBe(true)
  return await res.json() as FixtureCounters
}

/** Reset, then load a named fixture or an inline file. */
export async function loadFixture(request: APIRequestContext, fixture: string | Record<string, unknown>): Promise<void> {
  await resetServerHostFixture(request)
  await hostFixture(request, typeof fixture === 'string' ? { action: 'load', fixture } : { action: 'load', file: fixture })
}

/** An inline fixture file: neutral user, the default floor, the default folder tree. */
export function fixtureFile(hosts: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: 'dev', floor: { minVersion: '2.1.280', model: 'Opus 5.5' },
    dirs: { '/home/dev': ['work'], '/home/dev/work': ['api', 'web'], '/home/dev/work/api': ['src'], '/home/dev/work/web': ['src'] },
    hosts, ...extra,
  }
}

export const HEALTHY = { version: '2.1.281', auth: 'ok', installMethod: 'native' }

/** The first load (the only page.goto): Home, or Settings. */
export async function loadApp(page: Page, path: '/' | '/settings' = '/'): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  if (path === '/') await waitForHome(page)
  else await expect(page.getByTestId('settings-nav-remote-hosts')).toBeVisible({ timeout: 30_000 })
}

/** Rail Settings, then the Remote Hosts pane (real clicks). */
export async function openRemoteHosts(page: Page): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/settings')) await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-remote-hosts').click()
  await expect(page.locator('#remote-hosts')).toBeVisible({ timeout: 20_000 })
}

export const hostRow = (page: Page, alias: string): Locator => page.locator(`#rh-host-${alias}`)
/** The Ask Walnut slot's card: only under slotLayout (the task panel hidden, the slot shown). */
export const slotBanner = (page: Page): Locator => page.locator('.main-page-chat [data-testid="attention-banner"]')
/** The task panel's card (the default layout). */
export const tasksBanner = (page: Page): Locator => page.locator('.todo-panel [data-testid="attention-banner"][data-mount="tasks"]')
/**
 * Any attention card inside the notification panel. There is none, on any
 * section: System lists each host once instead (its Remote hosts block), so
 * specs assert this count stays 0.
 */
export const panelBanner = (page: Page): Locator => page.locator('.notification-panel [data-testid="attention-banner"]')
/** The rail's bell (the notification panel's opener and its dot). */
export const bell = (page: Page): Locator => page.locator('.sidebar-notification-btn')

/** Open the notification panel with a real click on the bell. */
export async function openBell(page: Page): Promise<Locator> {
  // A phone keeps the rail behind the menu button: a user opens it first, then taps the bell.
  if (!(await bell(page).isVisible())) await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await bell(page).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}
/** A host's row in THE banner, wherever it is mounted (the slot, or the draft column while a draft borrows the slot). */
export const bannerRow = (page: Page, host: string): Locator => page.locator(`[data-testid="attention-banner"] li.hpb-row[data-host="${host}"]`)
export const picker = (page: Page): Locator => page.locator('.session-path-selector')
export const hostTab = (page: Page, host: string): Locator => picker(page).locator(`.sps-host-tab[data-host="${host}"]`)

/** Open a draft and its folder picker; returns the draft panel. */
export async function openPicker(page: Page, waitForHost = 'devbox'): Promise<Locator> {
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 10_000 })
  await expect(hostTab(page, waitForHost)).toBeVisible({ timeout: 20_000 })
  return panel
}

/**
 * In the open picker: the host's tab, then a typed folder confirmed with
 * Shift+Enter. `live` waits for the host's listing first (a failed or off host
 * has none; its typed path is confirmed as is).
 */
export async function pickFolder(page: Page, panel: Locator, host: string, dir: string, opts: { live?: boolean } = {}): Promise<void> {
  await hostTab(page, host).click()
  await expect(hostTab(page, host)).toHaveClass(/active/)
  const input = picker(page).locator('.sps-search-input')
  await input.fill(dir)
  if (opts.live !== false) await expect(picker(page).locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  await input.press('Shift+Enter')
  await expect(picker(page)).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText(dir.split('/').filter(Boolean).pop()!)
}

/** Type a message and press Start; resolves with the quick-start response. */
export async function start(page: Page, panel: Locator, text: string): Promise<Response> {
  await draftComposer(page).fill(text)
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftSend(panel).click()
  return res
}

/** A session on `host` through the API (a history row and a quick chip for that host). */
export async function startOnHost(request: APIRequestContext, host: string, cwd: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', {
    data: { message: `history on ${host}`, cwd, host, sessionId: `hp-${host}-${Date.now()}`, ...extra },
  })
  expect(res.status(), `quick-start on ${host}: ${await res.text()}`).toBe(200)
  return (await res.json() as { sessionId: string }).sessionId
}

/** The gate bar of the (restored) draft. */
export const gateBar = (panel: Locator): Locator => panel.locator('[data-testid="host-gate-bar"]')
