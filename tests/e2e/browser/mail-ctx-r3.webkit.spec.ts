/**
 * Round 3 of the mail right-click slice in WEBKIT, which is the engine the Mac app is.
 *
 * Six of the ten fixes are paint or focus facts, and those are exactly the ones an engine can disagree
 * about: a title block's rule and type, one width per list, where a wrapped sentence sits, whether the
 * keyboard highlight is painted in the frame after the press, and where focus lands after Escape (WebKit
 * does not focus a control on mousedown at all, which is why the row is passed in rather than read from
 * `document.activeElement`).
 *
 * A `test.use` browser pin only holds in the file it is written in, so these cases live here rather than
 * in a shared registrar. The webkit project is opt-in:
 *
 *   PW_WEBKIT=1 npx playwright test tests/e2e/browser/mail-ctx-r3.webkit.spec.ts --project=webkit
 *
 * The first case asserts the engine off `navigator.userAgent`: a run under the chromium project is a
 * vacuous pass, and this file exists for the other engine.
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot, smartRow } from './mail-review-helpers'
import {
  KEEPER, LEASE, LUNCH, READER, WRITER,
  engineOf, intoWriterInbox, item, itemLabels, menu, openRowMenu, row,
} from './mail-context-fixes-core'
import {
  activeRowId, focusedShape, headingShape, menuWidth, reasonShape,
} from './mail-ctx-r3-core'

const SHOTS = '/tmp/mail-ctx-r3/webkit'
const READ_ROW = 'INBOX:2:11'
const DRAFT_ROW = 'Drafts:1:4'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
  port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
})
test.afterAll(async () => { await server.stop() })

test('this file really is WebKit', async ({ page }) => {
  await openMail(page, port)
  expect(await engineOf(page)).toBe('webkit')
})

test('R3-01 the heading is a title block in WebKit too', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, LUNCH)
  const one = await headingShape(page)
  expect(one.infos[0]!.rule).toBeGreaterThanOrEqual(1)
  expect(one.infos[0]!.cursor).toBe('default')
  expect(one.infos[0]!.font).toBeLessThan(one.firstItem.font)
  expect(one.gap).toBeGreaterThanOrEqual(4)
  await page.keyboard.press('Escape')

  await smartRow(page, 'inbox').click()
  await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, WRITER, LUNCH)
  const two = await headingShape(page)
  expect(two.infos.length).toBe(2)
  expect(two.infos[0]!.rule).toBe(0)
  expect(two.infos[1]!.rule).toBeGreaterThanOrEqual(1)
  console.log(`shot: ${await shoot(page, SHOTS, 'r3-01-title-block-webkit')}`)
})

test('R3-02 one width per list in WebKit', async ({ page }) => {
  await intoWriterInbox(page, port)
  const widths: number[] = []
  for (const id of [KEEPER, LUNCH, LEASE]) {
    await openRowMenu(page, WRITER, id)
    widths.push(await menuWidth(page))
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
  }
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, READER, READ_ROW)
  widths.push(await menuWidth(page))
  expect(new Set(widths).size, `widths differed: ${widths.join(', ')}`).toBe(1)
  console.log(`shot: ${await shoot(page, SHOTS, 'r3-02-one-width-webkit')}`)
})

test('R3-03 the disabled reason keeps one height per row in WebKit', async ({ page }) => {
  await openMail(page, port)
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, READ_ROW)).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, READER, READ_ROW)
  const shape = await reasonShape(page)
  expect(shape.reasons).toBe(1)
  expect(shape.reasonLeft).toBe(shape.labelLefts[0])
  expect(new Set(shape.heights).size, `rows differed: ${shape.heights.join(', ')}`).toBe(1)
  console.log(`shot: ${await shoot(page, SHOTS, 'r3-03-reason-row-webkit')}`)
})

test('R3-06 the row the reader holds offers no Open message in WebKit', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, LEASE)
  expect(await item(page, 'Open message').getAttribute('title')).toBeNull()
  await page.keyboard.press('Escape')
  await openRowMenu(page, WRITER, LUNCH)
  expect(await item(page, 'Open message').getAttribute('title')).toBe('Opening a message marks it read')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await row(page, WRITER, LEASE).click()
  await expect(page.locator('.mail-reader-head')).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, WRITER, LEASE)
  expect(await itemLabels(page)).not.toContain('Open message')
})

test('R3-08 the keyboard highlight is painted in WebKit, in the frame after the press', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, LUNCH)
  await page.keyboard.press('ArrowDown')
  const lit = await focusedShape(page)
  expect(lit.label).not.toBe('')
  expect(lit.ring).toMatch(/inset/)
  expect(lit.background).not.toBe('rgba(0, 0, 0, 0)')
  console.log(`shot: ${await shoot(page, SHOTS, 'r3-08-keyboard-highlight-webkit')}`)
})

test('R3-09 Escape returns the keyboard to the row in WebKit', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openRowMenu(page, WRITER, LUNCH)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await activeRowId(page)).toBe(`row ${LUNCH}`)
  await folderRow(page, WRITER, 'Archive').click({ button: 'right' })
  await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(0)
  expect(await activeRowId(page)).toBe('folder Archive')
})

test('R3-10 the provider draft row has its own menu in WebKit', async ({ page }) => {
  await openMail(page, port)
  await page.locator(`.mail-mailbox[data-account-id="${WRITER}"][data-mailbox-id="__walnut_drafts__"]`).click()
  const draft = page.locator(`.mail-row[data-message-id="${DRAFT_ROW}"]`)
  await expect(draft).toBeVisible({ timeout: 60_000 })
  await draft.click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  expect(await itemLabels(page)).toEqual(['Continue editing', 'Make a task', 'Copy Walnut link'])
  console.log(`shot: ${await shoot(page, SHOTS, 'r3-10-drafts-row-menu-webkit')}`)
})
