/**
 * The selection pill's Quote and Comment (2026-11-01, the user: "I select text,
 * leave a comment, select another piece and leave another comment, and nothing is
 * sent until I press send"; then, on the first design that put them in the box as
 * text: the commented words stay marked in the message, and the pending ones are
 * listed above the composer, one row each, three in view, never as text).
 *
 *   Quote / Comment    the passage gets an orange mark and a chip at its end; a row
 *                      for it appears above the composer; the composer keeps only
 *                      what the user typed
 *   the list           "N comments", a row per item in the order added (where it
 *                      was left, then the comment), three in view, scroll for more;
 *                      a row's click shows the passage, × takes it out
 *   a reload           keeps everything (it is on the session record)
 *   one send           ONE message: each quote with its comment, in order, then the
 *                      typed words; the list empties, the comments stay as quieter
 *                      marks (a plain Quote leaves none), before and after a reload
 *
 * Real pipeline: the threads fixture session (long invented answers) and a send that
 * reaches the mock CLI. Nothing is route-mocked.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage } from './threads-helpers'
import { COMMENTS_SESSION as AI_SESSION } from './threads-fixture'
import { loadHome } from './draft-helpers'

const AI_TASK = 'pw-task-threads-comments'
const AI_READY = 'How should the reader treat stale copies?'
const ANSWER = '[data-message-id][data-msg-role="assistant"]'

async function shot(scope: Page | Locator, name: string): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/quote-comment-stack/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await scope.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page): Promise<Locator> {
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${AI_SESSION}"]) {
    flex: 0 0 760px !important; width: 760px !important; min-width: 760px !important; max-width: 760px !important; }` })
  return openThreadsSession(page, AI_SESSION, AI_TASK, AI_READY, { view: 'linear' })
}

const pill = (page: Page) => page.locator('[data-testid="quote-pin-pill"]')
const composerOf = (panel: Locator) => panel.locator('.session-panel-input .chat-input-textarea')
const tray = (panel: Locator) => panel.getByTestId('pending-comments')
const rows = (panel: Locator) => panel.getByTestId('pending-comment-row')
const quoted = (passage: string) => passage.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')

/** How many passages one highlight name paints right now. */
const painted = (page: Page, name: string) => page.evaluate(
  (n) => ((CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get(n)?.size ?? 0), name,
)

/** Five real passages from the answers: whole sentences, one of them two sentences
 *  long, from different answers and paragraphs. */
async function passages(panel: Locator): Promise<string[]> {
  const paras = await panel.locator(`.session-history ${ANSWER} .session-msg-content p`).allInnerTexts()
  const sentences = paras.map((p) => p.match(/[^.!?]+[.!?]/g)?.map((s) => s.trim()) ?? [])
  const picks = [
    sentences[0][1],
    `${sentences[1][0]} ${sentences[1][1]}`,
    sentences[2][2],
    sentences[paras.length - 3][0],
    sentences[paras.length - 1][1],
  ]
  for (const p of picks) expect(p && p.split(/\s+/).length, `passage "${p}"`).toBeGreaterThan(5)
  return picks
}

async function select(page: Page, panel: Locator, phrase: string): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await centreInHistory(page, panel, phrase, { tolerance: 20 })
  await selectPassage(page, panel, phrase, ANSWER)
  await expect(pill(page)).toBeVisible()
}

async function quote(page: Page, panel: Locator, phrase: string): Promise<void> {
  await select(page, panel, phrase)
  await pill(page).getByRole('button', { name: 'Quote', exact: true }).click()
  await expect(pill(page)).toHaveCount(0)
  await expect(composerOf(panel)).toBeFocused()
}

async function comment(page: Page, panel: Locator, phrase: string, words: string, opts: { shotName?: string } = {}): Promise<void> {
  await select(page, panel, phrase)
  await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
  const input = page.getByTestId('quote-comment-input')
  await expect(input).toBeFocused()
  await expect(pill(page).getByRole('button', { name: 'Pin' })).toHaveCount(0)
  await expect(page.getByTestId('quote-comment-add')).toBeDisabled()
  const lines = words.split('\n')
  for (const [i, line] of lines.entries()) {
    if (i) await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(line)
  }
  await page.waitForTimeout(300)
  await expect(pill(page)).toBeVisible()
  if (opts.shotName) await shot(page, opts.shotName)
  await page.keyboard.press('Enter')
  await expect(pill(page)).toHaveCount(0)
  await expect(composerOf(panel)).toBeFocused()
}

/** Each row reads where it was left, then the comment (or "Quote"). */
async function expectRows(panel: Locator, items: Array<{ passage: string; comment?: string }>): Promise<void> {
  await expect(rows(panel)).toHaveCount(items.length)
  for (const [i, it] of items.entries()) {
    const row = rows(panel).nth(i)
    await expect(row.locator('.pending-comments-where')).toHaveAttribute('title', it.passage)
    await expect(row.locator('.pending-comments-text')).toHaveText(it.comment ? it.comment.replace(/\s+/g, ' ') : 'Quote')
  }
}

function captureSends(page: Page): Array<{ sessionId: string; message: string }> {
  const sent: Array<{ sessionId: string; message: string }> = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload)
      if (row.method === 'session:send') sent.push(row.payload)
    } catch { /* not JSON */ }
  }))
  return sent
}

test.describe('Selection pill: Quote and Comment stay on the passage and go with the next send', () => {
  // Both tests write the one fixture session's comments.
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ page, request }) => {
    await resetThreadsFixture(request, AI_SESSION)
    await page.setViewportSize({ width: 1280, height: 900 })
    await loadHome(page)
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('draft:')) localStorage.removeItem(k) })
  })
  test.afterEach(async ({ page, request }) => {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('draft:')) localStorage.removeItem(k) }).catch(() => {})
    await resetThreadsFixture(request, AI_SESSION)
  })

  test('3 quotes and 2 comments: marked, listed, kept over a reload, sent as one message, then kept as marks', async ({ page }) => {
    const sent = captureSends(page)
    let panel = await open(page)
    const composer = () => composerOf(panel)
    const [p1, p2, p3, p4, p5] = await passages(panel)
    const c1 = 'Is this still true after the rewrite?'
    const c2 = 'Compare this with the second answer.\nThey disagree on the order.'

    await select(page, panel, p1)
    const labels = (await pill(page).locator('button').allInnerTexts()).map((t) => t.trim())
    expect(labels).toEqual(['Pin', 'Ask here', 'Quote', 'Comment', 'Copy'])
    await page.keyboard.press('Escape')
    await expect(pill(page)).toHaveCount(0)

    // Esc in the Comment box adds nothing and keeps the words as that passage's draft;
    // Cancel throws them away.
    const input = page.getByTestId('quote-comment-input')
    const reopen = async () => {
      await select(page, panel, p1)
      await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
      await expect(input).toBeFocused()
    }
    await reopen()
    await page.keyboard.type('never added')
    await page.keyboard.press('Escape')
    await expect(pill(page)).toHaveCount(0)
    await expect(tray(panel)).toHaveCount(0)
    await reopen()
    await expect(input).toHaveValue('never added')
    await pill(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await reopen()
    await expect(input).toHaveValue('')
    await page.keyboard.press('Escape')

    // The user's own words in the box stay theirs throughout.
    await composer().fill('My own line.')
    await quote(page, panel, p1)
    await comment(page, panel, p2, c1, { shotName: '01-comment-box' })
    await quote(page, panel, p3)
    await expect(composer()).toHaveValue('My own line.')
    await expect(panel.getByTestId('pending-comments-count')).toHaveText('1 comment, 2 quotes')
    await expectRows(panel, [{ passage: p1 }, { passage: p2, comment: c1 }, { passage: p3 }])
    // Three marks while pending, a chip on each passage in view.
    await expect.poll(() => painted(page, 'walnut-comment')).toBe(3)
    await centreInHistory(page, panel, p2, { tolerance: 20 })
    const chip2 = page.locator('[data-testid="passage-comment-marker"][aria-label^="Comment:"]')
    await expect(chip2).toHaveCount(1)
    await expect(chip2).toHaveAttribute('title', c1)
    await shot(panel, '02-marked-and-listed')
    expect(sent, 'adding sends nothing').toHaveLength(0)

    // A reload keeps them: list, order and marks.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await open(page)
    await expectRows(panel, [{ passage: p1 }, { passage: p2, comment: c1 }, { passage: p3 }])
    await expect.poll(() => painted(page, 'walnut-comment')).toBe(3)

    // A two-line comment, then a fifth: five rows, three in view, the rest scroll.
    await comment(page, panel, p4, c2)
    await quote(page, panel, p5)
    await expectRows(panel, [{ passage: p1 }, { passage: p2, comment: c1 }, { passage: p3 }, { passage: p4, comment: c2 }, { passage: p5 }])
    await expect(panel.getByTestId('pending-comments-count')).toHaveText('2 comments, 3 quotes')
    const list = panel.locator('.pending-comments-list')
    const box = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, row: (el.firstElementChild as HTMLElement).offsetHeight }))
    expect(Math.round(box.client / box.row)).toBe(3)
    expect(box.scroll).toBeGreaterThan(box.client)
    await shot(panel.locator('.session-panel-input'), '03-five-pending')

    // A row's click shows where it was left: scroll to the bottom, click the first row.
    await panel.locator('.session-history').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await rows(panel).first().locator('.pending-comments-jump').click()
    await expect.poll(async () => {
      const r = await panel.locator(ANSWER).filter({ hasText: p1 }).first().boundingBox()
      const h = await panel.locator('.session-history').boundingBox()
      return !!r && !!h && r.y < h.y + h.height && r.y + r.height > h.y
    }, { timeout: 10_000 }).toBe(true)

    // Send with the typed words: ONE message carrying all five, in order, then the line.
    await composer().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(1)
    expect(sent[0].sessionId).toBe(AI_SESSION)
    const all = `${quoted(p1)}\n\n${quoted(p2)}\n\n${c1}\n\n${quoted(p3)}\n\n${quoted(p4)}\n\n${c2}\n\n${quoted(p5)}\n\nMy own line.`
    expect(sent[0].message).toBe(all)
    await expect(composer()).toHaveValue('')
    await expect(tray(panel)).toHaveCount(0)
    const bubble = panel.locator('.session-msg-user').filter({ hasText: 'My own line.' }).last()
    await expect(bubble.locator('blockquote')).toHaveCount(5, { timeout: 30_000 })
    // The two comments stay as marks; the plain quotes leave none.
    await expect.poll(() => painted(page, 'walnut-comment-sent')).toBe(2)
    await expect.poll(() => painted(page, 'walnut-comment')).toBe(0)

    // After a reload too, and a chip opens the comment's card.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await open(page)
    await expect(tray(panel)).toHaveCount(0)
    await expect.poll(() => painted(page, 'walnut-comment-sent')).toBe(2)
    await centreInHistory(page, panel, p2, { tolerance: 20 })
    const chip = page.locator('[data-testid="passage-comment-marker"].is-sent').first()
    await chip.click()
    const card = page.getByTestId('passage-comment-card')
    await expect(card).toContainText(c1)
    await expect(card).toContainText('Sent')
    await shot(panel, '04-sent-mark-card')
    // Remove mark takes it off the words.
    await card.getByTestId('passage-comment-remove').click()
    await expect.poll(() => painted(page, 'walnut-comment-sent')).toBe(1)
    expect(sent).toHaveLength(1)
  })

  test('comments alone are a message; × takes one out; the keyboard path and a scrolled-away passage keep the words', async ({ page }) => {
    const sent = captureSends(page)
    // The socket opened before the capture: a reload opens the one it watches.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const panel = await open(page)
    const composer = composerOf(panel)
    const [p1, p2, p3] = await passages(panel)

    // Keyboard: focus Comment and press Enter (no pointer press to hold the passage on).
    await select(page, panel, p1)
    await pill(page).getByRole('button', { name: 'Comment', exact: true }).focus()
    await page.keyboard.press('Enter')
    const input = page.getByTestId('quote-comment-input')
    await expect(input).toBeFocused()
    await page.keyboard.type('the first one')
    // The passage scrolls far out of view while the box is open: the words stay.
    await panel.locator('.session-history').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await page.waitForTimeout(500)
    await expect(input).toHaveValue('the first one')
    await input.focus()
    await page.keyboard.press('Enter')
    await expect(pill(page)).toHaveCount(0)

    await comment(page, panel, p2, 'the second one')
    await quote(page, panel, p3)
    await expectRows(panel, [{ passage: p1, comment: 'the first one' }, { passage: p2, comment: 'the second one' }, { passage: p3 }])
    // × takes the second out, and its mark goes with it.
    await rows(panel).nth(1).getByTestId('pending-comment-remove').click()
    await expectRows(panel, [{ passage: p1, comment: 'the first one' }, { passage: p3 }])
    await expect.poll(() => painted(page, 'walnut-comment')).toBe(2)

    // Nothing typed: the list alone is the message, and Enter sends it.
    await expect(composer).toHaveValue('')
    await expect(panel.locator('.session-panel-input .chat-send-btn-icon')).toBeEnabled()
    await composer.focus()
    // A second Enter right after: the first send claimed the list, nothing goes twice.
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(1)
    expect(sent[0].message).toBe(`${quoted(p1)}\n\nthe first one\n\n${quoted(p3)}`)
    await expect(tray(panel)).toHaveCount(0)
    await expect.poll(() => painted(page, 'walnut-comment-sent')).toBe(1)
    await page.waitForTimeout(1000)
    expect(sent).toHaveLength(1)
  })
})
