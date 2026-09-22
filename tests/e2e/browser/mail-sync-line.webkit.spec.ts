import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  folderRow,
  openMail,
  shoot,
  smartRow,
} from './mail-review-helpers'

/**
 * The same footer in WEBKIT, which is the engine the Mac app is.
 *
 * Only what an engine can disagree about: the line's own geometry inside a 204px column whose scrollbar
 * takes layout width here, and whether the 30 s tick fires in WKWebView at all. The wording, the states
 * and the request counting are the same DOM in both engines and are graded once, in the Chromium file.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file rather
 * than a project. Run it with `PW_WEBKIT=1 … --project=webkit`; without both, it runs as Chromium and
 * the first case says so.
 */

const SHOT_DIR = '/tmp/mail-sync-line/webkit'
const LINE = 'mail-sync-line'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

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

test('one line at the pane foot, in the flow, saying the same thing', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 90_000 })
  await folderRow(page, HARBOUR, 'INBOX').click()

  const line = page.getByTestId(LINE)
  await expect(line).toHaveText(/^Checked (just now|\d+ min ago)$/, { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'checked')
  await expect(line).toHaveAttribute('title', /^Last checked .+ · Harbour mail: .+ · Marina mail: /)

  // The engine whose scrollbar takes 15px out of a 204px column: still ONE line, nothing cut off, and a
  // footer's height rather than a card's. A ratio line-height rounds DOWN here, which is how a capped box
  // gains half a row in the Mac app and nowhere else.
  const box = await line.evaluate((el) => {
    const style = getComputedStyle(el)
    const content = el.clientHeight
      - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
    return {
      lines: Math.round(content / Number.parseFloat(style.lineHeight)),
      height: Math.round(el.getBoundingClientRect().height),
      cut: el.scrollWidth - el.clientWidth,
      position: style.position,
    }
  })
  expect(box.lines, 'one line at 204px').toBe(1)
  expect(box.height, 'a footer, not a card').toBeLessThanOrEqual(26)
  expect(box.cut, 'the sentence fits, or is ellipsed rather than overflowing').toBeLessThanOrEqual(1)
  expect(box.position, 'never an overlay').toBe('static')

  // A merged row reads the same here.
  await smartRow(page, 'inbox').click()
  await expect(line).toHaveText(/^Checked /, { timeout: 60_000 })
  console.log(`webkit sync line: ${JSON.stringify(box)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-pane')}`)
})

test('the 30 s tick fires in WKWebView', async ({ page }) => {
  await page.clock.install({ time: new Date() })
  await page.route((url) => url.pathname.endsWith('/mailboxes'), async (route) => {
    const answer = await route.fetch()
    const body = await answer.json() as { mailboxes?: Array<{ lastSyncAt?: number }> }
    for (const row of body.mailboxes ?? []) row.lastSyncAt = Date.now()
    await route.fulfill({ response: answer, json: body })
  })
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  await folderRow(page, HARBOUR, 'INBOX').click()

  const line = page.getByTestId(LINE)
  await expect(line).toHaveAttribute('data-at', /^\d+$/, { timeout: 60_000 })
  const at = Number(await line.getAttribute('data-at'))
  await page.clock.pauseAt(new Date(at + 1_000))
  await expect(line).toHaveText('Checked just now', { timeout: 30_000 })
  await page.clock.fastForward(90_000)
  await expect(line).toHaveText('Checked 1 min ago', { timeout: 30_000 })
})

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
