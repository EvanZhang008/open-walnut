import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The Mail console's WRITE path, end to end, against a real server with a canned provider plugin.
 *
 * One user story in order, because every step is the setup for the next: write a message, ask the
 * phone to approve it, ANSWER THAT LETTER FROM THE WEB INBOX, reply to a message that already
 * exists, then edit a frozen draft and watch the letter be replaced.
 *
 * What this pins that no unit test can:
 *
 *   a. A pasted `a@x.invalid, b@y.invalid` becomes TWO chips, and the draft is created and saved
 *      by itself; the Drafts row counts it.
 *   b. The approval letter is answerable from the web inbox (the same store the phone reads), and
 *      answering Send there is what sends: the fixture provider recorded exactly ONE message, with
 *      both recipients and the html the SERVER rendered from the markdown.
 *   c. Reply pre-fills the sender and `Re:` once, shows the original as a quote, and the server
 *      copies `In-Reply-To` from the cached message rather than trusting the browser.
 *   d. Editing a draft that has a letter out withdraws that letter and issues a fresh one, and the
 *      form does NOT get yanked away from the human mid-sentence.
 *   e. An account whose provider cannot send says so on the button instead of failing on the click.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home: the
 * accounts, the drafts and the recorded sends must not outlive the run.
 */

const SCREENSHOT_DIR = '/tmp/plugin-platform/pw'

const SENDABLE = 'fixture:me@example.invalid'
const INBOUND = 'inbound:read-only@example.invalid'

interface Fixture {
  port: number
  home: string
  /** Where the canned provider records every message it was handed. */
  outbox: string
}

interface RecordedSend {
  accountId: string
  to: Array<{ name?: string; address: string }>
  cc: Array<{ address: string }>
  subject: string
  bodyMarkdown: string
  bodyHtml: string
  inReplyTo: string | null
  references: string[]
  idempotencyKey: string
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)
test.use({ viewport: { width: 1280, height: 900 } })

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

/** Every message the provider was handed, in order. `[]` until the first send. */
async function recordedSends(): Promise<RecordedSend[]> {
  try {
    return JSON.parse(await fs.readFile(fixture!.outbox, 'utf8')) as RecordedSend[]
  } catch {
    return []
  }
}

/** Add an account through the dialog, exactly as a human does. */
async function addAccount(page: Page, providerId: string, address: string): Promise<void> {
  await page.getByTestId('mail-add-account').click()
  const dialog = page.getByTestId('mail-add-dialog')
  await expect(dialog).toBeVisible()
  await page.locator(`[data-testid="mail-provider-option"][data-provider-id="${providerId}"]`).click()
  await page.getByTestId('mail-setup-address').fill(address)
  if (await page.getByTestId('mail-setup-token').count()) {
    await page.getByTestId('mail-setup-token').fill('ok')
  }
  await page.getByTestId('mail-add-submit').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Paste into a chip field.
 *
 * A dispatched `paste` carrying a DataTransfer is the only way to exercise the handler that splits
 * it: keyboard `Meta+V` needs a populated system clipboard, which a headless run cannot promise.
 * The event bubbles, so React's root listener sees it exactly as it sees a real one.
 */
async function pasteInto(field: Locator, text: string): Promise<void> {
  await field.click()
  await field.evaluate((element, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }))
  }, text)
}

/** Open the human inbox the way a human does: the bell, then the section. */
async function openLetters(page: Page, section: 'Needs Action' | 'Inbox'): Promise<void> {
  await page.locator('.sidebar-notification-btn').click()
  await expect(page.locator('.notification-panel')).toBeVisible({ timeout: 30_000 })
  await page.locator('.nfc-rail-btn', { hasText: section }).first().click()
}

/**
 * Open the letters and keep reopening until `wanted` is on screen.
 *
 * The letters list is CACHED for 15s (`web/src/components/inbox/letter-store.ts`), and a letter
 * event that lands while the panel is closed does not invalidate that cache, so the first open
 * after a letter was issued legitimately shows the previous list and "Nothing waiting on you". A
 * human's answer to that is to close it and look again, which re-runs the staleness check, so that
 * is what this does rather than pretending the mail console is at fault. The cache is reported as
 * drift; nothing in this slice's files can fix it.
 */
async function openLettersUntil(
  page: Page,
  section: 'Needs Action' | 'Inbox',
  wanted: Locator,
): Promise<void> {
  const deadline = Date.now() + 90_000
  for (;;) {
    await openLetters(page, section)
    try {
      await expect(wanted).toHaveCount(1, { timeout: 8_000 })
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await closeLetters(page)
      await page.waitForTimeout(5_000)
    }
  }
}

async function closeLetters(page: Page): Promise<void> {
  if (await page.locator('.hib-reader-close').count()) await page.locator('.hib-reader-close').click()
  await page.locator('.notification-panel-close').click()
  await expect(page.locator('.notification-panel')).toHaveCount(0)
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: booting a server plus Vite takes longer than
  // the config default whenever the machine is busy.
  test.setTimeout(300_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    // PW_MAIL_INBOUND_PROVIDER: the fixture plugin also registers a provider that declares `send: false`,
    // which is the only way the console can see two accounts disagree about sending.
    env: { ...process.env, PW_MAIL_PORT: String(port), PW_MAIL_PROVIDER: '1', PW_MAIL_INBOUND_PROVIDER: '1' },
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

test('compose, approve from the web inbox, reply, and re-ask after an edit', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)

  const mailRow = page.getByTestId('sidebar-core-app-mail')
  await expect(mailRow).toBeVisible({ timeout: 60_000 })
  await mailRow.click()

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await addAccount(page, 'fixture', 'me@example.invalid')

  const inbox = page.locator('.mail-mailbox[data-mailbox-id="INBOX"]')
  await expect(inbox.first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-row')).toHaveCount(3, { timeout: 60_000 })

  // ── (a) a new message, its chips, and the autosave ──

  const compose = page.getByTestId('mail-compose-new')
  await expect(compose).toBeEnabled()
  await compose.click()

  const composer = page.getByTestId('mail-composer')
  await expect(composer).toBeVisible()

  await pasteInto(page.getByTestId('mail-compose-to'), 'a@x.invalid, b@y.invalid')
  const chips = page.getByTestId('mail-compose-chip-to')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('data-address', 'a@x.invalid')
  await expect(chips.nth(1)).toHaveAttribute('data-address', 'b@y.invalid')

  await page.getByTestId('mail-compose-subject').fill('Boardwalk plan')
  await page.getByTestId('mail-compose-body').fill('Bringing the **boardwalk plan** on Friday.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await expect(page.getByTestId('mail-compose-attachments')).toContainText('not supported yet')

  const draftsRow = page.locator(`[data-testid="mail-drafts-row"][data-account-id="${SENDABLE}"]`)
  await expect(draftsRow.getByTestId('mail-drafts-count')).toHaveText('1', { timeout: 30_000 })
  await composer.screenshot({ path: `${SCREENSHOT_DIR}/mail-composer.png` })

  // ── (b) ask the phone, then answer the letter from the WEB inbox ──

  await page.getByTestId('mail-compose-ask').click()
  const headline = page.getByTestId('mail-send-headline')
  await expect(headline).toContainText('Waiting for approval', { timeout: 30_000 })
  await expect(page.getByTestId('mail-send-letter')).not.toBeEmpty()
  await composer.screenshot({ path: `${SCREENSHOT_DIR}/mail-waiting-approval.png` })

  const letter = page.locator('.hib-row', { hasText: 'Approve this message' })
  await openLettersUntil(page, 'Needs Action', letter)
  await letter.click()

  // The letter is the approval object: what it shows IS what will be sent.
  const actions = page.locator('.hib-action-btn')
  await expect(actions).toHaveCount(3, { timeout: 30_000 })
  await expect(actions.nth(0)).toContainText('Send')
  await expect(actions.nth(1)).toContainText('Edit')
  await expect(actions.nth(2)).toContainText('Discard')
  await expect(page.locator('.hib-reader-body')).toContainText('a@x.invalid')
  await expect(page.locator('.hib-reader-body')).toContainText('Answering Send sends exactly this')

  await actions.nth(0).click()
  await expect(page.locator('.hib-answered')).toContainText('Send', { timeout: 30_000 })
  await closeLetters(page)

  await expect(headline).toContainText('Sent at', { timeout: 60_000 })
  await composer.screenshot({ path: `${SCREENSHOT_DIR}/mail-sent-card.png` })
  // A sent draft is not a draft: it leaves the Drafts row's count.
  await expect(draftsRow.getByTestId('mail-drafts-count')).toHaveCount(0, { timeout: 30_000 })

  await expect.poll(async () => (await recordedSends()).length, { timeout: 30_000 }).toBe(1)
  const first = (await recordedSends())[0]!
  expect(first.accountId).toBe(SENDABLE)
  expect(first.to.map((one) => one.address)).toEqual(['a@x.invalid', 'b@y.invalid'])
  expect(first.subject).toBe('Boardwalk plan')
  // The html is the SERVER's rendering of the markdown the human typed, which is the half a
  // console-side renderer would have had to agree with.
  expect(first.bodyHtml).toContain('<strong>boardwalk plan</strong>')
  expect(first.idempotencyKey).toMatch(/^dr-.+:\d+$/)

  // ── (c) reply to a message that already exists ──

  await page.getByTestId('mail-send-back').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)

  await page.locator('[data-testid="mail-row"]', { hasText: 'Quarterly keeper report' }).click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Quarterly keeper report', { timeout: 30_000 })
  await page.getByTestId('mail-reply').click()

  await expect(page.getByTestId('mail-composer')).toBeVisible()
  await expect(page.getByTestId('mail-compose-chip-to')).toHaveAttribute('data-address', 'keeper@example.invalid')
  await expect(page.getByTestId('mail-compose-subject')).toHaveValue('Re: Quarterly keeper report')
  await expect(page.getByTestId('mail-compose-quote')).toContainText('keeper@example.invalid> wrote:')

  await page.getByTestId('mail-compose-body').fill('Noted, thank you.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('mail-compose-send').click()

  await expect(page.getByTestId('mail-send-headline')).toContainText('Sent', { timeout: 60_000 })
  await expect.poll(async () => (await recordedSends()).length, { timeout: 30_000 }).toBe(2)
  const reply = (await recordedSends())[1]!
  // Copied by the SERVER from the cached message, never from the browser.
  expect(reply.inReplyTo).toBe('<keeper-31@example.invalid>')
  expect(reply.references).toContain('<keeper-31@example.invalid>')
  expect(reply.subject).toBe('Re: Quarterly keeper report')
  expect(reply.bodyMarkdown).toContain('Noted, thank you.')

  // ── (d) editing a frozen draft replaces the letter ──

  await page.getByTestId('mail-send-back').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)

  await page.getByTestId('mail-compose-new').click()
  await pasteInto(page.getByTestId('mail-compose-to'), 'carol@example.invalid')
  await page.getByTestId('mail-compose-subject').fill('Second look')
  await page.getByTestId('mail-compose-body').fill('First version.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('mail-compose-ask').click()
  await expect(page.getByTestId('mail-send-headline')).toContainText('Waiting for approval', { timeout: 30_000 })
  const firstLetterId = (await page.getByTestId('mail-send-letter').textContent())?.trim()
  expect(firstLetterId).toBeTruthy()

  // The drafts list shows it waiting, which is the state a list of drafts must not hide.
  await draftsRow.click()
  const draftRows = page.getByTestId('mail-draft-row')
  await expect(draftRows).toHaveCount(1, { timeout: 30_000 })
  await expect(draftRows.first().getByTestId('mail-draft-pill')).toHaveText('Waiting')
  await page.getByTestId('mail-message-list').screenshot({ path: `${SCREENSHOT_DIR}/mail-drafts-list.png` })

  // Back to the card, then Edit, then ONE more character: the form stays put (the human is
  // mid-sentence) and the server swaps the letter underneath it.
  await page.getByTestId('mail-send-edit').click()
  await page.getByTestId('mail-compose-body').fill('First version, revised.')
  await expect(page.getByTestId('mail-compose-notice')).toContainText('fresh letter', { timeout: 30_000 })
  await expect(page.getByTestId('mail-composer')).toHaveAttribute('data-mode', 'edit')

  // A DIFFERENT letter, which is the whole promise: an approval can never outlive the text it
  // described. The card is one click away while the form stays where it was.
  await page.getByTestId('mail-composer-show-status').click()
  const secondLetterId = (await page.getByTestId('mail-send-letter').textContent())?.trim()
  expect(secondLetterId).toBeTruthy()
  expect(secondLetterId).not.toBe(firstLetterId)

  // Keyed on the WITHDRAWN row: it exists only in a list read after the swap, so a cached list
  // cannot make this pass by accident.
  const withdrawn = page.locator('.hib-row', { hasText: 'Second look' }).filter({ hasText: 'Withdrawn' })
  await openLettersUntil(page, 'Inbox', withdrawn)
  // Both asks are on the shelf, and exactly one of them was taken back.
  await expect(page.locator('.hib-row', { hasText: 'Second look' })).toHaveCount(2)

  await page.locator('.nfc-rail-btn', { hasText: 'Needs Action' }).first().click()
  // One live ask, and it is not the withdrawn one: a withdrawn letter is answered, so it drops out.
  const live = page.locator('.hib-row', { hasText: 'Approve this message' })
  await expect(live).toHaveCount(1, { timeout: 30_000 })
  await expect(live.locator('.hib-answered-chip')).toHaveCount(0)
  await closeLetters(page)

  // Nothing was sent by any of that.
  expect((await recordedSends())).toHaveLength(2)

  // ── (e) an account that cannot send says so ──

  await addAccount(page, 'inbound', 'read-only@example.invalid')
  const inboundInbox = page.locator(`.mail-mailbox[data-account-id="${INBOUND}"][data-mailbox-id="INBOX"]`)
  await expect(inboundInbox).toBeVisible({ timeout: 60_000 })
  await inboundInbox.click()

  const gated = page.getByTestId('mail-compose-new')
  await expect(gated).toBeDisabled()
  await expect(gated).toHaveAttribute('title', 'This account cannot send; add SMTP settings')

  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
})
