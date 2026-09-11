import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'

/**
 * The Mail console's DESIGN, against a dense inbox, in both themes and both engines.
 *
 * The other three mail specs prove the console works. This one proves it holds its shape when the
 * mail is real: forty-three messages, a table-heavy newsletter with the sender's own colours, a
 * 142-character subject, fourteen recipients with nine attachments, a six-thousand-word plain-text
 * mail, a non-Latin subject and body. Every claim here is a measurement, not a screenshot, because
 * "it looks fine" is not something a run can assert:
 *
 *   a. THE READING COLUMN IS BOUNDED. A 1280px pane does not set mail across its whole width.
 *   b. NOTHING SCROLLS SIDEWAYS, at 1280 and at 900, in the page or in the message list.
 *   c. THE BODY IS ON PAPER IN THE DARK THEME TOO. The frame's own `body` is white, whatever the
 *      app around it is, because html mail is authored for white and forcing it dark is what put a
 *      newsletter's blue headings on a black field.
 *   d. AN ATTACHMENT-REFERENCING IMAGE IS NEVER A BROKEN GLYPH. Nothing serves `cid:` bytes, so the
 *      string pass turns those into a chip; a broken-image icon in the middle of the prose reads as
 *      a broken reader.
 *   e. THE COMPOSER'S FOOTER IS A SEND BUTTON, not a paragraph of apology about attachments.
 *   f. A LONG SUBJECT WRAPS instead of pushing the toolbar off the pane, and a row's preview stays
 *      ONE line however long the message is.
 *
 * Screenshots land in /tmp/mail-slack-ui/design/<engine>-<theme>-<step>.png for a human to look at.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home, and
 * with `MAIL_FIXTURE_DENSE=1`, which is the flag the canned provider reads for the extra forty
 * messages. The other specs count the four they have, so density is never the default.
 */

const SHOT_DIR = '/tmp/mail-slack-ui/design'

/** The reading column is 760px wide including its 28px of side padding. */
const COLUMN_MAX = 760

interface Fixture {
  port: number
  home: string
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)
test.use({ viewport: { width: 1280, height: 800 } })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a mail fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Mail fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(output)
      if (!match) return false
      clearTimeout(deadline)
      resolve(JSON.parse(match[1]!) as Fixture)
      return true
    }
    const timer = setInterval(() => {
      if (check()) clearInterval(timer)
      else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Mail fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** Add the account through the dialog, exactly as a human does. */
async function addAccount(page: Page): Promise<void> {
  await page.getByTestId('mail-add-account').click()
  const dialog = page.getByTestId('mail-add-dialog')
  await expect(dialog).toBeVisible()
  await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()
  await page.getByTestId('mail-setup-address').fill('alice@example.invalid')
  await page.getByTestId('mail-setup-token').fill('ok')
  await page.getByTestId('mail-add-submit').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Switch the theme the way the app does: Settings, the theme picker, back to Mail.
 *
 * `useTheme` writes `data-theme` on the document and remembers the choice, and this is the only
 * control that calls it, so driving the real button is the only way to prove the console follows
 * the app rather than the OS.
 */
async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 30_000 })
}

/** No sideways scroll in one element. `+1` absorbs sub-pixel layout, never a real overflow. */
async function noSideScroll(target: Locator, label: string): Promise<void> {
  const measured = await target.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(measured.scroll, `${label} must not scroll sideways`).toBeLessThanOrEqual(measured.client + 1)
}

/** No sideways scroll in the document itself, which is the one the browser puts a bar on. */
async function noPageSideScroll(page: Page, label: string): Promise<void> {
  const measured = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    client: document.scrollingElement?.clientWidth ?? 0,
  }))
  expect(measured.scroll, `${label} must not scroll sideways`).toBeLessThanOrEqual(measured.client + 1)
}

async function shoot(target: Locator | Page, theme: string, step: string): Promise<string> {
  const engine = test.info().project.name
  const path = `${SHOT_DIR}/${engine}-${theme}-${step}.png`
  await target.screenshot({ path })
  return path
}

/** The sandboxed body, which is a separate document with its own colours. */
function bodyFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="mail-html-frame"]')
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_MAIL_PORT: String(port),
      PW_MAIL_PROVIDER: '1',
      // The provider plugin runs INSIDE the fixture server's process, so its environment is this
      // spawn's environment: no plumbing in mail-app-server.ts is needed to reach it.
      MAIL_FIXTURE_DENSE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (child) {
    child.kill('SIGTERM')
    const deadline = Date.now() + 15_000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (fixture?.home.includes('walnut-mail-app-')) {
    await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('a dense inbox keeps its shape, on paper, in both themes', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await addAccount(page)

  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(43, { timeout: 90_000 })

  const shots: string[] = []
  for (const theme of ['light', 'dark'] as const) {
    await pickTheme(page, theme === 'light' ? 'Light' : 'Dark')
    await expect(rows).toHaveCount(43, { timeout: 60_000 })
    shots.push(...await onePass(page, theme))
  }

  // The console must not throw, in either theme, with any of this on screen.
  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
  console.log(`design screenshots:\n${shots.join('\n')}`)
})

/** Every assertion and every screenshot, for one theme. */
async function onePass(page: Page, theme: string): Promise<string[]> {
  const shots: string[] = []
  const consolePane = page.locator('.mail-console')
  const rows = page.getByTestId('mail-row')
  const list = page.getByTestId('mail-message-list')

  // ── (b) the list, at the width the app opens on ──
  await expect(page.getByTestId('mail-list-section')).toContainText('Inbox')
  await noPageSideScroll(page, 'the page')
  await noSideScroll(list, 'the message list')
  await noSideScroll(page.locator('.mail-rows'), 'the message rows')
  await noSideScroll(page.locator('.mail-accounts-pane'), 'the mailbox pane')
  shots.push(await shoot(consolePane, theme, 'list'))

  // ── (f) a newsletter's row: one line of preview, however much it holds ──
  const newsletter = rows.filter({ hasText: 'issue 42' }).first()
  const preview = newsletter.locator('.mail-row-snippet')
  const previewBox = await preview.evaluate((el) => ({
    scroll: el.scrollHeight,
    line: Number.parseFloat(getComputedStyle(el).lineHeight),
  }))
  expect(previewBox.scroll, 'a row preview is one line').toBeLessThanOrEqual(previewBox.line + 2)

  // ── (a, c, d) the html body ──
  await newsletter.click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('issue 42', { timeout: 30_000 })
  const frame = page.getByTestId('mail-html-frame')
  await expect(frame).toBeVisible({ timeout: 30_000 })

  const columnWidth = await page.locator('.mail-reader-head').evaluate((el) => el.getBoundingClientRect().width)
  expect(columnWidth, 'the reading column is bounded').toBeLessThanOrEqual(COLUMN_MAX + 56)
  await noPageSideScroll(page, 'the page with a table-heavy newsletter open')
  await noSideScroll(page.locator('.mail-reader-pane'), 'the reader pane')

  const paper = await bodyFrame(page).locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(paper, `the body renders on paper in the ${theme} theme`).toBe('rgb(255, 255, 255)')

  // The newsletter is built the way newsletters are built, as a table with a fixed pixel width, and
  // it has to fit the paper INSIDE the frame. This is a WebKit assertion in practice: Chromium
  // clamps a table with `max-width`, WebKit does not apply max-width to a table box at all, so the
  // Mac app was the surface losing the last two columns behind an overlay scrollbar nobody sees.
  const inside = await bodyFrame(page).locator('body').evaluate((el) => {
    const doc = el.ownerDocument.documentElement
    return { scroll: doc.scrollWidth, client: doc.clientWidth }
  })
  expect(inside.scroll, 'a fixed-width newsletter table fits the paper').toBeLessThanOrEqual(inside.client + 1)

  // The inline image became a chip carrying the sender's own alt text, and there is no `cid:` image
  // left to paint a broken glyph.
  await expect(bodyFrame(page).locator('span.walnut-cid-image')).toContainText('Harbour Ferry masthead')
  const broken = await bodyFrame(page).locator('img').evaluateAll((nodes) => nodes
    .filter((node) => {
      const image = node as HTMLImageElement
      return image.naturalWidth === 0 && (image.getAttribute('src') ?? '').toLowerCase().startsWith('cid:')
    })
    .map((node) => node.getAttribute('src')))
  expect(broken, 'an attachment image is a chip, never a broken glyph').toEqual([])

  // The remote pixel is still blocked, and the notice is on the paper rather than across the pane.
  await expect(page.getByTestId('mail-blocked-images')).toContainText('1 remote image blocked')
  shots.push(await shoot(page.locator('.mail-reader-pane'), theme, 'reader-html'))

  // ── the details disclosure, on the message with fourteen recipients and nine attachments ──
  await rows.filter({ hasText: 'nine files' }).first().click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('nine files', { timeout: 30_000 })
  await expect(page.getByTestId('mail-attachments').locator('li')).toHaveCount(9)
  await page.getByTestId('mail-reader-details').click()
  await expect(page.getByTestId('mail-reader-detail-rows')).toContainText('kai.lindberg@example.com')

  // Fourteen recipients overflow the box, so it scrolls; where it CUTS is the detail. The strip the
  // reader can see is a whole number of line boxes, because a round height sliced the seventh
  // address through its x-height and a working scroll box then looks like a rendering bug (WebKit).
  // Padding-bottom is deliberately NOT subtracted: a scroll box clips at its padding box, so content
  // shows THROUGH the bottom padding, and only the top padding takes room away from the strip.
  const detailFit = await page.getByTestId('mail-reader-detail-rows').evaluate((el) => {
    const style = getComputedStyle(el)
    const line = Number.parseFloat(style.lineHeight)
    const visible = el.clientHeight - Number.parseFloat(style.paddingTop)
    return { scrolls: el.scrollHeight > el.clientHeight, remainder: visible % line }
  })
  expect(detailFit.scrolls, 'fourteen recipients are more than the box shows').toBe(true)
  expect(detailFit.remainder, 'the box cuts between lines, never through one').toBeLessThanOrEqual(0.5)
  await noSideScroll(page.locator('.mail-reader-pane'), 'the reader pane with 14 recipients')
  shots.push(await shoot(page.locator('.mail-reader-pane'), theme, 'reader-dense-header'))

  // ── (f) the 142-character subject wraps, and takes nothing with it ──
  await rows.filter({ hasText: 'Winter works on the Sandhill pontoon' }).first().click()
  const subject = page.getByTestId('mail-reader-subject')
  await expect(subject).toContainText('before the ninth', { timeout: 30_000 })
  const subjectBox = await subject.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: Number.parseFloat(getComputedStyle(el).lineHeight),
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(subjectBox.height, 'a long subject wraps').toBeGreaterThan(subjectBox.line + 2)
  expect(subjectBox.scroll, 'a long subject does not overflow').toBeLessThanOrEqual(subjectBox.client + 1)
  await noSideScroll(page.locator('.mail-reader-pane'), 'the reader pane with a 142-character subject')

  // ── the six-thousand-word plain-text mail: prose, not a printout ──
  await rows.filter({ hasText: 'long version' }).first().click()
  const bodyText = page.getByTestId('mail-body-text')
  await expect(bodyText).toBeVisible({ timeout: 30_000 })
  await expect(bodyText).toHaveAttribute('data-shape', 'prose')
  const font = await bodyText.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase())
  expect(font, 'prose is not set in monospace').not.toContain('mono')
  await noSideScroll(page.locator('.mail-reader-pane'), 'the reader pane with a 6,000 word mail')
  shots.push(await shoot(page.locator('.mail-reader-pane'), theme, 'reader-text'))

  // ── (e) the composer ──
  await page.getByTestId('mail-compose-new').click()
  const composer = page.getByTestId('mail-composer')
  await expect(composer).toBeVisible()
  await expect(composer).toContainText('New message')
  await expect(page.getByTestId('mail-compose-send')).toBeVisible()
  const clip = page.getByTestId('mail-compose-attachments')
  await expect(clip).toBeDisabled()
  await expect(clip).toHaveAttribute('title', 'Attachments are coming')
  const clipBox = await clip.boundingBox()
  expect(clipBox!.width, 'the attachments line became an icon').toBeLessThanOrEqual(40)
  // The grey sentence is gone from the pane: what is left is the icon's accessible name.
  await expect(page.locator('.mail-composer-pane p', { hasText: 'not supported' })).toHaveCount(0)
  await expect(page.locator('.mail-compose-hint')).toContainText('Markdown is rendered on send')
  await noSideScroll(page.locator('.mail-composer-pane'), 'the composer pane')
  shots.push(await shoot(page.locator('.mail-composer-pane'), theme, 'composer-new'))

  await page.getByTestId('mail-composer-close').click()
  await expect(composer).toHaveCount(0)

  // ── a reply, on the same card and the same measure as the message it answers ──
  await rows.filter({ hasText: 'Dock walkthrough' }).first().click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Dock walkthrough', { timeout: 30_000 })
  await page.getByTestId('mail-reply').click()
  await expect(composer).toBeVisible()
  await expect(composer).toContainText('Reply')
  await expect(page.getByTestId('mail-compose-subject')).toHaveValue('Re: Dock walkthrough on Thursday')
  await expect(page.getByTestId('mail-compose-quote')).toContainText('marta.silva@example.com> wrote:')
  const cardWidth = await page.locator('.mail-compose-card').evaluate((el) => el.getBoundingClientRect().width)
  expect(cardWidth, 'the composer keeps the reading measure').toBeLessThanOrEqual(COLUMN_MAX)
  await noSideScroll(page.locator('.mail-composer-pane'), 'the composer pane with a quote')
  shots.push(await shoot(page.locator('.mail-composer-pane'), theme, 'composer-reply'))

  // A reply nobody typed into is deleted on the way out, so the next pass starts clean.
  await page.getByTestId('mail-composer-close').click()
  await expect(composer).toHaveCount(0, { timeout: 30_000 })

  // ── the forward path, which is the one action the toolbar added ──
  // The composer took the reader's slot, so the message has to be reopened to reach its toolbar.
  await rows.filter({ hasText: 'Dock walkthrough' }).first().click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Dock walkthrough', { timeout: 30_000 })
  await page.getByTestId('mail-forward').click()
  await expect(composer).toContainText('Forward')
  // `Fwd:` is added ONCE, in front of whatever the original carried, and the original here is
  // itself a reply, so both prefixes are on the line.
  await expect(page.getByTestId('mail-compose-subject')).toHaveValue('Fwd: Re: Dock walkthrough on Thursday')
  await expect(page.getByTestId('mail-compose-chip-to')).toHaveCount(0)
  // Nothing was typed, so the trash asks nothing: a dialog about text nobody wrote is noise.
  await page.getByTestId('mail-compose-discard').click()
  await expect(composer).toHaveCount(0, { timeout: 30_000 })

  // ── (b) and again at 900, where the console drills to one pane ──
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(list).toBeVisible()
  await noPageSideScroll(page, 'the page at 900')
  await noSideScroll(list, 'the message list at 900')
  await noSideScroll(page.locator('.mail-rows'), 'the message rows at 900')
  shots.push(await shoot(consolePane, theme, 'narrow-900-list'))

  await rows.filter({ hasText: 'issue 42' }).first().click()
  const narrowReader = page.getByTestId('mail-reader')
  await expect(narrowReader).toBeVisible()
  await noPageSideScroll(page, 'the page at 900 with the newsletter open')
  await noSideScroll(narrowReader, 'the reader pane at 900')
  shots.push(await shoot(consolePane, theme, 'narrow-900-reader'))

  await page.getByTestId('mail-reader-back').click()
  await expect(list).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('.mail-accounts-pane')).toBeVisible()

  return shots
}
