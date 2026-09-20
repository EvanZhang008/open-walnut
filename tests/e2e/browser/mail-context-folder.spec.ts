/**
 * The LEFT pane's right-click menus, driven as a person drives them (C34, C35, C36, C37, C38, C39,
 * C40, C58, C63, C64, C71).
 *
 * The reported complaint was that a folder row has no menu at all, so most of what is graded here is
 * that the gesture lands on the WHOLE LINE and that it changes nothing else:
 *
 *   1. A right-click does not open the row. The selection stays where it was and the row that was
 *      right-clicked is never read, because opening a folder is what replaces the message list and
 *      this menu exists so that "fetch that one" does not have to (C34).
 *   2. The menu acts on the row it opened over, not on the selection: the fetch's POST body carries
 *      the right-clicked pair while a different folder is on screen (C35), and in a merged list it
 *      carries the CHILD's own account rather than the first one the pane lists (C39, C58).
 *   3. Each of the fetch's answers gets its OWN sentence, on the row and in the pane, and the three
 *      that are answers rather than failures never read as "Walnut could not fetch" (C36, C71).
 *   4. Those answers are per FOLDER: an unrelated account's sync does not wipe one (C63), and two
 *      fetches at once are two states, with the slow one overwriting nothing (C64).
 *   5. The rows that deliberately keep the BROWSER's menu keep it (C40).
 *
 * The DENSE fixture, which is production density: two accounts, 64 folders against 6, the same roles
 * under different ids in each account, and all three smart rows visible at once (the child cases need
 * that). Five of the six fetch answers are canned at the socket with `page.route`, in the plugin's own
 * `MailboxFetchResult` shape: `stopped` and `unknown-mailbox` are the plugin's internal bookkeeping and
 * `running` is a ten second deadline, so producing them for real would mean sleeping inside the sync
 * queue and holding every other folder behind it. The sixth (`fetched`) travels the real path.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { HARBOUR, MARINA, MailFixtureServer, PANE, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-context-folder/pw'
const FETCH_URL = '**/api/plugins/mail/mailboxes/fetch'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  // The hook's own budget is 30s by default, and a cold fixture boot is ~20s idle, ~70s under load.
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  port = (await server.start()).port
})

test.afterAll(async () => { await server.stop() })

/** The `<li>` that wraps a folder row: the whole line, which is what holds the gesture. */
function folderLine(page: Page, accountId: string, mailboxId: string): Locator {
  return page.locator(
    `${PANE} .mail-account[data-account-id="${accountId}"] li:has(> .mail-mailbox[data-mailbox-id="${mailboxId}"])`,
  )
}

function menu(page: Page, testId = 'mail-folder-ctx-menu'): Locator {
  return page.getByTestId(testId)
}

/** The labels a person reads, in order. The info heading and the dividers are not items. */
function itemLabels(page: Page, testId = 'mail-folder-ctx-menu'): Promise<string[]> {
  return menu(page, testId).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
}

async function clickItem(page: Page, label: string, testId = 'mail-folder-ctx-menu'): Promise<void> {
  await menu(page, testId).locator('[role="menuitem"]', { hasText: label }).first().click()
  await expect(menu(page, testId)).toHaveCount(0)
}

/** Which folder the pane says is selected. One row, or none. */
function activeMailboxId(page: Page): Promise<string | null> {
  return page.locator(`${PANE} .mail-mailbox.active`).first().getAttribute('data-mailbox-id')
}

function paneNotes(page: Page): Locator {
  return page.getByTestId('mail-folder-fetch-note')
}

function paneNote(page: Page, mailboxId: string): Locator {
  return page.locator(`[data-testid="mail-folder-fetch-note"][data-mailbox-id="${mailboxId}"]`)
}

function fetchDot(page: Page, accountId: string, mailboxId: string): Locator {
  return folderRow(page, accountId, mailboxId).getByTestId('mail-mailbox-fetch-dot')
}

/** A sentence used as a pattern: folder names here contain no metacharacters, but ids can. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One canned answer for one folder, in the plugin's own result shape. */
interface Canned {
  status?: number
  body?: Record<string, unknown>
  /** Hold the answer back this long, which is how two fetches overlap on purpose. */
  delayMs?: number
}

/**
 * Answer `/mailboxes/fetch` from a table keyed by mailbox id, and record every body that was sent.
 *
 * A folder with no entry in the table travels to the plugin untouched, which is what keeps the
 * `fetched` case real.
 */
async function cannedFetches(
  page: Page,
  table: Record<string, Canned>,
): Promise<{ accountId?: string, mailboxId?: string }[]> {
  const bodies: { accountId?: string, mailboxId?: string }[] = []
  await page.route(FETCH_URL, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { accountId?: string, mailboxId?: string }
    bodies.push(body)
    const canned = table[body.mailboxId ?? '']
    if (!canned) { await route.continue(); return }
    if (canned.delayMs) await new Promise((wake) => { setTimeout(wake, canned.delayMs) })
    await route.fulfill({
      status: canned.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(canned.body ?? { ok: true, fetched: true, added: 0, updated: 0 }),
    })
  })
  return bodies
}

/** Both accounts have landed, which is when the pane draws its folders and its smart group. */
async function paneReady(page: Page): Promise<void> {
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveCount(1, { timeout: 120_000 })
  await expect(folderRow(page, MARINA, 'inbox')).toHaveCount(1, { timeout: 120_000 })
}

test('C34: a right-click opens a menu and changes nothing else', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  // The selection is put on the inbox by CLICKING it, so the "before" is a real selection.
  await folderRow(page, HARBOUR, 'INBOX').click()
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveClass(/active/)
  await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 120_000 })

  // Any page read for the folder about to be right-clicked, counted. Scoped to THAT folder rather
  // than to every read: a background sync re-reads the OPEN folder legitimately, and what is graded
  // here is that the row under the pointer was not opened.
  let archiveReads = 0
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/api/plugins/mail/messages?') && url.includes('mailbox=Archive')) archiveReads += 1
  })

  await folderLine(page, HARBOUR, 'Archive').click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  expect(await itemLabels(page)).toEqual([
    'Open this folder',
    'Fetch this folder now',
    'Show only unread in this folder',
    'Show all folders in this account',
  ])
  // The heading names the folder AND its account, because two accounts are listed.
  await expect(menu(page).locator('.wn-context-menu-info')).toHaveText('Archive · Harbour mail')

  expect(await activeMailboxId(page), 'the selection did not move').toBe('INBOX')
  await expect(folderRow(page, HARBOUR, 'Archive')).not.toHaveClass(/active/)
  await expect(folderRow(page, HARBOUR, 'Archive')).not.toHaveAttribute('aria-current', 'true')
  expect(archiveReads, 'the right-clicked folder was never read').toBe(0)
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'chromium-folder-menu')}`)

  // Escape belongs to the primitive; this only proves the menu is dismissible and left no mark.
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await activeMailboxId(page)).toBe('INBOX')
})

test('C35: the fetch names the right-clicked pair, not the selected one', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  const bodies = await cannedFetches(page, { Spam: {} })
  await folderRow(page, HARBOUR, 'INBOX').click()
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveClass(/active/)

  await folderLine(page, HARBOUR, 'Spam').click({ button: 'right' })
  await clickItem(page, 'Fetch this folder now')
  // Filtered to the folder under test: the console also fetches a SELECTED folder that came back
  // empty by itself, and that automatic ask is not what this grades.
  await expect.poll(() => bodies.filter((one) => one.mailboxId === 'Spam').length, { timeout: 60_000 }).toBe(1)
  expect(bodies.filter((one) => one.mailboxId === 'Spam')[0]).toEqual({ accountId: HARBOUR, mailboxId: 'Spam' })
  // Still reading the inbox: the fetch went somewhere else entirely.
  expect(await activeMailboxId(page)).toBe('INBOX')
})

/**
 * The six answers, read off the row that asked and off the pane line beside it.
 *
 * One page for all six: the answers are per FOLDER, so six rows carry six different states in one
 * window, which is exactly what a single shared slot got wrong.
 */
test('C36 and C71: every fetch answer says its own sentence', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  await cannedFetches(page, {
    Spam: { status: 202, body: { ok: true, fetched: false, running: true } },
    Trash: { body: { ok: true, fetched: false, reason: 'unknown-mailbox' } },
    Sent: { body: { ok: true, fetched: false, reason: 'stopped' } },
    junk: { body: { ok: true, fetched: false, reason: 'failed', detail: 'The folder refused to open.' } },
    bin: { body: { ok: true, fetched: false, reason: 'replica' } },
  })

  const cases = [
    // No entry in the table: this one travels the real path and really fetches.
    { account: HARBOUR, mailboxId: 'Archive', sentence: 'Fetched Archive.', dot: null },
    { account: HARBOUR, mailboxId: 'Spam', sentence: 'Still fetching Spam.', dot: 'running' },
    { account: HARBOUR, mailboxId: 'Trash', sentence: 'Trash is no longer on the server.', dot: 'failed' },
    { account: HARBOUR, mailboxId: 'Sent', sentence: 'Sent is no longer on the server.', dot: 'failed' },
    {
      account: MARINA,
      mailboxId: 'junk',
      sentence: 'Walnut could not fetch Junk. The folder refused to open.',
      dot: 'failed',
    },
    { account: MARINA, mailboxId: 'bin', sentence: 'This copy of Walnut only reads mail.', dot: 'failed' },
  ]

  for (const one of cases) {
    await folderLine(page, one.account, one.mailboxId).click({ button: 'right' })
    await clickItem(page, 'Fetch this folder now')
    await expect(paneNote(page, one.mailboxId)).toHaveText(one.sentence, { timeout: 60_000 })
    if (one.dot === null) {
      // A fetch that worked leaves no state behind: the store's record is removed once the rows
      // landed, and the sentence above is the only thing that has to say so.
      await expect(fetchDot(page, one.account, one.mailboxId)).toHaveCount(0)
    } else {
      await expect(fetchDot(page, one.account, one.mailboxId)).toHaveAttribute('data-state', one.dot)
      // The words are on the row too, for the case where the pane line has already been replaced. An
      // ANSWER goes into the hover text (the row keeps its role name first); a fetch that is still
      // running has no answer yet, so its dot carries the sentence and the hover text is untouched.
      const rowWords = one.dot === 'failed'
        ? folderRow(page, one.account, one.mailboxId)
        : fetchDot(page, one.account, one.mailboxId)
      const attribute = one.dot === 'failed' ? 'title' : 'aria-label'
      await expect(rowWords).toHaveAttribute(attribute, new RegExp(escapeRegExp(one.sentence)))
    }
    // G13, checked while this answer is still on screen: only the one worth pressing again may say
    // Walnut could not. The pane keeps the three newest sentences, so this cannot wait for the end.
    if (one.mailboxId !== 'junk') {
      await expect(paneNote(page, one.mailboxId)).not.toContainText('Walnut could not')
    } else {
      await expect(paneNote(page, one.mailboxId)).toContainText('Walnut could not fetch Junk.')
    }
  }

  // Three sentences, not six: a note is a note and not a log, and each of them names its own folder.
  await expect(paneNotes(page)).toHaveCount(3)
  await expect(paneNote(page, 'bin')).toHaveText('This copy of Walnut only reads mail.')
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-fetch-answers')}`)
})

test('C63: another account syncing does not wipe this folder\'s answer', async ({ page }) => {
  // The socket is proxied so a frame can be injected on the real client path, which is how the
  // console learns that an account finished syncing.
  let inject: ((frame: string) => void) | null = null
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => ws.send(message))
    inject = (frame) => ws.send(frame)
  })
  await openMail(page, port)
  await paneReady(page)
  await cannedFetches(page, {
    Trash: { body: { ok: true, fetched: false, reason: 'failed', detail: 'The folder refused to open.' } },
  })

  await folderLine(page, HARBOUR, 'Trash').click({ button: 'right' })
  await clickItem(page, 'Fetch this folder now')
  await expect(paneNote(page, 'Trash')).toContainText('Walnut could not fetch Trash.', { timeout: 60_000 })

  // The OTHER account finishes a sync. `clearRefreshNoteFor` takes the shared refresh note down on
  // exactly this event, which is why a folder's own answer must never live there.
  expect(inject, 'the socket route is installed').not.toBeNull()
  inject!(JSON.stringify({
    type: 'event',
    name: 'plugin:mail:sync-completed',
    data: { accountId: MARINA, mailboxId: 'inbox', added: 1, updated: 0 },
    seq: 1,
  }))
  await page.waitForTimeout(2_000)
  await expect(paneNote(page, 'Trash')).toContainText('Walnut could not fetch Trash.')
  await expect(fetchDot(page, HARBOUR, 'Trash')).toHaveAttribute('data-state', 'failed')
})

test('C64: two fetches at once are two states, and the slow one overwrites nothing', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  await cannedFetches(page, {
    // Held back long enough for a second fetch to start, answer, and be read.
    Trash: { delayMs: 12_000, body: { ok: true, fetched: false, reason: 'unknown-mailbox' } },
    Spam: { body: { ok: true, fetched: false, reason: 'failed', detail: 'The folder refused to open.' } },
  })

  await folderLine(page, HARBOUR, 'Trash').click({ button: 'right' })
  await clickItem(page, 'Fetch this folder now')
  await expect(fetchDot(page, HARBOUR, 'Trash')).toHaveAttribute('data-state', 'fetching')

  // The second fetch starts while the first is still in flight.
  await folderLine(page, HARBOUR, 'Spam').click({ button: 'right' })
  await clickItem(page, 'Fetch this folder now')
  await expect(paneNote(page, 'Spam')).toContainText('Walnut could not fetch Spam.', { timeout: 30_000 })
  // Each row is its own state in the same frame: one has answered, one is still going.
  await expect(fetchDot(page, HARBOUR, 'Spam')).toHaveAttribute('data-state', 'failed')
  await expect(fetchDot(page, HARBOUR, 'Trash')).toHaveAttribute('data-state', 'fetching')
  await expect(paneNote(page, 'Trash')).toHaveText('Fetching Trash…')
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-two-fetches')}`)

  // The late answer lands on its own row and leaves the earlier sentence standing.
  await expect(paneNote(page, 'Trash')).toHaveText('Trash is no longer on the server.', { timeout: 60_000 })
  await expect(paneNote(page, 'Spam')).toContainText('Walnut could not fetch Spam.')
  await expect(paneNotes(page)).toHaveCount(2)
})

test('C37 and C38: the Drafts row and the smart rows offer no fetch', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)

  const draftsLine = page.locator(
    `${PANE} .mail-account[data-account-id="${HARBOUR}"] li:has(> [data-testid="mail-drafts-row"])`,
  )
  await draftsLine.click({ button: 'right' })
  expect(await itemLabels(page)).toEqual(['Open Drafts', 'New message'])
  await expect(menu(page)).toHaveAttribute('aria-label', 'Drafts actions')
  await page.keyboard.press('Escape')

  // Each of the three smart rows, through its own LINE so the chevron is covered too (G10): a menu
  // over most of a line and the browser's over the rest is the complaint this slice started from.
  for (const role of ['inbox', 'sent', 'drafts']) {
    const line = page.locator(
      `${PANE} .mail-smart li:has(.mail-mailbox.smart[data-smart="${role}"]) > .mail-mailbox-line`,
    )
    await expect(line).toHaveCount(1)
    await line.click({ button: 'right' })
    expect(await itemLabels(page, 'mail-smart-ctx-menu'), `the ${role} row`).toEqual([
      'Open this list',
      'Check for new mail',
      'Show accounts in this list',
    ])
    await expect(menu(page, 'mail-smart-ctx-menu')).toHaveAttribute('aria-label', 'Smart mailbox actions')
    await page.keyboard.press('Escape')

    // The chevron, which is a SIBLING button on the same line.
    await line.click({ button: 'right', position: { x: 8, y: 12 } })
    await expect(menu(page, 'mail-smart-ctx-menu'), `the ${role} chevron`).toHaveCount(1)
    expect(await itemLabels(page, 'mail-smart-ctx-menu')).toContain('Open this list')
    await page.keyboard.press('Escape')
  }
})

test('C40: the collapse row, the group heading and the account head keep the browser menu', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  const exempt = [
    page.locator(`${PANE} .mail-tail-row[data-account-id="${HARBOUR}"]`).first(),
    page.getByTestId('mail-smart-head'),
    page.locator(`${PANE} .mail-account[data-account-id="${HARBOUR}"] .mail-account-head`),
  ]
  for (const target of exempt) {
    await expect(target).toHaveCount(1)
    await target.click({ button: 'right' })
    // Neither menu: these rows are not objects, and taking the browser's menu away to offer nothing
    // is worse than letting a person see Reload once.
    await expect(menu(page)).toHaveCount(0)
    await expect(menu(page, 'mail-smart-ctx-menu')).toHaveCount(0)
  }
})

/** Open one smart row's children through its own chevron. */
async function expandSmart(page: Page, role: string): Promise<void> {
  const twist = page.locator(`${PANE} .mail-twist[data-smart="${role}"]`)
  await expect(twist).toHaveCount(1, { timeout: 120_000 })
  if ((await twist.getAttribute('aria-expanded')) !== 'true') await twist.click()
}

function smartChild(page: Page, role: string, accountId: string): Locator {
  return page.locator(
    `${PANE} .mail-smart li:has(.mail-mailbox.smart[data-smart="${role}"])`
    + ` .mail-smart-children li:has(> .mail-mailbox.child[data-account-id="${accountId}"])`,
  )
}

test('C39 and C58: a child acts on its own pair, and All Drafts children are Drafts rows', async ({ page }) => {
  await openMail(page, port)
  await paneReady(page)
  const bodies = await cannedFetches(page, {})

  for (const role of ['inbox', 'sent']) {
    await expandSmart(page, role)
    const row = smartChild(page, role, MARINA)
    await expect(row).toHaveCount(1, { timeout: 60_000 })
    // The id is read off the row rather than written down: this account spells every role differently
    // from the other one, and what is graded is that the MENU carries the row's own id.
    const mailboxId = await row.locator('.mail-mailbox.child').getAttribute('data-mailbox-id')
    expect(mailboxId, `the ${role} child names a folder`).toBeTruthy()

    await row.click({ button: 'right' })
    // No tail switch: the account's own collapse row lives in its own section further down the pane.
    expect(await itemLabels(page)).toEqual([
      'Open this folder',
      'Fetch this folder now',
      'Show only unread in this folder',
    ])
    await clickItem(page, 'Fetch this folder now')
    await expect.poll(() => bodies.filter((one) => one.mailboxId === mailboxId).length, { timeout: 60_000 })
      .toBe(1)
    // The SECOND account of a merged list, which is the one a menu built from the pane's first
    // account would have got wrong.
    expect(bodies.filter((one) => one.mailboxId === mailboxId)[0]?.accountId).toBe(MARINA)
  }

  // An All Drafts child is the reserved pair, so it is a Drafts row and never offers a fetch.
  await expandSmart(page, 'drafts')
  const draftsChild = smartChild(page, 'drafts', MARINA)
  await expect(draftsChild).toHaveCount(1, { timeout: 60_000 })
  await expect(draftsChild.locator('.mail-mailbox.child'))
    .toHaveAttribute('data-mailbox-id', '__walnut_drafts__')
  await draftsChild.click({ button: 'right' })
  expect(await itemLabels(page)).toEqual(['Open Drafts', 'New message'])
  await expect(menu(page)).toHaveAttribute('aria-label', 'Drafts actions')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'chromium-all-drafts-child')}`)
  await page.keyboard.press('Escape')
  // The reserved id never reached the fetch route.
  expect(bodies.some((one) => one.mailboxId === '__walnut_drafts__')).toBe(false)

  // The other child of All Inboxes is still its own pair, not the one above.
  await expandSmart(page, 'inbox')
  const harbour = smartChild(page, 'inbox', HARBOUR)
  const harbourId = await harbour.locator('.mail-mailbox.child').getAttribute('data-mailbox-id')
  await harbour.click({ button: 'right' })
  await clickItem(page, 'Fetch this folder now')
  await expect.poll(() => bodies.filter((one) => one.mailboxId === harbourId).length, { timeout: 60_000 })
    .toBeGreaterThan(0)
  expect(bodies.filter((one) => one.mailboxId === harbourId)[0]?.accountId).toBe(HARBOUR)
})
