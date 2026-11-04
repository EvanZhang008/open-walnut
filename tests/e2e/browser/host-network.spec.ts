/**
 * Settings › Remote Hosts: machines that join with a link (useHostNetwork.ts, HostJoinLink.tsx,
 * NetMachineRow.tsx, HostNetworkRelay.tsx; server: src/web/routes/hosts-net.ts). Add host >
 * Join a machine with a link puts the link first in Hosts: the command for the new machine's
 * system with Copy and the minutes left, the notes folded; it watches the invite, and the
 * machine that joins becomes a Hosts row (a Link tag) saying how this Mac reaches it; an
 * expired link offers a new one; a refused invite says why; Remove (its More menu) asks once, sends the
 * DELETE and drops the row; the relay choice (More settings) says what each one shares, a
 * companion means its relay, without one a pick is sent once and the rows follow it, a
 * refused pick says why, and the invite is a ticket. The server is faked at the route (no
 * companion here; tests/e2e/host-network-e2e.test.ts runs the real one). Navigation is by
 * clicks. WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-network'
const ID = 'e'.repeat(64)
const LINK = 'https://wn.example.com/join/K7QM-4XTD-92ZD'
const COMMAND = `curl -fsSL ${LINK} | sh`

async function openRemoteHosts(page: Page) {
  // A fold one test opens (More about this link is remembered) never reaches the next test's boot.
  await isolatePrefs(page)
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
}

/** Add host > Join a machine with a link (the pane's one way to make a link). */
async function joinWithLink(page: Page) {
  await page.locator('[data-testid="remote-hosts-add"]:visible').first().click()
  await page.getByRole('menuitem', { name: /^Join a machine with a link/ }).click()
}

/** The relay picker sits under More settings, in its own fold, both closed by default (open stays open for the tab). */
async function openMore(page: Page) {
  for (const id of ['remote-hosts-more-toggle', 'host-network-relay-toggle']) {
    const toggle = page.getByTestId(id)
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
}

function overview(machines: unknown[], extra: Record<string, unknown> = {}) {
  return { enabled: true, macId: 'a'.repeat(64), relays: ['https://wn.example.com'], syncedAt: Date.now(), error: null, machines, ...extra }
}

const shot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('remote-hosts-list').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}
const pickerShot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('host-network-relay').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test('Join a machine with a link: the command, the countdown, the join, the path, Remove', async ({ page }) => {
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
  const group = page.getByTestId('remote-hosts-list')
  await expect(group).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('host-network-invite')).toHaveCount(0)
  await group.scrollIntoViewIfNeeded()
  await shot(page, '1-empty')

  await joinWithLink(page)
  const invite = page.getByTestId('host-network-invite')
  // The first row of Hosts: the command for a Mac (the default system), then how long it lasts.
  await expect(group.locator('.settings-row').first()).toHaveAttribute('data-testid', 'host-network-invite')
  await expect(invite).toContainText('Run this on the new machine')
  await expect(invite).toContainText('In Terminal on the new Mac:')
  await expect(page.getByTestId('host-network-command')).toHaveText(COMMAND)
  await expect(page.getByTestId('host-network-wait')).toHaveText(/^Waiting for the machine\.\.\. The link works once, for 10 minutes \((9|10):\d\d left\)\./)
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
  await expect(invite).toContainText('It is in the list below.')
  const row = group.locator('[data-host-alias="gpu-box"]')
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64, direct, 31 ms')
  await expect(row).toContainText('Link')
  // A joined link is done: no New link on it (Add host makes the next one).
  await expect(page.getByTestId('host-network-new-link')).toHaveCount(0)
  expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await shot(page, '3-joined')

  // Remove (last in the row's More menu) asks once, naming the machine, then sends the
  // DELETE and the row goes.
  await row.getByTestId('rh-row-more').click()
  await page.getByTestId('rh-row-menu').getByRole('menuitem', { name: 'Remove', exact: true }).click()
  const confirm = page.getByTestId('rh-row-confirm')
  await expect(confirm).toContainText('Remove gpu-box?')
  expect(deleted).toEqual([])
  await confirm.getByTestId('rh-row-confirm-remove').click()
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
  const group = page.getByTestId('remote-hosts-list')
  await expect(group).toBeVisible({ timeout: 30_000 })
  const row = group.locator('[data-net-path="relay"]')
  await expect(row.getByTestId('host-network-path')).toHaveText('macOS arm64, through your relay, 88 ms')
  expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

  await joinWithLink(page)
  // The row names what failed; the reason sits under it.
  await expect(page.getByTestId('host-network-invite-error')).toContainText('Could not make a link')
  await expect(group.getByRole('alert')).toContainText('pair one first')
  await group.scrollIntoViewIfNeeded()
  await shot(page, '4-refused')

  refuse = false
  await joinWithLink(page)
  await expect(page.getByTestId('host-network-invite-error')).toHaveCount(0)
  const invite = page.getByTestId('host-network-invite')
  await expect(invite).toHaveAttribute('data-invite-state', 'expired', { timeout: 15_000 })
  await expect(invite).toContainText('This link expired.')
  await expect(page.getByTestId('host-network-new-link')).toHaveText('New link')
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
  const TICKET_WIN = "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $env:WALNUT_JOIN_TICKET='wn1-eyJ2IjoxfQ'; iex ((New-Object Net.WebClient).DownloadString('https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.ps1'))"
  const ticketInvite = { id: 'ni-3', link: 'wn1-eyJ2IjoxfQ', command: TICKET_CMD, windowsCommand: TICKET_WIN, state: 'waiting' }
  await page.route('**/api/hosts/net/invites', (route) => route.fulfill({ status: 201, json: { ...ticketInvite, expiresAt: Date.now() + 10 * 60_000 } }))
  await page.route('**/api/hosts/net/invites/ni-3', (route) => route.fulfill({ json: { ...ticketInvite, expiresAt: Date.now() + 9 * 60_000 } }))

  await openRemoteHosts(page)
  await openMore(page)
  const picker = page.getByTestId('host-network-relay')
  await expect(picker).toBeVisible({ timeout: 30_000 })
  await expect(picker).toContainText('When two machines that joined with a link cannot connect directly, their traffic goes through the relay picked here.')
  const own = picker.locator('[data-relay="own"]')
  const pub = picker.locator('[data-relay="public"]')
  const none = picker.locator('[data-relay="none"]')
  // A companion: its relay, and the other two say what they share but cannot be picked.
  await expect(own).toHaveAttribute('aria-checked', 'true')
  await expect(own).toContainText('On your cloud companion (wn.example.com). Only your machines use it.')
  await expect(pub).toContainText("They see your machines' internet addresses and which of them talk to each other")
  await expect(none).toContainText('Machines behind two home routers may not connect.')
  await expect(pub).toBeDisabled()
  await expect(none).toBeDisabled()
  await expect(picker).toContainText('While a cloud companion is paired, your machines use its relay.')
  await picker.scrollIntoViewIfNeeded()
  await pickerShot(page, '6-relay-own')
  const row = page.getByTestId('remote-hosts-list').locator('[data-host-alias="gpu-box"]')
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64, through your relay, 40 ms')

  // No companion: public relays, and Your relay cannot be picked. Another section and back:
  // the page reads the network again.
  companion = false
  relay = 'public'
  await page.getByTestId('settings-nav-general').click()
  await expect(picker).toHaveCount(0)
  await page.getByTestId('settings-nav-remote-hosts').click()
  // More settings stays open for this tab.
  await expect(pub).toHaveAttribute('aria-checked', 'true')
  await expect(own).toHaveAttribute('aria-disabled', 'true')
  await expect(own).toBeDisabled()
  await expect(own).toContainText('Pair a cloud companion first (Settings > Cloud Companion).')
  await expect(picker).not.toContainText('While a cloud companion is paired')
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64, through a public relay, 40 ms')

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
  await expect(row.getByTestId('host-network-path')).toHaveText('Linux x86_64, direct, 40 ms')

  // The invite is a ticket, and the Mac must stay on while the machine joins.
  await joinWithLink(page)
  await expect(page.getByTestId('host-network-command')).toHaveText(TICKET_CMD)
  const ticketRow = page.getByTestId('host-network-invite')
  // How the machines reach each other, for the relay picked: under More about this link.
  const more = page.getByTestId('host-network-more')
  await more.click()
  await expect(ticketRow).toContainText('The machine needs no SSH: it reaches this Mac directly. Only Walnut can use this connection. You pick the relay under More settings.')
  // A Windows PC gets its own line, in PowerShell, and the notes say what it needs.
  await page.getByTestId('host-network-os-windows').click()
  await expect(ticketRow).toContainText('In PowerShell on the PC:')
  await expect(page.getByTestId('host-network-windows-command')).toHaveText(TICKET_WIN)
  await expect(ticketRow).toContainText('On Windows, Walnut runs in WSL (Linux inside Windows). A PC without WSL asks once for an administrator to turn it on, then a restart and a new link.')
  const chromiumTicket = page.context().browser()?.browserType().name() === 'chromium'
  if (chromiumTicket) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByTestId('host-network-windows-copy').click()
    await expect(page.getByTestId('host-network-windows-copy')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TICKET_WIN)
  }
  // Each command stays inside the row at this width (one line that scrolls).
  const rowBox = (await ticketRow.boundingBox())!
  const inside = async (id: string) => {
    const b = (await page.getByTestId(id).boundingBox())!
    expect(b.x + b.width, id).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
  }
  await inside('host-network-windows-command')
  await expect(page.getByTestId('host-network-wait')).toContainText('Keep this Mac awake and online until it joins.')
  await page.getByTestId('host-network-os-mac').click()
  await inside('host-network-command')
  await page.getByTestId('remote-hosts-list').scrollIntoViewIfNeeded()
  await shot(page, '7-no-companion')
  await picker.scrollIntoViewIfNeeded()
  await pickerShot(page, '8-relay-no-companion')
  expect(errors).toEqual([])
})

// Once the newest release carries Walnut for Windows, a PC joins with the app: the row says
// where to get it, gives the link to paste in it, says what Windows asks first (the app is not
// signed), and keeps the PowerShell line beside it.
test('Join a machine on Windows: the app, the link to paste in it, and PowerShell under the notes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const APP = 'https://github.com/EvanZhang008/open-walnut/releases/latest/download/Walnut-Setup-x64.exe'
  const WIN = `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm ${LINK}/windows | iex`
  const invite = { id: 'ni-4', link: LINK, command: COMMAND, windowsCommand: WIN, windowsApp: APP, state: 'waiting' }
  await page.route('**/api/hosts/net', (route) => route.fulfill({ json: overview([], { companion: true, relay: 'own' }) }))
  await page.route('**/api/hosts/net/invites', (route) => route.fulfill({ status: 201, json: { ...invite, expiresAt: Date.now() + 10 * 60_000 } }))
  await page.route('**/api/hosts/net/invites/ni-4', (route) => route.fulfill({ json: { ...invite, expiresAt: Date.now() + 9 * 60_000 } }))

  await openRemoteHosts(page)
  await expect(page.getByTestId('remote-hosts-list')).toBeVisible({ timeout: 30_000 })
  await joinWithLink(page)
  const row = page.getByTestId('host-network-invite')
  await expect(row).toHaveAttribute('data-os', 'mac')
  await page.getByTestId('host-network-os-windows').click()
  await expect(row).toHaveAttribute('data-os', 'windows')
  await expect(page.getByTestId('host-network-windows-app')).toContainText('Download Walnut for Windows on the PC, open it, choose Add this PC to my Walnut, and paste this link:')
  await expect(page.getByTestId('host-network-windows-app').getByRole('link', { name: 'Walnut for Windows' })).toHaveAttribute('href', APP)
  await expect(page.getByTestId('host-network-windows-link')).toHaveText(LINK)
  // The signing warning and the PowerShell way are notes, folded under More about this link.
  await expect(page.getByTestId('host-network-windows-command')).toBeHidden()
  await page.getByTestId('host-network-more').click()
  await expect(row).toContainText('The Windows app is not signed yet: when Windows says “Windows protected your PC”, click More info, then Run anyway.')
  await expect(row).toContainText('Or in PowerShell on the PC:')
  await expect(page.getByTestId('host-network-windows-command')).toHaveText(WIN)
  if (page.context().browser()?.browserType().name() === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByTestId('host-network-windows-link-copy').click()
    await expect(page.getByTestId('host-network-windows-link-copy')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINK)
  }
  // Every line stays inside the row.
  const rowBox = (await row.boundingBox())!
  for (const id of ['host-network-windows-app', 'host-network-windows-link', 'host-network-windows-command']) {
    const b = (await page.getByTestId(id).boundingBox())!
    expect(b.x + b.width, id).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
  }
  await page.getByTestId('remote-hosts-list').scrollIntoViewIfNeeded()
  await shot(page, '9-windows-app')
  expect(errors).toEqual([])
})
