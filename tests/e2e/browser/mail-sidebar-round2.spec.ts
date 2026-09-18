import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  accountSection,
  filterShape,
  folderRow,
  openMail,
  paneGeometry,
  shoot,
  smartRow,
  tailShape,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * The second review round, one test per finding, at the dense fixture's density.
 *
 *   F1  All Drafts promised 51 and the page it opened could account for 8
 *   F2  the collapse row counted unread MESSAGES where its own tooltip and data said FOLDERS
 *   F3  it said "58 folders" for an account with 64, because the word `more` was missing
 *   F4  typing in the folder filter deleted the account's Inbox, Drafts, Sent, Junk and Trash, and took
 *       the selected row's highlight off the whole sidebar
 *   F5  the smart parent and the ordinary folder rows started on the same pixel (35px), so the group had
 *       no hierarchy cue but boldness, and its icon column was empty
 *   F6  the two accounts drew the same six roles in two different orders
 *   F7  one cold open issued four `/messages` requests for a single merged page
 *   F9  two rows carried `aria-current` for one mailbox
 *   F10 the smart row's number was the fourth smallest of ten badges, under Archive and Trash counts
 *   F11 the filter box broke the pane's text column and outweighed the 58 rows it filters
 *   C64 the expanded list's LAST li was a second copy of the control, not the collapse row itself
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/round2'
const NARROW_COLUMN = { width: 1280, height: 800 }
const WIDE_COLUMN = { width: 1440, height: 900 }
/**
 * The role rows, by the PROVIDER's own name and in the SERVER's order (round 3, N10 and C9): relabelling
 * them to canonical role names left the real name reachable only on hover, invisible to the tail filter,
 * and re-ordered the rows of every install. The role is on the row as its glyph.
 */
const ROLE_ROWS = ['INBOX', 'Archive', 'Drafts', 'Sent', 'Spam', 'Trash']
/** The other account's own six, in its own server order (its names sort Bin before Drafts). */
const ROLE_ROWS_MARINA = ['Inbox', 'Archived', 'Bin', 'Drafts', 'Junk', 'Sent Mail']

test.setTimeout(420_000)
test.use({ viewport: NARROW_COLUMN })
test.describe.configure({ mode: 'serial' })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start()
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

test('F2 F3: the collapse row counts folders, and says `more` because 58 is a remainder', async ({ page }) => {
  await openMail(page, port)
  const tail = tailToggle(page, HARBOUR)
  await expect(tail).toBeVisible({ timeout: 90_000 })

  const shape = await tailShape(page, HARBOUR)
  // The account has 64 folders and six are drawn above this line. Six of the 58 hidden ones hold 200
  // unread between them, and the row's second number is the SIX: two clauses in one comma-separated
  // sentence are read in the unit of the first word, so "200 unread" read as 200 folders.
  expect(shape.text).toBe('58 more folders, 6 with unread')
  expect(shape.label).toBe('58 more folders, ')
  expect(shape.clause).toBe('6 with unread')
  await expect(tail).toHaveAttribute('data-hidden', '58')
  await expect(tail).toHaveAttribute('data-hidden-unread-folders', '6')
  await expect(tail).toHaveAttribute('data-hidden-unread', '200')
  // The row and its own hover text agree on the number, and the MAIL count names its unit there.
  await expect(tail).toHaveAttribute(
    'title',
    'Folders you have not opened lately. Anything that just received mail is above this line.'
    + ' 6 of them hold unread mail (200 messages).',
  )
  // F8: readable. One line, the same height as the rows it sits among, and a contrast a person can read.
  expect(shape.cut.every((one) => one <= 1), `neither clause is cut: ${shape.cut.join(', ')}`).toBe(true)
  expect(shape.gap, 'a real gap after the comma').toBeGreaterThanOrEqual(2)
  expect(Math.abs(shape.height - shape.folderHeight), 'the same height as a folder row')
    .toBeLessThanOrEqual(1)
  expect(shape.contrast, `${shape.colour} in light`).toBeGreaterThanOrEqual(4.5)
  console.log(`F2 F3 collapse row: ${JSON.stringify(shape)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-tail-row')}`)
})

test('F5 C61: the group entry is left of the folder rows it contains', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)

  const measured: string[] = []
  for (const [label, size] of [['204px', NARROW_COLUMN], ['232px', WIDE_COLUMN]] as const) {
    await page.setViewportSize(size)
    await expect(smartRow(page, 'inbox')).toBeVisible()
    const geometry = await paneGeometry(page)
    // ONE glyph column for the pane, and four text columns that prove the containment: the group entry
    // is leftmost (a 20px chevron), an ordinary folder is 3px right of it (a 15px glyph and a 4px gap),
    // a child is 18px inside its parent (round 3, N13: at 8px all four left edges lived within 8px of
    // each other and the children read as loose text), and the collapse row shares the parent's column
    // because it
    // belongs to the list as a whole. All four used to be 35px.
    // The glyph column, to the pixel the layout can promise: at 232px the pane's own left edge is
    // fractional, so an SVG box rounds to 11 where the text boxes still round to their exact column.
    for (const [what, at] of [
      ['the smart chevron', geometry.smartGlyph],
      ['the folder icon', geometry.folderGlyph],
      ['the collapse chevron', geometry.tailGlyph],
    ] as const) {
      expect(Math.abs(at - 12), `${what} at ${label} measured ${at}`).toBeLessThanOrEqual(1)
    }
    expect(
      { smart: geometry.smartText, folder: geometry.folderText, child: geometry.childText, tail: geometry.tailText },
      `text left edges at ${label}`,
    ).toEqual({ smart: 28, folder: 31, child: 46, tail: 28 })
    measured.push(`${label}: ${JSON.stringify(geometry)}`)
  }
  await page.setViewportSize(NARROW_COLUMN)
  console.log(`F5 geometry\n${measured.join('\n')}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-hierarchy')}`)
})

// F6 REVERSED in round 3 (N10, C9): each account's section is that account's own list, in the order the
// server gave it, under the provider's own names. The canonical relabel that used to be asserted here read
// `Archive` over a folder the provider calls something else and moved the rows of every install.
test('C9 N10: each account draws its own six, in the order and under the names the server gave', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  const names = async (accountId: string) => accountSection(page, accountId)
    .locator('ul.mail-mailboxes .mail-mailbox .mail-mailbox-name')
    .allInnerTexts()
  expect(await names(HARBOUR), 'the 64 folder account').toEqual(ROLE_ROWS)
  expect(await names(MARINA), 'the 6 folder account, its own order').toEqual(ROLE_ROWS_MARINA)
  const providerOrder = await page.evaluate(async () => {
    const answer = await fetch('/api/plugins/mail/mailboxes?account=dense:marina')
    const body = await answer.json() as { mailboxes: Array<{ role: string }> }
    return body.mailboxes.map((one) => one.role)
  })
  expect(providerOrder, 'the server really hands them over in another order')
    .toEqual(['inbox', 'archive', 'trash', 'drafts', 'spam', 'sent'])
  // The Drafts row keeps its splice: it is Walnut's own row, in the place the provider's folder held.
  const drafts = accountSection(page, MARINA).locator('[data-testid="mail-drafts-row"]')
  await expect(drafts).toHaveCount(1)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-role-order')}`)
})

test('F4 C64: the filter reaches the labels only, and the collapse row is the last li', async ({ page }) => {
  await openMail(page, port)
  await folderRow(page, HARBOUR, 'INBOX').click()
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  await tailToggle(page, HARBOUR).click()
  const filter = page.getByTestId('mail-tail-filter')
  await expect(filter).toBeVisible({ timeout: 90_000 })

  await filter.fill('receipts')
  const names = await accountSection(page, HARBOUR)
    .locator('ul.mail-mailboxes .mail-mailbox .mail-mailbox-name').allInnerTexts()
  // It used to leave ONE row: the label that matched. Inbox, Archive, Drafts, Sent, Junk and Trash were
  // gone, and `.mail-mailbox.active` was zero across the whole sidebar while the person read that inbox.
  expect(names, 'the six role rows plus the one match').toEqual([...ROLE_ROWS, 'Receipts'])
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator(`${PANE} .mail-mailbox.active`)).toHaveCount(1)

  // C64: the collapse row itself is the last li, expanded and collapsed, with the repeat above the tail.
  await filter.fill('')
  const shape = await accountSection(page, HARBOUR).locator('ul.mail-mailboxes').evaluate((list) => {
    const items = Array.from(list.children)
    return {
      count: items.length,
      toggleAt: items.findIndex((li) => li.querySelector('.mail-tail-toggle')),
      headAt: items.findIndex((li) => li.querySelector('.mail-tail-head')),
      filterAt: items.findIndex((li) => li.querySelector('.mail-tail-filter')),
      lastRowAt: items.map((li, at) => (li.querySelector('.mail-mailbox') ? at : -1)).filter((at) => at >= 0).pop(),
      toggles: list.querySelectorAll('.mail-tail-toggle').length,
    }
  })
  expect(shape.toggleAt, 'the collapse row is the last li').toBe(shape.count - 1)
  expect(shape.toggles, 'and there is exactly one of it').toBe(1)
  expect(shape.headAt).toBeLessThan(shape.filterAt)
  expect(shape.filterAt).toBeLessThan(shape.lastRowAt!)
  console.log(`F4 C64 list shape: ${JSON.stringify(shape)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-filtered')}`)
})

test('F11: the filter box sits in the folder text column and weighs no more than a row', async ({ page }) => {
  await openMail(page, port)
  await tailToggle(page, HARBOUR).click()
  await expect(page.getByTestId('mail-tail-filter')).toBeVisible({ timeout: 90_000 })
  const box = await filterShape(page)
  // Its text used to start 19px left of every folder name, so a 204px pane had two text columns, and it
  // carried a full border plus a focus ring in a column of 58 borderless rows.
  expect(box.inputText, 'the input reads down the folder column').toBe(box.folderText)
  expect(Math.abs(Number(box.inputHeight) - Number(box.rowHeight)), 'a row, not a taller box')
    .toBeLessThanOrEqual(1)
  expect(box.border, 'no resting border: a filled well instead').toBe('0px')
  await page.getByTestId('mail-tail-filter').fill('zzzznope')
  await expect(page.getByTestId('mail-tail-empty')).toBeVisible()
  const withEmpty = await filterShape(page)
  expect(withEmpty.emptyText, 'the stand-in line reads down the same column').toBe(withEmpty.folderText)
  console.log(`F11 filter box: ${JSON.stringify({ ...box, empty: withEmpty.emptyText })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-filter-box')}`)
})

test('F7: one cold open of Mail issues one /messages request', async ({ page }) => {
  const pages: Array<{ at: number, search: string }> = []
  const fetches: string[] = []
  const started = Date.now()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/mail/messages')) pages.push({ at: Date.now() - started, search: url.search })
    if (url.pathname.endsWith('/mailboxes/fetch')) fetches.push(url.search)
  })
  // The fixture's FIRST sync of two accounts lands during the boot, and a sync that really added rows is
  // a reason to re-read the page on screen (pinned by the promotion test). This case is about the boot
  // sequence alone, so those frames are held at the socket: what is graded is the number of pages the
  // console asks for by itself.
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      const text = String(message)
      if (text.includes('plugin:mail:sync-completed') || text.includes('plugin:mail:messages-received')) return
      ws.send(message)
    })
  })

  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90_000 })
  // A moment for anything the boot sequence still had in flight to arrive and be counted.
  await page.waitForTimeout(3_000)
  // It used to be four: an account page for the first folder list to land (never shown), then the
  // cross-account scope query three times. That query trades an index seek for a scan plus a temporary
  // sort, on the single event loop every route in this server shares.
  expect(pages.map((one) => one.search), `one merged page: ${JSON.stringify(pages)}`).toHaveLength(1)
  expect(pages[0]!.search).toContain('scope=role%3Ainbox')
  // The discarded page: the first folder list to land auto-picked its own account's inbox and fetched it,
  // and the merged row then replaced that selection before anything was drawn.
  expect(pages[0]!.search, 'and no account filter rides with it').not.toContain('account=')
  // C6: a merged selection is not a folder, so nothing is fetched to open it.
  expect(fetches, 'no folder fetch').toEqual([])

  // Leaving Mail and coming back is the other path the fan-out doubled on: the store is loaded, so this
  // goes through the refresh instead of the boot, and it must still be ONE page.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator(PANE)).toHaveCount(0)
  const before = pages.length
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.locator(PANE)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3_000)
  expect(pages.slice(before).map((one) => one.search), `one page on return: ${JSON.stringify(pages.slice(before))}`)
    .toHaveLength(1)
  console.log(`F7 requests: ${JSON.stringify(pages)}`)
})

test('F9: one mailbox, one current row', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await twist(page, 'inbox').click()
  const child = page.locator(`${PANE} [data-testid="mail-smart-child"][data-account-id="${MARINA}"]`)
  await expect(child).toBeVisible()
  await child.click()

  // ONE row looks clicked (round 3, N6). The same mailbox is drawn twice in this pane, and giving both
  // the full active fill left two filled rows 400px apart, the louder of which carried no `aria-current`.
  // The child keeps a QUIET mark instead, so the group still shows which of its children is on screen.
  await expect(page.locator(`${PANE} .mail-mailbox.active`)).toHaveCount(1)
  await expect(page.locator(`${PANE} .mail-mailbox.active`)).toHaveAttribute('data-mailbox-id', 'inbox')
  await expect(child).toHaveAttribute('data-current', 'true')
  await expect(child).not.toHaveClass(/\bactive\b/)
  const marks = await child.evaluate((row) => {
    const style = getComputedStyle(row)
    const real = getComputedStyle(row.closest('.mail-accounts-pane')!
      .querySelector('.mail-mailbox.active')!)
    return { child: style.backgroundColor, chosen: real.backgroundColor, weight: style.fontWeight,
      rail: style.boxShadow }
  })
  expect(marks.child, 'the child is not filled like the row that was chosen').not.toBe(marks.chosen)
  expect(marks.rail, 'it carries a rail instead').not.toBe('none')
  await expect(page.locator(`${PANE} .mail-mailbox[aria-current="true"]`)).toHaveCount(1)
  await expect(folderRow(page, MARINA, 'inbox')).toHaveAttribute('aria-current', 'true')
  await expect(child).not.toHaveAttribute('aria-current', /.+/)
  // And a smart PARENT selection is announced by the parent, once.
  await smartRow(page, 'inbox').click()
  await expect(page.locator(`${PANE} .mail-mailbox[aria-current="true"]`)).toHaveCount(1)
  await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true')
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-child-selected')}`)
})

test('F10: the roles nobody triages carry a quiet badge, the inboxes a loud one', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 90_000 })
  const badges = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.mail-accounts-pane .mail-mailbox')) as HTMLElement[]
    return rows.flatMap((row) => {
      const badge = row.querySelector('.mail-unread-badge') as HTMLElement | null
      if (!badge) return []
      return [{
        mailbox: row.getAttribute('data-mailbox-id') ?? '',
        text: badge.textContent ?? '',
        quiet: badge.getAttribute('data-quiet') === 'true',
        background: getComputedStyle(badge).backgroundColor,
      }]
    })
  })
  const loud = badges.filter((one) => !one.quiet).map((one) => one.background)
  const quiet = badges.filter((one) => one.quiet)
  // The fixture really does carry the shape this is about: Archive 177, Junk 37, Trash 2,609. Without this
  // the loop below would pass over an empty list and prove nothing.
  expect(quiet.map((one) => one.text).sort(), `quiet badges: ${JSON.stringify(badges)}`)
    .toEqual(['177', '2,609', '37'])
  // The unread numbers on Archive, Junk and Trash are exact and still on screen, because unread only
  // Walnut can see is what this pane must never hide. They just stop being the loudest thing in it.
  for (const badge of quiet) expect(loud).not.toContain(badge.background)
  // The number the group exists to answer keeps the alert fill, and it is the mailbox rows' own sum.
  const inbox = smartRow(page, 'inbox').getByTestId('mail-smart-unread')
  await expect(inbox).toHaveText('7')
  const smartFill = await inbox.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(loud, 'the smart row is in the loud set').toContain(smartFill)
  console.log(`F10 badges: ${JSON.stringify(badges)}`)
})

test('F1: the All Drafts badge is a number you can count in the first section', async ({ page }) => {
  await openMail(page, port)
  const row = smartRow(page, 'drafts')
  await expect(row).toBeVisible({ timeout: 90_000 })
  const badge = row.getByTestId('mail-smart-unread')
  const header = page.locator('.mail-list-section .mail-list-section-count')

  // STATE A: nothing written here, three drafts across the two providers' own Drafts folders. The badge
  // used to be the sum of those folders' DECLARED sizes, which count drafts outside this cache's window:
  // on the real install it read 51 directly above the sentence "No drafts. Start one with New message."
  await expect(badge, 'nothing written here means no number').toHaveCount(0, { timeout: 60_000 })
  await row.click()
  await expect(page.locator('.mail-list-section-name')).toHaveText('All Drafts', { timeout: 60_000 })
  const written = page.locator('[data-testid="mail-drafts-group"][data-group="written-here"]')
  await expect(written.locator('.mail-rows-group-count')).toHaveText('0')
  await expect(page.getByTestId('mail-draft-row'), 'section one lists nothing').toHaveCount(0)
  // The HEADER still describes the whole view, and every row under it can be counted.
  await expect(page.getByTestId('mail-row')).toHaveCount(3, { timeout: 60_000 })
  await expect(header, 'the header counts what is under it').toHaveText('3')
  await expect(page.getByTestId('mail-list-count-word')).toHaveText('loaded')
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-all-drafts-empty')}`)

  // STATE B: one draft written here, through the real composer.
  await page.getByTestId('mail-compose-new').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  await page.getByTestId('mail-compose-subject').fill('Counting the first section')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  await expect(badge, 'the badge is section one').toHaveText('1', { timeout: 60_000 })
  await row.click()
  await expect(page.getByTestId('mail-draft-row'), 'and section one really lists one')
    .toHaveCount(1, { timeout: 60_000 })
  const first = await written.locator('.mail-rows-group-count').allTextContents()
  expect(first.map(Number).reduce((sum, one) => sum + one, 0), 'counted, it is the badge').toBe(1)
  await expect(header, 'the header moved with it').toHaveText('4', { timeout: 60_000 })
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-all-drafts-one')}`)
})
