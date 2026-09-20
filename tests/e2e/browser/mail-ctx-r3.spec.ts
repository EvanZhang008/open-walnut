/**
 * Round 3 of the mail right-click slice, measured in the browser.
 *
 * One case per graded id, each one written to fail on the shape the reviewer measured:
 *
 *  · R3-01 the heading was two more menu rows, ending 1px above the first action with no rule.
 *  · R3-02 the panel was content-sized, so its own edge moved from one right-click to the next.
 *  · R3-03 the disabled group's sentence rode inside the first row of the group, indented 22px for an
 *    icon column this menu never draws, making that row 52px tall next to its 30px siblings.
 *  · R3-04 the header chip read `{n} unread · showing`, and a filtered folder's sidebar row said nothing.
 *  · R3-05 a reply to an HTML-only message saved a draft whose quote was the attribution line alone.
 *  · R3-06 `Open message` was drawn on the row the reader already shows, and warned about marking read
 *    on rows that were already read.
 *  · R3-07 the refusal sentence sat 620px from the row it names, with the row's own mark hover-only.
 *  · R3-08 the keyboard highlight was an 8% tint with no ring, transparent in the frame after the press.
 *  · R3-09 Escape dropped focus to BODY instead of the row the gesture started on.
 *  · R3-10 the provider's Drafts folder had no rows, so the drafts branch of the menu was never driven.
 *
 * Runs in whichever project it is launched with; the WebKit half is pinned in its own file.
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot, smartRow } from './mail-review-helpers'
import {
  KEEPER, LEASE, LUNCH, READER, WRITER,
  intoWriterInbox, item, itemLabels, menu, openRowMenu, row,
} from './mail-context-fixes-core'
import {
  activeRowId, filterShape, focusedShape, headingShape, menuWidth, reasonShape, refusalMark,
} from './mail-ctx-r3-core'

const SHOTS = '/tmp/mail-ctx-r3'
const READ_ROW = 'INBOX:2:11'
const DRAFT_ROW = 'Drafts:1:4'

test.describe('mail right-click, round 3 fixes', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test.describe.configure({ mode: 'default' })
  const server = new MailFixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOTS, { recursive: true })
    port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
  })
  test.afterAll(async () => { await server.stop() })

  test('R3-01 the heading is a title block with a rule under it, not two more menu rows', async ({ page }) => {
    await intoWriterInbox(page, port)
    await openRowMenu(page, WRITER, LUNCH)
    const one = await headingShape(page)
    expect(one.infos.length, 'a single-account list names the message on one line').toBe(1)
    expect(one.infos[0]!.rule, 'the block is closed by a rule').toBeGreaterThanOrEqual(1)
    expect(one.infos[0]!.cursor, 'and it does not pretend to be pressable').toBe('default')
    expect(one.infos[0]!.font, 'title type is smaller than an item').toBeLessThan(one.firstItem.font)
    expect(one.gap, 'the 1px no-rule gap is gone').toBeGreaterThanOrEqual(4)
    await page.keyboard.press('Escape')

    // The two-line block, which is what the reviewer measured: a merged list adds the account line.
    await smartRow(page, 'inbox').click()
    await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
    await openRowMenu(page, WRITER, LUNCH)
    const two = await headingShape(page)
    expect(two.infos.length).toBe(2)
    expect(two.infos[0]!.rule, 'only the LAST line carries the rule').toBe(0)
    expect(two.infos[1]!.rule).toBeGreaterThanOrEqual(1)
    expect(two.infos[1]!.font, 'the account line is the subtitle').toBeLessThanOrEqual(two.infos[0]!.font)
    expect(two.gap).toBeGreaterThanOrEqual(4)
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-01-title-block')}`)
  })

  test('R3-02 every row of one list opens the same width', async ({ page }) => {
    await intoWriterInbox(page, port)
    const widths: number[] = []
    for (const id of [KEEPER, LUNCH, LEASE]) {
      await openRowMenu(page, WRITER, id)
      widths.push(await menuWidth(page))
      await page.keyboard.press('Escape')
      await expect(menu(page)).toHaveCount(0)
    }
    // The account that cannot send: its disabled reason used to set the width (319px measured).
    await folderRow(page, READER, 'INBOX').click()
    await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
    await openRowMenu(page, READER, READ_ROW)
    widths.push(await menuWidth(page))
    expect(new Set(widths).size, `widths differed: ${widths.join(', ')}`).toBe(1)
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-02-one-width')}`)
  })

  test('R3-03 the disabled reason is one row under the group, aligned with the labels', async ({ page }) => {
    await openMail(page, port)
    await folderRow(page, READER, 'INBOX').click()
    await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
    await openRowMenu(page, READER, READ_ROW)
    const shape = await reasonShape(page)
    expect(shape.reasons, 'one sentence for the group of three').toBe(1)
    expect(shape.icons, 'this menu draws no icon column').toBe(0)
    expect(shape.reasonLeft, 'so the sentence is not indented past one').toBe(shape.labelLefts[0])
    expect(new Set(shape.heights).size, `rows differed in height: ${shape.heights.join(', ')}`).toBe(1)
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-03-reason-row')}`)
  })
  test('R3-06 no Open message on the row the reader holds, and the warning is only true rows', async ({ page }) => {
    await intoWriterInbox(page, port)
    // A row that is already READ: opening it cannot change a flag that is set, so no warning.
    await openRowMenu(page, WRITER, LEASE)
    expect(await itemLabels(page)).toContain('Open message')
    expect(await item(page, 'Open message').getAttribute('title')).toBeNull()
    await page.keyboard.press('Escape')

    // An UNREAD row: the one place the warning is true.
    await openRowMenu(page, WRITER, LUNCH)
    expect(await item(page, 'Open message').getAttribute('title'))
      .toBe('Opening a message marks it read')
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)

    // Open that read row in the reader (no write: it is already read), then ask it again.
    await row(page, WRITER, LEASE).click()
    await expect(page.locator('.mail-reader-head')).toBeVisible({ timeout: 60_000 })
    await openRowMenu(page, WRITER, LEASE)
    const labels = await itemLabels(page)
    expect(labels, 'the item that would do nothing is gone').not.toContain('Open message')
    expect(labels, 'and the rest of the menu is still there').toContain('Copy Walnut link')
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-06-open-row-menu')}`)
  })

  test('R3-08 the keyboard highlight is visible in the frame after the press', async ({ page }) => {
    await intoWriterInbox(page, port)
    await openRowMenu(page, WRITER, LUNCH)
    await page.keyboard.press('ArrowDown')
    // Read with NO settle: that timing is the bug (a 0.1s background transition made the first frame
    // transparent, so a screenshot taken then showed no highlight at all).
    const lit = await focusedShape(page)
    expect(lit.label, 'the first item is highlighted').not.toBe('')
    expect(lit.ring, 'a ring a person can find at a glance').toMatch(/inset/)
    expect(lit.ring).not.toBe('none')
    expect(lit.background, 'and a fill that is actually painted').not.toBe('rgba(0, 0, 0, 0)')
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-08-keyboard-highlight')}`)
  })

  test('R3-09 Escape hands the keyboard back to the row it started on', async ({ page }) => {
    await intoWriterInbox(page, port)
    await openRowMenu(page, WRITER, LUNCH)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    expect(await activeRowId(page)).toBe(`row ${LUNCH}`)

    // The same rule on the sidebar, where the gesture is on the `<li>` around the row.
    await folderRow(page, WRITER, 'Archive').click({ button: 'right' })
    await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(0)
    expect(await activeRowId(page)).toBe('folder Archive')
  })
  test('R3-04 the filter chip finishes its sentence and the sidebar row says it is on', async ({ page }) => {
    await intoWriterInbox(page, port)
    await folderRow(page, WRITER, 'INBOX').click({ button: 'right' })
    await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
    await page.getByRole('menuitem').filter({ hasText: 'Show only unread in this folder' }).first().click()
    await expect.poll(async () => (await filterShape(page, WRITER, 'INBOX')).sidebar, { timeout: 30_000 })
      .toBe('1')
    const on = await filterShape(page, WRITER, 'INBOX')
    expect(on.chip, 'the pill states what it is showing').toContain('showing unread only')
    expect(on.chip.endsWith('showing'), `chip stopped mid-phrase: ${on.chip}`).toBe(false)
    expect(on.sidebarTitle).toContain('Showing unread only')

    // A row held on an unread-only list (read in this pass, kept on screen) is admitted in words.
    await openRowMenu(page, WRITER, KEEPER)
    await item(page, 'Mark as read').click()
    await expect.poll(async () => (await filterShape(page, WRITER, 'INBOX')).held, { timeout: 30_000 })
      .toContain('still listed')
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-04-filter-marks')}`)
  })

  test('R3-05 a reply from a row quotes an HTML-only body', async ({ page }) => {
    await intoWriterInbox(page, port)
    await openRowMenu(page, WRITER, KEEPER)
    await item(page, 'Reply all').click()
    const quote = page.locator('.mail-compose-quote-text')
    await expect(quote).toBeVisible({ timeout: 60_000 })
    const text = (await quote.innerText()).replace(/\s+/g, ' ')
    expect(text, 'the body is in the quote, not just the attribution line')
      .toContain('Attendance held up through the wet months.')
    expect(text).toContain('zebra')
    expect(text, 'and no script body came with it').not.toContain('alert(')
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-05-quoted-html')}`)
  })

  test('R3-10 a provider draft row has its own menu, with no read toggle and no reply', async ({ page }) => {
    await openMail(page, port)
    await page.locator(`.mail-mailbox[data-account-id="${WRITER}"][data-mailbox-id="__walnut_drafts__"]`)
      .click()
    const draft = page.locator(`.mail-row[data-message-id="${DRAFT_ROW}"]`)
    await expect(draft, 'the fixture now has a provider draft to right-click').toBeVisible({ timeout: 60_000 })
    await draft.click({ button: 'right' })
    await expect(menu(page)).toHaveCount(1)
    expect(await itemLabels(page)).toEqual(['Continue editing', 'Make a task', 'Copy Walnut link'])
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-10-drafts-row-menu')}`)
  })
})

/**
 * R3-07 on its own server, because it needs every WRITE refused: the refusal sentence sat at the far foot
 * of the column, about 620px from the row it named, and the row's own amber glyph explained itself only in
 * `title`. The row now says the state in words and the mark is a control that brings the provider's reason
 * back, and the sentence carries a way to the row.
 */
test.describe('mail right-click, round 3, a refused flip', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test.describe.configure({ mode: 'default' })
  const refused = new MailFixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOTS, { recursive: true })
    port = (await refused.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '', PW_MAIL_WRITES_503: '1' })).port
  })
  test.afterAll(async () => { await refused.stop() })

  test('R3-07 the refused row says so in words, and the sentence leads back to it', async ({ page }) => {
    await intoWriterInbox(page, port)
    await openRowMenu(page, WRITER, LUNCH)
    await item(page, 'Mark as read').click()
    const mark = page.locator(`.mail-row[data-message-id="${LUNCH}"] [data-testid="mail-row-flag-failed"]`)
    await expect(mark, 'the rolled-back row keeps a mark').toBeVisible({ timeout: 60_000 })
    const shape = await refusalMark(page, LUNCH)
    expect(shape.tag, 'and the mark is a real control').toBe('BUTTON')
    expect(shape.words, 'which says the state without a hover').toContain('still unread')
    expect(shape.title, 'with the provider reason on it').not.toBe('')

    // The way back from the sentence to the row it names.
    const jump = page.getByTestId('mail-row-note-jump')
    await expect(jump).toBeVisible({ timeout: 30_000 })
    await jump.click()
    await expect(page.locator(`.mail-row[data-message-id="${LUNCH}"].flash-target`)).toHaveCount(1)

    // And the row's own mark brings the reason back after the note has been dismissed.
    await page.getByTestId('mail-row-note-close').click()
    await expect(page.getByTestId('mail-row-note')).toHaveCount(0)
    await mark.click()
    await expect(page.getByTestId('mail-row-note')).toBeVisible({ timeout: 30_000 })
    expect((await page.getByTestId('mail-row-note').innerText()).trim().length).toBeGreaterThan(10)
    console.log(`shot: ${await shoot(page, SHOTS, 'r3-07-refusal-pair')}`)
  })
})
