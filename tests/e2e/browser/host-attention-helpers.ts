/**
 * Shared helpers for the specs about where a host or Claude Code problem
 * speaks (host-attention.ts): never a card on the page. What is broken right
 * now is an error: All and the all-errors view of the notification panel lead
 * with the problems block (nfc-problems): this machine's Claude Code notice
 * while it shows, then the Remote hosts problem list, one row per problem host
 * (dense, headline, Retry, Show details and an x that dismisses it), with the
 * feed errors that host caused right under it; the Errors badge counts each of
 * them once. The System section still lists every host once (its Remote hosts
 * block, the inventory, which ignores dismissals and draws no x), a problem
 * host as its row and every other host as a plain status line, and its badge
 * counts git sync and the search index only. A new problem is also a toast
 * (HostProblemNotices). The bell opens the panel on Needs Action when an ask
 * waits, else on All.
 * Host frames and local health are routed client-side (host-problems-helpers.ts),
 * so no remote host is dialed and nothing reaches a real server beyond the
 * fixture; bpSetup lists the routed hosts in the health, as the server lists
 * its configured ones.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import {
  CHAT_VISIBLE_KEY, connected, failed, outdated, setup, signedOut, type HS, type Hosts, type LocalState,
} from './host-problems-helpers'
import { serveNoWaitingApprovals } from './approvals-lock'
import { bell, openBell } from './host-problems-fixture-helpers'
import { presetPanelView } from './todo-panel-helpers'


/**
 * The fixtures/host-problems.json set as client frames, in Settings order:
 * devbox healthy, buildbox claude_outdated (never a problem row), signbox
 * signed out, keybox auth, certbox cert_expired, netbox unreachable (Walnut Health's: never a
 * problems-block row, toast or dot; still a System row).
 */
export function fixtureHosts(): HS[] {
  return [
    connected('devbox', 'Dev box'), outdated('buildbox', 'Build box'), signedOut('signbox', 'Sign box'),
    failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired'), failed('netbox', 'Net box', 'unreachable'),
  ]
}
/**
 * The problems block's order for fixtureHosts(): connect failures first (Settings order), readiness
 * second. Net box is left out: an unreachable host is Walnut Health's (audience.ts
 * hostProblemNeedsYou), so it takes a row only in System and Walnut Health, never here.
 */
export const FIXTURE_ORDER = ['keybox', 'certbox', 'signbox']

/** Every host row of a list as `host|type|kind`. */
export function triples(list: Locator): Promise<string[]> {
  return list.locator('li.hpb-row[data-host]').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-host')}|${e.getAttribute('data-type')}|${e.getAttribute('data-kind')}`))
}
export const hostsOf = (list: Locator): Promise<Array<string | null>> =>
  list.locator('li.hpb-row[data-host]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
export const cardRow = (list: Locator, host: string): Locator => list.locator(`li.hpb-row[data-host="${host}"]`)
/** The System section's Remote hosts block (every configured host once). */
export const systemHosts = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-remote-hosts"]')
/** A problem host's row in the System list (the same row the problems block draws, without its x). */
export const systemHostRow = (page: Page, host: string): Locator => systemHosts(page).locator(`li.hpb-row[data-host="${host}"]`)
/** A host's plain status line in the System list (healthy, disabled, off, connecting, a version floor). */
export const systemHostLine = (page: Page, host: string): Locator => systemHosts(page).locator(`li.nfc-daemon-row[data-host="${host}"]`)
/** Every host the System list names, in its order, row or line. */
export const systemListHosts = (page: Page): Promise<Array<string | null>> =>
  systemHosts(page).locator('ul.nfc-host-list > li[data-host]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
/** The hosts the System list gives a row (a problem), in its order. */
export const systemRowHosts = (page: Page): Promise<Array<string | null>> => hostsOf(systemHosts(page))
/** The problems block leading All and the all-errors view (absent when nothing is broken). */
export const panelProblems = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-problems"]')
/**
 * This machine's Claude Code notice, anywhere in the panel. It renders only in
 * the problems block (All, all errors) while the local notice shows; System
 * never holds it.
 */
export const panelLocalCard = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-local-claude"]')
/** The problems block's Remote hosts list: each host with a problem row (dismissed rows left out). */
export const problemHosts = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-problem-hosts"]')
/** A problem host's row in the problems block. */
export const problemRow = (page: Page, host: string): Locator => problemHosts(page).locator(`li.hpb-row[data-host="${host}"]`)
/** The feed errors a problem host caused, right under its row (one collapsed group). */
export const problemCards = (page: Page, host: string): Locator => problemHosts(page).locator(`li.nfc-problem-cards[data-host-cards="${host}"]`)
/**
 * The hosts the problems block gives a row, in its order: connect failures
 * first, then readiness, each in Settings order (FIXTURE_ORDER).
 */
export const problemRowHosts = (page: Page): Promise<Array<string | null>> => hostsOf(problemHosts(page))
export const toolbarHide = (page: Page): Locator => page.locator('.todo-panel-toolbar .todo-panel-hide')
export const railButton = (page: Page, label: string): Locator =>
  page.locator('.notification-panel .nfc-rail .nfc-rail-btn', { has: page.locator('.nfc-rail-name', { hasText: new RegExp(`^${label}$`) }) })
/** The System rail entry's count: git sync failing and the search index error only (never a host or Claude Code). */
export const systemBadge = (page: Page): Locator => railButton(page, 'System').locator('.nfc-rail-badge')
/** The Errors rail entry's count: the feed's error cards, each problem host, and the local notice while it shows. */
export const errorsBadge = (page: Page): Locator => railButton(page, 'Errors').locator('.nfc-rail-badge')
/**
 * A host problem row anywhere but the notification panel: there is none (no
 * card in the task panel, the Ask Walnut slot or a draft column, 2026-11-16).
 */
export const hostRowsOutsidePanel = (page: Page): Locator => page.locator('li.hpb-row:not(.notification-panel li.hpb-row)')
export const settingsEntry = (page: Page): Locator => page.getByTestId('sidebar-core-app-settings')
export const settingsDot = (page: Page): Locator => settingsEntry(page).locator('.sidebar-host-dot')
export const bellDot = (page: Page): Locator => bell(page).locator('.notification-badge-dot')
export const bellCount = (page: Page): Locator => bell(page).locator('.notification-badge-count')

/**
 * Click `target` for real and sample `selector` in the first animation frame
 * after the click (scheduled from a capture listener, so it runs after React's
 * commit for that click and before the next paint). Returns the sampled count.
 */
export async function countInFirstFrameAfterClick(page: Page, target: Locator, selector: string): Promise<number> {
  await page.evaluate((sel) => {
    const w = window as unknown as { __bpRaf?: number | null }
    w.__bpRaf = null
    document.addEventListener('click', () => {
      requestAnimationFrame(() => { w.__bpRaf = document.querySelectorAll(sel).length })
    }, { capture: true, once: true })
  }, selector)
  await target.click()
  await page.waitForFunction(() => (window as unknown as { __bpRaf?: number | null }).__bpRaf != null)
  return page.evaluate(() => (window as unknown as { __bpRaf: number }).__bpRaf)
}

/** A rail entry, clicked for real (never page.goto); waits for the route. */
export async function goRail(page: Page, id: 'home' | 'notes' | 'settings'): Promise<void> {
  await page.getByTestId(`sidebar-core-app-${id}`).click()
  const path = id === 'home' ? /\/(\?.*)?$/ : new RegExp(`/${id}`)
  await expect(page).toHaveURL(path)
  if (id === 'home') await expect(page.locator('.main-page')).toBeVisible({ timeout: 20_000 })
}

export type CloseWay = 'escape' | 'backdrop' | 'close' | 'bell'
/** Close the notification panel one of the four ways a person does. */
export async function closePanel(page: Page, how: CloseWay): Promise<void> {
  if (how === 'escape') await page.keyboard.press('Escape')
  else if (how === 'backdrop') {
    const box = (await page.locator('.notification-panel').boundingBox())!
    const vp = page.viewportSize()!
    // A backdrop point to the right of the panel, clear of it.
    await page.mouse.click(Math.min(vp.width - 10, box.x + box.width + 40), Math.round(vp.height / 2))
  } else if (how === 'close') await page.locator('.notification-panel .notification-panel-close').click()
  else {
    // The bell again, where a person clicks it (the backdrop lies over the rail while the panel is open).
    const b = (await bell(page).boundingBox())!
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  }
  await expect(page.locator('.notification-panel')).toHaveCount(0)
}

/** A pending ask (a permission request) as the notifications feed carries it. */
export function askRecord(i: number, t = Date.now()): Record<string, unknown> {
  return {
    id: `bp-ask-${i}`, kind: 'permission', severity: 'warning', title: 'Bash', body: `BP pending ask ${i}`,
    timestamp: t - 30_000 + i, read: false, dedupKey: `perm:bp-r${i}`, requestId: `bp-r${i}`, toolName: 'Bash', sessionId: `bp-s${i}`,
  }
}
/** A connect error event about one host (two share a cause key, so the Errors pane groups them). */
export function hostErrorRecord(host: string, i: number, t = Date.now()): Record<string, unknown> {
  return {
    id: `bp-herr-${host}-${i}`, kind: 'operation-error', needsYou: 'own-action', severity: 'error', title: `Session failed to start ${i}`,
    body: `ssh: connect to host ${host}.example.com: certificate expired`, timestamp: t - 20_000 + i, read: false,
    dedupKey: `error:bp-${host}-${i}`, recoveryKey: `host:${host}:${i}`, causeKey: `host:${host}`, category: 'Sessions',
  }
}

/**
 * Serve what the bell counts, without touching the live socket: the notifications feed (asks,
 * error events) and the approval requests (no pending one). The fixture server holds every
 * notice and approval an earlier spec on it left, so a test that reads the bell's number or
 * name, or the Errors count, serves its page these (2026-11-16 CI: HD-8 and C67 read
 * "Notifications, 191 waiting; ..." for their hosts only).
 */
export async function seedFeed(page: Page, feed: Array<Record<string, unknown>>): Promise<void> {
  await page.route('**/api/notifications', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { feed, unreadCount: feed.filter((f) => !f.read).length } })
    : route.fallback())
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await serveNoWaitingApprovals(page)
}

/**
 * End the user's Quiet on the fixture server. Quiet is server state, so every later spec on
 * that server reads it (no dot, a "Quiet" bell name). Call it from test.afterEach: a hook runs
 * after a failure or a timeout too, where a finally inside the test may wait on a closed page.
 */
export async function endServerQuiet(request: APIRequestContext): Promise<void> {
  const res = await request.put('/api/quiet', { data: { on: false } })
  expect(res.ok(), `end quiet: ${res.status()}`).toBe(true)
}

export interface BpOptions {
  hosts?: HS[]
  local?: LocalState
  feed?: Array<Record<string, unknown>>
  /** Before the load: a layout or a style (slotLayout, bareLayout...). */
  before?: (page: Page) => Promise<void>
  /** Open the All section and the All project, so task rows (.todo-panel-item) exist. */
  allTasks?: boolean
  /** List the routed hosts in the health, so System names them (default true). */
  listHosts?: boolean
}

/**
 * git-sync reads healthy, so the bell's older system dot (hasIssues) never mixes into a host or
 * local reason. It is also a backup that RUNS: a test server runs none (`off: 'test'`), and its
 * System section then shows no Data Backup card (NotificationSystemPane.tsx), so a spec that reads
 * that card routes this first.
 */
export async function healthyGitSync(page: Page): Promise<void> {
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: true, consecutiveFailures: 0 } }))
}

/** Home with the routed hosts and health, prefs isolated, optional feed and probe. */
export async function bpSetup(page: Page, opts: BpOptions = {}): Promise<Hosts> {
  await healthyGitSync(page)
  await seedFeed(page, opts.feed ?? [])
  if (opts.allTasks) await presetPanelView(page)
  if (opts.before) await opts.before(page)
  // The layout these specs measure: the task panel with the Ask Walnut slot hidden. A browser
  // that never chose opens the slot since 2026-10-21 (HOME_CHAT_VISIBLE_DEFAULT), which narrows
  // the task panel and covers it on a phone. Absent-only, so a `before` that picks a layout wins.
  await page.addInitScript((c) => { if (localStorage.getItem(c) === null) localStorage.setItem(c, 'false') }, CHAT_VISIBLE_KEY)
  const h = await setup(page, opts.hosts ?? fixtureHosts(), opts.local, { listHosts: opts.listHosts ?? true })
  return h
}

/** Pick a rail section with a real click and wait until it is the current one. */
export async function pickRail(page: Page, label: string): Promise<void> {
  await railButton(page, label).click()
  await expect(railButton(page, label)).toHaveAttribute('aria-current', 'page')
}

/**
 * Open the bell, then the System section with a real click (the bell lands on
 * All or Needs Action, never on System); returns its Remote hosts block.
 */
export async function openSystemHosts(page: Page): Promise<Locator> {
  await openBell(page)
  const system = railButton(page, 'System')
  if (await system.getAttribute('aria-current') !== 'page') await system.click()
  await expect(system).toHaveAttribute('aria-current', 'page')
  await expect(systemHosts(page)).toBeVisible({ timeout: 20_000 })
  return systemHosts(page)
}

/**
 * Open the bell with no ask waiting: the panel lands on All, whose first block
 * is the problems block; returns its Remote hosts list.
 */
export async function openProblems(page: Page): Promise<Locator> {
  await openBell(page)
  await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
  await expect(problemHosts(page)).toBeVisible({ timeout: 20_000 })
  return problemHosts(page)
}

/** Box gap between two elements (0 when they touch or overlap). */
export function boxGap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
  return Math.hypot(dx, dy)
}

/**
 * Open a host row's details. A dense row starts closed (headline + primary
 * action, BP-R3-N1), so its secondary actions (Open Settings) and its hint
 * are one Show details away.
 */
export async function openRow(r: Locator): Promise<void> {
  if (await r.evaluate((e) => e.classList.contains('hpb-open'))) return
  await r.getByRole('button', { name: 'Show details' }).click()
  await expect(r).toHaveClass(/hpb-open/)
}
