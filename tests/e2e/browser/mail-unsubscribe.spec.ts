/**
 * Leaving a mailing list, driven as a person drives it (S8 acceptance 1, 5, 6, 7, 8, 9).
 *
 * The console's promise here is that ONE right-click gets somebody off a list, and that it never says
 * so unless it happened. Almost everything graded below is therefore a SENTENCE: which words the row
 * offers, which words the reader shows, and which words come back when the sender's endpoint cannot be
 * reached. A row reading `Unsubscribed ✓` about a list still sending is the one outcome worse than a
 * row that did nothing.
 *
 *   1. THE FOUR STATES, on one screen, from four real messages (`PW_MAIL_UNSUB=1`): a mail with no way
 *      out at all (present, disabled, and it says what can try instead), a one-click newsletter, a
 *      list that only takes a mail, and the same mailto-only shape on an account with NO outgoing mail
 *      (disabled with the SMTP reason, rather than a click that could only fail at the transport).
 *   2. THE MAILTO RUNG REALLY SENDS, and the ledger says who asked. The fixture provider records the
 *      message it was handed, so the assertion is the mail itself: one recipient, the subject the
 *      header asked for, `approval_kind: 'console'`, `approval_ref: 'unsubscribe:<messageId>'`, and NO
 *      letter in the human inbox — a click already is the authorisation, and asking again for it is how
 *      a console teaches people to stop reading letters.
 *   3. LEAVING A LIST IS REMEMBERED PER LIST, not per mail. Two issues of one newsletter are on screen;
 *      unsubscribing from the second makes the FIRST say `You unsubscribed from this list on …` without
 *      anybody clicking it. That wording is also why the fixture gives it a `List-Id`: a ledger keyed on
 *      a sender's address is coarser, and it has to say "this sender" instead.
 *   4. THE OPTIMISTIC MARK IS `Unsubscribing…`, NEVER A TICK, and a failure comes back in the sender's
 *      own terms with a click that is a retry.
 *   5. THE READER IS THE SECOND SURFACE and it must never disagree with the first: a status line under
 *      the sender and one round button in the toolbar, both read off the same pure state. The reader has
 *      no context menu at all (its body is a sandboxed iframe), so that button is the only way in.
 *
 * NO SOCKET LEAVES THIS RUN. Every list host is `.invalid` (RFC 2606), so the https rungs fail in the
 * server's own DNS lookup, which is what makes the `failed` case real here rather than mocked. The two
 * verdicts a stranger's page would have to produce (`needs-human`, and the agent's `asked`) are canned
 * at the ROUTE with `page.route`, deliberately: they are answers about somebody else's web page, the
 * server half is graded in `tests/integrations/mail-unsubscribe-*.test.ts`, and what is being graded
 * here is what the console does with them.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-unsubscribe/chromium'

/** The two accounts the fixture adopts: the second one has no SMTP. */
const WRITER = 'fixture:ctx-writer@example.invalid'
const READER = 'inbound:ctx-reader@example.invalid'

/** The writer's newsletters, one per rung, plus a mail from a person with nothing to unsubscribe from. */
const ONE_CLICK = 'INBOX:8:1'
const MAILTO = 'INBOX:8:2'
const FOOTER = 'INBOX:8:3'
const NOTHING = 'INBOX:8:4'
/** The other issue of `MAILTO`'s list. Never clicked: it is what list-wide memory is proved on. */
const SIBLING = 'INBOX:8:5'
/** Mailto-only, on the account that cannot send. The other half of the SMTP gate. */
const NO_SMTP = 'INBOX:2:13'

const MENU = 'mail-row-ctx-menu'
const DRAWER = 'ask-object-drawer'
const UNSUB_URL = '**/api/plugins/mail/messages/*/*/unsubscribe'

/** Quoted from `mail-unsubscribe-state.ts`, so a reword there fails here rather than drifting. */
const NONE_TITLE = 'No unsubscribe link found. Ask Walnut can try.'
const RETRY_TITLE = 'Walnut\'s last attempt did not work. Clicking tries again.'
const ASK_TITLE = 'Walnut got part of the way and the rest needs a person. This opens Ask Walnut about it.'
const ASKED_TITLE = 'Walnut asked you about this in your inbox. Answer there and it will finish the job.'
/** `CANNOT_SEND_TITLE` (web/src/apps/mail/compose/send-status.ts). */
const CANNOT_SEND = 'This account cannot send; add SMTP settings'

// One worker, in declaration order, and NOT `serial`. These cases share one install and the ledger is
// server state, so each one acts on a DIFFERENT message (that is what the five fixture rows are for);
// a failure in one is not a reason to stop grading the others.
test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0
let home = ''

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  // `PW_MAIL_DENSE` is emptied rather than omitted: the helper defaults it on, and a second linked
  // provider would double every count and put two options in the add-an-account dialog.
  const fixture = await server.start({ PW_MAIL_UNSUB: '1', PW_MAIL_DENSE: '' })
  port = fixture.port
  home = fixture.home
})

test.afterAll(async () => { await server.stop() })

/** Anything the page threw, in this run's own output: a render crash otherwise reads as a timeout. */
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => { console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

function menu(page: Page): Locator {
  return page.getByTestId(MENU)
}

function row(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)
}

/**
 * The `Unsubscribe` row of the open menu.
 *
 * Located as the LAST item rather than by its words, because its words are the thing under test: it
 * reads `Unsubscribe`, `Unsubscribing…`, `Unsubscribed ✓`, `Finish unsubscribing…` or `Waiting on your
 * answer` depending on the state, and a `hasText` locator would match three of those at once.
 */
function unsubItem(page: Page): Locator {
  return menu(page).locator('[role="menuitem"]').last()
}

async function unsubLabel(page: Page): Promise<string> {
  return unsubItem(page).locator('.wn-context-menu-label').innerText()
}

async function openRowMenu(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

/** Open the menu, read the unsubscribe row's three facts, close it again. */
async function unsubState(page: Page, accountId: string, messageId: string): Promise<{
  label: string
  title: string
  disabled: boolean
}> {
  await openRowMenu(page, accountId, messageId)
  const item = unsubItem(page)
  const state = {
    label: (await item.locator('.wn-context-menu-label').innerText()).trim(),
    title: (await item.getAttribute('title')) ?? '',
    disabled: await item.isDisabled(),
  }
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  return state
}

/** Into the writer's inbox, with the newsletters on screen. Most cases start here. */
async function openWriterInbox(page: Page): Promise<void> {
  // The screenshot is taken HERE rather than left to the reporter: `test-results/` is shared by every
  // Playwright run on this machine and is emptied at the start of the next one, so a failure's own
  // evidence is routinely gone before it can be read.
  await openMail(page, port).catch(async (error: unknown) => {
    console.log(`shot: ${await shoot(page, SHOT_DIR, 'no-pane')}`)
    console.log(`body: ${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`)
    throw error
  })
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, WRITER, ONE_CLICK)).toBeVisible({ timeout: 90_000 })
  await expect(row(page, WRITER, SIBLING)).toBeVisible()
}

/** Open a message the way a person does, and wait for the reader to be showing that one. */
async function openMessage(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', messageId, {
    timeout: 60_000,
  })
}

function unsubButton(page: Page): Locator {
  return page.getByTestId('mail-unsubscribe')
}

function statusLine(page: Page): Locator {
  return page.getByTestId('mail-reader-unsub')
}

interface RecordedSend {
  accountId: string
  to: Array<{ address: string }>
  subject: string
  bodyMarkdown: string
  idempotencyKey: string
}

/** Every message the fixture provider was handed. Empty (rather than an error) before the first one. */
async function outbox(): Promise<RecordedSend[]> {
  try {
    return JSON.parse(await fs.readFile(`${home}/mail-fixture-sends.json`, 'utf8')) as RecordedSend[]
  } catch {
    return []
  }
}

interface SendRow {
  sendId: string
  draftId: string
  state: string
  approvalKind: string
  approvalRef: string
}

async function sends(page: Page): Promise<SendRow[]> {
  const answer = await page.request.get(`http://127.0.0.1:${port}/api/plugins/mail/sends?limit=50`)
  expect(answer.ok(), 'the sends ledger answered').toBe(true)
  return ((await answer.json()) as { sends: SendRow[] }).sends
}

/** How many letters are in the human inbox. The digest is parked (`PW_MAIL_DIGEST_OFF`), so it is stable. */
async function letterCount(page: Page): Promise<number> {
  const answer = await page.request.get(`http://127.0.0.1:${port}/api/v1/human-inbox`)
  expect(answer.ok(), 'the human inbox answered').toBe(true)
  const held = await answer.json() as unknown
  return Array.isArray(held) ? held.length : (held as { letters?: unknown[] }).letters?.length ?? 0
}

test('acceptance 6, 5: four messages, four different answers, and every disabled one says why', async ({ page }) => {
  await openWriterInbox(page)

  // A mail from a person. The row is PRESENT and disabled, which is this menu's one deliberate
  // exception to its own no-dead-controls rule: the Ask rows above it can look at a message with no
  // link at all, so dropping this one would answer "why is there no Unsubscribe?" with silence.
  const nothing = await unsubState(page, WRITER, NOTHING)
  expect(nothing.label).toBe('Unsubscribe')
  expect(nothing.disabled).toBe(true)
  expect(nothing.title).toBe(NONE_TITLE)

  // A one-click newsletter: the plain row, enabled, with nothing extra to say.
  const oneClick = await unsubState(page, WRITER, ONE_CLICK)
  expect(oneClick).toEqual({ label: 'Unsubscribe', title: '', disabled: false })

  // A list that only takes a mail, on the account that CAN send: also enabled, because the click is
  // the authorisation for the one mail that goes out.
  const mailto = await unsubState(page, WRITER, MAILTO)
  expect(mailto).toEqual({ label: 'Unsubscribe', title: '', disabled: false })

  // The row carries the ✦ mark and draws it INSIDE its label: this menu has no icon column, so an
  // icon here would indent the Walnut group's words and leave the ten rows above them flush left.
  await openRowMenu(page, WRITER, ONE_CLICK)
  await expect(unsubItem(page)).toHaveAttribute('data-ai', 'true')
  await expect(unsubItem(page).locator('.wn-context-menu-label .wn-context-ai-mark svg')).toHaveCount(1)
  await expect(menu(page).locator('.wn-context-menu-icon')).toHaveCount(0)
  // A disabled row's reason is also readable without a mouse, which is what the reason line is for.
  await page.keyboard.press('Escape')
  await openRowMenu(page, WRITER, NOTHING)
  await expect(menu(page).getByTestId('wn-context-menu-reason').last()).toHaveText(NONE_TITLE)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'menu-no-link')}`)
  await page.keyboard.press('Escape')

  // And the SMTP gate, which is the same shape of message on an account with no outgoing mail. Not a
  // hidden row and not a click that 409s at the transport: disabled, with the fix named.
  await expect(folderRow(page, READER, 'INBOX')).toHaveCount(1)
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, NO_SMTP)).toBeVisible({ timeout: 90_000 })
  const blocked = await unsubState(page, READER, NO_SMTP)
  expect(blocked.label).toBe('Unsubscribe')
  expect(blocked.disabled).toBe(true)
  expect(blocked.title).toBe(CANNOT_SEND)
})

test('acceptance 8: the reader carries the button, and learns the link off the body it just read', async ({ page }) => {
  await openWriterInbox(page)

  // Nothing to unsubscribe from: the button is there and disabled with the same sentence the menu
  // gives, and there is NO status line — the reader already has a control saying it, and a header row
  // repeating "this message cannot be unsubscribed from" is noise on top of it.
  await openMessage(page, WRITER, NOTHING)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'none')
  await expect(unsubButton(page)).toBeDisabled()
  await expect(unsubButton(page)).toHaveAttribute('title', NONE_TITLE)
  await expect(statusLine(page)).toHaveCount(0)

  // A one-click newsletter: enabled, and still no line, because nothing has happened yet.
  await openMessage(page, WRITER, ONE_CLICK)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'ready')
  await expect(unsubButton(page)).toBeEnabled()
  await expect(statusLine(page)).toHaveCount(0)

  // The footer message carries NO headers at all: its only way out is the https anchor in its own
  // markup, and this very read is what finds it (`readMessage` restates `available` off the body it
  // just stored). Before this open the row said `none`; the button must not.
  await openMessage(page, WRITER, FOOTER)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'ready', { timeout: 30_000 })
  await expect(unsubButton(page)).toBeEnabled()
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), SHOT_DIR, 'reader-footer-link')}`)
})

test('acceptance 6, 4: the optimistic mark is `Unsubscribing…`, and a refusal is the sender\'s own words', async ({ page }) => {
  await openWriterInbox(page)
  await openMessage(page, WRITER, ONE_CLICK)

  // HELD, so the frame a person actually sees is gradable. Only this message's request: the response
  // is then let through to the REAL server, whose lookup of a `.invalid` host is what fails.
  let release: (() => void) | null = null
  await page.route(UNSUB_URL, async (route) => {
    if (!route.request().url().includes(encodeURIComponent(ONE_CLICK))) { await route.continue(); return }
    await new Promise<void>((wake) => { release = wake })
    await route.continue()
  })

  await unsubButton(page).click()
  // Both surfaces, on the first frame and before any server answered. `Unsubscribing…` and never a
  // tick: the whole point of the ladder is that leaving a list can fail quietly.
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'pending')
  await expect(unsubButton(page)).toBeDisabled()
  await expect(statusLine(page)).toHaveAttribute('data-state', 'pending')
  await expect(statusLine(page)).toHaveText('Unsubscribing…')
  expect(await unsubState(page, WRITER, ONE_CLICK)).toMatchObject({
    label: 'Unsubscribing…',
    disabled: true,
  })
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), SHOT_DIR, 'reader-pending')}`)

  await expect.poll(() => (release ? 'ready' : 'waiting')).toBe('ready')
  release!()

  // The verdict, in the SERVER's words. `lists.example.invalid` does not resolve, so the guard's own
  // lookup fails and the sentence is about a page, not about Walnut.
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('could not be reached', { timeout: 60_000 })
  await expect(note).toContainText('Nothing was changed')
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'failed')
  await expect(statusLine(page)).toHaveText('Unsubscribe did not work')
  // Enabled again, and the title says what the click now means. A retry is a first-class answer here:
  // nothing left the machine, so there is nothing to be careful about.
  await expect(unsubButton(page)).toBeEnabled()
  expect(await unsubState(page, WRITER, ONE_CLICK)).toEqual({
    label: 'Unsubscribe',
    title: RETRY_TITLE,
    disabled: false,
  })
  await page.unroute(UNSUB_URL)
})

test('acceptance 1, 6, 7: the mailto rung sends one mail as a console click, and the list remembers', async ({ page }) => {
  await openWriterInbox(page)
  expect(await outbox(), 'nothing has been sent yet').toEqual([])
  const lettersBefore = await letterCount(page)

  // The sibling issue of the same list, before: it has never been touched, so it offers a plain click.
  expect(await unsubState(page, WRITER, SIBLING)).toEqual({
    label: 'Unsubscribe', title: '', disabled: false,
  })

  await openRowMenu(page, WRITER, MAILTO)
  expect((await unsubLabel(page)).trim()).toBe('Unsubscribe')
  await unsubItem(page).click()
  await expect(menu(page)).toHaveCount(0)

  // THE MAIL ITSELF, as the provider was handed it. One recipient, the subject the sender's own header
  // asked for, and the body the parser fell back to.
  await expect.poll(async () => (await outbox()).length, { timeout: 60_000 }).toBe(1)
  const sent = (await outbox())[0]!
  expect(sent.accountId).toBe(WRITER)
  expect(sent.to.map((one) => one.address)).toEqual(['leave@lists.example.invalid'])
  expect(sent.subject).toBe('unsubscribe k9')
  expect(sent.bodyMarkdown).toBe('unsubscribe')
  // `<draftId>:<revision>`: a second send of one approved revision would show up as two rows sharing
  // this key, which is the failure the whole approval ledger exists to prevent.
  expect(sent.idempotencyKey).toMatch(/^.+:\d+$/)

  // WHO ASKED, on the ledger row. `console` because a right-click at the device IS the approval, and a
  // ref naming the message rather than the bare word `console`, because "who authorised this" is the
  // first question anybody asks about a mail they did not expect.
  const ledger = await sends(page)
  expect(ledger.length, 'exactly one send').toBe(1)
  expect(ledger[0]!.approvalKind).toBe('console')
  expect(ledger[0]!.approvalRef).toBe(`unsubscribe:${MAILTO}`)
  expect(['sent', 'unknown']).toContain(ledger[0]!.state)
  // And NO letter: the click already happened, so asking about it would be asking twice.
  expect(await letterCount(page), 'the human inbox was not written to').toBe(lettersBefore)

  // The rung answered `in-flight` and the send settles behind it (an SMTP handshake is allowed to take
  // tens of seconds, so the response does not hold one of the browser's six connections open for it).
  // The console learns the verdict from the bus event, so the wait is on the STATE and not on a clock.
  await openMessage(page, WRITER, MAILTO)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'done', { timeout: 60_000 })

  // The row that was clicked names the RUNG and the day, because that is the fact about this mail.
  const done = await unsubState(page, WRITER, MAILTO)
  expect(done.label).toBe('Unsubscribed ✓')
  expect(done.title).toMatch(/^Unsubscribed via a mail to the list · .+/)
  // STILL CLICKABLE. Asking again is legitimate (a list that kept sending) and it is also safe: the
  // ledger refuses to re-claim a `done` row, so the request answers `409 already` and sends nothing.
  expect(done.disabled).toBe(false)

  // ACCEPTANCE 7, and the point of the whole ledger: the OTHER issue of the same list, which nobody
  // clicked, now says so too — and says "this list" rather than "this sender", because the key came
  // from a `List-Id` and not from the address.
  await openMessage(page, WRITER, SIBLING)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'done', { timeout: 60_000 })
  const sibling = await unsubState(page, WRITER, SIBLING)
  expect(sibling.label).toBe('Unsubscribed ✓')
  expect(sibling.title).toMatch(/^You unsubscribed from this list on .+/)
  expect(sibling.title, 'the coarser noun would overstate what was left').not.toContain('sender')
  expect(sibling.disabled).toBe(false)

  // The reader agrees with the menu, which is the one thing these two surfaces must never do
  // differently: it repeats the menu's own sentence rather than composing a second one.
  await expect(statusLine(page)).toHaveAttribute('data-state', 'done')
  expect((await statusLine(page).innerText()).trim()).toBe(sibling.title)
  await expect(unsubButton(page)).toBeEnabled()
  console.log(`shot: ${await shoot(page.getByTestId('mail-reader'), SHOT_DIR, 'reader-done-list')}`)

  // A message of a DIFFERENT list is untouched by any of it: the ledger is keyed, not global.
  expect(await unsubState(page, WRITER, NOTHING)).toMatchObject({ disabled: true, title: NONE_TITLE })
})

test('acceptance 9: a page that wants a confirmation hands the rest to Ask Walnut', async ({ page }) => {
  await openWriterInbox(page)

  // CANNED AT THE ROUTE. `needs-human` is an answer about a stranger's web page: producing one for real
  // would need a public https endpoint serving a confirmation form, which is exactly what this run
  // refuses to reach. The server half is graded in tests/integrations/mail-unsubscribe-route.test.ts;
  // what is graded here is that the console prints the server's sentence, keeps the row actionable,
  // and hands the page to the model with the REASON attached.
  await page.route(UNSUB_URL, async (route) => {
    if (!route.request().url().includes(encodeURIComponent(FOOTER))) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'needs-human',
        method: 'link',
        reason: 'confirm-form',
        url: 'https://lists.example.invalid/u/footer?confirm=1',
        at: Date.now(),
        message: 'The unsubscribe page opened but it wants a confirmation, so nothing is final yet.'
          + ' Ask Walnut to finish it, or open the page yourself.',
      }),
    })
  })

  // Driven from the READER rather than the row menu, and for a reason worth writing down: this message
  // carries no `List-Unsubscribe` header at all, so its LIST ROW says `none` until something reads the
  // body. Opening it is what finds the footer link, and the reader's own button is the control that then
  // has somewhere to go. The row menu's half of the same verdict is graded further down.
  await openMessage(page, WRITER, FOOTER)
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'ready', { timeout: 30_000 })
  await unsubButton(page).click()

  // The server's own sentence, and it STAYS: a verdict somebody has to act on does not retire itself
  // after twelve seconds the way a plain success does.
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('wants a confirmation', { timeout: 60_000 })

  // The click carries straight on into the drawer, with the page and the reason in the first turn:
  // "finish this" is useless to a model that is not told what stopped or where.
  await expect(page.getByTestId(DRAWER)).toBeVisible({ timeout: 60_000 })
  const turn = page.getByTestId(DRAWER).locator('.chat-message-user').first()
  await expect(turn).toContainText('I want off this list')
  await expect(turn).toContainText('lists.example.invalid/u/footer')
  await expect(turn).toContainText('wants a confirmation pressed')
  await expect(turn).toContainText('Do not tell me I am unsubscribed unless the page said so')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'needs-human-drawer')}`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(DRAWER)).toHaveCount(0)

  // The state is on the LIST ROW too, not only in the reader: every copy of one message draws this, and
  // a row still offering a plain `Unsubscribe` would send somebody round the same dead end. `Finish
  // unsubscribing…` outranks the row's own `available: 'none'`, which is what makes this row possible at
  // all — the header said nothing, and the attempt is what there is to say.
  const held = await unsubState(page, WRITER, FOOTER)
  expect(held.label).toBe('Finish unsubscribing…')
  expect(held.title).toBe(ASK_TITLE)
  expect(held.disabled).toBe(false)

  // And the reader's line, which is the second surface saying the same thing in fewer words.
  await openMessage(page, WRITER, FOOTER)
  await expect(statusLine(page)).toHaveAttribute('data-state', 'needs-human')
  await expect(statusLine(page)).toHaveText('Unsubscribe needs a confirmation')

  // That control's click opens the drawer again and sends NOTHING: it is a conversation, not a rung.
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/unsubscribe')) posts.push(request.url())
  })
  await openRowMenu(page, WRITER, FOOTER)
  await unsubItem(page).click()
  await expect(page.getByTestId(DRAWER)).toBeVisible({ timeout: 60_000 })
  expect(posts, 'opening the drawer is not another attempt').toEqual([])
  await page.keyboard.press('Escape')
  await page.unroute(UNSUB_URL)
})

test('the agent\'s own ask is a different state: disabled, and it points at the inbox', async ({ page }) => {
  await openWriterInbox(page)

  // `needs-human` with `reason: 'asked'` is the agent having put the question in front of the person
  // (S9's op) and touched nothing else. It arrives as the same ledger status as the case above and
  // means the opposite: there is no page to finish, and the answer belongs where it was asked. Canned
  // at the route for the same reason — the agent's path is graded in
  // tests/integrations/mail-unsubscribe-console-only.test.ts.
  await page.route(UNSUB_URL, async (route) => {
    if (!route.request().url().includes(encodeURIComponent(ONE_CLICK))) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'needs-human',
        method: 'one-click',
        reason: 'asked',
        at: Date.now(),
        message: 'Walnut asked you about this in your inbox.',
      }),
    })
  })

  await openMessage(page, WRITER, ONE_CLICK)
  await unsubButton(page).click()
  await expect(unsubButton(page)).toHaveAttribute('data-unsub-state', 'asked', { timeout: 60_000 })
  // DISABLED, and that is the deliberate half. The ledger WOULD let a click through, and running the
  // ladder here would leave the agent's letter sitting in the inbox with a button that no longer means
  // anything.
  await expect(unsubButton(page)).toBeDisabled()
  await expect(unsubButton(page)).toHaveAttribute('title', ASKED_TITLE)
  await expect(statusLine(page)).toHaveText('Walnut asked you about unsubscribing')
  // And NO drawer, which is the whole difference from the case above: the question is already in front
  // of the person somewhere else, so opening a conversation about finishing it would be Walnut answering
  // its own letter.
  await expect(page.getByTestId(DRAWER)).toHaveCount(0)
  expect(await unsubState(page, WRITER, ONE_CLICK)).toEqual({
    label: 'Waiting on your answer',
    title: ASKED_TITLE,
    disabled: true,
  })
  await page.unroute(UNSUB_URL)
})
