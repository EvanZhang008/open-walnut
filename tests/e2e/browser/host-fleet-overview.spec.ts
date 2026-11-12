/**
 * Settings > Remote Hosts at the density of a real fleet (server: src/core/hosts/fleet.ts): five
 * hosts, this computer, a dev box, the cloud box, and two Walnut is not connected to.
 *
 * First on the page, open by default, the Overview (HostFleetOverview.tsx, HostFleetCard.tsx; the
 * dashboard of 2026-11-03, back on 2026-11-11 at the user's ask): its four numbers (counted from
 * the list's rows, so they never disagree with it), the diagram drawing every row (a node lands on
 * its card), one card per live host (rings, disk, the 12 hour timeline, numbers, chips, one
 * problem line with Set up), a row each for the hosts away (Connect), Details in place in each.
 * Under it, ONE list of machines (RemoteHostsSection.tsx): the header's one "need a look" count, a
 * row per host with one state line and at most one action (Set up, Retry SSH), Details in place
 * under a row (the same reading, the problems its row does not already name, the facts table,
 * What Walnut knows).
 * The page opens on the cached readings (GET /api/v1/hosts?cached=1) and reads hosts again only
 * on a press (POST /api/v1/hosts/refresh: Refresh, opening the Overview, a card's or a row's
 * Details, Set up); a failed read keeps the values and says why; a truly first run fills each
 * card and row as its own read ends.
 * The config's SSH hosts are pinned to the fixture server's own one (other specs add hosts to the
 * shared server), so the fleet's SSH hosts render as reading-only rows (FleetHostRow.tsx); the
 * Connect tests save Home PC as an SSH host for its Retry SSH.
 * Navigation is by clicks (page.goto only loads the app). WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openHostParts } from './host-problems-fixture-helpers'
import { fleetStat, pick, row } from './remote-hosts-every-button-helpers'
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
/** A live host's Overview card, and the Overview's row of a host Walnut is not connected to. */
const cardOf = (page: Page, host: string) => page.locator(`[data-testid="host-fleet"] [data-testid="hf-dash-card"][data-host="${host}"]`)
const awayOf = (page: Page, host: string) => page.locator(`[data-testid="host-fleet"] [data-testid="hf-dash-offline"][data-host="${host}"]`)
const hostsOf = (l: Locator) => l.evaluateAll((els) => els.map((e) => e.getAttribute('data-host')!))
const details = (page: Page, alias: string) => page.locator(`[data-testid="rh-details"][data-host="${alias}"]`)
const aliases = (page: Page) => page.locator('[data-testid="remote-hosts-list"] .rh-host-row[data-host-alias]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host-alias')!))

/** A row's Details, from its More menu (closed by default; one open at a time). */
async function openDetails(page: Page, alias: string): Promise<Locator> {
  await pick(page, row(page, alias), 'Details')
  await expect(details(page, alias)).toBeVisible()
  await expect(page.getByTestId('rh-details')).toHaveCount(1)
  // Every part open (This host and What Walnut knows are folded by default).
  await openHostParts(details(page, alias))
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

/**
 * Nothing is wider than its box, the page never scrolls sideways, the Overview's numbers, cards and
 * rows sit inside it, and the list's rows are one column.
 */
async function expectNoOverflow(page: Page) {
  expect(await page.locator('#remote-hosts').evaluate((root) => {
    const out: string[] = []
    const r = root.getBoundingClientRect()
    const name = (el: Element) => `${el.getAttribute('class')} ${el.closest('[data-host-alias]')?.getAttribute('data-host-alias') ?? el.closest('[data-host]')?.getAttribute('data-host') ?? ''}`
    const sel = '.hf-dash, .hf-stat, .hf-panel, .hf-grid, .hf-card, .hf-off, .rh-host-row, .rh-row-state, .rh-details, .hf-vitals-block, .hf-vitals, .hf-numbers, .hf-rows, .hf-problem-list, .hf-topo-panel'
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (!el.getClientRects().length) continue // folded away
      const b = el.getBoundingClientRect()
      if (el.scrollWidth - el.clientWidth > 1) out.push(`scrolls: ${name(el)}`)
      if (b.right > r.right + 1 || b.left < r.left - 1) out.push(`outside: ${name(el)}`)
    }
    const dash = root.querySelector('[data-testid="host-fleet"]')
    if (dash) {
      const d = dash.getBoundingClientRect()
      for (const el of dash.querySelectorAll('.hf-stat, .hf-card, .hf-off')) {
        const b = el.getBoundingClientRect()
        if (b.right > d.right + 1 || b.left < d.left - 1) out.push(`outside the Overview: ${name(el)}`)
      }
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
      const box = el.closest<HTMLElement>('.hf-gauge, .hf-numbers > div, .hf-stat') ?? el.parentElement!
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
    // A "?" anywhere else (a ring, a number, an Overview tile, a row's state line) is a bare one.
    for (const el of root.querySelectorAll<HTMLElement>('.hf-gauge-value, .hf-big, .hf-stat-value, .rh-row-state')) {
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

test('a fleet of five, the Overview: its numbers, the diagram (a node lands on its card), a card per live host, a row each for the two away, Details in them', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const { asks } = await openFleet(page)
  const dash = page.getByTestId('host-fleet')
  // The cached readings at once, with their age; only this computer's, 12 minutes old, is read
  // behind them (no network); no other host is read to show them.
  await see(page, { 'host-fleet-read': 'Read 12 min ago', 'host-fleet-reading': 0 })
  await expect.poll(() => asks).toEqual([['__local__']])
  // Open by default, the page's first part, beside the groups, never inside one (settings-layout.spec.ts F10).
  await expect(page.getByTestId('host-fleet-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(await dash.evaluate((el) => !!el.closest('.settings-group'))).toBe(false)
  expect(await page.getByTestId('remote-hosts-page').evaluate((el) => el.firstElementChild?.getAttribute('data-testid'))).toBe('host-fleet')

  // Its numbers count the list's rows, each once: 3 of the 5 machines Walnut reaches are online
  // (the saved host switched off is none of them); "need a look" is the header's own count.
  for (const [id, want] of [['online', '3/5'], ['sessions', '34'], ['spend', '$5,205'], ['problems', '4']] as const) await expect(fleetStat(page, id)).toHaveText(want)
  await expect(page.getByTestId('host-fleet-stat-spend')).toHaveAttribute('title', 'At list price, not a bill')
  await expect(page.getByTestId('host-fleet-stat-problems')).toContainText('Hosts need a look')
  await expect(page.getByTestId('rh-needs-look')).toHaveText('4 need a look')

  // A card per live host in the list's order, this computer first; a row each for the two away;
  // the host switched off is left out of it.
  expect(await hostsOf(dash.getByTestId('hf-dash-card'))).toEqual(['__local__', 'devbox', '__cloudbox__'])
  expect(await hostsOf(dash.getByTestId('hf-dash-offline'))).toEqual(['olddev', 'homepc'])
  await expect(dash.locator('#hf-card-fixture-remote')).toHaveCount(0)
  await see(dash.getByTestId('host-fleet-offline-list'), { '.hf-off-head': 'Not connected (2)' })
  await see(cardOf(page, 'devbox'), { 'host-fleet-read-age': 'Read 12 min ago' })
  await expectEveryUnknownSaysWhy(page)

  // The diagram, every row of the list as its row says it (2026-11-04 review: it drew only the
  // hosts with a reading, and one green that its row said was off). Six nodes, five lines; the two
  // hosts away and the one switched off are dashed. Each line says how this Mac reaches the host:
  // the dev box by its SSH tunnel, only the companion's box through the companion.
  const topo = dash.getByTestId('host-fleet-topology')
  const link = (h: string) => `[data-testid="host-fleet-topo-link"][data-host="${h}"]`
  const node = (h: string) => topo.locator(`[data-testid="host-fleet-topo-node"][data-host="${h}"]`)
  await see(topo, {
    'host-fleet-topo-node': 6, 'path.hf-topo-link': 5, '[data-testid="host-fleet-topo-link"][data-live="false"]': 3,
    [link('devbox')]: 'SSH tunnel, 38 ms', [link('__cloudbox__')]: 'Through your cloud companion, 120 ms', [link('homepc')]: 'Not connected', [link('fixture-remote')]: 'Off',
    '[data-mark="cloud"]': 1, '[data-host="__cloudbox__"] [data-mark="cloud"], [data-host="devbox"] [data-mark="phone"]': 2, '[data-host="__local__"] .hf-topo-name': 'This Mac',
  })
  await expect(node('fixture-remote')).toHaveAttribute('data-kind', 'off')
  await expect(node('homepc')).toHaveAttribute('data-kind', 'failed')
  await expect(node('__cloudbox__')).toHaveAttribute('data-kind', 'connected')
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
  // A node takes you to its card (or its Not connected row), in view, focused and ringed; the
  // host switched off, which the Overview leaves out, to its row in the list.
  for (const [h, to] of [['devbox', cardOf(page, 'devbox')], ['homepc', awayOf(page, 'homepc')], ['fixture-remote', row(page, 'fixture-remote')]] as const) {
    await node(h).click()
    await expectRing(page, to)
    await expect(to).toBeInViewport()
  }

  // The dev box's card: what it is, rings (disk too: the share in use, what is free under it; no
  // GPU on it), the last 12 hours (the one online bar broken where it was down or had no link, a
  // chart each), numbers, chips, and its one problem with the fix.
  const dev = cardOf(page, 'devbox')
  await see(dev, {
    '.hf-card-name': 'Big dev box', 'host-fleet-roles': 'Always onWalnut runs here', 'host-fleet-system': /^Debian 12, x64, 32 CPUs, 128 GB/,
    '[data-gauge="cpu"] .hf-gauge-value': '25%', '[data-gauge="mem"] .hf-gauge-value': '25%', '[data-gauge="disk"] .hf-gauge-value': '44%',
    'host-fleet-disk-free': '2.2 TB free', 'host-fleet-gauge': 3, 'host-fleet-spark': 3, '[data-spark="sessions"] .hf-lane-value': /^max \d+$/,
    '[data-testid="host-fleet-sessions"] .hf-big': '19', '[data-testid="host-fleet-spend"] .hf-big': '$1,234',
    '[data-testid="host-fleet-caps"] .hf-chip': ['Docker', '3 MCP servers', 'gpu'],
    '[data-testid="host-fleet-timeline"] i[data-tone="bad"]': 1, '[data-testid="host-fleet-timeline"] i[data-tone="warn"]': 1,
    '.hf-problem-text': "Walnut won't restart on Big dev box after it reboots", 'hf-dash-fix': 'Set up',
  })
  await expect(dev.getByTestId('host-fleet-disk-free')).toHaveAttribute('data-low', 'false')
  await expect(dev.locator('[data-testid="host-fleet-timeline"] i[data-tone="bad"]')).toHaveAttribute('title', /: down \(40 min\)$/)
  expect((await dev.locator('[data-spark="cpu"] .hf-spark-line').getAttribute('d'))!.split('M').filter(Boolean)).toHaveLength(2)
  const problem = dev.getByTestId('hf-dash-problem')
  await expect(problem).toHaveAttribute('data-problem', 'reboot')
  await expect(problem).toHaveAttribute('title', 'does not start by itself after a reboot: nothing on it starts the daemon at boot')
  // This Mac: named as its row and its node name it, its GPU ring and chart, iOS and the browser,
  // its uptime first with one more problem behind it (the laptop verdict), and nothing to fix.
  const mac = cardOf(page, '__local__')
  await see(mac, {
    '.hf-card-name': 'This Mac', 'host-fleet-roles': 'Your main Walnut', '[data-gauge]': 4, '[data-gauge="gpu"] .hf-gauge-value': '18%',
    '[data-gauge="disk"] .hf-gauge-value': '95%', 'host-fleet-disk-free': '50 GB free', '[data-spark]': 4,
    '[data-testid="host-fleet-caps"] .hf-chip': ['iOS simulator', 'Browser', '1 MCP server'], '.hf-problem-text': 'Up 93% of the last 7 days (+1)', 'hf-dash-fix': 0,
  })
  await expect(mac.locator('[data-spark="gpu"]')).toHaveAttribute('title', /^GPU over the last 12 hours/)
  // The cloud box is fine: no problem line.
  await see(cardOf(page, '__cloudbox__'), { 'host-fleet-roles': 'Cloud', 'hf-dash-problem': 0 })

  // The two hosts away: one compact row each, why (the error in its title), Details and Connect.
  const home = awayOf(page, 'homepc')
  await see(home, { '.hf-off-name': 'Home PC', '.hf-off-why': 'Could not reach Home PC', 'hf-dash-details-toggle': 'Details', 'hf-dash-connect': 'Connect' })
  await expect(home.locator('.hf-off-why')).toHaveAttribute('title', 'ssh: connection timed out')
  expect((await home.boundingBox())!.height).toBeLessThan(50)
  const old = awayOf(page, 'olddev')
  // Its whole name is in the row (cut off, it peeks in place on hover: utils/truncation-peek.ts).
  await expect(old.locator('.hf-off-name')).toHaveText(FLEET[2].label)

  // Details, in place: the facts table. Opening them reads that host again (the person is looking
  // at it); closing them reads nothing.
  await expect(dash.getByTestId('host-fleet-details')).toHaveCount(0)
  const devDetails = dev.getByTestId('hf-dash-details-toggle')
  await devDetails.click()
  await expect(devDetails).toHaveAttribute('aria-expanded', 'true')
  await expect(devDetails).toHaveText('Hide details')
  await expect.poll(() => asks).toEqual([['__local__'], ['devbox']])
  await see(dev, { '[data-row="now"] dt': 'Up for', '[data-row="now"] dd': '13 d, load 6.16', '[data-row="daemon"] dt': 'Session helper' })
  await home.getByTestId('hf-dash-details-toggle').click()
  await see(home, { '[data-row="connection"] dd': 'SSH tunnel: Could not reach Home PC (ssh: connection timed out)', 'host-fleet-fit': 0 })
  await old.getByTestId('hf-dash-details-toggle').click()
  await see(old, { '[data-row="now"] dd': 'Its session helper is older than this view (it updates on the next connect)' })
  await expectEveryUnknownSaysWhy(page)
  await expectNoOverflow(page)
  await shot(page, '1-overview-1280', dash)
  for (const l of [dev, home, old]) await l.getByTestId('hf-dash-details-toggle').click()
  await expect(dash.getByTestId('host-fleet-details')).toHaveCount(0)
  expect(asks).toEqual([['__local__'], ['devbox'], ['homepc'], ['olddev']])
  expect(errors).toEqual([])
})

test('a fleet of five, the list: a row per host, the header\'s one count, and Details of live hosts and of the two away', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const { asks } = await openFleet(page)
  // The cached readings at once, with their age; only this computer's, 12 minutes old, is read
  // behind them (no network); no other host is read to show them.
  await see(page, { 'host-fleet-read': 'Read 12 min ago', 'host-fleet-reading': 0 })
  await expect.poll(() => asks).toEqual([['__local__']])
  // The "need a look" count is the header's, the page's one (2026-11-04 review: it scrolled away
  // under the pinned bar after the first press); the Overview's tile says the same number and is
  // no second count to press.
  const needs = page.getByTestId('rh-needs-look')
  await expect(needs).toHaveText('4 need a look')
  await expect(fleetStat(page, 'problems')).toHaveText('4')
  await expect(page.getByTestId('host-fleet-stat-problems').locator('button, [role="button"]')).toHaveCount(0)

  // One row per host in Settings order, each with its one state line, at most one warning and one
  // action: Set up on the dev box; none on a host away with no SSH entry (Retry SSH: the Connect
  // test).
  expect((await aliases(page)).filter((a) => a in STATES)).toEqual(Object.keys(STATES))
  for (const [alias, line] of Object.entries(STATES)) await expect(state(page, alias)).toHaveText(line)
  const dev = row(page, 'devbox')
  // Plain words that name the host (2026-11-04 review: "Daemon does not come back after a reboot").
  await see(dev, { 'rh-row-warning': "Walnut won't restart on Big dev box after it reboots", 'host-fleet-fix': 'Set up' })
  await see(row(page, '__local__'), { '.rh-host-name': 'This Mac', 'rh-row-warning': 'Up 93% of the last 7 days' })
  await see(row(page, '__cloudbox__'), { '.settings-tag': 'Cloud', '.rh-row-line': 0 })
  for (const alias of ['__local__', 'olddev', '__cloudbox__', 'homepc']) await expect(row(page, alias).locator('.rh-row-primary button')).toHaveCount(0)
  // "4 need a look" are those rows, each tagged; a press shows the first in view and keeps the
  // focus on the count, so the next press is right there.
  const marked = await page.locator('[data-testid="remote-hosts-list"] [data-needs-look="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host-alias')!))
  expect(marked.filter((a) => a in STATES)).toEqual(['__local__', 'devbox', 'olddev', 'homepc'])
  await expect(page.locator('[data-testid="remote-hosts-list"] [data-testid="rh-look-tag"]')).toHaveCount(4)
  await needs.click()
  await expect(needs).toHaveText('1 of 4 need a look')
  await expect(row(page, '__local__')).toBeInViewport()
  await expect(needs).toBeFocused()
  await expectEveryUnknownSaysWhy(page) // the Overview and the rows
  // The dev box's Details (its reading, as on its card), closed until asked for: opening them reads that host again.
  await expect(page.getByTestId('rh-details')).toHaveCount(0)
  const d = await openDetails(page, 'devbox')
  await expect.poll(() => asks).toEqual([['__local__'], ['devbox']])
  // One System line, rings (disk too: the share in use, what is free under it; no GPU on it), the
  // last 12 hours (the one online bar, a chart each), numbers, chips and the facts table; each fact
  // once (2026-11-04 review: the system, the reboot warning and the online bar showed two or three
  // times). Its one problem is its row's line, so Details neither says it again nor repeats it in
  // the long-running verdict; the row keeps the one Set up; Walnut on it is a role chip.
  await see(d, {
    'host-fleet-system': /^Debian 12, x64, 32 CPUs, 128 GB/, 'host-system-line': 1, 'host-fleet-roles': 'Always onWalnut runs here', 'host-fleet-read-age': 'Read 12 min ago',
    '[data-gauge="cpu"] .hf-gauge-value': '25%', '[data-gauge="mem"] .hf-gauge-value': '25%', '[data-gauge="disk"] .hf-gauge-value': '44%',
    'host-fleet-disk-free': '2.2 TB free', 'host-fleet-gauge': 3, 'host-fleet-spark': 3, '[data-spark="sessions"] .hf-lane-value': /^max \d+$/,
    '[data-testid="host-fleet-sessions"] .hf-big': '19', '[data-testid="host-fleet-spend"] .hf-big': '$1,234',
    '[data-testid="host-fleet-caps"] .hf-chip': ['Docker', '3 MCP servers', 'gpu'], 'host-fleet-problems': 0, 'host-fleet-fit': 0,
    '[data-row="now"] dt': 'Up for', '[data-row="now"] dd': '13 d, load 6.16',
    '[data-row="server"]': 0, 'host-fleet-days': 0, 'host-fleet-fix': 0,
    // The timeline is broken where it was down (40 min) or had no link.
    '[data-testid="host-fleet-timeline"] i[data-tone="bad"]': 1, '[data-testid="host-fleet-timeline"] i[data-tone="warn"]': 1,
  })
  await expect(d.getByTestId('host-fleet-disk-free')).toHaveAttribute('data-low', 'false')
  // Said once in the list (its Overview card is the other surface: the problem line with Set up).
  await expect(page.getByTestId('remote-hosts-list').getByText("Walnut won't restart on Big dev box after it reboots", { exact: true })).toHaveCount(1)
  await expect(d.locator('[data-testid="host-fleet-timeline"] i[data-tone="bad"]')).toHaveAttribute('title', /: down \(40 min\)$/)
  expect((await d.locator('[data-spark="cpu"] .hf-spark-line').getAttribute('d'))!.split('M').filter(Boolean)).toHaveLength(2)

  // This Mac: it leads, iOS and the browser, a GPU ring and chart, and its laptop verdict (its
  // uptime is its row's line, not said again here).
  const mac = await openDetails(page, '__local__')
  await see(mac, {
    'host-fleet-roles': 'Your main Walnut', '[data-gauge="gpu"] .hf-gauge-value': '18%', '[data-gauge="disk"] .hf-gauge-value': '95%', 'host-fleet-disk-free': '50 GB free',
    '[data-gauge]': 4, '[data-spark]': 4, '[data-testid="host-fleet-caps"] .hf-chip': ['iOS simulator', 'Browser', '1 MCP server'],
    // Its laptop verdict is said once, as the facts' Long jobs row, not again as a problem
    // (2026-11-05 reviews: "not for jobs that must keep running" twice).
    'host-fleet-problem': 0, 'host-fleet-fit': 'Not a good fit: It is a laptop: a job here stops while it sleeps.',
  })
  await expect(mac.locator('[data-spark="gpu"]')).toHaveAttribute('title', /^GPU over the last 12 hours/)
  // The two hosts away: why, with the error; an older daemon's empty reading; each unknown says why.
  // Why it is away, said once in its Details (here its Connection row: this row draws no failure
  // block of its own), and no long-job verdict for a host Walnut cannot reach.
  const home = await openDetails(page, 'homepc')
  await see(home, { '[data-row="connection"] dd': 'SSH tunnel: Could not reach Home PC (ssh: connection timed out)', 'host-fleet-fit': 0 })
  expect(await home.evaluate((el) => (el.textContent!.match(/connection timed out/g) ?? []).length)).toBe(1)
  await expectEveryUnknownSaysWhy(page)
  await see(await openDetails(page, 'olddev'), { '[data-row="now"] dd': 'Its session helper is older than this view (it updates on the next connect)' })
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
  test(`at ${width} px${dark ? ', dark,' : ''} the Overview and the list stay readable: cards wrap, one column of rows, nothing spills, Details and the diagram included`, async ({ page }) => {
    if (dark) await page.emulateMedia({ colorScheme: 'dark' })
    await openFleet(page)
    // Narrowed once open (under 768 px the app's rail folds behind its menu).
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByTestId('host-fleet-topology')).toBeVisible()
    await expect(page.getByTestId('hf-dash-card')).toHaveCount(3)
    // The Overview's Details too: a card's and a Not connected row's.
    for (const l of [cardOf(page, 'devbox'), awayOf(page, 'olddev')]) {
      await l.getByTestId('hf-dash-details-toggle').click()
      await expect(l.getByTestId('host-fleet-details')).toBeVisible()
    }
    await expectNoOverflow(page)
    await expectEveryUnknownSaysWhy(page)
    await shot(page, `2-overview-${width}${dark ? '-dark' : ''}`, page.getByTestId('host-fleet'))
    for (const alias of ['olddev', 'devbox']) {
      await openDetails(page, alias)
      await expectNoOverflow(page)
      await expectEveryUnknownSaysWhy(page)
    }
    // The long label fits its row and its Not connected row (no spill above), its whole name in
    // the text (a cut-off one peeks in place on hover); the diagram scales down, still readable.
    await expect(row(page, 'olddev').locator('.rh-host-name')).toHaveText(FLEET[2].label)
    await expect(awayOf(page, 'olddev').locator('.hf-off-name')).toHaveText(FLEET[2].label)
    expect((await page.locator('[data-testid="host-fleet-topo-link"][data-host="devbox"]').boundingBox())!.height).toBeGreaterThanOrEqual(7)
    // Dark: no dark text left on a dark surface (the diagram's text by its fill).
    const inks = !dark ? [] : await page.locator('#remote-hosts').evaluate((root) => {
      const sel = '.hf-stat-value, .hf-card-name, .hf-problem-text, .hf-off-name, .hf-off-why, .rh-host-name, .rh-row-state, .rh-row-line, .hf-card-sys, .hf-gauge-value, .hf-big, .hf-problem-list li, .hf-chip, .hf-row dd, .hf-topo-name, .hf-topo-label'
      return [...root.querySelectorAll<HTMLElement>(sel)].map((el) => [el.getAttribute('class'), getComputedStyle(el)[el instanceof SVGElement ? 'fill' : 'color']])
    })
    expect(inks.filter(([, ink]) => Math.max(...cssColorToRgba(ink!).slice(0, 3)) < 90)).toEqual([])
    await shot(page, `2-list-${width}${dark ? '-dark' : ''}`, page.getByTestId('remote-hosts-list'))
  })
}

/**
 * The dev box's Set up, answered as `answer` says (refused, checked with nothing changed, set up);
 * the server's cached reading follows what the host answered. `press` holds the answer until the
 * busy words were seen.
 */
async function serveSetUp(page: Page) {
  const base = FLEET[1]
  const fixed = { ...base, daemon: { ...base.daemon, startsAfterReboot: true, bootStart: { mode: 'boot', backend: 'systemd-user', reason: null, checkedAt: NOW, setupRunning: false, setupError: null, next: null }, reboot: 'starts by itself after a reboot (as a systemd user service)' } }
  const unchanged = { ...base, daemon: { ...base.daemon, bootStart: { mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: 'this account cannot start the daemon at boot without root', next: 'recheck' }, reboot: 'does not start by itself after a reboot: this account cannot start the daemon at boot without root' } }
  const ctl = { answer: 'refuse' as 'refuse' | 'unchanged' | 'ok', served: base, hold: Promise.resolve() }
  await page.route('**/api/v1/hosts/devbox/boot-start', async (route) => {
    await ctl.hold
    if (ctl.answer === 'refuse') return route.fulfill({ status: 502, json: { error: 'Walnut could not check Big dev box: ssh: connection reset', code: 'check_failed' } })
    ctl.served = ctl.answer === 'ok' ? fixed : unchanged
    return route.fulfill({ json: { host: ctl.served } })
  })
  await openFleet(page, () => FLEET.map((h) => (h.host === 'devbox' ? ctl.served : h)))
  /** One press of `fix`, held until it shows it waits: Setting up..., disabled, on the dev box's row and card alone. */
  const press = async (fix: Locator, keyboard = false) => {
    let release = () => {}
    ctl.hold = new Promise<void>((r) => { release = r })
    if (keyboard) { await fix.focus(); await page.keyboard.press('Enter') } else await fix.click()
    await expect(fix).toHaveText('Setting up...')
    await expect(fix).toBeDisabled()
    // One Set up for the host, whichever surface pressed it: its row's and its Overview card's
    // say so, and nothing on another host does.
    await expect(row(page, 'devbox').getByTestId('host-fleet-fix')).toHaveText('Setting up...')
    await expect(cardOf(page, 'devbox').getByTestId('hf-dash-fix')).toHaveText('Setting up...')
    await expect(page.getByText('Setting up...', { exact: true })).toHaveCount(2)
    await expect(awayOf(page, 'homepc').getByTestId('hf-dash-connect')).toHaveText('Connect')
    release()
  }
  return { ctl, press }
}

test('Set up: the row waits, then reads as set up; a refusal or a check that changed nothing says so under it', async ({ page }) => {
  const { ctl, press } = await serveSetUp(page)
  const dev = row(page, 'devbox')
  const fix = dev.getByTestId('host-fleet-fix')
  await press(fix)
  await see(dev, { 'host-fleet-action-error': 'Could not set it up: Walnut could not check Big dev box: ssh: connection reset.', 'host-fleet-fix': 'Set up' })
  await expect(fix).toBeEnabled()
  await shot(page, '3-setup-refused', dev)
  ctl.answer = 'unchanged'
  await press(fix)
  await see(dev, { 'host-fleet-action-note': 'Checked just now: does not start by itself after a reboot: this account cannot start the daemon at boot without root.', 'host-fleet-fix': 'Check again', 'host-fleet-action-error': 0 })
  // By the keyboard: the button goes away with the warning, and the focus moves to the row's More.
  ctl.answer = 'ok'
  await press(fix, true)
  await see(dev, { 'host-fleet-action-note': 'Set up: starts by itself after a reboot (as a systemd user service).', 'rh-row-warning': 0, 'host-fleet-fix': 0, 'rh-row-state': DEV_LIVE })
  await expect(dev.getByTestId('rh-row-more')).toBeFocused()
  // Its Overview card read it too: its problem line went.
  await see(cardOf(page, 'devbox'), { 'hf-dash-problem': 0 })
  await shot(page, '4-setup-done', dev)
})

test('Set up from the Overview card: the button waits, then the card reads as set up; a refusal or a check that changed nothing says so on the card', async ({ page }) => {
  const { ctl, press } = await serveSetUp(page)
  const card = cardOf(page, 'devbox')
  const fix = card.getByTestId('hf-dash-fix')
  await expect(fix).toHaveText('Set up', { timeout: 30_000 })
  await press(fix)
  await see(card, { 'hf-dash-action-error': 'Could not set it up: Walnut could not check Big dev box: ssh: connection reset.', 'hf-dash-fix': 'Set up', 'hf-dash-action-note': 0 })
  await expect(fix).toBeEnabled()
  // Its row says the same, in the same words.
  await see(row(page, 'devbox'), { 'host-fleet-action-error': 'Could not set it up: Walnut could not check Big dev box: ssh: connection reset.' })
  await shot(page, '3-card-setup-refused', card)
  ctl.answer = 'unchanged'
  await press(fix)
  await see(card, { 'hf-dash-action-note': 'Checked just now: does not start by itself after a reboot: this account cannot start the daemon at boot without root.', 'hf-dash-action-error': 0, 'hf-dash-fix': 'Check again' })
  ctl.answer = 'ok'
  await press(fix)
  // Set up: the card's problem line goes and it says what was done; its row's warning goes too.
  await see(card, { 'hf-dash-problem': 0, 'hf-dash-action-note': 'Set up: starts by itself after a reboot (as a systemd user service).', 'hf-dash-action-error': 0 })
  await see(row(page, 'devbox'), { 'rh-row-warning': 0, 'host-fleet-fix': 0 })
  // The button went with its line: the focus never falls to the page.
  await expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
  await shot(page, '4-card-setup-done', card)
})

/**
 * Home PC saved as an SSH host, with its live status (the fixture server knows neither), so its
 * row is the editor's with Retry SSH and the Overview has it as a Not connected row with Connect.
 * Its connect is refused while `ctl.refuse`, else it comes up; each answer waits for `ctl.hold`.
 */
async function serveHomePc(page: Page) {
  const ctl = { up: false, upAt: 0, refuse: true, hold: Promise.resolve() }
  const live = () => ({ kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: ctl.upAt, rttMs: 51, error: null })
  serveFleet(page, () => FLEET.map((h) => (ctl.up && h.host === 'homepc' ? { ...h, connection: live(), now: { ...h.now, stale: false, at: ctl.upAt } } : h)))
  const asks = serveRefresh(page)
  const wire = () => ({
    host: 'homepc', label: 'Home PC', hostname: 'homepc.example.test', connected: ctl.up, phase: ctl.up ? 'connected' : 'failed', steps: [], at: Date.now(),
    phaseLabel: ctl.up ? 'Connected' : 'Could not reach Home PC', ...(ctl.up ? {} : { error: 'ssh: connection timed out', kind: 'network' }),
  })
  await page.route('**/api/hosts/status', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { hosts?: Card[] }
    await route.fulfill({ response: res, json: { ...body, hosts: [...(body.hosts ?? []).filter((h) => h.host !== 'homepc'), wire()] } })
  })
  await page.route('**/api/hosts/homepc/connect', async (route) => {
    await ctl.hold
    if (ctl.refuse) return route.fulfill({ status: 409, json: { error: 'Home PC refused the sign-in' } })
    ctl.up = true
    ctl.upAt = Date.now()
    // What the server answers: the host's status now (the store takes it, as from a push).
    return route.fulfill({ json: { ok: true, status: { ...wire(), serverNow: Date.now() } } })
  })
  await openRemoteHosts(page, { ...OWN_HOSTS, homepc: { hostname: 'homepc.example.test', label: 'Home PC', enabled: true } })
  /** One press of `button` (by the keyboard, the focus rule is about it), held until it shows it waits as `busy`. */
  const press = async (button: Locator, busy: string) => {
    let release = () => {}
    ctl.hold = new Promise<void>((res) => { release = res })
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(button).toHaveText(busy)
    await expect(button).toBeDisabled()
    // One attempt for the host, whichever surface asked: its row and its Overview row both wait.
    await expect(row(page, 'homepc').getByTestId('rh-row-connect')).toHaveText('Retrying...')
    await expect(awayOf(page, 'homepc').getByTestId('hf-dash-connect')).toHaveText('Connecting...')
    // While it waits, the focus stays on the page's controls.
    await expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
    release()
  }
  return { ctl, asks, press }
}

/** Home PC came up: a card in the Overview now, the other host away left in Not connected, the numbers and the diagram with it. */
async function expectHomeUp(page: Page) {
  await expect(cardOf(page, 'homepc')).toBeVisible()
  await expect(page.getByTestId('hf-dash-offline')).toHaveCount(1)
  await expect(awayOf(page, 'olddev')).toHaveCount(1)
  await expect(fleetStat(page, 'online')).toHaveText('4/5')
  await expect(page.locator('[data-testid="host-fleet-topo-link"][data-host="homepc"]')).toHaveAttribute('data-live', 'true')
  await expect(state(page, 'olddev')).toHaveText(STATES.olddev) // the other host away stays as it was
}

test('Connect: the row waits, then comes back live; a refusal stays on its row; the focus never falls to the page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  // A clock of its own, so six seconds after the Connect run inside this test.
  await page.clock.install()
  const { ctl, asks, press } = await serveHomePc(page)
  const r = row(page, 'homepc')
  const connect = r.getByTestId('rh-row-connect')
  // An SSH host's retry says it is SSH (2026-11-04 review: two buttons named Retry meant two things).
  await expect(connect).toHaveText('Retry SSH', { timeout: 30_000 })
  const failed = 'Could not connect to Home PC'
  await see(r, { '.settings-tag': 'SSH', 'rh-row-state': failed })
  await press(connect, 'Retrying...')
  // Why, in the words of the button pressed, and what tries again (2026-11-05 review: "Could not retry right now.").
  await see(r, { 'host-fleet-action-error': 'Could not connect: Home PC refused the sign-in. Retry SSH tries again.', 'rh-row-state': failed })
  await expect(connect).toBeEnabled()
  ctl.refuse = false
  await press(connect, 'Retrying...')
  await see(r, { 'rh-row-state': /^Online, 5% CPU/, 'host-fleet-action-note': 'Connected.', 'host-fleet-action-error': 0, 'rh-row-connect': 0 })
  // Its Retry SSH went away with its state: the focus is on the row's More.
  await expect(r.getByTestId('rh-row-more')).toBeFocused()
  await expectHomeUp(page)
  // It came up after its last read: that host alone is read again (this computer's old reading was read on open).
  await expect.poll(() => asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  // A connect reads its host once per link (2026-11-04: the press read it at once, again 5 s
  // later, and the per-link read on top): six seconds on, still no other read of a host.
  await page.clock.runFor(6_000)
  await expect(r.getByTestId('rh-row-state')).toHaveText(/^Online, 5% CPU/)
  expect(asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  await shot(page, '5-connected', r)
})

test('Connect from the Overview: it waits, then the host comes back as a card; a refusal stays on its row, in the list\'s words too', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.install()
  const { ctl, asks, press } = await serveHomePc(page)
  const away = awayOf(page, 'homepc')
  const connect = away.getByTestId('hf-dash-connect')
  await expect(connect).toHaveText('Connect', { timeout: 30_000 })
  await see(away, { '.hf-off-why': 'Could not reach Home PC' })
  await press(connect, 'Connecting...')
  // A refusal stays on its row, saying why; the list's row says it in its own words.
  await see(away, { 'hf-dash-action-error': 'Could not connect: Home PC refused the sign-in.' })
  await expect(connect).toBeEnabled()
  await see(row(page, 'homepc'), { 'host-fleet-action-error': 'Could not connect: Home PC refused the sign-in. Retry SSH tries again.' })
  await shot(page, '5-overview-connect-refused', away)
  ctl.refuse = false
  await press(connect, 'Connecting...')
  await expectHomeUp(page)
  await see(row(page, 'homepc'), { 'rh-row-state': /^Online, 5% CPU/ })
  // The Connect pressed went with its row: the focus never falls to the page.
  await expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
  // The connect read that host again, and only it; six seconds on, still no other read of a host.
  await expect.poll(() => asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  await page.clock.runFor(6_000)
  await expect(cardOf(page, 'homepc')).toBeVisible()
  expect(asks.filter((x) => x?.[0] !== '__local__')).toEqual([['homepc']])
  await shot(page, '5-overview-connected', page.getByTestId('host-fleet'))
})

test('no other host is read while the page is just open; this computer\'s old reading is read once; Details, opening the Overview or Refresh read them', async ({ page }) => {
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
  await see(cardOf(page, 'devbox'), { 'host-fleet-read-age': 'Read 17 min ago' })
  expect(others()).toEqual([])
  // A host's Details read it; the cached read after it finds this computer's reading old again
  // and reads it once more.
  await see(await openDetails(page, 'devbox'), { 'host-fleet-read-age': 'Read 17 min ago' })
  await expect.poll(others).toEqual([['devbox']])
  await expect.poll(local).toBeGreaterThanOrEqual(2)
  // Closing the Overview reads nothing (its head keeps when the hosts were read); opening it
  // reads every host.
  const toggle = page.getByTestId('host-fleet-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('hf-dash-card')).toHaveCount(0)
  await expect(page.getByTestId('host-fleet-read')).toBeVisible()
  expect(others()).toEqual([['devbox']])
  await toggle.click()
  await expect(page.getByTestId('hf-dash-card')).toHaveCount(2)
  await expect.poll(others).toEqual([['devbox'], null])
  // Refresh reads every host.
  await page.getByTestId('host-fleet-refresh').click()
  await expect.poll(others).toEqual([['devbox'], null, null])
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
  // Its Overview card the same.
  const macCard = cardOf(page, '__local__')
  const cardSessions = macCard.getByTestId('host-fleet-sessions')
  await see(macCard, { '[data-testid="host-fleet-sessions"] .hf-big': '4', '[data-num="unknown"]': 0 })
  await expect(cardSessions).toHaveAttribute('data-source', 'host')
  await expect(cardSessions).toHaveAttribute('title', 'Counted by the host 19 min ago (its last reading)')
  // The cloud box runs no sessions of its own: its row and the Overview's count leave them out,
  // and its card says why in words, never a bare "?".
  await expect(fleetStat(page, 'sessions')).toHaveText('4')
  await expect(state(page, '__cloudbox__')).toHaveText('Online, 12% CPU')
  await see(cardOf(page, '__cloudbox__'), { '[data-testid="host-fleet-sessions"] .hf-why': 'the cloud box runs no sessions of its own', '[data-testid="host-fleet-spend"] .hf-why': 'not counted yet' })
  await expectEveryUnknownSaysWhy(page)
  release()
  // The read ends: the open Details, the card and the row show the host's own count, read just now.
  await expect(sessions.locator('.hf-big')).toHaveText('5', { timeout: 15_000 })
  await expect(sessions).toHaveAttribute('title', 'Counted by the host itself')
  await see(mac, { 'host-fleet-read-age': 'Read just now' })
  await see(macCard, { '[data-testid="host-fleet-sessions"] .hf-big': '5', 'host-fleet-read-age': 'Read just now' })
  await expect(cardSessions).toHaveAttribute('title', 'Counted by the host itself')
  await expect(fleetStat(page, 'sessions')).toHaveText('5')
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
  await expect(fleetStat(page, 'online')).toHaveText('2/2')
  await see(page, { 'host-fleet-reading': 0, '.hf-loading': 0 })
  await see(cardOf(page, 'devbox'), { '[data-gauge="cpu"] .hf-gauge-value': '25%', '[data-testid="host-fleet-sessions"] .hf-big': /^\d+$/ })
  release()
  hold = null
  // The server's answer replaces them; three hours old, every value stays, with its age.
  await expect(devState).toHaveText('Online, 61% CPU, 7 sessions', { timeout: 10_000 })
  const devCard = cardOf(page, 'devbox')
  await see(devCard, { '[data-gauge="cpu"] .hf-gauge-value': '61%', '[data-testid="host-fleet-sessions"] .hf-big': '7', 'host-fleet-read-age': 'Read 3 h ago', '[data-num="unknown"]': 0 })
  await expect(devCard.getByTestId('host-fleet-sessions')).toHaveAttribute('title', 'Counted by the host 3 h ago (its last reading)')
  const d = await openDetails(page, 'devbox')
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '61%', '[data-testid="host-fleet-sessions"] .hf-big': '7', 'host-fleet-read-age': 'Read 3 h ago', '[data-num="unknown"]': 0 })
  await expect(d.getByTestId('host-fleet-sessions')).toHaveAttribute('title', 'Counted by the host 3 h ago (its last reading)')
  for (const g of await d.getByTestId('host-fleet-gauge').all()) await expect(g.locator('.hf-gauge-value')).not.toHaveText('?')
  await expectEveryUnknownSaysWhy(page)
  await expect(fleetStat(page, 'sessions')).toHaveText('19')
})

test('a read keeps the old values with ONE "Refreshing..." for the page; each card, row and Details change as its read ends; a failed one says why', async ({ page }) => {
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
  // The old values stay; the Overview's Refresh alone says a read runs (no words per host, on a
  // card or in Details: a card being read only marks its age, data-refreshing).
  await see(page, { 'host-fleet-refresh': 'Refreshing...', 'host-fleet-reading': 0 })
  await expect(page.getByText('Refreshing...', { exact: true })).toHaveCount(1)
  await expect(devState).toHaveText(DEV_LIVE)
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '25%', 'host-fleet-read-age': 'Read 12 min ago' })
  const devCard = cardOf(page, 'devbox')
  await see(devCard, { '[data-gauge="cpu"] .hf-gauge-value': '25%', 'host-fleet-read-age': 'Read 12 min ago' })
  await expect(devCard.getByTestId('host-fleet-read-age')).toHaveAttribute('data-refreshing', 'true')
  await expect(page.getByTestId('hf-dash-card')).toHaveCount(3) // every card stays
  expect(await aliases(page)).toEqual(Object.keys(STATES)) // every row stays
  await shot(page, '6-refreshing', page.getByTestId('remote-hosts-list'))
  // Its read ends: the row and the open Details change in place.
  stage = 'done'
  await expect(devState).toHaveText('Online, 60% CPU, 19 sessions', { timeout: 10_000 })
  await see(d, { '[data-gauge="cpu"] .hf-gauge-value': '60%', 'host-fleet-read-age': 'Read just now', 'host-fleet-read-error': 0 })
  await see(devCard, { '[data-gauge="cpu"] .hf-gauge-value': '60%', 'host-fleet-read-age': 'Read just now', 'host-fleet-read-error': 0 })
  await expect(devCard.getByTestId('host-fleet-read-age')).toHaveAttribute('data-refreshing', 'false')
  await see(page, { 'host-fleet-refresh': 'Refresh', 'host-fleet-read': 'Read just now' })
  // The host that did not answer keeps its card, with one line saying why and how old it is, and
  // no problem line saying the same.
  await see(cardOf(page, '__cloudbox__'), {
    'host-fleet-read-error': 'Could not read it: it did not answer in 25 s. Showing what it read 12 min ago.', 'host-fleet-read-age': 'Read 12 min ago', 'hf-dash-problem': 0,
  })
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

test('a truly first run: the Overview says it is reading, then each card and row as its own read ends', async ({ page }) => {
  let stage = 0 // 0 never read, 1 all being read, 2 the Mac read, 3 all read
  const unread = { readAt: null, refreshing: false, readError: null, readFailedAt: null }
  serveFleet(page, () => FLEET.slice(0, 3).map((h, i) => {
    if (stage === 0) return { ...h, ...unread }
    const read = stage === 3 || (stage === 2 && i === 0)
    return { ...h, ...(read ? { readAt: Date.now(), refreshing: false, readError: null, readFailedAt: null } : { ...unread, refreshing: true }) }
  }), () => stage === 1 || stage === 2)
  const asks = serveRefresh(page, () => { stage = 1 })
  await openRemoteHosts(page)
  // Nothing was ever read: the page reads every host once, on its own, and the Overview says it
  // reads them (the saved host switched off is a row from the start, so its words may differ).
  await expect.poll(() => asks, { timeout: 30_000 }).toEqual([['__local__', 'devbox', 'olddev']])
  await see(page, { 'host-fleet-reading': /^Reading / })
  for (const alias of ['__local__', 'devbox', 'olddev']) await expect(row(page, alias)).toHaveCount(0)
  await expect(page.getByTestId('hf-dash-card')).toHaveCount(0)
  stage = 2
  await expect(state(page, '__local__')).toHaveText(STATES.__local__, { timeout: 10_000 })
  expect((await aliases(page))[0]).toBe('__local__')
  await expect(fleetStat(page, 'online')).toHaveText('1/1')
  await see(page, { 'host-fleet-reading': 'Reading 2 more hosts...' })
  expect(await hostsOf(page.getByTestId('hf-dash-card'))).toEqual(['__local__'])
  await expect(row(page, 'devbox')).toHaveCount(0)
  await shot(page, '8-first-run', page.locator('.rh-page'))
  stage = 3
  await expect(state(page, 'devbox')).toHaveText(DEV_LIVE, { timeout: 10_000 })
  await expect(state(page, 'olddev')).toHaveText(STATES.olddev)
  await see(page, { 'host-fleet-reading': 0, 'hf-dash-card': 2, 'hf-dash-offline': 1 })
  await expect(fleetStat(page, 'online')).toHaveText('2/3')
  expect(asks).toHaveLength(1) // read once, not again on every poll
})

test('a failed read keeps the cards and the rows and says why; the next press recovers', async ({ page }) => {
  let fail: 'none' | 'read' | 'refresh' = 'none'
  await page.route((url) => url.pathname === '/api/v1/hosts', (route) => fail === 'read'
    ? route.fulfill({ status: 500, json: { error: 'host table locked' } })
    : route.fulfill({ json: { hosts: FLEET.slice(0, 2).map((h) => ({ ...h, readAt: Date.now() - 12 * MIN, refreshing: false, readError: null })), checkedAt: NOW, refreshing: false } }))
  await page.route('**/api/v1/hosts/refresh', (route) => fail === 'refresh'
    ? route.fulfill({ status: 503, json: { error: 'Walnut is restarting' } })
    : route.fulfill({ status: 202, json: { started: [], refreshing: [] } }))
  await openRemoteHosts(page)
  const devState = state(page, 'devbox')
  const bad = page.getByTestId('host-fleet').locator('.hf-error')
  // Every card and every row stays, with its last values.
  const kept = async () => {
    await expect(devState).toHaveText(DEV_LIVE)
    expect(await aliases(page)).toEqual(['__local__', 'fixture-remote', 'devbox'])
    expect(await hostsOf(page.getByTestId('hf-dash-card'))).toEqual(['__local__', 'devbox'])
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
  await shot(page, '9-refresh-failed', page.getByTestId('host-fleet'))
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
  // Its Overview card leads the cards, named as its row names it, with its Details in place.
  const first = page.getByTestId('hf-dash-card').first()
  await expect(first).toHaveAttribute('data-host', '__local__')
  await see(first, { '.hf-card-name': 'This Mac', 'host-fleet-read-age': /^Read (just now|\d+ min ago)$/ })
  for (const part of [first.getByTestId('host-fleet-spend'), first.getByTestId('host-fleet-timeline')]) await expect(part).toBeVisible()
  await first.getByTestId('hf-dash-details-toggle').click()
  await expect(first.locator('[data-row="can"]')).toBeVisible()
  await shot(page, '10-fixture-server', page.locator('.rh-page'))
})
