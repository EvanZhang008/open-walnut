/**
 * A new SSH host in remote-hosts-every-button.spec.ts (2026-11-04 review: "typed input is never
 * lost"; 2026-11-05 review: a half-typed host was saved the moment the focus left Hostname, and
 * "not a host!!" saved as a host): a hostname that is no host is refused beside its field; a new
 * row saves only on Add and connect (or Enter in a field), never on leaving a field or on another
 * way in; its alias follows the hostname, a taken alias is refused, an alias typed away is said
 * once it is left; then Saving..., Connecting... (not counted as needing a look while it tries),
 * and a failure that says why in the words of Add; the summary counts it at once. A row not saved
 * yet outlives leaving the pane (it is kept for the browser session), while the other hosts'
 * changes still save. The wide window's page is checked here too: it grows past today's 680 px
 * column, with the sticky bar's actions on its edge.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect } from '@playwright/test'
import { openRemoteHosts } from './host-problems-fixture-helpers'
import { netCommand, openGroup, openMore, pick, row, shot } from './remote-hosts-every-button-helpers'
import { ADD_ITEMS, addButton, callBack, joinPress, type StepCtx } from './remote-hosts-every-button-steps'

const addSsh = async (ctx: StepCtx) => {
  await addButton(ctx.page).click()
  await ctx.page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
}

const FLEET = '2 online, 2 not connected, 1 off, 1 found in ~/.ssh/config, '

export async function checkNewHost(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  const pane = page.locator('#remote-hosts')
  const counts = page.locator('[data-testid="rh-summary"] .rh-summary-line')
  const needs = page.getByTestId('rh-needs-look')
  const needsBefore = (await needs.textContent())!
  const puts = routes.callsTo('PUT', '/api/config').length
  await addSsh(ctx)
  const hostname = page.locator('input[id^="rh-hostname-"]')
  const alias = page.locator('input[id^="rh-alias-"]')
  const user = page.locator('input[id^="rh-user-"]')
  const port = page.locator('input[id^="rh-port-"]')
  const add = page.getByTestId('rh-add-connect')
  const draft = pane.locator('.rh-host-row[data-unsaved="true"]')
  const state = draft.getByTestId('rh-row-state')

  // A hostname that is no host: refused beside its field once it is left, and never saved.
  await hostname.fill('not a host!!')
  await hostname.press('Tab')
  const hostError = pane.locator('.settings-row-error', { hasText: 'A hostname has no spaces. Type one like build7.example.com.' })
  await expect(hostError).toBeVisible()
  await expect(hostname).toHaveAttribute('aria-invalid', 'true')
  await expect(state).toHaveText('Not saved: its hostname is not one Walnut can reach.')
  await shot(page, 'new-host-bad-hostname')
  // Add and connect takes the person back to the field; Enter in it does the same.
  await add.click()
  await expect(hostname).toBeFocused()
  await hostname.press('Enter')
  await expect(hostname).toBeFocused()
  await hostname.fill('build7!.example.com')
  await hostname.press('Tab')
  await expect(pane.locator('.settings-row-error', { hasText: 'A hostname holds letters, digits, dots and dashes only ("!" is not one).' })).toBeVisible()
  // user@host:port is split into its fields when the hostname is left.
  await hostname.fill('sam@dup.example.com:2222')
  await hostname.press('Tab')
  await expect(hostname).toHaveValue('dup.example.com')
  await expect(user).toHaveValue('sam')
  await expect(port).toHaveValue('2222')
  await expect(pane.locator('.rh-edit .settings-row-error')).toHaveCount(0)
  await expect(hostname).not.toHaveAttribute('aria-invalid', 'true')
  // The alias comes from the hostname until one is typed (2026-11-04 review: a hostname with no
  // alias turned into a normal-looking row and was gone with the pane).
  await expect(alias).toHaveValue('dup')
  // Left, it is not saved: a new host saves only on Add and connect.
  await expect(state).toHaveText('Not saved yet: Add and connect saves it.')
  await page.waitForTimeout(1_800)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)

  // Another way in keeps the typed row as it is, unsaved and uncounted (the review: "half" was
  // saved, tagged Needs a look and counted when Join a machine with a link was chosen).
  const n = routes.invites + 1
  await joinPress(page)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n))
  await expect(draft).toHaveCount(1)
  // Escape on the join card closes it, as it does every draft (Sol review), the focus on Add host.
  await page.getByTestId('host-network-copy').press('Escape')
  await expect(page.getByTestId('host-network-invite')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()
  await page.waitForTimeout(1_800)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)
  await expect(counts).toContainText(`6 hosts: ${FLEET}`)
  await expect(draft.getByTestId('rh-look-tag')).toHaveCount(0)
  await expect(needs).toHaveText(needsBefore)
  await callBack(ctx, `ni-${n}`)

  await alias.fill('devbox')
  const refusal = pane.locator('.settings-row-error', { hasText: 'devbox is already Alpha box. Pick another alias.' })
  await expect(refusal).toBeVisible()
  await expect(alias).toHaveAttribute('aria-invalid', 'true')
  await expect(state).toHaveText('Not saved until it has an alias of its own.')
  await expect(draft).toContainText('Not saved')
  // Alpha box keeps its row (and its status): one row has its id.
  await expect(page.locator('[id="rh-host-devbox"]')).toHaveCount(1)
  // A second Add an SSH host goes to this row's refused Alias, not to a new row.
  await addSsh(ctx)
  await expect(hostname).toHaveCount(1)
  await expect(alias).toBeFocused()
  // An alias typed away is said once it is left, not while typing.
  await alias.fill('')
  const empty = pane.locator('.settings-row-error', { hasText: 'Give it an alias, like devbox.' })
  await expect(empty).toHaveCount(0)
  await alias.press('Tab')
  await expect(empty).toBeVisible()
  // Three times the autosave's wait: nothing went out.
  await page.waitForTimeout(1_800)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)

  // An alias of its own, then Enter in the field (Add and connect): Saving... until the save
  // lands, with no Connect now (2026-11-04 review); then it dials, Connecting..., and while it
  // tries it is not counted as needing a look (2026-11-05 review).
  let answer: (() => void) | null = null
  await page.route(/\/api\/hosts\/labbox\/connect$/, async (route) => {
    await new Promise<void>((r) => { answer = r })
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'ssh: Could not resolve hostname dup.example.com: Name or service not known' }) })
  })
  const release = routes.gate('config-put')
  await alias.fill('labbox')
  await expect(refusal).toHaveCount(0)
  await expect(state).toHaveText('Not saved yet: Add and connect saves it.')
  await alias.press('Enter')
  const lab = row(page, 'labbox')
  await expect(lab.getByTestId('rh-row-state')).toHaveText('Saving...')
  await expect(add).toHaveText('Adding...')
  await routes.nth('PUT', '/api/config', puts + 1)
  await expect(lab.getByTestId('rh-row-connect')).toHaveCount(0)
  release()
  await expect(lab).not.toHaveAttribute('data-unsaved', 'true')
  await expect.poll(() => answer !== null).toBe(true)
  await expect(lab.getByTestId('rh-row-state')).toHaveText(/^Connecting to labbox/)
  await expect(lab.getByTestId('rh-look-tag')).toHaveCount(0)
  await expect(needs).toHaveText(needsBefore)
  // One receipt for the save: the header's Saved, none on the row (2026-11-05 review: two at once).
  await expect(lab.getByTestId('rh-row-saved')).toHaveCount(0)
  await expect(page.getByTestId('settings-saved-indicator')).toBeVisible()
  // Counted at once: a seventh host, not connected yet.
  await expect(counts).toContainText('7 hosts: 2 online, 3 not connected, 1 off, 1 found in ~/.ssh/config, ')
  const saved = routes.callsTo('PUT', '/api/config')[puts].body as { hosts: Record<string, Record<string, unknown>> }
  expect(saved.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
  expect(saved.hosts.labbox).toMatchObject({ hostname: 'dup.example.com', user: 'sam', port: 2222 })
  // The dial fails: the row says why, in the words of the button pressed, and what tries again
  // (2026-11-05 review: only "Could not retry right now.", for a Retry nobody pressed).
  answer!()
  await expect(lab.getByTestId('host-fleet-action-error')).toHaveText(
    'Added, but Walnut could not connect: ssh: Could not resolve hostname dup.example.com: Name or service not known. Connect now tries again.',
  )
  await expect(lab).not.toContainText('Could not retry right now')
  await shot(page, 'new-host-dial-failed')
  await page.unroute(/\/api\/hosts\/labbox\/connect$/)

  // Remove asks, then takes it away; the focus goes to the next row; the summary moves back.
  await pick(page, lab, 'Done editing')
  await pick(page, lab, 'Remove')
  await page.getByTestId('rh-row-confirm').getByTestId('rh-row-confirm-remove').click()
  await expect(lab).toHaveCount(0)
  const after = (await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(Object.keys(after.hosts)).not.toContain('labbox')
  expect(after.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
  await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^(ssh|fleet|net):/)
  await expect(counts).toContainText(`6 hosts: ${FLEET}`)
  ctx.ran('Hosts/button#rh-row-confirm-remove', 'Hosts/button#rh-add-connect')
}

export async function checkDraftKept(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  // At 1100 px and wider the page grows past today's 680 px column (2026-11-04 review).
  const inner = page.locator('.settings-pane-inner').filter({ has: page.locator('#remote-hosts') })
  const width = (await inner.boundingBox())!.width
  expect(width).toBeGreaterThan(760)
  expect(width).toBeLessThanOrEqual(920)
  // Scrolled, the header's actions move into the sticky bar, on the same right edge as the page,
  // as new buttons: the one that held the focus keeps it there (2026-11-04 review: the count's
  // second press and a scroll that closed Add host's menu left the focus on the page).
  const scroller = page.locator('.settings-pane').first()
  const sticky = (id: string) => page.locator(`.settings-pane-stickybar.is-compact [data-testid="${id}"]`)
  await page.getByTestId('rh-needs-look').focus()
  await scroller.evaluate((el) => { el.scrollTop = 600 })
  await expect(sticky('rh-needs-look')).toBeVisible()
  await expect(sticky('rh-needs-look')).toBeFocused()
  const edge = async (sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return b.x + b.width }
  expect(Math.abs(await edge('.settings-pane-stickybar.is-compact [data-testid="remote-hosts-add"]') - await edge('[data-testid="remote-hosts-list"]'))).toBeLessThanOrEqual(4)
  await scroller.evaluate((el) => { el.scrollTop = 0 })
  await expect(page.locator('.settings-pane-header [data-testid="rh-needs-look"]')).toBeFocused()
  await addButton(page).click()
  await expect(page.getByTestId('remote-hosts-add-menu')).toBeVisible()
  // The menu hears scrolls from the frame after it opened (ContextMenu.tsx).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await scroller.evaluate((el) => { el.scrollTop = 600 })
  await expect(page.getByTestId('remote-hosts-add-menu')).toHaveCount(0)
  await expect(sticky('remote-hosts-add')).toBeFocused()
  await scroller.evaluate((el) => { el.scrollTop = 0 })

  // A row with a taken alias cannot save: it is what a person leaves the pane with.
  const puts = routes.callsTo('PUT', '/api/config').length
  await addSsh(ctx)
  await page.locator('input[id^="rh-hostname-"]').fill('keep.example.com')
  await page.locator('input[id^="rh-alias-"]').fill('devbox')
  await page.locator('input[id^="rh-user-"]').fill('sam')
  await expect(page.locator('#remote-hosts .rh-host-row[data-unsaved="true"]')).toHaveCount(1)
  // And a join link closed while it still works (review: leaving the pane forgot it, with no way
  // left to call it back, and Join with a link made a second one).
  await joinPress(page)
  await expect(page.getByTestId('host-network-copy')).toBeVisible()
  const made = routes.invites
  await page.getByTestId('host-network-done').click()
  await expect(page.getByTestId('host-network-closed')).toContainText(/Link still works for \d+ min\./)

  // Leave by a real link: More settings > Relay's "Phones & Cloud" (2026-11-04 review: it was
  // the words "Settings > Cloud Companion", for a page that is called Phones & Cloud).
  await openMore(page)
  await openGroup(page, 'host-network-relay')
  await page.getByTestId('host-network-relay-pair').click()
  await expect.poll(() => new URL(page.url()).hash).toBe('#cloud')
  await expect(page.locator('#remote-hosts')).toHaveCount(0)

  // Back: the row is there as it was left, Not saved, the refusal said; nothing was saved.
  await openRemoteHosts(page)
  const draft = page.locator('#remote-hosts .rh-host-row[data-unsaved="true"]')
  await expect(draft).toHaveCount(1)
  await expect(draft).toContainText('Not saved')
  await expect(page.locator('input[id^="rh-hostname-"]')).toHaveValue('keep.example.com')
  await expect(page.locator('input[id^="rh-alias-"]')).toHaveValue('devbox')
  await expect(page.locator('input[id^="rh-user-"]')).toHaveValue('sam')
  await expect(page.locator('#remote-hosts .settings-row-error', { hasText: 'devbox is already Alpha box.' })).toBeVisible()
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)
  // The link is there as it was left, with Cancel link; Join with a link shows that same link.
  const closed = page.getByTestId('host-network-closed')
  await expect(closed).toContainText(/Link still works for \d+ min\./)
  await expect(closed.getByTestId('host-network-cancel')).toBeVisible()
  await joinPress(page)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(made))
  expect(routes.invites).toBe(made)
  await page.getByTestId('host-network-done').click()
  await expect(closed).toBeVisible()
  // The row that cannot save holds back no other change (review: a kept half-typed row stopped
  // every other host's change from saving, with nothing saying so): Alpha box's Turn off saves,
  // without the new row, and Turn on again.
  const alpha = row(page, 'devbox')
  await pick(page, alpha, 'Turn off')
  const off = (await routes.nth('PUT', '/api/config', puts + 1)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(off.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', enabled: false })
  expect(JSON.stringify(off.hosts)).not.toContain('keep.example.com')
  await alpha.getByTestId('rh-turn-on').click()
  const on = (await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(on.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', enabled: true })
  expect(JSON.stringify(on.hosts)).not.toContain('keep.example.com')
  await expect(page.locator('#remote-hosts .rh-host-row[data-unsaved="true"]')).toHaveCount(1)
  // An alias of its own saves nothing by itself; Add and connect saves it, and it is no longer
  // kept as a draft.
  await page.locator('input[id^="rh-alias-"]').fill('keepbox')
  await page.waitForTimeout(1_200)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts + 2)
  await page.getByTestId('rh-add-connect').click()
  const put = (await routes.nth('PUT', '/api/config', puts + 3)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(put.hosts.keepbox).toMatchObject({ hostname: 'keep.example.com', user: 'sam' })
  await expect(row(page, 'keepbox')).not.toHaveAttribute('data-unsaved', 'true')
  await expect(row(page, 'keepbox').getByTestId('rh-row-saved')).toHaveCount(0)
  // The kept rows (ssh-draft-store.ts): a saved one is no longer among them.
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('walnut.remote-hosts.ssh-drafts') ?? '')).not.toContain('keep.example.com')
}
