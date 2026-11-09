/**
 * Ask here answers are filed from their tag alone (2026-11-03, the user: "we must
 * make it strict ... the thread-id and thread name in a html tag format ...
 * otherwise we keep getting this no answered").
 *
 * A question's send carries its thread id and name in the `question` hint, and
 * the model answers inside `<walnut-ask-answer thread=".." name="..">`
 * (src/core/sessions/ask-thread.ts). The client files exactly the text inside a
 * tag whose id AND name match under that question (web/src/utils/ask-answer.ts);
 * text outside every tag stays in the main conversation, and a question with no
 * tagged answer waits: never "Answered" over "No answer".
 *
 * The mock CLI answers a strict question inside its tag; `MOCK_ASK_NO_TAG`
 * forgets the tag, `MOCK_ASK_WRONG_NAME` gets the name wrong, and
 * `MOCK_ASK_ECHO_THREAD` says which thread id the send named. Chromium and
 * WebKit, on pw-threads-strict-session (threads-fixture.ts), whose question 1 is a
 * strict one from the transcript: its card shows only its tagged answer.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, mainComposer, mainPage, openThreadsSession, readRecord, resetThreadsFixture, selectPassage, switchView, test } from './threads-helpers'
import { MIDTURN_PASSAGES, MIDTURN_READY, STRICT_SESSION, STRICT_TASK } from './threads-fixture'

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/ask-strict-tag/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (target) await target.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, view: 'linear' | 'stack' = 'linear'): Promise<Locator> {
  // The fixed column width below assumes Home's chat spot is closed. Said here,
  // not left to the server's synced layout: on the Mac its read timed out at
  // boot, the chat opened by default and pushed the session off screen (2026-11-09).
  await page.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${STRICT_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }
    .notification-toaster { display: none !important; }` })
  return openThreadsSession(page, STRICT_SESSION, STRICT_TASK, MIDTURN_READY, { view })
}

const card = (panel: Locator) => panel.locator('.thread-card')

/** The main chat shows `text` on screen (not inside a question's card). */
function mainChatShows(panel: Locator, text: string): Promise<boolean> {
  return panel.evaluate((root, needle) => {
    const box = root.querySelector('.session-history')
    if (!box) return false
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !(n as Text).data.includes(needle)) continue
      if (el.closest('.thread-card, .thread-card-layer, .thread-review-sidebar')) continue
      if (el.getClientRects().length > 0) return true
    }
    return false
  }, text)
}

/** No answer tag is ever on screen. */
async function noTagShown(panel: Locator): Promise<void> {
  expect(await panel.evaluate((root) => (root as HTMLElement).innerText.includes('walnut-ask-answer'))).toBe(false)
}

/** Ask inline on `passage` (Conversation Mode), send `question`, wait for its turn to end. */
async function ask(page: Page, panel: Locator, passage: string, question: string): Promise<void> {
  await centreInHistory(page, panel, passage)
  await selectPassage(page, panel, passage)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(card(panel)).toBeVisible()
  const input = card(panel).locator('.thread-card-input')
  await input.fill(question)
  await input.press('Enter')
  await expect(input).toHaveValue('')
}

async function idle(panel: Locator): Promise<void> {
  await expect(panel.locator('.chat-stop-btn-icon')).toHaveCount(0, { timeout: 60_000 })
}

/** The thread id the record stored for the question whose text holds `words`. */
async function threadIdOf(page: Page, words: string): Promise<string> {
  let id = ''
  await expect.poll(async () => {
    const rec = await readRecord(page.request, STRICT_SESSION)
    const m = (rec.threadMeta ?? []).find((x) => typeof x.question === 'string' && (x.question as string).includes(words))
    id = typeof m?.thread === 'string' ? m.thread : ''
    return id
  }, { timeout: 15_000 }).toMatch(/^\d+(\.\d+)*$/)
  return id
}

test.describe('Ask here: the answer is the text inside its tag', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, STRICT_SESSION)
  })

  test('a stored strict question: its page holds only the words inside its tag', async ({ page }) => {
    const panel = await open(page, 'stack')
    await panel.locator('.thread-map-row[data-kind="thread"]').filter({ hasText: 'Account lists' }).first().click()
    await expect(mainPage(panel).locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    // The panel's own page (the right half once an Ask splits the pane).
    const history = mainPage(panel).locator('.session-history')
    await expect(history).toContainText('No, each cluster keeps its own.')
    await expect(history).not.toContainText('Looking at the cluster setup first.')
    await noTagShown(panel)
    // The words outside the tag read on the main conversation.
    await switchView(panel, 'linear')
    await expect.poll(() => mainChatShows(panel, 'Looking at the cluster setup first.'), { timeout: 15_000 }).toBe(true)
    await shot(page, '0-stored', panel)
  })

  test('answered in its tag: the card and the Tree page hold it, the main chat does not; a follow-up and a nested question too', async ({ page }) => {
    const QUESTION = 'Can a pod use an account from another namespace?'
    const ANSWER = `processed your message: ${QUESTION}`
    const panel = await open(page)
    await ask(page, panel, MIDTURN_PASSAGES.ASK, `MOCK_ASK_ECHO_THREAD ${QUESTION}`)
    const body = card(panel).locator('.thread-card-body')
    await expect(body).toContainText(ANSWER, { timeout: 60_000 })
    await idle(panel)
    const thread = await threadIdOf(page, QUESTION)
    expect(thread, 'a question on the main conversation gets a top-level id').toMatch(/^\d+$/)
    // The answer names the id its send named.
    await expect(body).toContainText(`Thread ${thread} answer.`)
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1_000)
      expect(await mainChatShows(panel, ANSWER), 'the tagged answer is not in the main chat').toBe(false)
      await expect(body).toContainText(ANSWER)
    }
    await expect(card(panel).locator('.thread-status-word')).not.toHaveAttribute('data-kind', /failed|waiting/)
    await expect(card(panel).locator('.thread-card-noanswer')).toHaveCount(0)
    await noTagShown(panel)
    await shot(page, '1-tag-answer', panel)

    // A follow-up from its card: its send names the same thread, its answer joins the card.
    const FOLLOW = 'And from another cluster?'
    const input = card(panel).locator('.thread-card-input')
    await input.fill(`MOCK_ASK_ECHO_THREAD ${FOLLOW}`)
    await input.press('Enter')
    await expect(body).toContainText(`processed your message: ${FOLLOW}`, { timeout: 60_000 })
    await idle(panel)
    await expect(body.locator('.thread-card-turn')).toHaveCount(2)
    await expect(body.locator('.thread-card-turn').nth(1)).toContainText(`Thread ${thread} answer.`)
    expect(await mainChatShows(panel, `processed your message: ${FOLLOW}`)).toBe(false)
    await shot(page, '2-follow-up', panel)

    // The Tree page of the question: its rows and its answers, not the main chat's.
    await page.keyboard.press('Escape')
    await switchView(panel, 'stack')
    // Its row in the question map opens its page.
    await panel.locator('.thread-map-row[data-kind="thread"]').filter({ hasText: MIDTURN_PASSAGES.ASK.slice(0, 12) }).first().click()
    await expect(mainPage(panel).locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    // The panel's own page (the right half once an Ask splits the pane).
    const history = mainPage(panel).locator('.session-history')
    await expect(history).toContainText(ANSWER)
    await expect(history).toContainText(`processed your message: ${FOLLOW}`)
    await expect(history).not.toContainText(MIDTURN_READY)
    await noTagShown(panel)
    await shot(page, '3-tree-page', panel)

    // A question about a passage of that answer: one level down, id `<thread>.1`.
    const NESTED = 'Why does that hold?'
    await selectPassage(page, mainPage(panel), `processed your message: ${QUESTION}`, '[data-message-id][data-msg-role="assistant"]')
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(mainPage(panel).locator('.thread-stack')).toHaveAttribute('data-thread-depth', '2', { timeout: 15_000 })
    // An Ask shows the pages side by side again: the question it was asked on
    // left of the new one, which has the panel's composer.
    await expect(panel.locator('.tree-split-left').first()).toBeVisible()
    const composer = mainComposer(panel)
    await composer.click()
    await composer.fill(`MOCK_ASK_ECHO_THREAD ${NESTED}`)
    await composer.press('Enter')
    await expect(history).toContainText(`processed your message: ${NESTED}`, { timeout: 60_000 })
    await idle(panel)
    const nested = await threadIdOf(page, NESTED)
    expect(nested).toBe(`${thread}.1`)
    await expect(history).toContainText(`Thread ${nested} answer.`)
    await noTagShown(panel)
    // Its badge reads its id (2.1), as its tag does, never its flat number.
    const seq = await (async () => {
      const rec = await readRecord(page.request, STRICT_SESSION)
      return (rec.threadMeta ?? []).find((x) => typeof x.question === 'string' && (x.question as string).includes(NESTED))?.seq
    })()
    expect(String(seq)).not.toBe(nested)
    // The path bar names it.
    const pathNums = panel.locator('.tree-path-num')
    await expect(pathNums.filter({ hasText: new RegExp(`^${nested.replace('.', '\\.')}$`) }).first()).toBeVisible({ timeout: 15_000 })
    await expect(pathNums.filter({ hasText: new RegExp(`^${seq}$`) })).toHaveCount(0)
    // So does the question map, which a page beside another draws as the thin
    // rail without numbers: one page again shows the map's own numbers.
    const sides = panel.locator('.tree-split-left:not(.tree-split-sibling)')
    while (await sides.count() > 0) {
      const n = await sides.count()
      await sides.first().getByRole('button', { name: /^Close the (left|middle) page$/ }).click()
      await expect(sides).toHaveCount(n - 1)
    }
    const badges = panel.locator('.thread-map-num')
    await expect(badges.filter({ hasText: new RegExp(`^${nested.replace('.', '\\.')}$`) }).first()).toBeVisible({ timeout: 15_000 })
    await expect(badges.filter({ hasText: new RegExp(`^${seq}$`) })).toHaveCount(0)
    await shot(page, '4-nested', panel)
  })

  test('no tag, or a tag with the wrong name: the text stays in the main chat and the question waits', async ({ page }) => {
    const QUESTION = 'Which list wins when two disagree?'
    const TEXT = `processed your message: ${QUESTION}`
    const panel = await open(page)
    await ask(page, panel, MIDTURN_PASSAGES.ASK, `MOCK_ASK_NO_TAG ${QUESTION}`)
    await idle(panel)
    await expect.poll(() => mainChatShows(panel, TEXT), { timeout: 30_000 }).toBe(true)
    const body = card(panel).locator('.thread-card-body')
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1_000)
      await expect(body).not.toContainText(TEXT)
      expect(await mainChatShows(panel, TEXT)).toBe(true)
    }
    // Waiting for its answer: never "Answered", never "No answer".
    await expect(card(panel).locator('.thread-status-word')).toHaveAttribute('data-kind', 'waiting', { timeout: 15_000 })
    await expect(card(panel).locator('.thread-card-noanswer')).toHaveText('Waiting for its answer…')
    await expect(card(panel)).not.toContainText('Answered')
    await expect(card(panel)).not.toContainText('No answer')
    await shot(page, '5-no-tag', panel)

    // The wrong name: the tag files nothing, its text reads in the main chat (no tag shown).
    const WRONG = 'When is the admission check run?'
    const WRONG_TEXT = `processed your message: ${WRONG}`
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    await ask(page, panel, MIDTURN_PASSAGES.ASK2, `MOCK_ASK_WRONG_NAME ${WRONG}`)
    await idle(panel)
    await expect.poll(() => mainChatShows(panel, WRONG_TEXT), { timeout: 30_000 }).toBe(true)
    await expect(card(panel).locator('.thread-card-body')).not.toContainText(WRONG_TEXT)
    await expect(card(panel).locator('.thread-status-word')).toHaveAttribute('data-kind', 'waiting', { timeout: 15_000 })
    await noTagShown(panel)
    await shot(page, '6-wrong-name', panel)

    // A reload reads the transcript only: the same.
    await page.reload()
    const again = await open(page)
    await expect.poll(() => mainChatShows(again, TEXT), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => mainChatShows(again, WRONG_TEXT), { timeout: 30_000 }).toBe(true)
    await noTagShown(again)
  })
})
