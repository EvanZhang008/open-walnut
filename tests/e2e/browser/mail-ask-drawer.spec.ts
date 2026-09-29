/**
 * The Walnut group of the message row menu, driven as a person drives it (S4).
 *
 * The promise being graded is that three menu rows turn one mail into an ordinary Ask Walnut session,
 * drawn by the same panels as every other session, and that the session is about THAT mail and only
 * made once:
 *
 *   1. The group is the last thing in the menu, under its own name, and each of its rows carries the
 *      shared ✦ mark (`data-ai="true"`) WITHOUT indenting any other row: the mark rides inside the
 *      label, because the icon column this menu never draws would shift only this group's words.
 *   2. `Draft a reply with Walnut` is disabled with the SMTP reason on an account that cannot send,
 *      and absent on mail this person wrote. The other two never need SMTP.
 *   3. The drawer takes the READER's pane, its draft composer takes the caret, and Escape gives the
 *      pane back and the keyboard to the row the menu opened from.
 *   4. ONE session per mail: the first question POSTs `/api/sessions/quick-start` once, and a second
 *      open lands in the same session.
 *   5. `Summarize` and `Draft a reply` start the session with their question at once. The launch
 *      carries the context block (From, Subject, Date, the Walnut link, the body quoted with `> `) as a
 *      leading `[Mail you are asking about]` block, which the session panel folds into one row so the
 *      bubble reads as the question. `Ask Walnut about this…` starts nothing until the person types.
 *   6. Identity is the PAIR. In a merged list two accounts can hold the same provider message id, and
 *      the dense fixture really does (`shared-8042`): the two rows must open two different sessions.
 *   7. Its session panel's Locate takes the person to that task on Home.
 *   8. Escape belongs to an open menu first: with the composer's + menu open it closes the menu and
 *      leaves the drawer, and only the next Escape closes the drawer.
 *   9. A second canned question asked while the first launch is still out joins that launch and goes
 *      into the same session as a follow-up: one quick-start, both questions answered.
 *  10. The draft is the Home draft's fork: Ask Walnut by default, Start Task one card away (it needs a
 *      folder, and runs there with the mail as its context), a task that starts in Focus, and More for
 *      its fields. "Save as todo" files the text with the mail in its description.
 *
 * Two fixtures, because the two halves need opposite installs: `PW_MAIL_CTX=1` is the small mailbox
 * with one account that can send and one that cannot, and `PW_MAIL_DENSE=1` is the production-density
 * pair that holds one message id twice. The model never runs for real: sessions run
 * `tests/providers/mock-claude.mjs`, and these cases assert the LAUNCH and the mock's echo of each
 * question (what the menu did) rather than an answer (what a model would say).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { draftCwdPill, draftTaskMenu, openDraftSettings, draftSend } from './draft-helpers'
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
/**
 * The group's fourth row, added by the unsubscribe slice. It sits LAST on purpose (it is the one row
 * here that acts on the world instead of opening a chat, so a stray click is least likely to land on
 * it); its own states and copy are graded in `mail-unsubscribe.spec.ts`.
 */
const UNSUBSCRIBE = 'Unsubscribe'

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

/** The user turns in the drawer's session, oldest first. */
function userTurns(page: Page): Locator {
  return drawer(page).locator('.session-msg-user')
}

/** The drawer's draft panel (before the first question). */
function draftPanel(page: Page): Locator {
  return drawer(page).locator('.draft-session-panel')
}

/** One of the draft's two mode cards. */
function intentCard(page: Page, label: 'Ask Walnut' | 'Start Task'): Locator {
  return draftPanel(page).locator('.draft-intent-card', { hasText: label })
}

/** Point the drawer's Start Task draft at `cwd` through the folder picker (it may already be open: a
 *  Start with no folder opens it). */
async function pickFolder(page: Page, cwd: string): Promise<void> {
  const picker = page.locator('.session-path-selector')
  if (!(await picker.isVisible())) await draftCwdPill(draftPanel(page)).click()
  await expect(picker).toBeVisible({ timeout: 10_000 })
  const input = picker.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(draftPanel(page))).toContainText(path.basename(cwd))
}

/** Every task create (POST /api/tasks), with its body. */
function recordTaskCreates(page: Page): { bodies: Record<string, unknown>[] } {
  const record = { bodies: [] as Record<string, unknown>[] }
  page.on('request', (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/tasks') return
    try { record.bodies.push(request.postDataJSON() as Record<string, unknown>) } catch { record.bodies.push({}) }
  })
  return record
}

/** The drawer's session body, once there is one; its `data-session-id` is the session. */
function sessionBody(page: Page): Locator {
  return drawer(page).getByTestId('ask-object-session')
}

interface LaunchBody {
  message?: string
  walnutAgent?: boolean
  project?: string
  cwd?: string
  taskMeta?: { pinTier?: unknown }
}

/** Every quick-start POST (one ask session each), with its body, for the whole page's life. */
function recordLaunches(page: Page): { bodies: LaunchBody[]; results: Array<{ taskId?: string; sessionId?: string }> } {
  const record = { bodies: [] as LaunchBody[], results: [] as Array<{ taskId?: string; sessionId?: string }> }
  const isLaunch = (method: string, url: string) => method === 'POST' && new URL(url).pathname === '/api/sessions/quick-start'
  page.on('request', (request) => {
    if (!isLaunch(request.method(), request.url())) return
    try { record.bodies.push(request.postDataJSON() as LaunchBody) } catch { record.bodies.push({}) }
  })
  page.on('response', (response) => {
    if (!isLaunch(response.request().method(), response.url())) return
    response.json().then((json) => { record.results.push(json as { taskId?: string; sessionId?: string }) }, () => {})
  })
  return record
}

/**
 * The mock CLI's answers in the drawer's session: it echoes every message it is sent
 * (`Hello! I processed your message: <message>`), so an answer carrying a question is proof the
 * session received that question. The USER row itself is not graded here: the default mock writes no
 * transcript, so a fresh session's history has no user line to draw (the fold of the context block
 * into one row is graded on `splitLeadingBanners` in tests/web/ask-object-session.test.ts and against
 * a real CLI before a deploy).
 */
function answers(page: Page, question: RegExp): Locator {
  return drawer(page).locator('.session-msg-assistant').filter({ hasText: question })
}

// ───────────────────────────────── the small mailbox ─────────────────────────────────

test.describe('the Walnut group, on a mailbox whose second account cannot send', () => {
  const server = new MailFixtureServer()
  let port = 0
  /** A real folder inside the fixture's throwaway home, for the Start Task cases. */
  let folder = ''

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    // `PW_MAIL_DENSE` emptied rather than omitted: the helper defaults it on, and two linked providers
    // double every count and put two options in the add-an-account dialog.
    const fixture = await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })
    port = fixture.port
    folder = path.join(fixture.home, 'work', 'marina-app')
    await fs.mkdir(folder, { recursive: true })
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

    // Last four items, in the designed order.
    expect((await itemLabels(page)).slice(-4)).toEqual([SUMMARIZE, DRAFT_REPLY, ASK, UNSUBSCRIBE])

    // Its name is an `info` row (not focusable, not uppercased), and it is the LAST info row.
    const info = menu(page).locator('.wn-context-menu-info')
    await expect(info.last()).toHaveText('Walnut')
    // `section` uppercases; this must read as written, like the two title lines above it.
    await expect(info.last()).toHaveCSS('text-transform', 'none')

    // Exactly four rows are marked, and each draws one ✦ inside its own label.
    const marked = menu(page).locator('[role="menuitem"][data-ai="true"]')
    await expect(marked).toHaveCount(4)
    for (const label of [SUMMARIZE, DRAFT_REPLY, ASK, UNSUBSCRIBE]) {
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
    // By its WORDS, not by position: the unsubscribe row below draws a reason line of its own, so
    // `.last()` graded that one instead of this one. Not a count either, because on an account with no
    // outgoing mail more than one row can honestly give this same reason (a mailto-only list is the
    // other one) and the point here is that the sentence is on screen for somebody without a mouse.
    await expect(menu(page).getByTestId('wn-context-menu-reason').filter({ hasText: CANNOT_SEND }).first())
      .toBeVisible()
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
    // `Ask` opens the ordinary draft panel, lands the caret in its composer, and starts nothing.
    await expect(drawer(page)).toHaveAttribute('data-view', 'compose')
    await expect(drawer(page).locator('.draft-session-panel textarea')).toBeFocused()
    // The Home draft's fork, Ask Walnut chosen, and More for the task fields.
    await expect(intentCard(page, 'Ask Walnut')).toHaveAttribute('aria-pressed', 'true')
    await expect(intentCard(page, 'Start Task')).toHaveAttribute('aria-pressed', 'false')
    await expect(draftPanel(page).locator('.draft-launch-bar button.draft-more-btn')).toBeVisible()
    await expect(userTurns(page)).toHaveCount(0)
    console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'ask-compose')}`)

    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    // The reader comes back untouched, and the keyboard is on the row the menu opened from.
    await expect(page.getByTestId('mail-reader')).toBeVisible()
    await expect(row(page, WRITER, KEEPER)).toBeFocused()
  })

  test('S4-4: Summarize starts one session whose first turn folds the context block', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, KEEPER, SUMMARIZE)

    await expect.poll(() => launches.bodies.length, { timeout: 60_000 }).toBe(1)
    const body = launches.bodies[0]
    // An ordinary Ask Walnut launch that does not pin itself anywhere.
    expect(body.walnutAgent).toBe(true)
    expect(body.project).toBe('Ask Walnut')
    expect(body.cwd).toBe('')
    // A new task starts in Focus, like every task a draft launches (More changes it).
    expect(body.taskMeta?.pinTier).toBe('focus')
    // The headers a model cannot see on screen, inside the named block, then the question.
    const message = body.message ?? ''
    expect(message.startsWith('[Mail you are asking about]\n')).toBe(true)
    expect(message).toContain('\n[/Mail you are asking about]\n\n')
    expect(message).toContain('From: ')
    expect(message).toContain('Subject: Quarterly keeper report')
    expect(message).toContain('Date: ')
    // The Walnut deep link back to THIS console, with both ids.
    expect(message).toMatch(new RegExp(`Link: http://127\\.0\\.0\\.1:${port}/mail\\?`))
    expect(message).toContain(encodeURIComponent(WRITER))
    // The body, quoted line by line, which is what makes a hostile line harmless.
    expect(message).toContain('> ')
    expect(message.split('[/Mail you are asking about]')[1]).toMatch(/summarize this mail/i)

    // On screen: the regular session panel, and the session answered the question it was started with.
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    await expect(sessionBody(page).locator('.session-panel')).toBeVisible()
    await expect(answers(page, /processed your message: \[Mail you are asking about\]/)).toHaveCount(1, { timeout: 90_000 })
    await expect(answers(page, /summarize this mail/i)).toHaveCount(1)
    console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'summarize-session')}`)
  })

  test('S4-5: Draft a reply asks for a draft and names the approval, never a send', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, LUNCH, DRAFT_REPLY)
    await expect.poll(() => launches.bodies.length, { timeout: 60_000 }).toBe(1)
    const question = (launches.bodies[0].message ?? '').split('[/Mail you are asking about]')[1] ?? ''
    expect(question).toMatch(/do not send/i)
    expect(question).toContain('mail_request_send')
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    // No composer was opened and no draft was written: this is a question, not a reply.
    await expect(page.locator('.mail-composer-pane')).toHaveCount(0)
  })

  test('S4-6: one mail is ONE session across opens, and a second canned question goes into it', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)

    // Ask mode starts nothing until the person types; the first question is the launch.
    await ask(page, WRITER, KEEPER, ASK)
    await expect(drawer(page)).toHaveAttribute('data-view', 'compose')
    const composer = drawer(page).locator('.draft-session-panel textarea')
    await composer.fill('Who sends this report?')
    await composer.press('Enter')
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const first = await sessionBody(page).getAttribute('data-session-id')
    expect(launches.bodies).toHaveLength(1)
    await expect(answers(page, /Who sends this report\?/)).toHaveCount(1, { timeout: 90_000 })
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    // Reopened: the same session, nothing new started, and Ask mode still lands the caret in its composer.
    await ask(page, WRITER, KEEPER, ASK)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', first!, { timeout: 60_000 })
    expect(launches.bodies).toHaveLength(1)
    await expect(sessionBody(page).locator('textarea.chat-input-textarea')).toBeFocused({ timeout: 30_000 })

    // A canned question on the same mail goes INTO that session rather than starting another.
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    await ask(page, WRITER, KEEPER, SUMMARIZE)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', first!, { timeout: 60_000 })
    // By its words, not by `.session-msg-assistant`: this mock writes no transcript, so a reopened drawer
    // can still be drawing the reply from the live stream block (and the first `session:send` carries the
    // one-time rich-output note, whose echoed "```html-app" leaves a building placeholder after the words).
    const summarized = sessionBody(page).getByText(/Hello! I processed your message: Summarize this mail/)
    await expect(summarized).toHaveCount(1, { timeout: 90_000 })
    expect(launches.bodies).toHaveLength(1)
    // And asked once: the same entry again opens the session without asking a second time.
    await page.keyboard.press('Escape')
    await ask(page, WRITER, KEEPER, SUMMARIZE)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', first!, { timeout: 60_000 })
    // Held a moment so a second send would have had time to be answered: absence needs a window.
    await page.waitForTimeout(3_000)
    await expect(summarized).toHaveCount(1)

    // A DIFFERENT mail is a different session, which is the other half of the same rule.
    await page.keyboard.press('Escape')
    await ask(page, WRITER, LUNCH, SUMMARIZE)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const second = await sessionBody(page).getAttribute('data-session-id')
    expect(second).not.toBe(first)
    expect(launches.bodies).toHaveLength(2)
  })

  test('S4-12: Escape with a composer menu open closes the menu, not the drawer', async ({ page }) => {
    await openWriterInbox(page)
    await ask(page, WRITER, LUNCH, SUMMARIZE)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const plus = sessionBody(page).locator('button[aria-haspopup="menu"]').first()
    await plus.click()
    await expect(sessionBody(page).locator('.chat-plus-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sessionBody(page).locator('.chat-plus-menu')).toHaveCount(0)
    await expect(drawer(page)).toBeVisible()
    // With nothing open, the next Escape is the drawer's.
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
  })

  test('S4-13: a second canned question asked while the first is starting reaches the same session', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    // Hold the launch, so the second question lands while the first is still out.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/sessions/quick-start', async (route) => { await held; await route.continue() })
    await ask(page, WRITER, KEEPER, SUMMARIZE)
    await expect(drawer(page)).toHaveAttribute('data-view', 'starting')
    await openRowMenu(page, WRITER, KEEPER)
    await clickItem(page, DRAFT_REPLY)
    await page.waitForTimeout(500)
    release()

    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    await expect(answers(page, /processed your message: \[Mail you are asking about\]/)).toHaveCount(1, { timeout: 90_000 })
    // Matched anywhere in the session, not only on a settled answer row: the follow-up lands mid-turn,
    // and the mock's echo of it can still be the live streaming block when the assertion runs.
    await expect(sessionBody(page).getByText(/Hello! I processed your message: Draft a reply to this mail/))
      .toHaveCount(1, { timeout: 90_000 })
    // One session: the second question joined the first launch instead of starting another.
    expect(launches.bodies).toHaveLength(1)
    await page.unroute('**/api/sessions/quick-start')
  })

  test('S4-14: Start Task runs in a picked folder, in Focus, with the mail as its context', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, KEEPER, ASK)
    await intentCard(page, 'Start Task').click()
    await expect(intentCard(page, 'Start Task')).toHaveAttribute('aria-pressed', 'true')
    // Still about the mail.
    await expect(drawer(page).getByTestId('ask-object-quote')).toContainText('Quarterly keeper report')

    // A Start with no folder says so, opens the picker, keeps the text and starts nothing.
    const composer = draftPanel(page).locator('textarea.chat-input-textarea')
    await composer.fill('Write the reply as a script in this repo')
    await draftSend(draftPanel(page)).click()
    await expect(draftPanel(page).getByTestId('draft-needs-folder')).toBeVisible()
    await expect(composer).toHaveValue('Write the reply as a script in this repo')
    expect(launches.bodies).toHaveLength(0)

    await pickFolder(page, folder)
    // More opens on the default Focus, and its Escape closes the menu, not the drawer.
    const menu = await openDraftSettings(draftPanel(page), 'more')
    await expect(menu.locator('.task-kebab-tier-label')).toHaveText('Pinned')
    await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Focus/)
    await page.keyboard.press('Escape')
    await expect(draftTaskMenu(page)).toHaveCount(0)
    await expect(drawer(page)).toBeVisible()
    console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'start-task-draft')}`)

    await draftSend(draftPanel(page)).click()
    await expect.poll(() => launches.bodies.length, { timeout: 60_000 }).toBe(1)
    const body = launches.bodies[0] as LaunchBody & { host?: string; projectFromFolder?: boolean }
    expect(body.cwd).toBe(folder)
    expect(body.walnutAgent).toBeUndefined()
    expect(body.project).toBe('marina-app')
    expect(body.projectFromFolder).toBe(true)
    expect(body.taskMeta?.pinTier).toBe('focus')
    const message = body.message ?? ''
    expect(message.startsWith('[Mail you are asking about]\n')).toBe(true)
    expect(message).toContain('Subject: Quarterly keeper report')
    expect(message.split('[/Mail you are asking about]')[1]?.trim()).toBe('Write the reply as a script in this repo')

    // The regular session panel, in the drawer, answering in that folder.
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    await expect(answers(page, /Write the reply as a script in this repo/)).toHaveCount(1, { timeout: 90_000 })
    const sessionId = await sessionBody(page).getAttribute('data-session-id')
    await expect.poll(() => launches.results.length).toBe(1)
    const launched = launches.results[0]
    // And the task it made is in Focus, filed under the folder's project, its session in that folder.
    // The mail fixture's own server, not the Playwright config's baseURL (a different fixture).
    const api = `http://localhost:${port}`
    expect(launched.sessionId).toBe(sessionId)
    const { session } = await (await page.request.get(`${api}/api/sessions/${sessionId}`)).json() as { session: { taskId: string; cwd?: string } }
    expect(session).toMatchObject({ taskId: launched.taskId, cwd: folder })
    const { task } = await (await page.request.get(`${api}/api/tasks/${launched.taskId}`)).json() as { task: { project?: string; pinned?: boolean; focus_tier?: string } }
    expect(task.project).toBe('marina-app')
    expect(task.pinned).toBe(true)
    // `focus_tier` absent would mean Satellite, so the tier is read, not defaulted.
    expect(task.focus_tier).toBe('focus')

    // Reopened: the same session, not a new draft.
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    await ask(page, WRITER, KEEPER, ASK)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', sessionId!, { timeout: 60_000 })
    expect(launches.bodies).toHaveLength(1)
  })

  test('S4-15: More on the Ask Walnut draft picks the tier the ask is filed in', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, LUNCH, ASK)
    const menu = await openDraftSettings(draftPanel(page), 'more')
    await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Satellite' }).click()
    await expect(draftTaskMenu(page)).toHaveCount(0)
    const composer = draftPanel(page).locator('textarea.chat-input-textarea')
    await composer.fill('When is lunch?')
    await composer.press('Enter')
    await expect.poll(() => launches.bodies.length, { timeout: 60_000 }).toBe(1)
    expect(launches.bodies[0].walnutAgent).toBe(true)
    expect(launches.bodies[0].taskMeta?.pinTier).toBe('satellite')
    await expect(answers(page, /When is lunch\?/)).toHaveCount(1, { timeout: 90_000 })
  })

  test('S4-16: Save as todo files the text with the mail in its description', async ({ page }) => {
    const creates = recordTaskCreates(page)
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, KEEPER, ASK)
    // Walnut mode has no such exit: it would file the question with nothing to answer it.
    await expect(draftPanel(page).locator('.draft-later-btn')).toHaveCount(0)
    await intentCard(page, 'Start Task').click()
    const composer = draftPanel(page).locator('textarea.chat-input-textarea')
    await composer.fill('Reply to the keeper\nBefore the May opening.')
    await draftPanel(page).locator('.draft-later-btn').click()

    await expect(drawer(page)).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => creates.bodies.length, { timeout: 30_000 }).toBe(1)
    const body = creates.bodies[0] as { title?: string; description?: string; pinned?: boolean; focus_tier?: string }
    expect(body.title).toBe('Reply to the keeper')
    expect(body.description).toContain('Before the May opening.')
    expect(body.description).toContain('Subject: Quarterly keeper report')
    expect(body.description).toMatch(/Link: http:\/\/127\.0\.0\.1:\d+\/mail\?/)
    expect(body).toMatchObject({ pinned: true, focus_tier: 'focus' })
    expect(launches.bodies).toHaveLength(0)
    // The notice says so and can find it on Home.
    const notice = page.getByText('Task created: Reply to the keeper')
    await expect(notice).toBeVisible({ timeout: 15_000 })
  })

  test('S4-11: Locate in the drawer\'s session finds the task on Home', async ({ page }) => {
    const launches = recordLaunches(page)
    await openWriterInbox(page)
    await ask(page, WRITER, KEEPER, SUMMARIZE)
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const sessionId = await sessionBody(page).getAttribute('data-session-id')
    const locate = sessionBody(page).getByTestId('session-panel-locate')
    await expect(locate).toBeVisible({ timeout: 60_000 })
    await expect(locate).toHaveAttribute('aria-label', 'Find on Home')
    await locate.click()

    // Home, with the ask's task selected in the task panel and its session in the chat slot, where
    // every ask lives, and NOT a second copy of it in a session column beside the slot.
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator(`[data-testid="ask-walnut-session"][data-session-id="${sessionId}"]`))
      .toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`.main-page-session-column [data-session-id="${sessionId}"]`)).toHaveCount(0)
    // Selected where it is drawn: an ask starts in Focus, so its row is the tier's active card (a
    // listed task would be a focused row). By the task's id, not by its title: every ask is "Ask Walnut".
    const selected = page.locator('#home-task-navigation').locator('.task-focused, .todo-pinned-card-active')
    await expect(selected).toHaveCount(1, { timeout: 30_000 })
    await expect(selected).toHaveAttribute('data-task-id', launches.results[0]?.taskId ?? 'no launch result')
    console.log(`shot: ${await shoot(page, SHOT_DIR, 'find-on-home')}`)
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
    // A reply composer with text the server does not have. The SAVE IS BROKEN on purpose rather than
    // raced: betting that the 800ms autosave debounce is still pending two UI actions later is a bet
    // this case kept losing (it passed or failed by how fast the machine was, which says nothing about
    // the guard). A refused save is the same state the guard exists for, held still.
    let refuse = true
    await page.route('**/api/plugins/mail/drafts/**', async (route) => {
      if (!refuse || route.request().method() !== 'PATCH') { await route.continue(); return }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture', message: 'the fixture refused this save' }),
      })
    })
    await openRowMenu(page, WRITER, KEEPER)
    await clickItem(page, 'Reply')
    await expect(page.getByTestId('mail-composer')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('mail-compose-body').fill('A sentence that is still only in the browser.')
    // Held there: `failed`/`retrying` is what `isSaveSettled` reads, and it does not time out.
    await expect(page.getByTestId('mail-compose-save'))
      .toHaveAttribute('data-state', /failed|retrying/, { timeout: 60_000 })

    await openRowMenu(page, WRITER, LUNCH)
    await clickItem(page, SUMMARIZE)
    // Refused: the composer keeps the pane, and the row note says what to do about it.
    await expect(drawer(page)).toHaveCount(0)
    await expect(page.getByTestId('mail-composer')).toBeVisible()
    await expect(page.getByTestId('mail-row-note')).toContainText('not saved yet', { timeout: 30_000 })
    console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'dirty-draft-refusal')}`)

    // Once the draft has settled the same click is allowed, and the composer gives the pane up. The
    // save is let through again and the composer's own retry is what saves it: nothing here re-types.
    refuse = false
    await page.getByTestId('mail-compose-body').fill('A sentence that is still only in the browser, edited.')
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

  test('S4-10: the two rows open two different sessions', async ({ page }) => {
    const launches = recordLaunches(page)
    await openMail(page, port)
    // All Inboxes: one list across both accounts, which is where the collision is visible.
    await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
    await expect(row(page, HARBOUR, SHARED)).toBeVisible({ timeout: 90_000 })
    await expect(row(page, MARINA, SHARED)).toBeVisible()

    await ask(page, HARBOUR, SHARED, SUMMARIZE)
    const first = await drawer(page).getAttribute('data-object-key')
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const firstSession = await sessionBody(page).getAttribute('data-session-id')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await ask(page, MARINA, SHARED, SUMMARIZE)
    const second = await drawer(page).getAttribute('data-object-key')
    await expect(sessionBody(page)).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
    const secondSession = await sessionBody(page).getAttribute('data-session-id')

    expect(first).toContain(HARBOUR)
    expect(second).toContain(MARINA)
    expect(second).not.toBe(first)
    expect(secondSession).not.toBe(firstSession)
    // Two mails, two sessions: the pair is the identity, never the message id alone.
    expect(launches.bodies).toHaveLength(2)
  })
})
