/**
 * Tree Mode's split screen (design 4, the path bar; 2026-11-03, the user: "4 is
 * good"). On its own fixture session (threads-fixture.ts `SPLIT_SESSION`:
 * Main > 1 > 1.1 > 1.1.1, siblings 2 and 1.2), in the full-screen sheet at
 * 1440x900, with real clicks and keys:
 *
 *  The split shows two pages side by side: the question on screen on the right
 *  and the level before it on the path on the left (equal width by default;
 *  2026-11-11, the user: "parent and child are equal").
 *  A. Asking a new question: the level it was asked from beside it, the new
 *     question on the right with its own composer; each page's composer sends
 *     into its own question (the record's anchor and the send's `question` hint).
 *  B. Cmd+[ / Cmd+] (Ctrl elsewhere) slide the pages along the path; the path bar
 *     keeps the deeper levels; a segment's list shows the questions at its level
 *     with their status words, and a pick switches it and cuts the levels after it.
 *  C. Closing the left page shows the page alone (Split, or the next move to
 *     another page, brings the page before it back); closing the right page
 *     closes its level. A chat area narrower than 600px shows one page.
 *  The split survives a reload. An Ask from a passage in the LEFT page (an answer
 *  still streaming there) hangs the new question on that page.
 *  What keeps the pages through comments, list picks and turns:
 *  session-tree-panes-keep.spec.ts.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { mainComposer, openThreadsSession, switchView, readRecord, resetThreadsFixture, test } from './threads-helpers'
import { SPLIT_PASSAGES, SPLIT_READY, SPLIT_SESSION, SPLIT_TASK, SPLIT_TITLES, buildSplitSession } from './threads-fixture'
import {
  bar, captureSends, hintOf, leftHalf, leftHeader, openQuestion, openSheet, pagesOnScreen, rightBody,
  rightComposer, rightHeader, segments, selectIn, send, shot, sidePages,
} from './tree-split-helpers'

const leftComposer = (panel: Locator) => leftHalf(panel).locator('textarea.chat-input-textarea')
async function expectPages(panel: Locator, pages: string[]): Promise<void> {
  await expect.poll(() => pagesOnScreen(panel), { timeout: 10_000 }).toEqual(pages)
}

const fixture = buildSplitSession()
const headOf = (title: string) => fixture.threadMeta.find((m) => m.title === title)!.headId
const answerOf = (head: string) => fixture.rows[fixture.rows.findIndex((r) => r.uuid === head) + 1].uuid

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

/** Ask here (Tree Mode) on `phrase` in `scope`; the split shows the new question on the right. */
async function askHere(page: Page, panel: Locator, scope: Locator, phrase: string): Promise<void> {
  await selectIn(page, scope, phrase)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(sidePages(panel).first()).toBeVisible({ timeout: 15_000 })
  await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('New question')
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

  test('A: asking splits, each page sends into its own question, a reload keeps the pages', async ({ page }) => {
    // Two turns and a reload: past the default budget on a loaded host.
    test.setTimeout(180_000)
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q11)
    // Three levels, two pages: the path bar names each with its place.
    await expect(bar(panel)).toBeVisible()
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1} [L]`, `1.1 ${SPLIT_TITLES.Q11} [R]`])
    await expectPages(panel, ['L 1', 'R 1.1'])

    await askHere(page, panel, rightBody(panel), SPLIT_PASSAGES.ASK_Q11)
    // State A: the level it was asked in beside it, its passage on screen there.
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await expect(leftHeader(panel).locator('.thread-half-badge')).toHaveText('L')
    await expect(leftHalf(panel).locator('.session-history')).toContainText(SPLIT_PASSAGES.ASK_Q11)
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [L]`, 'New question [R]'])
    await expectPages(panel, ['L 1.1', 'R New question'])
    await expect(rightComposer(panel)).toBeFocused()
    // Each badge is in its segment's name; only the right page is the current one.
    await expect(bar(panel).getByRole('button', { name: new RegExp(`${SPLIT_TITLES.Q11} \\(left page\\)$`) })).toBeVisible()
    await expect(bar(panel).getByRole('button', { name: /New question \(right page\)$/ })).toBeVisible()
    await expect(bar(panel).locator('[aria-current="page"]')).toHaveCount(1)
    await expect(bar(panel).locator('.tree-path-seg[data-role="R"] [aria-current="page"]')).toHaveCount(1)

    const rightWords = `Which rule did it miss, split right ${Date.now()}?`
    await send(rightComposer(panel), rightWords)
    await expect(rightBody(panel).locator('.session-history')).toContainText(rightWords, { timeout: 20_000 })
    // The next child of 1.1: 1.1.2 on a fresh fixture, later when an earlier spec of the
    // run asked under 1.1 too (a reset keeps the transcript's old turns).
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText(/^1\.1\.\d+$/, { timeout: 20_000 })
    const newNum = (await rightHeader(panel).locator('.thread-half-name').textContent())!.trim()
    expect(Number(newNum.split('.')[2])).toBeGreaterThanOrEqual(2)
    await expect(leftHalf(panel).locator('.session-history')).not.toContainText(rightWords)
    await expect(rightHeader(panel).locator('.thread-status-word')).toHaveText(/Answer/, { timeout: 30_000 })
    await expect(rightComposer(panel)).toHaveAttribute('placeholder', /^Reply in /)
    // A long title's placeholder stays on one line in the light composer.
    expect(await rightComposer(panel).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await expect(leftComposer(panel)).toHaveAttribute('placeholder', `Reply in \u201c${SPLIT_TITLES.Q11}\u201d\u2026`)
    // The new question is filed under the passage of 1.1's answer.
    await expect.poll(async () => (await anchorFor(panel, rightWords))?.parent, { timeout: 20_000 }).toBe(answerOf(headOf(SPLIT_TITLES.Q11)))
    expect((await anchorFor(panel, rightWords))?.quote?.exact).toBe(SPLIT_PASSAGES.ASK_Q11)
    // Its send told the model which question it is.
    expect(hintOf(sent, rightWords)).toBe(newNum)
    await expect(rightHeader(panel).locator('.thread-status-word')).toHaveText('Answered', { timeout: 30_000 })
    await shot(page, 'A', panel)

    // The left page's composer posts into 1.1, not into the new question.
    const midWords = `And who reads the binding, split left ${Date.now()}?`
    await send(leftComposer(panel), midWords)
    await expect(leftHalf(panel).locator('.session-history')).toContainText(midWords, { timeout: 20_000 })
    await expect(rightBody(panel).locator('.session-history')).not.toContainText(midWords)
    await expect.poll(async () => (await anchorFor(panel, midWords))?.parent, { timeout: 20_000 }).toBe(answerOf(headOf(SPLIT_TITLES.Q1)))
    expect((await anchorFor(panel, midWords))?.quote?.exact).toBe(SPLIT_PASSAGES.Q11)
    expect(hintOf(sent, midWords)).toBe('1.1')
    // A draft typed in one page stays with its question.
    await leftComposer(panel).fill('left page draft')
    await rightComposer(panel).fill('right page draft')

    // A reload keeps the full screen, Tree Mode, the pages and every draft.
    // Each page's draft is saved under its own question (after the composer's debounce).
    const keys = await Promise.all([leftComposer(panel), rightComposer(panel)].map((b) => b.getAttribute('data-draft-key')))
    expect(new Set(keys).size).toBe(2)
    await expect.poll(() => page.evaluate((ks) => ks.map((k) => localStorage.getItem(k!)), keys))
      .toEqual(['left page draft', 'right page draft'])
    await page.reload()
    // 'load', not 'networkidle': the reloaded page polls, and at a high load it never goes quiet for 500ms.
    await page.waitForLoadState('load')
    const again = page.locator(`.main-page-session-column .session-panel[data-session-id="${SPLIT_SESSION}"]`)
    await expect(leftHalf(again)).toBeVisible({ timeout: 60_000 })
    await expectPages(again, ['L 1.1', `R ${newNum}`])
    await expect(leftComposer(again)).toHaveValue('left page draft')
    await expect(rightComposer(again)).toHaveValue('right page draft')
  })

  test('an Ask from the left page while its answer streams hangs on the left page', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q1)
    await expect(leftHeader(panel).locator('.thread-half-name')).toHaveText('Main conversation')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
    // A message in the LEFT page (Main) whose answer streams for seconds.
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

  test('B: Cmd+[ / Cmd+] slide the pages, a level list switches a segment and cuts the path', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11} [L]`, `1.1.1 ${SPLIT_TITLES.Q111} [R]`,
    ])
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, ['L 1', 'R 1.1'])
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, ['L Main conversation', 'R 1'])
    // The deeper levels stay on the path, unmarked, also after a reload.
    const atEnd = [
      'Main conversation [L]', `1 ${SPLIT_TITLES.Q1} [R]`, `1.1 ${SPLIT_TITLES.Q11}`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ]
    expect(await segments(panel)).toEqual(atEnd)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(leftHalf(panel)).toBeVisible({ timeout: 30_000 })
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
    expect(await segments(panel)).toEqual(atEnd)
    // Main is at most the left page: one more Cmd+[ is taken (never the
    // browser's back) and moves nothing: the pages, the path, the page.
    await rightComposer(panel).focus()
    await watchPairChord(page)
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    expect(await pairTaken(page)).toBe(true)
    await page.waitForTimeout(300)
    expect(await segments(panel)).toEqual(atEnd)
    await expectPages(panel, ['L Main conversation', 'R 1'])
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1')
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.1.1')
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])

    // State B: the list of a segment's level, with status words.
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
    // Picking the question the segment already shows keeps the path; that level
    // is off the two pages, so they slide to show it as the left page.
    await menu.locator('.tree-path-menu-item', { hasText: SPLIT_TITLES.Q1 }).click()
    await expect(menu).toHaveCount(0)
    await expectPages(panel, ['L 1', 'R 1.1'])
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1} [L]`, `1.1 ${SPLIT_TITLES.Q11} [R]`, `1.1.1 ${SPLIT_TITLES.Q111}`,
    ])
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

    // A segment on screen only takes the focus; a deeper list switches only its level.
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-seg-main').click()
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    await expect(leftComposer(panel)).toBeFocused()
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-caret').click()
    await expect(menu.locator('.tree-path-menu-heading')).toHaveText('Level 2 \u00b7 questions on 1')
    await menu.locator('.tree-path-menu-item', { hasText: SPLIT_TITLES.Q12 }).click()
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1.2')
    // A sibling of the same level: still two pages, its parent on the left.
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${SPLIT_TITLES.Q1} [L]`, `1.2 ${SPLIT_TITLES.Q12} [R]`])
    await expectPages(panel, ['L 1', 'R 1.2'])
    // Esc still goes up one level, as before.
    await rightComposer(panel).focus()
    await page.keyboard.press('Escape')
    await expect(rightHeader(panel).locator('.thread-half-name')).toHaveText('1')
    await expectPages(panel, ['L Main conversation', 'R 1'])
  })

  test('C: closing a page; one page only when the reader asks; a narrow chat shows one', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    // Close the left page: one page, the view the reader turned on, every level
    // on the path; the focus in its composer moves to the composer that stays.
    await leftComposer(panel).focus()
    await leftHeader(panel).getByRole('button', { name: 'Close the left page' }).click()
    await expect(sidePages(panel)).toHaveCount(0)
    await expect(rightComposer(panel)).toBeFocused()
    expect(await segments(panel)).toEqual([
      'Main conversation', `1 ${SPLIT_TITLES.Q1}`, `1.1 ${SPLIT_TITLES.Q11}`, `1.1.1 ${SPLIT_TITLES.Q111} [only]`,
    ])
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q111)
    // A wide single page offers the split back. Single: Cmd+[ moves the page.
    await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeVisible()
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q11)
    await expect(sidePages(panel)).toHaveCount(0)
    await shot(page, 'C', panel)
    // Split again: the two pages.
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expectPages(panel, ['L 1', 'R 1.1'])
    // Close the RIGHT page: its level closes.
    await rightHeader(panel).getByRole('button', { name: 'Close the right page' }).click()
    await expectPages(panel, ['L Main conversation', 'R 1'])
    expect(await segments(panel)).toEqual(['Main conversation [L]', `1 ${SPLIT_TITLES.Q1} [R]`])

    // Narrower: two pages down to a 600px chat; under it one, with the path bar
    // and no Split offer; wide again, the pages are back.
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    await page.setViewportSize({ width: 1280, height: 900 })
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    await page.setViewportSize({ width: 800, height: 900 })
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
    await page.setViewportSize({ width: 600, height: 900 })
    await expect(sidePages(panel)).toHaveCount(0)
    // One page is the plain page: no sibling above it either.
    await expect(panel.locator('.tree-split-sibling')).toHaveCount(0)
    await expect(bar(panel)).toBeVisible()
    await expect(bar(panel).locator('.tree-path-seg[data-role="only"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q111)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
  })

  test('a notice in the corner as the sheet opens takes no page away', async ({ page }) => {
    // 2026-11-09, CI: a notice held the corner (another spec's) when the column went full screen,
    // the sheet moved its left edge past it, and Tree Mode kept the 1037px column's two pages in
    // the 1107px sheet. A pending approval card, for this page only, holds the corner here.
    // (The width tiers then were two pages and three; the rule keeps holding for two.)
    const now = Date.now()
    await page.route(/\/api\/v1\/approvals(\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({ json: { keys: [], approvals: [{
        id: 'apr-pw-tree-split-corner', what: 'Corner notice for the split', digest: '0'.repeat(64), mode: 'tap',
        requester: { host: 'pw-host', local: true, cwd: '/work/site', command: 'release.sh', identity: 'none' },
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), status: 'pending',
      }] } })
    })
    const panel = await openSheet(page)
    await expect(page.getByTestId('approval-card')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => panel.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue('--corner-sheet-inset')) || 0), { timeout: 10_000 }).toBeGreaterThan(0)
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await expectPages(panel, ['L 1.1', 'R 1.1.1'])
  })

  test('the path bar never takes Cmd+[ outside Tree Mode, and a column shows as many pages as fit', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, SPLIT_SESSION, SPLIT_TASK, SPLIT_READY, { view: 'stack', pages: 'room' })
    await openQuestion(panel, SPLIT_TITLES.Q11)
    // A normal session column: two pages from a 600px chat, else one, with the path bar.
    await expect(bar(panel)).toBeVisible()
    // Measured the way the split measures it (useTreeSplit): the chat column, or the panel while
    // the column shows one page, since then the chat column is `display: contents` (tree-split.css)
    // and has no box (2026-11-10 CI: a column under 900px beside a parallel test's columns threw on
    // a null box). The width and the pages are read together until they agree, so a column that
    // opens beside this one while the split settles is counted.
    const fitNow = () => panel.evaluate((p) => {
      const w = p.querySelector('.session-panel-chat-col')?.getBoundingClientRect().width || p.getBoundingClientRect().width
      return w >= 600 ? 2 : 1
    })
    let fit = 0
    await expect.poll(async () => {
      fit = await fitNow()
      return `${(await pagesOnScreen(panel)).length || 1} of ${fit}`
    }).toMatch(/^(\d) of \1$/)
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
    if (fit === 1) await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(SPLIT_TITLES.Q1)
    // Two pages slide one level: Main is the left page now.
    else await expect.poll(() => pagesOnScreen(panel)).toEqual(['L Main conversation', 'R 1'])
    // Conversation Mode has no path bar, and the same chord stays the browser's.
    await switchView(panel, 'linear')
    await expect(bar(panel)).toHaveCount(0)
    await mainComposer(panel).focus()
    expect(await chord()).toBe(false)
  })
})
