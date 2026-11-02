/**
 * Settings › Remote Hosts › Machines that joined with a link (HostNetworkGroup.tsx;
 * server: src/web/routes/hosts-net.ts). With none, one line says so; Add a machine shows
 * the command to run on the new machine with Copy and the minutes left, watches the
 * invite, and the machine that joins becomes a row saying how this Mac reaches it;
 * an expired link offers a new one; a refused invite says why; Remove asks once more,
 * sends the DELETE and drops the row; the relay choice says what each one shares, a
 * companion means its relay, without one a pick is sent once and the rows follow it, a
 * refused pick says why, and the invite is a ticket. The server is faked at the route (no companion here;
 * tests/e2e/host-network-e2e.test.ts runs the real one). Navigation is by clicks.
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
const pickerShot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('host-network-relay').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
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

test('the relay choice: what each one shares, a companion means its relay, and without one a pick moves every machine', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let relay = 'own'
  let companion = true
  let failNext = false
  const puts: unknown[] = []
  const machine = { host: 'gpu-box', endpoint: ID, enabled: true, platform: 'linux-x64', path: 'relay', rttMs: 40 }
  await page.route('**/api/hosts/net', (route) => route.fulfill({ json: overview([machine], { companion, relay }) }))
  await page.route('**/api/hosts/net/relay', async (route) => {
    const body = route.request().postDataJSON() as { relay: string }
    puts.push(body)
    if (failNext) {
      failNext = false
      return route.fulfill({ status: 409, json: { error: 'No relay would cut off gpu-box: it reaches this Mac only through a relay or a router. Keep Public relays, or put it on the same network as this Mac first.', code: 'needs_relay' } })
    }
    relay = body.relay
    if (relay === 'none') machine.path = 'direct'
    return route.fulfill({ json: { relay } })
  })
  const TICKET_CMD = 'curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh | sh -s -- wn1-eyJ2IjoxfQ'
  await page.route('**/api/hosts/net/invites', (route) => route.fulfill({
    status: 201, json: { id: 'ni-3', link: 'wn1-eyJ2IjoxfQ', command: TICKET_CMD, expiresAt: Date.now() + 10 * 60_000, state: 'waiting' },
  }))
  await page.route('**/api/hosts/net/invites/ni-3', (route) => route.fulfill({ json: { id: 'ni-3', link: 'wn1-eyJ2IjoxfQ', command: TICKET_CMD, expiresAt: Date.now() + 9 * 60_000, state: 'waiting' } }))

  await openRemoteHosts(page)
  const picker = page.getByTestId('host-network-relay')
  await expect(picker).toBeVisible({ timeout: 30_000 })
  await expect(picker).toContainText('When two machines cannot connect directly, they go through')
  const own = picker.locator('[data-relay="own"]')
  const pub = picker.locator('[data-relay="public"]')
  const none = picker.locator('[data-relay="none"]')
  // A companion: its relay, and the other two say what they share but cannot be picked.
  await expect(own).toHaveAttribute('aria-checked', 'true')
  await expect(own).toContainText('on your cloud companion (wn.example.com). Only your machines use it.')
  await expect(pub).toContainText("They see your machines' internet addresses and which of them talk to each other")
  await expect(none).toContainText('Machines behind two home routers may not connect.')
  await expect(pub).toBeDisabled()
  await expect(none).toBeDisabled()
  await expect(picker).toContainText('While a cloud companion is paired, your machines use its relay.')
  await picker.scrollIntoViewIfNeeded()
  await pickerShot(page, '6-relay-own')
  const row = page.getByTestId('host-network-group').locator('[data-host-alias="gpu-box"]')
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64 · Through your relay · 40 ms')

  // No companion: public relays, and Your relay cannot be picked. Another section and back:
  // the page reads the network again.
  companion = false
  relay = 'public'
  await page.getByTestId('settings-nav-general').click()
  await expect(picker).toHaveCount(0)
  await page.getByTestId('settings-nav-remote-hosts').click()
  await expect(pub).toHaveAttribute('aria-checked', 'true')
  await expect(own).toHaveAttribute('aria-disabled', 'true')
  await expect(own).toBeDisabled()
  await expect(own).toContainText('Pair a cloud companion first (Settings > Cloud Companion).')
  await expect(picker).not.toContainText('While a cloud companion is paired')
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64 · Through a public relay · 40 ms')
  await expect(page.getByTestId('host-network-group')).toContainText('through a public relay that cannot read the traffic')

  // A refused change says why and keeps the choice it had.
  failNext = true
  await none.click()
  await expect(page.getByTestId('host-network-relay-error')).toContainText('Could not change the relay')
  await expect(picker.getByRole('alert')).toContainText('No relay would cut off gpu-box')
  await expect(pub).toHaveAttribute('aria-checked', 'true')

  // No relay: the server is asked once, the choice, the row and the footer follow it.
  await none.click()
  await expect.poll(() => puts.at(-1)).toEqual({ relay: 'none' })
  await expect(none).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('host-network-relay-error')).toHaveCount(0)
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64 · Direct · 40 ms')
  await expect(page.getByTestId('host-network-group')).toContainText('They reach this Mac directly. Only Walnut can use this connection.')

  // The invite is a ticket, and the Mac must stay on while the machine joins.
  await page.getByTestId('host-network-add').click()
  await expect(page.getByTestId('host-network-command')).toHaveText(TICKET_CMD)
  await expect(page.getByTestId('host-network-invite')).toContainText('Keep this Mac awake and online until the machine joins.')
  await page.getByTestId('host-network-group').scrollIntoViewIfNeeded()
  await shot(page, '7-no-companion')
  await picker.scrollIntoViewIfNeeded()
  await pickerShot(page, '8-relay-no-companion')
  expect(errors).toEqual([])
})
