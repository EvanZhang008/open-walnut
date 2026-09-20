/**
 * Verifier round 3: a SECOND measurement of the mail right-click slice's load-bearing claims, written
 * by the verifier and deliberately not reusing the slice's own assertions.
 *
 * The one method note that matters: the optimistic flip is observed from INSIDE the page, by a
 * recorder armed before the click, because a cross-process sample loop cannot promise to land inside a
 * window that is only as long as the provider's answer takes (the previous round's loop took its first
 * sample 1825ms after the click and reported a flip that had already been rolled back).
 *
 * Runs in whichever project it is launched with (`--project=webkit` pins WebKit), so no browser pin is
 * written here.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, pickTheme, smartRow } from './mail-review-helpers'

const SHOTS = '/tmp/mail-verify-v3'
const WRITER = 'fixture:ctx-writer@example.invalid'
const READER = 'inbound:ctx-reader@example.invalid'
const KEEPER = 'INBOX:1:31'   // unread at first sight
const LUNCH = 'INBOX:1:30'    // unread at first sight
const LEASE = 'INBOX:1:29'    // read at first sight
const MENU = '.wn-context-menu'

let port = 0
let tag = 'engine'
const server = new MailFixtureServer()

/**
 * WHICH message the reader pane is showing: its subject and the pair it is keyed on.
 *
 * Not the pane's whole text, which two cases below used to compare before and after a gesture. A body
 * arrives asynchronously and adds a line while the pane settles, so the full text differs for a reason
 * that has nothing to do with the gesture under test.
 */
async function readerShows(page: Page): Promise<{ subject: string, pair: string | null }> {
  // One round trip, and it tolerates an EMPTY pane: one case below never opens a message at all, so a
  // locator that waits for the subject waits for something that is correctly absent.
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="mail-reader"]')
    const subject = document.querySelector('[data-testid="mail-reader-subject"]')
    return {
      subject: subject ? (subject.textContent ?? '').trim() : '',
      pair: pane ? pane.getAttribute('data-message-id') : null,
    }
  })
}

test.describe('mail right-click, verifier round 3', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test.describe.configure({ mode: 'default' })

  test.beforeAll(async ({ browserName }) => {
    test.setTimeout(300_000)
    tag = browserName
    await fs.mkdir(SHOTS, { recursive: true })
    port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
  })
  test.afterAll(async () => { await server.stop() })

  const row = (page: Page, accountId: string, messageId: string): Locator =>
    page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)

  const item = (page: Page, text: RegExp): Locator =>
    page.locator(`${MENU} [role="menuitem"]`).filter({ hasText: text }).first()

  async function intoInbox(page: Page, accountId = WRITER): Promise<void> {
    await openMail(page, port)
    await expect(folderRow(page, accountId, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, accountId, 'INBOX').click()
    await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 90_000 })
  }

  /** Arm an in-page recorder over the row, the folder badge and the smart total. */
  async function armRecorder(page: Page, accountId: string, messageId: string): Promise<void> {
    await page.evaluate(({ accountId, messageId }) => {
      const win = window as unknown as { __v3?: unknown[] }
      const frames: unknown[] = []
      win.__v3 = frames
      const t0 = performance.now()
      const read = () => {
        const row = document.querySelector(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)
        const folder = document.querySelector(
          `.mail-account[data-account-id="${accountId}"] .mail-mailbox[data-mailbox-id="INBOX"] [data-testid="mail-mailbox-unread"]`,
        )
        const smart = document.querySelector('.mail-mailbox.smart[data-smart="inbox"] [data-testid="mail-smart-unread"]')
        frames.push({
          t: Math.round(performance.now() - t0),
          unread: row?.getAttribute('data-unread') ?? 'gone',
          failed: row?.getAttribute('data-flag-failed') ?? '',
          folder: (folder?.textContent ?? '').trim(),
          smart: (smart?.textContent ?? '').trim(),
        })
      }
      read()
      const timer = window.setInterval(read, 20)
      window.setTimeout(() => window.clearInterval(timer), 6_000)
    }, { accountId, messageId })
  }

  type Frame = { t: number, unread: string, failed: string, folder: string, smart: string }
  const frames = async (page: Page): Promise<Frame[]> =>
    await page.evaluate(() => (window as unknown as { __v3: Frame[] }).__v3) as unknown as Frame[]

  test('V3-1 C15 C16: the flip is on screen before the answer, and a refusal puts all three back', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-unread', 'true', { timeout: 60_000 })
    const before = {
      folder: (await folderRow(page, WRITER, 'INBOX').locator('[data-testid="mail-mailbox-unread"]').innerText()).trim(),
      smart: (await smartRow(page, 'inbox').locator('[data-testid="mail-smart-unread"]').innerText()).trim(),
    }
    const calls: string[] = []
    page.on('request', (r) => { if (r.url().endsWith('/read')) calls.push(`req ${r.method()} ${r.url().split('/messages/')[1]}`) })
    page.on('response', (r) => { if (r.url().endsWith('/read')) calls.push(`res ${r.status()}`) })
    await page.route('**/read', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      await new Promise<void>((done) => { setTimeout(done, 1_200) })
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'cannot_mark_read', message: 'This provider cannot mark mail read.' }),
      })
    })
    await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    await armRecorder(page, WRITER, KEEPER)
    await item(page, /^Mark as read$/).click()
    await page.waitForTimeout(3_500)
    const series = await frames(page)
    const flipped = series.filter((one) => one.unread === 'false')
    const last = series[series.length - 1]!
    console.log(`[${tag}] V3-1 calls=${JSON.stringify(calls)}`)
    console.log(`[${tag}] V3-1 before=${JSON.stringify(before)} flipFrames=${flipped.length} first=${JSON.stringify(flipped[0] ?? null)} last=${JSON.stringify(last)}`)
    const note = (await page.getByTestId('mail-row-note').innerText().catch(() => '')).trim()
    console.log(`[${tag}] V3-1 note="${note}" title="${await row(page, WRITER, KEEPER).getAttribute('title')}"`)
    await page.screenshot({ path: `${SHOTS}/${tag}-v3-1-rollback.png` })
    // C15: the row and BOTH numbers moved before the answer landed.
    expect(flipped.length, 'the row was drawn read while the request was out').toBeGreaterThan(0)
    const during = flipped[0]!
    const count = (text: string): number => Number((text || '0').replace(/[^\d]/g, '') || '0')
    expect(during.folder, 'the folder badge moved with the row').toBe(String(count(before.folder) - 1))
    expect(during.smart, 'and so did the merged total').toBe(String(count(before.smart) - 1))
    expect(during.t, 'the flip was on screen before the 1200ms answer').toBeLessThan(1_200)
    // C16: everything is back, and the refusal names the row.
    expect(last.unread, 'the row is unread again').toBe('true')
    expect(last.folder, 'the folder badge is back to its own number').toBe(before.folder)
    expect(last.smart, 'so is the merged total').toBe(before.smart)
    expect(last.failed, 'the row carries the refusal').toBe('1')
    expect(note, 'the note names this row').toMatch(/could not mark/i)
    expect(note.length, 'and names the row rather than "that message"').toBeGreaterThan(40)
  })

  test('V3-2 C13 C14 C23 C48: the first item reads the row it was opened on, and the keyboard reaches it', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
    const unreadFirst = (await page.locator(`${MENU} [role="menuitem"]`).first().innerText()).trim()
    const heading = (await page.locator(`${MENU} .wn-context-menu-info`).first().innerText()).trim()
    const headingTitle = await page.locator(`${MENU} .wn-context-menu-info`).first().getAttribute('title')
    // ONE ArrowDown must land on the read toggle: the heading is not focusable.
    await page.keyboard.press('ArrowDown')
    const focused = (await page.locator(`${MENU} .wn-context-menu-item.focused`).innerText()).trim()
    const active = await page.locator(MENU).getAttribute('aria-activedescendant')
    const focusedId = await page.locator(`${MENU} .wn-context-menu-item.focused`).getAttribute('id')
    await page.keyboard.press('Escape')
    await expect(page.locator(MENU)).toHaveCount(0)
    const stillUnread = await row(page, WRITER, KEEPER).getAttribute('data-unread')
    await row(page, WRITER, LEASE).click({ button: 'right', position: { x: 12, y: 10 } })
    const readFirst = (await page.locator(`${MENU} [role="menuitem"]`).first().innerText()).trim()
    await page.keyboard.press('Escape')
    console.log(`[${tag}] V3-2 unreadRow="${unreadFirst}" readRow="${readFirst}" heading="${heading}" title="${headingTitle}" focused="${focused}" active=${active} id=${focusedId} escapeRanNothing=${stillUnread}`)
    expect(unreadFirst, 'an unread row offers to read it').toBe('Mark as read')
    expect(readFirst, 'a read row offers the reverse').toBe('Mark as unread')
    expect(unreadFirst).not.toBe(readFirst)
    expect(heading.length, 'the heading names the row').toBeGreaterThan(8)
    expect(headingTitle ?? '', 'and the full text rides in title').toContain('·')
    expect(focused, 'one ArrowDown lands on the read toggle').toBe('Mark as read')
    expect(active, 'the highlight is named for assistive tech').toBe(focusedId)
    expect(stillUnread, 'Escape closed without running anything').toBe('true')
  })

  test('V3-3 C6 C7 C8 C9 C10 C12: a right-click leaves the reader, the selection and the flag alone', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    // Open LEASE (already read, so opening writes nothing), then right-click a DIFFERENT row.
    await row(page, WRITER, LEASE).click()
    await expect(page.locator('[data-testid="mail-reader"]')).toBeVisible({ timeout: 30_000 })
    // WHICH MESSAGE the pane is showing, not the pane's whole text. The body arrives asynchronously and
    // adds a line while it settles, which is the pane finishing the open this test performed itself, not
    // the right-click changing what is on screen: graded on the full text this case failed with the
    // single line "Signed and filed. Nothing needed from you." as the entire difference. The webkit twin
    // already reads it this way, for the same reason.
    const readerBefore = await readerShows(page)
    const selectedBefore = await page.locator('.mail-row.selected').getAttribute('data-message-id')
    const posts: string[] = []
    const gets: string[] = []
    page.on('request', (r) => {
      const url = r.url()
      if (r.method() === 'POST' && /\/mail\//.test(url)) posts.push(url.split('/plugins/mail')[1] ?? url)
      if (r.method() === 'GET' && /\/messages\/[^?]+\/[^?]+$/.test(url)) gets.push(url.split('/messages/')[1]!)
    })
    await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    const ctxOpen = await row(page, WRITER, KEEPER).getAttribute('data-ctx-open')
    const ariaCurrent = await row(page, WRITER, KEEPER).getAttribute('aria-current')
    const gotSelected = await row(page, WRITER, KEEPER).evaluate((el) => el.classList.contains('selected'))
    // C11: a second right-click on another row MOVES the menu rather than stacking one.
    const boxOne = await page.locator(MENU).boundingBox()
    // Through the MOUSE, not the row's locator: the open menu's backdrop covers the row, so a
    // locator click would wait for pointer events it will never get.
    const second = (await row(page, WRITER, LUNCH).boundingBox())!
    await page.mouse.click(second.x + 14, second.y + 10, { button: 'right' })
    await page.waitForTimeout(300)
    const menus = await page.locator(MENU).count()
    const boxTwo = menus ? await page.locator(MENU).boundingBox() : null
    // Read WHILE THE MENU IS STILL OPEN. This block used to sit after the Escape below, gated on the
    // count taken before it: when the second right-click really did move the menu (count 1), the
    // heading read then waited 180s for a menu Escape had just closed, and the case died on the
    // timeout. After Escape both `data-ctx-open` marks are null as well, so the diagnostic it prints
    // could never have answered the question it was written for (which row owns the open menu).
    const owner = {
      keeper: await row(page, WRITER, KEEPER).getAttribute('data-ctx-open'),
      lunch: await row(page, WRITER, LUNCH).getAttribute('data-ctx-open'),
      heading: menus ? (await page.locator(`${MENU} .wn-context-menu-info`).first().innerText()).trim() : '',
      keeperBox: await row(page, WRITER, KEEPER).boundingBox(),
      lunchBox: await row(page, WRITER, LUNCH).boundingBox(),
    }
    await page.keyboard.press('Escape')
    const after = {
      reader: await readerShows(page),
      selected: await page.locator('.mail-row.selected').getAttribute('data-message-id'),
      unread: await row(page, WRITER, KEEPER).getAttribute('data-unread'),
      ctxOpenGone: await row(page, WRITER, KEEPER).getAttribute('data-ctx-open'),
    }
    console.log(`[${tag}] V3-3 posts=${JSON.stringify(posts)} gets=${JSON.stringify(gets)} menus=${menus} ctxOpen=${ctxOpen} aria=${ariaCurrent} selectedRow=${gotSelected} moved=${boxOne?.y !== boxTwo?.y || boxOne?.x !== boxTwo?.x}`)
    expect(after.selected, 'the selection did not move').toBe(selectedBefore)
    expect(after.reader, 'the open message is untouched').toEqual(readerBefore)
    expect(gets, 'no message was fetched').toEqual([])
    expect(posts.filter((one) => one.endsWith('/read')), 'nothing was marked read').toEqual([])
    expect(after.unread, 'the row is still unread').toBe('true')
    expect(gotSelected, 'the right-clicked row did not become the selection').toBe(false)
    expect(ctxOpen, 'the row carries the open mark').toBe('true')
    expect(after.ctxOpenGone, 'and drops it when the menu closes').toBeNull()
    expect(ariaCurrent, 'aria-current never moved').toBeNull()
    // C11 as written asks for the menu to MOVE and stay one. Recorded rather than assumed: the shared
    // backdrop owns the next right-click, so the honest answer may be zero (it ended it).
    console.log(`[${tag}] V3-3 C11 menusAfterSecondRightClick=${menus} boxOne=${JSON.stringify(boxOne)} boxTwo=${JSON.stringify(boxTwo)} owner=${JSON.stringify(owner)}`)
    expect(menus, 'never two menus at once').toBeLessThanOrEqual(1)
  })

  test('V3-4 C26 C74 C75: a real drag selects the row text, keeps the browser menu, and opens nothing', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    const posts: string[] = []
    const gets: string[] = []
    page.on('request', (r) => {
      const url = r.url()
      if (r.method() === 'POST' && /\/mail\//.test(url)) posts.push(url.split('/plugins/mail')[1] ?? url)
      if (r.method() === 'GET' && /\/messages\/[^?]+\/[^?]+$/.test(url)) gets.push(url.split('/messages/')[1]!)
    })
    const readerBefore = await readerShows(page)
    for (const part of ['.mail-row-subject-text', '.mail-row-snippet']) {
      const text = row(page, WRITER, KEEPER).locator(part).first()
      const box = (await text.boundingBox())!
      await page.mouse.move(box.x + 3, box.y + box.height / 2)
      await page.mouse.down()
      // Step, because one long move can arrive as a single event that selects nothing in WebKit.
      for (let at = 1; at <= 6; at += 1) {
        await page.mouse.move(box.x + 3 + (box.width - 6) * (at / 6), box.y + box.height / 2)
      }
      await page.mouse.up()
      const selection = await page.evaluate(() => {
        const sel = window.getSelection()
        return { collapsed: sel?.isCollapsed ?? true, text: (sel?.toString() ?? '').trim() }
      })
      console.log(`[${tag}] V3-4 ${part} collapsed=${selection.collapsed} text="${selection.text.slice(0, 40)}"`)
      expect(selection.collapsed, `${part} can be selected by hand`).toBe(false)
      expect(selection.text.length, `${part} selected real characters`).toBeGreaterThan(0)
      // Right-click INSIDE that selection: the browser's own Copy / Look Up is the better menu.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      await page.waitForTimeout(250)
      const menus = await page.locator(MENU).count()
      console.log(`[${tag}] V3-4 ${part} walnutMenus=${menus}`)
      expect(menus, 'the browser menu is kept on a live selection').toBe(0)
      await page.mouse.click(5, 5)
    }
    const after = await readerShows(page)
    console.log(`[${tag}] V3-4 posts=${JSON.stringify(posts)} gets=${JSON.stringify(gets)}`)
    expect(gets, 'a drag never opened the message').toEqual([])
    expect(posts.filter((one) => one.endsWith('/read')), 'and never marked it read').toEqual([])
    expect(after, 'the reader is untouched').toEqual(readerBefore)
  })

  test('V3-5 C3 C4 C43: the menu is whole in the corner, stable, and never wider than the viewport', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    const rows = page.locator('.mail-row')
    const last = rows.last()
    await last.scrollIntoViewIfNeeded()
    const box = (await last.boundingBox())!
    const view = page.viewportSize()!
    // As close to the bottom-right of the WINDOW as a row reaches.
    const x = Math.min(box.x + box.width - 2, view.width - 6)
    const y = Math.min(box.y + box.height - 2, view.height - 6)
    await page.mouse.click(x, y, { button: 'right' })
    await expect(page.locator(MENU)).toHaveCount(1)
    const first = (await page.locator(MENU).boundingBox())!
    const height = await page.locator(MENU).evaluate((el) => (el as HTMLElement).offsetHeight)
    const width = await page.locator(MENU).evaluate((el) => getComputedStyle(el).maxWidth)
    const overflow = await page.locator(MENU).evaluate((el) => getComputedStyle(el).overflowY)
    const controls = await page.locator(`${MENU} select, ${MENU} input, ${MENU} textarea`).count()
    await page.waitForTimeout(1_000)
    const height2 = await page.locator(MENU).evaluate((el) => (el as HTMLElement).offsetHeight)
    const after = (await page.locator(MENU).boundingBox())!
    await page.screenshot({ path: `${SHOTS}/${tag}-v3-5-corner.png` })
    console.log(`[${tag}] V3-5 click=(${x},${y}) box=${JSON.stringify(first)} view=${JSON.stringify(view)} h=${height}->${height2} maxWidth=${width} overflowY=${overflow} formControls=${controls}`)
    expect(first.x, 'left edge on screen').toBeGreaterThanOrEqual(0)
    expect(first.y, 'top edge on screen').toBeGreaterThanOrEqual(0)
    expect(first.x + first.width, 'right edge on screen').toBeLessThanOrEqual(view.width)
    expect(first.y + first.height, 'bottom edge on screen').toBeLessThanOrEqual(view.height)
    expect(height2, 'the menu did not grow after it opened').toBe(height)
    expect(after.y, 'and did not move').toBe(first.y)
    expect(controls, 'no form control inside the menu').toBe(0)
    expect(width.replace(/\s/g, ''), 'the width ceiling is the shared rule').toMatch(/min\(340px,100vw-16px\)|^\d+px$/)
  })

  test('V3-6 C17 C22 C24 C31: capability gates, and a merged row acts on its own account', async ({ page }) => {
    test.setTimeout(180_000)
    await openMail(page, port)
    // The account whose provider declares markRead: false.
    await expect(folderRow(page, READER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, READER, 'INBOX').click()
    await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 60_000 })
    await page.locator('.mail-row').first().click({ button: 'right', position: { x: 12, y: 10 } })
    const readerLabels = (await page.locator(`${MENU} [role="menuitem"]`).allInnerTexts()).map((one) => one.trim())
    const disabledSend = await page.locator(`${MENU} [role="menuitem"][disabled]`).allInnerTexts()
    // `hasText: /^Reply$/` would miss it: a disabled row draws its reason as a second line inside the
    // same button, so the item's innerText is two lines.
    const replyRow = page.locator(`${MENU} [role="menuitem"]`).filter({ hasText: /Reply/ }).first()
    const sendTitle = await replyRow.getAttribute('title').catch(() => null)
    const replyDisabled = await replyRow.isDisabled().catch(() => null)
    await page.keyboard.press('Escape')
    console.log(`[${tag}] V3-6 no-markRead account items=${JSON.stringify(readerLabels)} disabled=${JSON.stringify(disabledSend.map((o) => o.trim()))} replyTitle="${sendTitle}" replyDisabled=${replyDisabled}`)
    expect(readerLabels.some((one) => /^Mark as/.test(one)), 'no read item at all on a provider that cannot').toBe(false)
    // C31: the send items stay, disabled, with the reason a person can act on.
    expect(replyDisabled, 'Reply is disabled rather than missing when the account cannot send').toBe(true)
    expect(sendTitle, 'and says why').toBe('This account cannot send; add SMTP settings')
    // Merged list: All Inboxes holds both accounts, and the write must name the row's own account.
    await smartRow(page, 'inbox').click()
    await expect(page.locator(`.mail-row[data-account-id="${WRITER}"]`).first()).toBeVisible({ timeout: 60_000 })
    const both = await page.locator('.mail-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-account-id')))
    const writerRow = page.locator(`.mail-row[data-account-id="${WRITER}"][data-unread="true"]`).first()
    const readerRow = page.locator(`.mail-row[data-account-id="${READER}"]`).first()
    await readerRow.click({ button: 'right', position: { x: 12, y: 10 } })
    const readerHasRead = await page.locator(`${MENU} [role="menuitem"]`).filter({ hasText: /^Mark as/ }).count()
    await page.keyboard.press('Escape')
    const wantedId = await writerRow.getAttribute('data-message-id')
    const posted: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/read')) posted.push(decodeURIComponent(r.url().split('/messages/')[1]!)) })
    await writerRow.click({ button: 'right', position: { x: 12, y: 10 } })
    const writerHasRead = await page.locator(`${MENU} [role="menuitem"]`).filter({ hasText: /^Mark as/ }).count()
    await item(page, /^Mark as read$/).click()
    await page.waitForTimeout(1_500)
    console.log(`[${tag}] V3-6 merged accounts=${JSON.stringify([...new Set(both)])} readerItems=${readerHasRead} writerItems=${writerHasRead} posted=${JSON.stringify(posted)} wanted=${WRITER}/${wantedId}`)
    expect(new Set(both).size, 'the merged list really mixes accounts').toBeGreaterThan(1)
    expect(readerHasRead, 'the no-markRead account has no read item here either').toBe(0)
    expect(writerHasRead, 'the capable account does').toBe(1)
    expect(posted.length, 'exactly one write went out').toBe(1)
    expect(posted[0], 'and it named the row\'s own account and message').toBe(`${WRITER}/${wantedId}/read`)
  })

  test('V3-7 C34 C35: a folder row menu acts on the right-clicked pair, not the selection', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    const active = await page.locator('.mail-mailbox.active').getAttribute('data-mailbox-id')
    const other = folderRow(page, WRITER, 'Archive')
    const otherCount = await other.count()
    const target = otherCount ? other : folderRow(page, WRITER, 'INBOX')
    const targetId = await target.getAttribute('data-mailbox-id')
    const bodies: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/mailboxes/fetch')) bodies.push(r.postData() ?? '')
    })
    const rowsBefore = await page.locator('.mail-row').count()
    await target.click({ button: 'right', position: { x: 10, y: 8 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    const labels = (await page.locator(`${MENU} [role="menuitem"]`).allInnerTexts()).map((one) => one.trim())
    await page.screenshot({ path: `${SHOTS}/${tag}-v3-7-folder-menu.png` })
    await item(page, /^Fetch this folder now$/).click()
    await page.waitForTimeout(1_200)
    const stillActive = await page.locator('.mail-mailbox.active').getAttribute('data-mailbox-id')
    console.log(`[${tag}] V3-7 selected=${active}->${stillActive} target=${targetId} items=${JSON.stringify(labels)} body=${JSON.stringify(bodies)} rows=${rowsBefore}->${await page.locator('.mail-row').count()}`)
    expect(stillActive, 'the selection did not move').toBe(active)
    expect(bodies.length, 'one fetch went out').toBe(1)
    expect(bodies[0], 'for the right-clicked folder').toContain(`"mailboxId":"${targetId}"`)
    expect(bodies[0], 'and its own account').toContain(`"accountId":"${WRITER}"`)
    expect(labels.join('|'), 'no dead controls in the folder menu').not.toMatch(/Delete|Move|Archive this|Flag|Star|Mark all|Unsubscribe/)
  })

  test('V3-8 C42: the menu reads in light and in dark', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    for (const theme of ['Light', 'Dark'] as const) {
      await pickTheme(page, theme)
      await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 60_000 })
      await folderRow(page, WRITER, 'INBOX').click()
      await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 60_000 })
      await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      await page.locator(`${MENU} [role="menuitem"]`).nth(2).hover()
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${SHOTS}/${tag}-v3-8-${theme.toLowerCase()}.png` })
      const shot = await page.locator(MENU).screenshot({ path: `${SHOTS}/${tag}-v3-8-${theme.toLowerCase()}-menu.png` })
      console.log(`[${tag}] V3-8 ${theme} menu shot ${shot.length} bytes`)
      await page.keyboard.press('Escape')
    }
  })

  test('V3-9 C11: a right-click on another row while a menu is open, sampled in the page', async ({ page }) => {
    test.setTimeout(180_000)
    await intoInbox(page)
    const ids = await page.locator('.mail-row').evaluateAll((els) => els.map((el) => ({
      id: el.getAttribute('data-message-id'),
      account: el.getAttribute('data-account-id'),
      top: Math.round(el.getBoundingClientRect().top),
    })))
    console.log(`[${tag}] V3-9 rows=${JSON.stringify(ids)}`)
    const first = page.locator('.mail-row').first()
    const second = page.locator('.mail-row').nth(1)
    await first.click({ button: 'right', position: { x: 14, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    const box = (await second.boundingBox())!
    const menuBox = (await page.locator(MENU).boundingBox())!
    // A point on the SECOND row that the open menu does not cover: the menu is drawn from the cursor
    // rightward and downward, so the middle of a row below it is INSIDE the menu (this is what made the
    // first attempt, and the slice's own C11 case, right-click the menu itself and measure nothing).
    const spot = menuBox.x + menuBox.width + 6 < box.x + box.width
      ? { x: menuBox.x + menuBox.width + 6, y: box.y + box.height / 2 }
      : { x: box.x + 6, y: box.y + box.height / 2 }
    console.log(`[${tag}] V3-9 menuBox=${JSON.stringify(menuBox)} rowBox=${JSON.stringify(box)} spot=${JSON.stringify(spot)} covered=${spot.x >= menuBox.x && spot.x <= menuBox.x + menuBox.width && spot.y >= menuBox.y && spot.y <= menuBox.y + menuBox.height}`)
    await page.evaluate(() => {
      const win = window as unknown as { __v9?: unknown[] }
      const out: unknown[] = []
      win.__v9 = out
      const t0 = performance.now()
      const read = () => {
        const menu = document.querySelector('.wn-context-menu') as HTMLElement | null
        const marked = document.querySelector('.mail-row[data-ctx-open="true"]')
        out.push({
          t: Math.round(performance.now() - t0),
          menus: document.querySelectorAll('.wn-context-menu').length,
          top: menu ? Math.round(menu.getBoundingClientRect().top) : -1,
          row: marked?.getAttribute('data-message-id') ?? '',
        })
      }
      read()
      const timer = window.setInterval(read, 25)
      window.setTimeout(() => window.clearInterval(timer), 2_500)
    })
    await page.mouse.click(spot.x, spot.y, { button: 'right' })
    await page.waitForTimeout(2_000)
    const samples = await page.evaluate(() => (window as unknown as { __v9: unknown[] }).__v9) as {
      t: number, menus: number, top: number, row: string,
    }[]
    const most = Math.max(...samples.map((one) => one.menus))
    const shapes = [...new Set(samples.map((one) => `${one.menus}@${one.top}/${one.row}`))]
    console.log(`[${tag}] V3-9 clickedRow=${await second.getAttribute('data-message-id')} maxMenus=${most} shapes=${JSON.stringify(shapes)}`)
    console.log(`[${tag}] V3-9 last=${JSON.stringify(samples[samples.length - 1])}`)
    expect(most, 'never two menus at once').toBeLessThanOrEqual(1)
  })
})
