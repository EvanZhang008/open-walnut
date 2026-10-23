/**
 * The tunnel moving to a host and installing its CLI, as Settings says it
 * (BrowserAccessGroup.tsx, browser-access-status.ts describeExpose): while the
 * host's server installs, the tunnel runs here and the state line says where it
 * moves and what the host is doing; the screen follows the move by itself (it
 * polls every 3 s while moving) until the host holds it. A CLI that is missing is
 * installed first ("Installing ..."), a failed install is the person's turn with
 * Retry, and on a host the line names it.
 *
 * The shared fixture has no tunnel plugin and no host server, so this spec answers
 * /api/expose itself; the server half is tests/e2e/expose-handover-e2e.test.ts.
 * Every navigation is a click (the app is entered through a link). WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/bun-tunnel-shots'
const URL_HERE = 'https://someone-acme-demo.acme-tunnel.example'
const RUNS_ON = { hostKey: 'devbox', label: 'Dev box', auto: true }

type Status = Record<string, unknown>

interface Server {
  status: Status
  /** POST /api/expose/retry answers with this, then it is the status. */
  afterRetry?: Status
  retries: number
  gets: number
}

const base = { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', since: 1 }

function exposeBody(s: Server) {
  return {
    status: s.status,
    providers: [{ id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [{ key: 'name', label: 'Tunnel name', default: 'acme-demo' }] }],
    places: [{ id: 'devbox', label: 'Dev box', alwaysOn: true }, { id: 'here', label: 'This computer', alwaysOn: false }],
    settings: { enabled: true, provider: 'acme-tunnel', options: {}, runOn: null, placedOn: 'devbox' },
  }
}

async function serve(page: Page, s: Server) {
  await page.route('**/api/expose', async (route: Route) => {
    s.gets++
    await route.fulfill({ json: exposeBody(s) })
  })
  await page.route('**/api/expose/retry', async (route: Route) => {
    s.retries++
    if (s.afterRetry) s.status = s.afterRetry
    await route.fulfill({ json: { status: s.status } })
  })
}

/** Into the app through a link, then Settings by clicks (SPA navigation only). */
async function openSettings(page: Page, baseURL: string | undefined) {
  await page.setContent(`<a href="${new URL('/', baseURL).href}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  const group = page.getByTestId('browser-access')
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  return group
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.scrollIntoViewIfNeeded()
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('moving to a host: it runs here meanwhile, says what the host does, and follows the move by itself', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const s: Server = {
    status: { ...base, state: 'connected', url: URL_HERE, port: 54001, movingTo: { hostKey: 'devbox', label: 'Dev box', note: 'Installing Walnut 0.6.7-abc1234 on the host.' } },
    retries: 0, gets: 0,
  }
  await serve(page, s)
  const group = await openSettings(page, baseURL)
  const state = page.getByTestId('browser-access-state')
  await expect(state).toHaveText('Connected through Acme Tunnel. Moving to Dev box once it runs there. Installing Walnut 0.6.7-abc1234 on the host.')
  await expect(state).toHaveAttribute('data-state', 'connected')
  await expect(state.locator('.browser-access-dot')).toHaveAttribute('data-dot', 'done')
  // This computer's address answers meanwhile; no Retry while it does.
  await expect(page.getByTestId('browser-access-url')).toHaveText('someone-acme-demo.acme-tunnel.example')
  await expect(page.getByTestId('browser-access-retry')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-runs-on-devbox')).toHaveAttribute('aria-checked', 'true')
  await shot(page, '1-moving-installing-walnut', group)

  // The host installs the tunnel CLI: the next poll (3 s while moving) says so.
  s.status = { ...s.status, movingTo: { hostKey: 'devbox', label: 'Dev box', note: 'Installing Acme Tunnel...' } }
  await expect(state).toHaveText('Connected through Acme Tunnel. Moving to Dev box once it runs there. Installing Acme Tunnel...', { timeout: 10_000 })
  s.status = { ...s.status, movingTo: { hostKey: 'devbox', label: 'Dev box', note: 'Switching over.' } }
  await expect(state).toHaveText('Connected through Acme Tunnel. Moving to Dev box once it runs there. Switching over.', { timeout: 10_000 })
  await shot(page, '2-moving-switching-over', group)

  // The host holds it: the line names the host, without a reload or a click.
  s.status = { ...base, state: 'connected', url: URL_HERE, runsOn: RUNS_ON }
  await expect(state).toHaveText('Connected through Acme Tunnel on Dev box.', { timeout: 10_000 })
  await expect(page.getByTestId('browser-access-url')).toHaveText('someone-acme-demo.acme-tunnel.example')
  await shot(page, '3-handed-over', group)
  expect(errors).toEqual([])
})

test('a missing CLI is installed first; a failed install offers Retry, which installs again', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const installing = { ...base, state: 'starting', port: 54001, activity: 'Installing Acme Tunnel...' }
  const s: Server = { status: installing, retries: 0, gets: 0 }
  await serve(page, s)
  const group = await openSettings(page, baseURL)
  const state = page.getByTestId('browser-access-state')
  await expect(state).toHaveText('Installing Acme Tunnel...')
  await expect(state.locator('.browser-access-dot')).toHaveAttribute('data-dot', 'pending')
  await expect(page.getByTestId('browser-access-retry')).toHaveCount(0)
  await shot(page, '4-installing-here', group)

  const at = Date.now() + 5 * 60_000
  s.status = {
    ...base, state: 'missing', port: 54001, nextRetryAt: at,
    lastError: 'Installing Acme Tunnel failed: error: no access to the registry', hint: 'Install the Acme tunnel CLI first.',
  }
  s.afterRetry = installing
  await expect(state).toContainText('Installing Acme Tunnel failed: error: no access to the registry. Install the Acme tunnel CLI first. Trying again at', { timeout: 10_000 })
  await expect(state.locator('.browser-access-dot')).toHaveAttribute('data-dot', 'action')
  await shot(page, '5-install-failed', group)
  await page.getByTestId('browser-access-retry').click()
  await expect(state).toHaveText('Installing Acme Tunnel...')
  expect(s.retries).toBe(1)
  expect(errors).toEqual([])
})

test('on a host, its install names the host; moving while the one here retries says both', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  const s: Server = { status: { ...base, state: 'starting', runsOn: RUNS_ON, activity: 'Installing Acme Tunnel...' }, retries: 0, gets: 0 }
  await serve(page, s)
  const group = await openSettings(page, baseURL)
  const state = page.getByTestId('browser-access-state')
  await expect(state).toHaveText('Installing Acme Tunnel on Dev box...')
  await shot(page, '6-installing-on-host', group)

  s.status = {
    ...base, state: 'retrying', port: 54001, nextRetryAt: Date.now() + 30_000, lastError: 'Acme Tunnel exited (code 1).',
    movingTo: { hostKey: 'devbox', label: 'Dev box', note: 'Waiting to connect to Dev box.' },
  }
  await expect(state).toContainText('Acme Tunnel exited (code 1). Trying again at', { timeout: 10_000 })
  await expect(state).toContainText('Moving to Dev box once it runs there. Waiting to connect to Dev box.')
  await expect(page.getByTestId('browser-access-retry')).toBeVisible()
  await shot(page, '7-retrying-while-moving', group)
})
