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

  test('a replica host (every host by default) lists what it keeps while the Mac sleeps, the choice is saved, and the rollback hides it', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    const hosts = await hostsNow(page)
    // No program named: the replica (D13).
    const plain: Record<string, unknown> = { ...(hosts[KEY] ?? {}) }
    delete plain.server_program
    await putHosts(page, { ...hosts, [KEY]: plain })
    const group = await openRemoteHosts(page)
    const copies = page.getByTestId(`host-server-copies-${KEY}`)
    await expect(copies).toBeVisible({ timeout: 15_000 })
    await expect(copies).toContainText('Kept on this host')
    const box = (key: string) => page.getByTestId(`host-server-copy-${KEY}-${key}`)
    // Default: every kind kept, letter bodies too (the same defaults as every replica).
    for (const key of ['sessions', 'requests', 'boards', 'inbox', 'inbox_bodies']) await expect(box(key)).toBeChecked()
    await expect(copies).not.toContainText('read from your Mac')
    await copies.scrollIntoViewIfNeeded()
    await shot(page, '2b-copies-default', group)

    // The user's switch still turns one off, and on again.
    await copies.getByText('Letter bodies', { exact: true }).click()
    await expect(box('inbox_bodies')).not.toBeChecked({ timeout: 15_000 })
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toMatchObject({ inbox_bodies: false })
    await copies.getByText('Letter bodies', { exact: true }).click()
    await expect(box('inbox_bodies')).toBeChecked({ timeout: 15_000 })
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toMatchObject({ inbox_bodies: true })
    await copies.getByText('Inbox', { exact: true }).click()
    await expect(box('inbox')).not.toBeChecked({ timeout: 15_000 })
    // Bodies ride with the index: without the inbox there is nothing to keep them for.
    await expect(box('inbox_bodies')).toBeDisabled()
    await expect(box('inbox_bodies')).not.toBeChecked()
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toEqual({ inbox_bodies: false, inbox: false })
    await shot(page, '2c-copies-chosen', group)
    // The inbox on again: bodies stay off until the user picks them again.
    await copies.getByText('Inbox', { exact: true }).click()
    await expect(box('inbox')).toBeChecked({ timeout: 15_000 })
    await expect(box('inbox_bodies')).toBeEnabled()
    await expect(box('inbox_bodies')).not.toBeChecked()
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toEqual({ inbox_bodies: false, inbox: true })
    await copies.getByText('Inbox', { exact: true }).click()
    await expect(box('inbox')).not.toBeChecked({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByTestId(`host-server-copies-${KEY}`)).toBeVisible({ timeout: 30_000 })
    await expect(box('inbox')).not.toBeChecked()
    await expect(box('sessions')).toBeChecked()

    // The rollback to the plain host server keeps no copies: the list goes.
    const now = await hostsNow(page)
    await putHosts(page, { ...now, [KEY]: { ...now[KEY], server_program: 'host-server' } })
    await page.reload()
    await expect(page.getByTestId(`host-server-enabled-${KEY}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`host-server-copies-${KEY}`)).toHaveCount(0)
    await putHosts(page, { ...now, [KEY]: { ...now[KEY] } })
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
