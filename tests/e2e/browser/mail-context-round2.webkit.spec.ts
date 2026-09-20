/**
 * The second review round in WEBKIT, which is the engine the Mac app is.
 *
 * The subset whose answer is engine-owned rather than logic-owned, and every one of them was measured in
 * both engines during the review:
 *
 *  · R2-05 the clamped box has to FOLLOW the highlight. `scrollIntoView` walks ancestors in this engine
 *    and would scroll the page behind a fixed box, which is why the scroll is done by hand.
 *  · R2-17 the wheel: WebKit delivers it to a different element than Chromium does, and the rule
 *    ("a scroll dismisses a menu anchored to a frozen point") has to fire in both.
 *  · R2-10 the row marks are computed `box-shadow` lists, and the two engines serialise them differently.
 *  · R2-09 the heading's contrast, measured on the real paint in this engine's light theme.
 *  · R2-01 the chip and the folder menu reading one preference: a `useSyncExternalStore` subscription.
 *  · R2-07 a draft row's menu, which needs the composer to have saved a draft here too.
 *
 * A `test.use` browser pin only holds in the file it is written in, so every case lives here. Run:
 *
 *   PW_WEBKIT=1 npx playwright test tests/e2e/browser/mail-context-round2.webkit.spec.ts --project=webkit
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer, folderRow, pickTheme, shoot } from './mail-review-helpers'
import {
  KEEPER, LUNCH, READER, WRITER,
  contrastOf, engineOf, highlightBox, intoWriterInbox, item, markShape, menu, openFolderMenu,
  openRowMenu, row, stripShape, unreadChip,
} from './mail-context-round2-core'

const SHOT_DIR = '/tmp/mail-context-ux/r3/webkit'

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

test('R2-01: the chip follows the folder menu\'s switch in this engine too', async ({ page }) => {
  expect(await engineOf(page), 'this file must really be webkit').toBe('webkit')
  await intoWriterInbox(page, port)
  const before = await unreadChip(page)
  expect(before.on).toBe('false')

  await openFolderMenu(page, WRITER, 'INBOX')
  await item(page, 'Show only unread in this folder').click()
  await expect.poll(async () => (await unreadChip(page)).on, { timeout: 30_000 }).toBe('true')
  const filtered = await unreadChip(page)
  expect(filtered.pressed).toBe('true')
  expect(filtered.unreadRows).toBe(filtered.rows)
  console.log(`chip: ${JSON.stringify(filtered)}`)

  // ONE click restores the list, which is the half that used to need two.
  await page.getByTestId('mail-unread-filter').click()
  await expect.poll(async () => (await unreadChip(page)).rows, { timeout: 30_000 }).toBe(before.rows)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r201-chip')}`)
})

test('R2-05, R2-17: the clamped box follows the highlight, and a wheel outside closes it', async ({ page }) => {
  await intoWriterInbox(page, port)
  await page.setViewportSize({ width: 1280, height: 420 })
  await openRowMenu(page, WRITER, KEEPER)
  const capped = await highlightBox(page)
  expect(capped.hidden, 'the menu is capped here as well').toBeGreaterThan(20)
  expect(capped.more).toBe('true')

  await page.keyboard.press('End')
  const last = await highlightBox(page)
  expect(last.label).toBe('Copy Walnut link')
  expect(last.inside, 'the last item is visible when it is highlighted').toBe(true)
  expect(last.scrollTop, 'the box scrolled, and the page behind it did not').toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  console.log(`end: ${JSON.stringify(last)}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r205-end')}`)

  // R2-17: a wheel over the list behind closes it here too.
  await page.setViewportSize({ width: 1280, height: 800 })
  await openRowMenu(page, WRITER, KEEPER)
  const box = (await page.locator('.mail-rows').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)
  await expect(menu(page)).toHaveCount(0, { timeout: 10_000 })
  expect(await page.locator('[data-testid="mail-reader"][data-message-id]').count()).toBe(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r217-wheel')}`)
})

test('R2-09, R2-10: light-mode heading contrast, and two marks that do not replace each other', async ({ page }) => {
  await intoWriterInbox(page, port)
  await pickTheme(page, 'Light')
  await row(page, WRITER, LUNCH).click()
  await expect(page.locator('[data-testid="mail-reader"][data-message-id]')).toHaveCount(1, { timeout: 30_000 })
  await openRowMenu(page, WRITER, LUNCH)

  const heading = await contrastOf(page, '.wn-context-menu-info')
  expect(heading.ratio, `${heading.colour} on ${heading.background} at ${heading.size}`)
    .toBeGreaterThanOrEqual(4.5)
  const marks = await markShape(page, WRITER, LUNCH)
  expect(marks.keepsBar, 'the selection bar survives the right-click ring').toBe(true)
  expect(marks.ringsWithAccent, 'and the ring is a different kind of mark').toBe(false)
  console.log(`marks: ${JSON.stringify({ heading, marks })}`)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r209-r210-light')}`)
  await page.keyboard.press('Escape')
})

test('R2-11: the disabled items hold the highlight here, with their reason on the row', async ({ page }) => {
  await intoWriterInbox(page, port)
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, 'INBOX:2:11')).toBeVisible({ timeout: 60_000 })
  await openRowMenu(page, READER, 'INBOX:2:11')
  await expect(menu(page).locator('.wn-context-menu-reason').first()).toContainText('cannot send')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const lit = await highlightBox(page)
  expect(lit.label).toMatch(/^Reply/)
  await page.keyboard.press('Enter')
  await expect(menu(page), 'a disabled item runs nothing').toHaveCount(1)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r211-disabled')}`)
  await page.keyboard.press('Escape')
})

test('R2-03, R2-07: the answer strip covers nothing, and a draft row answers with a menu', async ({ page }) => {
  await intoWriterInbox(page, port)
  await openFolderMenu(page, WRITER, 'Archive')
  await item(page, 'Fetch this folder now').click()
  await expect(page.getByTestId('mail-folder-fetch-note').first()).toBeVisible({ timeout: 30_000 })
  const strip = await stripShape(page, 'pane')
  expect(strip.positioned).toBe('static')
  expect(strip.covers, 'no folder row is behind the answer').toBe(0)
  console.log(`strip: ${JSON.stringify(strip)}`)

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
  await draftRow.click({ button: 'right' })
  await expect(page.getByTestId('mail-draft-ctx-menu')).toHaveCount(1)
  const labels = await menu(page).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
  expect(labels.map((one) => one.trim())).toEqual(['Continue editing', 'Discard draft'])
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'r207-drafts')}`)
  await page.keyboard.press('Escape')
})
