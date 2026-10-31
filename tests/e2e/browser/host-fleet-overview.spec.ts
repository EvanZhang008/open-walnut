/**
 * Settings › Remote Hosts › Overview (HostFleetGroup.tsx; server: src/core/hosts/fleet.ts):
 * the fleet dashboard at the density of a real fleet (five hosts: this computer, a dev
 * box, the cloud box, and two Walnut is not connected to): the summary strip, the
 * diagram (dashed lines to hosts not connected), one card per live host (rings, disk,
 * 12 hour timeline, numbers, chips, one problem line), the Set up and Connect buttons
 * (pending, done, refused), the key/value table behind Details, no overflow at 1280
 * and 900 px, a failed refresh that keeps the cards, and the fixture server's own fleet.
 * Navigation is by clicks. WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-fleet-overview'
const GB = 1024 ** 3
const NOW = Date.now()
const DAY = 86_400_000
const HOUR = 3_600_000

function days(upShare: (i: number) => number, covered = 30) {
  return Array.from({ length: 30 }, (_, i) => {
    const minutes = i >= 30 - covered ? 1440 : 0
    const up = Math.round(minutes * upShare(i))
    return { start: NOW - (30 - i) * DAY, minutes, up, linked: up, cpu: 0.3, mem: 0.6, sessionsMax: 4 }
  })
}

/** The last 12 hours in 15 minute steps (host.vitals `recent`): a wave a host could show; `down` steps read null. */
function recent(opts: { cpu: number; mem: number; gpu?: number; disk: number; sessions: number; down?: number[] }) {
  const isDown = (i: number) => (opts.down ?? []).includes(i)
  const wave = (base: number, amp: number, i: number) => Math.round(Math.min(0.99, Math.max(0.01, base + amp * Math.sin(i / 4) + (i % 7) * 0.01)) * 100) / 100
  const steps = Array.from({ length: 48 }, (_, i) => i)
  return {
    from: NOW - 12 * HOUR, stepMinutes: 15,
    up: steps.map((i) => (isDown(i) ? 0 : 15)),
    cpu: steps.map((i) => (isDown(i) ? null : wave(opts.cpu, 0.12, i))),
    mem: steps.map((i) => (isDown(i) ? null : wave(opts.mem, 0.05, i))),
    gpu: opts.gpu === undefined ? null : steps.map((i) => (isDown(i) ? null : wave(opts.gpu!, 0.15, i))),
    disk: steps.map((i) => (isDown(i) ? null : opts.disk)),
    sessions: steps.map((i) => (isDown(i) ? 0 : Math.max(0, Math.round(opts.sessions + 3 * Math.sin(i / 6))))),
  }
}

function card(over: Record<string, unknown>) {
  return {
    host: 'x', label: 'X', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 20 * 60_000, rttMs: 38, error: null },
    system: { os: 'Ubuntu 24.04', arch: 'x64', cpus: 16, memBytes: 64 * GB, diskFreeBytes: 400 * GB, kind: 'public-cloud-vm', probedAt: null },
    now: { cpus: 16, cpuUtil: 0.12, load: [1.5, 1.2, 1], memTotalBytes: 64 * GB, memAvailBytes: 40 * GB, uptimeSec: 9 * 86400, bootedAt: NOW - 9 * DAY, linked: true, gpuUtil: null, disk: { totalBytes: 30 * GB, freeBytes: 20 * GB }, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days(() => 1), windows: [{ days: 7, minutes: 7 * 1440, up: 7 * 1440, linked: 7 * 1440, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    sessions: { running: 3 },
    spend: { last30dUsd: 812.4, from: '2026-10-02', basis: 'list-price' },
    server: null,
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true },
    placement: { score: 12, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    ...over,
  }
}

const FLEET = [
  card({
    host: '__local__', label: 'This computer', local: true,
    connection: { kind: 'local', connected: true, phase: 'connected', phaseLabel: 'Running on this Mac', since: null, rttMs: 1, error: null },
    system: { os: 'macOS 15.1', arch: 'arm64', cpus: 10, memBytes: 32 * GB, diskFreeBytes: 50 * GB, kind: 'laptop', probedAt: null },
    now: { cpus: 10, cpuUtil: 0.12, load: [3.1, 2.8, 2.5], memTotalBytes: 32 * GB, memAvailBytes: 20 * GB, uptimeSec: 2 * 86400, bootedAt: NOW - 2 * DAY, linked: true, gpuUtil: 0.18, disk: { totalBytes: 994 * GB, freeBytes: 50 * GB }, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days((i) => (i % 3 === 0 ? 0.7 : 0.95)), windows: [{ days: 7, minutes: 7 * 1440, up: 9374, linked: 9374, online: 0.93, linkedShare: 0.93, drops: 0, downs: 6 }], outages: [], boots: [], daemonStarts: 4, recent: recent({ cpu: 0.3, mem: 0.55, gpu: 0.2, disk: 0.95, sessions: 10 }) },
    sessions: { running: 12 }, spend: { last30dUsd: 2345.6, from: '2026-10-02', basis: 'list-price' },
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'binary', vitals: true },
    placement: { score: 3, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: ['It is a laptop: a job here stops while it sleeps.'] } },
    capabilities: {
      tags: ['macos', 'local', 'ios', 'browser', 'mcp:playwright'], alwaysOn: false, placement: 'local', os: 'macos',
      ios: { xcode: 'Xcode 26.1', runtimes: ['iOS 26.1', 'iOS 18.6'] }, browsers: [{ name: 'chrome', relay: true }, { name: 'brave', relay: false }],
      mcp: [{ name: 'playwright' }], clis: ['git', 'node', 'xcodegen'], declared: [], unknown: [],
    },
  }),
  card({
    host: 'devbox', label: 'Big dev box',
    system: { os: 'Debian 12', arch: 'x64', cpus: 32, memBytes: 128 * GB, diskFreeBytes: 2300 * GB, kind: 'private-cloud-vm', probedAt: null },
    now: { cpus: 32, cpuUtil: 0.25, load: [6.16, 8.1, 14.7], memTotalBytes: 128 * GB, memAvailBytes: 96 * GB, uptimeSec: 13 * 86400, bootedAt: NOW - 13 * DAY, linked: true, gpuUtil: null, disk: { totalBytes: 4096 * GB, freeBytes: 2300 * GB }, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days((i) => (i === 27 ? 0.85 : 0.999)), windows: [{ days: 7, minutes: 7 * 1440, up: 10000, linked: 9500, online: 0.992, linkedShare: 0.94, drops: 41, downs: 1, daemonStarts: 15, boots: 0 }], outages: [
      { from: NOW - 3 * HOUR, to: NOW - 3 * HOUR + 20 * 60_000, minutes: 20, kind: 'unlinked' },
      { from: NOW - 9 * HOUR, to: NOW - 9 * HOUR + 40 * 60_000, minutes: 40, kind: 'down' },
    ], boots: [], daemonStarts: 15, recent: recent({ cpu: 0.35, mem: 0.3, disk: 0.44, sessions: 17, down: [12, 13, 14] }) },
    sessions: { running: 19 }, spend: { last30dUsd: 1234.2, from: '2026-10-02', basis: 'list-price' },
    server: { enabled: true, program: 'replica', phase: 'running', phaseLabel: 'running', build: '0.6.20-abc1234', phone: 'connected', message: null },
    daemon: {
      version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true,
      bootStart: { mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', checkedAt: NOW, setupRunning: false, setupError: null, next: 'install' },
      reboot: 'does not start by itself after a reboot: nothing on it starts the daemon at boot',
    },
    placement: { score: 32, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: ['Its daemon does not start by itself after a reboot (run `walnut daemon install --yes` on it, then `sudo loginctl enable-linger $USER` there so it starts at boot, not only at login).'] } },
    capabilities: {
      tags: ['always-on', 'cloud', 'linux', 'docker', 'mcp:docs-mcp', 'mcp:tickets-mcp', 'mcp:mail-mcp', 'gpu'], alwaysOn: true, placement: 'cloud', os: 'linux',
      ios: null, browsers: [], mcp: [{ name: 'docs-mcp', plugin: 'Tools' }, { name: 'tickets-mcp', plugin: 'Tools' }, { name: 'mail-mcp' }],
      clis: ['docker', 'gh', 'git', 'go', 'node'], declared: ['gpu'], unknown: [],
    },
  }),
  card({
    host: 'olddev', label: 'Spare box with a rather long label that must not break the card',
    connection: { kind: 'ssh-tunnel', connected: false, phase: 'off', phaseLabel: 'Not connected', since: null, rttMs: null, error: null },
    now: null, history: null, system: null, sessions: { running: null },
    server: { enabled: false, program: null, phase: 'off', phaseLabel: 'off', build: null, phone: null, message: null },
    daemon: { version: 'walnut-daemon-0aa1bb2cc3dd', startedAt: NOW - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: false },
    spend: { last30dUsd: 0, from: '2026-10-02', basis: 'list-price' },
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['No Walnut server runs on it (Settings, Remote Hosts, host servers).', 'Its daemon does not start by itself after a reboot (run `walnut daemon install --yes` on it, then `sudo loginctl enable-linger $USER` there so it starts at boot, not only at login).'] } },
  }),
  card({
    host: '__cloudbox__', label: 'Cloud',
    connection: { kind: 'bridge', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 2 * 3600_000, rttMs: 120, error: null },
    system: { os: 'Alpine 3.20', arch: 'arm64', cpus: 2, memBytes: 8 * GB, diskFreeBytes: 20 * GB, kind: 'public-cloud-vm', probedAt: null },
    // As prod reports it: on-demand, yet it comes back with the companion's systemd unit.
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', startsAfterReboot: true, runtime: 'bun', vitals: true },
    history: { coverageFrom: NOW - 2 * DAY, bucketMinutes: 1440, buckets: days(() => 1, 2), windows: [{ days: 7, minutes: 2 * 1440, up: 2 * 1440, linked: 2 * 1440, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1, recent: recent({ cpu: 0.1, mem: 0.4, disk: 0.33, sessions: 3 }) },
  }),
  card({
    host: 'homepc', label: 'Home PC',
    connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not reach Home PC', since: null, rttMs: null, error: 'ssh: connection timed out' },
    now: { cpus: 8, cpuUtil: 0.05, load: [0.2, 0.2, 0.2], memTotalBytes: 32 * GB, memAvailBytes: 20 * GB, uptimeSec: 3600, bootedAt: NOW - 3600_000, linked: false, at: NOW - 7 * 60_000, stale: true },
    sessions: { running: null }, server: { enabled: false, program: null, phase: 'off', phaseLabel: 'off', build: null, phone: null, message: null },
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['Walnut is not connected to it now.'] } },
    capabilities: { tags: ['linux'], alwaysOn: null, placement: null, os: 'linux', ios: null, browsers: [], mcp: [], clis: ['git'], declared: [], unknown: ['always-on', 'browser', 'mcp'] },
  }),
]

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
}

/** A tall window for the picture, so the whole region shows below the pinned bar. */
async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: 2400 })
  await region.evaluate((el) => el.closest('.settings-section')?.scrollIntoView({ block: 'start' }))
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
  await page.setViewportSize(size)
}

/** Nothing in the dashboard is wider than its box. */
async function expectNoOverflow(page: Page) {
  const over = await page.getByTestId('host-fleet').evaluate((root) => {
    const bad: string[] = []
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('.hf-card, .hf-off, .hf-stat, .hf-panel')]) {
      if (el.scrollWidth - el.clientWidth > 1) bad.push(`${el.className} ${el.getAttribute('data-host') ?? ''}`)
    }
    const r = root.getBoundingClientRect()
    for (const el of root.querySelectorAll<HTMLElement>('.hf-card, .hf-off, .hf-stat')) {
      const b = el.getBoundingClientRect()
      if (b.right > r.right + 1 || b.left < r.left - 1) bad.push(`outside: ${el.className}`)
    }
    return bad
  })
  expect(over).toEqual([])
}

function serveFleet(page: Page, hosts: () => unknown[]) {
  let calls = 0
  void page.route('**/api/v1/hosts', (route) => { calls++; return route.fulfill({ json: { hosts: hosts(), checkedAt: NOW } }) })
  return () => calls
}

test('a fleet of five: summary, diagram, cards for the three live hosts, a row each for the two away', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const calls = serveFleet(page, () => FLEET)
  await openRemoteHosts(page)
  const dash = page.getByTestId('host-fleet')
  await expect(dash.getByTestId('host-fleet-card')).toHaveCount(3, { timeout: 30_000 })
  await expect(dash.getByTestId('host-fleet-card').nth(0)).toHaveAttribute('data-host', '__local__')
  // The dashboard is beside the groups, never inside one (settings-layout.spec.ts F10).
  expect(await dash.evaluate((el) => !!el.closest('.settings-group'))).toBe(false)

  // Summary strip.
  await expect(dash.getByTestId('host-fleet-stat-online')).toContainText('3/5')
  await expect(dash.getByTestId('host-fleet-stat-sessions')).toContainText('34')
  await expect(dash.getByTestId('host-fleet-stat-spend')).toContainText('$5,205')
  await expect(dash.getByTestId('host-fleet-stat-problems')).toContainText('4')

  // Diagram: five nodes, four lines; the two hosts away are dashed and grey.
  const topo = dash.getByTestId('host-fleet-topology')
  await expect(topo.getByTestId('host-fleet-topo-node')).toHaveCount(5)
  await expect(topo.getByTestId('host-fleet-topo-link')).toHaveCount(4)
  await expect(topo.locator('[data-testid="host-fleet-topo-link"][data-live="false"]')).toHaveCount(2)
  expect(await topo.locator('path.hf-topo-link[data-live="false"]').first().evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none')
  await expect(topo.locator('path.hf-topo-link')).toHaveCount(4)
  await expect(topo.locator('[data-testid="host-fleet-topo-link"][data-host="devbox"]')).toHaveText('SSH tunnel · 38 ms')
  await expect(topo.locator('[data-testid="host-fleet-topo-link"][data-host="__cloudbox__"]')).toHaveText('Bridge · 120 ms')
  await expect(topo.locator('[data-testid="host-fleet-topo-link"][data-host="homepc"]')).toHaveText('Not connected')
  // No two pieces of text in the diagram overlap.
  const clash = await topo.evaluate((svg) => {
    const boxes = [...svg.querySelectorAll('text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }))
    const hits: string[] = []
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(`${boxes[i].t} / ${boxes[j].t}`)
    }
    return hits
  })
  expect(clash).toEqual([])
  await expect(topo.locator('[data-host="__cloudbox__"] [data-mark="cloud"]')).toHaveCount(1)
  await expect(topo.locator('[data-host="devbox"] [data-mark="phone"]')).toHaveCount(1)
  // The diagram shows labels, never an alias.
  await expect(topo).not.toContainText('__cloudbox__')

  // The dev box card.
  const dev = dash.locator('[data-testid="host-fleet-card"][data-host="devbox"]')
  await expect(dev.locator('.hf-card-name')).toHaveText('Big dev box')
  await expect(dev.getByTestId('host-fleet-roles')).toHaveText('Always onReplica')
  await expect(dev.getByTestId('host-fleet-system')).toHaveText('Debian 12 · x64 · 32 CPUs · 128 GB')
  await expect(dev.locator('[data-gauge="cpu"] .hf-gauge-value')).toHaveText('25%')
  await expect(dev.locator('[data-gauge="mem"] .hf-gauge-value')).toHaveText('25%')
  // Disk is a ring like the others: the share in use, with what is free under it.
  await expect(dev.locator('[data-gauge="disk"] .hf-gauge-value')).toHaveText('44%')
  await expect(dev.getByTestId('host-fleet-disk-free')).toHaveText('2.2 TB free')
  await expect(dev.getByTestId('host-fleet-disk-free')).toHaveAttribute('data-low', 'false')
  await expect(dev.getByTestId('host-fleet-gauge')).toHaveCount(3) // no GPU on it
  // The last 12 hours: a small chart each, broken where it was down.
  await expect(dev.getByTestId('host-fleet-spark')).toHaveCount(3)
  await expect(dev.locator('[data-spark="sessions"] .hf-lane-value')).toHaveText(/^max \d+$/)
  expect((await dev.locator('[data-spark="cpu"] .hf-spark-line').getAttribute('d'))!.split('M').filter(Boolean)).toHaveLength(2)
  const tl = dev.getByTestId('host-fleet-timeline')
  await expect(tl.locator('i[data-tone="bad"]')).toHaveCount(1)
  await expect(tl.locator('i[data-tone="warn"]')).toHaveCount(1)
  await expect(tl.locator('i[data-tone="bad"]')).toHaveAttribute('title', /: down \(40 min\)$/)
  await expect(dev.getByTestId('host-fleet-sessions')).toContainText('19')
  await expect(dev.getByTestId('host-fleet-spend')).toContainText('$1,234')
  await expect(dev.getByTestId('host-fleet-caps').locator('.hf-chip')).toHaveText(['Docker', 'MCP × 3', 'gpu'])
  const problem = dev.getByTestId('host-fleet-problem')
  await expect(problem).toHaveAttribute('data-problem', 'reboot')
  await expect(problem.locator('.hf-problem-text')).toHaveText('Daemon does not come back after a reboot')
  await expect(problem).toHaveAttribute('title', 'does not start by itself after a reboot: nothing on it starts the daemon at boot')
  await expect(problem.getByTestId('host-fleet-fix')).toHaveText('Set up')

  // The Mac: Primary, iOS and the browser, its uptime and its laptop verdict on one line.
  const mac = dash.locator('[data-testid="host-fleet-card"][data-host="__local__"]')
  await expect(mac.getByTestId('host-fleet-roles')).toHaveText('Primary')
  await expect(mac.locator('[data-gauge]')).toHaveCount(4)
  await expect(mac.locator('[data-gauge="gpu"] .hf-gauge-value')).toHaveText('18%')
  await expect(mac.locator('[data-gauge="disk"] .hf-gauge-value')).toHaveText('95%')
  await expect(mac.getByTestId('host-fleet-disk-free')).toHaveText('50 GB free')
  await expect(mac.locator('[data-spark]')).toHaveCount(4)
  await expect(mac.locator('[data-spark="gpu"]')).toHaveAttribute('title', /^GPU over the last 12 hours/)
  await expect(mac.getByTestId('host-fleet-caps').locator('.hf-chip')).toHaveText(['iOS simulator', 'Browser', 'MCP × 1'])
  await expect(mac.getByTestId('host-fleet-problem').locator('.hf-problem-text')).toHaveText('Up 93% of the last 7 days (+1)')
  await expect(mac.getByTestId('host-fleet-fix')).toHaveCount(0)
  // The cloud box is fine: no problem line.
  await expect(dash.locator('[data-testid="host-fleet-card"][data-host="__cloudbox__"]').getByTestId('host-fleet-problem')).toHaveCount(0)
  await expect(dash.locator('[data-testid="host-fleet-card"][data-host="__cloudbox__"]').getByTestId('host-fleet-roles')).toHaveText('Cloud')

  // The two hosts away: one row each, Connect, the error in the title.
  const away = dash.getByTestId('host-fleet-offline')
  await expect(away).toHaveCount(2)
  const home = dash.locator('[data-testid="host-fleet-offline"][data-host="homepc"]')
  await expect(home.locator('.hf-off-why')).toHaveText('Could not reach Home PC')
  await expect(home.locator('.hf-off-why')).toHaveAttribute('title', 'ssh: connection timed out')
  await expect(home.getByTestId('host-fleet-connect')).toHaveText('Connect')
  const card = await home.boundingBox()
  expect(card && card.height < 50).toBe(true)

  // Details: the whole key/value table, the 30 day cells, the long-running verdict.
  await expect(dev.getByTestId('host-fleet-details')).toHaveCount(0)
  await dev.getByTestId('host-fleet-details-toggle').click()
  await expect(dev.getByTestId('host-fleet-details-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(dev.locator('[data-row="now"] dd')).toHaveText('CPU 25% · load 6.16 · 96 GB of 128 GB memory free · up 13 d')
  await expect(dev.locator('[data-row="server"] dd')).toHaveText('Replica · running · 0.6.20-abc1234 · phone tunnel connected')
  await expect(dev.getByTestId('host-fleet-days').locator('i')).toHaveCount(30)
  await expect(dev.getByTestId('host-fleet-fit').locator('code')).toHaveText(['walnut daemon install --yes', 'sudo loginctl enable-linger $USER'])
  await home.getByTestId('host-fleet-details-toggle').click()
  await expect(home.locator('[data-row="connection"] dd')).toHaveText('SSH tunnel · Could not reach Home PC (ssh: connection timed out)')
  const old = dash.locator('[data-testid="host-fleet-offline"][data-host="olddev"]')
  await old.getByTestId('host-fleet-details-toggle').click()
  await expect(old.locator('[data-row="now"] dd')).toHaveText('Its daemon is older than this view (it upgrades on the next connect)')
  await expectNoOverflow(page)
  await dev.getByTestId('host-fleet-details-toggle').click()
  await home.getByTestId('host-fleet-details-toggle').click()
  await old.getByTestId('host-fleet-details-toggle').click()
  await expect(dash.getByTestId('host-fleet-details')).toHaveCount(0)

  // A node in the diagram takes you to its card.
  await topo.locator('[data-testid="host-fleet-topo-node"][data-host="devbox"]').click()
  await expect(dev).toBeFocused()

  await dash.scrollIntoViewIfNeeded()
  await expectNoOverflow(page)
  await shot(page, '1-fleet-1280', dash)
  expect(calls()).toBeGreaterThanOrEqual(1)
  expect(errors).toEqual([])
})

test('at 900 px the dashboard still fits: cards wrap, nothing spills', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  serveFleet(page, () => FLEET)
  await openRemoteHosts(page)
  const dash = page.getByTestId('host-fleet')
  await expect(dash.getByTestId('host-fleet-card')).toHaveCount(3, { timeout: 30_000 })
  await expectNoOverflow(page)
  const label = await dash.locator('[data-testid="host-fleet-topo-link"][data-host="devbox"]').boundingBox()
  expect(label && label.height >= 7).toBe(true) // the diagram scales down, still readable
  await shot(page, '2-fleet-900', dash)
})

test('dark: every surface keeps its text readable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark' })
  serveFleet(page, () => FLEET)
  await openRemoteHosts(page)
  const dash = page.getByTestId('host-fleet')
  await expect(dash.getByTestId('host-fleet-card')).toHaveCount(3, { timeout: 30_000 })
  // Text and its own surface differ: no dark text left on a dark card.
  const same = await dash.evaluate((root) => {
    const bad: string[] = []
    for (const el of root.querySelectorAll<HTMLElement>('.hf-card-name, .hf-big, .hf-stat-value, .hf-problem-text, .hf-chip')) {
      const fg = getComputedStyle(el).color
      if (fg === 'rgb(0, 0, 0)' || fg === 'rgb(29, 29, 31)') bad.push(el.className)
    }
    return bad
  })
  expect(same).toEqual([])
  await shot(page, '8-fleet-dark', dash)
})

test('Set up: the button waits, then the card reads as fixed; a refusal or a check that changed nothing says so', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  serveFleet(page, () => FLEET)
  let release: () => void = () => {}
  let answer: 'refuse' | 'unchanged' | 'ok' = 'refuse'
  const base = FLEET[1] as Record<string, unknown> & { daemon: Record<string, unknown> }
  const fixed = { ...base, daemon: { ...base.daemon, startsAfterReboot: true, bootStart: { mode: 'boot', backend: 'systemd-user', reason: null, checkedAt: NOW, setupRunning: false, setupError: null, next: null }, reboot: 'starts by itself after a reboot (as a systemd user service)' } }
  const unchanged = { ...base, daemon: { ...base.daemon, bootStart: { mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: 'this account cannot start the daemon at boot without root', next: 'recheck' }, reboot: 'does not start by itself after a reboot: this account cannot start the daemon at boot without root' } }
  await page.route('**/api/v1/hosts/devbox/boot-start', async (route) => {
    await new Promise<void>((r) => { release = r })
    if (answer === 'refuse') return route.fulfill({ status: 502, json: { error: 'Walnut could not check Big dev box: ssh: connection reset', code: 'check_failed' } })
    return route.fulfill({ json: { host: answer === 'ok' ? fixed : unchanged } })
  })
  await openRemoteHosts(page)
  const dev = page.locator('[data-testid="host-fleet-card"][data-host="devbox"]')
  const fix = dev.getByTestId('host-fleet-fix')
  await expect(fix).toHaveText('Set up', { timeout: 30_000 })
  await fix.click()
  await expect(fix).toBeDisabled()
  await expect(fix).toHaveText('Setting up...')
  // The card's own Set up never shows as busy on another host's row.
  await expect(page.getByTestId('host-fleet-connect').first()).toHaveText('Connect')
  release()
  await expect(dev.getByTestId('host-fleet-action-error')).toHaveText('Could not set it up: Walnut could not check Big dev box: ssh: connection reset.')
  await expect(fix).toBeEnabled()
  await shot(page, '3-setup-refused', dev)
  answer = 'unchanged'
  await fix.click()
  release()
  await expect(dev.getByTestId('host-fleet-action-note')).toHaveText('Checked just now: does not start by itself after a reboot: this account cannot start the daemon at boot without root.')
  await expect(dev.getByTestId('host-fleet-action-error')).toHaveCount(0)
  await expect(fix).toHaveText('Check again')
  answer = 'ok'
  await fix.click()
  await expect(fix).toHaveText('Setting up...')
  release()
  await expect(dev.getByTestId('host-fleet-problem')).toHaveCount(0)
  await expect(dev.getByTestId('host-fleet-action-note')).toHaveCount(0)
  await shot(page, '4-setup-done', dev)
})

test('Connect: the row waits, then the host comes back as a card; a refusal stays on its row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let homeUp = false
  serveFleet(page, () => FLEET.map((h) => (homeUp && (h as { host: string }).host === 'homepc'
    ? { ...h, connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW, rttMs: 51, error: null }, now: { ...(h as { now: Record<string, unknown> }).now, stale: false, at: NOW } }
    : h)))
  let release: () => void = () => {}
  let refuse = true
  await page.route('**/api/hosts/homepc/connect', async (route) => {
    await new Promise<void>((r) => { release = r })
    if (refuse) return route.fulfill({ status: 409, json: { error: 'Home PC refused the sign-in' } })
    homeUp = true
    return route.fulfill({ json: { ok: true, status: { host: 'homepc', phase: 'connected' } } })
  })
  await openRemoteHosts(page)
  const dash = page.getByTestId('host-fleet')
  const row = dash.locator('[data-testid="host-fleet-offline"][data-host="homepc"]')
  const connect = row.getByTestId('host-fleet-connect')
  await expect(connect).toBeVisible({ timeout: 30_000 })
  await connect.click()
  await expect(connect).toHaveText('Connecting...')
  release()
  await expect(row.getByTestId('host-fleet-action-error')).toHaveText(/^Could not connect: .*refused the sign-in\.$/)
  await expect(connect).toBeEnabled()
  refuse = false
  await connect.click()
  release()
  await expect(dash.locator('[data-testid="host-fleet-card"][data-host="homepc"]')).toBeVisible()
  await expect(dash.getByTestId('host-fleet-offline')).toHaveCount(1)
  await expect(dash.getByTestId('host-fleet-stat-online')).toContainText('4/5')
  await expect(dash.locator('[data-testid="host-fleet-topo-link"][data-host="homepc"]')).toHaveAttribute('data-live', 'true')
  await shot(page, '5-connected', dash)
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
  await expect(group.locator('.hf-error')).toHaveText('Could not refresh the overview: host table locked. Showing the last cards.')
  await expect(group.getByTestId('host-fleet-card')).toHaveCount(2)
  await shot(page, '6-refresh-failed', group)
  fail = false
  await page.clock.runFor(31_000)
  await expect(group.locator('.hf-error')).toHaveCount(0)
  await expect(group.getByTestId('host-fleet-card')).toHaveCount(2)
})

test('the fixture server answers its own fleet: this computer first', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openRemoteHosts(page)
  const first = page.getByTestId('host-fleet').getByTestId('host-fleet-card').first()
  await expect(first).toHaveAttribute('data-host', '__local__', { timeout: 30_000 })
  await expect(first.locator('.hf-card-name')).toHaveText('This computer')
  await expect(first.getByTestId('host-fleet-spend')).toBeVisible()
  await expect(first.getByTestId('host-fleet-timeline')).toBeVisible()
  await first.getByTestId('host-fleet-details-toggle').click()
  await expect(first.locator('[data-row="can"]')).toBeVisible() // the real server sends capabilities
  await shot(page, '7-fixture-server', page.getByTestId('host-fleet'))
})
