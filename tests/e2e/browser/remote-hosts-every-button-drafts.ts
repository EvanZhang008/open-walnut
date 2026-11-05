/**
 * A new SSH host in remote-hosts-every-button.spec.ts (2026-11-04 review: "typed input is never
 * lost"): its alias follows the hostname, a taken alias is refused, an alias typed away is said
 * once it is left, the save says Saving... then Saved and the summary counts it at once; and a
 * row not saved yet outlives leaving the pane (it is kept for the browser session), while the
 * other hosts' changes still save. The wide
 * window's page is checked here too: it grows past today's 680 px column, with the sticky bar's
 * actions on its edge.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect } from '@playwright/test'
import { openRemoteHosts } from './host-problems-fixture-helpers'
import { netCommand, openGroup, openMore, pick, row } from './remote-hosts-every-button-helpers'
import { ADD_ITEMS, addButton, joinPress, type StepCtx } from './remote-hosts-every-button-steps'

const addSsh = async (ctx: StepCtx) => {
  await addButton(ctx.page).click()
  await ctx.page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
}

export async function checkNewHost(ctx: StepCtx): Promise<void> {
  const { page, routes } = ctx
  const pane = page.locator('#remote-hosts')
  const online = page.getByTestId('rh-summary-online')
  const puts = routes.callsTo('PUT', '/api/config').length
  await addSsh(ctx)
  const hostname = page.locator('input[id^="rh-hostname-"]')
  const alias = page.locator('input[id^="rh-alias-"]')
  const draft = pane.locator('.rh-host-row[data-unsaved="true"]')
  await hostname.fill('dup.example.com')
  // The alias comes from the hostname until one is typed (2026-11-04 review: a hostname with no
  // alias turned into a normal-looking row and was gone with the pane).
  await expect(alias).toHaveValue('dup')
  await expect(draft.getByTestId('rh-row-state')).toHaveText('It saves as dup when you leave the hostname.')
  await alias.fill('devbox')
  const refusal = pane.locator('.settings-row-error', { hasText: 'devbox is already Alpha box. Pick another alias.' })
  await expect(refusal).toBeVisible()
  await expect(alias).toHaveAttribute('aria-invalid', 'true')
  await expect(draft.getByTestId('rh-row-state')).toHaveText('Not saved until it has an alias of its own.')
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

  // Until the save lands the row says Saving..., with no Connect now (2026-11-04 review).
  const release = routes.gate('config-put')
  await alias.fill('labbox')
  await expect(refusal).toHaveCount(0)
  const lab = row(page, 'labbox')
  await expect(lab.getByTestId('rh-row-state')).toHaveText('Saving...')
  await routes.nth('PUT', '/api/config', puts + 1)
  await expect(lab.getByTestId('rh-row-connect')).toHaveCount(0)
  release()
  await expect(lab.getByTestId('rh-row-saved')).toHaveText('Saved.')
  await expect(lab).not.toHaveAttribute('data-unsaved', 'true')
  // Counted at once: a fifth host, not connected yet.
  await expect(online).toHaveText('2 of 5 online')
  const saved = routes.callsTo('PUT', '/api/config')[puts].body as { hosts: Record<string, Record<string, unknown>> }
  expect(saved.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
  expect(saved.hosts.labbox).toMatchObject({ hostname: 'dup.example.com' })
  await expect(lab.getByTestId('rh-row-saved')).toHaveCount(0, { timeout: 6_000 })

  // Remove asks, then takes it away; the focus goes to the next row; the summary moves back.
  await pick(page, lab, 'Done editing')
  await pick(page, lab, 'Remove')
  await page.getByTestId('rh-row-confirm').getByTestId('rh-row-confirm-remove').click()
  await expect(lab).toHaveCount(0)
  const after = (await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(Object.keys(after.hosts)).not.toContain('labbox')
  expect(after.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
  await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^(ssh|fleet|net):/)
  await expect(online).toHaveText('2 of 4 online')
  ctx.ran('Hosts/button#rh-row-confirm-remove')
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
  // An alias of its own: it saves, and is no longer kept as a draft.
  await page.locator('input[id^="rh-alias-"]').fill('keepbox')
  const put = (await routes.nth('PUT', '/api/config', puts + 3)).body as { hosts: Record<string, Record<string, unknown>> }
  expect(put.hosts.keepbox).toMatchObject({ hostname: 'keep.example.com', user: 'sam' })
  await expect(row(page, 'keepbox').getByTestId('rh-row-saved')).toHaveText('Saved.')
  // The kept rows (ssh-draft-store.ts): a saved one is no longer among them.
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('walnut.remote-hosts.ssh-drafts') ?? '')).not.toContain('keep.example.com')
}
