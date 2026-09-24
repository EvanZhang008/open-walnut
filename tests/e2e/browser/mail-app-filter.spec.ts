import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

/**
 * Three things the Mail console asked a human to put up with, against the dense fixture, in both
 * themes and both engines.
 *
 *   a. ONE ROW CALLED DRAFTS. The folder list had two: the provider's Drafts mailbox and Walnut's
 *      own drafts row, same word, same glyph, different things. The merged row opens a list with a
 *      section for each, and the provider's mailbox is gone from the folder list.
 *   b. THE UNREAD COUNT IS A CONTROL. "8 unread" was a label with no way to act on it. It is now a
 *      chip that filters the list, says so while it is filtering, is remembered across a reload,
 *      and never yanks the row being read out from under the pointer.
 *   c. THE FILTER SEES THE WHOLE MAILBOX. It was a pass over the fifty rows a page holds, so on a
 *      real account it read "4 unread" under a folder row saying "Inbox 99+" and showed those four.
 *      The chip now reads the MAILBOX's number and the list is `GET /messages?unread=1`, which pages
 *      with "Load older" like any other list.
 *   d. ONE SOURCE FOR THE THREE NUMBERS. The folder badge, the header's folder size and the header's
 *      unread count are all the mailbox row's own figures, and the badge prints them exactly (12,345,
 *      never "99+"). The reported state was a folder row reading "Inbox 99+" beside a header reading
 *      "INBOX 50" and "5 unread": three numbers for one folder, no two of them the same thing.
 *      Reading a message moves the badge and the chip together, in the same click.
 *
 * The one rule worth spelling out, because it is the difference between a filter people trust and
 * one they turn off: opening an unread mail marks it read, and its row STAYS until another row is
 * selected. A row that vanished in the same click would take the reply and make-a-task buttons with
 * it and leave nothing to go back to. That now has to survive a "Load older" as well, because the
 * server has genuinely stopped returning it and only the browser still has it.
 *
 * Screenshots land in /tmp/mail-slack-ui/mail-usability/<engine>-<theme>-<step>.png, and the two the
 * server-side filter is judged on in /tmp/mail-slack-ui/mail-unread-server/<engine>-<step>.png.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home,
 * `MAIL_FIXTURE_DENSE=1` (a Drafts folder with two server drafts, an Archive folder with one unread
 * mail) and `MAIL_FIXTURE_DEEP=1` (sixty older inbox messages, forty-five unread, so the inbox is 103
 * rows and 53 unread and neither the page nor the unread list fits in one request). The other mail
 * specs count the four messages of the plain set, so none of this is ever their default.
 */

const SHOT_DIR = '/tmp/mail-slack-ui/mail-usability'
const SERVER_FILTER_SHOT_DIR = '/tmp/mail-slack-ui/mail-unread-server'

/** One page of the list, which is also how much of a 103-row inbox arrives at once. */
const PAGE_SIZE = 50

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
  // The form focuses its first field once it mounts; filling before that lands the password in the
  // address box (seen 2026-09-24: `alice@example.invalidok` and a disabled button). Same guard as
  // mail-app-folder-fetch.spec.ts.
  const address = page.getByTestId('mail-setup-address')
  await expect(address).toBeFocused({ timeout: 15_000 })
  await address.fill('alice@example.invalid')
  await page.getByTestId('mail-setup-token').fill('ok')
  await expect(address).toHaveValue('alice@example.invalid')
  await expect(page.getByTestId('mail-setup-token')).toHaveValue('ok')
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

/** The server-side filter's own two shots, named without the theme so the light pass is canonical. */
async function shootServerFilter(target: Locator | Page, theme: string, step: string): Promise<string> {
  const engine = test.info().project.name
  const path = `${SERVER_FILTER_SHOT_DIR}/${engine}-${step}${theme === 'light' ? '' : `-${theme}`}.png`
  await target.screenshot({ path })
  return path
}

function folderRow(page: Page, mailboxId: string): Locator {
  return page.locator(`.mail-accounts-pane .mail-mailbox[data-mailbox-id="${mailboxId}"]`)
}

/** The number beside the folder name in the list header: how big the FOLDER is, in both modes. */
function sectionCount(page: Page): Locator {
  return page.locator('.mail-list-section .mail-list-section-count')
}

/** The unread number the FOLDER row shows, which is the one the chip now has to agree with. */
async function folderUnread(page: Page, mailboxId: string): Promise<number> {
  const value = await folderRow(page, mailboxId).getAttribute('data-unread')
  return Number(value)
}

/** The folder's size as the mailbox row declares it, which is what the header now prints. */
async function folderTotal(page: Page, mailboxId: string): Promise<number> {
  const value = await folderRow(page, mailboxId).getAttribute('data-total')
  return Number(value)
}

function unreadBadge(page: Page, mailboxId: string): Locator {
  return folderRow(page, mailboxId).getByTestId('mail-mailbox-unread')
}

/**
 * A count as the console prints it.
 *
 * `en-US` rather than the runner's locale: Playwright gives the page that locale unless a project
 * asks for another, so this is the grouping the browser under test will actually apply.
 */
function grouped(count: number): string {
  return new Intl.NumberFormat('en-US').format(count)
}

/**
 * A badge wide enough to hold five figures still has to be ONE line inside its folder row.
 *
 * Measured rather than eyeballed: a wrapped badge is the failure that a screenshot of a light theme
 * at one width can hide, and it is engine-specific (the pane is 232px and the two engines round flex
 * widths differently).
 */
async function expectBadgeFits(page: Page, mailboxId: string, text: string): Promise<void> {
  const badge = unreadBadge(page, mailboxId)
  await expect(badge, `the ${mailboxId} badge prints its exact count`).toHaveText(text)
  const box = await badge.boundingBox()
  const row = await folderRow(page, mailboxId).boundingBox()
  expect(box, 'the badge is on screen').not.toBeNull()
  expect(row, 'so is its folder row').not.toBeNull()
  expect(box!.height, `the ${mailboxId} badge stays on one line`).toBeLessThan(20)
  expect(box!.x + box!.width, `the ${mailboxId} badge stays inside its row`)
    .toBeLessThanOrEqual(row!.x + row!.width + 0.5)
  const clipped = await badge.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(clipped, `the ${mailboxId} badge is not clipping its own number`).toBeLessThanOrEqual(1)
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await fs.mkdir(SERVER_FILTER_SHOT_DIR, { recursive: true })
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
      // Sixty older inbox messages, forty-five of them unread: without them the inbox is 43 rows
      // with 8 unread, one page holds all of it, and a filter in the browser is indistinguishable
      // from a filter in SQL.
      MAIL_FIXTURE_DEEP: '1',
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

test('one Drafts row for both kinds, and an unread filter that sees the whole mailbox', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await addAccount(page)
  // ONE page of a 103-row inbox. That the list stops at fifty is the reason the filter had to move
  // to the server at all.
  await expect(page.getByTestId('mail-row')).toHaveCount(PAGE_SIZE, { timeout: 90_000 })

  // One draft written HERE, so the merged row has something in both of its sections.
  await writeOneDraft(page)

  const shots: string[] = []
  for (const theme of ['light', 'dark'] as const) {
    await pickTheme(page, theme === 'light' ? 'Light' : 'Dark')
    await expect(folderRow(page, 'INBOX')).toBeVisible({ timeout: 60_000 })
    shots.push(...await mergedDraftsRow(page, theme))
    shots.push(...await exactUnreadBadges(page, theme))
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
  // The badge is the FIRST SECTION of the view this row opens: the one draft written here, which a person
  // can check by counting rows. It added the provider's Drafts folder as the mailbox row declares it, and a
  // folder's declared size counts drafts outside this cache's retention window, so on a real account a
  // badge of 51 sat over sections adding up to 8. The header below still counts the whole view.
  await expect(merged.getByTestId('mail-drafts-count')).toHaveText('1', { timeout: 30_000 })
  shots.push(await shoot(page.locator('.mail-accounts-pane'), theme, 'folders'))

  await merged.click()

  // The folder header counts everything below it, and each section counts its own: one written here plus
  // the two the provider holds. The row's badge above is the first of those sections.
  await expect(page.getByTestId('mail-list-section')).toContainText('Drafts', { timeout: 30_000 })
  await expect(page.locator('.mail-list-section .mail-list-section-count')).toHaveText('3')
  await expect(page.getByTestId('mail-list-count-word'), 'a page of a folder, not a total').toHaveText('loaded')
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

/**
 * (d) The folder badges print exact counts, and a five figure one fits its row.
 *
 * Junk declares 12,345 unread with nothing cached, which is what a real spam folder looks like: the
 * cap used to turn every folder past a hundred into the same folder, so a mailbox with 12,345 unread
 * and one with 100 were both "99+" and neither could be checked against the list header.
 */
async function exactUnreadBadges(page: Page, theme: string): Promise<string[]> {
  const pane = page.locator('.mail-accounts-pane')
  await expect(pane, 'no folder count is capped any more').not.toContainText('99+')

  // The inbox badge is the mailbox row's own number, printed in full.
  await expect(unreadBadge(page, 'INBOX')).toHaveText(grouped(await folderUnread(page, 'INBOX')))
  await expectBadgeFits(page, 'INBOX', grouped(await folderUnread(page, 'INBOX')))
  // And the wide one, grouped by the locale rather than run together as 12345.
  expect(await folderUnread(page, 'Junk'), 'the fixture declares a five figure spam folder').toBe(12_345)
  await expectBadgeFits(page, 'Junk', '12,345')

  return [await shoot(pane, theme, 'exact-badges')]
}

/**
 * (b) and (c). The chip reads the MAILBOX's unread count, filtering asks the server for the unread
 * set, that set pages, and the row being read survives both a reload and a "Load older".
 *
 * Every number here is read off the page rather than written down, because the second theme's pass
 * starts from a mailbox the first one read two messages out of. What is asserted are the RELATIONS,
 * and the load-bearing one is the first: the folder holds more unread mail than the loaded page
 * contains, which is the exact state the old client-side filter answered wrongly.
 */
async function unreadFilter(page: Page, theme: string): Promise<string[]> {
  const shots: string[] = []
  await folderRow(page, 'INBOX').click()

  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
  const unreadRows = page.locator('[data-testid="mail-row"][data-unread="true"]')
  const chip = page.getByTestId('mail-unread-filter')

  // What the mailbox holds, against what the loaded page can see. The old chip counted the second
  // number and offered to show you those.
  const mailboxUnread = await folderUnread(page, 'INBOX')
  const mailboxTotal = await folderTotal(page, 'INBOX')
  const onThePage = await unreadRows.count()
  expect(mailboxUnread, 'the deep inbox holds more unread mail than one page can hold')
    .toBeGreaterThan(PAGE_SIZE)
  expect(onThePage, 'and the loaded page holds only some of it').toBeLessThan(mailboxUnread)
  await expect(chip, 'the chip is the mailbox count, not the loaded one')
    .toHaveText(`${mailboxUnread} unread`)
  await expect(chip).toHaveAttribute('data-on', 'false')
  // The header's own two numbers are the mailbox row's, not the page's: the folder is bigger than the
  // fifty rows under it and says so, which is the state that used to read "INBOX 50" under "Inbox 53".
  expect(mailboxTotal, 'the folder is bigger than one page').toBeGreaterThan(PAGE_SIZE)
  await expect(sectionCount(page)).toHaveText(grouped(mailboxTotal))
  await expect(sectionCount(page)).toHaveAttribute('data-loaded', 'false')
  await expect(sectionCount(page)).toHaveAttribute('title', 'messages in this folder')
  await expect(unreadBadge(page, 'INBOX'), 'the badge and the chip are one number')
    .toHaveText(grouped(mailboxUnread))

  // One unread mail that is past the first page, named so its arrival is provable rather than a
  // difference between two counts.
  const deep = page.locator('[data-testid="mail-row"]', { hasText: 'Older harbour note 45' })
  const deepest = page.locator('[data-testid="mail-row"]', { hasText: 'Older harbour note 59' })
  await expect(deep, 'it is not on the unfiltered first page').toHaveCount(0)

  await chip.click()
  await expect(chip).toHaveAttribute('data-on', 'true')
  await expect(chip).toHaveText(`${mailboxUnread} unread · showing unread only`)
  // A FULL page of unread rows, which is already more unread mail than the unfiltered page held at
  // all: no client-side filter over that page could produce this list.
  await expect(rows, 'the filtered first page is a full page of unread mail').toHaveCount(PAGE_SIZE)
  await expect(unreadRows).toHaveCount(PAGE_SIZE)
  await expect(deep, 'and it reaches mail the browser never had').toHaveCount(1)
  // Unchanged by the filter: it describes the folder, and the folder did not change size.
  await expect(sectionCount(page)).toHaveText(grouped(mailboxTotal))
  shots.push(await shoot(page.locator('.mail-list-pane'), theme, 'unread-filter'))
  shots.push(await shootServerFilter(page.locator('.mail-list-pane'), theme, 'filter-on-first-page'))

  // The unread list pages like any other list, and ends when it ends.
  const older = page.getByTestId('mail-load-older')
  await expect(older, 'the unread set is longer than a page, so there is more to load').toHaveCount(1)
  await older.click()
  await expect(rows, 'every unread message in the mailbox').toHaveCount(mailboxUnread, { timeout: 60_000 })
  await expect(unreadRows).toHaveCount(mailboxUnread)
  await expect(deepest, 'down to the oldest unread mail there is').toHaveCount(1)
  await expect(sectionCount(page)).toHaveText(grouped(mailboxTotal))
  await expect(older, 'a short page offers no cursor, so the list ends').toHaveCount(0)
  shots.push(await shootServerFilter(page.locator('.mail-list-pane'), theme, 'filter-on-after-load-older'))

  // Remembered: a reload lands on Mail (its own route) with the filter still on, at page one.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 60_000 })
  await expandSidebar(page)
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'true', { timeout: 60_000 })
  await expect(rows).toHaveCount(PAGE_SIZE, { timeout: 60_000 })

  // Reading one keeps its row until another row is selected, and the SERVER has stopped returning it
  // by then, so the "Load older" below is the real test: only the browser still has this row.
  const first = rows.first()
  const firstId = await first.getAttribute('data-message-id')
  await first.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', firstId!, { timeout: 30_000 })
  const read = page.locator(`[data-testid="mail-row"][data-message-id="${firstId}"]`)
  await expect(read, 'the row the human is reading turned read').toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await expect(read, 'and it is still on the list').toHaveCount(1)
  await expect(rows, 'the list itself does not move under the filter').toHaveCount(PAGE_SIZE)
  // The chip and the folder badge follow the mailbox, which just lost one, in the same click: they are
  // the same number from the same row, so a human watching sees all three figures agree at every step.
  await expect(page.getByTestId('mail-unread-filter')).toHaveText(`${mailboxUnread - 1} unread · showing unread only`)
  await expect(unreadBadge(page, 'INBOX'), 'the badge dropped by one too')
    .toHaveText(grouped(mailboxUnread - 1))
  expect(await folderUnread(page, 'INBOX')).toBe(mailboxUnread - 1)
  await expect(sectionCount(page), 'and the folder did not get smaller').toHaveText(grouped(mailboxTotal))

  await page.getByTestId('mail-load-older').click()
  await expect(rows, 'the rest of the unread mail arrives').toHaveCount(mailboxUnread, { timeout: 60_000 })
  await expect(read, 'and the row being read survived a page the server answered without it')
    .toHaveCount(1)
  await expect(read).toHaveAttribute('data-unread', 'false')

  const next = unreadRows.first()
  const nextId = await next.getAttribute('data-message-id')
  expect(nextId).not.toBe(firstId)
  await next.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', nextId!, { timeout: 30_000 })
  await expect(read, 'selecting another row is when the read one leaves').toHaveCount(0, { timeout: 30_000 })
  await expect(rows).toHaveCount(mailboxUnread - 1)

  // Clicking the chip again reloads the plain first page.
  await page.getByTestId('mail-unread-filter').click()
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'false')
  await expect(rows).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
  await expect(deep, 'which is the top of the mailbox again, not the unread set').toHaveCount(0)
  await expect(page.getByTestId('mail-load-older'), 'and it pages the mailbox').toHaveCount(1)

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
  const archiveTotal = await folderTotal(page, 'Archive')

  const chip = page.getByTestId('mail-unread-filter')
  await expect(chip).toHaveText('1 unread', { timeout: 30_000 })
  await chip.click()
  await expect(rows).toHaveCount(1)

  const only = rows.first()
  const onlyId = await only.getAttribute('data-message-id')
  await only.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', onlyId!, { timeout: 30_000 })
  await expect(rows, 'the last unread mail stays while it is open').toHaveCount(1)

  // Away and back, which is when the read one drops out. It is also the case the server answers with
  // an EMPTY page: "nothing unread" and "nothing at all" are the same zero rows now, and only the
  // filter being on tells the pane which sentence to print.
  await folderRow(page, 'INBOX').click()
  await expect(rows).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
  await folderRow(page, 'Archive').click()
  const empty = page.getByTestId('mail-unread-empty')
  await expect(empty, 'the filter was remembered for this mailbox too').toBeVisible({ timeout: 60_000 })
  await expect(empty).toContainText('No unread messages')
  await expect(page.getByTestId('mail-list-empty'), 'not the "no mail in this folder" line').toHaveCount(0)
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('mail-unread-filter')).toHaveText('0 unread · showing unread only')
  // Still the FOLDER's size, with none of it unread and so none of it on screen. The count answering
  // "0" here would say the folder is empty, which is a different thing and not true.
  await expect(sectionCount(page)).toHaveText(grouped(archiveTotal))
  await expect(unreadBadge(page, 'Archive'), 'nothing unread, so no badge at all').toHaveCount(0)
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
