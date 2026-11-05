/**
 * Settings > Remote Hosts > a host's Details > This host > Walnut on this host
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host"; HostServersGroup.tsx
 * HostServerPart): the switch that keeps a Walnut running on a host, its one sentence of
 * state, and that the Hosts editor, which saves the whole hosts map, never turns it off.
 * 2026-11-04 review: this sat under More settings as "Walnut on a host", away from the host;
 * it now lives with the host, in its Details (row menu > Details).
 *
 * The host is one this spec adds, turned off as a host, so nothing dials it: the
 * server waits for the host. The fixture has no tunnel plugin, so the tunnel row
 * says how to add one. Config writes are real, on the fixture server; navigation
 * is by clicks. WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { hostRow, openHostDetails } from './host-problems-fixture-helpers'

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
  await expect(hostRow(page, KEY)).toBeVisible({ timeout: 30_000 })
}

/** The host's own settings: its Details (closed by default, opened from its row's More menu), This host. */
async function thisHost(page: Page): Promise<Locator> {
  await expect(hostRow(page, KEY)).toBeVisible({ timeout: 30_000 })
  const details = await openHostDetails(page, KEY)
  const part = details.getByTestId(`rh-this-host-${KEY}`)
  await expect(part.getByTestId(`host-server-${KEY}`)).toBeVisible({ timeout: 30_000 })
  return part
}

async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Walnut on this host, in the host\'s Details', () => {
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
    await openRemoteHosts(page)
    // Nothing of it under More settings any more: it is the host's own setting.
    await expect(page.getByTestId('host-servers')).toHaveCount(0)
    const part = await thisHost(page)
    // The part is this host's: it names it, so its rows need not.
    await expect(part).toHaveAttribute('aria-label', 'Settings of Build box')
    const row = part.getByTestId(`host-server-${KEY}`)
    const state = part.getByTestId(`host-server-state-${KEY}`)
    const toggle = part.getByTestId(`host-server-enabled-${KEY}`)
    await expect(row).toHaveAttribute('data-phase', 'off')
    await expect(row.locator('.settings-row-label')).toHaveText('Walnut on this host')
    await expect(state).toHaveText('Off: no Walnut runs there, so a browser there cannot open Walnut while your Mac is away.')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await part.scrollIntoViewIfNeeded()
    await shot(page, '1-off', part)
    // The row's title: a click on it starts nothing (2026-11-02).
    await row.locator('.settings-row-label').click()
    await page.waitForTimeout(500)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(((await hostsNow(page))[KEY]?.server as { enabled?: boolean } | undefined)?.enabled).not.toBe(true)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(row).toHaveAttribute('data-phase', 'waiting-for-host', { timeout: 15_000 })
    await expect(state).toContainText('It starts once Walnut connects to this host')
    await expect(part.getByTestId(`host-server-no-provider-${KEY}`)).toContainText('add a tunnel plugin')
    // How a browser there signs in, said once while it is on (the old group's footer).
    await expect(part).toContainText('A browser opening it signs in with a code (Phones & Cloud, Open from a browser).')
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: true })
    await shot(page, '2-on-waiting', part)

    await page.reload()
    const again = await thisHost(page)
    await expect(again.getByTestId(`host-server-enabled-${KEY}`)).toHaveAttribute('aria-checked', 'true')
    await expect(again.getByTestId(`host-server-${KEY}`)).toHaveAttribute('data-phase', 'waiting-for-host')
  })

  test('editing the host in the Hosts editor keeps its server on', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await openRemoteHosts(page)
    const boxRow = hostRow(page, KEY)
    await boxRow.getByTestId('rh-row-more').click()
    await page.getByTestId('rh-row-menu').getByRole('menuitem', { name: 'Edit', exact: true }).click()
    const options = page.getByTestId('rh-more-options')
    if ((await options.getAttribute('aria-expanded')) !== 'true') await options.click()
    const label = page.locator('#remote-hosts input[id^="rh-label-"]')
    await expect(label).toHaveValue('Build box')
    await label.fill('Build box 2')
    // The editor saves the whole hosts map on its own.
    await expect.poll(async () => (await hostsNow(page))[KEY]?.label, { timeout: 15_000 }).toBe('Build box 2')
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: true })
    await page.getByTestId('rh-edit-done').click()
    await expect(boxRow.locator('.rh-host-name')).toHaveText('Build box 2', { timeout: 15_000 })
    // Its Details follow the new name, and Walnut on it is still on.
    const part = await thisHost(page)
    await expect(part).toHaveAttribute('aria-label', 'Settings of Build box 2')
    await expect(part.getByTestId(`host-server-enabled-${KEY}`)).toHaveAttribute('aria-checked', 'true')
  })

  test('a replica host (every host by default) lists what it keeps while the Mac sleeps, the choice is saved, and the rollback hides it', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    const hosts = await hostsNow(page)
    // No program named: the replica (D13).
    const plain: Record<string, unknown> = { ...(hosts[KEY] ?? {}) }
    delete plain.server_program
    await putHosts(page, { ...hosts, [KEY]: plain })
    await openRemoteHosts(page)
    const group = await thisHost(page)
    // The switches fold behind one line that says how many are kept.
    const kept = group.getByTestId(`host-server-copies-toggle-${KEY}`)
    await expect(kept).toContainText('Kept on this host', { timeout: 15_000 })
    await expect(kept).toContainText('All 11 kinds copied')
    if ((await kept.getAttribute('aria-expanded')) !== 'true') await kept.click()
    const copies = page.getByTestId(`host-server-copies-${KEY}`)
    await expect(copies).toBeVisible({ timeout: 15_000 })
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
    await copies.getByText('Inbox and notification cards', { exact: true }).click()
    await expect(box('inbox')).not.toBeChecked({ timeout: 15_000 })
    // Bodies ride with the index: without the inbox there is nothing to keep them for.
    await expect(box('inbox_bodies')).toBeDisabled()
    await expect(box('inbox_bodies')).not.toBeChecked()
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toEqual({ inbox_bodies: false, inbox: false })
    await shot(page, '2c-copies-chosen', group)
    // The inbox on again: bodies stay off until the user picks them again.
    await copies.getByText('Inbox and notification cards', { exact: true }).click()
    await expect(box('inbox')).toBeChecked({ timeout: 15_000 })
    await expect(box('inbox_bodies')).toBeEnabled()
    await expect(box('inbox_bodies')).not.toBeChecked()
    await expect.poll(async () => ((await hostsNow(page))[KEY]?.server as { copies?: Record<string, boolean> })?.copies, { timeout: 15_000 })
      .toEqual({ inbox_bodies: false, inbox: true })
    await copies.getByText('Inbox and notification cards', { exact: true }).click()
    await expect(box('inbox')).not.toBeChecked({ timeout: 15_000 })

    await page.reload()
    // Details are closed again after a reload; the fold inside them stays open for this tab.
    await thisHost(page)
    await expect(page.getByTestId(`host-server-copies-${KEY}`)).toBeVisible({ timeout: 30_000 })
    await expect(kept).toContainText('9 of 11 copied')
    await expect(box('inbox')).not.toBeChecked()
    await expect(box('sessions')).toBeChecked()

    // The rollback to the plain host server keeps no copies: the list goes.
    const now = await hostsNow(page)
    await putHosts(page, { ...now, [KEY]: { ...now[KEY], server_program: 'host-server' } })
    await page.reload()
    await thisHost(page)
    await expect(page.getByTestId(`host-server-enabled-${KEY}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`host-server-copies-${KEY}`)).toHaveCount(0)
    await putHosts(page, { ...now, [KEY]: { ...now[KEY] } })
  })

  test('turn it off', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    await openRemoteHosts(page)
    const group = await thisHost(page)
    const toggle = group.getByTestId(`host-server-enabled-${KEY}`)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(group.getByTestId(`host-server-${KEY}`)).toHaveAttribute('data-phase', 'off')
    await expect(group.getByTestId(`host-server-no-provider-${KEY}`)).toHaveCount(0)
    await expect(group).not.toContainText('A browser opening it signs in with a code')
    expect((await hostsNow(page))[KEY]?.server).toMatchObject({ enabled: false })
    await shot(page, '3-off-again', group)
  })
})
