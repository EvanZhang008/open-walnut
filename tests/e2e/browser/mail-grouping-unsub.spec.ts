/**
 * The batch unsubscribe checklist (spec 10) on the grouped inbox (design v2), on the `PW_MAIL_GROUPS`
 * fixture: it opens from a group's more (...) menu or its open footer, nothing is ticked until the person ticks
 * it, the dead-end mailto, nothing sent until the main button, each list walked through the existing
 * ladder with its own outcome, Stop after this one, and Esc ignored while a batch runs. The fixture's
 * `unsub-log` is the record of every request that left for a sender.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, MARINA_ADDRESS, api, deliver, getGroups, openGroupLine, openGroupMenu, openGrouped, setUnsubDelay,
  startGroupsFixture, unsubLog, waitLabeled,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

/** The group the fixture's model names `label`, in All Inboxes. */
async function groupNamed(label: string): Promise<{ id: string; label: string; unsubscribable: number }> {
  const groups = await getGroups(fixture, ALL_INBOXES)
  const group = groups.groups.find((one: { label: string }) => one.label === label)
  expect(group, `a ${label} group`).toBeTruthy()
  expect(group.unsubscribable).toBeGreaterThan(0)
  return group
}

async function openPlan(page: Page, groupId: string): Promise<Locator> {
  await openGrouped(page, fixture)
  const menu = await openGroupMenu(page, groupId)
  await menu.getByRole('menuitem', { name: 'Unsubscribe\u2026' }).click()
  const dialog = page.getByTestId('mail-unsub-plan')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  return dialog
}

function item(dialog: Locator, method: string): Locator {
  return dialog.locator(`[data-testid="mail-unsub-item"][data-method="${method}"]`)
}

test('nothing is ticked, the methods say what they do, and nothing leaves without the main button', async ({ page }) => {
  const popups: string[] = []
  page.on('popup', (popup) => popups.push(popup.url()))
  // Newsletters holds the mailto lists and the link-only one (groups-set.mjs).
  const newsletters = await groupNamed('Newsletters')
  const dialog = await openPlan(page, newsletters.id)
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.locator('h2')).toHaveText('Unsubscribe from lists in Newsletters')
  await expect(dialog.getByTestId('mail-unsub-checking')).toHaveCount(0, { timeout: 10_000 })
  await expect(dialog.getByTestId('mail-unsub-pick')).toHaveText('Tick the lists you want to leave. Nothing is sent until you press Unsubscribe.')
  const checks = dialog.getByTestId('mail-unsub-check')
  expect(await checks.count()).toBeGreaterThan(0)
  for (const one of await checks.all()) await expect(one).not.toBeChecked()
  await expect(dialog.getByTestId('mail-unsub-submit')).toBeDisabled()
  const mailto = dialog.locator('[data-testid="mail-unsub-item"][data-method="mailto"][data-kind="checkable"]').first()
  await expect(mailto.getByTestId('mail-unsub-method')).toHaveText('email')
  await expect(mailto.getByTestId('mail-unsub-from')).toHaveText(`sends an email from ${MARINA_ADDRESS}`)
  const link = item(dialog, 'link').first()
  await expect(link.getByTestId('mail-unsub-method')).toHaveText('web page \u00b7 Walnut visits the page')
  // The dialog stays inside the viewport and is the width the spec says.
  const box = (await dialog.boundingBox())!
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  expect(box.width).toBeLessThanOrEqual(480)
  // Ticking counts on the button; unticking puts it back.
  await mailto.getByTestId('mail-unsub-check').check()
  await expect(dialog.getByTestId('mail-unsub-submit')).toHaveText('Unsubscribe from 1')
  await link.getByTestId('mail-unsub-check').check()
  await expect(dialog.getByTestId('mail-unsub-submit')).toHaveText('Unsubscribe from 2')
  await shoot(dialog, SHOTS, 'unsub-plan')
  await link.getByTestId('mail-unsub-check').uncheck()
  await mailto.getByTestId('mail-unsub-check').uncheck()
  await dialog.getByTestId('mail-unsub-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect((await unsubLog(fixture)).calls).toBe(0)
  const { body } = await api(fixture, `/messages?scope=role:inbox&group=${encodeURIComponent(newsletters.id)}&limit=200`)
  expect(body.messages.every((one: { unsubscribe?: { attempt?: unknown; done?: unknown } }) => !one.unsubscribe?.attempt && !one.unsubscribe?.done)).toBe(true)
  expect(popups).toEqual([])
})

test('the open group\'s footer opens the same checklist, and Esc closes it', async ({ page }) => {
  const shopping = await groupNamed('Shopping')
  await openGrouped(page, fixture)
  const group = await openGroupLine(page, shopping.id)
  await group.getByTestId('mail-group-unsubscribe').click()
  const dialog = page.getByTestId('mail-unsub-plan')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog.locator('h2')).toHaveText('Unsubscribe from lists in Shopping')
  await expect(item(dialog, 'one-click').first().getByTestId('mail-unsub-method')).toHaveText('one-click')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(group.getByTestId('mail-group-unsubscribe')).toBeFocused()
  expect((await unsubLog(fixture)).calls).toBe(0)
})

test('the ferry account cannot send: its mailto offers Copy address and the mail app', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  // A newsletter whose only way out is a mailto:, on the account that cannot send.
  await deliver(fixture, 1, { account: 'ferry', kind: 'list' })
  await expect.poll(async () => (await getGroups(fixture, { accountId: FERRY, mailboxId: 'INBOX' })).groups
    .some((one: { label: string; unsubscribable: number }) => one.label === 'Newsletters' && one.unsubscribable > 0), { timeout: 60_000 }).toBe(true)
  await waitLabeled(fixture, ALL_INBOXES)
  const dialog = await openPlan(page, (await groupNamed('Newsletters')).id)
  await expect(dialog.getByTestId('mail-unsub-checking')).toHaveCount(0, { timeout: 10_000 })
  const dead = dialog.locator('[data-testid="mail-unsub-item"][data-kind="cannot-send"]').first()
  await expect(dead).toBeVisible()
  await expect(dead.getByTestId('mail-unsub-check')).toBeDisabled()
  await expect(dead.getByTestId('mail-unsub-method')).toContainText("can't send from this account")
  await expect(dead.getByTestId('mail-unsub-open-app')).toHaveAttribute('href', /^mailto:/)
  await dead.getByTestId('mail-unsub-copy').click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(/^[^:?\s]+@[^?\s]+$/)
  expect((await unsubLog(fixture)).calls).toBe(0)
  await dialog.getByTestId('mail-unsub-cancel').click()
})

test('the batch walks each ticked list in turn, Stop after this one leaves the rest waiting', async ({ page }) => {
  const newsletters = await groupNamed('Newsletters')
  const dialog = await openPlan(page, newsletters.id)
  await expect(dialog.getByTestId('mail-unsub-checking')).toHaveCount(0, { timeout: 10_000 })
  const checkable = dialog.locator('[data-testid="mail-unsub-item"][data-kind="checkable"]')
  const total = await checkable.count()
  expect(total).toBeGreaterThanOrEqual(2)
  for (const one of await checkable.all()) await one.getByTestId('mail-unsub-check').check()
  await expect(dialog.getByTestId('mail-unsub-submit')).toHaveText(`Unsubscribe from ${total}`)
  // Each list answers after 3 s, so Stop lands while the first one runs. (With instant answers the
  // batch could end first, and the Close button that replaces Stop took the click.)
  await setUnsubDelay(fixture, 3_000)
  try {
    await dialog.getByTestId('mail-unsub-submit').click()
    const stop = dialog.getByTestId('mail-unsub-stop')
    await expect(stop).toBeVisible()
    // Esc does nothing while it runs.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await stop.click()
    await expect(dialog.getByTestId('mail-unsub-close')).toBeVisible({ timeout: 60_000 })
  } finally {
    await setUnsubDelay(fixture, 0)
  }
  const runs = await dialog.getByTestId('mail-unsub-run').evaluateAll((els) => els.map((one) => one.getAttribute('data-status')))
  expect(runs).toHaveLength(total)
  // The list that was running when Stop landed finishes; the rest are left waiting, never run.
  const skipped = runs.filter((one) => one === 'skipped').length
  expect(runs.every((one) => ['done', 'already', 'needs-human', 'failed', 'skipped'].includes(one ?? ''))).toBe(true)
  expect(total - skipped).toBeGreaterThanOrEqual(1)
  expect(skipped).toBeGreaterThanOrEqual(1)
  await expect(dialog.getByTestId('mail-unsub-summary')).toContainText(/^Done \d+/)
  expect((await unsubLog(fixture)).calls).toBeGreaterThanOrEqual(1)
  for (const finish of await dialog.getByTestId('mail-unsub-finish').all()) {
    await expect(finish).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(finish).toHaveAttribute('target', '_blank')
  }
  await shoot(dialog, SHOTS, 'unsub-plan-ran')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
