/**
 * The selection pill's "Comment" beside "Quote" (2026-11-01, the user: "I select
 * text, leave a comment, select another piece and leave another comment, and
 * nothing is sent until I press send"; "Sometimes I just want to quote it").
 *
 *   Comment            a box in the pill; Enter adds the quote with the comment under
 *                      it to the MAIN conversation's composer; nothing is sent
 *   Quote / Comment    stack in the composer in the order added (the first one still
 *                      leads the typed words, as a single Quote always did)
 *   a reload           keeps everything collected (the composer's own draft)
 *   one Enter          sends ONE message holding every piece in order, and only the
 *                      accepted send empties the composer
 *
 * Real pipeline: the threads fixture session (long invented answers) and a send that
 * reaches the mock CLI. Nothing is route-mocked.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { AI_SESSION, centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage } from './threads-helpers'
import { loadHome } from './draft-helpers'

const AI_TASK = 'pw-task-threads-ai'
const AI_READY = 'How should the reader treat stale copies?'
const ANSWER = '[data-message-id][data-msg-role="assistant"]'
const DRAFT_KEY = `draft:session:${AI_SESSION}`

/** The composer's saved draft has caught up with `text` (or is gone, for ''). */
async function draftSaved(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k) ?? '', DRAFT_KEY), { timeout: 10_000 })
    .toBe(text)
}

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
const quoted = (passage: string) => passage.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')

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
  // The box takes the pill's place: only Cancel and Add are left.
  expect((await pill(page).locator('button').allInnerTexts()).map((t) => t.trim())).toEqual(['Cancel', 'Add'])
  // Empty: Add waits for words.
  await expect(page.getByTestId('quote-comment-add')).toBeDisabled()
  await page.keyboard.type(words)
  // The passage stays held while the user writes: the pill does not go away.
  await page.waitForTimeout(400)
  await expect(pill(page)).toBeVisible()
  if (opts.shotName) await shot(page, opts.shotName)
  await page.keyboard.press('Enter')
  await expect(pill(page)).toHaveCount(0)
  await expect(composerOf(panel)).toBeFocused()
}

test.describe('Selection pill: Comment, and quotes that stack until one send', () => {
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

  test('3 quotes and 2 comments, a reload between them, one send carrying all 5 in order', async ({ page }) => {
    const sent: Array<{ sessionId: string; message: string }> = []
    page.on('websocket', (socket) => socket.on('framesent', (frame) => {
      if (typeof frame.payload !== 'string') return
      try {
        const row = JSON.parse(frame.payload)
        if (row.method === 'session:send') sent.push(row.payload)
      } catch { /* not JSON */ }
    }))
    let panel = await open(page)
    const composer = () => composerOf(panel)
    const [p1, p2, p3, p4, p5] = await passages(panel)
    const c1 = 'Is this still true after the rewrite?'
    const c2 = 'Compare this with the second answer.\nThey disagree on the order.'

    // The pill names all five actions.
    await select(page, panel, p1)
    const labels = (await pill(page).locator('button').allInnerTexts()).map((t) => t.trim())
    expect(labels).toEqual(['Pin', 'Ask here', 'Quote', 'Comment', 'Copy'])
    await page.keyboard.press('Escape')
    await expect(pill(page)).toHaveCount(0)
    // (A press on a live selection would drag the text, not select it again.)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    // Esc in the Comment box adds nothing.
    await select(page, panel, p1)
    await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
    await page.keyboard.type('never added')
    await page.keyboard.press('Escape')
    await expect(pill(page)).toHaveCount(0)
    await expect(composer()).toHaveValue('')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    // 1 Quote: the first quote leads, as a single Quote always did.
    await quote(page, panel, p1)
    await expect(composer()).toHaveValue(`${quoted(p1)}\n\n`)
    // 2 Comment, 3 Quote: each goes under the last.
    await comment(page, panel, p2, c1, { shotName: '01-comment-box' })
    await quote(page, panel, p3)
    const beforeReload = `${quoted(p1)}\n\n${quoted(p2)}\n\n${c1}\n\n${quoted(p3)}\n\n`
    await expect(composer()).toHaveValue(beforeReload)
    expect(sent, 'adding sends nothing').toHaveLength(0)

    // A reload keeps everything collected.
    await draftSaved(page, beforeReload.trimEnd())
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await open(page)
    // (The saved draft drops trailing blank lines; the next block puts one back.)
    await expect(composer()).toHaveValue(beforeReload.trimEnd())

    // 4 Comment (two lines, typed with Shift+Enter), 5 Quote.
    await select(page, panel, p4)
    await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByTestId('quote-comment-input')).toBeFocused()
    const [l1, l2] = c2.split('\n')
    await page.keyboard.type(l1)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(l2)
    await page.getByTestId('quote-comment-add').click()
    await expect(pill(page)).toHaveCount(0)
    await quote(page, panel, p5)
    const all = `${beforeReload}${quoted(p4)}\n\n${c2}\n\n${quoted(p5)}\n\n`
    await expect(composer()).toHaveValue(all)
    // The caret waits at the end, after the last quote.
    expect(await composer().evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(all.length)
    await shot(panel.locator('.session-panel-input'), '02-composer-stacked')
    expect(sent).toHaveLength(0)

    // Edit like any text: a line of the user's own at the end.
    await page.keyboard.type('Please answer each one.')
    // One send.
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(1)
    const message = sent[0].message
    expect(sent[0].sessionId).toBe(AI_SESSION)
    expect(message.trim()).toBe(`${all}Please answer each one.`.trim())
    const order = [quoted(p1), quoted(p2), c1, quoted(p3), quoted(p4), c2, quoted(p5)].map((piece) => message.indexOf(piece))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    await expect(composer()).toHaveValue('')
    // The bubble carries the five pieces as one message.
    const bubble = panel.locator('.session-msg-user').filter({ hasText: c1 }).last()
    await expect(bubble).toContainText('Please answer each one.', { timeout: 30_000 })
    await expect(bubble.locator('blockquote')).toHaveCount(5)

    // Accepted: the draft is gone, so a reload opens an empty box.
    await draftSaved(page, '')
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await open(page)
    await expect(composer()).toHaveValue('')
    await shot(panel, '03-sent')
    expect(sent).toHaveLength(1)
  })

  test('Comment from the keyboard, a comment kept while its passage scrolls away, and a first quote that leads the typed words', async ({ page }) => {
    const panel = await open(page)
    const composer = composerOf(panel)
    const [p1, p2] = await passages(panel)
    await composer.click()
    await composer.fill('what do these two mean')

    // Keyboard: focus Comment and press Enter (no pointer press to hold the passage on).
    await select(page, panel, p1)
    await pill(page).getByRole('button', { name: 'Comment', exact: true }).focus()
    await page.keyboard.press('Enter')
    const input = page.getByTestId('quote-comment-input')
    await expect(input).toBeFocused()
    await page.keyboard.type('the first one')

    // The passage scrolls far out of view while the box is open: the words stay.
    await panel.locator('.session-history').evaluate((el) => {
      const scroller = (el.closest('[data-scroll-root]') ?? el) as HTMLElement
      for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 10 && getComputedStyle(n).overflowY !== 'visible') { n.scrollTop = n.scrollHeight; return }
      }
      scroller.scrollTop = scroller.scrollHeight
    })
    await page.waitForTimeout(500)
    await expect(input).toHaveValue('the first one')
    await input.focus()
    await page.keyboard.press('Enter')
    await expect(pill(page)).toHaveCount(0)
    // The first quote leads, the typed words follow it.
    await expect(composer).toHaveValue(`${quoted(p1)}\n\nthe first one\n\nwhat do these two mean`)

    // The next one goes at the end.
    await quote(page, panel, p2)
    await expect(composer).toHaveValue(`${quoted(p1)}\n\nthe first one\n\nwhat do these two mean\n\n${quoted(p2)}\n\n`)
  })
})
