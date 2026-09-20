/**
 * The message row's right-click in WEBKIT, which is the engine the Mac app is (C26, C74, C75).
 *
 * Only what an engine can disagree about, and here that is the GESTURE and the SELECTION.
 *
 * MEASURED, and it is why the row is not a `<button>`: in WebKit a drag inside a form control produces
 * NO selection at all, and no amount of `user-select: text` changes that. Probed three ways on a page of
 * the same shape (`user-select` on the span, both spellings on the span, both spellings on the button
 * too): all three selected nothing in WebKit and all three selected in Chromium. The same span inside
 * a `<div role="button" tabindex="0">` selects in WebKit on the first try, which is what the row became,
 * so the G15 promise (Copy / Look Up / Translate stay available on a row's text) now holds in both
 * engines and the first case here is graded rather than marked as a known gap.
 *
 * The other two cases are the half that does hold in this engine, and it is the one the Mac app lives
 * on: a right-click is Walnut's menu, ON THE ROW'S OWN WORDS as well as off them, it opens nothing and
 * it writes nothing. The words half needed the shared rule to stop counting a selection the right-press
 * itself made (`selectionForGesture`); before that, every point over a subject or a snippet handed the
 * gesture to the browser and the row's menu was unreachable in the Mac app.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file rather
 * than a project, and its two helpers are inline: importing the Chromium spec would run all fifteen of
 * its cases in this engine as well.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-context-row/webkit'

const WRITER = 'fixture:ctx-writer@example.invalid'
const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'

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

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

/** Drag across an element's text the way a person does, and report what got selected. */
async function dragAcross(page: Page, target: Locator): Promise<string> {
  const box = (await target.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  for (let at = 4; at <= Math.min(box.width - 2, 160); at += 12) {
    await page.mouse.move(box.x + at, y)
  }
  await page.mouse.up()
  return page.evaluate(() => {
    const selection = window.getSelection()
    return selection && !selection.isCollapsed ? selection.toString() : ''
  })
}

/**
 * A point inside the row that is NOT over its text.
 *
 * WebKit selects the WORD under a right-click, so aiming at the subject or the snippet is aiming at
 * the one case where the shared rule deliberately keeps the browser's own menu. The empty space to the
 * right of the subject is still the row, and still the gesture's target.
 */
async function pointOffText(target: Locator): Promise<{ x: number, y: number }> {
  const box = (await target.boundingBox())!
  const subject = (await target.locator('.mail-row-subject-text').boundingBox())!
  return {
    x: Math.round(Math.min(subject.x + subject.width + 24, box.x + box.width - 8) - box.x),
    y: Math.round(subject.y + subject.height / 2 - box.y),
  }
}

async function openWriterInbox(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, KEEPER)).toBeVisible({ timeout: 90_000 })
}

test('C75, C26, C74: a row\'s text can be selected, and selecting it opens nothing', async ({ page }) => {
  // The gap this case was written for is CLOSED: while a row was a `<button>`, WebKit refused a
  // selection inside it whatever `user-select` said, so the native Copy / Look Up menu was unreachable
  // on a mail row in the Mac app and the click gate had nothing to hold back (the drag arrived as a
  // click that opened the message). The row is a `div role="button"` now, which selects in both
  // engines, so this is graded rather than marked `test.fail`.
  await openWriterInbox(page)
  const subject = await dragAcross(page, row(page, KEEPER).locator('.mail-row-subject-text'))
  expect(subject.trim().length, 'the subject line is selectable').toBeGreaterThan(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const snippet = await dragAcross(page, row(page, KEEPER).locator('.mail-row-snippet'))
  expect(snippet.trim().length, 'and so is the snippet').toBeGreaterThan(0)
  // With a live selection the browser's own menu is the better one, so Walnut's must not appear. ON THE
  // SELECTED WORDS: now that a row's text really is selectable, a right-press on text OUTSIDE the
  // selection collapses it before any handler runs, and with no selection left Walnut's menu is the
  // right answer there. The selection above ended in the snippet, so that is where the press goes.
  await row(page, KEEPER).locator('.mail-row-snippet').click({ button: 'right' })
  await page.waitForTimeout(300)
  expect(await page.locator('.wn-context-menu').count(), 'the browser keeps this one').toBe(0)
})

test('C26, C12: with no selection the right-click is Walnut\'s, and it opens nothing', async ({ page }) => {
  await openWriterInbox(page)
  // The reader is holding another message, so "nothing opened" is a comparison rather than a guess.
  await row(page, LUNCH).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LUNCH, { timeout: 60_000 })
  // The SUBJECT plus the open pair, not the pane's whole text: a body arrives asynchronously and adds
  // a trailing line while it settles, which is not the pane changing what it is showing.
  const readerBefore = await page.getByTestId('mail-reader-subject').innerText()
  const openedBefore = await page.getByTestId('mail-reader').getAttribute('data-message-id')

  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/\/api\/plugins\/mail\/messages\/[^?]+$/.test(url) && request.method() === 'GET') calls.push(url)
    if (url.endsWith('/read')) calls.push(url)
  })

  await row(page, KEEPER).click({ button: 'right', position: await pointOffText(row(page, KEEPER)) })
  await expect(page.getByTestId('mail-row-ctx-menu')).toHaveCount(1)
  // The engine WebKit leaves `<button>`s out of its own tab order, so the menu's own arrow keys are
  // what has to work: it takes focus itself and moves to its first item.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.wn-context-menu-item.focused')).toHaveCount(1)

  await expect(row(page, KEEPER)).toHaveAttribute('data-ctx-open', 'true')
  await expect(row(page, KEEPER)).not.toHaveAttribute('aria-current', /.*/)
  await expect(page.locator('.mail-row.selected')).toHaveAttribute('data-message-id', LUNCH)
  expect(await page.getByTestId('mail-reader-subject').innerText()).toBe(readerBefore)
  expect(await page.getByTestId('mail-reader').getAttribute('data-message-id')).toBe(openedBefore)
  // Graded on the RIGHT-CLICKED row, and on nothing else reaching the server. The left click above is
  // what marks LUNCH read, and that write is not over when the reader has painted: the row flips
  // optimistically and the POST follows, so in WebKit under load it lands inside this window (measured
  // 2026-09-18). Asserting a flat zero graded the open's own documented write as the menu's doing.
  const about = (id: string) => calls.filter((url) => url.includes(encodeURIComponent(id)))
  expect(about(KEEPER), 'a right-click is not a read and not a write').toEqual([])
  expect(calls.filter((url) => !about(LUNCH).includes(url)), 'and nothing else went out').toEqual([])
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'row-menu-open')}`)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mail-row-ctx-menu')).toHaveCount(0)
  await expect(row(page, KEEPER)).not.toHaveAttribute('data-ctx-open', /.*/)
})

test('C26, C66: a right-click on the row\'s own words opens Walnut\'s menu here too', async ({ page }) => {
  await openWriterInbox(page)
  // This engine SELECTS THE WORD under a right-press as the press's own default action, so by the time
  // the handler runs there is a live selection nobody asked for. Rule 2 fired on it and the row's menu
  // could never open over a subject or a snippet in the Mac app, while Chromium (which does not
  // pre-select) opened it every time. The shared rule now asks whether the selection was there BEFORE
  // the press (`selectionForGesture`): one the press made counts as none, one the human made is still
  // theirs. The menu is the answer here, and the selection is not left lit up behind it.
  const snippet = row(page, KEEPER).locator('.mail-row-snippet')
  await snippet.click({ button: 'right' })
  await expect(page.getByTestId('mail-row-ctx-menu')).toHaveCount(1)
  const selected = await page.evaluate(() => {
    const selection = window.getSelection()
    return selection && !selection.isCollapsed ? selection.toString() : ''
  })
  expect(selected.trim(), 'the word the press selected is dropped with it').toBe('')
  // Still the gesture this slice promises: nothing opened, nothing marked read.
  await expect(row(page, KEEPER)).toHaveAttribute('data-ctx-open', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mail-row-ctx-menu')).toHaveCount(0)
})
