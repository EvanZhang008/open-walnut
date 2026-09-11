import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Two things the Mail console asked a human to put up with, against the dense fixture, in both
 * themes and both engines.
 *
 *   a. ONE ROW CALLED DRAFTS. The folder list had two: the provider's Drafts mailbox and Walnut's
 *      own drafts row, same word, same glyph, different things. The merged row opens a list with a
 *      section for each, and the provider's mailbox is gone from the folder list.
 *   b. THE UNREAD COUNT IS A CONTROL. "8 unread" was a label with no way to act on it. It is now a
 *      chip that filters the list, says so while it is filtering, is remembered across a reload,
 *      and never yanks the row being read out from under the pointer.
 *
 * The one rule worth spelling out, because it is the difference between a filter people trust and
 * one they turn off: opening an unread mail marks it read, and its row STAYS until another row is
 * selected. A row that vanished in the same click would take the reply and make-a-task buttons with
 * it and leave nothing to go back to.
 *
 * Screenshots land in /tmp/mail-slack-ui/mail-usability/<engine>-<theme>-<step>.png.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home and
 * `MAIL_FIXTURE_DENSE=1`, which is what gives the fixture provider a Drafts folder with two server
 * drafts and an Archive folder with one unread mail. The other mail specs count the four messages
 * of the plain set, so none of this is ever their default.
 */

const SHOT_DIR = '/tmp/mail-slack-ui/mail-usability'

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

/** Switch the theme the way the app does: Settings, the picker, back to Mail. */
async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 30_000 })
}

/**
 * Paste into a chip field.
 *
 * A dispatched `paste` carrying a DataTransfer is the only way to exercise the handler that splits
 * it: keyboard Meta+V needs a populated system clipboard, which a headless run cannot promise.
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

async function shoot(target: Locator | Page, theme: string, step: string): Promise<string> {
  const engine = test.info().project.name
  const path = `${SHOT_DIR}/${engine}-${theme}-${step}.png`
  await target.screenshot({ path })
  return path
}

function folderRow(page: Page, mailboxId: string): Locator {
  return page.locator(`.mail-accounts-pane .mail-mailbox[data-mailbox-id="${mailboxId}"]`)
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
      // spawn's environment.
      MAIL_FIXTURE_DENSE: '1',
      // No unasked-for digest mid-run: this spec is about the list, and the scheduled letter is
      // work the console does not need while a filter is being measured.
      PW_MAIL_DIGEST_OFF: '1',
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

test('one Drafts row for both kinds, and an unread filter worth trusting', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await addAccount(page)
  await expect(page.getByTestId('mail-row')).toHaveCount(43, { timeout: 90_000 })

  // One draft written HERE, so the merged row has something in both of its sections.
  await writeOneDraft(page)

  const shots: string[] = []
  for (const theme of ['light', 'dark'] as const) {
    await pickTheme(page, theme === 'light' ? 'Light' : 'Dark')
    await expect(folderRow(page, 'INBOX')).toBeVisible({ timeout: 60_000 })
    shots.push(...await mergedDraftsRow(page, theme))
    shots.push(...await unreadFilter(page, theme))
    shots.push(...await unreadEmptyState(page, theme))
  }

  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
  console.log(`mail usability screenshots:\n${shots.join('\n')}`)
})

/** One local draft through the composer, exactly as the write spec makes one. */
async function writeOneDraft(page: Page): Promise<void> {
  await page.getByTestId('mail-compose-new').click()
  const composer = page.getByTestId('mail-composer')
  await expect(composer).toBeVisible()
  await pasteInto(page.getByTestId('mail-compose-to'), 'marta.silva@example.com')
  await page.getByTestId('mail-compose-subject').fill('Berth numbers for the temporary ramp')
  await page.getByTestId('mail-compose-body').fill('Three berths, and the chandlery keeps the keys.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('mail-composer-close').click()
  await expect(composer).toHaveCount(0, { timeout: 30_000 })
}

/** (a) One row called Drafts, in the provider folder's place, holding both kinds. */
async function mergedDraftsRow(page: Page, theme: string): Promise<string[]> {
  const shots: string[] = []

  // Exactly one row labelled Drafts, and it is not the provider's mailbox: that button is gone.
  const labelled = page.locator('.mail-accounts-pane .mail-mailbox-name').filter({ hasText: /^Drafts$/ })
  await expect(labelled, 'one row called Drafts, never two').toHaveCount(1)
  await expect(folderRow(page, 'Drafts'), "the provider's Drafts folder has no row of its own").toHaveCount(0)
  const merged = page.getByTestId('mail-drafts-row')
  await expect(merged).toHaveCount(1)
  // In the place the provider's folder held (before Junk, which is the folder that makes this a
  // claim rather than a coincidence), so the order a person knows their mailbox by is kept.
  const order = await page.locator('.mail-accounts-pane .mail-mailbox-name').allInnerTexts()
  expect(order, 'the merged row sits where the folder was').toEqual(['Inbox', 'Archive', 'Drafts', 'Junk'])
  // The badge counts what a human can act on, which is the local drafts, not the server's two.
  await expect(merged.getByTestId('mail-drafts-count')).toHaveText('1', { timeout: 30_000 })
  shots.push(await shoot(page.locator('.mail-accounts-pane'), theme, 'folders'))

  await merged.click()

  // The folder header counts everything below it, and each section counts its own.
  await expect(page.getByTestId('mail-list-section')).toContainText('Drafts', { timeout: 30_000 })
  await expect(page.getByTestId('mail-list-section')).toContainText('3')
  const groups = page.getByTestId('mail-drafts-group')
  await expect(groups).toHaveCount(2, { timeout: 30_000 })
  const here = groups.nth(0)
  await expect(here).toHaveAttribute('data-group', 'written-here')
  await expect(here).toContainText('Written here')
  await expect(here).toContainText('1')
  const server = groups.nth(1)
  await expect(server).toHaveAttribute('data-group', 'on-the-server')
  await expect(server).toContainText('On the server')
  await expect(server).toContainText('2')
  await expect(page.getByTestId('mail-draft-row'), 'the draft written here').toHaveCount(1)
  const serverRows = page.getByTestId('mail-row')
  await expect(serverRows, "the provider's two drafts").toHaveCount(2, { timeout: 30_000 })
  // No unread chip here: a drafts list has no unread, and a control that filters nothing is noise.
  await expect(page.getByTestId('mail-unread-filter')).toHaveCount(0)
  shots.push(await shoot(page.locator('.mail-list-pane'), theme, 'drafts-merged'))

  // A refresh must not move the human off this row. The Drafts row is in no provider's mailbox
  // list, so the check that decides whether a selection still exists used to read it as gone and
  // put the inbox back, which any sync event was enough to trigger. Keyed on the mailbox list's own
  // answer, because that is what runs the check.
  const mailboxRead = page.waitForResponse(
    (answer) => answer.url().includes('/mailboxes') && answer.request().method() === 'GET',
    { timeout: 60_000 },
  )
  const refresh = page.getByTestId('mail-refresh')
  await refresh.click()
  await mailboxRead
  // The button comes back only after the whole refresh has run, and the selection check is inside
  // it, so this is the barrier rather than a sleep: a machine under load would outlast any sleep.
  await expect(refresh).toBeEnabled({ timeout: 60_000 })
  await expect(merged, 'a refresh leaves the Drafts row selected').toHaveAttribute('aria-current', 'true')
  await expect(page.getByTestId('mail-list-section')).toContainText('Drafts')
  await expect(groups).toHaveCount(2)

  // A server draft opens in the reader like any other cached message.
  await serverRows.filter({ hasText: 'pontoon handover notes' }).click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('pontoon handover notes', { timeout: 30_000 })

  return shots
}

/** (b) The chip filters, says it is filtering, survives a reload, and holds the row being read. */
async function unreadFilter(page: Page, theme: string): Promise<string[]> {
  const shots: string[] = []
  await folderRow(page, 'INBOX').click()

  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(43, { timeout: 60_000 })
  const unreadRows = page.locator('[data-testid="mail-row"][data-unread="true"]')
  const unread = await unreadRows.count()
  expect(unread, 'the dense inbox has unread mail to filter').toBeGreaterThan(2)

  const chip = page.getByTestId('mail-unread-filter')
  await expect(chip).toHaveText(`${unread} unread`)
  await expect(chip).toHaveAttribute('data-on', 'false')

  await chip.click()
  await expect(chip).toHaveAttribute('data-on', 'true')
  await expect(chip).toHaveText(`${unread} unread · showing`)
  await expect(rows, 'the list is exactly the unread rows').toHaveCount(unread)
  await expect(unreadRows).toHaveCount(unread)
  // Both numbers stay checkable by looking: what is on screen, and what is loaded behind it.
  await expect(page.getByTestId('mail-list-section')).toContainText(`${unread} of 43`)
  shots.push(await shoot(page.locator('.mail-list-pane'), theme, 'unread-filter'))

  // Remembered: a reload lands on Mail (its own route) with the filter still on.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 60_000 })
  await expandSidebar(page)
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'true', { timeout: 60_000 })
  await expect(rows).toHaveCount(unread, { timeout: 60_000 })

  // Reading one keeps its row until another row is selected.
  const first = rows.first()
  const firstId = await first.getAttribute('data-message-id')
  await first.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', firstId!, { timeout: 30_000 })
  const read = page.locator(`[data-testid="mail-row"][data-message-id="${firstId}"]`)
  await expect(read, 'the row the human is reading turned read').toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await expect(read, 'and it is still on the list').toHaveCount(1)
  await expect(rows).toHaveCount(unread)

  const next = unreadRows.first()
  const nextId = await next.getAttribute('data-message-id')
  expect(nextId).not.toBe(firstId)
  await next.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', nextId!, { timeout: 30_000 })
  await expect(read, 'selecting another row is when the read one leaves').toHaveCount(0, { timeout: 30_000 })
  await expect(rows).toHaveCount(unread - 1)

  // Clicking the chip again shows everything.
  await page.getByTestId('mail-unread-filter').click()
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'false')
  await expect(rows).toHaveCount(43)

  return shots
}

/**
 * (b) The filter with nothing left to show: one line and a way out.
 *
 * Archive is the small folder with one unread mail. Reading it and coming back is the honest way to
 * reach the state, and coming back is also what proves the filter was remembered for THAT mailbox.
 * The mail is put back to unread at the end, so the second theme's pass starts where this one did.
 */
async function unreadEmptyState(page: Page, theme: string): Promise<string[]> {
  const shots: string[] = []
  await folderRow(page, 'Archive').click()
  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(2, { timeout: 60_000 })

  const chip = page.getByTestId('mail-unread-filter')
  await expect(chip).toHaveText('1 unread', { timeout: 30_000 })
  await chip.click()
  await expect(rows).toHaveCount(1)

  const only = rows.first()
  const onlyId = await only.getAttribute('data-message-id')
  await only.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', onlyId!, { timeout: 30_000 })
  await expect(rows, 'the last unread mail stays while it is open').toHaveCount(1)

  // Away and back, which is when the read one drops out.
  await folderRow(page, 'INBOX').click()
  await expect(rows).toHaveCount(43, { timeout: 60_000 })
  await folderRow(page, 'Archive').click()
  const empty = page.getByTestId('mail-unread-empty')
  await expect(empty, 'the filter was remembered for this mailbox too').toBeVisible({ timeout: 60_000 })
  await expect(empty).toContainText('No unread messages')
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('mail-unread-filter')).toHaveText('0 unread · showing')
  await expect(page.getByTestId('mail-list-section')).toContainText('0 of 2')
  shots.push(await shoot(page.locator('.mail-list-pane'), theme, 'unread-empty'))

  await page.getByTestId('mail-unread-show-all').click()
  await expect(page.getByTestId('mail-unread-empty')).toHaveCount(0)
  await expect(rows, 'Show all brings the folder back').toHaveCount(2)

  // Put the mail back to unread for the next pass, through the reader's own control.
  await page.locator(`[data-testid="mail-row"][data-message-id="${onlyId}"]`).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', onlyId!, { timeout: 30_000 })
  await page.getByTestId('mail-mark-read').click()
  await expect(page.locator(`[data-testid="mail-row"][data-message-id="${onlyId}"]`))
    .toHaveAttribute('data-unread', 'true', { timeout: 30_000 })

  return shots
}
