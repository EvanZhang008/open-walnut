import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  accountSection,
  filterShape,
  folderRow,
  openMail,
  paneGeometry,
  pickTheme,
  shoot,
  smartRow,
  tailShape,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * The same round in WEBKIT, which is the engine the Mac app runs (WKWebView).
 *
 * The pin only works at the top level of its own file, so this is a file rather than a project. What can
 * only be graded here: the collapse row's sentence has to fit ONE line in a 204px column whose scrollbar
 * takes layout width, and the pane's four text columns are the argument for the hierarchy, so a 3px
 * difference between engines would be a different picture.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/round2'
const NARROW_COLUMN = { width: 1280, height: 800 }
/**
 * The role rows, by the PROVIDER's own name and in the SERVER's order (round 3, N10 and C9): relabelling
 * them to canonical role names left the real name reachable only on hover, invisible to the tail filter,
 * and re-ordered the rows of every install. The role is on the row as its glyph.
 */
const ROLE_ROWS = ['INBOX', 'Archive', 'Drafts', 'Sent', 'Spam', 'Trash']
/** The other account's own six, in its own server order (its names sort Bin before Drafts). */
const ROLE_ROWS_MARINA = ['Inbox', 'Archived', 'Bin', 'Drafts', 'Junk', 'Sent Mail']

test.setTimeout(420_000)
test.use({ browserName: 'webkit', viewport: NARROW_COLUMN })
test.describe.configure({ mode: 'serial' })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start()
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('F2 F3 F8: one line, one type size, both numbers whole, readable', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  const shape = await tailShape(page, HARBOUR)
  expect(shape.text).toBe('58 more folders, 6 with unread')
  expect(shape.cut.every((one) => one <= 1), `neither clause is cut: ${shape.cut.join(', ')}`).toBe(true)
  expect(shape.gap, 'a real gap after the comma').toBeGreaterThanOrEqual(2)
  expect(Math.abs(shape.height - shape.folderHeight), 'the same height as a folder row')
    .toBeLessThanOrEqual(1)
  expect(shape.contrast, `${shape.colour} in light`).toBeGreaterThanOrEqual(4.5)
  console.log(`webkit collapse row: ${JSON.stringify(shape)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-tail-row')}`)
})

test('F5 C61 F11: the same four text columns, and a filter box that reads down one of them', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
  const geometry = await paneGeometry(page)
  expect(geometry.smartGlyph).toBe(12)
  expect(geometry.folderGlyph).toBe(12)
  expect(geometry.tailGlyph).toBe(12)
  expect(
    { smart: geometry.smartText, folder: geometry.folderText, child: geometry.childText, tail: geometry.tailText },
    'text left edges at 204px in WebKit',
  ).toEqual({ smart: 28, folder: 31, child: 46, tail: 28 })

  await tailToggle(page, HARBOUR).click()
  await expect(page.getByTestId('mail-tail-filter')).toBeVisible()
  const box = await filterShape(page)
  console.log(`webkit filter box: ${JSON.stringify(box)}`)
  expect(box.inputText, 'the input reads down the folder column').toBe(box.folderText)
  expect(Math.abs(Number(box.inputHeight) - Number(box.rowHeight)), 'a row, not a taller box')
    .toBeLessThanOrEqual(1)
  expect(box.border).toBe('0px')
  console.log(`webkit geometry: ${JSON.stringify({ ...geometry, ...box })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-hierarchy')}`)
})

test('F4 F6 C64: one order, a pinned set of role rows, and the collapse row last', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  const names = async (accountId: string) => accountSection(page, accountId)
    .locator('ul.mail-mailboxes .mail-mailbox .mail-mailbox-name')
    .allInnerTexts()
  expect(await names(HARBOUR)).toEqual(ROLE_ROWS)
  expect(await names(MARINA), "each account's own order").toEqual(ROLE_ROWS_MARINA)

  await folderRow(page, HARBOUR, 'INBOX').click()
  await tailToggle(page, HARBOUR).click()
  await page.getByTestId('mail-tail-filter').fill('receipts')
  expect(await names(HARBOUR), 'the role rows stay pinned').toEqual([...ROLE_ROWS, 'Receipts'])
  await expect(page.locator(`${PANE} .mail-mailbox[aria-current="true"]`)).toHaveCount(1)
  await page.getByTestId('mail-tail-filter').fill('')
  const last = await accountSection(page, HARBOUR).locator('ul.mail-mailboxes').evaluate((list) => {
    const items = Array.from(list.children)
    return { count: items.length, toggleAt: items.findIndex((li) => li.querySelector('.mail-tail-toggle')) }
  })
  expect(last.toggleAt, 'the collapse row is the last li').toBe(last.count - 1)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-filtered')}`)
})

test('F2 F5 F8: the same reading in the dark theme', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  await pickTheme(page, 'Dark')
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 60_000 })
  const shape = await tailShape(page, HARBOUR)
  expect(shape.text).toBe('58 more folders, 6 with unread')
  expect(shape.cut.every((one) => one <= 1)).toBe(true)
  expect(shape.contrast, `${shape.colour} in dark`).toBeGreaterThanOrEqual(4.5)
  await twist(page, 'inbox').click()
  const geometry = await paneGeometry(page)
  expect(
    { smart: geometry.smartText, folder: geometry.folderText, child: geometry.childText, tail: geometry.tailText },
    'the theme moves nothing',
  ).toEqual({ smart: 28, folder: 31, child: 46, tail: 28 })
  console.log(`webkit dark: ${JSON.stringify({ ...shape, ...geometry })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-dark-pane')}`)
})
