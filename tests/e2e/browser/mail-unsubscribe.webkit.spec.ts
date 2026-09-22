/**
 * Leaving a mailing list in WEBKIT, which is the engine the Mac app is (S8 acceptance 6, 8, 10).
 *
 * Only what an engine can disagree about, which here is three things:
 *
 *   1. THE GESTURE. This engine selects the WORD under a right-press as the press's own default action,
 *      so by the time a handler runs there is a live selection nobody asked for. Before the shared rule
 *      learned to ignore a selection the press itself made (`selectionForGesture`), the row's menu could
 *      never open over a subject or a snippet in the Mac app — which is where a person right-clicks, and
 *      therefore where the `Unsubscribe` row was unreachable.
 *   2. THE ONE FLOW THAT PUTS MAIL ON THE WIRE. The mailto rung sends a real message under the user's
 *      own name, and the Mac app is the surface most of that will happen from. A mock-green Chromium run
 *      is not an answer about it, so the whole arc is driven here as well: the reader's button, the
 *      fixture provider recording exactly one mail, the ledger naming the click that authorised it, and
 *      the row settling to `Unsubscribed ✓`.
 *   3. THE STATUS LINE'S BOX. It is a new line inside the reader's header, and this engine is the one
 *      that floors fractional line heights — the ratchet for that (a row clipped by half a line in the
 *      Mac app and nowhere else) is the reason a wrapping sentence added to a header gets measured
 *      rather than eyeballed.
 *
 * NO SOCKET LEAVES THIS RUN: every list host is `.invalid` (RFC 2606), and the one mail that is sent
 * goes to the fixture provider, which writes it to a file inside a throwaway home.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file rather
 * than a project, and its helpers are inline: importing the Chromium spec would run all six of its cases
 * in this engine too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-unsubscribe/webkit'

const WRITER = 'fixture:ctx-writer@example.invalid'
const ONE_CLICK = 'INBOX:8:1'
const MAILTO = 'INBOX:8:2'
const SIBLING = 'INBOX:8:5'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0
let home = ''

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start({ PW_MAIL_UNSUB: '1', PW_MAIL_DENSE: '' })
  port = fixture.port
  home = fixture.home
})

test.afterAll(async () => { await server.stop() })

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => { console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

function menu(page: Page): Locator {
  return page.getByTestId('mail-row-ctx-menu')
}

/** The `Unsubscribe` row: the LAST item, because its words are the thing under test. */
function unsubItem(page: Page): Locator {
  return menu(page).locator('[role="menuitem"]').last()
}

function unsubButton(page: Page): Locator {
  return page.getByTestId('mail-unsubscribe')
}

function statusLine(page: Page): Locator {
  return page.getByTestId('mail-reader-unsub')
}

async function openWriterInbox(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, ONE_CLICK)).toBeVisible({ timeout: 90_000 })
}

async function openMessage(page: Page, messageId: string): Promise<void> {
  await row(page, messageId).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', messageId, {
    timeout: 60_000,
  })
}

interface RecordedSend {
  accountId: string
  to: Array<{ address: string }>
  subject: string
  bodyMarkdown: string
}

async function outbox(): Promise<RecordedSend[]> {
  try {
    return JSON.parse(await fs.readFile(`${home}/mail-fixture-sends.json`, 'utf8')) as RecordedSend[]
  } catch {
    return []
  }
}

test('the Unsubscribe row is reachable over the row\'s own words in this engine', async ({ page }) => {
  await openWriterInbox(page)
  // ON THE SNIPPET, which is where a person right-clicks a newsletter. This engine pre-selects the word
  // under the press, and the shared rule asks whether the selection was there BEFORE it: one the press
  // made counts as none, one the human made is still theirs.
  await row(page, ONE_CLICK).locator('.mail-row-snippet').click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  const selected = await page.evaluate(() => {
    const selection = window.getSelection()
    return selection && !selection.isCollapsed ? selection.toString() : ''
  })
  expect(selected.trim(), 'the word the press selected is dropped with it').toBe('')

  // And the row itself is the one this slice adds, in its ready state: the last item, enabled, with the
  // ✦ mark drawn inside its label rather than in an icon column this menu does not have.
  await expect(unsubItem(page).locator('.wn-context-menu-label')).toHaveText('Unsubscribe')
  await expect(unsubItem(page)).toBeEnabled()
  await expect(unsubItem(page)).toHaveAttribute('data-ai', 'true')
  await expect(menu(page).locator('.wn-context-menu-icon')).toHaveCount(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'row-menu-unsub')}`)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
})

test('the mailto rung sends exactly one mail here too, filed as the click that asked for it', async ({ page }) => {
  await openWriterInbox(page)
  expect(await outbox(), 'nothing has been sent yet').toEqual([])

  // From the READER's button, which is the only way into the ladder from an open message: the reader has
  // no context menu at all, because its body is a sandboxed iframe.
  await openMessage(page, MAILTO)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'ready')
  await unsubButton(page).click()

  // The optimistic mark is `Unsubscribing…` and never a tick. It may already have settled by the time
  // this reads, which is why the assertion is "one of the two honest states" rather than a sleep.
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', /pending|done/, { timeout: 60_000 })

  // The mail itself, as the provider was handed it: one recipient and the subject the sender's own
  // header asked for.
  await expect.poll(async () => (await outbox()).length, { timeout: 90_000 }).toBe(1)
  const sent = (await outbox())[0]!
  expect(sent.to.map((one) => one.address)).toEqual(['leave@lists.example.invalid'])
  expect(sent.subject).toBe('unsubscribe k9')

  // Who authorised it: a click at this device, named by the message it was made on.
  const answer = await page.request.get(`http://127.0.0.1:${port}/api/plugins/mail/sends?limit=50`)
  expect(answer.ok()).toBe(true)
  const ledger = ((await answer.json()) as { sends: Array<{ approvalKind: string, approvalRef: string }> }).sends
  expect(ledger.length, 'exactly one send').toBe(1)
  expect(ledger[0]!.approvalKind).toBe('console')
  expect(ledger[0]!.approvalRef).toBe(`unsubscribe:${MAILTO}`)

  // And it settles to `done`, on both surfaces, with the wording each one owns.
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'done', { timeout: 90_000 })
  await expect(statusLine(page)).toHaveAttribute('data-state', 'done')
  await expect(statusLine(page)).toContainText('Unsubscribed via a mail to the list')
  await row(page, MAILTO).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await expect(unsubItem(page).locator('.wn-context-menu-label')).toHaveText('Unsubscribed ✓')
  // Still clickable: the ledger refuses to re-claim a `done` row, so asking again is safe.
  await expect(unsubItem(page)).toBeEnabled()
  await page.keyboard.press('Escape')

  // The other issue of the same list, which nobody clicked, says so in the list's own words.
  await openMessage(page, SIBLING)
  await expect(statusLine(page)).toContainText('You unsubscribed from this list on', { timeout: 90_000 })
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), SHOT_DIR, 'reader-done-list')}`)
})

test('the status line sits inside the header and is not clipped by half a line', async ({ page }) => {
  await openWriterInbox(page)
  // The longest of the lines, and the one somebody has to read to act: the failure wording. Produced for
  // real — `lists.example.invalid` does not resolve, so the guard's own lookup is what fails.
  await openMessage(page, ONE_CLICK)
  await unsubButton(page).click()
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'failed', { timeout: 90_000 })
  await expect(statusLine(page)).toHaveText('Unsubscribe did not work')

  const box = await statusLine(page).evaluate((line) => {
    const head = line.closest('.mail-reader-head') ?? line.parentElement!
    const mine = line.getBoundingClientRect()
    const around = head.getBoundingClientRect()
    return {
      // A wrapping sentence is fine; a sentence taller than the box drawing it is not. This engine
      // floors a fractional line height, which is exactly how a line ends up half-cut here and nowhere
      // else, so the comparison is made in pixels rather than by eye.
      clippedBy: Math.round(line.scrollHeight - line.clientHeight),
      // Inside the header it belongs to, on both edges.
      overflowsBelow: Math.round(mine.bottom - around.bottom),
      overflowsRight: Math.round(mine.right - around.right),
      height: Math.round(mine.height),
      text: (line.textContent ?? '').trim(),
    }
  })
  expect(box.text).toBe('Unsubscribe did not work')
  expect(box.clippedBy, 'the sentence fits the box drawing it').toBeLessThanOrEqual(0)
  expect(box.overflowsBelow, 'and the box fits the header').toBeLessThanOrEqual(0)
  expect(box.overflowsRight).toBeLessThanOrEqual(0)
  expect(box.height, 'one line of 12px text, not a collapsed box').toBeGreaterThan(10)
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), SHOT_DIR, 'reader-failed-line')}`)
})
