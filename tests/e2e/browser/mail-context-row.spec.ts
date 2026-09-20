/**
 * The MESSAGE row's right-click menu, driven as a person drives it (C6-C12, C13-C20, C22-C25, C26,
 * C27, C33, C49, C54, C57, C67-C70, C74, C75, C79).
 *
 * The complaint this menu answers is that the only way to change a row's read flag was to OPEN the
 * row, which marks it read. So the promise being graded is mostly about what does NOT happen:
 *
 *   1. A right-click opens nothing, selects nothing and writes nothing (C6-C9). The menu it opens is
 *      the only one on screen (C10, C11) and the row it opened over is marked in a way that cannot be
 *      read as a selection (C12, C67, C68).
 *   2. The read toggle states what the click would do to THAT row, read from that row's own flags
 *      (C13, C14, C20), and the flip is optimistic in three places at once, with a refusal putting all
 *      three back and saying so about the row by name (C15, C16, C69, C70).
 *   3. An item the provider cannot honour is not drawn (C24); an answer nobody has yet is not a no
 *      (C18); and a row this console flipped stays on an unread page across a sync (C19).
 *   4. Every item acts on the row's OWN account, which is the whole question a merged list asks (C22,
 *      C25).
 *   5. A reply from a row nobody opened quotes the real message, and a body that will not load writes
 *      NO draft (C54), because a draft is saved the moment a composer opens.
 *   6. The browser's own menu stays where it is the better one, which needs a REAL drag selection to
 *      be provable at all (C26, C27, C74, C75).
 *
 * The fixture is `PW_MAIL_CTX=1`: two accounts, one that can mark read and send and one that can do
 * neither, a read row, an unread row and a row that already carries a task.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, PANE, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-context-row/chromium'

/** The two accounts `PW_MAIL_CTX=1` adopts. */
const WRITER = 'fixture:ctx-writer@example.invalid'
const READER = 'inbound:ctx-reader@example.invalid'

/** Writer rows: unread with an html body, unread with a text body, read and already tasked. */
const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'
const LEASE = 'INBOX:1:29'
/** Reader rows: read, and unread with a body the provider refuses. */
const NOTICE = 'INBOX:2:11'

const READ_URL = '**/api/plugins/mail/messages/*/*/read'
const TASK_URL = '**/api/plugins/mail/messages/*/*/task'
const MENU = 'mail-row-ctx-menu'

// One worker, in declaration order, and NOT `serial`: these cases share one install (the read flags
// are the fixture's own server state, which is why each case puts the rows it needs back to unread),
// but a failure in one is not a reason to stop grading the other twenty checks in this file.
test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  // `PW_MAIL_DENSE` is emptied rather than omitted: the helper defaults it on, and two linked
  // providers double every count and put two options in the add-an-account dialog.
  port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
})

test.afterAll(async () => { await server.stop() })

/**
 * Anything the page threw, in this run's own output.
 *
 * A render crash in the mail app shows up here as "the pane never appeared", which is a timeout with
 * no cause attached; the console line is the whole diagnosis.
 */
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => { console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

function menu(page: Page): Locator {
  return page.getByTestId(MENU)
}

/** The words a person reads, in order. The info heading and the dividers are not items. */
function itemLabels(page: Page): Promise<string[]> {
  return menu(page).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
}

function item(page: Page, label: string): Locator {
  return menu(page).locator('[role="menuitem"]', { hasText: label }).first()
}

async function clickItem(page: Page, label: string): Promise<void> {
  await item(page, label).click()
  await expect(menu(page)).toHaveCount(0)
}

function row(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)
}

/** Right-click a row and wait for ITS menu. The row is the whole line in this pane. */
async function openRowMenu(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

/** Into the writer's inbox, with its rows on screen. Every case starts here. */
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
  await expect(row(page, WRITER, KEEPER)).toBeVisible({ timeout: 90_000 })
  await expect(row(page, WRITER, LEASE)).toBeVisible()
}

/**
 * Put a row back to unread, through the menu, so a case that needs unread mail has some.
 *
 * The fixture's read flags are SERVER state and these cases share one install, so a case that marked
 * two rows read leaves the next one with an inbox at zero. Driven through the menu rather than through
 * a seam, because it is the same write the case under test is about.
 */
async function ensureUnread(page: Page, accountId: string, messageId: string): Promise<void> {
  const target = row(page, accountId, messageId)
  if ((await target.getAttribute('data-unread')) === 'true') return
  await openRowMenu(page, accountId, messageId)
  await clickItem(page, 'Mark as unread')
  await expect(target).toHaveAttribute('data-unread', 'true', { timeout: 30_000 })
}

/** The number on a folder row, or 0 when the badge is absent (which is what no unread looks like). */
async function folderBadge(page: Page, accountId: string, mailboxId: string): Promise<number> {
  const badge = folderRow(page, accountId, mailboxId).getByTestId('mail-mailbox-unread')
  if (await badge.count() === 0) return 0
  return Number.parseInt((await badge.innerText()).replace(/[^\d]/g, ''), 10)
}

/** The All Inboxes badge: the sum every account contributes to, and the one the app badge mirrors. */
async function smartBadge(page: Page): Promise<number> {
  const badge = page.locator(`${PANE} .mail-mailbox.smart[data-smart="inbox"]`).getByTestId('mail-smart-unread')
  if (await badge.count() === 0) return 0
  return Number.parseInt((await badge.innerText()).replace(/[^\d]/g, ''), 10)
}

/** Drag across an element's text the way a person does, and report what got selected. */
async function dragAcross(page: Page, target: Locator): Promise<string> {
  const box = (await target.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  for (let at = 4; at <= Math.min(box.width - 2, 160); at += 12) {
    await page.mouse.move(box.x + at, y)
  }
  await page.mouse.up()
  return page.evaluate(() => {
    const selection = window.getSelection()
    return selection && !selection.isCollapsed ? selection.toString() : ''
  })
}

test('C6, C7, C8, C9, C10, C12, C23: a right-click opens the menu and does nothing else', async ({ page }) => {
  await openWriterInbox(page)
  // A real selection to compare against: the reader is holding LEASE when the menu opens over KEEPER.
  await row(page, WRITER, LEASE).click()
  await expect(page.locator('.mail-row.selected')).toHaveAttribute('data-message-id', LEASE)
  await expect(page.getByTestId('mail-reader')).toBeVisible({ timeout: 60_000 })
  // The SUBJECT plus the open pair, not the pane's whole text: a body arrives asynchronously and adds
  // a trailing line while it settles, which is not the pane changing what it is showing.
  const readerBefore = await page.getByTestId('mail-reader-subject').innerText()
  const openedBefore = await page.getByTestId('mail-reader').getAttribute('data-message-id')

  // Every read of a message and every write of a flag, counted.
  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/\/api\/plugins\/mail\/messages\/[^?]+$/.test(url) && request.method() === 'GET') calls.push(`get ${url}`)
    if (url.endsWith('/read')) calls.push(`read ${url}`)
  })

  await openRowMenu(page, WRITER, KEEPER)
  expect(await itemLabels(page)).toEqual([
    'Mark as read',
    'Open message',
    'Reply',
    'Reply all',
    'Forward',
    'Make a task',
    'Find mail from this sender',
    'Copy Walnut link',
  ])
  // The heading is the TARGET, not a group name, and it is not focusable: the first ArrowDown has to
  // land on the read toggle, which is the item the menu exists for.
  const heading = menu(page).locator('.wn-context-menu-info')
  await expect(heading).toHaveText('Keeper Reports · Quarterly keeper report')
  await expect(heading).toHaveAttribute('title', 'Keeper Reports · Quarterly keeper report')
  await page.keyboard.press('ArrowDown')
  await expect(menu(page).locator('.wn-context-menu-item.focused')).toHaveText('Mark as read')

  // Nothing moved: not the selection, not the reader, not the flag, and no request went out.
  await expect(page.locator('.mail-row.selected')).toHaveAttribute('data-message-id', LEASE)
  await expect(row(page, WRITER, KEEPER)).not.toHaveClass(/selected/)
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'true')
  await expect(row(page, WRITER, KEEPER)).not.toHaveAttribute('aria-current', /.*/)
  expect(await page.getByTestId('mail-reader-subject').innerText()).toBe(readerBefore)
  expect(await page.getByTestId('mail-reader').getAttribute('data-message-id')).toBe(openedBefore)
  // Graded on the RIGHT-CLICKED row, and on nothing else reaching the server. Opening LEASE one line
  // above is what marks LEASE read, and the row flips optimistically with the POST behind it, so that
  // write can land inside this window (it does in WebKit under load). The menu's promise is about the
  // row the gesture was on, so a flat zero was grading somebody else's documented write.
  const about = (id: string) => calls.filter((url) => url.includes(encodeURIComponent(id)))
  expect(about(KEEPER), 'a right-click is not a read and not a write').toEqual([])
  expect(calls.filter((url) => !about(LEASE).includes(url)), 'and nothing else went out').toEqual([])
  expect(await page.locator('.wn-context-menu').count(), 'one menu, not one per ancestor').toBe(1)

  // The mark, and its removal. `aria-current` is untouched throughout: this is not a selection.
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-ctx-open', 'true')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'row-menu-open')}`)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(row(page, WRITER, KEEPER)).not.toHaveAttribute('data-ctx-open', /.*/)
})

test('C11: a right-click while a menu is open never leaves two menus', async ({ page }) => {
  await openWriterInbox(page)
  await openRowMenu(page, WRITER, KEEPER)
  // The backdrop owns the next right-click, so a second gesture elsewhere MOVES the menu (or ends it)
  // rather than stacking a second one. Driven through the mouse rather than through the row's
  // locator, because the open menu sits under the cursor and Playwright would refuse a click on an
  // element it covers.
  const target = (await row(page, WRITER, LUNCH).boundingBox())!
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2, { button: 'right' })
  expect(await page.locator('.wn-context-menu').count(), 'never two at once').toBeLessThanOrEqual(1)

  // From a clean slate, the menu belongs to the row the gesture landed on and the mark moved with it.
  await page.keyboard.press('Escape')
  await expect(page.locator('.wn-context-menu')).toHaveCount(0)
  await openRowMenu(page, WRITER, LUNCH)
  expect(await page.locator('.wn-context-menu').count()).toBe(1)
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-ctx-open', 'true')
  await expect(row(page, WRITER, KEEPER)).not.toHaveAttribute('data-ctx-open', /.*/)
})

test('C13, C14, C20, C56: the label is read off the row the menu opened over', async ({ page }) => {
  await openWriterInbox(page)
  await ensureUnread(page, WRITER, KEEPER)
  await openRowMenu(page, WRITER, KEEPER)
  expect((await itemLabels(page))[0]).toBe('Mark as read')
  await page.keyboard.press('Escape')

  // The same list, a row with the other flag: the words differ, so they cannot be a fixed string.
  await openRowMenu(page, WRITER, LEASE)
  expect((await itemLabels(page))[0]).toBe('Mark as unread')
  await page.keyboard.press('Escape')

  // A flip through the menu, then the menu again: the toggle now offers the way back.
  await openRowMenu(page, WRITER, KEEPER)
  await clickItem(page, 'Mark as read')
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await openRowMenu(page, WRITER, KEEPER)
  expect((await itemLabels(page))[0]).toBe('Mark as unread')
  await page.keyboard.press('Escape')

  // And a flag moved by a DIFFERENT path (opening the row, which marks it read) is followed too:
  // the items are built from the snapshot, never from the payload the right-click carried.
  await row(page, WRITER, LUNCH).click()
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await openRowMenu(page, WRITER, LUNCH)
  expect((await itemLabels(page))[0]).toBe('Mark as unread')
})

test('C15, C16, C69, C70: the flip is optimistic, and a refusal puts all three numbers back', async ({ page }) => {
  await openWriterInbox(page)
  await ensureUnread(page, WRITER, KEEPER)
  await ensureUnread(page, WRITER, LUNCH)
  const badgeBefore = await folderBadge(page, WRITER, 'INBOX')
  const smartBefore = await smartBadge(page)
  expect(badgeBefore, 'the writer inbox starts with unread mail').toBeGreaterThan(0)

  // Held, not answered: the numbers below are what a person sees BEFORE any server replied.
  let release: (() => void) | null = null
  await page.route(READ_URL, async (route) => {
    await new Promise<void>((wake) => { release = wake })
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unsupported', message: 'This provider cannot change the read flag' }),
    })
  })

  await openRowMenu(page, WRITER, KEEPER)
  await clickItem(page, 'Mark as read')
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'false')
  expect(await folderBadge(page, WRITER, 'INBOX'), 'the folder badge moved at once').toBe(badgeBefore - 1)
  expect(await smartBadge(page), 'and so did the sum every account feeds').toBe(smartBefore - 1)

  // The refusal. Everything goes back to the value that was RECORDED, and the row is named.
  await expect.poll(() => (release ? 'ready' : 'waiting')).toBe('ready')
  release!()
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'true', { timeout: 30_000 })
  expect(await folderBadge(page, WRITER, 'INBOX')).toBe(badgeBefore)
  expect(await smartBadge(page)).toBe(smartBefore)
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('Quarterly keeper report')
  await expect(note).toContainText('This provider cannot change the read flag')
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-flag-failed', '1')
  await expect(row(page, WRITER, KEEPER).getByTestId('mail-row-flag-failed')).toHaveCount(1)
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('title', /cannot change the read flag/)
  // C70: this account has neither a degraded line nor an unread gap, so the sentence had no slot to
  // render in before the note joined that condition.
  await expect(page.getByTestId('mail-degraded-line')).toHaveCount(0)
  await expect(page.getByTestId('mail-unread-gap')).toHaveCount(0)
  await expect(note).toBeVisible()
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'flip-refused')}`)

  // C69: a second row fails too. Each row keeps its OWN mark, and the sentence names the latest.
  release = null
  await openRowMenu(page, WRITER, LUNCH)
  await clickItem(page, 'Mark as read')
  await expect.poll(() => (release ? 'ready' : 'waiting')).toBe('ready')
  release!()
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-flag-failed', '1', { timeout: 30_000 })
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-flag-failed', '1')
  await expect(note).toContainText('Lunch tomorrow')
  await page.unroute(READ_URL)
})

test('C18: the toggle is drawn while the provider list is unknown, and the server decides', async ({ page }) => {
  // The provider list never lands, which is NOT the same answer as "this provider cannot". The item is
  // offered, the call goes out, and the refusal is what rolls it back.
  await page.route('**/api/plugins/mail/providers', (route) => route.abort())
  await openMail(page, port)
  await expect(folderRow(page, READER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, READER, 'INBOX').click()
  await expect(row(page, READER, NOTICE)).toBeVisible({ timeout: 90_000 })

  const writes: string[] = []
  page.on('request', (request) => { if (request.url().endsWith('/read')) writes.push(request.url()) })
  await openRowMenu(page, READER, NOTICE)
  expect(await itemLabels(page)).toContain('Mark as unread')
  await clickItem(page, 'Mark as unread')
  // The provider really cannot, so the plugin answers 409 and the row comes back to read.
  await expect(page.getByTestId('mail-row-note')).toContainText('Moorings closed on the sixth', { timeout: 30_000 })
  await expect(row(page, READER, NOTICE)).toHaveAttribute('data-unread', 'false')
  await expect(row(page, READER, NOTICE)).toHaveAttribute('data-flag-failed', '1')
  expect(writes.length, 'the click asked the server rather than deciding for it').toBe(1)
  expect(writes[0]).toContain(encodeURIComponent(READER))
  await page.unroute('**/api/plugins/mail/providers')
})

test('C19: a row flipped from the menu survives the unread filter and a sync', async ({ page }) => {
  // The socket is proxied so a real `sync-completed` frame can be injected, which is what makes the
  // console re-read the page: a local flip alone would leave the row in place by doing nothing.
  let inject: ((frame: string) => void) | null = null
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => ws.send(message))
    inject = (frame) => ws.send(frame)
  })
  await openWriterInbox(page)
  await ensureUnread(page, WRITER, KEEPER)
  await page.getByTestId('mail-unread-filter').click()
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'true')
  await expect(row(page, WRITER, LEASE)).toHaveCount(0, { timeout: 30_000 })
  const before = await page.locator('.mail-row').evaluateAll(
    (rows) => rows.map((one) => one.getAttribute('data-message-id')),
  )
  expect(before).toContain(KEEPER)

  await openRowMenu(page, WRITER, KEEPER)
  await clickItem(page, 'Mark as read')
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  // Still there, and at its own index: a row vanishing under the pointer is how a triage pass loses
  // its place.
  expect(await page.locator('.mail-row').evaluateAll(
    (rows) => rows.map((one) => one.getAttribute('data-message-id')),
  )).toEqual(before)

  expect(inject, 'the socket route is installed').not.toBeNull()
  inject!(JSON.stringify({
    type: 'event',
    name: 'plugin:mail:sync-completed',
    data: { accountId: WRITER, mailboxId: 'INBOX', added: 0, updated: 1 },
    seq: 1,
  }))
  await page.waitForTimeout(2_500)
  expect(
    await page.locator('.mail-row').evaluateAll((rows) => rows.map((one) => one.getAttribute('data-message-id'))),
    'the server has stopped returning it, and it is still on screen where it was',
  ).toEqual(before)
  await page.getByTestId('mail-unread-filter').click()
})

test('C22, C24: a merged list acts on the row it opened over, account by account', async ({ page }) => {
  await openMail(page, port)
  const allInboxes = page.locator(`${PANE} .mail-mailbox.smart[data-smart="inbox"]`)
  await expect(allInboxes).toHaveCount(1, { timeout: 90_000 })
  await allInboxes.click()
  await expect(row(page, READER, NOTICE)).toBeVisible({ timeout: 90_000 })
  await expect(row(page, WRITER, KEEPER)).toBeVisible()
  await ensureUnread(page, WRITER, KEEPER)

  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const url = request.url()
    if (url.endsWith('/read') || url.endsWith('/task')) posts.push(url)
  })

  // The account whose provider cannot move the flag has NO toggle, in the same list as one that can.
  await openRowMenu(page, READER, NOTICE)
  // The account is a heading line OF ITS OWN now: the single line clipped from the right on real mail,
  // and the account field (the one thing a merged list is asked about) was the first thing lost.
  await expect(menu(page).locator('.wn-context-menu-info').last()).toHaveText('Fixture Mail (inbound only)')
  expect(await itemLabels(page)).not.toContain('Mark as read')
  expect(await itemLabels(page)).not.toContain('Mark as unread')
  await clickItem(page, 'Make a task')
  await expect(row(page, READER, NOTICE)).toHaveAttribute('data-task-id', /.+/, { timeout: 60_000 })

  // And the writer's row in the same list carries the toggle, whose write goes to the WRITER.
  await openRowMenu(page, WRITER, KEEPER)
  await expect(menu(page).locator('.wn-context-menu-info').last()).toHaveText('Fixture Mail')
  await clickItem(page, 'Mark as read')
  await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })

  expect(posts.length).toBe(2)
  expect(posts[0], 'the task was made on the row it opened over').toContain(encodeURIComponent(READER))
  expect(posts[1], 'and the flag was moved on the other account').toContain(encodeURIComponent(WRITER))
  expect(posts[1]).toContain(encodeURIComponent(KEEPER))
})

test('C25, C54: a reply from a never-opened row quotes it and sends as that row', async ({ page }) => {
  await openMail(page, port)
  const allInboxes = page.locator(`${PANE} .mail-mailbox.smart[data-smart="inbox"]`)
  await expect(allInboxes).toHaveCount(1, { timeout: 90_000 })
  await allInboxes.click()
  await expect(row(page, WRITER, LUNCH)).toBeVisible({ timeout: 90_000 })
  // Nobody has opened this row in this window, so its body is not in the store: the quote can only be
  // real if the item fetched it first.
  await expect(page.getByTestId('mail-reader')).not.toHaveAttribute('data-message-id', LUNCH)

  await openRowMenu(page, WRITER, LUNCH)
  await clickItem(page, 'Reply')
  await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 60_000 })
  // The identity is the ROW's account, not whichever account the merged pane happens to list first.
  await expect(page.getByTestId('mail-compose-account')).toHaveAttribute('data-account-id', WRITER)
  const quote = page.getByTestId('mail-compose-quote')
  await expect(quote).toContainText('Lunch tomorrow at one?')
  // A real quote, not the bare attribution line a missing body would have produced.
  await expect(quote).toContainText('>')
  await page.getByTestId('mail-composer-close').click()
})

test('C54: a body that will not load writes no draft at all', async ({ page }) => {
  await openWriterInbox(page)
  // The one read this item makes, refused. The row has never been opened, so there is no held body.
  await page.route(`**/api/plugins/mail/messages/*/${encodeURIComponent(KEEPER)}*`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'body_unavailable', message: 'the provider closed the connection' }),
    })
  })
  const drafts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/plugins/mail/drafts')) {
      drafts.push(request.url())
    }
  })

  await openRowMenu(page, WRITER, KEEPER)
  await clickItem(page, 'Reply')
  const note = page.getByTestId('mail-row-note')
  await expect(note).toContainText('Quarterly keeper report', { timeout: 60_000 })
  await expect(note).toContainText('no reply was started')
  await expect(page.getByTestId('mail-composer')).toHaveCount(0)
  expect(drafts, 'nothing was saved: a composer writes its draft the moment it opens').toEqual([])
  await page.unroute(`**/api/plugins/mail/messages/*/${encodeURIComponent(KEEPER)}*`)
})

test('C79: replying from one row keeps the row being read on an unread page', async ({ page }) => {
  await openWriterInbox(page)
  // BOTH rows, because the filter has to hold X while the menu is opened over Y: a case that ran
  // earlier may have left either of them read.
  await ensureUnread(page, WRITER, LUNCH)
  await ensureUnread(page, WRITER, KEEPER)
  await page.getByTestId('mail-unread-filter').click()
  await expect(page.getByTestId('mail-unread-filter')).toHaveAttribute('data-on', 'true')
  await expect(row(page, WRITER, LUNCH)).toBeVisible({ timeout: 30_000 })

  // X is READ now, because opening it is what marks it read; it stays on the filtered page because it
  // is the row being read.
  await row(page, WRITER, LUNCH).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LUNCH, { timeout: 60_000 })
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })

  // A reply to a DIFFERENT row takes the reader's pane (`handOver` clears the open message), and X
  // must not leave the list with it: the human is replying to Y, not finished with X.
  await openRowMenu(page, WRITER, KEEPER)
  await clickItem(page, 'Reply')
  await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 60_000 })
  await expect(row(page, WRITER, LUNCH)).toHaveCount(1)
  await expect(row(page, WRITER, LUNCH)).toBeVisible()
  await page.getByTestId('mail-composer-close').click()
  await page.getByTestId('mail-unread-filter').click()
})

test('C33, C57: the task lands on the row with no reload, and a double click is one POST', async ({ page }) => {
  await openWriterInbox(page)
  await expect(row(page, WRITER, LUNCH)).not.toHaveAttribute('data-task-id', /.+/)
  // Held long enough for a second click to land while the first is still out.
  const posts: string[] = []
  await page.route(TASK_URL, async (route) => {
    posts.push(route.request().url())
    await new Promise((wake) => { setTimeout(wake, 2_000) })
    await route.continue()
  })

  await openRowMenu(page, WRITER, LUNCH)
  await clickItem(page, 'Make a task')
  // The impatient second press, while the first request is still in flight.
  await openRowMenu(page, WRITER, LUNCH)
  await clickItem(page, 'Make a task')
  await expect(row(page, WRITER, LUNCH)).toHaveAttribute('data-task-id', /.+/, { timeout: 60_000 })
  expect(posts.length, 'the two clicks were coalesced into one write').toBe(1)

  // The mark is on the row itself, with no reload, and it is a SPAN: a link would hand the row's
  // right-click back to the browser.
  await expect(row(page, WRITER, LUNCH).getByTestId('mail-row-task')).toHaveCount(1)
  expect(await row(page, WRITER, LUNCH).locator('a[href]').count(), 'no anchor inside the row').toBe(0)
  // And the item now offers the task instead of making a second one.
  await openRowMenu(page, WRITER, LUNCH)
  expect(await itemLabels(page)).toContain('Open task')
  expect(await itemLabels(page)).not.toContain('Make a task')
  await page.keyboard.press('Escape')
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'row-tasked')}`)
  await page.unroute(TASK_URL)
})

test('C49: Copy Walnut link writes the deep link and says so', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openWriterInbox(page)
  await openRowMenu(page, WRITER, LEASE)
  await clickItem(page, 'Copy Walnut link')
  await expect(page.getByTestId('mail-row-note')).toHaveText('Link copied.', { timeout: 30_000 })
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  const query = new URLSearchParams(new URL(copied).search)
  expect(query.get('account')).toBe(WRITER)
  expect(query.get('message')).toBe(LEASE)
  expect(new URL(copied).pathname).toBe('/mail')
})

test('C67, C68: the right-clicked row is marked, and not the way a selected row is', async ({ page }) => {
  await openWriterInbox(page)
  await row(page, WRITER, LEASE).click()
  await expect(row(page, WRITER, LEASE)).toHaveClass(/selected/)
  await openRowMenu(page, WRITER, KEEPER)
  // The heading names the row the menu is ABOUT, which is not the row that is selected.
  await expect(menu(page).locator('.wn-context-menu-info')).toContainText('Quarterly keeper report')

  const marks = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null
      if (!element) return null
      const style = getComputedStyle(element)
      return { shadow: style.boxShadow, outline: style.outlineWidth }
    }
    return {
      selected: read('.mail-row.selected'),
      ctx: read('.mail-row[data-ctx-open="true"]'),
    }
  })
  expect(marks.selected).not.toBeNull()
  expect(marks.ctx).not.toBeNull()
  // Not the same kind of mark: the selected row's accent bar is an inset on its LEFT edge, and a
  // second bar in the same place and colour reads as "it selected this row", which is the one thing a
  // right-click promises never to do.
  expect(marks.ctx!.shadow).not.toBe(marks.selected!.shadow)
  console.log(`shot: ${await shoot(page.locator('.mail-rows'), SHOT_DIR, 'ctx-vs-selected')}`)
})

test('C26, C74, C75: a real selection keeps the browser menu and does not open the row', async ({ page }) => {
  await openWriterInbox(page)
  // The reader is holding a THIRD message, so "the drag opened nothing" is a comparison against
  // something rather than against a blank pane.
  await row(page, WRITER, LEASE).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LEASE, { timeout: 60_000 })
  // Both text spans have to be selectable for any of this to be provable: a `<button>`'s text is not,
  // by default, which is why this case could not be written before.
  const subject = await dragAcross(page, row(page, WRITER, KEEPER).locator('.mail-row-subject-text'))
  expect(subject.trim().length, 'the subject is selectable text').toBeGreaterThan(0)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())

  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/\/api\/plugins\/mail\/messages\/[^?]+$/.test(url) && request.method() === 'GET') calls.push(url)
    if (url.endsWith('/read')) calls.push(url)
  })
  // The SUBJECT plus the open pair, not the pane's whole text: a body arrives asynchronously and adds
  // a trailing line while it settles, which is not the pane changing what it is showing.
  const readerBefore = await page.getByTestId('mail-reader-subject').innerText()
  const openedBefore = await page.getByTestId('mail-reader').getAttribute('data-message-id')

  const snippet = await dragAcross(page, row(page, WRITER, LUNCH).locator('.mail-row-snippet'))
  expect(snippet.trim().length, 'and so is the snippet').toBeGreaterThan(0)
  // C74: the drag ended inside a button, so it also fired a click. The row must not open, because
  // opening marks it read and looking a word up is not a request to read the mail.
  expect(calls, 'a drag select is not a click on the row').toEqual([])
  expect(await page.getByTestId('mail-reader-subject').innerText()).toBe(readerBefore)
  expect(await page.getByTestId('mail-reader').getAttribute('data-message-id')).toBe(openedBefore)

  // C26: with that selection live, the right-click belongs to the browser (Copy, Look Up, Translate).
  // ON THE SELECTED WORDS, which is where a person right-clicks and is now the only place it can be
  // graded: the row is a `div role="button"` (so its text is selectable in WebKit too), and in a
  // selectable element a right-press on text OUTSIDE the selection collapses it before any handler
  // runs. With no selection left there is nothing for the browser's menu to act on, so Walnut's is
  // the right answer there.
  await row(page, WRITER, LUNCH).locator('.mail-row-snippet').click({ button: 'right' })
  await page.waitForTimeout(500)
  expect(await page.locator('.wn-context-menu').count(), 'the native menu was left alone').toBe(0)
  expect(calls).toEqual([])
})

test('C27: a selection left in another pane does not suppress the row menu', async ({ page }) => {
  await openWriterInbox(page)
  await row(page, WRITER, LEASE).click()
  await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 60_000 })
  const elsewhere = await dragAcross(page, page.getByTestId('mail-reader-subject'))
  expect(elsewhere.trim().length, 'a live selection, outside any row').toBeGreaterThan(0)

  // The rule is scoped to the row the gesture landed on, so a leftover selection somewhere else on
  // the page is not an answer about this row.
  await openRowMenu(page, WRITER, KEEPER)
  expect(await itemLabels(page)).toContain('Mark as read')
  await page.keyboard.press('Escape')
})
