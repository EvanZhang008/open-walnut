/**
 * Phones & Cloud's third tab is the tunnel, by its own name from the first frame (2026-11-18,
 * the user: "why this was browser link before and only after some time become <the tunnel
 * plugin> ... browser link is very confusing ... under general tab show the replica server we
 * have, but mostly you should show <the tunnel plugin> if it is installed"):
 *
 *   1. With a plugin tunnel, the tab never shows a name it then changes: a blank placeholder until
 *      the first answer (a browser that never saw it), the kept name at once afterwards, and a
 *      plugin still loading after a restart keeps the placeholder, never "Tunnel".
 *   2. The tab and its intro say the tunnel's name, never "browser link"; where it runs is the
 *      host's name the person gave it.
 *   3. "Your Walnut runs on", above the tabs, names this Mac, the companion, and an always-on host
 *      listed in config.yaml twice (named, and found in ~/.ssh/config, carrying the tunnel) once;
 *      it opens the host row whose server it is. All devices keeps phones, browsers and the
 *      extension; this Mac's own link and simulators are in Settings > Advanced.
 *
 * Every label the tab ever painted is recorded by a MutationObserver (it runs before the frame is
 * painted), so a flash of another name fails the test. The list, the tunnel's state and the host
 * servers are page.route fixtures with neutral names, shaped as the user's own; navigation is by
 * clicks.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/tunnel-tab-name'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const ACME = { id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [] }
const COMMAND = { id: 'command', title: 'Custom command', owner: 'core', options: [] }
const TUNNEL_URL = 'https://someone-devbox.acme-tunnel.example'

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

interface ExposeControl {
  /** The next answers wait for this (a slow first read). */
  hold?: Promise<void>
  /** Leave the plugin's provider out (it is still loading after a restart). */
  pluginLoading?: boolean
}

function exposeBody(ctl: ExposeControl) {
  return {
    status: {
      enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: Date.now(), url: TUNNEL_URL,
      runsOn: { hostKey: 'devbox-ssh', label: 'Big dev box', auto: true },
    },
    providers: ctl.pluginLoading ? [COMMAND] : [ACME, COMMAND],
    places: [{ id: 'devbox-ssh', label: 'Big dev box', alwaysOn: true }, { id: 'here', label: 'This computer', alwaysOn: false }],
    settings: { enabled: true, provider: 'acme-tunnel', runOn: null, placedOn: 'devbox-ssh', options: {} },
  }
}

const copies = { sessions: true, requests: true, boards: true, inbox: true, inbox_bodies: true, routines: true }
const off = { enabled: false, provider: null, options: {} }
const serverView = (hostKey: string) => ({
  hostKey, enabled: true, phase: 'running', since: Date.now() - 3_600_000, port: 42578,
  server: { route: { kind: 'leader' }, version: '0.6.34', expose: { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: Date.now(), url: TUNNEL_URL } },
})
/** The user's shape: the named row runs a server, its found twin carries the tunnel, other hosts run none. */
const HOST_SERVERS = {
  hosts: [
    { hostKey: 'devbox', label: 'Big dev box', settings: { enabled: true, expose: off, copies }, view: serverView('devbox') },
    { hostKey: 'oldbox', label: 'Old small box', settings: { enabled: false, expose: off, copies }, view: { hostKey: 'oldbox', enabled: false, phase: 'off', since: 0, server: null } },
    { hostKey: 'devbox-ssh', label: 'devbox-ssh', settings: { enabled: true, carriesTunnel: true, expose: off, copies }, view: serverView('devbox-ssh'), knownAs: { hostKey: 'devbox', label: 'Big dev box' } },
  ],
  providers: [ACME],
}

async function mockAll(page: Page, ctl: ExposeControl, opts: { simulators?: number } = {}) {
  const sims = Array.from({ length: opts.simulators ?? 0 }, (_, i) => ({ name: `sim-${i + 1}`, createdAt: ago(5000 + i), role: 'simulator' }))
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, { installed: false, running: false, peers: [], install: { brew: false, job: null } }))
  await page.route((url) => url.pathname === '/api/devices', (route) => json(route, {
    devices: [
      { name: 'pocket-phone', createdAt: ago(600), role: 'phone', adoptedFrom: 'cloud' },
      { name: 'browser-1a2b3c', createdAt: ago(9000), lastUsedAt: ago(100), role: 'browser' },
      ...sims,
    ],
    cloudDevices: [{ name: 'pocket-phone', createdAt: ago(600), lastUsedAt: ago(2), role: 'phone' }, { name: 'this-mac', createdAt: ago(20000), role: 'self' }],
    targets: [LAN, CLOUD],
    tailscale: { installed: false, running: false },
  }))
  await page.route((url) => url.pathname === '/api/expose', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (ctl.hold) await ctl.hold
    return json(route, exposeBody(ctl))
  })
  await page.route((url) => url.pathname === '/api/host-servers', (route) => json(route, HOST_SERVERS))
}

/** Records every label the tunnel's tab paints, from the first frame of each document. */
async function recordTabLabels(page: Page) {
  await page.addInitScript(() => {
    const labels: string[] = []
    ;(window as unknown as { __tunnelLabels: string[] }).__tunnelLabels = labels
    const look = () => {
      const label = document.querySelector('[data-testid="pc-tab-devices-browser"] .pc-tab-label')
      if (!label) return
      const text = label.classList.contains('pc-tab-label-pending') ? '(placeholder)' : (label.textContent ?? '')
      if (labels[labels.length - 1] !== text) labels.push(text)
    }
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  })
}
const tabLabels = (page: Page) => page.evaluate(() => (window as unknown as { __tunnelLabels: string[] }).__tunnelLabels)

async function openPhonesCloud(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  await expect(page.getByTestId('pc-tabs')).toBeVisible({ timeout: 30_000 })
}

const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }),
  page.locator('.settings-pane').screenshot({ path: `${SHOTS}/${page.context().browser()?.browserType().name()}-${name}.png`, scale: 'css' }))

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('1. the tab never shows a name it then changes: a placeholder first, the kept name after a reload', async ({ page }) => {
  let release!: () => void
  const ctl: ExposeControl = { hold: new Promise<void>((r) => { release = r }) }
  await mockAll(page, ctl)
  await recordTabLabels(page)
  await openPhonesCloud(page)
  const tab = page.getByTestId('pc-tab-devices-browser')
  // A browser that never saw the tunnel's name, while the first read is on its way.
  await expect(tab.getByTestId('pc-tab-label-pending')).toBeVisible()
  await shot(page, '1-placeholder')
  release()
  await expect(tab.locator('.pc-tab-label')).toHaveText('Acme Tunnel', { timeout: 30_000 })
  expect(await tabLabels(page)).toEqual(['(placeholder)', 'Acme Tunnel'])

  // Reopened (the Mac app started again), the read slow again: the kept name from the first frame.
  ctl.hold = new Promise<void>((r) => { release = r })
  await page.reload()
  await expect(page.getByTestId('pc-tabs')).toBeVisible({ timeout: 30_000 })
  await expect(tab.locator('.pc-tab-label')).toHaveText('Acme Tunnel')
  expect(await tabLabels(page)).toEqual(['Acme Tunnel'])
  release()
  await page.waitForTimeout(500)
  expect(await tabLabels(page)).toEqual(['Acme Tunnel'])
})

test('1b. a plugin still loading after a restart keeps the placeholder, never "Tunnel"', async ({ page }) => {
  const ctl: ExposeControl = { pluginLoading: true }
  await mockAll(page, ctl)
  await recordTabLabels(page)
  await openPhonesCloud(page)
  const tab = page.getByTestId('pc-tab-devices-browser')
  await expect(tab.getByTestId('pc-tab-label-pending')).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(tab.getByTestId('pc-tab-label-pending')).toBeVisible()
  // The plugin is up: the next look (another tab, then this one) reads its name.
  ctl.pluginLoading = false
  await page.getByTestId('pc-tab-devices-phones').click()
  await tab.click()
  await expect(tab.locator('.pc-tab-label')).toHaveText('Acme Tunnel', { timeout: 30_000 })
  expect(await tabLabels(page)).not.toContain('Tunnel')
  expect((await tabLabels(page)).filter((l) => l !== '(placeholder)')).toEqual(['Acme Tunnel'])
})

test('Find a setting finds the tunnel by its name and by "tunnel", and shows its name', async ({ page }) => {
  await mockAll(page, {})
  await openPhonesCloud(page)
  await expect(page.getByTestId('pc-tab-devices-browser').locator('.pc-tab-label')).toHaveText('Acme Tunnel', { timeout: 30_000 })
  for (const query of ['acme', 'tunnel']) {
    await page.getByTestId('settings-filter').fill(query)
    await expect(page.getByTestId('settings-nav-devices-browser')).toContainText('Acme Tunnel')
  }
  await page.getByTestId('settings-nav-devices-browser').click()
  await expect(page.getByTestId('pc-tab-devices-browser')).toHaveAttribute('aria-current', 'page')
})

test('2 and 3. the tab says the tunnel and its host by name; "Your Walnut runs on" names each server once, above the tabs', async ({ page }) => {
  await mockAll(page, {})
  await openPhonesCloud(page)
  const tab = page.getByTestId('pc-tab-devices-browser')
  await expect(tab.locator('.pc-tab-label')).toHaveText('Acme Tunnel', { timeout: 30_000 })
  await tab.click()
  const pane = page.locator('#devices-browser')
  const intro = pane.getByTestId('pc-intro-devices-browser')
  await expect(intro.locator('.pc-intro-what')).toHaveText(/^An HTTPS address that opens this Walnut in any browser.*\(from the Acme Tunnel plugin\)\.$/)
  await expect(intro.locator('.pc-intro-now')).toContainText('Connected through Acme Tunnel, runs on Big dev box.')
  await expect(pane.getByTestId('browser-access-runs-on')).toContainText('Big dev box stays on')
  await expect(pane).not.toContainText(/browser link/i)
  await expect(pane).not.toContainText('devbox-ssh')

  // The servers line sits above the tabs, on every tab: each machine once, by the name it was given.
  const servers = pane.getByTestId('walnut-servers')
  await expect(servers.locator('.pc-server')).toHaveCount(3, { timeout: 30_000 })
  expect(await servers.locator('.pc-server-name').allTextContents()).toEqual(['This Mac', 'Cloud companion', 'Big dev box'])
  expect(await servers.locator('.pc-server-short').allTextContents()).toEqual(['main', 'walnut.example.com', 'carries Acme Tunnel'])
  await expect(servers.getByTestId('walnut-server-host:devbox')).toHaveAttribute('title', 'Running. Acme Tunnel opens this Walnut at someone-devbox.acme-tunnel.example, also while this Mac sleeps.')
  await expect(servers).not.toContainText('devbox-ssh')
  await expect(servers).not.toContainText('Old small box')
  const order = await pane.evaluate((el) => ['walnut-servers', 'pc-tabs'].map((id) => el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top))
  expect(order[0]).toBeLessThan(order[1])
  await shot(page, '2-tunnel-tab')

  // All devices: the phones with the app, the browsers and the extension; no servers, no pairing, no Advanced.
  await page.getByTestId('pc-tab-devices-phones').click()
  const all = page.locator('#devices-phones')
  await expect(all.getByTestId('devices-phones-group')).toContainText('Phones with the Walnut app', { timeout: 30_000 })
  await expect(all.getByTestId('devices-phones-group')).toContainText('New phone: Cloud companion, Same Wi-Fi or Tailscale.')
  await expect(all.getByTestId('walnut-servers')).toHaveCount(1)
  await expect(all.locator('.settings-group-heading, h3').filter({ hasText: /Walnut servers|Add a phone|Advanced/ })).toHaveCount(0)
  await expect(all.getByTestId('way-pair-all')).toHaveCount(0)
  await expect(all.getByTestId('devices-show-qr')).toHaveCount(0)
  await expect(all.getByTestId('devices-others-group')).toHaveCount(0)
  await expect(all).not.toContainText(/browser link/i)
  await shot(page, '3-all-devices')

  // A server opens the host row whose server it is (the one carrying the tunnel).
  await all.getByTestId('walnut-server-host:devbox').click()
  await expect(page).toHaveURL(/#rh-host-devbox-ssh$/)
  // The companion opens its tab.
  await page.getByTestId('settings-nav-devices').click()
  await expect(page).toHaveURL(/#cloud$/, { timeout: 30_000 })
  await page.locator('#cloud').getByTestId('walnut-server-companion').click()
  await expect(page).toHaveURL(/#cloud$/)
})

test('This Mac\'s own link and the simulators are in Settings > Advanced, folded', async ({ page }) => {
  await mockAll(page, {}, { simulators: 3 })
  await openPhonesCloud(page)
  await page.getByTestId('settings-nav-advanced').click()
  const adv = page.locator('#advanced')
  const records = adv.getByTestId('devices-others-group')
  await expect(records).toContainText('Device records', { timeout: 30_000 })
  await records.getByTestId('devices-others').click()
  await expect(records.locator('.devices-row')).toHaveCount(4)
  await expect(records.locator('.devices-row').first()).toContainText('This Mac')
})
