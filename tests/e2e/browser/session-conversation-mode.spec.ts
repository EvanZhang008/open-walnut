/**
 * One sidebar, one button: Conversation Mode (the default view of a session with
 * questions), the Tree Mode / Conversation Mode pill in the header, and the
 * `[Qn]` reply tag that files an answer under its question.
 *
 * Covers: the pill is the only question control in the header and names the
 * view a click switches to; Conversation Mode shows every row, with ONE label
 * per turn group (number, title, status) and a grey rule down the turn; the
 * sidebar numbers the questions and shows a status word, no colour; a tagged
 * reply is filed by its tag (a turn with no anchor, a turn anchored to the wrong
 * question), and the tag never shows on screen; Ask in Conversation Mode makes
 * the new question the composer's target without opening a page, the send
 * carries the question banner, the reply comes back tagged and stripped, and the
 * question gets its number (`seq`) in the record; a narrow column keeps the pill
 * as an icon and the sidebar as a rail, with the same numbers.
 *
 * Chromium and WebKit. The tagged fixture session is this file's own.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, modePill, nextQuestionNumber, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, switchView,
} from './threads-helpers'
import { buildTaggedSession, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TEXT, TAGGED_TITLES } from './threads-fixture'

const IDS = buildTaggedSession(Date.now()).ids
const T = TAGGED_TEXT

/** Evidence: the panel alone when given (a wide column runs past the viewport). */
async function shot(page: Page, name: string, panel?: Locator): Promise<void> {
  const dir = `/tmp/one-sidebar/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (panel) await panel.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

/** A wide column needs a wide window, or the panel runs past the viewport and
 *  its right half (the bubbles, the header's pill) is off screen. */
async function pinPanelWidth(page: Page, width: number): Promise<void> {
  if (width > 700) await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${TAGGED_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

async function open(page: Page, view: 'stack' | 'linear' = 'linear'): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view })
}

const row = (panel: Locator, id: string) => panel.locator(`.session-history [data-message-id="${id}"]`)
const labelOf = (panel: Locator, id: string) => row(panel, id).locator('.thread-turn-label')
const history = (panel: Locator) => panel.locator('.session-history')

test.describe('Conversation Mode, the mode pill and the question tag', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('the header holds one pill; Conversation Mode labels each turn group once and files tagged replies by their tag', async ({ page }) => {
    const panel = await open(page)
    const header = panel.locator('.session-panel-header')
    // One control, and nothing else about questions up here.
    const pill = modePill(panel)
    await expect(pill).toHaveText('Tree Mode')
    await expect(pill).toHaveAttribute('data-view-mode', 'linear')
    await expect(pill).toHaveAttribute('title', 'Switch to Tree Mode')
    await expect(header.locator('.thread-stack-more, .thread-drawer-toggle')).toHaveCount(0)
    await expect(header).not.toContainText(/\d+ open/)
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')

    // Every row is on screen, in order.
    for (const id of [IDS.R1.u, IDS.Q1.u, IDS.LOST.u, IDS.ROOT.u, IDS.Q2.u, IDS.MERGED.u]) await expect(row(panel, id)).toBeAttached()

    // One label per turn group, above the question's user row; nothing on the answer.
    await expect(labelOf(panel, IDS.Q1.u)).toHaveCount(1)
    await expect(labelOf(panel, IDS.Q1.u).locator('.thread-map-num')).toHaveText('1')
    await expect(labelOf(panel, IDS.Q1.u).locator('.thread-turn-label-title')).toHaveText(TAGGED_TITLES.Q1)
    await expect(labelOf(panel, IDS.Q1.u).locator('.thread-status-word')).toBeVisible()
    await expect(row(panel, IDS.Q1.a).locator('.thread-turn-label')).toHaveCount(0)
    await expect(row(panel, IDS.Q1.a)).toHaveClass(/session-msg--threaded/)
    // The main conversation's turn carries no label and no rule.
    await expect(labelOf(panel, IDS.ROOT.u)).toHaveCount(0)
    await expect(row(panel, IDS.ROOT.u)).not.toHaveClass(/session-msg--threaded/)

    // The tag files the turn: no anchor (lost uuid), and an anchor to the WRONG question.
    await expect(labelOf(panel, IDS.LOST.u).locator('.thread-map-num')).toHaveText('1')
    await expect(labelOf(panel, IDS.LOST.u).locator('.thread-turn-label-title')).toHaveText(TAGGED_TITLES.Q1)
    await expect(labelOf(panel, IDS.MERGED.u).locator('.thread-map-num')).toHaveText('1')
    await expect(labelOf(panel, IDS.Q2.u).locator('.thread-map-num')).toHaveText('2')
    // A turn filed by its tag never says `by order`.
    await expect(panel.locator('.thread-turn-label-by')).toHaveCount(0)

    // The tag itself is never on screen, in any of its spellings.
    const text = await history(panel).innerText()
    expect(text).not.toMatch(/\[Q\s?\d+\]/)
    expect(text).toContain(T.aLost)
    expect(text).toContain(T.a2)
    // The grey rule: 2px, no hue.
    const rule = await row(panel, IDS.Q1.u).evaluate((el) => {
      const cs = getComputedStyle(el)
      return { width: cs.borderLeftWidth, colour: cs.borderLeftColor }
    })
    expect(rule.width).toBe('2px')
    const [r, g, b] = rule.colour.match(/\d+/g)!.map(Number)
    expect(Math.max(r, g, b) - Math.min(r, g, b), `rule colour ${rule.colour} is grey`).toBeLessThanOrEqual(12)
    await shot(page, 'conversation-mode')
  })

  test('the sidebar numbers the questions with status words and no colour; a row is the composer target', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Wide enough for the labelled sidebar (a box of 640px or more).
    await pinPanelWidth(page, 1100)
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    const map = panel.locator('.thread-map')
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const rows = map.locator('.thread-map-row[data-kind="thread"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('.thread-map-num')).toHaveText('1')
    await expect(rows.nth(1).locator('.thread-map-num')).toHaveText('2')
    await expect(rows.nth(0).locator('.thread-map-label')).toHaveText(TAGGED_TITLES.Q1)
    await expect(rows.nth(0).locator('.thread-status-word')).toHaveText(/Answered|New/)
    // No hue anywhere in the map: every number badge is grey on grey.
    const hues = await rows.evaluateAll((els) => els.map((el) => {
      const n = el.querySelector('.thread-map-num') as HTMLElement
      const cs = getComputedStyle(n)
      const chroma = (c: string) => { const v = c.match(/\d+/g)!.map(Number); return Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2]) }
      return Math.max(chroma(cs.backgroundColor), chroma(cs.color))
    }))
    for (const h of hues) expect(h).toBeLessThanOrEqual(12)
    await expect(map.locator('.thread-map-count')).toHaveText('2 open')

    // Main conversation is the target until a row is picked.
    await expect(map.locator('.thread-map-row[data-kind="root"]')).toHaveAttribute('aria-current', 'page')
    await rows.nth(1).click()
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'page')
    // Still Conversation Mode: no page, the question's turns are marked current.
    await expect(modePill(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    await expect(row(panel, IDS.Q2.u)).toHaveAttribute('data-thread-current', 'true')
    await expect(labelOf(panel, IDS.Q2.u)).toHaveAttribute('data-current', 'true')
    await expect(row(panel, IDS.Q1.u)).not.toHaveAttribute('data-thread-current', 'true')
    // The composer says where the next message goes.
    await expect(panel.locator('.chat-input-textarea').first()).toHaveAttribute('placeholder', new RegExp(TAGGED_TITLES.Q2))
    // The row also opened the question's card (session-thread-card.spec.ts
    // covers it); closed here so the label under it can be clicked.
    await panel.locator('.thread-card .thread-card-close').click()
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    // A turn label is the same switch.
    await labelOf(panel, IDS.Q1.u).click()
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'page')
    await expect(row(panel, IDS.MERGED.u)).toHaveAttribute('data-thread-current', 'true')
    await shot(page, 'sidebar-target', panel)
    // Full screen: the same sidebar, labels and pill on the whole window.
    await panel.locator('button[title="Expand to full screen"]').click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await expect(modePill(panel)).toHaveText('Tree Mode')
    // The sheet's entrance fade first, or the shot is half of two layouts.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)
      .map((a) => a.finished.catch(() => undefined))))
    await page.waitForTimeout(300)
    await shot(page, 'fullscreen-wide')
  })

  test('Tree Mode files the same turns onto the question pages; the pill switches both ways and the choice survives a reload', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await pinPanelWidth(page, 1100)
    let panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await switchView(panel, 'stack')
    await expect(modePill(panel)).toHaveText('Conversation Mode')
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
    // Root page: the main line only; the tagged turns are gone from it.
    await expect(row(panel, IDS.ROOT.u)).toBeAttached()
    await expect(row(panel, IDS.LOST.u)).toHaveCount(0)
    await expect(row(panel, IDS.MERGED.u)).toHaveCount(0)
    // Question 1's page holds its head, the lost turn and the merged turn.
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(TAGGED_TITLES.Q1)
    for (const id of [IDS.Q1.u, IDS.Q1.a, IDS.LOST.u, IDS.LOST.a, IDS.MERGED.u, IDS.MERGED.a]) await expect(row(panel, id)).toBeAttached()
    await expect(row(panel, IDS.Q2.u)).toHaveCount(0)
    expect(await history(panel).innerText()).not.toMatch(/\[Q\s?\d+\]/)
    // The choice is per session and survives a reload, and so does the page.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK)
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(TAGGED_TITLES.Q1, { timeout: 30_000 })
    await switchView(panel, 'linear')
    await expect(row(panel, IDS.LOST.u)).toBeAttached()
    await expect(row(panel, IDS.ROOT.u)).toBeAttached()
    await shot(page, 'tree-mode-q1', panel)
  })

  test('Ask in Conversation Mode: the target moves to the new question, the send carries the banner, the reply comes back tagged, stripped and numbered', async ({ page, request }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await pinPanelWidth(page, 1100)
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    const n = await nextQuestionNumber(request, TAGGED_SESSION)
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await passageRects(panel, TAGGED_PASSAGE.slice(0, 30))
    await selectPassage(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    // No page opens; the draft question is the target, and the map shows it as new.
    await expect(modePill(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    const map = panel.locator('.thread-map')
    await expect(map.locator('.thread-map-row[data-kind="draft"], .thread-map-row[data-kind="pending"]')).toHaveCount(1)
    // Record what the page sends over its socket: the banner rides the message.
    await page.evaluate(() => {
      const w = window as unknown as { __sent?: string[] }
      w.__sent = []
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') w.__sent!.push(data)
        return send.call(this, data)
      }
    })
    const box = panel.locator('.chat-input-textarea').first()
    await box.click()
    await box.fill('Which page wins a tie?')
    await box.press('Enter')
    await expect(box).toHaveValue('')
    // The bubble lands in the conversation under a label with the next number
    // (one past the record's highest), and the reply follows it, tag stripped.
    const bubble = panel.locator('.session-history .session-msg--threaded', { hasText: 'Which page wins a tie?' }).first()
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(bubble.locator('.thread-turn-label .thread-map-num')).toHaveText(String(n))
    // The banner rides the send but never the bubble.
    await expect(bubble).not.toContainText(`Question Q${n}`)
    await expect(bubble).not.toContainText('Begin your reply')
    await expect(history(panel)).toContainText('processed your message', { timeout: 60_000 })
    await expect.poll(() => history(panel).innerText()).not.toMatch(/\[Q\s?\d+\]/)
    // The reply is filed under the new question: the map's row says answered, no `by order`.
    const rows = map.locator('.thread-map-row[data-kind="thread"]')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(2).locator('.thread-map-num')).toHaveText(String(n))
    await expect(panel.locator('.thread-turn-label-by')).toHaveCount(0)
    // The record: the question got its number, and the send carried the banner
    // asking for `[Q<n>]` (the mock CLI answers it the way a real model does).
    await expect.poll(async () => (await readRecord(request, TAGGED_SESSION)).threadMeta?.find((m) => (m as { seq?: number }).seq === n)?.headId, { timeout: 20_000 }).toBeTruthy()
    const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.join('\n'))
    expect(sent).toContain(`[Question Q${n}]`)
    expect(sent).toContain(`Begin your reply with the line \\"[Q${n}]\\"`)
    await shot(page, 'ask-in-conversation-mode', panel)
  })

  test('a 480px column: the pill is an icon, the rail is thin lines with no numbers', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await pinPanelWidth(page, 480)
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    const pill = modePill(panel)
    await expect(pill).toHaveAttribute('data-narrow', 'true')
    await expect(pill.locator('.thread-mode-pill-label')).toHaveCount(0)
    await expect(pill).toHaveAttribute('title', 'Switch to Tree Mode')
    const map = panel.locator('.thread-map')
    await expect(map).toHaveAttribute('data-shape', 'rail')
    // The rail is a minimap: one thin line per row (root longer), no badge, no dot.
    await expect(map.locator('.thread-map-mark[data-kind="thread"] .thread-map-tick')).toHaveCount(2)
    await expect(map.locator('.thread-map-mark .thread-map-num, .thread-map-mark .thread-map-root-dot')).toHaveCount(0)
    const tick = await map.locator('.thread-map-mark[data-kind="thread"] .thread-map-tick').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { w: r.width, h: r.height, style: cs.borderTopStyle, colour: cs.borderTopColor }
    })
    expect(tick.w).toBeGreaterThanOrEqual(7)
    expect(tick.h).toBeLessThanOrEqual(3)
    expect(tick.style).toBe('solid')
    const [r, g, b] = tick.colour.match(/\d+/g)!.map(Number)
    expect(Math.max(r, g, b) - Math.min(r, g, b), `tick colour ${tick.colour} is grey`).toBeLessThanOrEqual(12)
    // The labels stay readable at this width: number and title, status as a glyph or word.
    await expect(labelOf(panel, IDS.Q2.u).locator('.thread-map-num')).toHaveText('2')
    await expect(labelOf(panel, IDS.Q2.u).locator('.thread-turn-label-title')).toBeVisible()
    await pill.click()
    await expect(pill).toHaveAttribute('data-view-mode', 'stack')
    await expect(pill).toHaveAttribute('title', 'Switch to Conversation Mode')
    await shot(page, 'narrow-480')
  })
})
