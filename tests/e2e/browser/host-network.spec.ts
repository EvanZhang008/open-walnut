/**
 * Settings › Remote Hosts › Machines that joined with a link (HostNetworkGroup.tsx;
 * server: src/web/routes/hosts-net.ts). With none, one line says so; Add a machine shows
 * the command to run on the new machine with Copy and the minutes left, watches the
 * invite, and the machine that joins becomes a row saying how this Mac reaches it;
 * an expired link offers a new one; a refused invite says why; Remove asks once more,
 * sends the DELETE and drops the row. The server is faked at the route (no companion
 * here; tests/e2e/host-network-e2e.test.ts runs the real one). Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-network'
const ID = 'e'.repeat(64)
const LINK = 'https://wn.example.com/join/K7QM-4XTD-92ZD'
const COMMAND = `curl -fsSL ${LINK} | sh`

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
}

function overview(machines: unknown[], extra: Record<string, unknown> = {}) {
  return { enabled: true, macId: 'a'.repeat(64), relays: ['https://wn.example.com'], syncedAt: Date.now(), error: null, machines, ...extra }
}

const shot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('host-network-group').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('Add a machine: the command, the countdown, the join, the path, Remove', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let machines: Array<Record<string, unknown>> = []
  let polls = 0
  const deleted: string[] = []
  await page.route('**/api/hosts/net', (route) => route.fulfill({ json: overview(machines) }))
  await page.route('**/api/hosts/net/invites', (route) => route.fulfill({
    status: 201, json: { id: 'ni-1', link: LINK, command: COMMAND, expiresAt: Date.now() + 10 * 60_000, state: 'waiting' },
  }))
  await page.route('**/api/hosts/net/invites/ni-1', (route) => {
    polls++
    if (polls < 2) return route.fulfill({ json: { id: 'ni-1', link: LINK, command: COMMAND, expiresAt: Date.now() + 9 * 60_000, state: 'waiting' } })
    machines = [{ host: 'gpu-box', endpoint: ID, enabled: true, platform: 'linux-x64', addedAt: Date.now(), path: 'direct', rttMs: 31.4 }]
    return route.fulfill({ json: { id: 'ni-1', link: LINK, command: COMMAND, expiresAt: Date.now() + 9 * 60_000, state: 'joined', member: { id: ID, name: 'gpu-box', platform: 'linux-x64' } } })
  })
  await page.route('**/api/hosts/net/machines/*', (route) => {
    const host = decodeURIComponent(route.request().url().split('/').pop()!)
    deleted.push(`${route.request().method()} ${host}`)
    machines = machines.filter((m) => m.host !== host)
    return route.fulfill({ json: { removed: host } })
  })

  await openRemoteHosts(page)
  const group = page.getByTestId('host-network-group')
  await expect(group).toBeVisible({ timeout: 30_000 })
  await expect(group).toContainText('Machines that joined with a link')
  await expect(group).toContainText('No machines yet.')
  await expect(group).toContainText('These machines need no SSH.')
  await group.scrollIntoViewIfNeeded()
  await shot(page, '1-empty')

  await page.getByTestId('host-network-add').click()
  const invite = page.getByTestId('host-network-invite')
  await expect(invite).toContainText('Run this in a terminal on the new machine (macOS or Linux):')
  await expect(page.getByTestId('host-network-command')).toHaveText(COMMAND)
  await expect(invite).toContainText(/Works once, for 10 minutes \((9|10):\d\d left\)\. +Waiting for the machine\.\.\./)
  await expect(group).not.toContainText('No machines yet.')
  await shot(page, '2-waiting')
  // Copy puts the exact command on the clipboard (read back where the engine lets a test).
  const chromium = page.context().browser()?.browserType().name() === 'chromium'
  if (chromium) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByTestId('host-network-copy').click()
  if (chromium) {
    await expect(page.getByTestId('host-network-copy')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND)
  }

  // The machine runs it: the invite reads joined, and the machine is a row with its path.
  await expect(invite).toHaveAttribute('data-invite-state', 'joined', { timeout: 15_000 })
  await expect(invite).toContainText('gpu-box joined.')
  const row = group.locator('[data-host-alias="gpu-box"]')
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64 · Direct · 31 ms')
  await expect(page.getByTestId('host-network-add')).toHaveText('New link')
  expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await shot(page, '3-joined')

  // Remove asks once more ("Confirm remove" drops the button's "Remove gpu-box" name,
  // so it is found by its place), then sends the DELETE and the row goes.
  await expect(row.getByRole('button', { name: 'Remove gpu-box' })).toBeVisible()
  const remove = row.locator('button[data-armed]')
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  expect(deleted).toEqual([])
  await remove.click()
  await expect.poll(() => deleted, { timeout: 10_000 }).toEqual(['DELETE gpu-box'])
  await expect(row).toHaveCount(0, { timeout: 10_000 })
  expect(errors).toEqual([])
})

test('a refused invite says why, an expired link offers a new one, a narrow window keeps its rows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let refuse = true
  await page.route('**/api/hosts/net', (route) => route.fulfill({ json: overview([
    { host: 'a-machine-with-a-rather-long-name-for-a-narrow-window', endpoint: ID, enabled: true, platform: 'darwin-arm64', path: 'relay', rttMs: 88 },
  ]) }))
  await page.route('**/api/hosts/net/invites', (route) => {
    if (refuse) return route.fulfill({ status: 400, json: { error: 'Adding machines goes through your cloud companion; pair one first (Settings > Cloud Companion).', code: 'no_companion' } })
    return route.fulfill({ status: 201, json: { id: 'ni-2', link: LINK, command: COMMAND, expiresAt: Date.now() + 10 * 60_000, state: 'waiting' } })
  })
  // A restart forgot it: the server answers 404, which reads as expired.
  await page.route('**/api/hosts/net/invites/ni-2', (route) => route.fulfill({ status: 404, json: { error: 'No such invite', code: 'unknown_invite' } }))

  await openRemoteHosts(page)
  // A narrow window (the sidebar collapses below this, so the window narrows once there).
  await page.setViewportSize({ width: 720, height: 900 })
  const group = page.getByTestId('host-network-group')
  await expect(group).toBeVisible({ timeout: 30_000 })
  const row = group.locator('[data-net-path="relay"]')
  await expect(row.getByTestId('host-network-path')).toHaveText('macOS arm64 · Through your relay · 88 ms')
  expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

  await page.getByTestId('host-network-add').click()
  // The row names what failed; the reason sits under it.
  await expect(page.getByTestId('host-network-invite-error')).toContainText('Could not make a link')
  await expect(group.getByRole('alert')).toContainText('pair one first')
  await group.scrollIntoViewIfNeeded()
  await shot(page, '4-refused')

  refuse = false
  await page.getByTestId('host-network-add').click()
  await expect(page.getByTestId('host-network-invite-error')).toHaveCount(0)
  const invite = page.getByTestId('host-network-invite')
  await expect(invite).toHaveAttribute('data-invite-state', 'expired', { timeout: 15_000 })
  await expect(invite).toContainText('This link expired.')
  await expect(page.getByTestId('host-network-add')).toHaveText('New link')
  await shot(page, '5-expired')
  expect(errors).toEqual([])
})
