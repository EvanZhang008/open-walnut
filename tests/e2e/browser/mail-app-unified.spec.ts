import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

/**
 * The merged lists, against the dense fixture: two accounts, 70 folders, the same roles under
 * different mailbox ids, and one message id that exists in both accounts.
 *
 * What is being judged here, in the order the checklist asks for it:
 *
 *   a. ONE QUERY. Opening All Inboxes issues exactly one `GET /messages` carrying
 *      `scope=role:inbox`, and no per-account page beside it. A merge in the browser cannot page.
 *   b. ONE SET OF NUMBERS. The sidebar badge and the header's unread are the same string, because
 *      both are the sum of the same mailbox rows. The third number on screen (unread dots) can
 *      honestly differ, since the provider declares 7 unread in a folder whose cached rows hold 18,
 *      and turning the filter on is where a person meets that: the chip then counts the rows under
 *      it and says so in its title instead of printing the provider's figure over 18 rows.
 *   c. IDENTITY IS A PAIR. Two accounts really do answer with the same message id, so opening one
 *      copy highlights one row, and the row says which account it belongs to with the account's own
 *      short name. That slot used to print the raw mailbox id, which here is 90 characters.
 *   d. THE FOUR NUMBERS MOVE TOGETHER. Reading an unread mail in the merged list drops the child
 *      badge, the smart badge, the header and the app's own sidebar badge; a provider that refuses
 *      the flag (mocked 409) puts all four back and says nothing globally.
 *   e. AN EMPTY MERGED LIST IS THREE ANSWERS, and the one that offers a button asks for a refresh:
 *      a smart selection is not a folder, so there is nothing for `/mailboxes/fetch` to name.
 *   f. ALL DRAFTS is the per-account Drafts row's meaning, per account: what was written here first
 *      (that half IS the badge, countable on screen), then the accounts that keep a server folder.
 *   g. THE IDENTITY IS ON SCREEN in the reader and in the composer, and the composer's drafts chip
 *      no longer throws a person out of the list they were reading.
 *
 * Screenshots land in /tmp/mail-sidebar-ux/unified/<engine>-<step>.png.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home and
 * `PW_MAIL_DENSE=1`, so no dialog is driven: the dense provider declares no setup fields and the
 * base adopts both of its accounts as soon as it registers.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/unified'

/** The dense fixture's two accounts, and the ids it spells the same roles with. */
const A = 'dense:harbour'
const B = 'dense:marina'
const A_NAME = 'Harbour mail'
const B_NAME = 'Marina mail'
const A_ADDRESS = 'harbour@example.invalid'
const B_ADDRESS = 'marina@example.invalid'
/** The one collapsed-tail label with cached mail, which is where the selection starts. */
const TAIL_MAILBOX = 'harbour/label/receipts'
/** B's inbox declares this many unread; its cached rows hold 18. Both numbers are real. */
const DECLARED_UNREAD = 7
const CACHED_UNREAD = 18
const PAGE_SIZE = 50
/** Invented subjects, one per account, so a draft row can be found without guessing an id. */
const A_DRAFT = 'Ramp keys for the north berth'
const B_DRAFT = 'Fuel dock hours in winter'

interface Fixture { port: number; home: string }

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

async function startFixture(extra: Record<string, string> = {}): Promise<void> {
  output = ''
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_MAIL_PORT: String(port),
      PW_MAIL_DENSE: '1',
      // No unasked-for digest mid-run: the scheduled letter marks mail read, and every number in
      // this spec is an unread count.
      PW_MAIL_DIGEST_OFF: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
}

async function stopFixture(): Promise<void> {
  if (child) {
    child.kill('SIGTERM')
    const deadline = Date.now() + 15_000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (child.exitCode === null) child.kill('SIGKILL')
    child = null
  }
  if (fixture?.home.includes('walnut-mail-app-')) {
    await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => undefined)
  }
  fixture = null
}

/**
 * Open the console with the selection already inside the COLLAPSED TAIL.
 *
 * The stored preference is the fixture's documented way in: a label 51 rows down a 64 folder list is
 * where a person who was reading receipts left off, and revealing it has to happen on the first frame
 * rather than after they hunt for it. It also proves the smart rows are not the only thing the pane
 * can open on.
 */
async function openMail(page: Page): Promise<void> {
  await page.addInitScript(([accountId, mailboxId]) => {
    window.localStorage.setItem('walnut.mail.sidebar.v1', JSON.stringify({
      smart: {}, tail: {}, recent: {}, selected: { accountId, mailboxId },
    }))
  }, [A, TAIL_MAILBOX])
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-accounts-pane')).toContainText(A_NAME, { timeout: 90_000 })
  await expect(page.getByTestId('mail-accounts-pane')).toContainText(B_NAME, { timeout: 60_000 })
  // The remembered row is selected and visible, not hidden behind its own collapse row.
  const remembered = folderRow(page, TAIL_MAILBOX)
  await expect(remembered).toBeVisible({ timeout: 60_000 })
  await expect(remembered).toHaveClass(/active/)
}

function folderRow(page: Page, mailboxId: string): Locator {
  return page.locator(`.mail-accounts-pane .mail-mailbox[data-mailbox-id="${mailboxId}"]`)
}

/**
 * One account's own folder row, inside that account's SECTION.
 *
 * Two reasons it is this specific: the accounts spell the same roles with ids that differ only in
 * case (`INBOX` against `inbox`), and an expanded smart row draws a child carrying the same
 * (account, mailbox) pair, so anything looser matches two rows in two different places.
 */
function accountFolderRow(page: Page, accountId: string, mailboxId: string): Locator {
  return page.locator(
    `.mail-accounts-pane .mail-account[data-account-id="${accountId}"] .mail-mailbox[data-mailbox-id="${mailboxId}"]`,
  )
}

/** A smart row, by the role it stands for. The pane draws these before the account sections. */
function smartRow(page: Page, role: 'inbox' | 'sent' | 'drafts'): Locator {
  return page.locator(`.mail-accounts-pane .mail-mailbox.smart[data-smart="${role}"]`)
}

/** A badge's text, or an empty string when the row has no badge (which is what zero looks like). */
async function badgeText(row: Locator): Promise<string> {
  const badge = row.locator('.mail-unread-badge')
  if (await badge.count() === 0) return ''
  return ((await badge.first().textContent()) ?? '').trim()
}

/** The app sidebar's own Mail badge: every account's unread inbox mail, one number. */
function appBadge(page: Page): Locator {
  return page.getByTestId('sidebar-core-app-mail').locator('.notification-badge-count')
}

function headerUnread(page: Page): Locator {
  return page.getByTestId('mail-unread-filter')
}

async function shoot(target: Locator | Page, step: string): Promise<string> {
  const engine = test.info().project.name
  const path = `${SHOT_DIR}/${engine}-${step}.png`
  await target.screenshot({ path })
  return path
}

function rows(page: Page): Locator {
  return page.getByTestId('mail-row')
}

/** A row of the merged list, by the pair that identifies it. Never by the id alone. */
function rowFor(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(
    `[data-testid="mail-row"][data-account-id="${accountId}"][data-message-id="${messageId}"]`,
  )
}

function smartChild(page: Page, accountId: string): Locator {
  return page.locator(`[data-testid="mail-smart-child"][data-account-id="${accountId}"]`)
}

/**
 * Drop the transport stubs before the page goes away: the cases that mock a failure keep their handler
 * installed while the console goes on polling, so one can be inside `route.fetch()` when the page
 * closes and throw from a test that has already passed every assertion.
 */
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.describe('the merged lists at production density', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    await startFixture()
  })

  test.afterAll(async () => { await stopFixture() })

  test('All Inboxes is one query, one set of numbers, and one row per message', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const queries: string[] = []
    const posts: string[] = []
    /** Every folder a `/mailboxes/fetch` named, as `account/mailbox`. */
    const fetched: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (request.method() === 'GET' && url.includes('/api/plugins/mail/messages?')) queries.push(url)
      if (request.method() === 'POST' && url.includes('/api/plugins/mail/')) posts.push(url)
      if (request.method() === 'POST' && url.includes('/api/plugins/mail/mailboxes/fetch')) {
        const body = request.postDataJSON() as { accountId?: string; mailboxId?: string } | null
        fetched.push(`${body?.accountId ?? ''}/${body?.mailboxId ?? ''}`)
      }
    })
    const shots: string[] = []

    await openMail(page)
    // The remembered tail folder's own page, so nothing is in flight when the count below starts.
    await expect.poll(() => rows(page).count(), { timeout: 90_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(500)

    // ── C1: one merged query, and no per-account page beside it ──
    queries.length = 0
    await smartRow(page, 'inbox').click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE, { timeout: 90_000 })
    await page.waitForTimeout(1000)
    expect(queries, `one GET /messages for the merged page, got:\n${queries.join('\n')}`).toHaveLength(1)
    const merged = decodeURIComponent(queries[0]!)
    expect(merged, 'the merged page is asked for by ROLE').toContain('scope=role:inbox')
    expect(merged, 'a merged query names no account').not.toContain('account=')

    // ── C11: the badge and the header are the same string, from the same mailbox rows ──
    const badge = await badgeText(smartRow(page, 'inbox'))
    expect(badge, 'the smart badge is the exact sum of the inbox rows').toBe(String(DECLARED_UNREAD))
    await expect(page.locator('.mail-list-section-name')).toHaveText('All Inboxes')
    await expect(headerUnread(page)).toHaveText(`${badge} unread`)
    await expect(appBadge(page)).toHaveText(badge)
    // Opening the group is a local state change: the children's numbers are already in the rows.
    queries.length = 0
    await page.locator('[data-testid="mail-smart-twist"][data-smart="inbox"]').click()
    await expect(smartChild(page, B)).toBeVisible()
    expect(queries, 'expanding a smart row asks the server for nothing').toHaveLength(0)
    expect(await badgeText(smartChild(page, B)), "the child badge is that account's own number")
      .toBe(String(DECLARED_UNREAD))
    // Visible FIRST: `badgeText` answers '' for a row that is not there at all, and this account's
    // inbox really does hold nothing unread, so the empty string has to be about the badge.
    await expect(smartChild(page, A)).toBeVisible()
    expect(await badgeText(smartChild(page, A)), 'nothing unread means no badge at all').toBe('')
    shots.push(await shoot(page.locator('.mail-console'), 'all-inboxes'))

    // ── C58: the third number, and the sentence that explains it ──
    // The provider declares 7 unread in a folder whose cached rows hold 18. Both are real. With the
    // filter ON the chip counts the rows under it and its title says where that number came from,
    // while the sidebar keeps the provider's figure: the two disagreeing SILENTLY is the bug.
    // The sentence is ON SCREEN before anything is clicked (F3, C58). The chip's title used to be the
    // only explanation, and a title attribute never renders: three unread numbers on one screen (the
    // badge, the chip, the dots on the rows) with no way to reconcile them is the report this answers.
    await expect(page.getByTestId('mail-unread-gap')).toHaveText(
      `These folders report ${DECLARED_UNREAD} unread and ${CACHED_UNREAD} of the messages`
      + ' loaded here are unread.',
    )
    // And the count chip says, in one visible word, that its figure is the size of the folders rather
    // than the length of this list: `Load older` cannot reach 62,972.
    await expect(page.getByTestId('mail-list-count-word')).toHaveText('total')
    await headerUnread(page).click()
    await expect(rows(page)).toHaveCount(CACHED_UNREAD, { timeout: 60_000 })
    await expect(headerUnread(page)).toHaveText(`${CACHED_UNREAD} unread · showing unread only`)
    // With the filter on the chip counts the rows under it, so there is nothing left to explain.
    await expect(page.getByTestId('mail-unread-gap')).toHaveCount(0)
    await expect(headerUnread(page)).toHaveAttribute('data-loaded', 'true')
    await expect(headerUnread(page)).toHaveAttribute('title', /Counted from the messages loaded so far/)
    expect(await badgeText(smartRow(page, 'inbox')), 'the sidebar keeps the mailbox rows\' number')
      .toBe(String(DECLARED_UNREAD))
    expect(
      await page.locator('[data-testid="mail-row"][data-unread="false"]').count(),
      'every row under it is unread',
    ).toBe(0)
    shots.push(await shoot(page.locator('.mail-list-pane'), 'unread-filter-gap'))
    await headerUnread(page).click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
    await expect(headerUnread(page)).toHaveText(`${DECLARED_UNREAD} unread`)

    // ── C30 and C60: the row says which ACCOUNT, never which mailbox ──
    await expect(page.locator('.mail-row-mailbox'), 'the mailbox id slot is gone').toHaveCount(0)
    const labels = page.getByTestId('mail-row-account')
    await expect(labels).toHaveCount(PAGE_SIZE)
    // A MARK, not the name (round 3, N2): the name chip took more width than the sender and was itself
    // ellipsised on 19 of 50 rows, mid domain for an account whose display name is its address. One
    // letter cannot truncate; the whole identity is on the title, and the two accounts get two tones.
    expect([...new Set(await labels.allTextContents())].sort()).toEqual(['H', 'M'])
    const marinaMark = rowFor(page, B, 'inbox:1:1000').getByTestId('mail-row-account')
    await expect(marinaMark).toHaveAttribute('title', `${B_NAME} (${B_ADDRESS})`)
    await expect(marinaMark).toHaveAttribute('aria-label', `Account ${B_NAME}`)
    const tones = [...new Set(await labels.evaluateAll(
      (marks) => marks.map((mark) => mark.getAttribute('data-tone')),
    ))]
    expect(tones.length, 'two accounts, two tones').toBe(2)
    const cut = await labels.evaluateAll(
      (marks) => marks.filter((mark) => mark.scrollWidth - mark.clientWidth > 1).length,
    )
    expect(cut, 'a one glyph mark is never clipped').toBe(0)
    const listText = await page.locator('.mail-rows').innerText()
    expect(listText, "B's 90 character sent folder id never reaches a row").not.toContain('-segment')
    expect(listText, 'nor does any other mailbox id').not.toContain('harbour/label/')
    // It took the mailbox slot's place: in the row's title line, ahead of the time.
    const order = await rows(page).first().evaluate((row) => (
      Array.from(row.querySelector('.mail-row-top')?.children ?? []).map((kid) => String(kid.className))
    ))
    const at = (name: string) => order.findIndex((one) => String(one).includes(name))
    expect(at('mail-row-account'), 'the account label is in the title line').toBeGreaterThanOrEqual(0)
    expect(at('mail-row-account'), 'and it comes before the time').toBeLessThan(at('mail-row-time'))

    // ── C29: the same message id in two accounts is two messages ──
    // Page two, so both copies are certainly on screen. It is also where a `known` set keyed on the
    // id alone silently drops one of them.
    await page.getByTestId('mail-load-older').click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE * 2, { timeout: 60_000 })
    const shared = page.locator('[data-testid="mail-row"][data-message-id="shared-8042"]')
    await expect(shared, 'both accounts keep their copy of the shared id').toHaveCount(2)
    const mine = rowFor(page, B, 'shared-8042')
    await expect(mine).toHaveAttribute('data-unread', 'true')

    // ── C26: the four numbers move together ──
    await mine.click()
    await expect(page.getByTestId('mail-reader-subject')).toContainText('marina copy', { timeout: 60_000 })
    await expect(mine, 'only the opened row is selected').toHaveClass(/selected/)
    await expect(rowFor(page, A, 'shared-8042'), "and never the other account's copy of that id")
      .not.toHaveClass(/selected/)
    const dropped = String(DECLARED_UNREAD - 1)
    await expect(headerUnread(page)).toHaveText(`${dropped} unread`, { timeout: 30_000 })
    expect(await badgeText(smartRow(page, 'inbox'))).toBe(dropped)
    expect(await badgeText(smartChild(page, B))).toBe(dropped)
    await expect(appBadge(page)).toHaveText(dropped)
    shots.push(await shoot(page.locator('.mail-console'), 'read-in-merged-list'))

    // ── C27: a provider that refuses the flag puts all four back, and says nothing globally ──
    await page.route('**/api/plugins/mail/messages/*/*/read', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unsupported', message: 'this fixture refuses the flag' } }),
    }))
    const refused = page.locator('[data-testid="mail-row"][data-account-id="' + B + '"][data-unread="true"]').first()
    const refusedId = await refused.getAttribute('data-message-id')
    await refused.click()
    await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 60_000 })
    await expect(rowFor(page, B, refusedId!), 'the row stays unread').toHaveAttribute('data-unread', 'true', { timeout: 30_000 })
    await expect(headerUnread(page)).toHaveText(`${dropped} unread`)
    expect(await badgeText(smartRow(page, 'inbox'))).toBe(dropped)
    expect(await badgeText(smartChild(page, B))).toBe(dropped)
    await expect(appBadge(page)).toHaveText(dropped)
    await expect(page.locator('.mail-inline-error'), 'a refused flag is not a global failure').toHaveCount(0)
    await page.unroute('**/api/plugins/mail/messages/*/*/read')

    // ── C34: a failed page keeps the rows and the sidebar, and says so inline ──
    const held = await rows(page).count()
    await page.route('**/api/plugins/mail/messages?*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'the fixture refused this page' } }),
    }))
    await page.getByTestId('mail-load-older').click()
    await expect(page.locator('.mail-inline-error')).toBeVisible({ timeout: 30_000 })
    expect(await rows(page).count(), 'the rows already on screen stay').toBe(held)
    expect(await badgeText(smartRow(page, 'inbox')), 'the badges come from the mailbox rows, not this page')
      .toBe(dropped)
    await expect(appBadge(page)).toHaveText(dropped)
    shots.push(await shoot(page.locator('.mail-list-pane'), 'failed-page-keeps-rows'))
    await page.unroute('**/api/plugins/mail/messages?*')

    // ── C33: an empty merged list, and the button that is honest about what it can ask for ──
    await page.route('**/api/plugins/mail/messages?*', async (route) => {
      const asked = new URL(route.request().url())
      if (asked.searchParams.get('scope') !== 'role:inbox') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: [], nextBefore: null }),
      })
    })
    await accountFolderRow(page, A, 'INBOX').click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-smart-empty')).toHaveText('No mail in these inboxes yet.', { timeout: 60_000 })

    // Now with one of the participating inboxes never fetched, which is the state a fresh install is
    // in for most of its folders. Re-read from the server, because that is where `lastSyncAt` lives.
    await page.route('**/api/plugins/mail/mailboxes?*', async (route) => {
      const answer = await route.fetch()
      const body = await answer.json() as { mailboxes?: Array<Record<string, unknown>> }
      for (const row of body.mailboxes ?? []) if (row.role === 'inbox') delete row.lastSyncAt
      return route.fulfill({ status: answer.status(), contentType: 'application/json', body: JSON.stringify(body) })
    })
    await openMail(page)
    await smartRow(page, 'inbox').click()
    const unfetched = page.getByTestId('mail-smart-unfetched')
    await expect(unfetched).toContainText('Walnut has not fetched every inbox yet.', { timeout: 60_000 })
    posts.length = 0
    fetched.length = 0
    await unfetched.getByTestId('mail-smart-refresh').click()
    await expect.poll(() => posts.filter((one) => one.includes('/mail/refresh')).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    // Refresh polls the inboxes the merged list is made of first (each a real folder), and never the
    // smart row itself: that id is not a folder any provider could fetch.
    expect(fetched.filter((one) => one.includes('__smart_') || one.endsWith('/')), 'a smart row is not a folder to fetch')
      .toEqual([])
    console.log(`refresh polled first: ${fetched.join(', ')}`)
    expect(fetched.length, 'one poll per inbox on screen, before the full refresh').toBe(new Set(fetched).size)
    shots.push(await shoot(page.locator('.mail-list-pane'), 'smart-empty-unfetched'))
    await page.unroute('**/api/plugins/mail/mailboxes?*')
    await page.unroute('**/api/plugins/mail/messages?*')

    expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
    console.log(`merged inbox screenshots:\n${shots.join('\n')}`)
  })

  test('All Drafts is every account, and the identity is on screen in both panes', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const shots: string[] = []

    await openMail(page)

    // ── C59, first half: the reader says which account this mail is in ──
    await smartRow(page, 'inbox').click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE, { timeout: 90_000 })
    await rowFor(page, B, 'inbox:1:1000').click()
    const readerAccount = page.getByTestId('mail-reader-account')
    await expect(readerAccount).toHaveText(B_NAME, { timeout: 60_000 })
    await expect(readerAccount).toHaveAttribute('title', B_ADDRESS)
    await rowFor(page, A, 'INBOX:1:1000').click()
    await expect(readerAccount).toHaveText(A_NAME, { timeout: 60_000 })
    await expect(readerAccount).toHaveAttribute('title', A_ADDRESS)
    shots.push(await shoot(page.locator('.mail-reader-head'), 'reader-identity'))

    // One draft per account, each written from that account's own inbox, so the merged view has two
    // groups in its first half.
    await writeDraft(page, accountFolderRow(page, A, 'INBOX'), A_NAME, A_ADDRESS, A_DRAFT)
    await writeDraft(page, accountFolderRow(page, B, 'inbox'), B_NAME, B_ADDRESS, B_DRAFT)

    // ── C48: the structure, and a badge a person can check by counting ──
    // The badge is the FIRST SECTION: the two written here. It used to add the providers' Drafts folders
    // as their mailbox rows declare them, and a folder's declared size counts drafts outside this cache's
    // retention window: on the real install that made a badge of 51 sit over sections adding up to 8.
    const draftsBadge = smartRow(page, 'drafts').locator('.mail-unread-badge')
    await expect(draftsBadge).toHaveText('2', { timeout: 30_000 })
    await smartRow(page, 'drafts').click()
    await expect(page.locator('.mail-list-section-name')).toHaveText('All Drafts', { timeout: 60_000 })
    const written = page.locator('[data-testid="mail-drafts-group"][data-group="written-here"]')
    await expect(written).toHaveCount(2, { timeout: 60_000 })
    await expect(written.filter({ hasText: A_NAME })).toHaveCount(1)
    await expect(written.filter({ hasText: B_NAME })).toHaveCount(1)
    const counted = await written.locator('.mail-rows-group-count').allTextContents()
    expect(counted.map(Number).reduce((sum, one) => sum + one, 0), 'two written here').toBe(2)
    // The badge IS that sum, which is the point of it: a person can count the first section and check it.
    expect(counted.map(Number).reduce((sum, one) => sum + one, 0)).toBe(2)
    await expect(page.getByTestId('mail-draft-row'), 'and the rows are really there').toHaveCount(2)
    // Then the accounts that really keep a Drafts folder on the server, one group each.
    const onServer = page.locator('[data-testid="mail-drafts-group"][data-group="on-the-server"]')
    await expect(onServer).toHaveCount(2)
    await expect(onServer.first()).toContainText('On the server')
    // Every group counted adds up to the HEADER, so a person can check that number by counting rows
    // instead of trusting it. The header describes the whole view; the badge describes section one.
    const allGroups = await page.locator('[data-testid="mail-drafts-group"] .mail-rows-group-count')
      .allTextContents()
    expect(allGroups.map(Number).reduce((sum, one) => sum + one, 0), 'the header, counted').toBe(5)
    await expect(page.locator('.mail-list-section .mail-list-section-count')).toHaveText('5')
    shots.push(await shoot(page.locator('.mail-list-pane'), 'all-drafts'))

    // ── C49: editing and sending from here uses the DRAFT's own account ──
    const draftRow = page.locator('[data-testid="mail-draft-row"]', { hasText: B_DRAFT })
    await expect(draftRow).toHaveCount(1)
    await draftRow.click()
    const composerAccount = page.getByTestId('mail-compose-account')
    await expect(composerAccount).toHaveText(B_NAME, { timeout: 30_000 })
    await expect(composerAccount).toHaveAttribute('title', B_ADDRESS)
    shots.push(await shoot(page.locator('.mail-compose-card-head'), 'composer-identity'))
    await page.getByTestId('mail-compose-send').click()
    await expect(page.getByTestId('mail-send-headline')).toContainText('Sent', { timeout: 60_000 })
    // Both numbers come off the same count, so they drop together: the merged badge goes from two written
    // here to one, and the account that sent has nothing written here any more (its provider folder is
    // still listed in the view, under its own heading).
    await expect(draftsBadge).toHaveText('1', { timeout: 30_000 })
    await expect(
      page.locator(`[data-testid="mail-drafts-row"][data-account-id="${B}"]`).getByTestId('mail-drafts-count'),
      "the sent account's own row drops the draft that left",
    ).toHaveCount(0)
    await expect(
      page.locator(`[data-testid="mail-drafts-row"][data-account-id="${A}"]`).getByTestId('mail-drafts-count'),
      'and the other account is untouched: the one it has written here',
    ).toHaveText('1')

    // ── C59, second half: the drafts chip opens All Drafts and hijacks nothing ──
    await page.getByTestId('mail-composer-close').click()
    await smartRow(page, 'inbox').click()
    await expect(rows(page)).toHaveCount(PAGE_SIZE, { timeout: 60_000 })
    // Reading one of A's messages first, because the compose identity now follows the account you were
    // just reading or last sent from (F5): the chip counts THAT account's other drafts, and the one
    // written here belongs to A.
    await rowFor(page, A, 'INBOX:1:1000').click()
    await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('mail-compose-new').click()
    await expect(page.getByTestId('mail-compose-account')).toHaveText(A_NAME, { timeout: 30_000 })
    const chip = page.getByTestId('mail-compose-drafts-chip')
    await expect(chip).toHaveText('1 draft', { timeout: 30_000 })
    await chip.click()
    await expect(smartRow(page, 'drafts')).toHaveClass(/active/, { timeout: 30_000 })
    await expect(
      page.locator('.mail-accounts-pane [data-testid="mail-drafts-row"].active'),
      'never a per-account Drafts row the person did not ask for',
    ).toHaveCount(0)
    await page.getByTestId('mail-compose-discard').click()
    // An empty new message is discarded without a question; the dialog only appears for typed text.
    const confirm = page.locator('.app-modal-btn.primary')
    if (await confirm.count()) await confirm.first().click()
    await expect(page.getByTestId('mail-composer')).toHaveCount(0, { timeout: 30_000 })

    expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
    console.log(`all drafts screenshots:\n${shots.join('\n')}`)
  })
})

/**
 * Paste into a chip field.
 *
 * A dispatched `paste` carrying a DataTransfer is the only way to exercise the handler that splits it:
 * Meta+V needs a populated system clipboard, which a headless run cannot promise.
 */
async function pasteInto(field: Locator, text: string): Promise<void> {
  await field.click()
  await field.evaluate((element, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

/** One draft on ONE account, started from that account's own folder row so the identity is certain. */
async function writeDraft(
  page: Page,
  from: Locator,
  name: string,
  address: string,
  subject: string,
): Promise<void> {
  await from.click()
  const compose = page.getByTestId('mail-compose-new')
  await expect(compose).toBeEnabled({ timeout: 60_000 })
  await compose.click()
  await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mail-compose-account')).toHaveText(name, { timeout: 30_000 })
  await expect(page.getByTestId('mail-compose-account')).toHaveAttribute('title', address)
  await pasteInto(page.getByTestId('mail-compose-to'), 'desk@example.invalid')
  await page.getByTestId('mail-compose-subject').fill(subject)
  await page.getByTestId('mail-compose-body').fill('Two sets, and the office keeps the spare.')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  await page.getByTestId('mail-composer-close').click()
  await expect(page.getByTestId('mail-composer')).toHaveCount(0, { timeout: 30_000 })
}

/**
 * The same view with one account that keeps NO drafts folder on its server.
 *
 * Its own fixture run, because the shape is decided when the provider registers. What it proves is
 * a silence: that account appears once, in the first half, and nothing on screen says "server" about
 * it, which is exactly what its per-account Drafts row does today.
 */
test.describe('an account with no drafts folder on its server', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await startFixture({ PW_MAIL_DENSE_NO_DRAFTS: '1' })
  })

  test.afterAll(async () => { await stopFixture() })

  test('appears once, in the first half, with no mention of a server', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await openMail(page)
    await writeDraft(page, accountFolderRow(page, B, 'inbox'), B_NAME, B_ADDRESS, B_DRAFT)
    await smartRow(page, 'drafts').click()
    await expect(page.locator('.mail-list-section-name')).toHaveText('All Drafts', { timeout: 60_000 })

    const groups = page.getByTestId('mail-drafts-group')
    await expect(groups.filter({ hasText: B_NAME }), 'one group, and it is the first half')
      .toHaveCount(1)
    await expect(groups.filter({ hasText: B_NAME })).toHaveAttribute('data-group', 'written-here')
    await expect(
      groups.filter({ hasText: B_NAME }).filter({ hasText: 'server' }),
      'nothing says "server" about an account that has no such folder',
    ).toHaveCount(0)
    // The other account still keeps one, so the second half is drawn for it and only for it.
    await expect(page.locator('[data-testid="mail-drafts-group"][data-group="on-the-server"]'))
      .toHaveCount(1)
    await expect(page.locator('[data-testid="mail-drafts-group"][data-group="on-the-server"]'))
      .toContainText(A_NAME)
    const shot = await shoot(page.locator('.mail-list-pane'), 'all-drafts-no-server-folder')

    expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
    console.log(`no-drafts-folder screenshot:\n${shot}`)
  })
})
