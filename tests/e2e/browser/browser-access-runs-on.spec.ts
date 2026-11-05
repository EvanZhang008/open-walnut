/**
 * Where the tunnel runs (BrowserAccessGroup.tsx "Runs on", HostServersGroup.tsx;
 * src/core/expose/placement.ts): a provider that names always-on hosts runs on
 * one by default, the person moves it to this computer and back, the state line
 * names the host, and the host's Details in Remote Hosts (This host, Walnut on this
 * host) say it carries the tunnel with its switch held on. An older server (no
 * `places`) shows no Runs on row.
 *
 * The shared fixture has no tunnel plugin and no host server, so this spec
 * answers /api/expose and /api/host-servers itself, keeping what was written; the
 * server half is tests/e2e/expose-placement-e2e.test.ts. Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import { openWay } from './devices-ways-helpers'
import { hostDetails, hostRow, openHostDetails } from './host-problems-fixture-helpers'

test.setTimeout(120_000)

const SHOTS = '/tmp/browser-access-runs-on'
const URL_HOST = 'https://someone-walnut.acme-tunnel.example'

interface Server {
  runOn: string | null
  puts: unknown[]
  places: boolean
}

function exposeBody(s: Server) {
  const placedOn = s.runOn ?? 'devbox'
  const onHost = placedOn === 'devbox'
  return {
    status: onHost
      ? { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: 1, url: URL_HOST, runsOn: { hostKey: 'devbox', label: 'Dev box', auto: s.runOn === null } }
      : { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: 1, url: URL_HOST, port: 54001 },
    providers: [{ id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [{ key: 'name', label: 'Tunnel name', default: 'walnut' }] }],
    ...(s.places ? { places: [{ id: 'devbox', label: 'Dev box', alwaysOn: true }, { id: 'here', label: 'This computer', alwaysOn: false }] } : {}),
    settings: { enabled: true, provider: 'acme-tunnel', options: {}, ...(s.places ? { runOn: s.runOn, placedOn } : {}) },
  }
}

/** GET /api/host-servers: the always-on host, under `hostKey` (the Remote Hosts test names a saved one). */
function hostsBody(s: Server, hostKey = 'devbox', label = 'Dev box') {
  const carries = (s.runOn ?? 'devbox') === 'devbox'
  return {
    hosts: [{
      hostKey, label,
      settings: { enabled: carries, ...(carries ? { carriesTunnel: true } : {}), expose: { enabled: false, provider: null, options: {} } },
      view: carries
        ? { hostKey, enabled: true, phase: 'running', since: 1, server: { expose: { enabled: true, provider: 'acme-tunnel', state: 'connected', since: 1, url: URL_HOST } } }
        : { hostKey, enabled: false, phase: 'off', since: 1, server: null },
    }],
    providers: exposeBody(s).providers,
  }
}

async function serve(page: Page, s: Server, host?: { key: string; label: string }) {
  await page.route('**/api/expose', async (route: Route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { run_on?: string | null }
      s.puts.push(body)
      if (body.run_on !== undefined) s.runOn = body.run_on
      await route.fulfill({ json: { status: exposeBody(s).status } })
      return
    }
    await route.fulfill({ json: exposeBody(s) })
  })
  await page.route('**/api/host-servers', (route) => route.fulfill({ json: hostsBody(s, host?.key, host?.label) }))
  // The phone link Settings makes by itself once connected: the host's always-on address first.
  await page.route('**/api/devices/browser-code', (route) => route.fulfill({
    json: {
      code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000, url: URL_HOST, link: `${URL_HOST}/#pair=ABCD-EFGH`,
      addresses: [{ where: 'devbox', label: 'Dev box', url: URL_HOST, link: `${URL_HOST}/#pair=ABCD-EFGH`, alwaysOn: true }],
    },
  }))
}

async function openSettings(page: Page, nav: string) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId(nav).click()
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('runs on the always-on host by default; moves to this computer and back', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const s: Server = { runOn: null, puts: [], places: true }
  await serve(page, s)
  await openSettings(page, 'settings-nav-devices')
  await openWay(page, 'browser')
  const group = page.getByTestId('browser-access')
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  const runsOn = page.getByTestId('browser-access-runs-on')
  await expect(runsOn).toBeVisible()
  await expect(page.getByTestId('browser-access-runs-on-devbox')).toHaveAttribute('aria-checked', 'true')
  await expect(runsOn).toContainText('Dev box stays on, so the address answers while this computer sleeps.')
  await expect(page.getByTestId('browser-access-state')).toHaveText('Connected through Acme Tunnel on Dev box.')
  await expect(page.getByTestId('browser-access-link')).toHaveAttribute('href', `${URL_HOST}/#pair=ABCD-EFGH`)
  await group.scrollIntoViewIfNeeded()
  await shot(page, '1-on-host', group)

  await page.getByTestId('browser-access-runs-on-here').click()
  await expect(page.getByTestId('browser-access-runs-on-here')).toHaveAttribute('aria-checked', 'true')
  await expect(runsOn).toContainText('The address answers while this computer is awake.')
  await expect(page.getByTestId('browser-access-state')).toHaveText('Connected through Acme Tunnel.')
  expect(s.puts).toEqual([{ run_on: 'here' }])
  await shot(page, '2-on-this-computer', group)

  // The selected one again writes nothing.
  await page.getByTestId('browser-access-runs-on-here').click()
  await page.getByTestId('browser-access-runs-on-devbox').click()
  await expect(page.getByTestId('browser-access-state')).toHaveText('Connected through Acme Tunnel on Dev box.')
  expect(s.puts).toEqual([{ run_on: 'here' }, { run_on: 'devbox' }])
  expect(errors).toEqual([])
})

test('the host that carries the tunnel says so in Remote Hosts, its switch held on', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const s: Server = { runOn: null, puts: [], places: true }
  // Walnut on a host shows in that host's Details, so the always-on host here is the fixture's
  // own saved SSH host (switched off: nothing dials it).
  const HOST = 'fixture-remote'
  await serve(page, s, { key: HOST, label: 'Big remote host' })
  await openSettings(page, 'settings-nav-remote-hosts')
  // 2026-11-04 review: it sat under More settings as "Walnut on a host"; it is the host's own
  // setting now, in its Details (row menu > Details) under This host.
  await expect(hostRow(page, HOST)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('host-servers')).toHaveCount(0)
  await openHostDetails(page, HOST)
  const group = hostDetails(page, HOST).getByTestId(`rh-this-host-${HOST}`)
  await expect(group.getByTestId(`host-server-${HOST}`)).toBeVisible({ timeout: 30_000 })
  await expect(group.getByTestId(`host-server-carries-${HOST}`)).toContainText("Runs this computer's tunnel: change it in Phones & Cloud, Open from a browser.")
  await expect(group.getByTestId(`host-server-enabled-${HOST}`)).toBeDisabled()
  await expect(group.getByTestId(`host-server-url-${HOST}`)).toHaveText('someone-walnut.acme-tunnel.example')
  // Not its own tunnel controls: those belong to a tunnel of its own.
  await expect(group.getByTestId(`host-server-expose-${HOST}`)).toHaveCount(0)
  await group.scrollIntoViewIfNeeded()
  await shot(page, '3-remote-hosts-carries', group)
})

test('an older server without places shows no Runs on row', async ({ page }) => {
  const s: Server = { runOn: 'here', puts: [], places: false }
  await serve(page, s)
  await openSettings(page, 'settings-nav-devices')
  await openWay(page, 'browser')
  const group = page.getByTestId('browser-access')
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  await expect(page.getByTestId('browser-access-enabled')).toBeVisible()
  await expect(page.getByTestId('browser-access-runs-on')).toHaveCount(0)
})
