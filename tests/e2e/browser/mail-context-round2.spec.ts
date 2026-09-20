/**
 * The second review round on the mail right-click slice, in Chromium.
 *
 * One test per finding, each reproducing the reported gesture rather than a proxy for it:
 *
 *  · R2-01 the folder menu's unread switch left the header chip in the off state and ate the next click.
 *  · R2-02 the badge lost one unread on the first refresh after a flip.
 *  · R2-03 three fetch answers covered a whole account for 30 seconds.
 *  · R2-04 a refusal stayed on screen after the retry that succeeded.
 *  · R2-05 in a short window the keyboard walked the highlight off the visible box.
 *  · R2-06 a preference for a folder you are not looking at answered with nothing.
 *  · R2-07 the Drafts folder's rows answered the browser's menu.
 *  · R2-11 a keyboard user could not reach the disabled send items, so their reason was mouse only.
 *  · R2-12 the in-progress fetch dot outlived its sentence and carried no words.
 *  · R2-17 with a menu open a wheel over the list neither scrolled nor closed.
 *
 * Run: npx playwright test tests/e2e/browser/mail-context-round2.spec.ts
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, folderRow, shoot } from './mail-review-helpers'
import {
  KEEPER, LUNCH, READER, WRITER,
  contrastOf, folderTops, highlightBox, intoWriterInbox, item, markShape, menu, openFolderMenu,
  openRowMenu, row, stripShape, unreadChip,
} from './mail-context-round2-core'

const SHOT_DIR = '/tmp/mail-context-ux/r3'

test.use({ viewport: { width: 1280, height: 800 } })
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

test('R2-01: the folder menu\'s unread switch and the header chip are ONE preference', async ({ page }) => {
  await intoWriterInbox(page, port)
  const before = await unreadChip(page)
  expect(before.present, 'the inbox has unread mail, so the chip is there').toBe(true)
  expect(before.on).toBe('false')

  // The gesture as reported: right-click the folder ON SCREEN and switch the filter on from its menu.
  await openFolderMenu(page, WRITER, 'INBOX')
  await item(page, 'Show only unread in this folder').click()
  await expect(menu(page)).toHaveCount(0)
  await expect.poll(async () => (await unreadChip(page)).on, { timeout: 30_000 }).toBe('true')

  const filtered = await unreadChip(page)
  expect(filtered.pressed, 'the chip is pressed, not merely coloured').toBe('true')
  expect(filtered.text, 'and it says it is showing them').toContain('showing')
  expect(filtered.rows).toBeLessThan(before.rows)
  expect(filtered.unreadRows, 'every row on screen is unread').toBe(filtered.rows)
  console.log(`chip: ${JSON.stringify({ before, filtered })}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r201-filtered')}`)

  // ONE click of the chip restores the full list. It used to take two, because the first one was the
  // click that turned a filter the chip believed was off ON.
  await page.getByTestId('mail-unread-filter').click()
  await expect.poll(async () => (await unreadChip(page)).rows, { timeout: 30_000 }).toBe(before.rows)
  const back = await unreadChip(page)
  expect(back.on).toBe('false')
  // And the menu agrees, because it reads the same preference.
  await openFolderMenu(page, WRITER, 'INBOX')
  await expect(item(page, 'Show only unread in this folder')).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('R2-01: a folder with no unread mail says so, instead of blaming the cache', async ({ page }) => {
  await intoWriterInbox(page, port)
  await folderRow(page, WRITER, 'Sent').click()
  await expect.poll(async () => (await unreadChip(page)).rows, { timeout: 60_000 }).toBeGreaterThan(0)

  await openFolderMenu(page, WRITER, 'Sent')
  await item(page, 'Show only unread in this folder').click()
  await expect(page.getByTestId('mail-unread-empty')).toBeVisible({ timeout: 30_000 })
  const shape = await unreadChip(page)
  expect(shape.showAll, 'with the way out next to it').toBe(true)
  expect(shape.cacheLine, 'and no sentence about messages it is only hiding').toBe(false)
  expect(shape.on, 'the chip is on even at zero unread, or the way out goes with it').toBe('true')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r201-zero-unread')}`)

  await page.getByTestId('mail-unread-show-all').click()
  await expect.poll(async () => (await unreadChip(page)).rows, { timeout: 30_000 }).toBeGreaterThan(0)
})

test('R2-02: the folder count after a flip does not dip below the server\'s own number', async ({ page }) => {
  await intoWriterInbox(page, port)
  const inbox = folderRow(page, WRITER, 'INBOX')
  const before = Number(await inbox.getAttribute('data-unread'))
  expect(before, 'the inbox has unread mail to flip').toBeGreaterThan(0)

  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Mark as read').click()
  await expect(inbox).toHaveAttribute('data-unread', String(before - 1), { timeout: 30_000 })

  // The reported gesture: ask for new mail from the smart row's own menu, twice. The first refresh used
  // to subtract the flip a SECOND time (badge one low) and the second one healed it.
  for (const pass of [1, 2]) {
    await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click({ button: 'right' })
    await expect(menu(page)).toHaveCount(1)
    await item(page, 'Check for new mail').click()
    await expect(menu(page)).toHaveCount(0)
    // Long enough for the accounts + mailbox lists to land, then the number has to be the server's.
    await page.waitForTimeout(2_500)
    expect(
      Number(await inbox.getAttribute('data-unread')),
      `refresh ${pass}: the flip is counted once, by the server`,
    ).toBe(before - 1)
  }
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r202-badge')}`)
})

test('R2-03, R2-15: an answer strip covers nothing and can be dismissed', async ({ page }) => {
  await intoWriterInbox(page, port)
  const before = await folderTops(page)

  // Every folder answer this fixture can give, asked for back to back: three cards used to stack over
  // the account below and stand there for thirty seconds.
  for (const folder of ['Archive', 'Sent']) {
    await openFolderMenu(page, WRITER, folder)
    await item(page, 'Fetch this folder now').click()
    await expect(page.getByTestId('mail-folder-fetch-note').first()).toBeVisible({ timeout: 30_000 })
  }
  const strip = await stripShape(page, 'pane')
  expect(strip.positioned, 'in the flow at the foot, not floated over the list').toBe('static')
  expect(strip.covers, 'no folder row is behind it').toBe(0)
  expect(strip.dismiss, 'and it can be dismissed').toBe(true)
  expect(await folderTops(page), 'and no folder row moved').toEqual(before)
  console.log(`strip: ${JSON.stringify(strip)}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r203-strip')}`)

  await page.getByTestId('mail-pane-strip-close').click()
  await expect(page.getByTestId('mail-pane-toast')).toHaveCount(0)

  // And the row answer is a footer the LIST gives up, covering none of its rows either.
  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Copy Walnut link').click()
  await expect(page.getByTestId('mail-row-note')).toHaveText('Link copied.', { timeout: 30_000 })
  const rowStrip = await stripShape(page, 'row')
  expect(rowStrip.positioned).toBe('static')
  expect(rowStrip.covers).toBe(0)
})

test('R2-04: a retry clears the refusal it is retrying', async ({ page }) => {
  await intoWriterInbox(page, port)
  let refuse = true
  await page.route('**/api/plugins/mail/messages/**/read', async (route) => {
    if (!refuse) { await route.continue(); return }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unsupported', message: 'This account cannot change read flags (Fixture Mail).' }),
    })
  })

  await openRowMenu(page, WRITER, LUNCH)
  await item(page, 'Mark as read').click()
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('Walnut could not mark', { timeout: 30_000 })
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-flag-failed', '1')
  // A refusal WAITS to be read now, which is why it is the retry's job to clear it.
  await expect(page.getByTestId('mail-row-note-close')).toHaveCount(1)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r204-refused')}`)

  refuse = false
  await openRowMenu(page, WRITER, LUNCH)
  await item(page, 'Mark as read').click()
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await expect(page.getByTestId('mail-row-toast'), 'no sentence contradicts the row').toHaveCount(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r204-after-success')}`)
})

test('R2-05: in a short window the keyboard highlight stays inside the clamped box', async ({ page }) => {
  await intoWriterInbox(page, port)
  // The window the nitpick measured: the menu clamps to 238px against 311px of items.
  await page.setViewportSize({ width: 1280, height: 420 })
  await openRowMenu(page, WRITER, KEEPER)
  const capped = await highlightBox(page)
  expect(capped.hidden, 'the menu really is capped in this window').toBeGreaterThan(20)
  expect(capped.more, 'and it says there is more').toBe('true')
  expect(capped.masked || capped.scrollbar > 0, 'with a fade or a scrollbar to show it').toBe(true)

  // Seven presses used to put the highlight 7px below the box with scrollTop still 0, so Enter ran an
  // item nobody could see.
  for (let press = 0; press < 7; press += 1) await page.keyboard.press('ArrowDown')
  const walked = await highlightBox(page)
  expect(walked.label, 'something is highlighted').not.toBe('')
  expect(walked.inside, 'and it is inside the visible box').toBe(true)
  console.log(`walked: ${JSON.stringify(walked)}`)

  // End is where the box really has to move: the last item sat 37px below it with scrollTop 0.
  await page.keyboard.press('End')
  const last = await highlightBox(page)
  expect(last.label).toBe('Copy Walnut link')
  expect(last.inside, 'End lands on a row the person can see').toBe(true)
  expect(last.scrollTop, 'because the box followed the highlight').toBeGreaterThan(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r205-end-visible')}`)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('R2-06: a preference for a folder you are not looking at says so, naming it', async ({ page }) => {
  await intoWriterInbox(page, port)
  const rowsBefore = (await unreadChip(page)).rows

  await openFolderMenu(page, WRITER, 'Archive')
  await item(page, 'Show only unread in this folder').click()
  const note = page.getByTestId('mail-pane-note')
  await expect(note).toBeVisible({ timeout: 30_000 })
  await expect(note).toHaveText('Archive now shows only unread messages.')
  // The list on screen is untouched: this was a preference about another folder.
  expect((await unreadChip(page)).rows).toBe(rowsBefore)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r206-other-folder')}`)

  await openFolderMenu(page, WRITER, 'Archive')
  await item(page, 'Show everything in this folder').click()
  await expect(page.getByTestId('mail-pane-note')).toHaveText('Archive now shows every message.')
})

test('R2-11: the disabled send items are reachable, and their reason is on the row', async ({ page }) => {
  await intoWriterInbox(page, port)
  // The account that can neither mark read nor send: its rows are where a disabled item lives.
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, 'INBOX:2:11')).toBeVisible({ timeout: 60_000 })
  const posts: string[] = []
  page.on('request', (request) => {
    if (/\/(read|drafts)$/.test(request.url()) && request.method() === 'POST') posts.push(request.url())
  })
  await openRowMenu(page, READER, 'INBOX:2:11')

  // The reason is TEXT in the menu now, not a hover tooltip: since R3-03 its own row under the group.
  const why = menu(page).locator('.wn-context-menu-reason')
  await expect(why.first()).toBeVisible()
  await expect(why.first()).toContainText('cannot send')

  // And the highlight walks onto the disabled rows, which it used to skip entirely: two steps from the
  // top reach Reply, where the walk used to jump straight past all three send items.
  const labels: string[] = []
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press('ArrowDown')
    labels.push((await highlightBox(page)).label)
  }
  expect(labels[1], 'the second step is Reply, disabled and highlighted').toMatch(/^Reply/)
  // The reason is reachable from that highlight without a mouse: it is the row under the group (R3-03
  // moved it out of the button, where it made one of three grouped rows 52px tall), and the highlighted
  // row still carries it in `title`. Both are asserted, because "reachable" is the promise.
  const highlighted = menu(page).locator('[role="menuitem"].focused')
  expect(await highlighted.getAttribute('title')).toContain('cannot send')
  await expect(why.first(), 'and the sentence is on screen while that row is lit').toBeVisible()
  // Enter on a disabled row runs nothing and leaves the menu open.
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(1)
  expect(posts, 'nothing was written by pressing a disabled item').toEqual([])
  console.log(`walk: ${JSON.stringify(labels)}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r211-disabled')}`)
  await page.keyboard.press('Escape')
})

test('R2-17: with a menu open, a wheel over the list closes it', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, KEEPER)
  const rows = page.locator('.mail-rows')
  const box = (await rows.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)
  // The documented rule (a scroll dismisses a menu anchored to a frozen viewport point) now really
  // fires: the backdrop used to swallow the wheel, so the gesture did nothing at all.
  await expect(menu(page)).toHaveCount(0, { timeout: 10_000 })
  // The selection did not move and nothing opened.
  expect(await page.locator('[data-testid="mail-reader"][data-message-id]').count()).toBe(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r217-wheel-closed')}`)

  // A wheel over the MENU still scrolls the menu, which is the other half of the rule. The box has to be
  // clamped for that question to exist at all, so that is asserted first.
  await page.setViewportSize({ width: 1280, height: 360 })
  await openRowMenu(page, WRITER, KEEPER)
  expect((await highlightBox(page)).hidden, 'the menu is clamped in this window').toBeGreaterThan(20)
  const menuBox = (await menu(page).boundingBox())!
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2)
  await page.mouse.wheel(0, 120)
  await expect(menu(page)).toHaveCount(1)
  // Polled: a wheel is applied on the compositor's own frame, so reading `scrollTop` in the very next
  // task measured 0 on a loaded machine while the menu really had scrolled.
  await expect.poll(async () => (await highlightBox(page)).scrollTop, { timeout: 10_000 })
    .toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('R2-12: an in-progress fetch dot animates and carries the same words its row does', async ({ page }) => {
  await intoWriterInbox(page, port)
  // `ctx-fetch-running` is the folder the fixture answers with a 202: the sweep finishes it later, so
  // the dot stays up. It used to be the one state with no words at all. It lives in the collapsed tail,
  // which the folder menu's own switch opens.
  await openFolderMenu(page, WRITER, 'Archive')
  await item(page, 'Show all folders in this account').click()
  await expect(folderRow(page, WRITER, 'ctx-fetch-running')).toBeVisible({ timeout: 30_000 })
  await openFolderMenu(page, WRITER, 'ctx-fetch-running')
  await item(page, 'Fetch this folder now').click()
  const dot = folderRow(page, WRITER, 'ctx-fetch-running').getByTestId('mail-mailbox-fetch-dot')
  await expect(dot).toHaveCount(1, { timeout: 30_000 })
  const shape = await dot.evaluate((one) => ({
    animation: getComputedStyle(one).animationName,
    title: one.getAttribute('title'),
    label: one.getAttribute('aria-label'),
    rowTitle: one.closest('.mail-mailbox')?.getAttribute('title') ?? null,
  }))
  expect(shape.animation, 'a dot that means in progress moves').not.toBe('none')
  expect(shape.title, 'and it can be asked what it means').toContain('fetching')
  expect(shape.rowTitle, 'the row says it too, not only the failed states').toContain('fetching')
  console.log(`dot: ${JSON.stringify(shape)}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r212-dot')}`)
})

test('R2-09, R2-10: the heading clears AA and the right-clicked mark is not a selection', async ({ page }) => {
  await intoWriterInbox(page, port)
  // The row the menu is about is also the SELECTED row, which is where the two marks used to collide.
  await row(page, WRITER, LUNCH).click()
  await expect(page.locator('[data-testid="mail-reader"][data-message-id]')).toHaveCount(1, { timeout: 30_000 })
  await openRowMenu(page, WRITER, LUNCH)

  const heading = await contrastOf(page, '.wn-context-menu-info')
  expect(heading.ratio, `the heading naming the row is ${heading.colour} on ${heading.background}`)
    .toBeGreaterThanOrEqual(4.5)
  const marks = await markShape(page, WRITER, LUNCH)
  expect(marks.keepsBar, 'a selected row that is right-clicked keeps its selection bar').toBe(true)
  expect(marks.ringsWithAccent, 'and the ring is not the selection accent').toBe(false)
  console.log(`marks: ${JSON.stringify({ heading, marks })}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r209-r210-marks')}`)
  await page.keyboard.press('Escape')
})

test('R2-07, R2-16: a draft row answers with a Walnut menu, and the task copy reads once', async ({ page }) => {
  await intoWriterInbox(page, port)
  // R2-16 first, on a row: "Task made from X from Y" spent two `from` clauses on nine words.
  await openRowMenu(page, WRITER, KEEPER)
  await item(page, 'Make a task').click()
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('Task made from', { timeout: 30_000 })
  const said = (await note.textContent())!.trim()
  expect(said.match(/\bfrom\b/g), 'one preposition').toHaveLength(1)
  expect(said, 'the sender rides in parentheses').toMatch(/\(.+\)\.$/)

  // A draft of our own, so the Drafts view has a row drawn as a message row.
  await page.getByTestId('mail-compose-new').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('mail-compose-subject').fill('Berth swap')
  await page.getByTestId('mail-compose-body').fill('Asking about the swap.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  await page.getByTestId('mail-composer-close').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)

  await folderRow(page, WRITER, '__walnut_drafts__').click()
  const draftRow = page.getByTestId('mail-draft-row').first()
  await expect(draftRow).toBeVisible({ timeout: 30_000 })

  // The gesture the rest of the console teaches, in the one folder where it used to do nothing.
  await draftRow.click({ button: 'right' })
  await expect(page.getByTestId('mail-draft-ctx-menu')).toHaveCount(1)
  const labels = await menu(page).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
  expect(labels.map((one) => one.trim())).toEqual(['Continue editing', 'Discard draft'])
  // Named, because the menu covers the row it is about.
  await expect(menu(page).locator('.wn-context-menu-info')).toContainText('Berth swap')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r207-drafts-menu')}`)

  await item(page, 'Discard draft').click()
  await expect(page.getByTestId('mail-draft-row')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('mail-row-note')).toContainText('Draft discarded', { timeout: 30_000 })
})
