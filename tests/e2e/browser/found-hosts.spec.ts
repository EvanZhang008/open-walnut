/**
 * Hosts found in ~/.ssh/config (src/core/hosts/found-hosts.ts; RemoteHostsSection.tsx,
 * BrowserAccessGroup.tsx): Remote Hosts lists one with its Auto-discovered tag and asks
 * "Connect to it?" in place of the switch. Not now keeps it listed, quiet, with Connect
 * on its row; Connect makes it a normal host, switch on. Runs on leads to a found
 * always-on host with "Connect <host> first".
 *
 * The test server reads no real ~/.ssh/config, so this spec lays the found hosts over
 * the server's own GET /api/config and answers the answer route and the config save
 * itself (nothing is written to the fixture's data). Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 bun x playwright test found-hosts --project=webkit --workers=1`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { openWay } from './devices-ways-helpers'

test.setTimeout(180_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-discovered-hosts'

function foundRows(): Record<string, Record<string, unknown>> {
  return {
    'lab-mac': { hostname: '10.0.0.9', user: 'sam', discovered: true, connect: 'ask', enabled: false },
    'home-pc': { hostname: '10.0.0.12', discovered: true, connect: 'ask', enabled: false },
  }
}

interface Seen { answers: Array<{ host: string; answer: string }>; saves: unknown[] }

/** The server's config with the found hosts laid over it; answers and saves change them as the server would. */
async function serveFound(page: Page, seen: Seen) {
  const found = foundRows()
  let slowNextRead = false
  await page.route((url) => url.pathname === '/api/config', async (route: Route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { hosts?: Record<string, Record<string, unknown>> }
      seen.saves.push(body)
      for (const alias of Object.keys(found)) if (body.hosts?.[alias]) found[alias] = { ...body.hosts[alias] }
      await route.fulfill({ json: { ok: true } })
      // The read that follows a save comes back late, so typing lands while the save is out
      // (its echo must not take back what was typed since).
      slowNextRead = true
      return
    }
    if (slowNextRead) { slowNextRead = false; await new Promise((resolve) => setTimeout(resolve, 1500)) }
    const res = await route.fetch()
    const body = await res.json() as { config: { hosts?: Record<string, unknown> } }
    await route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts: { ...(body.config.hosts ?? {}), ...found } } } })
  })
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0])
    const { answer } = route.request().postDataJSON() as { answer: string }
    seen.answers.push({ host, answer })
    if (found[host]) found[host] = { ...found[host], connect: answer, enabled: answer === 'yes' }
    await route.fulfill({ json: { ok: true, host, answer } })
  })
}

async function openSettings(page: Page, nav: string) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId(nav).click()
}

async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.scrollIntoViewIfNeeded()
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

// A late config read (serveFound) may still be out when a test ends: drop it, never fail the next test on it.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const row = (page: Page, alias: string) => page.locator(`[data-host-alias="${alias}"]`)

test('Remote Hosts asks about a found host; Not now keeps it quiet, Connect makes it a normal host', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const seen: Seen = { answers: [], saves: [] }
  await serveFound(page, seen)
  await openSettings(page, 'settings-nav-remote-hosts')

  const lab = row(page, 'lab-mac')
  await expect(lab).toBeVisible({ timeout: 30_000 })
  await expect(lab).toContainText('Auto-discovered')
  await expect(lab.getByTestId('rh-found-question')).toHaveText('Walnut found lab-mac in ~/.ssh/config. Connect to it?')
  await expect(lab.getByTestId('rh-found-connect')).toBeVisible()
  await expect(lab.getByTestId('rh-found-not-now')).toBeVisible()
  // No switch until the person says yes: nothing about this host suggests it is in use.
  await expect(lab.getByRole('switch')).toHaveCount(0)
  await expect(lab).toHaveAttribute('data-found', 'ask')
  const hostsGroup = page.locator('.settings-group').filter({ has: lab })
  await shot(page, '1-asked', hostsGroup)

  // Not now: listed, quiet, not asked again; Connect stays on its row.
  await lab.getByTestId('rh-found-not-now').click()
  await expect(lab.getByTestId('rh-found-question')).toHaveText('Found in ~/.ssh/config. Walnut does not connect to it.')
  await expect(lab.getByTestId('rh-found-not-now')).toHaveCount(0)
  await expect(lab.getByTestId('rh-found-connect')).toBeVisible()
  await expect(lab).toHaveAttribute('data-found', 'not_now')
  expect(seen.answers).toEqual([{ host: 'lab-mac', answer: 'not_now' }])
  // The other found host still asks.
  await expect(row(page, 'home-pc').getByTestId('rh-found-question')).toHaveText('Walnut found home-pc in ~/.ssh/config. Connect to it?')
  await shot(page, '2-not-now', hostsGroup)

  // Connect: a normal host, its switch on, the question gone.
  await lab.getByTestId('rh-found-connect').click()
  await expect(lab.getByTestId('rh-found-question')).toHaveCount(0)
  await expect(lab.getByRole('switch', { name: 'Use lab-mac' })).toBeChecked()
  await expect(lab).not.toHaveAttribute('data-found', /.+/)
  expect(seen.answers).toEqual([{ host: 'lab-mac', answer: 'not_now' }, { host: 'lab-mac', answer: 'yes' }])
  await shot(page, '3-connected', hostsGroup)

  // The editor's own save carries the answers, so a later save never undoes them.
  const lastSaved = () => (seen.saves.at(-1) as { hosts?: Record<string, { connect?: string; enabled?: boolean; label?: string }> } | undefined)?.hosts
  await expect.poll(() => lastSaved()?.['lab-mac']?.connect, { timeout: 15_000 }).toBe('yes')
  const last = { hosts: lastSaved()! }
  expect(last.hosts['lab-mac']).toMatchObject({ connect: 'yes', enabled: true })
  expect(last.hosts['home-pc']).toMatchObject({ connect: 'ask', enabled: false })

  // Editing a host that waits is no yes: a new label is saved, and the question stays.
  const home = row(page, 'home-pc')
  await home.getByRole('button', { name: 'Edit' }).click()
  // The edit fields open below the row, one host at a time.
  await page.locator('input[id^="rh-label-"]').fill('Home PC')
  await home.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => lastSaved()?.['home-pc']?.label, { timeout: 15_000 }).toBe('Home PC')
  expect(lastSaved()!['home-pc']).toMatchObject({ connect: 'ask', enabled: false })
  await expect(home.getByTestId('rh-found-question')).toBeVisible()
  expect(seen.answers).toEqual([{ host: 'lab-mac', answer: 'not_now' }, { host: 'lab-mac', answer: 'yes' }])
  expect(errors).toEqual([])
})

test('Runs on leads to a found always-on host with Connect first', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const seen: Seen = { answers: [], saves: [] }
  await serveFound(page, seen)
  let connected = false
  const provider = { id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [] }
  await page.route('**/api/expose', async (route: Route) => {
    const places = connected
      ? [{ id: 'lab-mac', label: 'Lab Mac', alwaysOn: true }, { id: 'here', label: 'This computer', alwaysOn: false }]
      : [{ id: 'here', label: 'This computer', alwaysOn: false }, { id: 'lab-mac', label: 'Lab Mac', alwaysOn: true, needsConnect: true }]
    await route.fulfill({
      json: {
        status: { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: 1, url: 'https://someone.acme-tunnel.example', port: 54001 },
        providers: [provider],
        places,
        settings: { enabled: true, provider: 'acme-tunnel', options: {}, runOn: null, placedOn: connected ? 'lab-mac' : 'here' },
      },
    })
  })
  await page.route('**/api/hosts/lab-mac/found-answer', async (route: Route) => {
    seen.answers.push({ host: 'lab-mac', answer: (route.request().postDataJSON() as { answer: string }).answer })
    connected = true
    await route.fulfill({ json: { ok: true, host: 'lab-mac', answer: 'yes' } })
  })
  await openSettings(page, 'settings-nav-devices')
  // A plugin's tunnel names the way after itself: its card, its nav row and its pane title.
  await expect(page.getByTestId('devices-way-browser').locator('.devices-way-title')).toHaveText('Acme Tunnel', { timeout: 30_000 })
  await openWay(page, 'browser')
  await expect(page.locator('#devices-browser-title')).toHaveText('Acme Tunnel')
  await expect(page.getByTestId('settings-nav-devices-browser')).toContainText('Acme Tunnel')
  await expect(page.getByTestId('settings-nav-devices-browser')).not.toContainText('Browser link')
  const runsOn = page.getByTestId('browser-access-runs-on')
  await expect(runsOn).toBeVisible({ timeout: 30_000 })
  await expect(runsOn).toContainText('Lab Mac stays on, but Walnut found it in ~/.ssh/config and does not connect to it until you say so.')
  // Only one place to pick from: no picker, just the way to the host.
  await expect(page.getByTestId('browser-access-runs-on-here')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-connect-lab-mac')).toHaveText('Connect Lab Mac first')
  await shot(page, '4-runs-on-connect-first', runsOn)

  await page.getByTestId('browser-access-connect-lab-mac').click()
  await expect(page.getByTestId('browser-access-runs-on-lab-mac')).toHaveAttribute('aria-checked', 'true')
  await expect(runsOn).toContainText('Lab Mac stays on, so the address answers while this computer sleeps.')
  await expect(page.getByTestId('browser-access-connect-lab-mac')).toHaveCount(0)
  expect(seen.answers).toEqual([{ host: 'lab-mac', answer: 'yes' }])
  await shot(page, '5-runs-on-connected', runsOn)
  expect(errors).toEqual([])
})
