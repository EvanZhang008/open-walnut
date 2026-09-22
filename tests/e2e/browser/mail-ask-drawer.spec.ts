/**
 * The Walnut group of the message row menu, driven as a person drives it (S4).
 *
 * The promise being graded is that three menu rows turn one mail into a conversation, and that the
 * conversation is about THAT mail and only made once:
 *
 *   1. The group is the last thing in the menu, under its own name, and each of its rows carries the
 *      shared ✦ mark (`data-ai="true"`) WITHOUT indenting any other row: the mark rides inside the
 *      label, because the icon column this menu never draws would shift only this group's words.
 *   2. `Draft a reply with Walnut` is disabled with the SMTP reason on an account that cannot send,
 *      and absent on mail this person wrote. The other two never need SMTP.
 *   3. The drawer takes the READER's pane, its composer takes the caret, and Escape gives the pane
 *      back and the keyboard to the row the menu opened from.
 *   4. ONE conversation per mail: opening the same row twice POSTs `/conversations` once, and the
 *      second open lands in the same chat.
 *   5. `Summarize` and `Draft a reply` send their question immediately (one visible user turn, whose
 *      text is the context block: From, Subject, Date, the Walnut link, and the body quoted with `> `);
 *      `Ask Walnut about this…` sends nothing.
 *   6. Identity is the PAIR. In a merged list two accounts can hold the same provider message id, and
 *      the dense fixture really does (`shared-8042`): the two rows must open two different drawers.
 *
 * Two fixtures, because the two halves need opposite installs: `PW_MAIL_CTX=1` is the small mailbox
 * with one account that can send and one that cannot, and `PW_MAIL_DENSE=1` is the production-density
 * pair that holds one message id twice. The model never runs for real: the fixture points the main
 * agent at `tests/providers/mock-main-agent.mjs`, and these cases assert the USER turn (what the menu
 * did) rather than an answer (what a model would say).
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-ask-drawer/chromium'

/** The two accounts `PW_MAIL_CTX=1` adopts: the second one has no SMTP. */
const WRITER = 'fixture:ctx-writer@example.invalid'
const READER = 'inbound:ctx-reader@example.invalid'

const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'
const NOTICE = 'INBOX:2:11'

const MENU = 'mail-row-ctx-menu'
const DRAWER = 'ask-object-drawer'

const SUMMARIZE = 'Summarize with Walnut'
const DRAFT_REPLY = 'Draft a reply with Walnut'
const ASK = 'Ask Walnut about this…'

/** `CANNOT_SEND_TITLE` (web/src/apps/mail/compose/send-status.ts), quoted so a reword is caught here. */
const CANNOT_SEND = 'This account cannot send; add SMTP settings'

test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => { console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

function menu(page: Page): Locator {
  return page.getByTestId(MENU)
}

function drawer(page: Page): Locator {
  return page.getByTestId(DRAWER)
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

async function openRowMenu(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

/** Right-click a row and take one of the three Walnut rows, then wait for the drawer. */
async function ask(page: Page, accountId: string, messageId: string, label: string): Promise<void> {
  await openRowMenu(page, accountId, messageId)
  await clickItem(page, label)
  // The body is read first (the same read a reply does), so the drawer arrives a round trip later.
  await expect(drawer(page)).toBeVisible({ timeout: 60_000 })
}

/** The user turns in the drawer's chat, oldest first. */
function userTurns(page: Page): Locator {
  return drawer(page).locator('.chat-message-user')
}

/** Every POST that made a conversation, counted for the whole page's life. */
function countConversationPosts(page: Page): { total: () => number } {
  let total = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    if (/\/api\/agents\/[^/]+\/conversations$/.test(new URL(request.url()).pathname)) total += 1
  })
  return { total: () => total }
}

// ───────────────────────────────── the small mailbox ─────────────────────────────────

test.describe('the Walnut group, on a mailbox whose second account cannot send', () => {
  const server = new MailFixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    // `PW_MAIL_DENSE` emptied rather than omitted: the helper defaults it on, and two linked providers
    // double every count and put two options in the add-an-account dialog.
    port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
  })

  test.afterAll(async () => { await server.stop() })

  async function openWriterInbox(page: Page): Promise<void> {
    await openMail(page, port).catch(async (error: unknown) => {
      console.log(`shot: ${await shoot(page, SHOT_DIR, 'no-pane')}`)
      throw error
    })
    await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, WRITER, 'INBOX').click()
    await expect(row(page, WRITER, KEEPER)).toBeVisible({ timeout: 90_000 })
  }

  test('S4-1: the group is last, named Walnut, and every row of it carries the ✦', async ({ page }) => {
    await openWriterInbox(page)
    await openRowMenu(page, WRITER, KEEPER)

    // Last three items, in the designed order.
    expect((await itemLabels(page)).slice(-3)).toEqual([SUMMARIZE, DRAFT_REPLY, ASK])

    // Its name is an `info` row (not focusable, not uppercased), and it is the LAST info row.
    const info = menu(page).locator('.wn-context-menu-info')
    await expect(info.last()).toHaveText('Walnut')
    // `section` uppercases; this must read as written, like the two title lines above it.
    await expect(info.last()).toHaveCSS('text-transform', 'none')

    // Exactly three rows are marked, and each draws one ✦ inside its own label.
    const marked = menu(page).locator('[role="menuitem"][data-ai="true"]')
    await expect(marked).toHaveCount(3)
    for (const label of [SUMMARIZE, DRAFT_REPLY, ASK]) {
      await expect(item(page, label)).toHaveAttribute('data-ai', 'true')
      await expect(item(page, label).locator('.wn-context-menu-label .wn-context-ai-mark svg')).toHaveCount(1)
    }

    // THE INDENT RULE: the mark rides inside the label, so every row's words start at the same x.
    const starts = await menu(page).locator('[role="menuitem"] .wn-context-menu-label').evaluateAll(
      (labels) => labels.map((one) => Math.round(one.getBoundingClientRect().left)),
    )
    expect(new Set(starts).size).toBe(1)
    // And no row draws the 14px icon column at all.
    await expect(menu(page).locator('.wn-context-menu-icon')).toHaveCount(0)
    console.log(`shot: ${await shoot(menu(page), SHOT_DIR, 'walnut-group')}`)
  })

  test('S4-2: Draft a reply is disabled with the reason on an account with no SMTP', async ({ page }) => {
    await openMail(page, port)
    await expect(folderRow(page, READER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, READER, 'INBOX').click()
    await expect(row(page, READER, NOTICE)).toBeVisible({ timeout: 90_000 })
    await openRowMenu(page, READER, NOTICE)

    await expect(item(page, DRAFT_REPLY)).toBeDisabled()
    await expect(item(page, DRAFT_REPLY)).toHaveAttribute('title', CANNOT_SEND)
    // The reason is drawn as its own row under the group as well, for anyone without a mouse.
    await expect(menu(page).getByTestId('wn-context-menu-reason').last()).toContainText(CANNOT_SEND)
    // Asking a question needs no SMTP.
    await expect(item(page, SUMMARIZE)).toBeEnabled()
    await expect(item(page, ASK)).toBeEnabled()
    console.log(`shot: ${await shoot(menu(page), SHOT_DIR, 'cannot-send')}`)
  })

  test('S4-3: the drawer takes the reader pane, and Escape gives it and the keyboard back', async ({ page }) => {
    await openWriterInbox(page)
    // A message open in the reader, so there is something for the drawer to replace and come back to.
    await row(page, WRITER, LUNCH).click()
    await expect(page.getByTestId('mail-reader')).toBeVisible({ timeout: 60_000 })

    await ask(page, WRITER, KEEPER, ASK)
    // One pane, three tenants: the reader is GONE while the drawer is up, and the two panes on the
    // left are untouched.
    await expect(page.getByTestId('mail-reader')).toHaveCount(0)
    await expect(page.locator('.mail-accounts-pane')).toBeVisible()
    await expect(row(page, WRITER, KEEPER)).toBeVisible()
    // The drawer names the mail it is about (KEEPER), not the one the reader was holding (LUNCH).
    await expect(drawer(page).getByTestId('ask-object-quote')).toContainText('Quarterly keeper report')
    await expect(drawer(page).getByTestId('ask-object-quote')).toContainText('Keeper Reports')
    await expect(drawer(page).getByTestId('ask-object-quote')).not.toContainText('Lunch tomorrow')
    // `Ask` lands the caret in the composer and sends nothing.
    await expect(drawer(page).locator('.plugin-chat-view textarea')).toBeFocused()
    await expect(userTurns(page)).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    // The reader comes back untouched, and the keyboard is on the row the menu opened from.
    await expect(page.getByTestId('mail-reader')).toBeVisible()
    await expect(row(page, WRITER, KEEPER)).toBeFocused()
  })

  test('S4-4: Summarize sends one turn carrying the whole context block', async ({ page }) => {
    await openWriterInbox(page)
    await ask(page, WRITER, KEEPER, SUMMARIZE)

    await expect(userTurns(page)).toHaveCount(1, { timeout: 60_000 })
    const sent = await userTurns(page).first().innerText()
    // The headers a model cannot see on screen.
    expect(sent).toContain('From: ')
    expect(sent).toContain('Subject: ')
    expect(sent).toContain('Date: ')
    // The Walnut deep link back to THIS console, with both ids.
    expect(sent).toMatch(new RegExp(`Link: http://127\\.0\\.0\\.1:${port}/mail\\?`))
    expect(sent).toContain(encodeURIComponent(WRITER))
    // The body, quoted line by line, which is what makes a hostile line harmless.
    expect(sent).toContain('> ')
    // And the question itself, which is what `Summarize` stands for.
    expect(sent).toMatch(/summarize this mail/i)
  })

  test('S4-5: Draft a reply asks for a draft and names the approval, never a send', async ({ page }) => {
    await openWriterInbox(page)
    await ask(page, WRITER, LUNCH, DRAFT_REPLY)
    await expect(userTurns(page)).toHaveCount(1, { timeout: 60_000 })
    const sent = await userTurns(page).first().innerText()
    expect(sent).toMatch(/do not send/i)
    expect(sent).toContain('mail_request_send')
    // No composer was opened and no draft was written: this is a conversation, not a reply.
    await expect(page.locator('.mail-composer-pane')).toHaveCount(0)
  })

  test('S4-6: two opens of one mail make ONE conversation, and land in the same chat', async ({ page }) => {
    const posts = countConversationPosts(page)
    await openWriterInbox(page)

    await ask(page, WRITER, KEEPER, ASK)
    const first = await drawer(page).getByTestId('ask-object-chat').getAttribute('data-conversation')
    expect(first).toBeTruthy()
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await ask(page, WRITER, KEEPER, ASK)
    await expect(drawer(page).getByTestId('ask-object-chat')).toHaveAttribute('data-conversation', first!)
    expect(posts.total()).toBe(1)

    // A DIFFERENT mail is a different conversation, which is the other half of the same rule.
    await page.keyboard.press('Escape')
    await ask(page, WRITER, LUNCH, ASK)
    const second = await drawer(page).getByTestId('ask-object-chat').getAttribute('data-conversation')
    expect(second).not.toBe(first)
    expect(posts.total()).toBe(2)
  })

  test('S4-7: the drawer is about the row the menu opened on, not the selected row', async ({ page }) => {
    await openWriterInbox(page)
    await row(page, WRITER, LUNCH).click()
    await expect(page.locator('.mail-row.selected')).toHaveAttribute('data-message-id', LUNCH)
    await ask(page, WRITER, KEEPER, SUMMARIZE)
    // The object key is the PAIR of the right-clicked row, both halves of it.
    const key = await drawer(page).getAttribute('data-object-key')
    expect(key).toContain(KEEPER)
    expect(key).toContain(WRITER)
    expect(key).not.toContain(LUNCH)
  })

  test('S4-8: a dirty draft keeps its pane, and says why', async ({ page }) => {
    await openWriterInbox(page)
    // A reply composer with text the server has not been told about yet. `fill` fires input, so the
    // 800ms autosave debounce is armed and `isSaveSettled()` is false for the next moment.
    await openRowMenu(page, WRITER, KEEPER)
    await clickItem(page, 'Reply')
    await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('mail-compose-body').fill('A sentence that is still only in the browser.')

    await openRowMenu(page, WRITER, LUNCH)
    await clickItem(page, SUMMARIZE)
    // Refused: the composer keeps the pane, and the row note says what to do about it.
    await expect(drawer(page)).toHaveCount(0)
    await expect(page.getByTestId('mail-composer')).toBeVisible()
    await expect(page.getByTestId('mail-row-note')).toContainText('not saved yet', { timeout: 30_000 })
    console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'dirty-draft-refusal')}`)

    // Once the draft has settled the same click is allowed, and the composer gives the pane up.
    await expect(page.getByTestId('mail-compose-save')).toHaveAttribute('data-state', 'saved', { timeout: 60_000 })
    await ask(page, WRITER, LUNCH, SUMMARIZE)
    await expect(page.getByTestId('mail-composer')).toHaveCount(0)
  })

  test('S4-9: the menu keeps one width for every row of one list', async ({ page }) => {
    await openWriterInbox(page)
    const widths: number[] = []
    for (const messageId of [KEEPER, LUNCH]) {
      await openRowMenu(page, WRITER, messageId)
      await expect(menu(page)).toHaveClass(/wn-context-menu-titled/)
      const box = await menu(page).boundingBox()
      widths.push(Math.round(box!.width))
      await page.keyboard.press('Escape')
      await expect(menu(page)).toHaveCount(0)
    }
    expect(widths[0]).toBe(widths[1])
  })
})

// ───────────────────────────── the merged list, at density ─────────────────────────────

test.describe('a merged list where two accounts hold the same message id', () => {
  const server = new MailFixtureServer()
  let port = 0

  /** The dense fixture's two accounts, and the one message id both of them hold. */
  const HARBOUR = 'dense:harbour'
  const MARINA = 'dense:marina'
  const SHARED = 'shared-8042'

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    port = (await server.start()).port
  })

  test.afterAll(async () => { await server.stop() })

  test('S4-10: the two rows open two different conversations', async ({ page }) => {
    const posts = countConversationPosts(page)
    await openMail(page, port)
    // All Inboxes: one list across both accounts, which is where the collision is visible.
    await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
    await expect(row(page, HARBOUR, SHARED)).toBeVisible({ timeout: 90_000 })
    await expect(row(page, MARINA, SHARED)).toBeVisible()

    await ask(page, HARBOUR, SHARED, ASK)
    const first = await drawer(page).getAttribute('data-object-key')
    const firstChat = await drawer(page).getByTestId('ask-object-chat').getAttribute('data-conversation')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await ask(page, MARINA, SHARED, ASK)
    const second = await drawer(page).getAttribute('data-object-key')
    const secondChat = await drawer(page).getByTestId('ask-object-chat').getAttribute('data-conversation')

    expect(first).toContain(HARBOUR)
    expect(second).toContain(MARINA)
    expect(second).not.toBe(first)
    expect(secondChat).not.toBe(firstChat)
    // Two mails, two conversations: the pair is the identity, never the message id alone.
    expect(posts.total()).toBe(2)
  })
})
