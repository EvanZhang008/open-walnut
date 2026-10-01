/**
 * The grouped inbox in the Mac app's engine at narrow width (design v2): at 900px the console drills
 * one column at a time and the accounts pane is `display: none`, so the list's own header, its view
 * menu and the status strip have to fit the middle column; the search row's back button is the only
 * back, and the reader's back returns to the list with the open group and the scroll kept.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, getGroups, groupLine, openGroupLine, openMailAnyWidth, startGroupsFixture, statusLine, waitLabeled,
} from './mail-grouping-helpers'
import { shoot, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

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

async function openNarrow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 800 })
  await openMailAnyWidth(page, fixture.port)
  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-group-row').first()).toBeVisible({ timeout: 60_000 })
}

function inViewport(box: { x: number; y: number; width: number; height: number } | null, width: number, height: number): boolean {
  return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height
}

test('one back control; the reader returns to the list with the group still open and the scroll kept', async ({ page }) => {
  await openNarrow(page)
  const back = page.getByTestId('mail-show-mailboxes')
  await expect(back).toHaveAttribute('aria-label', 'Mailboxes')
  const groups = await getGroups(fixture, ALL_INBOXES)
  const big = [...groups.groups].sort((a: { unread: number }, b: { unread: number }) => b.unread - a.unread)[0]
  const group = await openGroupLine(page, big.id)
  // Opening a group is not a new place: the back is still Mailboxes, and there is no other back.
  await expect(back).toHaveAttribute('aria-label', 'Mailboxes')
  const scroller = page.locator('.mail-rows.mail-grouped')
  await scroller.evaluate((el) => { el.scrollTop = 60 })
  await page.waitForTimeout(200)
  const scrolled = await scroller.evaluate((el) => el.scrollTop)
  await group.locator('[data-testid="mail-row"]').first().click()
  await expect(page.getByTestId('mail-reader-back')).toBeVisible()
  await expect(page.getByTestId('mail-reader-sort')).toContainText(`In ${big.label}`)
  await shoot(page, SHOTS, 'narrow-reader')
  await page.getByTestId('mail-reader-back').click()
  await expect(page.getByTestId('mail-grouped')).toBeVisible()
  await expect(groupLine(page, big.id)).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => Math.abs((await scroller.evaluate((el) => el.scrollTop)) - scrolled)).toBeLessThanOrEqual(2)
  await back.click()
  await expect(page.locator('.mail-accounts-pane')).toBeVisible()
})

test('at 900px the header, the lines, the menus and the status strip fit the column', async ({ page }) => {
  await openNarrow(page)
  const overflow = await page.evaluate(() => {
    const bad: string[] = []
    const check = (el: Element | null, name: string) => { if (el && el.scrollWidth > el.clientWidth + 1) bad.push(name) }
    check(document.querySelector('.mail-rows.mail-grouped'), 'scroller')
    check(document.querySelector('[data-testid="mail-grouped"] [data-testid="mail-list-section"]'), 'head')
    for (const row of document.querySelectorAll('[data-testid="mail-group-row"]')) check(row, `row:${row.getAttribute('data-group-id')}`)
    return bad
  })
  expect(overflow).toEqual([])
  await page.getByTestId('mail-view-menu').click()
  const viewMenu = page.getByTestId('mail-view-menu-list')
  expect(inViewport(await viewMenu.boundingBox(), 900, 800)).toBe(true)
  await page.keyboard.press('Escape')
  const groups = await getGroups(fixture, ALL_INBOXES)
  const target = groups.groups.find((one: { unread: number; markableUnread: number }) => one.markableUnread === one.unread)
  const line = groupLine(page, target.id)
  await line.hover()
  await line.getByTestId('mail-group-more').click()
  const menu = page.getByTestId('mail-group-menu')
  expect(inViewport(await menu.boundingBox(), 900, 800)).toBe(true)
  await menu.getByRole('menuitem', { name: /^Mark \d+ read$/ }).click()
  const done = statusLine(page, /^Marked \d+ read in /)
  await expect(done).toBeVisible({ timeout: 60_000 })
  expect(inViewport(await done.boundingBox(), 900, 800)).toBe(true)
  await shoot(page, SHOTS, 'narrow-status')
  await done.getByTestId('mail-bulk-undo').click()
  await expect(groupLine(page, target.id)).toHaveAttribute('data-unread', String(target.unread), { timeout: 60_000 })
})
