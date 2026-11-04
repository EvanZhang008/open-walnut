/**
 * The longer steps of remote-hosts-every-button.spec.ts: Add host (both ways, a slow and a
 * failing link included), the join link, and the groups under More settings. Each takes the
 * spec's context (its sweep and its `ran`, which checks every key against the spec's REGISTRY).
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  ALPHA_URL, WINDOWS_APP, armThenCancel, expectCopied, expectOpensTab, flip, netCommand, netLink, netWindows, openGroup, openMore, shot, type PaneRoutes,
} from './remote-hosts-every-button-helpers'

export interface StepCtx {
  page: Page
  request: APIRequestContext
  routes: PaneRoutes
  sweep: () => Promise<void>
  ran: (...keys: string[]) => void
}

export const ADD_ITEMS = [/^Join a machine with a link/, /^Add an SSH host/]

/** A focus a press put somewhere shows its ring (WebKit draws none for a script's focus by itself). */
export async function expectRing(page: Page, el: ReturnType<Page['locator']>): Promise<void> {
  await expect(el).toBeFocused()
  await expect(el).toHaveAttribute('data-landed', 'true')
  expect(await el.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none')
}

const addButton = (page: Page) => page.locator('[data-testid="remote-hosts-add"]:visible').first()

/** Add host: a menu with two ways in, each landing in view at the top of the list. */
export async function checkAddHost(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  // The pane header's, or the sticky bar's once the pane scrolled (the same button, moved).
  const add = addButton(page)
  const menu = page.getByTestId('remote-hosts-add-menu')
  await add.click()
  await expect(menu).toBeVisible()
  await expect(add).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('menuitem')).toHaveText(ADD_ITEMS)
  // Under the button, right edges aligned (never over it, never off screen).
  const [b, m] = await Promise.all([add.boundingBox(), menu.boundingBox()])
  expect(Math.abs(b!.x + b!.width - (m!.x + m!.width))).toBeLessThanOrEqual(2)
  expect(m!.y).toBeGreaterThanOrEqual(b!.y + b!.height)
  await ctx.sweep()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(add).toBeFocused()

  // A link: "Making a link..." at once, in view and focused, while the link is made (2026-11-04
  // review: a slow host network showed nothing for 2.5 s); then the link, its Copy focused.
  const n = routes.invites + 1
  const release = routes.gate('invite')
  await add.click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
  const making = page.getByTestId('host-network-making')
  await expect(making).toBeVisible()
  await expect(making).toBeInViewport()
  await expect(making).toHaveAttribute('role', 'status')
  await expectRing(page, making)
  await shot(page, `add-host-making-${page.viewportSize()!.height}`)
  release()
  await expect(making).toHaveCount(0)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n))
  await expect(page.getByTestId('host-network-invite')).toBeInViewport()
  await expectRing(page, page.getByTestId('host-network-copy'))
  expect(routes.invites).toBe(n)
  await shot(page, `add-host-join-${page.viewportSize()!.height}`)

  // An SSH host: a new row at the top of the list, Hostname first and focused, Cancel on it.
  const puts = routes.callsTo('PUT', '/api/config').length
  await add.click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  const hostname = page.locator('input[id^="rh-hostname-"]')
  await expect(hostname).toHaveCount(1)
  await expect(hostname).toHaveValue('')
  await expect(hostname).toBeFocused()
  await expect(hostname).toBeInViewport()
  const draft = page.locator('#remote-hosts .rh-host-row').filter({ hasText: 'Add a hostname and an alias to save this host.' })
  await expect(draft).toHaveCount(1)
  // It is the new host (never "Host 5"), and its one way out is the Cancel on the row.
  await expect(draft.locator('.rh-host-name')).toHaveText('New SSH host')
  await expect(page.getByTestId('rh-edit').getByRole('button', { name: /^(Cancel|Done)$/ })).toHaveCount(0)
  await expect(draft.getByTestId('rh-draft-cancel')).toHaveText('Cancel')
  // The alias it suggests is one no host has.
  await expect(page.locator('input[id^="rh-alias-"]')).toHaveAttribute('placeholder', 'buildbox')
  // A second press goes to the same empty row (2026-11-04 review: it made Host 5 and Host 6).
  await hostname.press('Shift+Tab')
  await add.click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  await expect(hostname).toHaveCount(1)
  await expect(hostname).toBeFocused()
  await ctx.sweep()
  await shot(page, `add-host-ssh-row-${page.viewportSize()!.height}`)
  // Escape takes the untouched row away, with no confirm; the focus goes back to Add host.
  await hostname.press('Escape')
  await expect(draft).toHaveCount(0)
  await expectRing(page, add)
  // Cancel does the same.
  await add.click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  await expect(hostname).toBeFocused()
  await draft.getByTestId('rh-draft-cancel').click()
  await expect(draft).toHaveCount(0)
  await expectRing(page, add)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)
  ctx.ran('Header/button#remote-hosts-add', 'Add host menu/menuitem[join]', 'Add host menu/menuitem[ssh]', 'Hosts/button#rh-draft-cancel')
}

/** The join link made by Add host: each system's way, the notes folded, a failed second link, Done. */
export async function checkJoinLink(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  const card = page.getByTestId('host-network-invite')
  const n = routes.invites
  await expect(card).toHaveAttribute('data-os', 'mac')
  await expect(card).toContainText('In Terminal on the new Mac:')
  await expect(page.getByTestId('host-network-wait')).toContainText('The link works once, for 10 minutes')
  // The command box wraps (no scrollbar), and its Copy is the page's one Copy look.
  const cmd = page.getByTestId('host-network-command')
  expect(await cmd.evaluate((el) => [getComputedStyle(el).whiteSpace, el.scrollWidth <= el.clientWidth + 1])).toEqual(['pre-wrap', true])
  await expect(page.getByTestId('host-network-copy')).toHaveClass(/settings-button-default/)
  await expectCopied(page, page.getByTestId('host-network-copy'), netCommand(n))
  await page.getByTestId('host-network-os-linux').click()
  await expect(card).toHaveAttribute('data-os', 'linux')
  await expect(card).toContainText('In a terminal on the new machine:')
  await expect(cmd).toHaveText(netCommand(n))
  await page.getByTestId('host-network-os-windows').click()
  await expect(card).toHaveAttribute('data-os', 'windows')
  await expect(cmd).toHaveCount(0)
  await expectCopied(page, page.getByTestId('host-network-windows-link-copy'), netLink(n))
  await expectOpensTab(page, card.getByRole('link', { name: 'Walnut for Windows' }), WINDOWS_APP)
  const more = page.getByTestId('host-network-more')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('host-network-windows-command')).toBeHidden()
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(card).toContainText('You pick the relay under More settings.')
  await expectCopied(page, page.getByTestId('host-network-windows-copy'), netWindows(n))
  await ctx.sweep()
  await more.click()
  await expect(page.getByTestId('host-network-windows-command')).toBeHidden()
  await page.getByTestId('host-network-os-mac').click()
  await expect(card).toHaveAttribute('data-os', 'mac')
  ctx.ran(
    'Hosts/radio#host-network-os-mac', 'Hosts/radio#host-network-os-linux', 'Hosts/radio#host-network-os-windows',
    'Hosts/button#host-network-copy', 'Hosts/button#host-network-windows-link-copy', 'Hosts/button#host-network-windows-copy',
    'Hosts/link:Walnut for Windows', 'Hosts/button#host-network-more',
  )

  // Ten minutes later: the link says it expired, and New link makes another.
  routes.expireInvites = true
  await expect(card).toHaveAttribute('data-invite-state', 'expired', { timeout: 10_000 })
  await expect(card).toContainText('This link expired.')
  await ctx.sweep()
  routes.expireInvites = false
  await page.getByTestId('host-network-new-link').click()
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 1))
  await expectRing(page, page.getByTestId('host-network-copy'))
  ctx.ran('Hosts/button#host-network-new-link')

  // A second link that fails takes the first one's place, says why, and Try again holds the
  // focus with the whole row flashed (2026-11-04 review: the old link stayed, still waiting).
  routes.failInvites = 1
  await addButton(page).click()
  await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
  const failed = page.getByTestId('host-network-invite-error')
  await expect(failed).toContainText('Could not make a link')
  await expect(failed).toContainText('The host network is not running on this Mac.')
  await expect(card).toHaveCount(0)
  await expect(failed).toBeInViewport()
  await expect(failed).toHaveClass(/rh-row-flash/)
  const again = page.getByTestId('host-network-try-again')
  await expectRing(page, again)
  await shot(page, `add-host-link-failed-${page.viewportSize()!.height}`)
  await ctx.sweep()
  await again.click()
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 2))
  await expect(failed).toHaveCount(0)
  await expectRing(page, page.getByTestId('host-network-copy'))
  ctx.ran('Hosts/button#host-network-try-again')
  // Done on the error puts it away; Done on a link too. The focus goes back to Add host.
  routes.failInvites = 1
  await addButton(page).click()
  await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
  await page.getByTestId('host-network-error-done').click()
  await expect(failed).toHaveCount(0)
  await expectRing(page, addButton(page))
  ctx.ran('Hosts/button#host-network-error-done')
  await addButton(page).click()
  await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
  await expectRing(page, page.getByTestId('host-network-copy'))
  await page.getByTestId('host-network-done').click()
  await expect(card).toHaveCount(0)
  await expectRing(page, addButton(page))
  ctx.ran('Hosts/button#host-network-done')
}

/** More settings: closed with what is inside and what needs a look; each group one line with its summary. */
export async function checkMoreSettings(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  const toggle = page.getByTestId('remote-hosts-more-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('Relay, Walnut on a host, tasks using other hosts, secrets, session limits.')
  // Beta box's tunnel retries: the closed fold says something inside needs a look.
  await expect(page.getByTestId('remote-hosts-more-needs')).toHaveText(/^\d+ needs? a look$/)
  await expect(page.getByTestId('host-servers-toggle')).toBeHidden()
  await openMore(page)
  // Open, each group is one line that says what it holds (2026-11-04 review: five groups ran down the page).
  await expect(page.getByTestId('host-network-relay-summary')).toHaveText('Public relays')
  await expect(page.getByTestId('host-servers-summary')).toHaveText(/^On for 2 of 2 hosts, \d+ needs? a look$/)
  await expect(page.getByTestId('host-exec-grants-summary')).toHaveText('1 task allowed, 1 declined')
  await expect(page.getByTestId('fleet-secrets-summary')).toHaveText('1 secret')
  await expect(page.getByTestId('rh-session-limits-summary')).toHaveText('Alpha box: 3')
  // All five lines fit in the window under the opened fold.
  await expect(page.getByTestId('rh-session-limits-toggle')).toBeInViewport()
  await ctx.sweep()
  ctx.ran('Pane/button#remote-hosts-more-toggle')

  await openGroup(page, 'host-network-relay')
  const relay = page.getByTestId('host-network-relay')
  const own = relay.locator('[data-relay="own"]')
  await expect(own).toBeDisabled()
  await expect(own).toContainText('Pair a cloud companion first')
  for (const choice of ['none', 'public'] as const) {
    const radio = relay.locator(`[data-relay="${choice}"]`)
    const puts = routes.callsTo('PUT', '/api/hosts/net/relay').length
    await radio.click()
    expect((await routes.nth('PUT', '/api/hosts/net/relay', puts + 1)).body).toEqual({ relay: choice })
    await expect(radio).toHaveAttribute('aria-checked', 'true')
  }
  await ctx.sweep()
  ctx.ran('Relay/button#host-network-relay-toggle', 'Relay/radio[relay=own]', 'Relay/radio[relay=public]', 'Relay/radio[relay=none]')
}

export async function checkHostServers(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  await openGroup(page, 'host-servers')
  ctx.ran('Walnut on a host/button#host-servers-toggle')
  const saw = (key: string, take: (b: Record<string, unknown>) => unknown, want: (on: boolean) => unknown, also?: (on: boolean) => Promise<void>) => {
    const base = routes.callsTo('PUT', `/api/host-servers/${key}`).length
    let k = 0
    return async (on: boolean) => {
      expect(take((await routes.nth('PUT', `/api/host-servers/${key}`, base + ++k)).body as Record<string, unknown>)).toEqual(want(on))
      await also?.(on)
    }
  }
  await expectOpensTab(page, page.getByTestId('host-server-url-devbox'), ALPHA_URL)
  await expectCopied(page, page.getByTestId('host-server-copy-url-devbox'), ALPHA_URL)
  ctx.ran('Walnut on a host/link#host-server-url-<host>', 'Walnut on a host/button#host-server-copy-url-<host>')

  // The 11 copy switches fold behind one line that says how many are on.
  const kept = page.getByTestId('host-server-copies-toggle-devbox')
  await expect(kept).toContainText('All 11 kinds copied')
  // Folded rows stay mounted (hidden), like every SettingsDisclosure.
  const copies = page.locator('[data-testid^="host-server-copy-devbox-"][role="switch"]')
  await expect(copies.first()).toBeHidden()
  await kept.click()
  await expect(kept).toHaveAttribute('aria-expanded', 'true')
  await expect(copies).toHaveCount(11)
  for (const sw of await copies.all()) await expect(sw).toBeVisible()
  await ctx.sweep()
  for (const id of await copies.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))) {
    const kind = id.replace('host-server-copy-devbox-', '')
    // The line counts the switches that are on (one off can take a kind riding with it along).
    await flip(page.getByTestId(id), saw('devbox', (b) => (b.copies as Record<string, boolean>)[kind], (on) => on, async () => {
      await expect.poll(async () => {
        const n = await copies.evaluateAll((els) => els.filter((el) => el.getAttribute('aria-checked') === 'true').length)
        const text = (await kept.textContent()) ?? ''
        return text.includes(n === 11 ? 'All 11 kinds copied' : `${n} of 11 copied`)
      }).toBe(true)
    }))
  }
  await kept.click()
  await expect(copies.first()).toBeHidden()
  ctx.ran('Walnut on a host/button#host-server-copies-toggle-<host>', 'Walnut on a host/switch#host-server-copy-<host>-<kind>')
  await flip(page.getByTestId('host-server-expose-devbox'), saw('devbox', (b) => (b.expose as { enabled: boolean }).enabled, (on) => on))
  ctx.ran('Walnut on a host/switch#host-server-expose-<host>')
  await flip(page.getByTestId('host-server-enabled-downbox'), saw('downbox', (b) => b.enabled, (on) => on))
  ctx.ran('Walnut on a host/switch#host-server-enabled-<host>')

  const tunnelRetry = page.getByTestId('host-server-tunnel-retry-downbox')
  await tunnelRetry.click()
  await expect(page.getByTestId('host-server-tunnel-state-downbox')).toHaveText('Starting Test tunnel...')
  expect(routes.callsTo('POST', '/api/host-servers/downbox/expose/retry')).toHaveLength(1)
  ctx.ran('Walnut on a host/button#host-server-tunnel-retry-<host>')

  // A running Walnut on an older build: its button says what it does (2026-11-04 review: "Try again").
  const retry = page.getByTestId('host-server-retry-devbox')
  await expect(retry).toHaveText('Update to this build')
  const release = routes.gate('host-server')
  await retry.click()
  await expect(page.getByTestId('host-server-enabled-devbox')).toHaveAttribute('aria-busy', 'true')
  release()
  await expect(page.getByTestId('host-server-state-devbox')).toHaveText('Starting the new build...')
  await expect(retry).toHaveCount(0)
  ctx.ran('Walnut on a host/button#host-server-retry-<host>')
}

export async function checkExecGrants(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  await openGroup(page, 'host-exec-grants')
  ctx.ran('Tasks using other hosts/button#host-exec-grants-toggle')
  const ex = page.getByTestId('host-exec-grants')
  // This Mac is a name here like every other host's (2026-11-04 review: "this Mac" and "This Mac").
  await expect(ex.locator('[data-exec-host="__local__"] .settings-row-label')).toHaveText('This Mac')
  const sw = ex.getByRole('switch', { name: 'Tasks on other hosts may use Alpha box' })
  const execRow = ex.locator('[data-exec-host="devbox"]')
  await expect(execRow).not.toContainText('Off:')
  const base = routes.callsTo('PUT', '/api/v1/host-exec/hosts/devbox').length
  let k = 0
  await flip(sw, async (on) => {
    expect((await routes.nth('PUT', '/api/v1/host-exec/hosts/devbox', base + ++k)).body).toEqual({ closed: !on })
    // Only an Off host explains itself: the group's one line says what On means.
    if (on) await expect(execRow).not.toContainText('Off:')
    else await expect(execRow).toContainText('Off: nothing new starts there from another host.')
  })
  ctx.ran('Tasks using other hosts/switch:Tasks on other hosts may use <host>')
  await ex.getByRole('button', { name: 'Revoke Nightly build on Alpha box' }).click()
  await routes.nth('DELETE', '/api/v1/host-exec/grants/g-1', 1)
  await expect(ex.locator('[data-grant-id="g-1"]')).toHaveCount(0)
  ctx.ran('Tasks using other hosts/button:Revoke <task> on <host>')
  await ctx.sweep()
  await ex.getByRole('button', { name: 'Allow Lint job on Beta box' }).click()
  expect((await routes.nth('POST', '/api/v1/host-exec/grants', 1)).body).toEqual({ task_id: 'task-lint', host: 'downbox' })
  await expect(ex.locator('[data-denied]')).toHaveCount(0)
  await expect(ex.getByRole('button', { name: 'Revoke Lint job on Beta box' })).toBeVisible()
  ctx.ran('Tasks using other hosts/button:Allow <task> on <host>')
  await ctx.sweep()
}

export async function checkSecrets(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  await openGroup(page, 'fleet-secrets')
  ctx.ran('Secrets/button#fleet-secrets-toggle')
  const sec = page.getByTestId('fleet-secrets')
  const editor = sec.getByTestId('secret-editor')
  await sec.getByRole('button', { name: 'Edit github-read' }).click()
  await expect(editor).toContainText('Value of github-read')
  await expect(editor.getByTestId('secret-value-saved')).toContainText('Saved in secrets, never synced.')
  // The Mac's own box is named as everywhere on the page.
  await expect(editor.getByRole('checkbox', { name: /^This Mac\b/ })).toHaveAttribute('data-testid', 'secret-host-__local__')
  await ctx.sweep()
  ctx.ran('Secrets/button:Edit <secret>')
  await editor.getByRole('button', { name: 'Replace' }).click()
  const value = editor.getByTestId('secret-value')
  await expect(value).toBeFocused()
  ctx.ran('Secrets/button:Replace')
  await value.fill('s3cret-value')
  const eye = editor.locator('button.secret-toggle')
  await eye.click()
  await expect(value).toHaveAttribute('type', 'text')
  await expect(eye).toHaveText('Hide')
  await ctx.sweep()
  await eye.click()
  await expect(value).toHaveAttribute('type', 'password')
  ctx.ran('Secrets/button.secret-toggle')
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toHaveCount(0)
  ctx.ran('Secrets/button:Cancel')

  // Add focuses Name; a refused Save says why under the field it is about, and focuses it.
  await sec.getByTestId('secret-add').click()
  const name = editor.getByTestId('secret-name')
  await expect(name).toBeFocused()
  ctx.ran('Secrets/button#secret-add')
  await editor.getByTestId('secret-save').click()
  const fieldError = editor.locator('.settings-row-error')
  await expect(fieldError).toHaveText('A name is lower case letters, digits, . _ - (like github-read).')
  await expect(fieldError).toBeInViewport()
  await expect(name).toBeFocused()
  // Cancel takes the refusal with it, and so does opening the editor again (Codex review 1).
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toHaveCount(0)
  await expect(sec.getByText('A name is lower case letters', { exact: false })).toHaveCount(0)
  await sec.getByTestId('secret-add').click()
  await expect(name).toBeFocused()
  await expect(editor.locator('.settings-row-error')).toHaveCount(0)
  await name.fill('deploy-key')
  await editor.getByTestId('secret-value').fill('v4lue')
  const toAlpha = editor.getByTestId('secret-host-devbox')
  await toAlpha.click()
  await expect(toAlpha).toBeChecked()
  const sessions = editor.getByTestId('secret-sessions')
  await sessions.click()
  await expect(sessions).toBeChecked()
  await ctx.sweep()
  await editor.getByTestId('secret-save').click()
  await expect(fieldError).toHaveText('Sessions get it as an environment variable: give its name (GH_TOKEN).')
  await expect(editor.getByTestId('secret-env')).toBeFocused()
  await editor.getByTestId('secret-env').fill('deploy_token')
  await editor.getByTestId('secret-save').click()
  expect((await routes.nth('PUT', '/api/v1/secrets/deploy-key', 1)).body).toEqual({ value: 'v4lue', create: true, hosts: ['devbox'], env: 'DEPLOY_TOKEN', sessions: true, description: '' })
  await expect(editor).toHaveCount(0)
  const added = sec.locator('[data-secret-name="deploy-key"]')
  await expect(added).toBeVisible()
  ctx.ran('Secrets/button#secret-save', 'Secrets/checkbox#secret-host-<host>', 'Secrets/checkbox#secret-sessions')
  await armThenCancel(routes, sec.locator('[data-secret-name="github-read"] button[data-armed]'), 'Delete', 'Confirm delete')
  await ctx.sweep()
  const del = added.locator('button[data-armed]')
  await del.click()
  await del.click()
  await routes.nth('DELETE', '/api/v1/secrets/deploy-key', 1)
  await expect(added).toHaveCount(0)
  ctx.ran('Secrets/button:Delete <secret>')
}

export async function checkSessionLimits(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  await openGroup(page, 'rh-session-limits')
  ctx.ran('Session limits/button#rh-session-limits-toggle')
  // Hosts by their names, and a host picked from a list (2026-11-04 review: "devbox", typed).
  const limitRow = page.locator('[data-limit-host="devbox"]')
  await expect(limitRow.locator('.settings-row-label')).toHaveText('Alpha box')
  const puts = routes.callsTo('PUT', '/api/config').length
  await limitRow.getByRole('button', { name: 'Remove the limit for Alpha box' }).click()
  await expect(limitRow).toHaveCount(0)
  expect((await routes.nth('PUT', '/api/config', puts + 1)).body as { session_limits: unknown }).toHaveProperty('session_limits', {})
  ctx.ran('Session limits/button:Remove the limit for <host>')
  const add = page.locator('.rh-limit-add').getByRole('button', { name: 'Add', exact: true })
  await expect(add).toBeDisabled()
  const picker = page.locator('#rh-limit-new-host')
  const offered = await picker.locator('option:not([disabled])').allTextContents()
  expect(offered.slice(0, 1)).toEqual(['This Mac'])
  expect(offered).toEqual(expect.arrayContaining(['Alpha box', 'Beta box']))
  expect(offered).not.toContain('devbox')
  await picker.selectOption('devbox')
  await page.locator('#rh-limit-new-max').fill('4')
  await add.click()
  await expect(page.locator('#rh-limit-devbox')).toHaveValue('4')
  expect(((await routes.nth('PUT', '/api/config', puts + 2)).body as { session_limits: unknown }).session_limits).toEqual({ devbox: 4 })
  ctx.ran('Session limits/combobox#rh-limit-new-host', 'Session limits/button:Add')
  await ctx.sweep()
}
