/**
 * A big mail and its attachments in the Mail reader, driven as a person drives it.
 *
 * 2026-11-13, the report: a Gmail message with a 2.2 MB PDF opened as "This message body is too big
 * to cache, so Walnut did not fetch it.", and clicking the attachment showed nothing. His words: "why
 * not see? also if I click attachment also not show, but please don't auto download, I will download
 * attachment if needed". The fixture (`PW_MAIL_ATTACHMENTS=1`, attachment-set.mjs) is that message:
 * a source of about 2.4 MB whose text is a few hundred bytes, with a 2.3 MB PDF, a PNG and an html
 * file. In order, because each step is the next one's setup:
 *
 *   1. The body is READ: its text is on screen and no "too big" notice is.
 *   2. NOTHING about an attachment is requested while reading: not on open, not on hover, not later.
 *      Counted twice, in the browser (requests to the attachment route) and at the provider (its
 *      `getAttachment` log), because a request the browser never made and one the server answered
 *      from somewhere else would each fool one of the two.
 *   3. A click on the PDF opens Walnut's PDF viewer on page 1, with a Download button that saves it.
 *   4. A click on the image shows the image.
 *   5. A click on the html file DOWNLOADS it: no viewer, no new tab, no frame anywhere holds its text,
 *      and its script never ran.
 *
 * Engine-neutral; WebKit (`PW_WEBKIT=1 --project webkit`) only if a layout or painting question about
 * the viewer comes up. Runs on a Linux dev host, never on the Mac.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot, showAllMail } from './mail-review-helpers'

const WRITER = 'fixture:ctx-writer@example.invalid'
const BIG = 'INBOX:12:1'
const PDF = '2'
const IMAGE = '3'
const HTML = '4'
const ATTACHMENT_ROUTE = /\/api\/plugins\/mail\/messages\/[^/?]+\/[^/?]+\/attachments\//

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0
let home = ''
let shotDir = ''

test.beforeAll(async ({ browserName }) => {
  test.setTimeout(300_000)
  shotDir = `/tmp/mail-attachments/shots/${browserName}`
  await fs.mkdir(shotDir, { recursive: true })
  const fixture = await server.start({ PW_MAIL_ATTACHMENTS: '1', PW_MAIL_DENSE: '' })
  port = fixture.port
  home = fixture.home
})

test.afterAll(async () => { await server.stop() })

const errors: string[] = []
test.beforeEach(({ page }) => {
  errors.length = 0
  page.on('pageerror', (error) => { errors.push(error.message); console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

test.afterEach(() => { expect(errors, 'the page threw').toEqual([]) })

interface AttachmentCall { messageId: string; attachmentId: string }

async function attachmentCalls(): Promise<AttachmentCall[]> {
  try { return JSON.parse(await fs.readFile(`${home}/mail-fixture-attachment-calls.json`, 'utf8')) as AttachmentCall[] }
  catch { return [] }
}

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

function chip(page: Page, attachmentId: string): Locator {
  return page.locator(`[data-testid="mail-attachment"][data-attachment-id="${attachmentId}"]`)
}

async function openInbox(page: Page): Promise<void> {
  // This mail is read on arrival and the Inbox opens Grouped (unread only): the flat list, per page.
  await showAllMail(page)
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, BIG)).toBeVisible({ timeout: 90_000 })
}

test('a big mail reads, nothing downloads until a click, and each kind of file opens its own way', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (request) => { if (ATTACHMENT_ROUTE.test(request.url())) asked.push(request.url()) })
  await page.setViewportSize({ width: 1280, height: 860 })

  await openInbox(page)
  await row(page, BIG).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', BIG, { timeout: 60_000 })

  // 1. The body is read, not refused.
  const body = page.frameLocator('[data-testid="mail-html-frame"]')
  await expect(body.getByText('north basin')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mail-body-error')).toHaveCount(0)
  await expect(page.getByText('too big to cache')).toHaveCount(0)

  // 2. Three chips, each a control, and not one byte asked for: on open, on hover, a while later.
  await expect(page.getByTestId('mail-attachment')).toHaveCount(3)
  await expect(chip(page, PDF)).toHaveAttribute('data-viewer', 'pdf')
  await expect(chip(page, IMAGE)).toHaveAttribute('data-viewer', 'image')
  await expect(chip(page, HTML)).toHaveAttribute('data-viewer', 'download')
  for (const id of [PDF, IMAGE, HTML]) await chip(page, id).hover()
  await page.waitForTimeout(2_000)
  expect(asked, 'reading the mail asked for an attachment').toEqual([])
  expect(await attachmentCalls(), 'the provider was asked for an attachment before a click').toEqual([])
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), shotDir, 'read-no-download')}`)

  // 3. The PDF: Walnut's own viewer, page 1, and a Download button that saves the file.
  await chip(page, PDF).click()
  const viewer = page.getByTestId('mail-attachment-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveAttribute('data-kind', 'pdf')
  // Focus moves into the dialog, and comes back to the chip that opened it (below).
  await expect.poll(() => viewer.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await expect(viewer.locator('.fv-pdf-page-count')).toHaveText('1 / 1', { timeout: 60_000 })
  await expect(viewer.locator('.fv-pdf-text').first()).toContainText('Harbour survey, page 1', { timeout: 30_000 })
  await expect(viewer.locator('.fv-pdf-page[data-page="1"] canvas')).toBeVisible()
  const download = viewer.getByTestId('mail-attachment-download')
  await expect(download).toBeVisible()
  await expect(download).toHaveAttribute('download', 'harbour-survey.pdf')
  console.log(`shot: ${await shoot(page, shotDir, 'pdf-viewer')}`)
  const [saved] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(saved.suggestedFilename()).toBe('harbour-survey.pdf')
  const savedPath = await saved.path()
  expect((await fs.stat(savedPath)).size).toBeGreaterThan(2_000_000)
  await viewer.getByTestId('mail-attachment-close').click()
  await expect(viewer).toHaveCount(0)
  await expect(chip(page, PDF)).toBeFocused()

  // 4. The image, in the image viewer; Escape closes it.
  await chip(page, IMAGE).click()
  await expect(viewer).toHaveAttribute('data-kind', 'image')
  const image = viewer.getByTestId('mail-attachment-image')
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(96)
  console.log(`shot: ${await shoot(page, shotDir, 'image-viewer')}`)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(chip(page, IMAGE)).toBeFocused()

  // 5. The html file downloads. Nothing renders it: no viewer, no new tab, no frame with its text.
  const tabs = page.context().pages().length
  const [file] = await Promise.all([page.waitForEvent('download'), chip(page, HTML).click()])
  expect(file.suggestedFilename()).toMatch(/notice.*draft.*\.html$/)
  await expect(viewer).toHaveCount(0)
  expect(page.context().pages().length).toBe(tabs)
  for (const frame of page.frames()) expect(await frame.locator('#rendered').count()).toBe(0)
  expect(await page.title()).not.toBe('ran')

  // One provider call per thing a person did, and only for this message's files.
  const calls = await attachmentCalls()
  expect(calls.every((one) => one.messageId === BIG)).toBe(true)
  expect(new Set(calls.map((one) => one.attachmentId))).toEqual(new Set([PDF, IMAGE, HTML]))
  // The page sees the two viewers' fetches; a download a link starts is the browser's own request,
  // which the page's request listener does not always report, so the provider count above is the
  // one that proves every click asked once.
  expect(asked.length).toBeGreaterThanOrEqual(2)
  expect(asked.every((url) => url.includes(encodeURIComponent(BIG)) || url.includes(BIG))).toBe(true)
})

test('the viewer fits the window and closes from its backdrop', async ({ page }) => {
  await openInbox(page)
  await row(page, BIG).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', BIG, { timeout: 60_000 })
  // Narrowed only once the mail is open: below about 1000 px the folder list folds away, and the
  // question here is the viewer's fit, not the narrow layout's navigation.
  await page.setViewportSize({ width: 900, height: 700 })
  await chip(page, IMAGE).click()
  const viewer = page.getByTestId('mail-attachment-viewer')
  await expect(viewer).toBeVisible()
  const box = await viewer.boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: 900, height: 700 })
  // The bar's buttons are inside the window.
  for (const id of ['mail-attachment-download', 'mail-attachment-close']) {
    const button = await viewer.getByTestId(id).boundingBox()
    expect(button!.x + button!.width).toBeLessThanOrEqual(900)
  }
  // A click on the dark field (not the image) closes it.
  await page.mouse.click(20, 680)
  await expect(viewer).toHaveCount(0)
})

test('in the Mac app, Download saves the file into Downloads and says where', async ({ page }) => {
  // The Mac app's web view, as the console tells it from a browser (web/src/utils/mac-app.ts). Its
  // WKWebView has no download of its own, so a link there did nothing or replaced the console.
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { walnutChrome: { postMessage() {} } } }
  })
  // The fixture's HOME is its own temp dir (mail-app-server.ts), so nothing lands in a real home.
  const downloads = path.join(home, 'Downloads')
  const before = new Set(await fs.readdir(downloads))
  const saves: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/attachments\/[^/]+\/save$/.test(new URL(request.url()).pathname)) saves.push(request.url())
  })
  let browserDownloads = 0
  page.on('download', () => { browserDownloads += 1 })

  await openInbox(page)
  await row(page, BIG).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', BIG, { timeout: 60_000 })
  const consoleUrl = page.url()

  // The PDF viewer's Download is a button here, and the bar says where the file went.
  await chip(page, PDF).click()
  const viewer = page.getByTestId('mail-attachment-viewer')
  await expect(viewer.locator('.fv-pdf-page-count')).toHaveText('1 / 1', { timeout: 60_000 })
  const download = viewer.getByTestId('mail-attachment-download')
  await expect(download).toHaveJSProperty('tagName', 'BUTTON')
  await download.click()
  const viewerLine = viewer.getByTestId('mail-attachment-save-status')
  await expect(viewerLine).toHaveText('Saved to Downloads as harbour-survey.pdf', { timeout: 60_000 })
  console.log(`shot: ${await shoot(page, shotDir, 'mac-app-saved')}`)
  // Pressed again: a second file, never over the first.
  await download.click()
  await expect(viewerLine).toHaveText('Saved to Downloads as harbour-survey (1).pdf', { timeout: 60_000 })
  await viewer.getByTestId('mail-attachment-close').click()
  await expect(viewer).toHaveCount(0)

  // A file with no viewer: its chip saves it too, and the line under the chips says where.
  await expect(chip(page, HTML)).toHaveJSProperty('tagName', 'BUTTON')
  await chip(page, HTML).click()
  await expect(page.getByTestId('mail-reader').getByTestId('mail-attachment-save-status'))
    .toHaveText('Saved to Downloads as notice _draft_.html', { timeout: 60_000 })
  await expect(viewer).toHaveCount(0)

  // The console stayed where it was, and the browser itself downloaded nothing.
  expect(page.url()).toBe(consoleUrl)
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', BIG)
  expect(browserDownloads).toBe(0)
  expect(saves).toHaveLength(3)

  // On disk, whole, in the fixture's Downloads.
  const added = (await fs.readdir(downloads)).filter((name) => !before.has(name)).sort()
  expect(added).toEqual(['harbour-survey (1).pdf', 'harbour-survey.pdf', 'notice _draft_.html'])
  expect((await fs.stat(path.join(downloads, 'harbour-survey.pdf'))).size).toBeGreaterThan(2_000_000)
  expect(await fs.readFile(path.join(downloads, 'notice _draft_.html'), 'utf8')).toContain('id="rendered"')
})
