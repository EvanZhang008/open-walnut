/**
 * The grouped inbox's main paths (design v2) in WebKit, the Mac app's engine: the group lines, their
 * hover tools and more (...) menu, an open group, reading from it, the correction card's entry point, the
 * unsubscribe checklist; no horizontal overflow at the default 336px column; every overlay inside the
 * viewport.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, MARINA, ROW, fileHash, getGroups, groupLine, mailRow, markReadLog, openGroupLine, openGroupMenu,
  openGrouped, resetLogs, startGroupsFixture, unsubLog, waitLabeled,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const SHOTS = '/tmp/mail-grouping/shots/v2/webkit'
let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

async function noOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = []
    const check = (el: Element | null, name: string) => { if (el && el.scrollWidth > el.clientWidth + 1) bad.push(name) }
    check(document.querySelector('.mail-rows.mail-grouped'), 'scroller')
    check(document.querySelector('[data-testid="mail-grouped"] [data-testid="mail-list-section"]'), 'head')
    for (const row of document.querySelectorAll('[data-testid="mail-group-row"]')) check(row, `row:${row.getAttribute('data-group-id')}`)
    return bad
  })
}

function inside(box: { x: number; y: number; width: number; height: number } | null, view: { width: number; height: number }): boolean {
  return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5
}

test('lines, hover tools, the more (...) menu, an open group and the reader line all work in WebKit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openGrouped(page, fixture)
  const groups = await getGroups(fixture, ALL_INBOXES)
  const ids = await page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-group-id')))
  expect(ids).toEqual(groups.groups.map((one: { id: string }) => one.id))
  for (const group of groups.groups.slice(0, 5)) {
    await expect(groupLine(page, group.id).getByTestId('mail-group-name')).toHaveText(group.label)
    await expect(groupLine(page, group.id).getByTestId('mail-group-unread')).toHaveText(group.unread.toLocaleString())
  }
  await expect(page.getByTestId('mail-important-unread')).toHaveText(`${groups.important.unread} unread`)
  expect(await noOverflow(page)).toEqual([])
  const heights = await page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
  // A title row and one summary line (the model's line, or the subject for one unread).
  for (const height of heights) expect(height).toBeLessThanOrEqual(56)
  for (const group of groups.groups.slice(0, 5)) {
    await expect(groupLine(page, group.id).getByTestId('mail-group-summary')).toHaveText(group.summary)
  }
  await page.mouse.move(2, 2)
  await shoot(page, SHOTS, 'overview')
  // Hover tools and the more (...) menu, inside the viewport.
  const first = groups.groups[0]
  const menu = await openGroupMenu(page, first.id)
  expect(inside(await menu.boundingBox(), page.viewportSize()!)).toBe(true)
  await shoot(page, SHOTS, 'group-menu')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // Open a group, read a mail: the row stays, the pill counts down, the reader says why.
  const big = [...groups.groups].sort((a: { unread: number }, b: { unread: number }) => b.unread - a.unread)[0]
  const group = await openGroupLine(page, big.id)
  await expect(group.locator('[data-testid="mail-row"]')).toHaveCount(Math.min(3, big.unread))
  expect(await noOverflow(page)).toEqual([])
  const kid = group.locator('[data-testid="mail-row"]').first()
  const messageId = (await kid.getAttribute('data-message-id'))!
  await kid.click()
  await expect(page.getByTestId('mail-reader-sort')).toContainText(`In ${big.label}`)
  await expect(groupLine(page, big.id).getByTestId('mail-group-unread')).toHaveText(String(big.unread - 1))
  await expect(group.locator(`[data-testid="mail-row"][data-message-id="${messageId}"]`)).toHaveAttribute('data-unread', 'false')
  await shoot(page, SHOTS, 'group-open-reader')
})

test('the correction card and the unsubscribe checklist open inside the viewport, and closing writes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await resetLogs(fixture)
  const hash = await fileHash(fixture)
  await openGrouped(page, fixture)
  // A right-click on an Important row: Not important... opens the card with that choice picked.
  const row = mailRow(page, MARINA, ROW.direct)
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu')
  expect(inside(await menu.boundingBox(), page.viewportSize()!)).toBe(true)
  await page.getByRole('menuitem', { name: 'Not important\u2026' }).click()
  const card = page.getByTestId('mail-correct')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="mail-correct-choice"][data-group-id="not-important"]')).toBeChecked()
  expect(inside(await card.boundingBox(), page.viewportSize()!)).toBe(true)
  await shoot(card, SHOTS, 'correct-card')
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(row).toBeFocused()
  // The checklist from a group's more (...) menu.
  const groups = await getGroups(fixture, ALL_INBOXES)
  const withUnsub = groups.groups.find((one: { unsubscribable: number }) => one.unsubscribable > 0)
  await (await openGroupMenu(page, withUnsub.id)).getByRole('menuitem', { name: 'Unsubscribe\u2026' }).click()
  const dialog = page.getByTestId('mail-unsub-plan')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  expect(inside(await dialog.boundingBox(), page.viewportSize()!)).toBe(true)
  for (const one of await dialog.getByTestId('mail-unsub-check').all()) await expect(one).not.toBeChecked()
  await shoot(dialog, SHOTS, 'unsub-plan')
  await dialog.getByTestId('mail-unsub-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect((await unsubLog(fixture)).calls).toBe(0)
  expect((await markReadLog(fixture)).calls).toBe(0)
  expect(await fileHash(fixture)).toBe(hash)
})

test('the press marks a group read in WebKit and Undo brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openGrouped(page, fixture, MARINA)
  const groups = await getGroups(fixture, { accountId: MARINA, mailboxId: 'INBOX' })
  const target = groups.groups.find((one: { unread: number; markableUnread: number }) => one.unread >= 2 && one.markableUnread === one.unread)
  const line = groupLine(page, target.id)
  await line.hover()
  await line.getByTestId('mail-group-mark').click()
  const done = page.getByTestId('mail-list-status').locator('.mail-list-status-line').filter({ hasText: /^Marked \d+ read in / })
  await expect(done).toBeVisible({ timeout: 60_000 })
  await expect(line).toHaveCount(0, { timeout: 20_000 })
  await shoot(page, SHOTS, 'bulk-marked')
  await done.getByTestId('mail-bulk-undo').click()
  await expect(groupLine(page, target.id)).toHaveAttribute('data-unread', String(target.unread), { timeout: 60_000 })
})
