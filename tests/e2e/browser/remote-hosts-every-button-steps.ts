/**
 * The longer steps of remote-hosts-every-button.spec.ts: Add host (both ways, a slow and a
 * failing link included, one draft per way in), the join link (closed, shown again, called back),
 * and the groups under More settings. Each takes the spec's context (its sweep and its `ran`,
 * which checks every key against the spec's REGISTRY).
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  WINDOWS_APP, askThenCancel, expectCopied, expectOpensTab, netCommand, netLink, netWindows, openGroup, openMore, shot, type PaneRoutes,
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

export const addButton = (page: Page) => page.locator('[data-testid="remote-hosts-add"]:visible').first()

/** Add host > Join a machine with a link, from the button's menu. */
export async function joinPress(page: Page): Promise<void> {
  await addButton(page).click()
  await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
}

/**
 * A link put away while it still works: the list says how long, in its place, with Cancel link;
 * Cancel link calls it back (Cancelling..., then "Link cancelled." with Close focused), and Close
 * gives the focus back to Add host (2026-11-04 review: Done left the link working, unseen).
 */
export async function callBack(ctx: StepCtx, id: string): Promise<void> {
  const { page, routes } = ctx
  const closed = page.getByTestId('host-network-closed')
  if (await page.getByTestId('host-network-invite').count()) await page.getByTestId('host-network-done').click()
  await expect(closed).toHaveAttribute('data-invite-state', 'waiting')
  await expect(closed).toContainText(/Link still works for \d+ min\./)
  // It names the menu item by its own words (the review: "Join with a link shows it again").
  await expect(closed).toContainText('Add host, Join a machine with a link, shows it again.')
  const cancel = closed.getByTestId('host-network-cancel')
  const deletes = routes.callsTo('DELETE', `/api/hosts/net/invites/${id}`).length
  const release = routes.gate('cancel')
  await cancel.click()
  await expect(cancel).toHaveText('Cancelling...')
  release()
  await routes.nth('DELETE', `/api/hosts/net/invites/${id}`, deletes + 1)
  await expect(closed).toHaveAttribute('data-invite-state', 'cancelled')
  await expect(closed).toContainText('Link cancelled.')
  await expect(closed).toContainText('No machine can join with it now.')
  const done = closed.getByTestId('host-network-closed-done')
  await expectRing(page, done)
  await ctx.sweep()
  await done.click()
  await expect(closed).toHaveCount(0)
  await expectRing(page, addButton(page))
  ctx.ran('Hosts/button#host-network-cancel', 'Hosts/button#host-network-closed-done')
}

/** Add host: a menu with two ways in, each landing in view at the top of the list; one draft per way in. */
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
  // From the keyboard (Enter, Space, or ArrowDown on the closed button) the first item is
  // highlighted at once, so Enter runs it (2026-11-04 review: nothing was).
  for (const key of ['Enter', 'Space', 'ArrowDown']) {
    await addButton(page).focus()
    await page.keyboard.press(key)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toHaveClass(/\bfocused\b/)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(addButton(page)).toBeFocused()
  }
  // A scroll closes the menu; the focus stays on the button, also when the scroll moved it into
  // the sticky bar (2026-11-04 review: it fell to the page).
  await addButton(page).click()
  await expect(menu).toBeVisible()
  // The menu hears scrolls from the frame after it opened (ContextMenu.tsx): wait that frame out,
  // as a person always does (WebKit's frames came half a second apart under load).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  // A scroll the pane can make from where it stands (WebKit's pane may sit at its end already).
  await page.locator('.settings-pane').first().evaluate((el) => {
    const max = el.scrollHeight - el.clientHeight
    el.scrollTop += el.scrollTop > max / 2 ? -Math.min(24, el.scrollTop) : Math.min(24, max - el.scrollTop)
  })
  await expect(menu).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()

  // A link: "Making a link..." at once, in view and focused, while the link is made (2026-11-04
  // review: a slow host network showed nothing for 2.5 s); then the link, its Copy focused.
  const n = routes.invites + 1
  const release = routes.gate('invite')
  await addButton(page).click()
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

  // An SSH host: the untouched link closes (it still works, and the list says so), and a new row
  // comes at the top of the list, Hostname first and focused, Cancel on it.
  const puts = routes.callsTo('PUT', '/api/config').length
  await addButton(page).click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  const closed = page.getByTestId('host-network-closed')
  await expect(page.getByTestId('host-network-invite')).toHaveCount(0)
  await expect(closed).toHaveAttribute('data-invite-state', 'waiting')
  const hostname = page.locator('input[id^="rh-hostname-"]')
  const alias = page.locator('input[id^="rh-alias-"]')
  await expect(hostname).toHaveCount(1)
  await expect(hostname).toHaveValue('')
  await expect(hostname).toBeFocused()
  await expect(hostname).toBeInViewport()
  const draft = page.locator('#remote-hosts .rh-host-row[data-unsaved="true"]')
  await expect(draft).toHaveCount(1)
  await expect(draft.getByTestId('rh-row-state')).toHaveText('Add a hostname to save this host.')
  // It is the new host (never "Host 5"); it says Not saved; its one way out is the Cancel on the
  // row, and it has no More menu (nothing in it applies to a host not saved).
  await expect(draft.locator('.rh-host-name')).toHaveText('New SSH host')
  await expect(draft).toContainText('Not saved')
  await expect(draft.getByTestId('rh-row-more')).toHaveCount(0)
  await expect(page.getByTestId('rh-edit').getByRole('button', { name: /^(Cancel|Done)$/ })).toHaveCount(0)
  await expect(draft.getByTestId('rh-draft-cancel')).toHaveText('Cancel')
  // The alias it suggests is one no host has.
  await expect(alias).toHaveAttribute('placeholder', 'buildbox')
  // Tabbing through Alias refuses nothing (2026-11-04 review: "Give it an alias" on the way in).
  await hostname.press('Tab')
  await expect(alias).toBeFocused()
  await alias.press('Tab')
  await expect(page.getByTestId('rh-edit').locator('.settings-row-error')).toHaveCount(0)
  // A second press goes to the same row, at its first empty field (2026-11-04 review: it made
  // Host 5 and Host 6): here Hostname, with User typed.
  await page.locator('input[id^="rh-user-"]').fill('sam')
  await addButton(page).click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  await expect(hostname).toHaveCount(1)
  await expect(hostname).toBeFocused()
  await ctx.sweep()
  await shot(page, `add-host-ssh-row-${page.viewportSize()!.height}`)
  // Escape keeps a row someone typed in (it is not saved yet); Cancel takes it away.
  await hostname.press('Escape')
  await expect(draft).toHaveCount(1)
  await draft.getByTestId('rh-draft-cancel').click()
  await expect(draft).toHaveCount(0)
  await expectRing(page, addButton(page))
  // Escape takes an untouched row away, with no confirm; the focus goes back to Add host.
  await addButton(page).click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  await expect(hostname).toBeFocused()
  await hostname.press('Escape')
  await expect(draft).toHaveCount(0)
  await expectRing(page, addButton(page))
  // Join with a link closes an untouched SSH row, and shows the link that still works again
  // (2026-11-04 review: a second press made a second link while the first still worked).
  await addButton(page).click()
  await menu.getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
  await expect(draft).toHaveCount(1)
  await joinPress(page)
  await expect(draft).toHaveCount(0)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n))
  await expectRing(page, page.getByTestId('host-network-copy'))
  expect(routes.invites).toBe(n)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)
  // Close, then Cancel link: the next run of this check starts with no link.
  await callBack(ctx, `ni-${n}`)
  ctx.ran('Header/button#remote-hosts-add', 'Add host menu/menuitem[join]', 'Add host menu/menuitem[ssh]', 'Hosts/button#rh-draft-cancel', 'Hosts/button#host-network-done')
}

/**
 * The join link made by Add host: each system's way, the notes folded, an expired link, Close and
 * Join again (the same link), Cancel link, and the links that could not be made, each with the
 * fix its reason names (2026-11-04 review: "not running on this Mac" offered only Try again).
 */
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
  await ctx.sweep()
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
  // From the keyboard the arrows move the pick, and the picked one shows its ring (2026-11-05
  // review: WebKit drew none).
  const macSeg = page.getByTestId('host-network-os-mac')
  const linuxSeg = page.getByTestId('host-network-os-linux')
  await macSeg.focus()
  await page.keyboard.press('ArrowRight')
  await expect(card).toHaveAttribute('data-os', 'linux')
  await expect(linuxSeg).toBeFocused()
  expect(await linuxSeg.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.keyboard.press('ArrowLeft')
  await expect(card).toHaveAttribute('data-os', 'mac')
  await expect(macSeg).toBeFocused()
  // Escape there is Close (Sol review: it did nothing, the focus on a hidden radio): the card goes,
  // the link still works and says so (nothing is called back), the focus is on Add host.
  const deletes = routes.calls.filter((c) => c.method === 'DELETE').length
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('host-network-closed')).toContainText(/Link still works for \d+ min\./)
  await expectRing(page, addButton(page))
  expect(routes.calls.filter((c) => c.method === 'DELETE')).toHaveLength(deletes)
  await joinPress(page)
  await expect(cmd).toHaveText(netCommand(n))
  expect(routes.invites).toBe(n)
  ctx.ran(
    'Hosts/radio#host-network-os-mac', 'Hosts/radio#host-network-os-linux', 'Hosts/radio#host-network-os-windows',
    'Hosts/button#host-network-copy', 'Hosts/button#host-network-windows-link-copy', 'Hosts/button#host-network-windows-copy',
    'Hosts/link:Walnut for Windows', 'Hosts/button#host-network-more',
  )

  // Ten minutes later: the link says it expired, and New link makes another.
  routes.expireInvites = true
  // The page reads a waiting link every 3 s; a loaded machine may answer late.
  await expect(card).toHaveAttribute('data-invite-state', 'expired', { timeout: 20_000 })
  await expect(card).toContainText('This link expired.')
  await ctx.sweep()
  routes.expireInvites = false
  await page.getByTestId('host-network-new-link').click()
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 1))
  await expectRing(page, page.getByTestId('host-network-copy'))
  ctx.ran('Hosts/button#host-network-new-link')

  // Close: the list says the link still works, in its place, and the focus goes back to Add host
  // (Sol review: Close and Escape are one act); Join with a link shows the same link again,
  // never a second one.
  await page.getByTestId('host-network-done').click()
  await expect(card).toHaveCount(0)
  const closed = page.getByTestId('host-network-closed')
  await expect(closed).toContainText(/Link still works for \d+ min\./)
  await expectRing(page, addButton(page))
  await ctx.sweep()
  await joinPress(page)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 1))
  await expectRing(page, page.getByTestId('host-network-copy'))
  expect(routes.invites).toBe(n + 1)
  ctx.ran('Hosts/button#host-network-done')
  await callBack(ctx, `ni-${n + 1}`)

  // The host network did not run: the link's place says why, with Start the host network,
  // focused, which starts it and makes the link (2026-11-04 review).
  routes.failInvites = [{ error: 'The host network is not running on this Mac', code: 'net_unavailable' }]
  await joinPress(page)
  const failed = page.getByTestId('host-network-invite-error')
  await expect(failed).toContainText('Could not make a link')
  await expect(failed).toContainText('The host network is not running on this Mac.')
  await expect(failed).toHaveAttribute('data-fix', 'start')
  await expect(card).toHaveCount(0)
  await expect(failed).toBeInViewport()
  await expect(failed).toHaveClass(/rh-row-flash/)
  await expect(page.getByTestId('host-network-error-done')).toHaveText('Close')
  await expect(page.getByTestId('host-network-try-again')).toHaveCount(0)
  const start = page.getByTestId('host-network-start')
  await expectRing(page, start)
  await shot(page, `add-host-link-failed-${page.viewportSize()!.height}`)
  await ctx.sweep()
  const syncs = routes.callsTo('POST', '/api/hosts/net/sync').length
  const started = routes.gate('net-start')
  await start.click()
  await expect(start).toHaveText('Starting...')
  started()
  expect((await routes.nth('POST', '/api/hosts/net/sync', syncs + 1)).body).toEqual({ enable: true })
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 2))
  await expect(failed).toHaveCount(0)
  await expectRing(page, page.getByTestId('host-network-copy'))
  ctx.ran('Hosts/button#host-network-start')
  await callBack(ctx, `ni-${n + 2}`)

  // A reason with no fix of its own (an older server sends no code): Try again, which keeps the
  // focus when it fails again, and Close, which gives it back to Add host.
  const why = 'The cloud companion did not answer'
  routes.failInvites = [{ error: why }, { error: why }]
  await joinPress(page)
  await expect(failed).toHaveAttribute('data-fix', 'retry')
  const again = page.getByTestId('host-network-try-again')
  await expectRing(page, again)
  await ctx.sweep()
  await again.click()
  await expect(failed).toContainText(`${why}.`)
  await expectRing(page, again)
  expect(routes.invites).toBe(n + 2)
  await page.getByTestId('host-network-error-done').click()
  await expect(failed).toHaveCount(0)
  await expectRing(page, addButton(page))
  ctx.ran('Hosts/button#host-network-try-again', 'Hosts/button#host-network-error-done')
  // A link put away for the rest of the run: the list keeps saying it still works.
  await joinPress(page)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n + 3))
  await page.getByTestId('host-network-done').click()
  await expect(closed).toHaveAttribute('data-invite-state', 'waiting')
}

/**
 * More settings: what belongs to the whole page (the relay, the secrets). Open, it is one box with
 * Relay and Secrets inside it as plain groups, no fold of their own (2026-11-05 review: a fold that
 * opened two more folds, drawn as sibling cards); your own relay is said once, and who runs the
 * public relays is a line further, on request (the review: two own-relay rows, and jargon).
 */
export async function checkMoreSettings(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  const toggle = page.getByTestId('remote-hosts-more-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('Relay and secrets. A host\'s own settings are in its Details.')
  // No count of its own: the page has one, in the header (2026-11-04 review: two counts).
  await expect(page.getByTestId('remote-hosts-more-needs')).toHaveCount(0)
  await expect(page.getByTestId('fleet-secrets')).toBeHidden()
  await openMore(page)
  const box = page.getByTestId('remote-hosts-more')
  for (const gone of ['host-network-relay-toggle', 'fleet-secrets-toggle', 'host-network-relay-summary', 'fleet-secrets-summary']) await expect(page.getByTestId(gone)).toHaveCount(0)
  await expect(box.getByTestId('host-network-relay')).toBeVisible()
  await expect(box.getByTestId('fleet-secrets')).toBeVisible()
  // One bordered box around both groups.
  const [outer, relayBox, secretsBox] = await Promise.all([box.boundingBox(), box.getByTestId('host-network-relay').boundingBox(), box.getByTestId('fleet-secrets').boundingBox()])
  for (const inner of [relayBox!, secretsBox!]) {
    expect(inner.x).toBeGreaterThan(outer!.x)
    expect(inner.x + inner.width).toBeLessThan(outer!.x + outer!.width)
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer!.y + outer!.height)
  }
  expect(await box.evaluate((el) => getComputedStyle(el).borderTopStyle)).not.toBe('none')
  await shot(page, 'more-settings-open')
  // The groups that belong to one host are gone from here (their settings are in its Details).
  for (const gone of ['host-servers-toggle', 'host-exec-grants-toggle', 'rh-session-limits-toggle']) await expect(page.getByTestId(gone)).toHaveCount(0)
  await ctx.sweep()
  ctx.ran('Pane/button#remote-hosts-more-toggle')

  await openGroup(page, 'host-network-relay')
  const relay = page.getByTestId('host-network-relay')
  // No companion: your own relay is not a greyed choice, it is said once with the way to get one.
  await expect(relay.locator('[data-relay="own"]')).toHaveCount(0)
  await expect(relay.getByTestId('host-network-relay-own')).toHaveCount(1)
  await expect(relay.getByTestId('host-network-relay-own')).toContainText('Your own relay')
  // Where a companion is paired: a real link to that page, by its name (2026-11-04 review: the
  // text said "Settings > Cloud Companion", a page that is called Phones & Cloud).
  const pair = relay.getByTestId('host-network-relay-pair')
  await expect(pair).toHaveText('Phones & Cloud')
  await expect(pair).toHaveAttribute('href', '/settings#cloud')
  // Plain words; who runs the public relays only on request.
  await expect(relay.locator('[data-relay="public"]')).toContainText('A free public service passes the traffic on')
  await expect(relay).not.toContainText('n0')
  await expect(relay).not.toContainText('iroh')
  const about = relay.getByTestId('host-network-relay-about')
  await expect(about).toHaveAttribute('aria-expanded', 'false')
  await about.click()
  await expect(about).toHaveAttribute('aria-expanded', 'true')
  await expect(relay).toContainText('n0, the makers of iroh')
  await about.click()
  await expect(relay).not.toContainText('n0')
  for (const choice of ['none', 'public'] as const) {
    const radio = relay.locator(`[data-relay="${choice}"]`)
    const puts = routes.callsTo('PUT', '/api/hosts/net/relay').length
    await radio.click()
    expect((await routes.nth('PUT', '/api/hosts/net/relay', puts + 1)).body).toEqual({ relay: choice })
    await expect(radio).toHaveAttribute('aria-checked', 'true')
  }
  await ctx.sweep()
  ctx.ran('Relay/button#host-network-relay-about', 'Relay/radio[relay=public]', 'Relay/radio[relay=none]', 'Relay/link#host-network-relay-pair')
}

export async function checkSecrets(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  // Alpha box's "This host" switched this secret's copy before (remote-hosts-every-button-host.ts).
  const puts = routes.callsTo('PUT', '/api/v1/secrets/github-read').length
  await openGroup(page, 'fleet-secrets')
  const sec = page.getByTestId('fleet-secrets')
  const editor = sec.getByTestId('secret-editor')
  const edit = sec.getByRole('button', { name: 'Edit github-read' })
  await edit.click()
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
  // Escape is Cancel: nothing saved, the focus back on that secret's Edit (2026-11-04 review).
  await value.press('Escape')
  await expect(editor).toHaveCount(0)
  await expectRing(page, edit)
  expect(routes.callsTo('PUT', '/api/v1/secrets/github-read')).toHaveLength(puts)

  // Add focuses Name; Escape is Cancel and gives the focus back to Add.
  const addBtn = sec.getByTestId('secret-add')
  await addBtn.click()
  const name = editor.getByTestId('secret-name')
  await expect(name).toBeFocused()
  await name.press('Escape')
  await expect(editor).toHaveCount(0)
  await expectRing(page, addBtn)
  ctx.ran('Secrets/button#secret-add')
  // An empty Save: the first field it refuses comes into view, focused, with why beside it.
  await addBtn.click()
  await editor.getByTestId('secret-save').click()
  const fieldError = editor.locator('.settings-row-error')
  await expect(fieldError).toHaveText('Give it a name, like github-read.')
  await expect(fieldError).toBeInViewport()
  await expect(name).toBeFocused()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await name.fill('GitHub Read')
  await editor.getByTestId('secret-save').click()
  await expect(fieldError).toHaveText('A name is lower case letters, digits, . _ - (like github-read).')
  // Cancel takes the refusal with it, and so does opening the editor again (Codex review 1).
  await editor.getByTestId('secret-cancel').click()
  await expect(editor).toHaveCount(0)
  await expect(sec.getByText('A name is lower case letters', { exact: false })).toHaveCount(0)
  await expectRing(page, addBtn)
  ctx.ran('Secrets/button#secret-cancel')
  await addBtn.click()
  await expect(name).toBeFocused()
  await expect(editor.locator('.settings-row-error')).toHaveCount(0)
  await name.fill('deploy-key')
  await editor.getByTestId('secret-save').click()
  await expect(fieldError).toHaveText('Paste the value.')
  await expect(editor.getByTestId('secret-value')).toBeFocused()
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
  // Delete asks the page's one way (Cancel focused, no timer); the delete removes the row.
  await askThenCancel(page, routes, sec.getByRole('button', { name: 'Delete github-read' }), 'secret-delete-confirm', 'Delete github-read?')
  await sec.getByRole('button', { name: 'Delete deploy-key' }).click()
  const ask = page.getByTestId('secret-delete-confirm')
  await expect(ask).toContainText('Its copy on every host is removed too.')
  await ctx.sweep()
  await ask.getByTestId('secret-delete-confirm-remove').click()
  await routes.nth('DELETE', '/api/v1/secrets/deploy-key', 1)
  await expect(added).toHaveCount(0)
  await expectRing(page, addBtn)
  ctx.ran('Secrets/button:Delete <secret>', 'Secrets/button#secret-delete-confirm-cancel', 'Secrets/button#secret-delete-confirm-remove')
}
