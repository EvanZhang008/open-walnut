/**
 * The same round of fixes in WEBKIT, which is the engine the Mac app is.
 *
 * Two of them can only be graded here, and both were engine-specific by construction:
 *
 *  · N3, C75, C26, C74: a message row was a `<button>`, and WebKit refuses a text selection inside
 *    a form control whatever `user-select` says. So a row's subject could not be selected at all in the
 *    Mac app (Copy, Look Up and Translate were gone from every row), the two `user-select` rules in
 *    mail.css were Chromium-only, and the drag arrived as a plain CLICK that opened the message and
 *    marked it read. The row is now a `div role="button"`, which selects in both engines.
 *  · N1: Tab used to answer DIFFERENTLY in the two engines: Chromium walked DOM focus through the
 *    items with the highlight frozen, WebKit blurred the menu and closed it on the first press. One
 *    focus model means the same answer here.
 *
 * A `test.use` browser pin only holds in the file it is written in, so the cases live here rather than
 * in a shared registrar (see mail-context-independent-core.ts for the measurement that proved it). The
 * webkit PROJECT is opt-in, so run it as:
 *
 *   PW_WEBKIT=1 npx playwright test tests/e2e/browser/mail-context-fixes.webkit.spec.ts --project=webkit
 *
 * The first case asserts the engine off `navigator.userAgent`, because a run under the chromium project
 * is a vacuous pass and this file exists for the other engine.
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, shoot } from './mail-review-helpers'
import {
  KEEPER, LUNCH, WRITER,
  dragAcross, engineOf, headingLines, intoWriterInbox, item, menu, menuOverflow, openRowMenu,
  probeKeyboard, row, rowTops, rowToast,
} from './mail-context-fixes-core'

const SHOT_DIR = '/tmp/mail-context-fixes/webkit'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
})

test.afterAll(async () => { await server.stop() })

test('N3, C75: a row\'s subject and snippet can be selected in this engine too', async ({ page }) => {
  expect(await engineOf(page), 'this file must really be webkit').toBe('webkit')
  await intoWriterInbox(page, port)
  const subject = await dragAcross(page, row(page, WRITER, KEEPER).locator('.mail-row-subject-text'))
  expect(subject.trim().length, 'the subject line is selectable').toBeGreaterThan(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const snippet = await dragAcross(page, row(page, WRITER, KEEPER).locator('.mail-row-snippet'))
  expect(snippet.trim().length, 'and so is the snippet').toBeGreaterThan(0)
  console.log(`selected: ${JSON.stringify({ subject, snippet })}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n3-selection')}`)
})

test('C26, C74: a real selection keeps the browser menu, and selecting opens nothing', async ({ page }) => {
  await intoWriterInbox(page, port)
  const traffic: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/\/api\/plugins\/mail\/messages\/[^?]+$/.test(url) && request.method() === 'GET') traffic.push(url)
    if (url.endsWith('/read')) traffic.push(url)
  })
  // A real drag, asserted as a real selection first: with no selection possible this case could not
  // exist, and the drag used to be delivered as a click that opened the row and marked it read.
  const picked = await dragAcross(page, row(page, WRITER, LUNCH).locator('.mail-row-snippet'))
  expect(picked.trim().length).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false)
  expect(traffic, 'selecting a row\'s words is not opening it').toEqual([])
  // The pane itself exists with a "pick a message" placeholder; what must not exist is a message IN it.
  expect(await page.locator('[data-testid="mail-reader"][data-message-id]').count()).toBe(0)

  // Rule 6, now reachable in this engine: inside a live selection the browser's own menu is the better
  // one, so Walnut's must not appear.
  await row(page, WRITER, LUNCH).locator('.mail-row-snippet').click({ button: 'right' })
  await page.waitForTimeout(400)
  expect(await page.locator('.wn-context-menu').count(), 'the browser keeps this one').toBe(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'c26-native-kept')}`)
})

test('N1, N12: Tab steers the highlight here as well, and closes nothing', async ({ page }) => {
  await intoWriterInbox(page, port)
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/read') && request.method() === 'POST') posts.push(request.url())
  })
  await openRowMenu(page, WRITER, KEEPER)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  expect((await probeKeyboard(page)).highlighted).toBe('Open message')
  // This engine used to CLOSE the menu on the first Tab (relatedTarget was the twist button next door),
  // so the two engines answered one key two ways. One focus model, one answer.
  await page.keyboard.press('Tab')
  const tabbed = await probeKeyboard(page)
  expect(tabbed.menus, 'the menu is still open').toBe(1)
  expect(tabbed.highlighted).toBe('Reply')
  expect(tabbed.activeDescendantText).toBe('Reply')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(posts, 'no read write came out of a keyboard walk').toEqual([])
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n1-keyboard')}`)
})

test('N2, N10: the answer floats and the rows stay where they were', async ({ page }) => {
  await intoWriterInbox(page, port)
  const before = await rowTops(page)
  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Copy Walnut link').click()
  await expect(page.getByTestId('mail-row-note')).toHaveText('Link copied.', { timeout: 30_000 })
  const said = await rowToast(page)
  // R2-15: a footer the list gives up, not a card over its last row.
  expect(said.positioned).toBe('static')
  expect(said.overlaps).toBe(0)
  expect(said.insidePane).toBe(true)
  expect(await rowTops(page)).toEqual(before)

  await openRowMenu(page, WRITER, LUNCH)
  await item(page, 'Make a task').click()
  await expect(row(page, WRITER, LUNCH).getByTestId('mail-row-task')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('mail-row-note')).toContainText('Task made from', { timeout: 30_000 })
  expect(await rowTops(page)).toEqual(before)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n2-floating-answer')}`)
})

test('N6, N11: the heading fits, and a capped menu shows there is more', async ({ page }) => {
  await intoWriterInbox(page, port)
  await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
  await expect(row(page, WRITER, KEEPER)).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, WRITER, KEEPER)
  expect((await headingLines(page)).length, 'the account has its own line').toBe(2)
  const clipped = await page.evaluate(() => Array.from(
    document.querySelectorAll('.wn-context-menu-info .wn-context-menu-label'),
  ).map((one) => (one as HTMLElement).scrollWidth > (one as HTMLElement).clientWidth + 1))
  expect(clipped).toEqual([false, false])
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 1280, height: 320 })
  await openRowMenu(page, WRITER, KEEPER)
  const capped = await menuOverflow(page)
  expect(capped.hidden).toBeGreaterThan(20)
  expect(capped.more).toBe('true')
  expect(capped.masked, 'the fade is applied in this engine too').toBe(true)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n11-capped')}`)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('N7: a left-pane row is marked while its menu is open', async ({ page }) => {
  await intoWriterInbox(page, port)
  const smart = page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]')
  await smart.click({ button: 'right' })
  await expect(page.getByTestId('mail-smart-ctx-menu')).toHaveCount(1)
  await expect(page.locator('[data-ctx-open] > .mail-mailbox.smart')).toHaveCount(1)
  const head = await page.locator('.wn-context-menu-info .wn-context-menu-label').allInnerTexts()
  expect(head.map((one) => one.trim())).toEqual(['All Inboxes'])
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n7-sidebar-marks')}`)
  await page.keyboard.press('Escape')
})
