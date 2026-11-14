/**
 * A found host Walnut cannot add is never a "Your other computers" block on Home: its one entry is
 * in Notifications (src/core/hosts/found-host-alert.ts, found-host-offer.ts). 2026-11-13, the user,
 * of a Mac from his ~/.ssh/config that read "Could not connect" on Home after every reload: "I
 * don't want it keep showing ... Just show it inside notification is fine".
 *
 *   mac    the ssh config holds a Mac alias (studio-mac, merged as a found host waiting for the
 *          yes). Connect is answered the way the server answers it: the SSH probe says Darwin
 *          (not_linux), the server marks the row (not_offered, off), drops its status and raises
 *          one entry. Home shows no row for it, the bell holds one entry, x dismisses it, and a
 *          reload shows neither the block nor a second entry.
 *   twin   a found host that is the machine already joined with a link (not_offered:
 *          same_machine) is never asked; another found host still is.
 *
 * The fixture server reads no real ~/.ssh/config, so its merged rows are laid over GET /api/config
 * here, with the host statuses, the found answer, the notification feed and the server's pushes;
 * nothing reaches its config or dials a host. page.goto only loads the app.
 * WebKit is not needed (no engine-dependent behavior): Chromium.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import { dropFakes } from './route-teardown'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-found-host-not-offered'
const MAC = 'a'.repeat(64)
const NOT_LINUX = 'studio-mac runs Darwin: Walnut sets up SSH hosts on Linux only'

type Row = Record<string, unknown>
interface Fake {
  hosts: Record<string, Row>
  net: Row
  statuses: Record<string, Row>
  feed: Row[]
  answers: Array<{ host: string; answer: string }>
  dismissed: string[]
  socket?: WebSocketRoute
}

const statusOf = (host: string, over: Row = {}): Row => ({
  host, label: host, hostname: `${host}.example.test`, connected: false, phase: 'idle', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(), ...over,
})

/** The entry the server raises for a found host that is not Linux (found-host-alert.ts notLinuxCard). */
const notLinuxEntry = (alias: string): Row => ({
  id: `found-host-${alias}`, kind: 'operation-error', severity: 'warning',
  title: `${alias} cannot be added over SSH`,
  body: `${alias} is a Mac, and Walnut adds only Linux machines from your SSH config. To add it, open Settings › Remote Hosts › Add host › Join a machine with a link, and run its one command on ${alias}. Walnut will not try it over SSH again.`,
  timestamp: Date.now(), read: false, dedupKey: `found-host:${alias}`, recoveryKey: `host:${alias}`,
  category: 'Sessions', host: alias, action: { label: 'Open Remote Hosts', to: '/settings#remote-hosts' },
})

function push(fake: Fake, name: string, data: unknown): void {
  expect(fake.socket, 'the SPA socket is connected').toBeDefined()
  fake.socket!.send(JSON.stringify({ type: 'event', name, data, seq: Date.now() }))
}

async function serve(page: Page, hosts: Record<string, Row>, net: Row = { enabled: true }): Promise<Fake> {
  const fake: Fake = { hosts, net, statuses: {}, feed: [], answers: [], dismissed: [] }
  await page.route('**/api/ui-prefs', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { prefs: {} } : { ok: true } }))
  await page.route((url) => url.pathname === '/api/config', async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts: structuredClone(fake.hosts), net: fake.net } } })
  })
  await page.route((url) => url.pathname === '/api/hosts/status', (route) => route.fulfill({ json: { hosts: Object.values(fake.statuses) } }))
  await page.route((url) => url.pathname === '/api/notifications', (route) =>
    route.fulfill({ json: { feed: fake.feed, unreadCount: fake.feed.filter((n) => !n.read).length } }))
  await page.route((url) => url.pathname === '/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route((url) => url.pathname === '/api/notifications/dismiss', async (route) => {
    const { dedupKeys } = route.request().postDataJSON() as { dedupKeys: string[] }
    fake.dismissed.push(...dedupKeys)
    fake.feed = fake.feed.filter((n) => !dedupKeys.includes(n.dedupKey as string))
    await route.fulfill({ json: { unreadCount: 0, removed: dedupKeys.length } })
  })
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])
    const { answer } = route.request().postDataJSON() as { answer: string }
    fake.answers.push({ host, answer })
    fake.hosts[host] = { ...fake.hosts[host], connect: answer, enabled: answer === 'yes' }
    fake.statuses[host] = statusOf(host, answer === 'yes' ? { phase: 'ssh', phaseLabel: 'Connecting over SSH' } : { phase: 'off' })
    await route.fulfill({ json: { ok: true, host, answer, status: fake.statuses[host] } })
  })
  // The server's own pushes of these are held back: the test sends the ones it means.
  await page.routeWebSocket('**/ws*', (ws) => {
    fake.socket = ws
    const server = ws.connectToServer()
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as { type?: string; name?: string }
      if (frame.type !== 'event' || !['config:changed', 'host:status', 'notification:new', 'notification:updated'].includes(frame.name ?? '')) ws.send(message)
    })
  })
  return fake
}

/** What the server does after the SSH probe of studio-mac named Darwin (found-host-alert.ts). */
function probeSaysDarwin(fake: Fake, host: string): void {
  fake.statuses[host] = statusOf(host, { phase: 'failed', kind: 'not_linux', error: NOT_LINUX, retryable: false })
  push(fake, 'host:status', fake.statuses[host])
  fake.hosts[host] = { ...fake.hosts[host], enabled: false, not_offered: { reason: 'not_linux', os: 'Darwin', at: new Date().toISOString() } }
  // Off now: its status leaves every surface (pushHostRemoved), and the entry is raised once.
  delete fake.statuses[host]
  push(fake, 'host:status', { host, removed: true, at: Date.now(), serverNow: Date.now() })
  const entry = notLinuxEntry(host)
  fake.feed.push(entry)
  push(fake, 'config:changed', { key: 'hosts' })
  push(fake, 'notification:new', entry)
}

const prompts = (page: Page) => page.getByTestId('found-host-prompts')
const row = (page: Page, host: string) => prompts(page).locator(`li[data-host="${host}"]:not(.found-host-not-now)`)
const panel = (page: Page) => page.locator('.notification-panel')
const entry = (page: Page, title: string) => panel(page).locator('.notification-feed-item').filter({ has: page.locator('.notification-feed-item-title', { hasText: title }) })

async function openHome(page: Page, fake: Fake): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => !!fake.socket, { timeout: 60_000 }).toBe(true)
}

async function reloadHome(page: Page, fake: Fake): Promise<void> {
  const previous = fake.socket
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => !!fake.socket && fake.socket !== previous, { timeout: 60_000 }).toBe(true)
}

test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }) })
test.afterEach(async ({ page }) => { await dropFakes(page) })

test('a Mac from the ssh config leaves Home after its first not-Linux answer and is one dismissable Notifications entry', async ({ page }) => {
  const fake = await serve(page, {
    'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'ask', enabled: false },
    labbox: { hostname: 'labbox.example.test', discovered: true, connect: 'ask', enabled: false },
  })
  await openHome(page, fake)
  await expect(row(page, 'studio-mac')).toContainText('Connect to studio-mac?', { timeout: 30_000 })
  await row(page, 'studio-mac').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(() => fake.answers).toEqual([{ host: 'studio-mac', answer: 'yes' }])
  // Connecting shows in the background connect card, never as a row here.
  await expect(row(page, 'studio-mac')).toHaveCount(0)

  probeSaysDarwin(fake, 'studio-mac')
  await expect(row(page, 'studio-mac')).toHaveCount(0)
  await expect(prompts(page).getByText(/Could not connect|is not a Linux machine|Try again/)).toHaveCount(0)
  // The other found host is still a real choice.
  await expect(row(page, 'labbox')).toContainText('Connect to labbox?')
  await page.screenshot({ path: `${SHOTS}/home-after-not-linux.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })

  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(panel(page)).toBeVisible()
  const mac = entry(page, 'studio-mac cannot be added over SSH')
  await expect(mac).toHaveCount(1)
  await expect(mac).toContainText('Join a machine with a link')
  // The person fixes this one (a join link), so the card offers its own way, not an agent repair.
  await expect(mac.getByTestId('nfc-producer-action')).toHaveText(/Open Remote Hosts/)
  await expect(mac.getByTestId('nfc-fix-start')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/notification-entry.png` })
  await mac.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(mac).toHaveCount(0)
  expect(fake.dismissed).toEqual(['found-host:studio-mac'])

  // A reload: no block for it, no second entry, and nothing asked about it.
  await reloadHome(page, fake)
  await expect(row(page, 'labbox')).toContainText('Connect to labbox?', { timeout: 30_000 })
  await expect(row(page, 'studio-mac')).toHaveCount(0)
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(panel(page)).toBeVisible()
  await expect(entry(page, 'studio-mac cannot be added over SSH')).toHaveCount(0)
  expect(fake.answers).toEqual([{ host: 'studio-mac', answer: 'yes' }])
})

test('a found host that is the machine already joined with a link is never asked', async ({ page }) => {
  const fake = await serve(page, {
    'studio-alias': {
      hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'ask', enabled: false,
      not_offered: { reason: 'same_machine', same_as: 'Studio-MacBook', at: '2026-11-13T10:00:00.000Z' },
    },
    'Studio-MacBook': { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true },
    labbox: { hostname: 'labbox.example.test', discovered: true, connect: 'ask', enabled: false },
  })
  fake.statuses['Studio-MacBook'] = statusOf('Studio-MacBook', {
    hostname: 'Studio-MacBook.walnut-net.invalid', connected: true, phase: 'connected', connectedAt: Date.now(),
    readiness: { checkedAt: Date.now(), problems: [] },
  })
  await openHome(page, fake)
  await expect(row(page, 'labbox')).toContainText('Connect to labbox?', { timeout: 30_000 })
  await expect(row(page, 'studio-alias')).toHaveCount(0)
  await reloadHome(page, fake)
  await expect(row(page, 'labbox')).toBeVisible({ timeout: 30_000 })
  await expect(row(page, 'studio-alias')).toHaveCount(0)
  // The joined machine turned off: the found row is that machine no more, and is asked again.
  fake.hosts['Studio-MacBook'] = { ...fake.hosts['Studio-MacBook'], enabled: false }
  push(fake, 'config:changed', { key: 'hosts' })
  await expect(row(page, 'studio-alias')).toContainText('Connect to studio-alias?')
  expect(fake.answers).toEqual([])
})
