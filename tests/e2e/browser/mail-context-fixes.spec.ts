/**
 * The second round of the mail right-click slice, in CHROMIUM: one case per fix, each one a
 * measurement that failed before it.
 *
 * Every case here was a nitpick with numbers attached, so each one grades the number rather than the
 * feeling:
 *
 *  · N1  Tab inside the menu kept the highlight still while DOM focus walked the items, so Enter ran
 *        the item the browser had focused. On a mail row that is a read write against another message.
 *  · N2  Every answer sentence was inserted into the layout and stayed, so the rows walked 20px down
 *        (36px for a refusal) and stayed down for the rest of the session.
 *  · N5  A search started from the menu left the box empty, so the filter was invisible.
 *  · N6  The heading clipped from the right, so the account (the one thing a merged list is asked
 *        about) was the first field lost.
 *  · N10 `Make a task` answered with a glyph only, so it was silent once the row scrolled away.
 *  · N11 A capped menu gave no sign that it scrolls.
 *  · N12 The highlight was a CSS class with no `aria-activedescendant`.
 *
 * The fixture is `PW_MAIL_CTX=1`: two accounts, one that can mark read and send and one that can do
 * neither, a read row, an unread row and a row that already carries a task.
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, folderRow, shoot } from './mail-review-helpers'
import {
  KEEPER, LUNCH, READER, WRITER,
  folderTops, headingLines, intoWriterInbox, item, itemLabels, menu, menuOverflow, openRowMenu,
  probeKeyboard, row, rowTops, rowToast,
} from './mail-context-fixes-core'

const SHOT_DIR = '/tmp/mail-context-fixes/chromium'

test.use({ browserName: 'chromium', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
})

test.afterAll(async () => { await server.stop() })

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => { console.log(`[pageerror] ${error.message}`) })
})

test('N1, N12: Tab moves the SAME highlight Enter runs, and never a hidden write', async ({ page }) => {
  await intoWriterInbox(page, port)
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/read') && request.method() === 'POST') posts.push(request.url())
  })
  await openRowMenu(page, WRITER, KEEPER)
  // Two arrows: the read toggle, then Open message.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const armed = await probeKeyboard(page)
  expect(armed.highlighted).toBe('Open message')
  // N12: the highlighted row is NAMED, so assistive tech hears the arrows move.
  expect(armed.activeDescendant).toBe('set')
  expect(armed.activeDescendantText).toBe('Open message')

  // N1: Tab is the menu's own step, not the browser's walk through eight tabbable buttons. The
  // highlight moves WITH it and stays the thing Enter will run.
  await page.keyboard.press('Tab')
  const tabbed = await probeKeyboard(page)
  expect(tabbed.menus, 'Tab must not close the menu').toBe(1)
  expect(tabbed.highlighted).toBe('Reply')
  expect(tabbed.activeDescendantText).toBe('Reply')
  expect(tabbed.domFocus, 'focus stays on the menu box').toBe('DIV.wn-context-menu')
  await page.keyboard.press('Shift+Tab')
  expect((await probeKeyboard(page)).highlighted).toBe('Open message')

  // And the write the old shape could reach by accident never happens: Enter runs the highlight.
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(posts, 'a keyboard walk through the menu is not a read write').toEqual([])
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n1-keyboard')}`)
})

test('N2, N10: an answer floats over the pane and never moves the rows it is about', async ({ page }) => {
  await intoWriterInbox(page, port)
  const before = await rowTops(page)
  expect(before.length, 'no rows to measure').toBeGreaterThan(2)

  // The cheapest item, and the one whose answer used to cost 20px: Copy Walnut link.
  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Copy Walnut link').click()
  await expect(page.getByTestId('mail-row-note')).toHaveText('Link copied.', { timeout: 30_000 })
  const said = await rowToast(page)
  // R2-15 turned the floated card into a FOOTER the list gives up: same promise (no row moves), and no
  // row is covered by it any more, which a full list used to be.
  expect(said.positioned, 'the answer is a strip in the flow, not a card over the rows').toBe('static')
  expect(said.overlaps, 'and it covers no row').toBe(0)
  expect(said.insidePane, 'and it is inside the pane the row is in (C44)').toBe(true)
  expect(await rowTops(page), 'the rows did not move').toEqual(before)

  // N10: a task answers in the same slot, so a row the list has scrolled past can still be seen to
  // have been dealt with. The glyph is the durable mark; this is the sentence.
  await openRowMenu(page, WRITER, LUNCH)
  await item(page, 'Make a task').click()
  await expect(row(page, WRITER, LUNCH).getByTestId('mail-row-task')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('mail-row-note')).toContainText('Task made from', { timeout: 30_000 })
  expect(await rowTops(page), 'and the task answer did not move them either').toEqual(before)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n2-floating-answer')}`)
})

test('N2: the sidebar fetch answer does not push the folder list down either', async ({ page }) => {
  await intoWriterInbox(page, port)
  const before = await folderTops(page)
  for (const folder of ['Archive', 'Sent']) {
    await folderRow(page, WRITER, folder).click({ button: 'right' })
    await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
    await page.getByRole('menuitem').filter({ hasText: 'Fetch this folder now' }).first().click()
    await expect(page.getByTestId('mail-folder-fetch-note').first()).toBeVisible({ timeout: 30_000 })
  }
  // R2-03: the fetch answers are a strip at the FOOT of the pane, in the flow, so the space comes out of
  // the scroller and no folder row moves. Floated, three of them covered a whole second account.
  const strip = await page.evaluate(() => {
    const one = document.querySelector('[data-testid="mail-pane-toast"]') as HTMLElement | null
    if (!one) return { positioned: 'none', covered: -1 }
    const box = one.getBoundingClientRect()
    const covered = Array.from(document.querySelectorAll('.mail-accounts-pane .mail-mailbox')).filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1
    }).length
    return { positioned: getComputedStyle(one).position, covered }
  })
  expect(strip.positioned).toBe('static')
  expect(strip.covered, 'no folder row is behind the answer strip').toBe(0)
  expect(await folderTops(page), 'two fetch sentences moved no folder row').toEqual(before)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n2-fetch-notes')}`)
})

test('N5: a search started from the menu puts its term in the box', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Find mail from this sender').click()
  await expect(page.getByTestId('mail-search-meta')).toBeVisible({ timeout: 30_000 })
  const box = page.getByLabel('Search mail')
  // A filtered list whose filter is invisible cannot be edited, extended or trusted: the field used to
  // stay empty while the header said "29 results".
  await expect(box).not.toHaveValue('')
  expect((await box.inputValue()).includes('@'), 'the term is the address it searched for').toBe(true)
  // And clearing puts the box back, so the two never disagree.
  await page.getByTestId('mail-search-clear').click()
  await expect(box).toHaveValue('')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n5-search-term')}`)
})

test('N6: the heading fits its box and the account is on a line of its own', async ({ page }) => {
  await intoWriterInbox(page, port)
  // All Inboxes: the one list where two accounts' rows look alike, which is what rule 7 is about.
  await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
  await expect(row(page, WRITER, KEEPER)).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, WRITER, KEEPER)
  const lines = await headingLines(page)
  expect(lines.length, 'two lines: person and subject, then the account').toBe(2)
  // Nothing clips: the heading used to render 78 characters in a 340px box and lose the account field
  // entirely, which is the field a merged list is asked about.
  const clipped = await page.evaluate(() => Array.from(
    document.querySelectorAll('.wn-context-menu-info .wn-context-menu-label'),
  ).map((one) => (one as HTMLElement).scrollWidth > (one as HTMLElement).clientWidth + 1))
  expect(clipped, 'no heading line is cut off by its own box').toEqual([false, false])
  console.log(`heading: ${JSON.stringify(lines)}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n6-heading')}`)
})

test('N11: a capped menu says that there is more below the fold', async ({ page }) => {
  await intoWriterInbox(page, port)
  // The window the nitpick measured: at 320px tall the menu is capped and 42% of it was invisible.
  await page.setViewportSize({ width: 1280, height: 320 })
  await openRowMenu(page, WRITER, KEEPER)
  const capped = await menuOverflow(page)
  expect(capped.hidden, 'the menu really is capped in this window').toBeGreaterThan(20)
  expect(capped.more, 'and it says so').toBe('true')
  expect(capped.masked, 'with a fade at the capped edge').toBe(true)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n11-capped')}`)

  // Scrolled to the bottom there is nothing more, so the affordance goes.
  await menu(page).evaluate((box) => { box.scrollTop = box.scrollHeight })
  await expect.poll(async () => (await menuOverflow(page)).more, { timeout: 10_000 }).toBeNull()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('N7: a left-pane row is marked while its own menu is open, and the menu names it', async ({ page }) => {
  await intoWriterInbox(page, port)
  const archive = folderRow(page, WRITER, 'Archive')
  await archive.click({ button: 'right' })
  await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
  // The CSS for this ring was written with the slice and never reached: the sidebar rows set no
  // attribute, so a folder menu (which covers the rows below the cursor, with hover frozen by the
  // backdrop) had nothing on screen tying it to its row.
  await expect(page.locator('.mail-mailbox[data-ctx-open], [data-ctx-open] > .mail-mailbox'))
    .toHaveCount(1)
  await page.keyboard.press('Escape')

  // The smart row and the Drafts row carried no heading at all, so nothing named the row they act on.
  const smart = page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]')
  await smart.click({ button: 'right' })
  await expect(page.getByTestId('mail-smart-ctx-menu')).toHaveCount(1)
  const smartHead = await page.locator('.wn-context-menu-info .wn-context-menu-label').allInnerTexts()
  expect(smartHead.map((one) => one.trim())).toEqual(['All Inboxes'])
  await expect(page.locator('[data-ctx-open] > .mail-mailbox.smart')).toHaveCount(1)
  await page.keyboard.press('Escape')

  const drafts = page.locator(`.mail-accounts-pane [data-testid="mail-drafts-row"][data-account-id="${WRITER}"]`)
  await drafts.click({ button: 'right' })
  await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
  const draftsHead = await page.locator('.wn-context-menu-info .wn-context-menu-label').allInnerTexts()
  expect(draftsHead[0]!.trim().startsWith('Drafts')).toBe(true)
  await expect(page.locator('[data-ctx-open] > [data-testid="mail-drafts-row"]')).toHaveCount(1)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n7-sidebar-marks')}`)
  await page.keyboard.press('Escape')
})

test('N4, N9, N13: the words a row can keep, on an account that cannot mark read', async ({ page }) => {
  await intoWriterInbox(page, port)
  // The inbound-only account: no read toggle at all (it is dropped, never disabled), so the menu must
  // not turn round and explain that opening marks mail read.
  await folderRow(page, READER, 'INBOX').click()
  const first = page.locator(`.mail-row[data-account-id="${READER}"]`).first()
  await expect(first).toBeVisible({ timeout: 60_000 })
  await first.click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  const labels = await itemLabels(page)
  expect(labels.some((one) => one.startsWith('Mark as')), 'the toggle is dropped here').toBe(false)
  expect(await item(page, 'Open message').getAttribute('title')).toBeNull()
  await page.keyboard.press('Escape')

  // A sent row: the heading carries the row's own `To`, and the address search is gone because the
  // cached index holds no recipients (it answered `0 results` every time). The account's OWN Sent
  // folder, because this fixture's sent mail lives there and the merged row is not drawn for it.
  await folderRow(page, WRITER, 'Sent').click()
  const sent = row(page, WRITER, 'Sent:1:9')
  await expect(sent).toBeVisible({ timeout: 60_000 })
  await sent.click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  expect((await headingLines(page))[0]!.startsWith('To ')).toBe(true)
  expect(await itemLabels(page)).not.toContain('Find mail from this sender')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'n4-sent-menu')}`)
  await page.keyboard.press('Escape')
})
