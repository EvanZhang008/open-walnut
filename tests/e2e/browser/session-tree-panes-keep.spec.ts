/**
 * Tree Mode keeps its pages (2026-11-04, the user: a comment in Tree Mode
 * dropped to one page; "after click here it go to single panel mode, what? tree
 * mode is already multi panel"; a turn in the right page threw the left one to
 * the bottom). On the split fixture (Main > 1 > 1.1 > 1.1.1, siblings 2, 1.2) in
 * the full-screen sheet, with real clicks, keys and mouse selections:
 *
 *  - three pages side by side, the last levels of the path, and every way along
 *    the path (Cmd+[ / Cmd+], a path bar segment, the question list, an
 *    "Asked from this answer" row) keeps them: a level on screen only takes the
 *    focus, one left of them slides them;
 *  - a comment made on any page waits in THAT page's composer and goes with its
 *    question, and nothing of the comment flow moves a page;
 *  - a turn in one page never scrolls another (three pages and two);
 *  - a file opened beside the chat narrows the pages for room only; closed, they
 *    come back;
 *  - the right page's sibling sits above it (a third of the column), a regular
 *    page with its own composer; Swap trades the two; it closes and comes back;
 *  - only the main conversation's composer has the "+" menu, the mode and the
 *    model; every other page's is the text box, the mic and send (2026-11-05).
 * The rules behind it: web/src/utils/tree-split-state.ts (retargetNav), and the
 * source ratchet tests/web/tree-nav-keeps-panes.test.ts.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { resetThreadsFixture, test } from './threads-helpers'
import { SPLIT_PASSAGES, SPLIT_SESSION, SPLIT_TITLES } from './threads-fixture'
import {
  bar, captureSends, commentOn, hintOf, leftHalf, middlePage, openQuestion, openSheet, pagesOnScreen,
  rightBody, rightComposer, rightHeader, rowCountOf, scrollBoxOf, scrollTopOf, segments, send, shot, sidePages, siblingPage,
} from './tree-split-helpers'

const T = SPLIT_TITLES
const middleComposer = (panel: Locator) => middlePage(panel).locator('textarea.chat-input-textarea')
const leftComposer = (panel: Locator) => leftHalf(panel).locator('textarea.chat-input-textarea')
const THREE_DEEP = ['L 1', 'M 1.1', 'R 1.1.1']
const THREE_TOP = ['L Main conversation', 'M 1', 'R 1.1']

async function expectPages(panel: Locator, pages: string[]): Promise<void> {
  await expect.poll(() => pagesOnScreen(panel), { timeout: 10_000 }).toEqual(pages)
}

/** Scroll a page's timeline up the way the reader does (a wheel over it), so no landing hold puts it back. */
async function wheelUp(page: Page, scope: Locator): Promise<void> {
  const box = (await scrollBoxOf(scope).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -3000); await page.waitForTimeout(80) }
}
const awayFromBottom = (scope: Locator) => scrollBoxOf(scope).evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))

/** Every page's scroll box is laid out and its position settled. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(600)
}

test.describe('Tree Mode keeps its pages', () => {
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, SPLIT_SESSION) })

  test('three pages, and every way along the path keeps them', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    // The last three levels of the path, the question's own page on the right.
    await expectPages(panel, THREE_DEEP)
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${T.Q1} [L]`, `1.1 ${T.Q11} [M]`, `1.1.1 ${T.Q111} [R]`])
    // Each page's header names it: its number and its title, readable.
    for (const [scope, title] of [[leftHalf(panel), T.Q1], [middlePage(panel), T.Q11], [rightHeader(panel), T.Q111]] as const) {
      const t = scope.locator('.thread-half-title').first()
      await expect(t).toHaveText(title)
      expect((await t.boundingBox())!.width).toBeGreaterThan(50)
    }
    await shot(page, 'three', panel)

    // Cmd+[ slides the three pages one level; Main is at most the left page.
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, THREE_TOP)
    expect(await segments(panel)).toEqual(['Main conversation [L]', `1 ${T.Q1} [M]`, `1.1 ${T.Q11} [R]`, `1.1.1 ${T.Q111}`])
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await page.waitForTimeout(300)
    await expectPages(panel, THREE_TOP)
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expectPages(panel, THREE_DEEP)

    // A segment on screen only takes the focus: nothing moves.
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-seg-main').click()
    await expectPages(panel, THREE_DEEP)
    await expect(middleComposer(panel)).toBeFocused()
    // One left of the pages: they slide so it is the left page, still three.
    await bar(panel).locator('.tree-path-seg').nth(0).locator('.tree-path-seg-main').click()
    await expectPages(panel, THREE_TOP)
    expect(await segments(panel)).toEqual(['Main conversation [L]', `1 ${T.Q1} [M]`, `1.1 ${T.Q11} [R]`, `1.1.1 ${T.Q111}`])
    // One right of them: it is the right page.
    await bar(panel).locator('.tree-path-seg').nth(3).locator('.tree-path-seg-main').click()
    await expectPages(panel, THREE_DEEP)

    // The question list: a question on screen only takes the focus.
    await openQuestion(panel, T.Q1)
    await expectPages(panel, THREE_DEEP)
    await expect(leftComposer(panel)).toBeFocused()

    // An "Asked from this answer" row in a side page: a sibling of the right
    // page goes there, the pages stay three.
    const asked = leftHalf(panel).locator('.thread-asked-from .thread-asked-row', { hasText: T.Q12 })
    await asked.scrollIntoViewIfNeeded()
    await asked.click()
    await expectPages(panel, ['L Main conversation', 'M 1', 'R 1.2'])

    // Another question (2, on Main): as asked, as many pages as its path has.
    await openQuestion(panel, T.Q2)
    await expectPages(panel, ['L Main conversation', 'R 2'])
    expect(await segments(panel)).toEqual(['Main conversation [L]', `2 ${T.Q2} [R]`])
  })

  test('a comment on any page waits in that page and goes with its question; no page moves', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, THREE_DEEP)

    // A comment in the middle page (1.1).
    const midWords = `Middle page note ${Date.now()}`
    await commentOn(page, middlePage(panel), SPLIT_PASSAGES.ASK_Q11, midWords)
    await expectPages(panel, THREE_DEEP)
    const midTray = middlePage(panel).locator('[data-testid="pending-comments"]')
    await expect(midTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    await expect(panel.locator('[data-testid="pending-comments"]')).toHaveCount(1)
    // Its passage and its note on lines of their own, the note whole.
    const midRow = midTray.locator('[data-testid="pending-comment-row"]')
    const where = (await midRow.locator('.pending-comments-where').boundingBox())!
    const note = (await midRow.locator('.pending-comments-text').boundingBox())!
    expect(note.y).toBeGreaterThanOrEqual(where.y + where.height - 1)
    expect(await midRow.locator('.pending-comments-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await shot(page, 'comment-middle', panel)

    // A comment in the right page (1.1.1) waits in the right composer only.
    const rightWords = `Right page note ${Date.now()}`
    await commentOn(page, rightBody(panel), SPLIT_PASSAGES.ASK_Q111, rightWords)
    await expectPages(panel, THREE_DEEP)
    await expect(panel.locator('[data-testid="pending-comments"]')).toHaveCount(2)
    await expect(midTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    const rightTray = panel.locator('.session-panel-input:not(.tree-split-input) [data-testid="pending-comments"]')
    await expect(rightTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)

    // The middle page's message carries its own comment, into 1.1.
    const midAsk = `And who reviews those edits ${Date.now()}?`
    await send(middleComposer(panel), midAsk)
    await expect.poll(() => hintOf(sent, midAsk), { timeout: 10_000 }).toBe('1.1')
    const midSend = sent.find((x) => x.message.includes(midAsk))!
    expect(midSend.message).toContain(midWords)
    expect(midSend.message).not.toContain(rightWords)
    await expect(midTray).toHaveCount(0)
    await expect(rightTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    await expectPages(panel, THREE_DEEP)

    // The right page's comment goes alone (an empty message) into 1.1.1.
    await rightComposer(panel).click()
    await rightComposer(panel).press('Enter')
    await expect.poll(() => sent.find((x) => x.message.includes(rightWords))?.hints?.question?.arg, { timeout: 10_000 }).toBe('1.1.1')
    await expect(rightTray).toHaveCount(0)
    await expectPages(panel, THREE_DEEP)
  })

  for (const shape of [{ name: 'three pages', width: 1440, height: 900, pages: THREE_DEEP }, { name: 'two pages', width: 1280, height: 720, pages: ['L 1.1', 'R 1.1.1'] }]) {
    test(`a turn in one page never scrolls another (${shape.name})`, async ({ page }) => {
      const panel = await openSheet(page, shape.width, shape.height)
      await openQuestion(panel, T.Q111)
      await expectPages(panel, shape.pages)
      await settle(page)
      // Every side page scrolled up by the reader: away from the bottom.
      const sides = sidePages(panel)
      const n = await sides.count()
      for (let i = 0; i < n; i++) await wheelUp(page, sides.nth(i))
      await settle(page)
      const before = await Promise.all(Array.from({ length: n }, (_, i) => scrollTopOf(sides.nth(i))))
      for (let i = 0; i < n; i++) expect(await awayFromBottom(sides.nth(i)), `side page ${i} away from its bottom`).toBeGreaterThan(40)

      // A turn on the right: its answer streams in; the other pages stay put.
      const rowsBefore = await rowCountOf(rightBody(panel))
      await send(rightComposer(panel), `Right page turn ${Date.now()}`)
      await expect(rightBody(panel).locator('.session-history')).toContainText('Right page turn', { timeout: 20_000 })
      // Its answer is in: the message and the reply are rows of the right page.
      await expect.poll(() => rowCountOf(rightBody(panel)), { timeout: 30_000 }).toBeGreaterThanOrEqual(rowsBefore + 2)
      await settle(page)
      const after = await Promise.all(Array.from({ length: n }, (_, i) => scrollTopOf(sides.nth(i))))
      expect(after).toEqual(before)

      // A turn in the left page: the right page, scrolled up, stays put too.
      await wheelUp(page, rightBody(panel))
      await settle(page)
      const rightBefore = await scrollTopOf(rightBody(panel))
      expect(await awayFromBottom(rightBody(panel))).toBeGreaterThan(40)
      const leftRows = await rowCountOf(leftHalf(panel))
      await send(leftComposer(panel), `left page turn ${Date.now()}`)
      await expect(leftHalf(panel).locator('.session-history')).toContainText('left page turn', { timeout: 20_000 })
      await expect.poll(() => rowCountOf(leftHalf(panel)), { timeout: 30_000 }).toBeGreaterThanOrEqual(leftRows + 2)
      await settle(page)
      await page.waitForTimeout(2000)
      expect(await scrollTopOf(rightBody(panel))).toBe(rightBefore)
      if (n > 1) expect(await scrollTopOf(sides.nth(1))).toBe(before[1])
      await expectPages(panel, shape.pages)
    })
  }

  test('a file beside the chat narrows the pages for room only; closed, they come back', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, THREE_DEEP)
    await panel.getByRole('button', { name: 'Files', exact: true }).first().click()
    await expect(panel.locator('.session-file-explorer').first()).toBeVisible({ timeout: 15_000 })
    // Fewer pages fit; Tree Mode and the path bar stay, the question on the right.
    await expect.poll(async () => (await pagesOnScreen(panel)).length, { timeout: 10_000 }).toBeLessThan(3)
    await expect(bar(panel)).toBeVisible()
    const narrowed = await pagesOnScreen(panel)
    if (narrowed.length) expect(narrowed.at(-1)).toBe('R 1.1.1')
    else await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(T.Q111)
    // The page on screen keeps its number and role badge whole in the narrow bar.
    const role = bar(panel).locator('.tree-path-seg[data-shown] .tree-path-role').last()
    await expect(role).toBeVisible()
    const rb = (await role.boundingBox())!
    const bb = (await bar(panel).locator('.tree-path-segs').boundingBox())!
    expect(rb.x + rb.width).toBeLessThanOrEqual(bb.x + bb.width + 1)
    await shot(page, 'file-open', panel)
    await panel.getByRole('button', { name: 'Files', exact: true }).first().click()
    await expectPages(panel, THREE_DEEP)
  })

  test('only the page a turn answers offers Stop; the others still send', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, THREE_TOP)
    // A slow answer in the middle page (1).
    await send(middleComposer(panel), 'chunk-delay:2500 stream-partial-long-text')
    await expect(middlePage(panel).locator('.session-history')).toContainText('Claude Code is working', { timeout: 20_000 })
    const stopIn = (scope: Locator) => scope.getByRole('button', { name: 'Stop the running turn' })
    await expect(stopIn(middlePage(panel))).toBeVisible()
    // Main, the sibling and the right page are not answering: their composers send.
    for (const other of [leftHalf(panel), siblingPage(panel), panel.locator('.session-panel-input:not(.tree-split-input)')]) {
      await expect(stopIn(other)).toHaveCount(0)
    }
    await shot(page, 'stop', panel)
  })

  test('closing a page keeps the pages right of it', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, THREE_DEEP)
    // The middle page closes with the one left of it: the right page alone.
    await middlePage(panel).getByRole('button', { name: 'Close the middle page' }).click()
    await expect(sidePages(panel)).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(T.Q111)
    await expect(bar(panel)).toBeVisible()
  })

  test('the sibling sits above the right page with its own composer; Swap trades the two', async ({ page }) => {
    test.setTimeout(120_000)
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, THREE_TOP)
    // 1.1 is the first asked on 1: its sibling above it is the next one, 1.2.
    const sib = siblingPage(panel)
    await expect(sib).toBeVisible()
    await expect(sib.locator('.thread-half-where')).toHaveText('Next \u00b7 2 of 2')
    // How it relates to the page below stays in sight, in a narrow column too.
    await expect(sib.locator('.thread-half-where')).toBeVisible()
    expect(await sib.locator('.thread-half-where').evaluate((el) => (el as HTMLElement).innerText.trim())).toMatch(/^Next/)
    await expect(sib.locator('.thread-half-name')).toHaveText('1.2')
    await expect(sib.locator('.thread-half-title')).toHaveText(T.Q12)
    await expect(sib.locator('.session-history')).toContainText('Users, groups and service accounts.')
    // Swap keeps its word beside its icon.
    await expect(sib.locator('.thread-half-swap > span')).toBeVisible()
    // Its name is readable and its row fits its column (the buttons never push it out).
    expect((await sib.locator('.thread-half-title').boundingBox())!.width).toBeGreaterThan(60)
    const sibClose = (await sib.getByRole('button', { name: 'Close the sibling page' }).boundingBox())!
    const sibCol = (await sib.boundingBox())!
    expect(sibClose.x + sibClose.width).toBeLessThanOrEqual(sibCol.x + sibCol.width + 1)
    // A third of the right column (the page below it with its own composer).
    const sibBox = (await sib.boundingBox())!
    const bodyBox = (await rightBody(panel).boundingBox())!
    const share = sibBox.height / (sibBox.height + bodyBox.height)
    expect(share).toBeGreaterThan(0.28)
    expect(share).toBeLessThan(0.39)
    expect(Math.abs(sibBox.x - bodyBox.x)).toBeLessThanOrEqual(1)
    await shot(page, 'sibling', panel)

    // Its composer sends into 1.2.
    const words = `Which kinds are allowed, sibling ${Date.now()}?`
    await send(sib.locator('textarea.chat-input-textarea'), words)
    await expect.poll(() => hintOf(sent, words), { timeout: 10_000 }).toBe('1.2')
    await expect(sib.locator('.session-history')).toContainText(words, { timeout: 20_000 })
    await expect(rightBody(panel).locator('.session-history')).not.toContainText(words)
    await expectPages(panel, THREE_TOP)

    // Swap: 1.2 is the right page, 1.1 comes up. The middle page, scrolled by
    // the reader, stays where it is (only the two siblings trade places).
    await wheelUp(page, middlePage(panel))
    await settle(page)
    const midTop = await scrollTopOf(middlePage(panel))
    await sib.getByRole('button', { name: 'Swap with the page below' }).click()
    await expectPages(panel, ['L Main conversation', 'M 1', 'R 1.2'])
    await settle(page)
    expect(await scrollTopOf(middlePage(panel))).toBe(midTop)
    await expect(sib.locator('.thread-half-name')).toHaveText('1.1')
    await expect(sib.locator('.thread-half-title')).toHaveText(T.Q11)
    await expect(sib.locator('.thread-half-where')).toHaveText('Previous \u00b7 1 of 2')
    // The knob on the divider swaps back.
    await sib.locator('.tree-sibling-knob').click()
    await expectPages(panel, THREE_TOP)
    await expect(sib.locator('.thread-half-title')).toHaveText(T.Q12)

    // The divider drags (and the share stays after a reload).
    const div = sib.locator('.tree-sibling-divider')
    const d = (await div.boundingBox())!
    await page.mouse.move(d.x + 20, d.y + d.height / 2)
    await page.mouse.down()
    await page.mouse.move(d.x + 20, d.y + 120, { steps: 6 })
    await page.mouse.up()
    const grown = (await sib.boundingBox())!.height
    expect(grown).toBeGreaterThan(sibBox.height + 80)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(siblingPage(panel)).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => Math.round((await siblingPage(panel).boundingBox())!.height)).toBeGreaterThan(sibBox.height + 80)

    // Closed: gone, the right page offers it back.
    await siblingPage(panel).getByRole('button', { name: 'Close the sibling page' }).click()
    await expect(siblingPage(panel)).toHaveCount(0)
    await expectPages(panel, THREE_TOP)
    await rightHeader(panel).getByRole('button', { name: 'Show the sibling question' }).click()
    await expect(siblingPage(panel)).toBeVisible()
  })

  test('only the main conversation\'s composer has the "+" menu, the mode and the model', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, THREE_TOP)
    const box = (scope: Locator) => scope.locator('.chat-input-box').last()
    const main = box(leftHalf(panel))
    await expect(main.locator('.chat-plus-btn')).toBeVisible()
    await expect(main.locator('.session-mode-bar')).toBeVisible()
    const own = panel.locator('.session-panel-input:not(.tree-split-input) .chat-input-box')
    for (const light of [box(middlePage(panel)), own, box(siblingPage(panel))]) {
      await expect(light).toHaveAttribute('data-light', 'true')
      await expect(light.locator('.chat-plus-btn')).toHaveCount(0)
      await expect(light.locator('.session-mode-bar')).toHaveCount(0)
      await expect(light.locator('.mic-btn-wrapper')).toBeVisible()
      await expect(light.locator('.chat-send-group')).toBeVisible()
    }
    // A light composer is one row: the text, the mic and send side by side.
    for (const light of [box(middlePage(panel)), own]) {
      const b = (await light.boundingBox())!
      expect(b.height).toBeLessThan(60)
      const ta = (await light.locator('textarea').boundingBox())!
      const go = (await light.locator('.chat-send-group').boundingBox())!
      expect(go.x).toBeGreaterThan(ta.x + ta.width - 2)
      expect(go.y + go.height).toBeGreaterThan(ta.y)
      // An empty one shows its placeholder on one line, nothing clipped below it.
      expect(await light.locator('textarea').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
      // Mic and send inside the card, not spilling past its edge.
      const mic = (await light.locator('.mic-btn-wrapper').boundingBox())!
      expect(mic.x).toBeGreaterThan(ta.x + ta.width - 2)
      expect(go.x + go.width).toBeLessThanOrEqual(b.x + b.width)
    }
    // One set of the session's controls on screen, Main's.
    await expect(panel.locator('.session-mode-bar')).toHaveCount(1)
    await shot(page, 'composers', panel)
    // Main alone on screen: the panel's own composer is the full one again.
    await openQuestion(panel, T.Q111)
    await expectPages(panel, THREE_DEEP)
    await expect(panel.locator('.session-mode-bar')).toHaveCount(0)
    await rightComposer(panel).focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(sidePages(panel)).toHaveCount(0)
    await expect(own).not.toHaveAttribute('data-light', 'true')
    await expect(own.locator('.chat-plus-btn')).toBeVisible()
    await expect(own.locator('.session-mode-bar')).toBeVisible()
  })
})
