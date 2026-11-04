/**
 * Settings > Remote Hosts at the density of a real fleet (server: src/core/hosts/fleet.ts): five
 * hosts, this computer, a dev box, the cloud box, and two Walnut is not connected to. The page is
 * ONE list of machines (RemoteHostsSection.tsx): the summary line, a row per host with one state
 * line and at most one action (Set up, Retry), Details in place under a row (rings, disk, the 12
 * hour timeline, numbers, chips, problems, the key/value table, What Walnut knows), and the
 * network map, folded. The old Overview (HostFleetGroup.tsx) is gone: its stat tiles are the
 * summary line, its cards are each row's Details, its per-card read marks are one busy line.
 * The page opens on the cached readings (GET /api/v1/hosts?cached=1) and reads hosts again only
 * on a press (POST /api/v1/hosts/refresh: Refresh, a row's Details, Set up); a failed read keeps
 * the values and says why; a truly first run fills each row as its own read ends.
 * The config's SSH hosts are pinned to the fixture server's own one (other specs add hosts to the
 * shared server), so the fleet's SSH hosts render as reading-only rows (FleetHostRow.tsx); the
 * Connect test saves Home PC as an SSH host for its Retry.
 * Navigation is by clicks (page.goto only loads the app). WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { pick, row } from './remote-hosts-every-button-helpers'
import { expectRing } from './remote-hosts-every-button-steps'
import { cssColorToRgba } from './css-color'
import { dropFakes } from './route-teardown'

test.setTimeout(120_000)
test.use({ viewport: { width: 1280, height: 900 } })
// Settings reads /api/config on its own clock; one may still be in flight as the page closes,
// and a write sent then must not reach the shared fixture (route-teardown.ts).
test.afterEach(async ({ page }) => { await dropFakes(page) })

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-fleet-overview'
const [GB, NOW, MIN, HOUR, DAY] = [1024 ** 3, Date.now(), 60_000, 3_600_000, 86_400_000]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Card = Record<string, any>

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

function card(over: Record<string, unknown>): Card {
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

const FLEET: Card[] = [
  card({
    host: '__local__', label: 'This computer', local: true,
    connection: { kind: 'local', connected: true, phase: 'connected', phaseLabel: 'Running on this Mac', since: null, rttMs: 1, error: null },
    system: { os: 'macOS 15.1', arch: 'arm64', cpus: 10, memBytes: 32 * GB, diskFreeBytes: 50 * GB, kind: 'laptop', probedAt: null },
    now: { cpus: 10, cpuUtil: 0.12, load: [3.1, 2.8, 2.5], memTotalBytes: 32 * GB, memAvailBytes: 20 * GB, uptimeSec: 2 * 86400, bootedAt: NOW - 2 * DAY, linked: true, gpuUtil: 0.18, disk: { totalBytes: 994 * GB, freeBytes: 50 * GB }, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * DAY, bucketMinutes: 1440, buckets: days((i) => (i % 3 === 0 ? 0.7 : 0.95)), windows: [{ days: 7, minutes: 7 * 1440, up: 9374, linked: 9374, online: 0.93, linkedShare: 0.93, drops: 0, downs: 6 }], outages: [], boots: [], daemonStarts: 4, recent: recent({ cpu: 0.3, mem: 0.55, gpu: 0.2, disk: 0.95, sessions: 10 }) },
    sessions: { running: 12 }, spend: { last30dUsd: 2345.6, from: '2026-10-02', basis: 'list-price' },
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: NOW - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'binary', vitals: true },
    placement: { score: 3, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: ['It is a laptop: a job here stops while it sleeps.'] } },
    capabilities: { tags: ['macos', 'local', 'ios', 'browser', 'mcp:playwright'], alwaysOn: false, placement: 'local', os: 'macos', ios: { xcode: 'Xcode 26.1', runtimes: ['iOS 26.1', 'iOS 18.6'] },
      browsers: [{ name: 'chrome', relay: true }, { name: 'brave', relay: false }], mcp: [{ name: 'playwright' }], clis: ['git', 'node', 'xcodegen'], declared: [], unknown: [] },
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
    capabilities: { tags: ['always-on', 'cloud', 'linux', 'docker', 'mcp:docs-mcp', 'mcp:tickets-mcp', 'mcp:mail-mcp', 'gpu'], alwaysOn: true, placement: 'cloud', os: 'linux', ios: null, browsers: [],
      mcp: [{ name: 'docs-mcp', plugin: 'Tools' }, { name: 'tickets-mcp', plugin: 'Tools' }, { name: 'mail-mcp' }], clis: ['docker', 'gh', 'git', 'go', 'node'], declared: ['gpu'], unknown: [] },
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

/** Each row's one state line, in Settings order: This Mac, the saved SSH hosts (the server's own), then the fleet's other hosts. */
const STATES: Record<string, string> = {
  __local__: 'Online, 12% CPU, 12 sessions', 'fixture-remote': 'Off: Walnut does not connect to it.', devbox: 'Online, 25% CPU, 19 sessions',
  olddev: 'Not connected', __cloudbox__: 'Online, 12% CPU, 3 sessions', homepc: 'Could not reach Home PC',
}
const DEV_LIVE = STATES.devbox

/** The fixture server's own SSH host (test-server.ts). */
const OWN_HOSTS: Record<string, unknown> = { 'fixture-remote': { hostname: 'fixture.example.test', label: 'Big remote host', enabled: false } }
const pinned = new WeakSet<Page>()

/** Settings > Remote Hosts by clicks, the config's SSH hosts pinned to `hosts` (nothing here saves). */
async function openRemoteHosts(page: Page, hosts = OWN_HOSTS) {
  if (!pinned.has(page)) {
    pinned.add(page)
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const res = await route.fetch()
      const body = await res.json() as Card
      ;(body.config ?? body).hosts = hosts
      await route.fulfill({ response: res, json: body })
    })
  }
  await page.goto('/')
  await page.getByTestId('sidebar-core-app-settings').click({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
  await expect(page.locator('#remote-hosts')).toBeVisible({ timeout: 20_000 })
}

const state = (page: Page, alias: string) => row(page, alias).getByTestId('rh-row-state')
const details = (page: Page, alias: string) => page.locator(`[data-testid="rh-details"][data-host="${alias}"]`)
const aliases = (page: Page) => page.locator('[data-testid="remote-hosts-list"] .rh-host-row[data-host-alias]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host-alias')!))

/** A row's Details, from its More menu (closed by default; one open at a time). */
async function openDetails(page: Page, alias: string): Promise<Locator> {
  await pick(page, row(page, alias), 'Details')
  await expect(details(page, alias)).toBeVisible()
  await expect(page.getByTestId('rh-details')).toHaveCount(1)
  return details(page, alias)
}

/** Each part under `scope` (a test id, else a selector) reads its words, or is there that many times. */
async function see(scope: Locator | Page, want: Record<string, string | RegExp | string[] | number>) {
  for (const [sel, v] of Object.entries(want)) {
    const el = /^[\w-]+$/.test(sel) ? scope.getByTestId(sel) : scope.locator(sel)
    await (typeof v === 'number' ? expect(el).toHaveCount(v) : expect(el).toHaveText(v))
  }
}

/** A tall window for the picture, so the whole region shows below the pinned bar. */
async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: 2400 })
  await region.evaluate((el) => el.closest('#remote-hosts')?.scrollIntoView({ block: 'start' }))
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
  await page.setViewportSize(size)
}

/** Nothing is wider than its box, the page never scrolls sideways, and the rows are one column. */
async function expectNoOverflow(page: Page) {
  expect(await page.locator('#remote-hosts').evaluate((root) => {
    const out: string[] = []
    const r = root.getBoundingClientRect()
    const name = (el: Element) => `${el.getAttribute('class')} ${el.closest('[data-host-alias]')?.getAttribute('data-host-alias') ?? el.closest('[data-host]')?.getAttribute('data-host') ?? ''}`
    for (const el of root.querySelectorAll<HTMLElement>('.rh-summary, .rh-host-row, .rh-row-state, .rh-details, .hf-vitals-block, .hf-vitals, .hf-numbers, .hf-rows, .hf-problem-list, .hf-topo-panel')) {
      if (!el.getClientRects().length) continue // folded away
      const b = el.getBoundingClientRect()
      if (el.scrollWidth - el.clientWidth > 1) out.push(`scrolls: ${name(el)}`)
      if (b.right > r.right + 1 || b.left < r.left - 1) out.push(`outside: ${name(el)}`)
    }
    const rows = [...root.querySelectorAll<HTMLElement>('.rh-host-row')].map((el) => el.getBoundingClientRect())
    if (new Set(rows.map((b) => `${Math.round(b.left)}:${Math.round(b.width)}`)).size !== 1) out.push('the rows are not one column')
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways')
    return out
  })).toEqual([])
}

/** Every number slot with no number says why beside it, in words (2026-11-04: "why sesison is ?"). */
async function expectEveryUnknownSaysWhy(page: Page) {
  expect(await page.locator('#remote-hosts').evaluate((root) => {
    const bad: string[] = []
    const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    for (const el of root.querySelectorAll<HTMLElement>('[data-num="unknown"]')) {
      const box = el.closest<HTMLElement>('.hf-gauge, .hf-numbers > div') ?? el.parentElement!
      const why = box.querySelector<HTMLElement>('.hf-why')
      const host = el.closest('[data-host]')?.getAttribute('data-host') ?? 'page'
      if (!why || !why.textContent?.trim() || why.offsetParent === null) { bad.push(`${host}: ${box.textContent}`); continue }
      // The reason stays in its own slot's room: never into the next slot, never out of the group.
      const w = why.getBoundingClientRect()
      const group = box.parentElement!
      const g = group.getBoundingClientRect()
      const next = [...group.children].filter((s) => s !== box).flatMap((s) => [s, ...s.querySelectorAll('*')].map((c) => c.getBoundingClientRect()))
      if (w.left < g.left - 1 || w.right > g.right + 1 || next.some((o) => o.width && meets(w, o))) bad.push(`${host}: reason runs out of its slot`)
    }
    // A "?" anywhere else (a ring, a number, the summary, a row's state line) is a bare one.
    for (const el of root.querySelectorAll<HTMLElement>('.hf-gauge-value, .hf-big, .rh-summary-line, .rh-row-state')) {
      if (/(^|\s)\?($|\s)/.test(el.textContent ?? '') && el.getAttribute('data-num') !== 'unknown') bad.push(`bare: ${el.className}`)
    }
    return bad
  })).toEqual([])
}

/** The cached read: each card read 12 minutes ago unless it says otherwise. */
function serveFleet(page: Page, hosts: () => unknown[], refreshing: () => boolean = () => false) {
  let calls = 0
  void page.route((url) => url.pathname === '/api/v1/hosts', (route) => {
    calls++
    const at = Date.now()
    const list = hosts().map((h) => ('readAt' in (h as object) ? h : { ...(h as object), readAt: at - 12 * MIN, refreshing: false, readError: null, readFailedAt: null }))
    return route.fulfill({ json: { hosts: list, checkedAt: at, refreshing: refreshing() } })
  })
  return () => calls
}

/** POST /api/v1/hosts/refresh: each ask's host list (null: every host). */
function serveRefresh(page: Page, onAsk: (hosts: string[] | null) => void = () => {}) {
  const asks: Array<string[] | null> = []
  void page.route('**/api/v1/hosts/refresh', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { hosts?: string[] }
    asks.push(body.hosts ?? null)
    onAsk(body.hosts ?? null)
    return route.fulfill({ status: 202, json: { started: body.hosts ?? [], refreshing: body.hosts ?? [] } })
  })
  return asks
}

/** The fleet's cached read and its refresh served, then the page open with the dev box's row on it. */
async function openFleet(page: Page, hosts: () => unknown[] = () => FLEET) {
  const calls = serveFleet(page, hosts)
  const asks = serveRefresh(page)
  await openRemoteHosts(page)
  await expect(row(page, 'devbox')).toBeVisible({ timeout: 30_000 })
  return { calls, asks }
}

test('a fleet of five: the summary line, a row per host, the network map, and Details of live hosts and of the two away', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const { asks } = await openFleet(page)
  // The cached readings at once, with their age; only this computer's, 12 minutes old, is read
  // behind them (no network); no other host is read to show them.
  await see(page, { 'host-fleet-read': 'Read 12 min ago', 'host-fleet-reading': 0 })
  await expect.poll(() => asks).toEqual([['__local__']])
  // The summary line (the old stat tiles), beside the groups, never inside one (settings-layout.spec.ts F10).
  const summary = page.getByTestId('rh-summary')
  expect(await summary.evaluate((el) => !!el.closest('.settings-group'))).toBe(false)
  await see(summary, { 'rh-summary-online': '3 of 5 online', 'rh-summary-sessions': '34 sessions open', 'rh-summary-spend': '$5,205 in 30 days', 'rh-summary-needs': '4 need a look' })
  await expect(summary.getByTestId('rh-summary-spend')).toHaveAttribute('title', 'At list price, not a bill')

  // One row per host in Settings order, each with its one state line, at most one warning and one
  // action: Set up on the dev box; none on a host away with no SSH entry (Retry: the Connect test).
  expect((await aliases(page)).filter((a) => a in STATES)).toEqual(Object.keys(STATES))
  for (const [alias, line] of Object.entries(STATES)) await expect(state(page, alias)).toHaveText(line)
  const dev = row(page, 'devbox')
  await see(dev, { 'rh-row-warning': 'Daemon does not come back after a reboot', 'host-fleet-fix': 'Set up' })
  await see(row(page, '__local__'), { '.rh-host-name': 'This Mac', 'rh-row-warning': 'Up 93% of the last 7 days' })
  await see(row(page, '__cloudbox__'), { '.settings-tag': 'Cloud', '.rh-row-line': 0 })
  for (const alias of ['__local__', 'olddev', '__cloudbox__', 'homepc']) await expect(row(page, alias).locator('.rh-row-primary button')).toHaveCount(0)
  // "4 need a look" are those rows, and the words take you to the first.
  const marked = await page.locator('[data-testid="remote-hosts-list"] [data-needs-look="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host-alias')!))
  expect(marked.filter((a) => a in STATES)).toEqual(['__local__', 'devbox', 'olddev', 'homepc'])
  await summary.getByTestId('rh-summary-needs').click()
  await expectRing(page, row(page, '__local__'))
  await expectEveryUnknownSaysWhy(page) // the summary and the rows

  // The network map, folded: five nodes, four lines; the two hosts away are dashed and grey.
  const toggle = page.getByTestId('remote-hosts-map-toggle')
  const topo = page.getByTestId('host-fleet-topology')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(topo).toBeHidden()
  await toggle.click()
  const link = (h: string) => `[data-testid="host-fleet-topo-link"][data-host="${h}"]`
  await see(topo, {
    'host-fleet-topo-node': 5, 'path.hf-topo-link': 4, '[data-testid="host-fleet-topo-link"][data-live="false"]': 2,
    [link('devbox')]: 'SSH tunnel, 38 ms', [link('__cloudbox__')]: 'Bridge, 120 ms', [link('homepc')]: 'Not connected',
    '[data-host="__cloudbox__"] [data-mark="cloud"], [data-host="devbox"] [data-mark="phone"]': 2, '[data-host="__local__"] .hf-topo-name': 'This Mac',
  })
  expect(await topo.locator('path.hf-topo-link[data-live="false"]').first().evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none')
  // No two pieces of text overlap; labels only, never an alias.
  expect(await topo.evaluate((svg) => {
    const boxes = [...svg.querySelectorAll('text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }))
    const hits: string[] = []
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(`${boxes[i].t} / ${boxes[j].t}`)
    }
    return hits
  })).toEqual([])
  await expect(topo).not.toContainText('__cloudbox__')
  // A node takes you to its row.
  await topo.locator('[data-testid="host-fleet-topo-node"][data-host="devbox"]').click()
  await expectRing(page, dev)

  // The dev box's Details (the old card), closed until asked for: opening them reads that host again.
  await expect(page.getByTestId('rh-details')).toHaveCount(0)
  const d = await openDetails(page, 'devbox')
  await expect.poll(() => asks).toEqual([['__local__'], ['devbox']])
  // Rings (disk too: the share in use, what is free under it; no GPU on it), the last 12 hours (a
  // chart each), numbers, chips, its one problem in full, the key/value table, the long-running
  // verdict; the row keeps the one Set up.
  await see(d, {
    'host-fleet-system': /^Debian 12, x64, 32 CPUs, 128 GB/, 'host-fleet-roles': 'Always onReplica', 'host-fleet-read-age': 'Read 12 min ago',
    '[data-gauge="cpu"] .hf-gauge-value': '25%', '[data-gauge="mem"] .hf-gauge-value': '25%', '[data-gauge="disk"] .hf-gauge-value': '44%',
    'host-fleet-disk-free': '2.2 TB free', 'host-fleet-gauge': 3, 'host-fleet-spark': 3, '[data-spark="sessions"] .hf-lane-value': /^max \d+$/,
    '[data-testid="host-fleet-sessions"] .hf-big': '19', '[data-testid="host-fleet-spend"] .hf-big': '$1,234',
    '[data-testid="host-fleet-caps"] .hf-chip': ['Docker', '3 MCP servers', 'gpu'], 'host-fleet-problem': 'Daemon does not come back after a reboot',
    '[data-row="now"] dd': 'CPU 25%, load 6.16, 96 GB of 128 GB memory free, up 13 d',
    '[data-row="server"] dd': 'Replica, running, 0.6.20-abc1234, phone tunnel connected', '[data-testid="host-fleet-days"] i': 30,
    '[data-testid="host-fleet-fit"] code': ['walnut daemon install --yes', 'sudo loginctl enable-linger $USER'], 'host-fleet-fix': 0,
    // The timeline is broken where it was down (40 min) or had no link.
    '[data-testid="host-fleet-timeline"] i[data-tone="bad"]': 1, '[data-testid="host-fleet-timeline"] i[data-tone="warn"]': 1,
  })
  await expect(d.getByTestId('host-fleet-disk-free')).toHaveAttribute('data-low', 'false')
  await expect(d.getByTestId('host-fleet-problem')).toHaveAttribute('title', 'does not start by itself after a reboot: nothing on it starts the daemon at boot')
  await expect(d.getByTestId('host-fleet-problem')).toHaveAttribute('data-problem', 'reboot')
  await expect(d.locator('[data-testid="host-fleet-timeline"] i[data-tone="bad"]')).toHaveAttribute('title', /: down \(40 min\)$/)
  expect((await d.locator('[data-spark="cpu"] .hf-spark-line').getAttribute('d'))!.split('M').filter(Boolean)).toHaveLength(2)

  // This Mac: Primary, iOS and the browser, a GPU ring and chart, its uptime and its laptop verdict.
  const mac = await openDetails(page, '__local__')
  await see(mac, {
    'host-fleet-roles': 'Primary', '[data-gauge="gpu"] .hf-gauge-value': '18%', '[data-gauge="disk"] .hf-gauge-value': '95%', 'host-fleet-disk-free': '50 GB free',
    '[data-gauge]': 4, '[data-spark]': 4, '[data-testid="host-fleet-caps"] .hf-chip': ['iOS simulator', 'Browser', '1 MCP server'],
    'host-fleet-problem': ['Up 93% of the last 7 days', 'Laptop: not for jobs that must keep running'],
  })
  await expect(mac.locator('[data-spark="gpu"]')).toHaveAttribute('title', /^GPU over the last 12 hours/)
  // The two hosts away: why, with the error; an older daemon's empty reading; each unknown says why.
  await see(await openDetails(page, 'homepc'), { '[data-row="connection"] dd': 'SSH tunnel: Could not reach Home PC (ssh: connection timed out)' })
  await expectEveryUnknownSaysWhy(page)
  await see(await openDetails(page, 'olddev'), { '[data-row="now"] dd': 'Its daemon is older than this view (it upgrades on the next connect)' })
  await expectEveryUnknownSaysWhy(page)
  await expectNoOverflow(page)
  await shot(page, '1-fleet-1280', page.getByTestId('remote-hosts-list'))
  // Closing them reads nothing.
  await pick(page, row(page, 'olddev'), 'Hide details')
  await expect(page.getByTestId('rh-details')).toHaveCount(0)
  expect(asks).toEqual([['__local__'], ['devbox'], ['__local__'], ['homepc'], ['olddev']])
  expect(errors).toEqual([])
})

for (const { width, dark } of [{ width: 900 }, { width: 700 }, { width: 1280, dark: true }]) {
  test(`at ${width} px${dark ? ', dark,' : ''} the list stays readable: one column, nothing spills, Details and the map included`, async ({ page }) => {
    if (dark) await page.emulateMedia({ colorScheme: 'dark' })
    await openFleet(page)
    // Narrowed once open (under 768 px the app's rail folds behind its menu).
    await page.setViewportSize({ width, height: 900 })
    await page.getByTestId('remote-hosts-map-toggle').click()
    await expect(page.getByTestId('host-fleet-topology')).toBeVisible()
    for (const alias of ['olddev', 'devbox']) {
      await openDetails(page, alias)
      await expectNoOverflow(page)
      await expectEveryUnknownSaysWhy(page)
    }
    // The long label fits its row (no spill above), its whole name in the title; the map scales down, still readable.
    await expect(row(page, 'olddev').locator('.rh-host-name')).toHaveAttribute('title', FLEET[2].label)
    expect((await page.locator('[data-testid="host-fleet-topo-link"][data-host="devbox"]').boundingBox())!.height).toBeGreaterThanOrEqual(7)
    // Dark: no dark text left on a dark surface (the map's text by its fill).
    const inks = !dark ? [] : await page.locator('#remote-hosts').evaluate((root) => {
      const sel = '.rh-summary-line span, .rh-host-name, .rh-row-state, .rh-row-line, .hf-card-sys, .hf-gauge-value, .hf-big, .hf-problem-list li, .hf-chip, .hf-row dd, .hf-topo-name, .hf-topo-label'
      return [...root.querySelectorAll<HTMLElement>(sel)].map((el) => [el.getAttribute('class'), getComputedStyle(el)[el instanceof SVGElement ? 'fill' : 'color']])
    })
    expect(inks.filter(([, ink]) => Math.max(...cssColorToRgba(ink!).slice(0, 3)) < 90)).toEqual([])
    await shot(page, `2-list-${width}${dark ? '-dark' : ''}`, page.getByTestId('remote-hosts-list'))
  })
}

test('Set up: the row waits, then reads as set up; a refusal or a check that changed nothing says so under it', async ({ page }) => {
  let hold = Promise.resolve()
  let answer: 'refuse' | 'unchanged' | 'ok' = 'refuse'
  let served = FLEET[1] // the server's cached card follows what the host answered
  const base = FLEET[1]
  const fixed = { ...base, daemon: { ...base.daemon, startsAfterReboot: true, bootStart: { mode: 'boot', backend: 'systemd-user', reason: null, checkedAt: NOW, setupRunning: false, setupError: null, next: null }, reboot: 'starts by itself after a reboot (as a systemd user service)' } }
  const unchanged = { ...base, daemon: { ...base.daemon, bootStart: { mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: 'this account cannot start the daemon at boot without root', next: 'recheck' }, reboot: 'does not start by itself after a reboot: this account cannot start the daemon at boot without root' } }
  await page.route('**/api/v1/hosts/devbox/boot-start', async (route) => {
    await hold
    if (answer === 'refuse') return route.fulfill({ status: 502, json: { error: 'Walnut could not check Big dev box: ssh: connection reset', code: 'check_failed' } })
    served = answer === 'ok' ? fixed : unchanged
    return route.fulfill({ json: { host: served } })
  })
  await openFleet(page, () => FLEET.map((h) => (h.host === 'devbox' ? served : h)))
  const dev = row(page, 'devbox')
  const fix = dev.getByTestId('host-fleet-fix')
  // Each press waits until the test lets its answer go, so the busy words can be seen.
  const press = async (keyboard = false) => {
    let release = () => {}
    hold = new Promise<void>((r) => { release = r })
    if (keyboard) { await fix.focus(); await page.keyboard.press('Enter') } else await fix.click()
    await expect(fix).toHaveText('Setting up...')
    await expect(fix).toBeDisabled()
    await expect(page.getByText('Setting up...', { exact: true })).toHaveCount(1) // this row's alone
    release()
  }
  await press()
  await see(dev, { 'host-fleet-action-error': 'Could not set it up: Walnut could not check Big dev box: ssh: connection reset.', 'host-fleet-fix': 'Set up' })
  await expect(fix).toBeEnabled()
  await shot(page, '3-setup-refused', dev)
  answer = 'unchanged'
  await press()
  await see(dev, { 'host-fleet-action-note': 'Checked just now: does not start by itself after a reboot: this account cannot start the daemon at boot without root.', 'host-fleet-fix': 'Check again', 'host-fleet-action-error': 0 })
  // By the keyboard: the button goes away with the warning, and the focus moves to the row's More.
  answer = 'ok'
  await press(true)
  await see(dev, { 'host-fleet-action-note': 'Set up: starts by itself after a reboot (as a systemd user service).', 'rh-row-warning': 0, 'host-fleet-fix': 0, 'rh-row-state': DEV_LIVE })
  await expect(dev.getByTestId('rh-row-more')).toBeFocused()
  await shot(page, '4-setup-done', dev)
})

test('Connect: the row waits, then comes back live; a refusal stays on its row; the focus never falls to the page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  // A clock of its own, so six seconds after the Connect run inside this test.
  await page.clock.install()
  let homeUp = false
  let upAt = 0
  const live = () => ({ kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: upAt, rttMs: 51, error: null })
  serveFleet(page, () => FLEET.map((h) => (homeUp && h.host === 'homepc' ? { ...h, connection: live(), now: { ...h.now, stale: false, at: upAt } } : h)))
  const asks = serveRefresh(page)
  // Home PC saved as an SSH host, with its live status (the fixture server knows neither): its row is the editor's.
  const wire = () => ({
    host: 'homepc', label: 'Home PC', hostname: 'homepc.example.test', connected: homeUp, phase: homeUp ? 'connected' : 'failed', steps: [], at: Date.now(),
    phaseLabel: homeUp ? 'Connected' : 'Could not reach Home PC', ...(homeUp ? {} : { error: 'ssh: connection timed out', kind: 'network' }),
  })
  await page.route('**/api/hosts/status', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { hosts?: Card[] }
    await route.fulfill({ response: res, json: { ...body, hosts: [...(body.hosts ?? []).filter((h) => h.host !== 'homepc'), wire()] } })
  })
  let hold = Promise.resolve()
  let refuse = true
  await page.route('**/api/hosts/homepc/connect', async (route) => {
    await hold
    if (refuse) return route.fulfill({ status: 409, json: { error: 'Home PC refused the sign-in' } })
    homeUp = true
    upAt = Date.now()
    // What the server answers: the host's status now (the store takes it, as from a push).
    return route.fulfill({ json: { ok: true, status: { ...wire(), serverNow: Date.now() } } })
  })
  await openRemoteHosts(page, { ...OWN_HOSTS, homepc: { hostname: 'homepc.example.test', label: 'Home PC', enabled: true } })
  const r = row(page, 'homepc')
  const connect = r.getByTestId('rh-row-connect')
  await expect(connect).toHaveText('Retry', { timeout: 30_000 })
  const failed = 'Could not connect to Home PC'
  await see(r, { '.settings-tag': 'SSH', 'rh-row-state': failed })
  // Pressed by the keyboard (the focus rule is about it); while it waits, the focus stays on the page's controls.
  const press = async () => {
    let release = () => {}
    hold = new Promise<void>((res) => { release = res })
    await connect.focus()
    await page.keyboard.press('Enter')
    await expect(connect).toHaveText('Retrying...')
    await expect(connect).toBeDisabled()
    await expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
    release()
  }
  await press()
  await see(r, { 'host-fleet-action-error': 'Could not retry right now.', 'rh-row-state': failed })
  await expect(connect).toBeEnabled()
  refuse = false
  await press()
  await see(r, { 'rh-row-state': /^Online, 5% CPU/, 'host-fleet-action-note': 'Connected.', 'host-fleet-action-error': 0, 'rh-row-connect': 0 })
  // Its Retry went away with its state: the focus is on the row's More.
  await expect(r.getByTestId('rh-row-more')).toBeFocused()
  await see(page, { 'rh-summary-online': '4 of 5 online' })
  await expect(state(page, 'olddev')).toHaveText(STATES.olddev) // the other host away stays as it was
  await page.getByTestId('remote-hosts-map-toggle').click()
  await expect(page.locator('[data-testid="host-fleet-topo-link"][data-host="homepc"]')).toHaveAttribute('data-live', 'true')
  // It came up after its last read: that host alone is read again (this computer's old reading was read on open).
  await expect.poll(() => asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  // A connect reads its host once per link (2026-11-04: the press read it at once, again 5 s
  // later, and the per-link read on top): six seconds on, still no other read of a host.
  await page.clock.runFor(6_000)
  await expect(r.getByTestId('rh-row-state')).toHaveText(/^Online, 5% CPU/)
  expect(asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  await shot(page, '5-connected', r)
})

test('no other host is read while the page is just open; this computer\'s old reading is read once; Details or Refresh read them', async ({ page }) => {
  await page.clock.install()
  // Fixed read times (the page's clock runs ahead of the real one): the box was read 12 minutes
  // ago; this computer too, until its read on open lands (half a minute before it answers).
  const readAt = Date.now() - 12 * MIN
  let localAt = readAt
  let skew = 0 // how far the page's clock runs ahead of this one
  serveFleet(page, () => FLEET.slice(0, 2).map((h) => ({ ...h, readAt: h.local ? localAt : readAt, refreshing: false, readError: null, readFailedAt: null })))
  const asks = serveRefresh(page, (hosts) => { if (!hosts || hosts.includes('__local__')) localAt = Date.now() + skew - MIN / 2 })
  // This computer is read again whenever its reading is over 5 minutes old (no network); the rest are counted exactly.
  const local = () => asks.filter((a) => a?.length === 1 && a[0] === '__local__').length
  const others = () => asks.filter((a) => !(a?.length === 1 && a[0] === '__local__'))
  await openRemoteHosts(page)
  await expect(row(page, 'devbox')).toBeVisible({ timeout: 30_000 })
  // This computer's reading is 12 minutes old: it alone is read, once.
  await expect.poll(() => asks).toEqual([['__local__']])
  await see(page, { 'host-fleet-read': 'Read just now' })
  // Five minutes on the page (the old page read every host every 30 s): the words age, no host is read.
  await page.clock.runFor(5 * MIN)
  skew = 5 * MIN
  await see(page, { 'host-fleet-read': 'Read 5 min ago' })
  expect(others()).toEqual([])
  // A host's Details read it (the Overview's fold, which read every host as it opened, is gone);
  // the cached read after it finds this computer's reading old again and reads it once more.
  await see(await openDetails(page, 'devbox'), { 'host-fleet-read-age': 'Read 17 min ago' })
  await expect.poll(others).toEqual([['devbox']])
  await expect.poll(local).toBeGreaterThanOrEqual(2)
  // Refresh reads every host.
  await page.getByTestId('host-fleet-refresh').click()
  await expect.poll(others).toEqual([['devbox'], null])
})

test('this computer\'s reading 19 minutes old: its last session count stays, read again on open; a slot with no number says why', async ({ page }) => {
  let read = false
  const [local, cloud] = [FLEET[0], FLEET[3]]
  serveFleet(page, () => {
    const at = Date.now()
    const done = { refreshing: false, readError: null, readFailedAt: null }
    const mac = read
      ? { ...local, ...done, readAt: at, now: { ...local.now, at, stale: false }, sessions: { running: 5, source: 'host', why: null } }
      : { ...local, ...done, readAt: at - 19 * MIN, now: { ...local.now, at: at - 19 * MIN, stale: true }, sessions: { running: 4, source: 'host', why: null, at: at - 19 * MIN } }
    return [mac, { ...cloud, ...done, readAt: at - 12 * MIN, sessions: { running: null, source: null, why: 'the cloud box runs no sessions of its own' }, spend: null }]
  })
  // Hold the reads (briefly: the page gives one up after 10 s) so the kept count can be seen first.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  const asks: Array<string[] | null> = []
  await page.route('**/api/v1/hosts/refresh', async (route) => {
    asks.push(((route.request().postDataJSON() ?? {}) as { hosts?: string[] }).hosts ?? null)
    await held
    read = true
    return route.fulfill({ status: 202, json: { started: ['__local__'], refreshing: [] } })
  })
  await openRemoteHosts(page)
  // The old reading keeps its own count, on the row and in Details, whose tooltip says how old it is.
  await expect(state(page, '__local__')).toHaveText('Online, 12% CPU, 4 sessions', { timeout: 30_000 })
  await expect.poll(() => asks).toEqual([['__local__']])
  const mac = await openDetails(page, '__local__')
  const sessions = mac.getByTestId('host-fleet-sessions')
  await see(mac, { '[data-testid="host-fleet-sessions"] .hf-big': '4', '[data-num="unknown"]': 0 })
  await expect(sessions).toHaveAttribute('data-source', 'host')
  await expect(sessions).toHaveAttribute('title', 'Counted by the host 19 min ago (its last reading)')
  // The cloud box runs no sessions of its own: its row and the summary leave them out.
  await see(page, { 'rh-summary-sessions': '4 sessions open' })
  await expect(state(page, '__cloudbox__')).toHaveText('Online, 12% CPU')
  release()
  // The read ends: the open Details and the row show the host's own count, read just now.
  await expect(sessions.locator('.hf-big')).toHaveText('5', { timeout: 15_000 })
  await expect(sessions).toHaveAttribute('title', 'Counted by the host itself')
  await see(mac, { 'host-fleet-read-age': 'Read just now' })
  await expect(state(page, '__local__')).toHaveText('Online, 12% CPU, 5 sessions')
  // The cloud box's Details say why in words, never a bare "?".
  const box = await openDetails(page, '__cloudbox__')
  await see(box, { '[data-testid="host-fleet-sessions"] .hf-why': 'the cloud box runs no sessions of its own', '[data-testid="host-fleet-spend"] .hf-why': 'not counted yet' })
  await expectEveryUnknownSaysWhy(page)
  await expectNoOverflow(page)
  await shot(page, '11-stale-local', box)
  expect(asks).toEqual([['__local__'], ['__local__'], ['__cloudbox__']])
})

test('a reopened page shows the last readings at once, before the server answers; a reading hours old keeps every value', async ({ page }) => {
  let answer: 'first' | 'later' = 'first'
  let hold: Promise<void> | null = null
  await page.route((url) => url.pathname === '/api/v1/hosts', async (route) => {
    if (hold) await hold
    const at = Date.now()
    // Three hours later, never read since: the server still answers the box's last reading, marked stale.
    const old = at - 3 * HOUR
    const hosts = FLEET.slice(0, 2).map((x) => ({ ...x, refreshing: false, readError: null, readFailedAt: null, readAt: at - 2 * MIN, ...(answer === 'later' && x.host === 'devbox'
      ? { readAt: old, now: { ...x.now, cpuUtil: 0.61, at: old, stale: true }, sessions: { running: 7, source: 'host', why: null, at: old } } : {}) }))
    return route.fulfill({ json: { hosts, checkedAt: at, refreshing: false } })
  })
  serveRefresh(page)
  await openRemoteHosts(page)
  const devState = state(page, 'devbox')
  await expect(devState).toHaveText(DEV_LIVE, { timeout: 30_000 })
  // Reopen with the server slow to answer: the last readings paint at once from this browser.
  let release = () => {}
  hold = new Promise<void>((r) => { release = r })
  answer = 'later'
  await openRemoteHosts(page)
  await expect(devState).toHaveText(DEV_LIVE, { timeout: 10_000 })
  await see(page, { 'rh-summary-online': '2 of 2 online', 'host-fleet-reading': 0 })
  release()
  hold = null
  // The server's answer replaces them; three hours old, every value stays, with its age.
  await expect(devState).toHaveText('Online, 61% CPU, 7 sessions', { timeout: 10_000 })
  const d = await openDetails(page, 'devbox')
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '61%', '[data-testid="host-fleet-sessions"] .hf-big': '7', 'host-fleet-read-age': 'Read 3 h ago', '[data-num="unknown"]': 0 })
  await expect(d.getByTestId('host-fleet-sessions')).toHaveAttribute('title', 'Counted by the host 3 h ago (its last reading)')
  for (const g of await d.getByTestId('host-fleet-gauge').all()) await expect(g.locator('.hf-gauge-value')).not.toHaveText('?')
  await expectEveryUnknownSaysWhy(page)
  await see(page, { 'rh-summary-sessions': '19 sessions open' })
})

test('a read keeps the old values with ONE "Refreshing..." for the page; each row and Details change as its read ends; a failed one says why', async ({ page }) => {
  let stage: 'cached' | 'reading' | 'done' = 'cached'
  serveFleet(page, () => {
    const at = Date.now()
    const old = { readAt: at - 12 * MIN, refreshing: false, readError: null, readFailedAt: null }
    if (stage === 'cached') return FLEET
    if (stage === 'reading') return FLEET.map((h) => ({ ...h, ...old, refreshing: true }))
    return FLEET.map((x) => {
      if (x.host === 'devbox') return { ...x, now: { ...x.now, cpuUtil: 0.6, at }, readAt: at, refreshing: false, readError: null, readFailedAt: null }
      if (x.host === '__cloudbox__') return { ...x, now: { ...x.now, stale: true }, ...old, readError: 'it did not answer in 25 s', readFailedAt: at }
      return { ...x, ...old, readAt: at }
    })
  }, () => stage === 'reading')
  // Only the press reads every host; this computer's own read on open leaves the readings as cached.
  serveRefresh(page, (hosts) => { if (hosts === null) stage = 'reading' })
  await openRemoteHosts(page)
  const devState = state(page, 'devbox')
  await expect(devState).toHaveText(DEV_LIVE, { timeout: 30_000 })
  // The person looks at the dev box while every host is read.
  const d = await openDetails(page, 'devbox')
  await page.getByTestId('host-fleet-refresh').click()
  // The old values stay; the summary line alone says a read runs (no mark per host or in Details).
  await see(page, { 'host-fleet-refreshing': 'Refreshing...', 'host-fleet-reading': 0 })
  await expect(page.getByText('Refreshing...', { exact: true })).toHaveCount(1)
  await expect(devState).toHaveText(DEV_LIVE)
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '25%', 'host-fleet-read-age': 'Read 12 min ago' })
  expect(await aliases(page)).toEqual(Object.keys(STATES)) // every row stays
  await shot(page, '6-refreshing', page.getByTestId('remote-hosts-list'))
  // Its read ends: the row and the open Details change in place.
  stage = 'done'
  await expect(devState).toHaveText('Online, 60% CPU, 19 sessions', { timeout: 10_000 })
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '60%', 'host-fleet-read-age': 'Read just now', 'host-fleet-read-error': 0 })
  await see(page, { 'host-fleet-refreshing': 0, 'host-fleet-read': 'Read just now' })
  // The host that did not answer keeps its reading, with one line saying why and how old it is.
  const c = await openDetails(page, '__cloudbox__')
  await see(c, {
    'host-fleet-read-error': 'Could not read it: it did not answer in 25 s. Showing what it read 12 min ago.', 'host-fleet-read-age': 'Read 12 min ago',
    'host-fleet-problem': 0, // no second line saying the same
  })
  await expect(state(page, '__cloudbox__')).toHaveText(STATES.__cloudbox__)
  expect(await aliases(page)).toEqual(Object.keys(STATES))
  await expectNoOverflow(page)
  await shot(page, '7-read-failed', c)
})

test('a truly first run: the summary says it is reading, then each row as its own read ends', async ({ page }) => {
  let stage = 0 // 0 never read, 1 all being read, 2 the Mac read, 3 all read
  const unread = { readAt: null, refreshing: false, readError: null, readFailedAt: null }
  serveFleet(page, () => FLEET.slice(0, 3).map((h, i) => {
    if (stage === 0) return { ...h, ...unread }
    const read = stage === 3 || (stage === 2 && i === 0)
    return { ...h, ...(read ? { readAt: Date.now(), refreshing: false, readError: null, readFailedAt: null } : { ...unread, refreshing: true }) }
  }), () => stage === 1 || stage === 2)
  const asks = serveRefresh(page, () => { stage = 1 })
  await openRemoteHosts(page)
  // Nothing was ever read: the page reads every host once, on its own.
  await expect.poll(() => asks, { timeout: 30_000 }).toEqual([['__local__', 'devbox', 'olddev']])
  await see(page, { 'host-fleet-reading': 'Reading each host...' })
  for (const alias of ['__local__', 'devbox', 'olddev']) await expect(row(page, alias)).toHaveCount(0)
  stage = 2
  await expect(state(page, '__local__')).toHaveText(STATES.__local__, { timeout: 10_000 })
  expect((await aliases(page))[0]).toBe('__local__')
  await see(page, { 'rh-summary-online': '1 of 1 online', 'host-fleet-reading': 'Reading 2 more hosts...' })
  await expect(row(page, 'devbox')).toHaveCount(0)
  await shot(page, '8-first-run', page.getByTestId('remote-hosts-list'))
  stage = 3
  await expect(state(page, 'devbox')).toHaveText(DEV_LIVE, { timeout: 10_000 })
  await expect(state(page, 'olddev')).toHaveText(STATES.olddev)
  await see(page, { 'host-fleet-reading': 0, 'rh-summary-online': '2 of 3 online' })
  expect(asks).toHaveLength(1) // read once, not again on every poll
})

test('a failed read keeps the rows and says why; the next press recovers', async ({ page }) => {
  let fail: 'none' | 'read' | 'refresh' = 'none'
  await page.route((url) => url.pathname === '/api/v1/hosts', (route) => fail === 'read'
    ? route.fulfill({ status: 500, json: { error: 'host table locked' } })
    : route.fulfill({ json: { hosts: FLEET.slice(0, 2).map((h) => ({ ...h, readAt: Date.now() - 12 * MIN, refreshing: false, readError: null })), checkedAt: NOW, refreshing: false } }))
  await page.route('**/api/v1/hosts/refresh', (route) => fail === 'refresh'
    ? route.fulfill({ status: 503, json: { error: 'Walnut is restarting' } })
    : route.fulfill({ status: 202, json: { started: [], refreshing: [] } }))
  await openRemoteHosts(page)
  const devState = state(page, 'devbox')
  const bad = page.locator('[data-testid="rh-summary"] [data-tone="bad"]')
  // Every row stays, with its last values.
  const kept = async () => {
    await expect(devState).toHaveText(DEV_LIVE)
    expect(await aliases(page)).toEqual(['__local__', 'fixture-remote', 'devbox'])
  }
  await expect(devState).toHaveText(DEV_LIVE, { timeout: 30_000 })
  fail = 'read'
  await page.getByTestId('host-fleet-refresh').click()
  await expect(bad.first()).toHaveText('Could not read the hosts: host table locked. Showing what was read last.')
  await kept()
  fail = 'refresh'
  await page.getByTestId('host-fleet-refresh').click()
  await see(page, { 'host-fleet-refresh-error': 'Could not read the hosts again: Walnut is restarting. Showing what was read 12 min ago.' })
  await kept()
  await shot(page, '9-refresh-failed', page.getByTestId('rh-summary'))
  fail = 'none'
  await page.getByTestId('host-fleet-refresh').click()
  await expect(bad).toHaveCount(0)
  await kept()
})

test('opening a host\'s Details reads it again, What Walnut knows inside them; closing reads nothing', async ({ page }) => {
  const { asks } = await openFleet(page, () => FLEET.slice(0, 2))
  await expect.poll(() => asks).toEqual([['__local__']]) // this computer's 12 minute old reading
  // What Walnut knows moved from under Edit into Details: the one read is the opening of Details.
  const box = await openDetails(page, 'fixture-remote')
  await see(box, { 'host-profile-heading-fixture-remote': 'What Walnut knows', '.rh-details-empty': 'Walnut has no reading of Big remote host yet: it reads a host once it connects.' })
  await expect.poll(() => asks).toEqual([['__local__'], ['fixture-remote']])
  await pick(page, row(page, 'fixture-remote'), 'Hide details')
  await expect(box).toHaveCount(0)
  await openDetails(page, 'fixture-remote')
  await expect.poll(() => asks).toEqual([['__local__'], ['fixture-remote'], ['fixture-remote']])
})

test('the fixture server answers its own fleet: this computer first', async ({ page }) => {
  await openRemoteHosts(page)
  // A fresh fixture has no cache: the page reads each host once, and This Mac's row lands when its read ends.
  await expect(row(page, '__local__')).toBeVisible({ timeout: 30_000 })
  expect((await aliases(page))[0]).toBe('__local__')
  await see(row(page, '__local__'), { '.rh-host-name': 'This Mac', 'rh-row-state': /^Online/ })
  const mac = await openDetails(page, '__local__')
  for (const part of [mac.getByTestId('host-fleet-spend'), mac.getByTestId('host-fleet-timeline'), mac.locator('[data-row="can"]')]) await expect(part).toBeVisible() // the real server sends capabilities
  await expect(mac.getByTestId('host-fleet-read-age')).toHaveText(/^Read (just now|\d+ min ago)$/, { timeout: 30_000 })
  await shot(page, '10-fixture-server', page.getByTestId('remote-hosts-list'))
})
