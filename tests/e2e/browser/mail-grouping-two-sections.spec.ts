/**
 * The grouped inbox as two sections (2026-10-20): Not important, whose groups are its subcategories,
 * all open with every mail; then Important. And the read flag a click asks for: read at the click,
 * whatever the server is doing, including a provider list read while the server was still starting
 * (`{"providers":[]}`), which once stopped every open from marking anything read.
 *
 * Runs in both engines (`PW_WEBKIT=1 … --project chromium --project webkit`): the Mac app is WebKit.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, deliver, flags, getGroups, groupLine, groupOfMessage, mailRow, openGrouped, startGroupsFixture,
  waitLabeled,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

const shots = () => `/tmp/mail-grouped-two/shots/${test.info().project.name}`

/** The first unread Important row, and its identity. */
async function unreadImportant(page: Page): Promise<{ accountId: string; messageId: string }> {
  const target = page.locator('.mail-important [data-testid="mail-row"][data-unread="true"]').first()
  await expect(target).toBeVisible({ timeout: 30_000 })
  return { accountId: (await target.getAttribute('data-account-id'))!, messageId: (await target.getAttribute('data-message-id'))! }
}

test('a group with more mail than one page lists all of it, read page after page, with nothing to press', async ({ page }) => {
  // 60 newsletter mails from one list: one group, past the 50-row page.
  const { delivered } = await deliver(fixture, 60, { kind: 'list' })
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
  // Sorting the new mail into its group takes the model a moment.
  let groupId = ''
  await expect.poll(async () => {
    groupId = (await groupOfMessage(fixture, delivered[0]!.accountId, delivered[0]!.messageId)) ?? ''
    return groupId
  }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toMatch(/^[us]:/)
  const group = (await getGroups(fixture, ALL_INBOXES)).groups.find((one: { id: string }) => one.id === groupId)
  expect(group.unread).toBeGreaterThan(50)
  await openGrouped(page, fixture)
  await expect(groupLine(page, groupId)).toHaveAttribute('aria-expanded', 'true')
  const rows = page.locator(`[data-testid="mail-group"][data-group-id="${groupId}"] [data-testid="mail-row"]`)
  await expect(rows).toHaveCount(group.unread, { timeout: 30_000 })
  await expect(page.getByTestId('mail-group-more-rows')).toHaveCount(0)
  await expect(page.getByTestId('mail-group-load-older')).toHaveCount(0)
  await expect(page.getByTestId('mail-group-loading-more')).toHaveCount(0)
  // The section heads: Not important above the groups, Important under them.
  const notImportant = (await page.getByTestId('mail-not-important-head').boundingBox())!
  const important = (await page.getByTestId('mail-important-head').boundingBox())!
  expect(notImportant.y).toBeLessThan((await groupLine(page, groupId).boundingBox())!.y)
  expect(important.y).toBeGreaterThan((await rows.last().boundingBox())!.y)
  await page.mouse.move(0, 0)
  await shoot(page, shots(), 'two-sections')
})

test('a closed group stays closed while the view refreshes, and opens again with all of its mail', async ({ page }) => {
  await openGrouped(page, fixture)
  const groups = (await getGroups(fixture, ALL_INBOXES)).groups
  const one = groups[0]
  const line = groupLine(page, one.id)
  const rows = page.locator(`[data-testid="mail-group"][data-group-id="${one.id}"] [data-testid="mail-row"]`)
  await expect(rows).toHaveCount(one.unread, { timeout: 30_000 })
  await line.getByTestId('mail-group-name').click()
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await expect(rows).toHaveCount(0)
  // New mail arrives: the view refreshes, the closed group stays closed.
  await deliver(fixture, 1)
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
  await page.waitForTimeout(3_000)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await line.getByTestId('mail-group-name').click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(rows).toHaveCount(Number(await line.getAttribute('data-unread')), { timeout: 30_000 })
})

test('a click turns the row read before a slow server answers, and the server ends up holding it read', async ({ page }) => {
  await openGrouped(page, fixture)
  const { accountId, messageId } = await unreadImportant(page)
  await page.route('**/api/plugins/mail/messages/**/read', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await route.continue()
  })
  const row = mailRow(page, accountId, messageId)
  await row.click()
  await expect(row).toHaveAttribute('data-unread', 'false', { timeout: 300 })
  // The reader's own copy is read too, and stays read when the body (read before the flag) lands.
  await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await flags(fixture, accountId, messageId)).seen, { timeout: 20_000 }).toBe(true)
  await expect(row).toHaveAttribute('data-unread', 'false')
  await page.unroute('**/api/plugins/mail/messages/**/read')
})

test('a provider list read while the server was starting does not stop a click from marking the mail read', async ({ page }) => {
  // The first /providers answer is the one a starting server gives: an empty list.
  let first = true
  await page.route('**/api/plugins/mail/providers', async (route) => {
    if (!first) return route.continue()
    first = false
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"providers":[]}' })
  })
  const posts: string[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && /\/messages\/.+\/read$/.test(request.url())) posts.push(request.url()) })
  await openGrouped(page, fixture)
  expect(first).toBe(false)
  const { accountId, messageId } = await unreadImportant(page)
  const row = mailRow(page, accountId, messageId)
  await row.click()
  await expect(row).toHaveAttribute('data-unread', 'false', { timeout: 2_000 })
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1)
  await expect.poll(async () => (await flags(fixture, accountId, messageId)).seen, { timeout: 20_000 }).toBe(true)
})

test('Mark all read on the Not important head marks every group read in one press, and the groups leave', async ({ page }) => {
  await openGrouped(page, fixture)
  const before = (await getGroups(fixture, ALL_INBOXES)).groups
  const markable = before.filter((one: { markableUnread: number }) => one.markableUnread > 0)
  expect(markable.length).toBeGreaterThan(1)
  const press = page.getByTestId('mail-not-important-mark-all')
  await expect(press).toBeEnabled({ timeout: 20_000 })
  await shoot(page.getByTestId('mail-not-important-head'), shots(), 'mark-all-head')
  // The pointer stays on the list, where it is when a person presses: the groups still leave.
  await press.click()
  // A group that also holds mail from an account Walnut cannot mark keeps that mail, and its line.
  for (const one of markable.filter((group: { unread: number; markableUnread: number }) => group.markableUnread === group.unread)) {
    await expect(groupLine(page, one.id)).toHaveCount(0, { timeout: 60_000 })
  }
  await expect.poll(async () => (await getGroups(fixture, ALL_INBOXES)).groups
    .reduce((sum: number, one: { markableUnread: number }) => sum + one.markableUnread, 0), { timeout: 60_000 }).toBe(0)
  await expect(press).toHaveCount(0)
  await shoot(page, shots(), 'mark-all-done')
})
