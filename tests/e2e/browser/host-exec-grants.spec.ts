/**
 * Settings › Remote Hosts › a host's Details › This host: the tasks from other hosts that may
 * use it (HostThisPart.tsx; server: src/core/hosts/exec-grants.ts). Each task the user let run
 * commands on a host shows under THAT host, with since when and what it ran, and a Revoke that
 * sends the DELETE and drops the row; a task the user declined shows there with an Allow that
 * grants it after all; with none, one line says so. A grant a task on a registered host made by
 * itself says so. Each host has a switch, the hard stop, that sends the PUT.
 * 2026-11-04 review: these sat in one "Tasks using other hosts" group under More settings, each
 * row naming its host, away from the host; they now live in each host's Details (row menu >
 * Details), and This Mac's are in This Mac's Details. Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostRow, openHostDetails } from './host-problems-fixture-helpers'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-exec-grants'
const NOW = Date.now()
/** The fixture server's own saved SSH host (switched off, so nothing dials it). */
const REMOTE = 'fixture-remote'
const REMOTE_NAME = 'Big remote host'

const GRANTS = [
  { id: 'xg-aaaa', taskId: 't-ios', taskTitle: 'Run the iOS tests', host: '__local__', grantedAt: NOW - 3_600_000, via: 'own-host', runs: 4, lastRunAt: NOW - 60_000, lastCommand: 'xcodebuild test -scheme Walnut -destination "platform=iOS Simulator,name=iPhone 17"' },
  { id: 'xg-bbbb', taskId: 't-gpu', taskTitle: 'Train the small model on the box with the GPU and report the loss curve every hour', host: REMOTE, grantedAt: NOW - 86_400_000, via: 'settings', runs: 0 },
]

/**
 * The cloud companion's box, as the fleet reads it: no SSH entry or join link, so its row is a
 * reading only (FleetHostRow.tsx), and its Details still hold its switch.
 */
const CLOUD_CARD = {
  host: '__cloudbox__', label: 'Cloud', local: false, line: '', checkedAt: NOW,
  connection: { kind: 'bridge', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 3_600_000, rttMs: 120, error: null },
  system: null, now: null, history: null, sessions: { running: null }, spend: null,
  server: { enabled: false, program: null, phase: 'off', phaseLabel: 'off', build: null, phone: null, message: null },
  daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - 86_400_000, startup: 'on-demand', startsAfterReboot: true, runtime: 'bun', vitals: false },
  placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: [] } },
  readAt: NOW - 60_000, refreshing: false, readError: null, readFailedAt: null,
}

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
  // Nothing of it under More settings any more: each host's part holds its own.
  await expect(hostRow(page, REMOTE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('host-exec-grants')).toHaveCount(0)
}

/** A host's "This host" part: its Details (closed by default, one open at a time), then the part. */
async function thisHost(page: Page, alias: string): Promise<Locator> {
  await expect(hostRow(page, alias)).toBeVisible({ timeout: 30_000 })
  const details = await openHostDetails(page, alias)
  const part = details.getByTestId(`rh-this-host-${alias}`)
  await expect(part.locator('[data-testid="rh-host-exec"]')).toBeVisible({ timeout: 30_000 })
  return part
}

test('grants read in words under their own host, and Revoke drops one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let grants = [...GRANTS]
  let denied = [{ taskId: 't-ci', taskTitle: 'CI health', host: REMOTE, askedAt: NOW - 7_200_000, answeredAt: NOW - 7_000_000 }]
  const deleted: string[] = []
  const allowed: unknown[] = []
  await page.route('**/api/v1/host-exec/grants', (route) => {
    if (route.request().method() === 'POST') {
      const b = route.request().postDataJSON() as { task_id: string; host: string }
      allowed.push(b)
      denied = denied.filter((d) => d.taskId !== b.task_id)
      const g = { id: 'xg-cccc', taskId: b.task_id, taskTitle: 'CI health', host: b.host, grantedAt: Date.now(), via: 'settings', runs: 0 }
      grants = [...grants, g]
      return route.fulfill({ json: { grant: g } })
    }
    return route.fulfill({ json: { grants, denied } })
  })
  await page.route('**/api/v1/host-exec/grants/*', (route) => {
    const id = decodeURIComponent(route.request().url().split('/').pop()!)
    deleted.push(`${route.request().method()} ${id}`)
    const g = grants.find((x) => x.id === id)
    grants = grants.filter((x) => x.id !== id)
    return route.fulfill({ json: { grant: { ...g, revokedAt: Date.now() } } })
  })
  await openRemoteHosts(page)
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'

  // This Mac's own: the task it let in by itself (it runs on one of your hosts), with what it ran.
  // The line names no host: the part is This Mac's.
  const mac = await thisHost(page, '__local__')
  const macRows = mac.locator('[data-grant-id]')
  await expect(macRows).toHaveCount(1)
  await expect(macRows.nth(0)).toContainText('Run the iOS tests')
  await expect(macRows.nth(0)).toContainText('Allowed (it runs on one of your hosts)')
  await expect(macRows.nth(0)).toContainText('4 uses, last')
  await expect(macRows.nth(0)).toContainText('xcodebuild test -scheme Walnut')
  await expect(macRows.nth(0)).not.toContainText('This Mac')
  await expect(mac.locator('[data-denied]')).toHaveCount(0)
  // A long command never pushes the row past its part.
  expect(await macRows.nth(0).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

  // The remote host's: a grant not used yet, and a task the user declined there.
  const part = await thisHost(page, REMOTE)
  // One host's Details open at a time: This Mac's closed.
  await expect(page.locator('[data-testid="rh-details"][data-host="__local__"]')).toHaveCount(0)
  const rows = part.locator('[data-grant-id]')
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('Train the small model')
  await expect(rows.nth(0)).toContainText('not used yet')
  const declined = part.locator('[data-denied]')
  await expect(declined).toHaveCount(1)
  await expect(declined).toContainText('CI health')
  await expect(declined).toContainText('You declined it')
  // A long title never pushes the row past its part.
  expect(await rows.nth(0).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await part.scrollIntoViewIfNeeded()
  await part.screenshot({ path: `${SHOTS}/${engine}-1-grants.png`, scale: 'css' })

  // Allow on a Deny grants it after all: the row moves up to the grants.
  await declined.getByRole('button', { name: `Allow CI health on ${REMOTE_NAME}` }).click()
  await expect(declined).toHaveCount(0)
  await expect(rows).toHaveCount(2)
  expect(allowed).toEqual([{ task_id: 't-ci', host: REMOTE }])

  await part.getByRole('button', { name: /^Revoke Train the small model/ }).click()
  await expect(rows).toHaveCount(1)
  await part.getByRole('button', { name: `Revoke CI health on ${REMOTE_NAME}` }).click()
  await expect(rows).toHaveCount(0)
  await expect(part).toContainText('No task from another host has used it yet.')
  await part.screenshot({ path: `${SHOTS}/${engine}-2-empty.png`, scale: 'css' })

  // Back on This Mac: its one grant revoked the same way.
  const macAgain = await thisHost(page, '__local__')
  await macAgain.getByRole('button', { name: 'Revoke Run the iOS tests on This Mac' }).click()
  await expect(macAgain.locator('[data-grant-id]')).toHaveCount(0)
  await expect(macAgain).toContainText('No task from another host has used it yet.')
  expect(deleted).toEqual(['DELETE xg-bbbb', 'DELETE xg-cccc', 'DELETE xg-aaaa'])
  expect(errors).toEqual([])
})

test('each host has a hard stop switch that sends the PUT and sticks', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let closed: string[] = []
  const puts: Array<{ host: string; body: unknown }> = []
  await page.route('**/api/v1/host-exec/grants', (route) => route.fulfill({ json: { grants: [], denied: [], closedHosts: closed } }))
  let slowFirst = false
  await page.route('**/api/v1/host-exec/hosts/*', async (route) => {
    const host = decodeURIComponent(route.request().url().split('/').pop()!)
    const body = route.request().postDataJSON() as { closed: boolean }
    puts.push({ host, body })
    closed = body.closed ? [...new Set([...closed, host])].sort() : closed.filter((h) => h !== host)
    const answer = { closedHosts: closed }
    // The first of a quick pair answers last (its answer is the older state).
    if (slowFirst) { slowFirst = false; await new Promise((r) => setTimeout(r, 800)) }
    return route.fulfill({ json: answer })
  })
  // The cloud companion is no Settings entry: the fleet's reading names it, its row is that
  // reading, and its Details get a switch too.
  await page.route((url) => url.pathname === '/api/v1/hosts', async (route) => {
    const r = await route.fetch()
    const body = await r.json() as { hosts?: Array<Record<string, unknown>> }
    body.hosts = [...(body.hosts ?? []).filter((h) => h.host !== '__cloudbox__'), CLOUD_CARD]
    return route.fulfill({ response: r, json: body })
  })
  await openRemoteHosts(page)
  const cloud = await thisHost(page, '__cloudbox__')
  await expect(cloud).toContainText('without asking you')
  await expect(cloud.locator('[data-exec-host="__cloudbox__"]').getByRole('switch', { name: 'Tasks on other hosts may use Cloud' })).toBeVisible()
  await expect(cloud).not.toContainText('__cloudbox__')

  const mac = await thisHost(page, '__local__')
  const row = mac.locator('[data-exec-host="__local__"]')
  const sw = row.getByRole('switch', { name: 'Tasks on other hosts may use This Mac' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(row).toContainText('Off: nothing new starts here from another host.')
  expect(puts).toEqual([{ host: '__local__', body: { closed: true } }])
  await mac.scrollIntoViewIfNeeded()
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await mac.screenshot({ path: `${SHOTS}/${engine}-3-switch-off.png`, scale: 'css' })
  // Settings opened again reads the stop back from the server (Details close with the pane, so
  // This Mac's are opened again).
  await page.getByTestId('settings-nav-general').click()
  await page.getByTestId('settings-nav-remote-hosts').click()
  const again = (await thisHost(page, '__local__')).locator('[data-exec-host="__local__"]').getByRole('switch')
  await expect(again).toHaveAttribute('aria-checked', 'false')
  await again.click()
  await expect.poll(() => puts.length).toBe(2)
  expect(puts[1]).toEqual({ host: '__local__', body: { closed: false } })
  // Two quick flips whose answers come back in the wrong order: the switch ends on the server's word.
  slowFirst = true
  await again.click()
  await again.click()
  await expect.poll(() => puts.length).toBe(4)
  await expect.poll(() => closed.includes('__local__')).toBe(false)
  await expect(again).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(1_500)
  await expect(again).toHaveAttribute('aria-checked', 'true')
  expect(errors).toEqual([])
})
