/**
 * The Walnut group and its drawer in WEBKIT, which is the engine the Mac app is (S4).
 *
 * Only what an engine can disagree about, which here is four things:
 *
 *   1. THE GESTURE. WebKit selects the word under the pointer as the default action of a right-press,
 *      before dispatching `contextmenu`, and a mail row's subject and snippet are selectable on
 *      purpose. So a right-click on a row's own WORDS has to reach Walnut's menu (the shared
 *      `selectionForGesture` rule stops counting a selection the press itself made) or these three
 *      rows are unreachable in the Mac app.
 *   2. THE GLYPH. The ✦ rides inside the label rather than in the icon column, and the thing that rule
 *      exists to prevent is an indent. WebKit lays an inline-flex span inside a text box with an
 *      ellipsis differently enough to be worth measuring here: every row's words must still start at
 *      the same x, and the row must not have grown taller than its neighbours.
 *   3. THE DRAWER. It is the reader pane's tenant and holds an ordinary session panel; the Mac app is
 *      where it will actually be used, so one full open/auto-send/Escape round trip is graded in this
 *      engine too.
 *   4. THE FORK. Start Task's folder picker and More are menus over the drawer, and WebKit leaves focus
 *      on <body> after a button click, so Escape has to find the open menu rather than a focused one.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file rather
 * than a project, and its helpers are inline: importing the Chromium spec would run all ten of its
 * cases in this engine as well.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { draftCwdPill, draftTaskMenu, openDraftSettings } from './draft-helpers'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-ask-drawer/webkit'

const WRITER = 'fixture:ctx-writer@example.invalid'
const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'

const MENU = 'mail-row-ctx-menu'
const DRAWER = 'ask-object-drawer'

const SUMMARIZE = 'Summarize with Walnut'
const DRAFT_REPLY = 'Draft a reply with Walnut'
const ASK = 'Ask Walnut about this…'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0
/** A real folder in the fixture's home, for the Start Task case. */
let folder = ''

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })
  port = fixture.port
  folder = path.join(fixture.home, 'work', 'marina-app')
  await fs.mkdir(folder, { recursive: true })
})

test.afterAll(async () => { await server.stop() })

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

function menu(page: Page): Locator {
  return page.getByTestId(MENU)
}

function drawer(page: Page): Locator {
  return page.getByTestId(DRAWER)
}

function item(page: Page, label: string): Locator {
  return menu(page).locator('[role="menuitem"]', { hasText: label }).first()
}

async function openWriterInbox(page: Page): Promise<void> {
  await openMail(page, port).catch(async (error: unknown) => {
    console.log(`shot: ${await shoot(page, SHOT_DIR, 'no-pane')}`)
    throw error
  })
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, KEEPER)).toBeVisible({ timeout: 90_000 })
}

test('S4-W1: the three rows are reachable by right-clicking the row\'s OWN WORDS', async ({ page }) => {
  await openWriterInbox(page)
  // The subject text is the exact point WebKit pre-selects a word at, and where the menu used to be
  // unreachable in the Mac app.
  await row(page, KEEPER).locator('.mail-row-subject-text').click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  for (const label of [SUMMARIZE, DRAFT_REPLY, ASK]) {
    await expect(item(page, label)).toHaveCount(1)
    await expect(item(page, label)).toHaveAttribute('data-ai', 'true')
  }
  console.log(`shot: ${await shoot(menu(page), SHOT_DIR, 'walnut-group-webkit')}`)
})

test('S4-W2: the ✦ indents nothing and grows no row', async ({ page }) => {
  await openWriterInbox(page)
  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)

  const shape = await menu(page).locator('[role="menuitem"]').evaluateAll((rows) => rows.map((one) => {
    const label = one.querySelector('.wn-context-menu-label') as HTMLElement
    return {
      labelLeft: Math.round(label.getBoundingClientRect().left),
      height: Math.round(one.getBoundingClientRect().height),
      marks: one.querySelectorAll('.wn-context-ai-mark').length,
    }
  }))

  // ONE left edge for every row's words: the marked rows are not indented for an icon column.
  expect(new Set(shape.map((one) => one.labelLeft)).size).toBe(1)
  // ONE row height: a 13px glyph inside a 16px line must not make its row taller than its siblings
  // (the shape that made one of three grouped rows 52px next to two 30px ones).
  expect(new Set(shape.map((one) => one.height)).size).toBe(1)
  // Exactly the Walnut rows carry a mark: the three ask rows plus Unsubscribe (S8).
  expect(shape.filter((one) => one.marks === 1)).toHaveLength(4)
  expect(shape.every((one) => one.marks <= 1)).toBe(true)
  console.log(`shot: ${await shoot(menu(page), SHOT_DIR, 'ai-mark-geometry')}`)
})

test('S4-W3: one full round trip in the engine the Mac app is', async ({ page }) => {
  await openWriterInbox(page)
  // Something in the reader, so the pane hand-over and the hand-back are both visible.
  await row(page, LUNCH).click()
  await expect(page.getByTestId('mail-reader')).toBeVisible({ timeout: 60_000 })

  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await item(page, SUMMARIZE).click()
  await expect(drawer(page)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-reader')).toHaveCount(0)

  // The question went out as the session's first message, context block and all: the mock CLI echoes
  // what it is sent, so its answer is the proof.
  const session = drawer(page).getByTestId('ask-object-session')
  await expect(session).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
  const answer = drawer(page).locator('.session-msg-assistant').filter({ hasText: /summarize this mail/i })
  await expect(answer).toHaveCount(1, { timeout: 90_000 })
  await expect(answer).toContainText('Subject: Quarterly keeper report')
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'drawer-open')}`)

  // The drawer fills the reader's column and nothing else moved.
  const geometry = await page.evaluate(() => {
    const console_ = document.querySelector('.mail-console') as HTMLElement
    const pane = document.querySelector('.ask-object-drawer') as HTMLElement
    const box = pane.getBoundingClientRect()
    const outer = console_.getBoundingClientRect()
    return {
      bottomGap: Math.round(outer.bottom - box.bottom),
      rightGap: Math.round(outer.right - box.right),
      height: Math.round(box.height),
    }
  })
  expect(geometry.bottomGap).toBeLessThanOrEqual(1)
  expect(geometry.rightGap).toBeLessThanOrEqual(1)
  expect(geometry.height).toBeGreaterThan(300)

  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByTestId('mail-reader')).toBeVisible()
  await expect(row(page, KEEPER)).toBeFocused()
})

test('S4-W4: Find on Home from the drawer lands on the ask in the chat slot', async ({ page }) => {
  await openWriterInbox(page)
  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await item(page, SUMMARIZE).click()
  const session = drawer(page).getByTestId('ask-object-session')
  await expect(session).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
  const sessionId = await session.getAttribute('data-session-id')
  await session.getByTestId('session-panel-locate').click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator(`[data-testid="ask-walnut-session"][data-session-id="${sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`.main-page-session-column [data-session-id="${sessionId}"]`)).toHaveCount(0)
  // An ask starts in Focus, so it is selected as the tier's active card, not as a listed row.
  await expect(page.locator('#home-task-navigation').locator('.task-focused, .todo-pinned-card-active'))
    .toHaveCount(1, { timeout: 30_000 })
  console.log(`shot: ${await shoot(page, SHOT_DIR, 'find-on-home-webkit')}`)
})

test('S4-W5: Escape with the composer menu open closes the menu, and only then the drawer', async ({ page }) => {
  await openWriterInbox(page)
  await row(page, LUNCH).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await item(page, SUMMARIZE).click()
  const session = drawer(page).getByTestId('ask-object-session')
  await expect(session).toHaveAttribute('data-session-id', /.+/, { timeout: 60_000 })
  // WebKit does not focus a button on click, so the Escape arrives at <body>: the open menu is what
  // the drawer has to notice, not the focused element.
  await session.locator('button[aria-haspopup="menu"]').first().click()
  await expect(session.locator('.chat-plus-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(session.locator('.chat-plus-menu')).toHaveCount(0)
  await expect(drawer(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
})

test('S4-W6: Start Task picks its folder, More closes on Escape, and the launch runs there in Focus', async ({ page }) => {
  const launches: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/sessions/quick-start') return
    try { launches.push(request.postDataJSON() as Record<string, unknown>) } catch { launches.push({}) }
  })
  await openWriterInbox(page)
  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await item(page, ASK).click()
  const draft = drawer(page).locator('.draft-session-panel')
  await expect(draft).toBeVisible({ timeout: 60_000 })
  const card = (label: string) => draft.locator('.draft-intent-card', { hasText: label })
  await expect(card('Ask Walnut')).toHaveAttribute('aria-pressed', 'true')
  await card('Start Task').click()
  await expect(card('Start Task')).toHaveAttribute('aria-pressed', 'true')

  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('.sps-search-input').fill(folder)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(draft)).toContainText('marina-app')

  // WebKit leaves focus on <body> after a button click: the open menu is what Escape must find.
  const more = await openDraftSettings(draft, 'more')
  await expect(more.locator('.task-kebab-tier-label')).toHaveText('Pin to (default Focus)')
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(drawer(page)).toBeVisible()

  const composer = draft.locator('textarea.chat-input-textarea')
  await composer.fill('Write the reply as a script in this repo')
  await draft.locator('.draft-start-btn').click()
  await expect.poll(() => launches.length, { timeout: 60_000 }).toBe(1)
  expect(launches[0]).toMatchObject({ cwd: folder, project: 'marina-app', taskMeta: { pinTier: 'focus' } })
  expect(launches[0]).not.toHaveProperty('walnutAgent')
  const answer = drawer(page).locator('.session-msg-assistant').filter({ hasText: /Write the reply as a script in this repo/ })
  await expect(answer).toHaveCount(1, { timeout: 90_000 })
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'start-task-webkit')}`)
})
