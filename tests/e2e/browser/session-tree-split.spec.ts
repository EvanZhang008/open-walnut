/**
 * Tree Mode's split screen (design 4, the path bar; 2026-11-03, the user: "4 is
 * good"). On its own fixture session (threads-fixture.ts `SPLIT_SESSION`:
 * Main > 1 > 1.1 > 1.1.1, siblings 2 and 1.2), in the full-screen sheet at
 * 1440x900, with real clicks and keys:
 *
 *  A. Asking a new question splits: left = the level it was asked in, right =
 *     the new question with its own composer; each half's composer sends into
 *     its own question (the record's anchor and the send's `question` hint).
 *  B. Cmd+[ / Cmd+] (Ctrl elsewhere) move the pair along the path; the path bar
 *     keeps the deeper levels; a segment's list shows the questions at its level
 *     with their status words, and a pick switches it and cuts the levels after it.
 *  C. Closing a half leaves one pane; the path bar keeps every level, the page
 *     on screen marked `only`; Split brings the pair back.
 *  The split survives a reload, and a pane too narrow for two halves shows one.
 *  An Ask from a passage in the LEFT half (an answer still streaming there)
 *  hangs the new question on the left page, never on the right one.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { mainComposer, openThreadsSession, switchView, readRecord, resetThreadsFixture, test } from './threads-helpers'
import { SPLIT_PASSAGES, SPLIT_READY, SPLIT_SESSION, SPLIT_TASK, SPLIT_TITLES, buildSplitSession } from './threads-fixture'

const fixture = buildSplitSession()
const headOf = (title: string) => fixture.threadMeta.find((m) => m.title === title)!.headId
const answerOf = (head: string) => fixture.rows[fixture.rows.findIndex((r) => r.uuid === head) + 1].uuid

/** Every `session:send` the page puts on the socket (its text and its hints). */
function captureSends(page: Page): Array<{ message: string; hints?: Record<string, { arg?: string }> }> {
  const sent: Array<{ message: string; hints?: Record<string, { arg?: string }> }> = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload)
      if (row.method === 'session:send') sent.push(row.payload)
    } catch { /* not JSON */ }
  }))
  return sent
}

/** The question hint (its thread id) of the send whose text has `words`. */
function hintOf(sent: ReturnType<typeof captureSends>, words: string): string | undefined {
  return sent.find((x) => x.message.includes(words))?.hints?.question?.arg
}

/** Watch whether the next pair chord was taken (the window listener added after
 *  the panel router's, so it reads the router's verdict). */
async function watchPairChord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __pairTaken?: boolean | null; __pairWatch?: boolean }
    w.__pairTaken = null
    if (w.__pairWatch) return
    w.__pairWatch = true
    window.addEventListener('keydown', (e) => {
      if (e.key === '[' || e.key === ']') w.__pairTaken = e.defaultPrevented
    })
  })
}
const pairTaken = (page: Page) => page.evaluate(() => (window as unknown as { __pairTaken?: boolean | null }).__pairTaken ?? null)

async function shot(page: Page, name: string, target: Locator): Promise<void> {
  const dir = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : `/tmp/tree-split/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await target.screenshot({ path: `${dir}/split-${name}-${test.info().project.name}.png` })
}

async function openSheet(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, SPLIT_SESSION, SPLIT_TASK, SPLIT_READY, { view: 'stack' })
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  return panel
}

/** Open a question from the question list (the right half's map: the left half has none). */
async function openQuestion(panel: Locator, title: string): Promise<void> {
  const map = panel.locator('.session-panel-body .thread-map')
  await expect(map.locator('.thread-map-body')).toBeVisible()
  if (await map.getAttribute('data-shape') === 'rail') {
    const overlay = map.locator('.thread-map-overlay')
    if (await overlay.count() === 0) await map.locator('.thread-map-rail').dispatchEvent('click')
    await expect(overlay).toBeVisible()
  }
  await map.locator('.thread-map-icon[aria-label="Open the question list"]').click()
  const drawer = panel.page().locator('.thread-drawer')
  await expect(drawer).toBeVisible()
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  await drawer.locator('.thread-tree-row').filter({ has: panel.page().locator('.thread-tree-title', { hasText: title }) }).first().focus()
  await panel.page().keyboard.press('Enter')
  await expect(drawer).toHaveCount(0)
}

const bar = (panel: Locator) => panel.locator('.tree-path-bar')
const leftHalf = (panel: Locator) => panel.locator('.tree-split-left')
const rightBody = (panel: Locator) => panel.locator('.session-panel-body')
const leftHeader = (panel: Locator) => leftHalf(panel).locator('.thread-stack-header[data-half="L"]')
const rightHeader = (panel: Locator) => rightBody(panel).locator('.thread-stack-header[data-half="R"]')
const rightComposer = (panel: Locator) => panel.locator('.session-panel-input:not(.tree-split-input) textarea.chat-input-textarea')
const leftComposer = (panel: Locator) => leftHalf(panel).locator('textarea.chat-input-textarea')

/** Each path bar segment as `<number> <title> [role]`. */
async function segments(panel: Locator): Promise<string[]> {
  return bar(panel).locator('.tree-path-seg').evaluateAll((els) => els.map((el) => {
    const num = el.querySelector('.tree-path-num')?.textContent ?? ''
    const title = el.querySelector('.tree-path-title')?.textContent ?? ''
    const role = el.querySelector('.tree-path-role')?.textContent ?? ''
    return [num, title, role ? `[${role}]` : ''].filter(Boolean).join(' ')
  }))
}

/** Drag-select `phrase` inside `scope`'s timeline with the real mouse. */
async function selectIn(page: Page, scope: Locator, phrase: string): Promise<void> {
  const rects = await scope.evaluate((root, needle) => {
    for (const body of Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        const at = t.data.indexOf(needle)
        if (at === -1) continue
        t.parentElement!.scrollIntoView({ block: 'center' })
        const range = document.createRange()
        range.setStart(t, at)
        range.setEnd(t, at + needle.length)
        return Array.from(range.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height }))
      }
    }
    return null
  }, phrase)
  expect(rects, `passage "${phrase}" is not rendered`).not.toBeNull()
  await page.waitForTimeout(200)
  // Measured again after the scroll settled.
  const again = await scope.evaluate((root, needle) => {
    for (const body of Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        const at = t.data.indexOf(needle)
        if (at === -1) continue
        const range = document.createRange()
        range.setStart(t, at)
        range.setEnd(t, at + needle.length)
        return Array.from(range.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height }))
      }
    }
    return null
  }, phrase)
  const first = again![0]
  const last = again![again!.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move((first.left + last.right) / 2, last.top + last.height / 2, { steps: 5 })
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 5 })
  await page.mouse.up()
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim().length).toBeGreaterThan(0)
}

/** Ask here (Tree Mode) on `phrase` in `scope`; the split shows the new question on the right. */
async function askHere(page: Page, panel: Locator, scope: Locator, phrase: string): Promise<void> {
  await selectIn(page, scope, phrase)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(leftHalf(panel)).toBeVisible({ timeout: 15_000 })
  await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('New question')
}

async function send(box: Locator, text: string): Promise<void> {
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

/** The newest anchor the record holds whose question text has `words`. */
async function anchorFor(panel: Locator, words: string): Promise<{ msgId: string; parent: string; quote?: { exact: string } } | undefined> {
  const rec = await readRecord(panel.page().request, SPLIT_SESSION)
  const res = await panel.page().request.get(`/api/sessions/${SPLIT_SESSION}/history`)
  const rows = res.ok() ? ((await res.json()) as { messages?: Array<{ role: string; text?: string; msgId?: string; sourceUuid?: string }> }).messages ?? [] : []
  const row = [...rows].reverse().find((r) => r.role === 'user' && (r.text ?? '').includes(words))
  const id = row?.sourceUuid ?? row?.msgId
  return (rec.threadAnchors as Array<{ msgId: string; parent: string; quote?: { exact: string } }> | undefined)?.find((a) => a.msgId === id)
}

test.describe('Tree Mode split screen', () => {
  // One fixture session: tests sending into it must not run side by side.
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, SPLIT_SESSION) })

  test('A: asking splits, each half sends into its own question, a reload keeps the pair', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q11)
    // Single: the path bar names every level, the page on screen marked `only`.
    await expect(bar(panel)).toBeVisible()
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [only]`])
    await expect(leftHalf(panel)).toHaveCount(0)

    await askHere(page, panel, rightBody(panel), SPLIT_PASSAGES.ASK_Q11)
    // State A: the level it was asked in on the left, its passage on screen there.
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await expect(leftHeader(panel).locator('.thread-half-badge')).toHaveText('L')
    await expect(leftHalf(panel).locator('.session-history')).toContainText(SPLIT_PASSAGES.ASK_Q11)
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [L]`, 'New question [R]'])
    await expect(rightComposer(panel)).toBeFocused()
    // Each badge is in its segment's name; only the right page is the current one.
    await expect(bar(panel).getByRole('button', { name: new RegExp(`${SPLIT_TITLES.Q11} \\(left half\\)$`) })).toBeVisible()
    await expect(bar(panel).getByRole('button', { name: /New question \(right half\)$/ })).toBeVisible()
    await expect(bar(panel).locator('[aria-current="page"]')).toHaveCount(1)
    await expect(bar(panel).locator('.tree-path-seg[data-role="R"] [aria-current="page"]')).toHaveCount(1)

    const rightWords = `Which rule did it miss, split right ${Date.now()}?`
    await send(rightComposer(panel), rightWords)
    await expect(rightBody(panel).locator('.session-history')).toContainText(rightWords, { timeout: 20_000 })
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1.2', { timeout: 20_000 })
    await expect(leftHalf(panel).locator('.session-history')).not.toContainText(rightWords)
    await expect(rightHeader(panel).locator('.thread-status-word')).toHaveText(/Answer/, { timeout: 30_000 })
    await expect(rightComposer(panel)).toHaveAttribute('placeholder', /^Reply in /)
    await expect(leftComposer(panel)).toHaveAttribute('placeholder', `Reply in \u201c${SPLIT_TITLES.Q11}\u201d\u2026`)
    // The new question is filed under the passage of 1.1's answer.
    await expect.poll(async () => (await anchorFor(panel, rightWords))?.parent, { timeout: 20_000 }).toBe(answerOf(headOf(SPLIT_TITLES.Q11)))
    expect((await anchorFor(panel, rightWords))?.quote?.exact).toBe(SPLIT_PASSAGES.ASK_Q11)
    // Its send told the model which question it is.
    expect(hintOf(sent, rightWords)).toBe('1.1.2')
    await expect(rightHeader(panel).locator('.thread-status-word')).toHaveText('Answered', { timeout: 30_000 })
    await shot(page, 'A', panel)

    // The left half's composer posts into 1.1, not into the new question.
    const leftWords = `And who reads the binding, split left ${Date.now()}?`
    await send(leftComposer(panel), leftWords)
    await expect(leftHalf(panel).locator('.session-history')).toContainText(leftWords, { timeout: 20_000 })
    await expect(rightBody(panel).locator('.session-history')).not.toContainText(leftWords)
    await expect.poll(async () => (await anchorFor(panel, leftWords))?.parent, { timeout: 20_000 }).toBe(answerOf(headOf(SPLIT_TITLES.Q1)))
    expect((await anchorFor(panel, leftWords))?.quote?.exact).toBe(SPLIT_PASSAGES.Q11)
    expect(hintOf(sent, leftWords)).toBe('1.1')
    // A draft typed in one half stays with its question.
    await leftComposer(panel).fill('left half draft')
    await rightComposer(panel).fill('right half draft')

    // A reload keeps the full screen, Tree Mode, the pair and both drafts.
    // Each half's draft is saved under its own question (after the composer's debounce).
    const leftKey = (await leftComposer(panel).getAttribute('data-draft-key'))!
    const rightKey = (await rightComposer(panel).getAttribute('data-draft-key'))!
    expect(leftKey).not.toBe(rightKey)
    await expect.poll(() => page.evaluate(([l, r]) => [localStorage.getItem(l), localStorage.getItem(r)], [leftKey, rightKey]))
      .toEqual(['left half draft', 'right half draft'])
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = page.locator(`.main-page-session-column .session-panel[data-session-id="${SPLIT_SESSION}"]`)
    await expect(leftHalf(again)).toBeVisible({ timeout: 30_000 })
    await expect(leftHeader(again).locator('.thread-half-name')).toHaveText('1.1')
    await expect(rightHeader(again).locator('.thread-half-name')).toHaveText('1.1.2')
    await expect(leftComposer(again)).toHaveValue('left half draft')
    await expect(rightComposer(again)).toHaveValue('right half draft')
  })

  test('an Ask from the left half while its answer streams hangs on the left page', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q1)
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('Main conversation')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
    // A message in the LEFT half (Main) whose answer streams for seconds.
    await send(leftComposer(panel), 'chunk-delay:2500 stream-partial-long-text')
    const streamed = 'never blocks on a slow writer'
    await expect(leftHalf(panel).locator('.session-history')).toContainText(streamed, { timeout: 20_000 })
    // Still streaming: the passage is not in the question tree yet.
    await expect(leftHalf(panel).locator('.session-history')).not.toContainText('flips the read path over')
    await askHere(page, panel, leftHalf(panel), streamed)
    // The new question is on the page the passage is on: Main | New question,
    // never under the right page (1).
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('Main conversation')
    expect(await segments(panel)).toEqual(['Main conversation [L]', 'New question [R]'])
    // Once the answer has landed, the question asked there is sent as a
    // question on Main (its id `3`, beside 1 and 2), not under 1. (This mock
    // mode keeps no transcript of its streamed turn, so the page is not
    // followed past the send.)
    await expect(leftHalf(panel).locator('.session-history')).toContainText('flips the read path over', { timeout: 30_000 })
    const words = `Which writer does it skip, split stream ${Date.now()}?`
    await send(rightComposer(panel), words)
    await expect.poll(() => hintOf(sent, words), { timeout: 10_000 }).toBe('3')
  })

  test('B: Cmd+[ / Cmd+] move the pair, a level list switches a segment and cuts the path', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(leftHalf(panel)).toBeVisible()
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [L]`, `1.1.1 ${SPLIT_TITLES.Q111} [R]`,
    ])
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1')
    // The deeper level stays on the path, unmarked, also after a reload.
    const moved = [
      'Main conversation', `1 ${SPLIT_TITLES.Q1} [L]`, `1.1 ${SPLIT_TITLES.Q11} [R]`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ]
    expect(await segments(panel)).toEqual(moved)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(leftHalf(panel)).toBeVisible({ timeout: 30_000 })
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    expect(await segments(panel)).toEqual(moved)
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('Main conversation')
    // Main is at most the left half: one more Cmd+[ is taken (never the
    // browser's back) and moves nothing: the pair, the path, the page.
    const atEnd = [
      'Main conversation [L]', `1 ${SPLIT_TITLES.Q1} [R]`, `1.1 ${SPLIT_TITLES.Q11}`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ]
    expect(await segments(panel)).toEqual(atEnd)
    await watchPairChord(page)
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    expect(await pairTaken(page)).toBe(true)
    await page.waitForTimeout(300)
    expect(await segments(panel)).toEqual(atEnd)
    await expect(leftHalf(panel)).toBeVisible()
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')

    // State B: the list of the left segment's level, with status words.
    const seg1 = bar(panel).locator('.tree-path-seg').nth(1)
    await seg1.locator('.tree-path-caret').click()
    const menu = page.locator('.tree-path-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.tree-path-menu-heading')).toHaveText('Level 1 \u00b7 questions on Main')
    await expect(menu.locator('.tree-path-menu-item')).toHaveCount(2)
    await expect(menu.locator('.tree-path-menu-item').nth(0)).toContainText(SPLIT_TITLES.Q1)
    await expect(menu.locator('.tree-path-menu-item').nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(menu.locator('.tree-path-menu-item').nth(1).locator('.thread-status-word')).toHaveText('Answered')
    const m = await menu.boundingBox()
    expect(m!.x).toBeGreaterThanOrEqual(0)
    expect(m!.y + m!.height).toBeLessThanOrEqual(900)
    await shot(page, 'B', panel)
    // Picking the question the LEFT segment already shows moves nothing.
    await menu.locator('.tree-path-menu-item', { hasText: SPLIT_TITLES.Q1 }).click()
    await expect(menu).toHaveCount(0)
    await page.waitForTimeout(300)
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1')
    // Tab leaves the list on its caret.
    await seg1.locator('.tree-path-caret').click()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(seg1.locator('.tree-path-caret')).toBeFocused()
    // Picking 2 switches the segment: Main | 2, and the levels after it are gone.
    await seg1.locator('.tree-path-caret').click()
    await menu.locator('.tree-path-menu-item', { hasText: SPLIT_TITLES.Q2 }).click()
    await expect(menu).toHaveCount(0)
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('2')
    expect(await segments(panel)).toEqual(['Main conversation [L]', `2 ${SPLIT_TITLES.Q2} [R]`])

    // A segment click moves the pair there; a deeper list switches only its level.
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-seg-main').click()
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-caret').click()
    await expect(menu.locator('.tree-path-menu-heading')).toHaveText('Level 2 \u00b7 questions on 1')
    await menu.locator('.tree-path-menu-item', { hasText: SPLIT_TITLES.Q12 }).click()
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.2')
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1} [L]`, `1.2 ${SPLIT_TITLES.Q12} [R]`])
    // Esc still goes up one level, as before.
    await rightComposer(panel).focus()
    await page.keyboard.press('Escape')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
  })

  test('C: closing a half leaves one pane with the whole path; a narrow pane never splits', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(leftHalf(panel)).toBeVisible()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    // Close the left half: one pane, 1.1 alone, every level still on the path;
    // the focus in its composer moves to the composer that stays.
    await leftComposer(panel).focus()
    await leftHeader(panel).getByRole('button', { name: 'Close the left half' }).click()
    await expect(leftHalf(panel)).toHaveCount(0)
    await expect(rightComposer(panel)).toBeFocused()
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [only]`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ])
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q11)
    // A wide single pane offers the split back.
    await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeVisible()
    // Single: Cmd+] moves the page along the path.
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q111)
    await shot(page, 'C', panel)
    // Split again, then close the RIGHT half: its parent alone.
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await rightHeader(panel).getByRole('button', { name: 'Close the right half' }).click()
    await expect(leftHalf(panel)).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q11)
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [only]`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ])

    // Too narrow for two halves: the split stays chosen but one page shows,
    // with the path bar and no Split offer; wide again, the pair is back.
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(leftHalf(panel)).toBeVisible()
    await page.setViewportSize({ width: 860, height: 900 })
    await expect(leftHalf(panel)).toHaveCount(0)
    await expect(bar(panel)).toBeVisible()
    await expect(bar(panel).locator('.tree-path-seg[data-role="only"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q11)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(leftHalf(panel)).toBeVisible()
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1')
  })

  test('under the task tabs: the path bar sits right below them and a task tab covers both halves', async ({ page, request }) => {
    // A task the main chat names, so its pill opens it as a tab beside the chat.
    const created = await request.post('/api/tasks', { data: { title: `Split peek probe ${Date.now()}`, source: 'local' } })
    expect(created.ok()).toBe(true)
    const probe = ((await created.json()) as { task: { id: string } }).task.id
    try {
      const panel = await openSheet(page)
      await send(rightComposer(panel), `snapshot-clean-turn:The probe is ${probe}, ask it first.`)
      const pill = rightBody(panel).locator(`a.task-link[data-task-id="${probe}"]`).last()
      await expect(pill).toBeVisible({ timeout: 30_000 })
      await openQuestion(panel, SPLIT_TITLES.Q1)
      await page.getByRole('button', { name: 'Split', exact: true }).click()
      await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('Main conversation')
      // The pill is on Main, the left page: it opens the probe as a tab.
      await leftHalf(panel).locator(`a.task-link[data-task-id="${probe}"]`).last().click()
      const peek = panel.getByTestId('board-task-peek')
      await expect(peek).toHaveAttribute('data-task-id', probe)
      const col = panel.locator('.session-panel-chat-col')
      const tabBar = col.locator(':scope > .peek-tab-bar')
      await expect(tabBar).toBeVisible()
      const tabBox = (await tabBar.boundingBox())!
      const peekBox = (await peek.boundingBox())!
      const colBox = (await col.boundingBox())!
      // The tab covers the whole column below the tabs: both halves, both composers.
      expect(Math.abs(peekBox.y - (tabBox.y + tabBox.height))).toBeLessThanOrEqual(1)
      expect(Math.abs(peekBox.width - colBox.width)).toBeLessThanOrEqual(2)
      expect(Math.abs(peekBox.y + peekBox.height - (colBox.y + colBox.height))).toBeLessThanOrEqual(1)
      await shot(page, 'peek-task', panel)
      // Back to the chat: the path bar right under the tabs (one header offset,
      // not two), both halves and the right composer filling the column.
      await tabBar.getByRole('tab', { name: 'Chat', exact: true }).click()
      await expect(peek).toHaveCount(0)
      await expect(leftHalf(panel)).toBeVisible()
      const barBox = (await bar(panel).boundingBox())!
      expect(Math.abs(barBox.y - (tabBox.y + tabBox.height))).toBeLessThanOrEqual(1)
      const leftBox = (await leftHalf(panel).boundingBox())!
      const inputBox = (await panel.locator('.session-panel-input:not(.tree-split-input)').boundingBox())!
      expect(Math.abs(leftBox.y - (barBox.y + barBox.height))).toBeLessThanOrEqual(1)
      expect(Math.abs(leftBox.y + leftBox.height - (colBox.y + colBox.height))).toBeLessThanOrEqual(1)
      expect(Math.abs(inputBox.y + inputBox.height - (colBox.y + colBox.height))).toBeLessThanOrEqual(1)
      await shot(page, 'peek-chat', panel)
    } finally {
      await request.delete(`/api/tasks/${probe}?force=true`)
    }
  })

  test('the path bar never takes Cmd+[ outside Tree Mode, and a column shows one page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, SPLIT_SESSION, SPLIT_TASK, SPLIT_READY, { view: 'stack' })
    await openQuestion(panel, SPLIT_TITLES.Q11)
    // A normal session column is narrower than two halves: one page and the path bar.
    await expect(bar(panel)).toBeVisible()
    await expect(leftHalf(panel)).toHaveCount(0)
    // The platform's own chord only (Cmd on a Mac, Ctrl elsewhere): a press of
    // both is no pair chord on any platform.
    const chord = () => page.evaluate(() => {
      const mac = /mac|iphone|ipad/i.test(navigator.platform)
      const ev = new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true })
      window.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    // Tree Mode takes it (the control): the page moves up the path.
    await mainComposer(panel).focus()
    expect(await chord()).toBe(true)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q1)
    // Conversation Mode has no path bar, and the same chord stays the browser's.
    await switchView(panel, 'linear')
    await expect(bar(panel)).toHaveCount(0)
    await mainComposer(panel).focus()
    expect(await chord()).toBe(false)
  })
})
