/**
 * Shared helpers for the banner-placement specs (BP-C<n>): the attention card
 * lives in the task panel on Home (data-mount="tasks") and falls back to the
 * slot or the draft column only while the task panel is hidden. The
 * notification panel never holds the card: its System section lists every
 * host once (the Remote hosts block), a problem host as the Home card's own
 * row (dense, same headline, buttons and Show details, no x), every other host
 * as a plain status line. The bell opens the panel on Needs Action when an ask
 * waits, else on System when no in-page card covers the problem (/notes, a
 * hidden task panel), else on All. Host frames and local health are routed
 * client-side (host-problems-helpers.ts), so no remote host is dialed and
 * nothing reaches a real server beyond the fixture; bpSetup lists the routed
 * hosts in the health, as the server lists its configured ones.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type Locator, type Page } from '@playwright/test'
import {
  anyBanner, banner, connected, failed, outdated, setup, signedOut, type HS, type Hosts, type LocalState,
} from './host-problems-helpers'
import { bell, openBell, panelBanner } from './host-problems-fixture-helpers'
import { presetPanelView } from './todo-panel-helpers'

export const BP_SHOTS = '/tmp/walnut-banner-placement/shots'

/**
 * The fixtures/host-problems.json set as client frames, in Settings order:
 * devbox healthy, buildbox claude_outdated (never a banner row), signbox
 * signed out, keybox auth, certbox cert_expired, netbox unreachable.
 */
export function fixtureHosts(): HS[] {
  return [
    connected('devbox', 'Dev box'), outdated('buildbox', 'Build box'), signedOut('signbox', 'Sign box'),
    failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired'), failed('netbox', 'Net box', 'unreachable'),
  ]
}
/** The model's order for fixtureHosts(): connect failures first (Settings order), readiness second. */
export const FIXTURE_ORDER = ['keybox', 'certbox', 'netbox', 'signbox']

/** Every host row of a card as `host|type|kind` (undo rows carry no data-host). */
export function triples(card: Locator): Promise<string[]> {
  return card.locator('li.hpb-row[data-host]').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-host')}|${e.getAttribute('data-type')}|${e.getAttribute('data-kind')}`))
}
export const hostsOf = (card: Locator): Promise<Array<string | null>> =>
  card.locator('li.hpb-row[data-host]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
export const cardRow = (card: Locator, host: string): Locator => card.locator(`li.hpb-row[data-host="${host}"]`)
/** The System section's Remote hosts block (every configured host once). */
export const systemHosts = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-remote-hosts"]')
/** A problem host's row in the System list: the Home card's row for that host. */
export const systemHostRow = (page: Page, host: string): Locator => systemHosts(page).locator(`li.hpb-row[data-host="${host}"]`)
/** A host's plain status line in the System list (healthy, disabled, off, connecting, a version floor). */
export const systemHostLine = (page: Page, host: string): Locator => systemHosts(page).locator(`li.nfc-daemon-row[data-host="${host}"]`)
/** Every host the System list names, in its order, row or line. */
export const systemListHosts = (page: Page): Promise<Array<string | null>> =>
  systemHosts(page).locator('ul.nfc-host-list > li[data-host]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
/** The hosts the System list gives a row (a problem), in its order. */
export const systemRowHosts = (page: Page): Promise<Array<string | null>> => hostsOf(systemHosts(page))
/** This machine's Claude Code notice at the top of System (only while the local notice shows). */
export const systemLocalCard = (page: Page): Locator => page.locator('.notification-panel [data-testid="nfc-local-claude"]')
export const toolbarHide = (page: Page): Locator => page.locator('.todo-panel-toolbar .todo-panel-hide')
export const railButton = (page: Page, label: string): Locator =>
  page.locator('.notification-panel .nfc-rail .nfc-rail-btn', { has: page.locator('.nfc-rail-name', { hasText: new RegExp(`^${label}$`) }) })
/** The System rail entry's count (git sync, the search index, each problem host, the local notice). */
export const systemBadge = (page: Page): Locator => railButton(page, 'System').locator('.nfc-rail-badge')
/** Any attention mount inside the notification panel: there is none on any section. */
export const panelMount = (page: Page): Locator => page.locator('.notification-panel .ab-mount')
export const settingsEntry = (page: Page): Locator => page.getByTestId('sidebar-core-app-settings')
export const settingsDot = (page: Page): Locator => settingsEntry(page).locator('.sidebar-host-dot')
export const bellDot = (page: Page): Locator => bell(page).locator('.notification-badge-dot')
export const bellCount = (page: Page): Locator => bell(page).locator('.notification-badge-count')

/**
 * Record the most attention cards ever in the DOM at once (window.__bpMax),
 * checked on every mutation from the first script on. Call before the first load.
 */
export async function installMaxCardsProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __bpMax: number; __bpNow: () => number }
    w.__bpMax = 0
    w.__bpNow = () => document.querySelectorAll('[data-testid="attention-banner"]').length
    const check = () => { const n = w.__bpNow(); if (n > w.__bpMax) w.__bpMax = n }
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid', 'data-mount'] })
  })
}
export const maxCards = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __bpMax: number }).__bpMax)

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
    id: `bp-herr-${host}-${i}`, kind: 'operation-error', severity: 'error', title: `Session failed to start ${i}`,
    body: `ssh: connect to host ${host}.example.com: certificate expired`, timestamp: t - 20_000 + i, read: false,
    dedupKey: `error:bp-${host}-${i}`, recoveryKey: `host:${host}:${i}`, causeKey: `host:${host}`, category: 'Sessions',
  }
}

/** Serve the notifications feed (asks, error events) without touching the live socket. */
export async function seedFeed(page: Page, feed: Array<Record<string, unknown>>): Promise<void> {
  await page.route('**/api/notifications', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { feed, unreadCount: feed.filter((f) => !f.read).length } })
    : route.fallback())
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
}

export interface BpOptions {
  hosts?: HS[]
  local?: LocalState
  feed?: Array<Record<string, unknown>>
  /** Record the most cards ever on the page at once (maxCards). */
  probe?: boolean
  /** Before the load: a layout or a style (slotLayout, bareLayout...). */
  before?: (page: Page) => Promise<void>
  /** Open the All section and the All project, so task rows (.todo-panel-item) exist. */
  allTasks?: boolean
  /** List the routed hosts in the health, so System names them (default true). */
  listHosts?: boolean
}

/** git-sync reads healthy, so the bell's older system dot (hasIssues) never mixes into a host or local reason. */
export async function healthyGitSync(page: Page): Promise<void> {
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: true, consecutiveFailures: 0 } }))
}

/** Home with the routed hosts and health, prefs isolated, optional feed and probe. */
export async function bpSetup(page: Page, opts: BpOptions = {}): Promise<Hosts> {
  await healthyGitSync(page)
  if (opts.probe) await installMaxCardsProbe(page)
  if (opts.feed) await seedFeed(page, opts.feed)
  if (opts.allTasks) await presetPanelView(page)
  if (opts.before) await opts.before(page)
  const h = await setup(page, opts.hosts ?? fixtureHosts(), opts.local, { listHosts: opts.listHosts ?? true })
  return h
}

/** The card is in the task panel, the only one on the page, with the fixture's rows. */
export async function expectTasksCard(page: Page, order: string[] = FIXTURE_ORDER): Promise<void> {
  await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
  await expect(anyBanner(page)).toHaveCount(1)
  await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(order)
}

/** Pick a rail section with a real click and wait until it is the current one. */
export async function pickRail(page: Page, label: string): Promise<void> {
  await railButton(page, label).click()
  await expect(railButton(page, label)).toHaveAttribute('aria-current', 'true')
}

/**
 * Open the bell, then the System section with a real click unless the panel
 * already landed there; returns its Remote hosts block. No card in the panel.
 */
export async function openSystemHosts(page: Page): Promise<Locator> {
  await openBell(page)
  const system = railButton(page, 'System')
  if (await system.getAttribute('aria-current') !== 'true') await system.click()
  await expect(system).toHaveAttribute('aria-current', 'true')
  await expect(systemHosts(page)).toBeVisible({ timeout: 20_000 })
  await expect(panelBanner(page)).toHaveCount(0)
  return systemHosts(page)
}

export interface CardPlace { y: number; height: number }
/** Mark the Home card's node (a remount is a new node and loses the mark); returns its place. */
export async function markHomeCard(page: Page): Promise<CardPlace> {
  await banner(page).evaluate((el) => { el.setAttribute('data-bp-mark', 'kept') })
  const b = (await banner(page).boundingBox())!
  return { y: b.y, height: b.height }
}
/** The Home card is the node markHomeCard marked, in the same place at the same height. */
export async function expectHomeCardStill(page: Page, before: CardPlace, label = ''): Promise<void> {
  await expect(banner(page), `${label}: the Home card`).toHaveCount(1)
  await expect(banner(page), `${label}: the same node`).toHaveAttribute('data-bp-mark', 'kept')
  await expect(anyBanner(page), `${label}: one card`).toHaveCount(1)
  const b = (await banner(page).boundingBox())!
  expect(Math.abs(b.y - before.y), `${label}: card top`).toBeLessThanOrEqual(1)
  expect(Math.abs(b.height - before.height), `${label}: card height`).toBeLessThanOrEqual(1)
}

/** Box gap between two elements (0 when they touch or overlap). */
export function boxGap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
  return Math.hypot(dx, dy)
}

/**
 * Open a card row's details. With more than one entry every row starts closed
 * (dense: headline + primary action, BP-R3-N1), so its secondary actions
 * (Open Settings) and its hint are one Show details away.
 */
export async function openRow(r: Locator): Promise<void> {
  if (await r.evaluate((e) => e.classList.contains('hpb-open'))) return
  await r.getByRole('button', { name: 'Show details' }).click()
  await expect(r).toHaveClass(/hpb-open/)
}
