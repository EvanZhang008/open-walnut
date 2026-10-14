/**
 * Reply and Reply all on mail whose listing names people without their addresses.
 *
 * 2026-10-14: on an Outlook mailbox, Reply and Reply all opened the composer with an EMPTY `To`
 * ("where is the receiver"). The listing names everyone by display name only; the addresses arrive
 * with the body read, which the base now uses to fill them in. Engine-neutral, so the same file runs
 * in Chromium and (with `PW_WEBKIT=1 --project=webkit`) in WebKit, the engine the Mac app is.
 * The fixture (`PW_MAIL_NAMES_ONLY=1`, names-only-set.mjs) records every send, so the assertions are
 * what went out, not only the words on screen:
 *
 *   1. FROM THE READER: Reply puts the sender in To; Reply all adds everyone else in Cc, never the
 *      account itself; the send goes out to exactly those people as a reply in the thread.
 *   2. BEFORE THE BODY LANDED: Reply clicked while the reader is still reading opens at once, says who
 *      it is finding, keeps what the human types meanwhile, and fills the sender when the read lands.
 *   3. FROM THE ROW MENU, on a message never opened: the sender is filled the same way.
 *   4. A SENDER WITH NO ADDRESS AT ALL (a directory path): `To` names them as addressed by the
 *      provider instead of standing blank, and Send works, with an empty To the provider answers.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const WRITER = 'fixture:ctx-writer@example.invalid'
/** In Archive, which the Inbox body prefetch never visits, so its body is unread until a click. */
const FILLED = 'Archive:11:1'
const PATH_ONLY = 'INBOX:11:2'
const WITH_CC = 'INBOX:11:3'
const MENU_ONLY = 'Archive:11:4'

test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0
let home = ''
let shotDir = ''

test.beforeAll(async ({ browserName }) => {
  test.setTimeout(300_000)
  shotDir = `/tmp/outlook-reply-to/shots/${browserName}`
  await fs.mkdir(shotDir, { recursive: true })
  const fixture = await server.start({ PW_MAIL_NAMES_ONLY: '1', PW_MAIL_DENSE: '', PW_MAIL_NAMES_SLOW_MS: '3000' })
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

interface RecordedSend {
  to: Array<{ name?: string; address: string }>
  cc: Array<{ name?: string; address: string }>
  subject: string
  inReplyTo: string | null
  bodyMarkdown: string
}

async function sends(): Promise<RecordedSend[]> {
  try { return JSON.parse(await fs.readFile(`${home}/mail-fixture-sends.json`, 'utf8')) as RecordedSend[] }
  catch { return [] }
}

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

const toChips = (page: Page) => page.getByTestId('mail-compose-chip-to')
const ccChips = (page: Page) => page.getByTestId('mail-compose-chip-cc')
const implied = (page: Page) => page.getByTestId('mail-compose-reply-sender')

async function addresses(chips: Locator): Promise<string[]> {
  return chips.evaluateAll((all) => all.map((one) => one.getAttribute('data-address') ?? ''))
}

async function openInbox(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  // The Inbox opens Grouped, which lists unread mail only, and these rows were read on arrival:
  // switch to All mail the way a person does, through the list's own view menu.
  const view = page.getByTestId('mail-view-menu').first()
  await expect(view).toBeVisible({ timeout: 90_000 })
  if ((await view.getAttribute('data-grouped')) === 'true') {
    await view.click()
    const menu = page.getByTestId('mail-view-menu-list')
    await expect(menu).toBeVisible()
    await menu.locator('[role^="menuitem"]').filter({ hasText: 'All mail' }).first().click()
  }
  await expect(row(page, WITH_CC)).toBeVisible({ timeout: 90_000 })
}

async function openArchive(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'Archive')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'Archive').click()
  await expect(row(page, FILLED)).toBeVisible({ timeout: 90_000 })
}

async function openMessage(page: Page, messageId: string): Promise<void> {
  await row(page, messageId).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', messageId, { timeout: 60_000 })
}

/** Back from the status card (or the form) to the list, so the next case starts from the reader. */
async function closeComposer(page: Page): Promise<void> {
  const back = page.getByTestId('mail-send-back')
  if (await back.count()) await back.click()
  else await page.getByTestId('mail-composer-close').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)
}

test('from the reader: Reply has the sender in To, Reply all the others in Cc, and the send goes to them', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, WITH_CC)
  await expect(page.locator('.mail-reader-body')).toContainText('approval notice', { timeout: 60_000 })

  await page.getByTestId('mail-reply').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  await expect(toChips(page)).toHaveCount(1)
  await expect(toChips(page)).toHaveAttribute('data-address', 'cedar@office.example.invalid')
  await expect(implied(page)).toHaveCount(0)
  await expect(ccChips(page)).toHaveCount(0)
  console.log(`shot: ${await shoot(page.getByTestId('mail-composer'), shotDir, 'reply-from-reader')}`)
  await page.getByTestId('mail-composer-close').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)

  await openMessage(page, WITH_CC)
  await page.getByTestId('mail-reply-all').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  await expect.poll(() => addresses(toChips(page))).toEqual(['cedar@office.example.invalid'])
  // Everyone else, and never the account's own address, though the message was addressed to it.
  await expect.poll(() => addresses(ccChips(page))).toEqual([
    'casework@office.example.invalid',
    'dogwood@office.example.invalid',
  ])
  console.log(`shot: ${await shoot(page.getByTestId('mail-composer'), shotDir, 'reply-all-from-reader')}`)

  await page.getByTestId('mail-compose-body').fill('Confirmed, thank you.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('mail-compose-send').click()
  await expect(page.getByTestId('mail-send-headline')).toContainText('Sent', { timeout: 60_000 })
  await expect.poll(async () => (await sends()).length, { timeout: 30_000 }).toBe(1)
  const sent = (await sends())[0]!
  expect(sent.to.map((one) => one.address)).toEqual(['cedar@office.example.invalid'])
  expect(sent.cc.map((one) => one.address)).toEqual(['casework@office.example.invalid', 'dogwood@office.example.invalid'])
  expect(sent.inReplyTo).toBe('conv-INBOX-11-3')
  expect(sent.subject).toBe('Re: Approval notice received')
  await closeComposer(page)
})

test('before the body landed: Reply opens at once, keeps what was typed, and fills the sender when the read lands', async ({ page }) => {
  await openArchive(page)
  await row(page, FILLED).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', FILLED, { timeout: 60_000 })
  // The body read takes 3s here. The click answers now, and the composer says who it is finding.
  const started = Date.now()
  await page.getByTestId('mail-reply').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  expect(Date.now() - started, 'the composer opened without waiting for the body').toBeLessThan(2500)
  await expect(implied(page)).toHaveAttribute('data-state', 'finding')
  await expect(implied(page)).toContainText('Alder Desk')
  console.log(`shot: ${await shoot(page.getByTestId('mail-composer'), shotDir, 'reply-finding')}`)

  // The human adds somebody while the read is out. That chip must survive the fill.
  await page.getByTestId('mail-compose-to').fill('fir@example.invalid')
  await page.getByTestId('mail-compose-to').press('Enter')

  await expect.poll(() => addresses(toChips(page)), { timeout: 30_000 })
    .toEqual(['alder@desk.example.invalid', 'fir@example.invalid'])
  await expect(implied(page)).toHaveCount(0)
  // The quote was the attribution line alone while the body was out; it is completed with the text.
  await expect(page.getByTestId('mail-compose-quote')).toContainText('shipment details by Friday')
  await expect(page.getByTestId('mail-compose-quote')).toContainText('alder@desk.example.invalid')
  console.log(`shot: ${await shoot(page.getByTestId('mail-composer'), shotDir, 'reply-filled')}`)
  await page.getByTestId('mail-compose-body').fill('On it.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  // What the server holds is what is on screen.
  await closeComposer(page)
})

test('from the row menu, on a message never opened: the sender is filled', async ({ page }) => {
  await openArchive(page)
  // A row no other case opens: its listing still names the sender only, so the menu's reply has to
  // learn the address from the read it makes for the quote.
  await row(page, MENU_ONLY).click({ button: 'right' })
  const menu = page.getByTestId('mail-row-ctx-menu')
  await expect(menu).toHaveCount(1)
  await menu.locator('[role="menuitem"]', { hasText: 'Reply all' }).first().click()
  await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => addresses(toChips(page)), { timeout: 30_000 }).toEqual(['ledger@elm.example.invalid'])
  // The account's own address is the only other person, so Cc stays empty.
  await expect(ccChips(page)).toHaveCount(0)
  await expect(implied(page)).toHaveCount(0)
  await closeComposer(page)
})

test('a sender with no address anywhere: To names who it goes to, and Send works', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, PATH_ONLY)
  await expect(page.locator('.mail-reader-body')).toContainText('rota', { timeout: 60_000 })
  await page.getByTestId('mail-reply').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  await expect(implied(page)).toHaveAttribute('data-state', 'provider', { timeout: 30_000 })
  await expect(implied(page)).toContainText('Grove Team')
  await expect(implied(page)).toContainText('addressed by Fixture Mail')
  await expect(toChips(page)).toHaveCount(0)
  // A directory path is no address, so nothing red sits in To either.
  await expect(page.locator('.mail-chip.invalid')).toHaveCount(0)
  console.log(`shot: ${await shoot(page.getByTestId('mail-composer'), shotDir, 'reply-addressed-by-provider')}`)

  const before = (await sends()).length
  await page.getByTestId('mail-compose-body').fill('Thanks, noted.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await expect(page.getByTestId('mail-compose-send')).toBeEnabled()
  await page.getByTestId('mail-compose-send').click()
  await expect(page.getByTestId('mail-send-headline')).toContainText('Sent', { timeout: 60_000 })
  await expect.poll(async () => (await sends()).length, { timeout: 30_000 }).toBe(before + 1)
  const sent = (await sends()).at(-1)!
  expect(sent.to).toEqual([])
  expect(sent.inReplyTo).toBe('conv-INBOX-11-2')
  expect(sent.subject).toBe('Re: Grove rota for next week')
  await closeComposer(page)
})
