/**
 * Settings › Remote Hosts › Overview (HostFleetGroup.tsx; server: src/core/hosts/fleet.ts):
 * one card per host, at the density of a real fleet (the primary, two dev hosts, the
 * cloud box, a host whose daemon predates host.vitals, one that went away), each
 * reading in words, 30 day cells, the long-running verdict, a failed refresh that
 * keeps the cards and then recovers, and the real endpoint of the fixture server.
 * Navigation is by clicks. WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-fleet-overview'
const GB = 1024 ** 3
const NOW = Date.now()
const DAY = 86_400_000

function days(upShare: (i: number) => number, covered = 30) {
  return Array.from({ length: 30 }, (_, i) => {
    const minutes = i >= 30 - covered ? 1440 : 0
    const up = Math.round(minutes * upShare(i))
    return { start: NOW - (30 - i) * DAY, minutes, up, linked: up, cpu: 0.3, mem: 0.6, sessionsMax: 4 }
  })
}

function card(over: Record<string, unknown>) {
  return {
    host: 'x', label: 'X', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 20 * 60_000, rttMs: 38, error: null },
    system: { os: 'Ubuntu 24.04', arch: 'x64', cpus: 16, memBytes: 64 * GB, diskFreeBytes: 400 * GB, kind: 'public-cloud-vm', probedAt: null },
    now: { cpus: 16, cpuUtil: 0.12, load: [1.5, 1.2, 1], memTotalBytes: 64 * GB, memAvailBytes: 40 * GB, uptimeSec: 9 * 86400, bootedAt: NOW - 9 * DAY, linked: true, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days(() => 1), windows: [{ days: 7, minutes: 7 * 1440, up: 7 * 1440, linked: 7 * 1440, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    sessions: { running: 3 },
    spend: { last30dUsd: 812.4, from: '2026-10-02', basis: 'list-price' },
    server: null,
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'service', runtime: 'bun', vitals: true },
    placement: { score: 12, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    ...over,
  }
}

const FLEET = [
  card({
    host: '__local__', label: 'This computer', local: true,
    connection: { kind: 'local', connected: true, phase: 'connected', phaseLabel: 'Running on this Mac', since: null, rttMs: 1, error: null },
    system: { os: 'macOS 15.1', arch: 'arm64', cpus: 10, memBytes: 32 * GB, diskFreeBytes: 50 * GB, kind: 'laptop', probedAt: null },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days((i) => (i % 3 === 0 ? 0.7 : 0.95)), windows: [{ days: 7, minutes: 7 * 1440, up: 9374, linked: 9374, online: 0.93, linkedShare: 0.93, drops: 0, downs: 6 }], outages: [], boots: [], daemonStarts: 4 },
    sessions: { running: 12 }, spend: { last30dUsd: 2345.6, from: '2026-10-02', basis: 'list-price' },
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', runtime: 'binary', vitals: true },
    placement: { score: 3, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: ['It is a laptop: a job here stops while it sleeps.'] } },
  }),
  card({
    host: 'devbox', label: 'Big dev box',
    system: { os: 'Debian 12', arch: 'x64', cpus: 32, memBytes: 128 * GB, diskFreeBytes: 2300 * GB, kind: 'private-cloud-vm', probedAt: null },
    now: { cpus: 32, cpuUtil: 0.25, load: [6.16, 8.1, 14.7], memTotalBytes: 128 * GB, memAvailBytes: 96 * GB, uptimeSec: 13 * 86400, bootedAt: NOW - 13 * DAY, linked: true, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days((i) => (i === 27 ? 0.85 : 0.999)), windows: [{ days: 7, minutes: 7 * 1440, up: 10000, linked: 9500, online: 0.992, linkedShare: 0.94, drops: 41, downs: 1, daemonStarts: 15, boots: 0 }], outages: [], boots: [], daemonStarts: 15 },
    sessions: { running: 19 }, spend: { last30dUsd: 1234.2, from: '2026-10-02', basis: 'list-price' },
    server: { enabled: true, program: 'replica', phase: 'running', build: '0.6.20-abc1234', phone: 'connected', message: null },
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', runtime: 'bun', vitals: true },
    placement: { score: 32, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: ['Its daemon does not start by itself after a reboot (run `walnut daemon service install` on it).'] } },
  }),
  card({
    host: 'olddev', label: 'Spare box with a rather long label that must not break the card',
    now: null, history: null, system: null, sessions: { running: null },
    server: { enabled: false, program: null, phase: 'off', build: null, phone: null, message: null },
    daemon: { version: 'walnut-daemon-0aa1bb2cc3dd', startedAt: NOW - DAY, startup: 'on-demand', runtime: 'bun', vitals: false },
    spend: { last30dUsd: 0, from: '2026-10-02', basis: 'list-price' },
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['No Walnut server runs on it (Settings, Remote Hosts, host servers).', 'Its daemon does not start by itself after a reboot (run `walnut daemon service install` on it).'] } },
  }),
  card({
    host: '__cloudbox__', label: 'Cloud',
    connection: { kind: 'bridge', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 2 * 3600_000, rttMs: 120, error: null },
    system: { os: 'Alpine 3.20', arch: 'arm64', cpus: 2, memBytes: 8 * GB, diskFreeBytes: 20 * GB, kind: 'public-cloud-vm', probedAt: null },
    history: { coverageFrom: NOW - 2 * DAY, bucketMinutes: 1440, buckets: days(() => 1, 2), windows: [{ days: 7, minutes: 2 * 1440, up: 2 * 1440, linked: 2 * 1440, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
  }),
  card({
    host: 'homepc', label: 'Home PC',
    connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not reach Home PC', since: null, rttMs: null, error: 'ssh: connection timed out' },
    now: { cpus: 8, cpuUtil: 0.05, load: [0.2, 0.2, 0.2], memTotalBytes: 32 * GB, memAvailBytes: 20 * GB, uptimeSec: 3600, bootedAt: NOW - 3600_000, linked: false, at: NOW - 7 * 60_000, stale: true },
    sessions: { running: null }, server: { enabled: false, program: null, phase: 'off', build: null, phone: null, message: null },
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['Walnut is not connected to it now.'] } },
  }),
]

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('a fleet of five reads in words, with day cells and the long-running verdict', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let calls = 0
  await page.route('**/api/v1/hosts', (route) => { calls++; return route.fulfill({ json: { hosts: FLEET, checkedAt: NOW } }) })
  await openRemoteHosts(page)
  const group = page.getByTestId('host-fleet')
  const cards = group.getByTestId('host-fleet-card')
  await expect(cards).toHaveCount(5, { timeout: 30_000 })
  await expect(cards.nth(0)).toHaveAttribute('data-host', '__local__')
  const dev = group.locator('[data-host="devbox"]')
  await expect(dev.locator('[data-row="system"] dd')).toHaveText('Debian 12 · x64 · 32 CPUs · 128 GB · 2300 GB disk free')
  await expect(dev.locator('[data-row="now"] dd')).toHaveText('CPU 25% · load 6.16 · 96 GB of 128 GB memory free · up 13 d')
  await expect(dev.locator('[data-row="online"] dd')).toHaveText('99.2% of the last 7 days · 1 down · 41 link drops · daemon started 15 times')
  await expect(dev.locator('[data-row="sessions"] dd')).toHaveText('19 open')
  await expect(dev.locator('[data-row="spend"] dd')).toHaveText('$1,234 at list price (not a bill)')
  await expect(dev.locator('[data-row="server"] dd')).toHaveText('Replica · running · 0.6.20-abc1234 · phone tunnel connected')
  await expect(dev.locator('[data-row="daemon"] dd')).toHaveText('build 0123456789ab · bun · does not start by itself after a reboot')
  await expect(dev.getByTestId('host-fleet-days').locator('i')).toHaveCount(30)
  await expect(dev.getByTestId('host-fleet-days').locator('i[data-tone="bad"]')).toHaveCount(1)
  await expect(dev.getByTestId('host-fleet-fit')).toHaveText(/^Not for a job that must keep running: Its daemon does not start by itself/)
  await expect(dev.getByTestId('host-fleet-fit').locator('code')).toHaveText('walnut daemon service install')
  const old = group.locator('[data-host="olddev"]')
  await expect(old.locator('[data-row="now"] dd')).toHaveText('Its daemon is older than this view (it upgrades on the next connect)')
  await expect(old.getByTestId('host-fleet-days')).toHaveCount(0)
  const home = group.locator('[data-host="homepc"]')
  await expect(home.locator('[data-row="now"] dd')).toHaveText(/\(last reading, 7 min ago\)$/)
  await expect(home.locator('[data-row="connection"] dd')).toHaveText('SSH tunnel · Could not reach Home PC (ssh: connection timed out)')
  await expect(group.locator('[data-host="__cloudbox__"] [data-row="online"] dd')).toHaveText('100% of the 2 days recorded')
  await expect(group.locator('[data-host="__cloudbox__"]').getByTestId('host-fleet-fit')).toHaveText('Fits a job that must keep running.')
  // No card overflows its column at this density.
  for (let i = 0; i < 5; i++) {
    const box = await cards.nth(i).boundingBox()
    const scroll = await cards.nth(i).evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(box && box.width > 200).toBe(true)
    expect(scroll).toBeLessThanOrEqual(1)
  }
  await group.scrollIntoViewIfNeeded()
  await shot(page, '1-fleet', group)
  expect(calls).toBeGreaterThanOrEqual(1)
  expect(errors).toEqual([])
})

test('a failed refresh keeps the cards and says so; the next one recovers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.install()
  let fail = false
  await page.route('**/api/v1/hosts', (route) => fail
    ? route.fulfill({ status: 500, json: { error: 'host table locked' } })
    : route.fulfill({ json: { hosts: FLEET.slice(0, 2), checkedAt: NOW } }))
  await openRemoteHosts(page)
  const group = page.getByTestId('host-fleet')
  await expect(group.getByTestId('host-fleet-card')).toHaveCount(2, { timeout: 30_000 })
  fail = true
  await page.clock.runFor(31_000)
  await expect(group.getByRole('status')).toHaveText('Could not refresh the overview: host table locked. Showing the last cards.')
  await expect(group.getByRole('status')).toContainText('Showing the last cards.')
  await expect(group.getByTestId('host-fleet-card')).toHaveCount(2)
  await shot(page, '2-refresh-failed', group)
  fail = false
  await page.clock.runFor(31_000)
  await expect(group.getByRole('status')).toHaveCount(0)
  await expect(group.getByTestId('host-fleet-card')).toHaveCount(2)
})

test('the fixture server answers its own fleet: this computer first', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openRemoteHosts(page)
  const first = page.getByTestId('host-fleet').getByTestId('host-fleet-card').first()
  await expect(first).toHaveAttribute('data-host', '__local__', { timeout: 30_000 })
  await expect(first.locator('.hf-card-name')).toHaveText('This computer')
  await expect(first.locator('[data-row="spend"]')).toBeVisible()
  await shot(page, '3-fixture-server', page.getByTestId('host-fleet'))
})
