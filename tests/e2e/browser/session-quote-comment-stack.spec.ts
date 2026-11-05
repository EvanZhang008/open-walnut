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
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, test } from './threads-helpers'
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

/** Put the passage at `at` of the timeline's height; 'bottom' scrolls the timeline to
 *  its end (the passage is then in the last message, right above the composer). */
async function place(page: Page, panel: Locator, phrase: string, at: number | 'bottom'): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  if (at === 'bottom') {
    await panel.locator('.session-history').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await page.waitForTimeout(300)
  } else await centreInHistory(page, panel, phrase, { at, tolerance: 20 })
}

/** A box's rectangle once it has stopped moving (two equal reads 150ms apart): the
 *  timeline may still be settling a scroll when the box opens. */
async function settledBox(box: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = JSON.stringify(await box.boundingBox())
  await expect.poll(async () => {
    await box.page().waitForTimeout(150)
    const now = JSON.stringify(await box.boundingBox())
    const same = now === last
    last = now
    return same
  }, { timeout: 5_000 }).toBe(true)
  return JSON.parse(last)
}

/** The words of any message that lie under a box (its rectangle, viewport px). */
async function wordsUnder(history: Locator, box: { x: number; y: number; width: number; height: number }): Promise<string[]> {
  return history.evaluate((root, b) => {
    const hits: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text
      if (!t.data.trim()) continue
      // Only words a reader can see (a hidden control keeps its box).
      const host = t.parentElement
      if (!host || getComputedStyle(host).visibility !== 'visible') continue
      const r = document.createRange()
      r.selectNodeContents(t)
      for (const rect of Array.from(r.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.right > b.x + 1 && rect.left < b.x + b.width - 1 && rect.bottom > b.y + 1 && rect.top < b.y + b.height - 1) {
          hits.push(t.data.trim().slice(0, 40))
          break
        }
      }
    }
    return hits
  }, box)
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
    await expect(row.locator('.pending-comments-kind')).toHaveText(it.comment ? 'Comment' : 'Quote')
    if (it.comment) await expect(row.locator('.pending-comments-text')).toHaveText(it.comment.replace(/\s+/g, ' '))
    else await expect(row.locator('.pending-comments-text')).toHaveCount(0)
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
    const labels = (await pill(page).locator('button:not([data-testid="quote-ask-mode-btn"])').allInnerTexts()).map((t) => t.trim())
    expect(labels).toEqual(['Pin', 'Ask here', 'Quote', 'Comment', 'Copy'])
    // Beside Ask here, its caret picks Ask inline or Ask in Tree (an icon, no words).
    await expect(pill(page).getByRole('button', { name: 'Choose how to ask: inline or in Tree' })).toHaveCount(1)
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
    await pill(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await reopen()
    await expect(input).toHaveValue('')
    await page.keyboard.press('Escape')

    // The user's own words in the box stay theirs throughout.
    await composer().fill('My own line.')
    await quote(page, panel, p1)
    await comment(page, panel, p2, c1, { shotName: '01-comment-box' })
    await quote(page, panel, p3)
    await expect(composer()).toHaveValue('My own line.')
    // In the order the rows start with (a quote first here).
    await expect(panel.getByTestId('pending-comments-count')).toHaveText('2 quotes, 1 comment')
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
    await expect(panel.getByTestId('pending-comments-count')).toHaveText(/^(2 comments, 3 quotes|3 quotes, 2 comments)$/)
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

  test('the Comment box opens in room the text makes for it: it covers no words and never the composer', async ({ page }) => {
    // 2026-11-04, the user's screenshot: the box sat on the selected lines and on
    // the first table row under them, and its field had a blue glow inside the
    // box's blue border. Then two reviewers of a box placed under the passage: it
    // still hid the words after it, and at the bottom it lay on the composer.
    // Measured with the passage near the top, the middle and the bottom.
    const panel = await open(page)
    const [, p2, , p4, p5] = await passages(panel)
    const input = page.getByTestId('quote-comment-input')
    const history = panel.locator('.session-history')
    // The last one is in the last message, the timeline scrolled to its end.
    for (const [phrase, at] of [[p2, 0.12], [p4, 0.5], [p5, 'bottom']] as const) {
      await place(page, panel, phrase, at)
      await selectPassage(page, panel, phrase, ANSWER)
      await expect(pill(page)).toBeVisible()
      await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
      await expect(input).toBeFocused()
      const box = await settledBox(pill(page))
      // No line of any message lies under the box.
      const covered = await wordsUnder(history, box)
      expect(covered, `words under the box at ${at}`).toEqual([])
      // The passage keeps its mark while the box is open, every line of it above the box.
      await expect.poll(() => painted(page, 'walnut-held-quote')).toBe(1)
      expect(Math.max(...(await passageRects(panel, phrase, ANSWER)).map((r) => r.top + r.height))).toBeLessThanOrEqual(box.y + 0.5)
      // What the comment is on, in one line over the field.
      await expect(page.getByTestId('quote-comment-on')).toContainText(phrase.split(/\s+/).slice(0, 2).join(' '))
      // Inside the timeline: never on the composer.
      const tl = (await history.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(tl.y - 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual(tl.y + tl.height + 0.5)
      const composerTop = (await panel.locator('.session-panel-input').first().boundingBox())!.y
      expect(box.y + box.height, `the box ends above the composer at ${at}`).toBeLessThanOrEqual(composerTop + 0.5)
      // The passage itself is in view above the box.
      const lines = await passageRects(panel, phrase, ANSWER)
      expect(Math.max(...lines.map((r) => r.top + r.height))).toBeLessThanOrEqual(box.y + 0.5)
      expect(Math.min(...lines.map((r) => r.top))).toBeGreaterThanOrEqual(tl.y - 0.5)
      // One ring: the box border in the accent color, never a glow on the field inside it.
      expect(await input.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none')
      expect(await page.getByTestId('quote-comment-box').locator('.answer-box').evaluate((el) => getComputedStyle(el).borderTopColor))
        .toBe(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
          .replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`)))
      // One frame: the field's border; the box draws none of its own.
      expect(await pill(page).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
      // Add is off until there are words; the hint and Discard sit under the field.
      await expect(page.getByTestId('quote-comment-add')).toBeDisabled()
      const field = (await page.getByTestId('quote-comment-box').locator('.answer-box').boundingBox())!
      const discard = (await pill(page).getByRole('button', { name: 'Discard', exact: true }).boundingBox())!
      expect(discard.y).toBeGreaterThanOrEqual(field.y + field.height - 0.5)
      const hint = pill(page).getByText('Sent with your next message')
      await expect(hint).toBeVisible()
      // The hint is one line, even in the narrowest box.
      expect((await hint.boundingBox())!.height).toBeLessThanOrEqual(20)
      // The same room above and below the box in its gap: a room under the passage's
      // own line (a spacer in a long paragraph) or under its block (the block's margin).
      const gap = await panel.evaluate((root) => {
        const g = root.querySelector<HTMLElement>('[data-comment-gap]')!
        const r = g.getBoundingClientRect()
        if (g.hasAttribute('data-comment-gap-spacer')) return { top: r.top, next: r.bottom }
        const next = g.nextElementSibling ?? g.parentElement!.nextElementSibling
        return { top: r.bottom, next: next ? next.getBoundingClientRect().top : null }
      })
      if (gap.next !== null) {
        const above = box.y - gap.top
        const under = gap.next - (box.y + box.height)
        expect(Math.abs(under - above), `room above ${above}, below ${under}`).toBeLessThanOrEqual(6)
      }
      await expect(panel.locator('.scroll-to-bottom-btn')).not.toBeVisible()
      await shot(page, `05-comment-box-${at === 'bottom' ? 'bottom' : Math.round(at * 100)}`)
      await pill(page).getByRole('button', { name: 'Discard', exact: true }).click()
      await expect(pill(page)).toHaveCount(0)
      // The text gets its own spacing back, and the jump-to-latest arrow may show again.
      await expect(panel.locator('[data-comment-gap]')).toHaveCount(0)
      await expect(page.locator('html.quote-comment-open')).toHaveCount(0)
    }
  })

  test('the Ask choice drops below the passage in one box, never over the selected words', async ({ page }) => {
    // 2026-11-04, the user ("bro this is still not fixed"): selecting two words and
    // opening the Ask choice put it over the line above, its rows spilling out of a
    // box sized for the small button bar (two boxes out of line).
    const panel = await open(page)
    const [p1, , , p4, p5] = await passages(panel)
    const two = (p: string) => p.split(/\s+/).slice(1, 3).join(' ')
    for (const [phrase, at] of [[two(p1), 0.12], [two(p4), 0.5], [two(p5), 'bottom']] as const) {
      await place(page, panel, phrase, at)
      await selectPassage(page, panel, phrase, ANSWER)
      await expect(pill(page)).toBeVisible()
      await pill(page).getByRole('button', { name: 'Choose how to ask: inline or in Tree' }).click()
      const modes = page.getByTestId('quote-ask-modes')
      await expect(modes).toBeVisible()
      const box = await settledBox(pill(page))
      const lines = await passageRects(panel, phrase, ANSWER)
      const bottom = Math.max(...lines.map((r) => r.top + r.height))
      // Under the passage, in a gap the text made for it: no words of any message under it.
      expect(box.y, `menu at ${Math.round(box.y)} vs passage bottom ${Math.round(bottom)} at ${at}`).toBeGreaterThanOrEqual(bottom - 0.5)
      expect(await wordsUnder(panel.locator('.session-history'), box), `words under the choice at ${at}`).toEqual([])
      // Inside the timeline (never on the composer) and inside the message column.
      const tl = (await panel.locator('.session-history').boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(tl.y + tl.height + 0.5)
      const composerTop = (await panel.locator('.session-panel-input').first().boundingBox())!.y
      expect(box.y + box.height, `the choice ends above the composer at ${at}`).toBeLessThanOrEqual(composerTop + 0.5)
      // One row lit at a time, one width whatever is hovered, and the way back said.
      const filled = await modes.locator('.quote-ask-mode').evaluateAll((els) => els.filter((el) => {
        const c = getComputedStyle(el).backgroundColor
        return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'
      }).length)
      expect(filled, `one row lit at ${at}`).toBe(1)
      // One signal for what Enter asks: only the lit row names itself in the accent.
      const accentNames = await modes.locator('.quote-ask-mode').evaluateAll((els) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--accent)'
        document.body.appendChild(probe)
        const accent = getComputedStyle(probe).color
        probe.remove()
        return els.filter((el) => getComputedStyle(el.querySelector('span')!).color === accent).length
      })
      expect(accentNames, `one accent name at ${at}`).toBe(1)
      // The message's own last line (its copy and time row) stays above the composer.
      if (at === 'bottom') {
        const msgBottom = await modes.evaluate(() => {
          const sel = document.querySelector('.quote-pin-pill')
          const rows = Array.from(document.querySelectorAll('[data-message-id]'))
          const last = rows[rows.length - 1] as HTMLElement | undefined
          return sel && last ? last.getBoundingClientRect().bottom : 0
        })
        expect(msgBottom, 'the last message ends above the composer').toBeLessThanOrEqual(composerTop + 0.5)
      }
      // The same form as the Comment box: the column's width, no frame of its own, the "On" line.
      expect(await pill(page).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
      await expect(page.getByTestId('quote-comment-on')).toBeVisible()
      await expect(modes.getByText('Esc goes back')).toBeVisible()
      // The passage keeps its mark, every line of it above the choice.
      await expect.poll(() => painted(page, 'walnut-held-quote')).toBe(1)
      // Up and Down move between the two ways.
      await expect(page.getByTestId('quote-ask-inline')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId('quote-ask-tree')).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(page.getByTestId('quote-ask-inline')).toBeFocused()
      const column = (await panel.locator(`.session-history ${ANSWER} .session-msg-content`).filter({ hasText: phrase }).first().boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(column.x - 0.5)
      expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 0.5)
      // One box: the rows fit inside it, nothing spills out.
      const rows = (await modes.boundingBox())!
      expect(rows.y).toBeGreaterThanOrEqual(box.y - 0.5)
      expect(rows.y + rows.height).toBeLessThanOrEqual(box.y + box.height + 0.5)
      expect(await pill(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
      await shot(page, `06-ask-choice-${at === 'bottom' ? 'bottom' : Math.round(at * 100)}`)
      // Esc steps back to the bar first, a second Esc closes it.
      await page.keyboard.press('Escape')
      await expect(modes).toHaveCount(0)
      await expect(pill(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(pill(page)).toHaveCount(0)
    }
  })

  test('a Comment on a short user message gets a whole box under the bubble', async ({ page }) => {
    // A user message is a bubble as wide as its words: the box keeps the width its
    // field and buttons need, lines up with the bubble's right edge, and the bubble
    // keeps its own size (the room opens under it, not inside it).
    const panel = await open(page)
    const USER = '[data-message-id][data-msg-role="user"]'
    const bubble = panel.locator('.session-history .session-msg-user').filter({ hasText: 'two workers race' }).first()
    await expect(bubble).toBeVisible()
    const before = (await bubble.boundingBox())!
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await centreInHistory(page, panel, 'two workers', { at: 0.4, tolerance: 20 })
    await selectPassage(page, panel, 'two workers', USER)
    await expect(pill(page)).toBeVisible()
    await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByTestId('quote-comment-input')).toBeFocused()
    const box = await settledBox(pill(page))
    const after = (await bubble.boundingBox())!
    const history = (await panel.locator('.session-history').boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(279)
    expect(Math.abs(after.height - before.height), 'the bubble keeps its size').toBeLessThanOrEqual(1)
    expect(box.y, 'the box opens under the bubble').toBeGreaterThanOrEqual(after.y + after.height - 0.5)
    expect(Math.abs(box.x + box.width - (after.x + after.width)), 'lined up with the bubble').toBeLessThanOrEqual(1)
    expect(box.x).toBeGreaterThanOrEqual(history.x)
    expect(await pill(page).evaluate((el) => el.scrollWidth - el.clientWidth), 'no sideways scroll').toBeLessThanOrEqual(1)
    const add = (await page.getByTestId('quote-comment-add').boundingBox())!
    expect(add.x + add.width).toBeLessThanOrEqual(box.x + box.width)
    await shot(page, '07-comment-user-bubble')
    await pill(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(pill(page)).toHaveCount(0)
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
