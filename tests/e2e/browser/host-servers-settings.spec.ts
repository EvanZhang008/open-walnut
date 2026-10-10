/**
 * Settings → Remote Hosts → Walnut on a host (docs/plan/walnut-servers-everywhere.md,
 * "A server on a host"): the switch that keeps a Walnut running on a host, its
 * one sentence of state, and that the Hosts editor above it, which saves the
 * whole hosts map, never turns it off.
 *
 * The host is one this spec adds, turned off as a host, so nothing dials it: the
 * server waits for the host. The fixture has no tunnel plugin, so the tunnel row
 * says how to add one. Config writes are real, on the fixture server; navigation
 * is by clicks. WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/host-servers-settings'
const KEY = 'pw-hs-box'

async function hostsNow(page: Page): Promise<Record<string, Record<string, unknown>>> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { config: { hosts?: Record<string, Record<string, unknown>> } }).config.hosts ?? {}
}

async function putHosts(page: Page, hosts: Record<string, unknown>) {
  const res = await page.request.put('/api/config', { data: { hosts } })
  expect(res.ok()).toBe(true)
}

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-remote-hosts')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const group = page.getByTestId('host-servers')
  await expect(group).toBeVisible({ timeout: 30_000 })
  return group
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Walnut on a host', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const page = await context.newPage()
    const hosts = await hostsNow(page)
    await putHosts(page, { ...hosts, [KEY]: { hostname: `${KEY}.invalid`, label: 'Build box', enabled: false } })
    await context.close()
  })

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const page = await context.newPage()
    const hosts = await hostsNow(page)
    delete hosts[KEY]
    await putHosts(page, hosts).catch(() => {})
    await context.close()
  })

  test('turn it on: it waits for the host, and stays on through a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    const group = await openRemoteHosts(page)
    const row = page.getByTestId(`host-server-${KEY}`)
    const state = page.getByTestId(`host-server-state-${KEY}`)
    const toggle = page.getByTestId(`host-server-enabled-${KEY}`)
    await expect(row).toHaveAttribute('data-phase', 'off')
    await expect(row).toContainText('Build box')
    await expect(state).toContainText('also while this Mac sleeps')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await group.scrollIntoViewIfNeeded()
    await shot(page, '1-off', group)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(row).toHaveAttribute('data-phase', 'waiting-for-host', { timeout: 15_000 })
    await expect(state).toContainText('Walnut connects to this host when a session or a check needs it')
    await expect(page.getByTestId(`host-server-no-provider-${KEY}`)).toContainText('add a tunnel plugin')
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: true })
    await shot(page, '2-on-waiting', group)

    await page.reload()
    await expect(page.getByTestId('host-servers')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`host-server-enabled-${KEY}`)).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId(`host-server-${KEY}`)).toHaveAttribute('data-phase', 'waiting-for-host')
  })

  test('editing the host in the Hosts editor keeps its server on', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await openRemoteHosts(page)
    const hostRow = page.locator(`[data-host-alias="${KEY}"]`)
    await hostRow.getByRole('button', { name: 'Edit' }).click()
    const label = page.locator('#remote-hosts input[id^="rh-label-"]')
    await expect(label).toHaveValue('Build box')
    await label.fill('Build box 2')
    // The editor saves the whole hosts map on its own.
    await expect.poll(async () => (await hostsNow(page))[KEY]?.label, { timeout: 15_000 }).toBe('Build box 2')
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: true })
    await hostRow.getByRole('button', { name: 'Done' }).click()
    const row = page.getByTestId(`host-server-${KEY}`)
    await expect(row).toContainText('Build box 2', { timeout: 15_000 })
    await expect(page.getByTestId(`host-server-enabled-${KEY}`)).toHaveAttribute('aria-checked', 'true')
  })

  test('turn it off', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    const group = await openRemoteHosts(page)
    const toggle = page.getByTestId(`host-server-enabled-${KEY}`)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId(`host-server-${KEY}`)).toHaveAttribute('data-phase', 'off')
    await expect(page.getByTestId(`host-server-no-provider-${KEY}`)).toHaveCount(0)
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: false })
    await shot(page, '3-off-again', group)
  })
})
