/**
 * Tree Mode keeps its pages (2026-11-04, the user: a comment in Tree Mode
 * dropped to one page; "after click here it go to single panel mode, what? tree
 * mode is already multi panel"; a turn in the right page threw the left one to
 * the bottom; 2026-11-10: "we always show current one and previous one (1/3
 * size)"). On the split fixture (Main > 1 > 1.1 > 1.1.1, siblings 2, 1.2) in
 * the full-screen sheet, with real clicks, keys and mouse selections:
 *
 *  - two pages side by side, the current one (two thirds) and the one before it
 *    on the path (a third), at every depth, and every way along the path
 *    (Cmd+[ / Cmd+], a path bar segment, the question list, an "Asked from this
 *    answer" row, a pick between siblings from a level's list) keeps them: a
 *    level on screen only takes the focus, one left of them slides them;
 *  - a narrow sheet (about 780px) still shows both pages;
 *  - a comment made on either page waits in THAT page's composer and goes with
 *    its question, and nothing of the comment flow moves a page;
 *  - a turn in one page never scrolls the other (a wide sheet and a narrow one);
 *  - a file opened beside the chat narrows the pages for room only; closed, they
 *    come back;
 *  - the right page's sibling sits above it (a third of the column), a regular
 *    page with its own composer; Swap trades the two; it closes and comes back;
 *  - closing the left page shows one page (the view the reader asked for) until Split;
 *  - only the main conversation's composer has the "+" menu, the mode and the
 *    model; every other page's is the text box, the mic and send (2026-11-05).
 * The rules behind it: web/src/utils/tree-split-state.ts (retargetNav), and the
 * source ratchet tests/web/tree-nav-keeps-panes.test.ts.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { resetThreadsFixture, test } from './threads-helpers'
import { SPLIT_PASSAGES, SPLIT_SESSION, SPLIT_TITLES } from './threads-fixture'
import {
  bar, captureSends, commentOn, hintOf, leftHalf, openQuestion, openSheet, pagesOnScreen,
  rightBody, rightComposer, rightHeader, rowCountOf, scrollBoxOf, scrollTopOf, segments, send, shot, sidePages, siblingPage,
} from './tree-split-helpers'

const T = SPLIT_TITLES
const leftComposer = (panel: Locator) => leftHalf(panel).locator('textarea.chat-input-textarea')
/** The current page and the one before it, at each depth of the fixture's path. */
const TWO_DEEP = ['L 1.1', 'R 1.1.1']
const TWO_MID = ['L 1', 'R 1.1']
const TWO_TOP = ['L Main conversation', 'R 1']

/** The left page's share of the two pages' width (a third). */
async function leftShare(panel: Locator): Promise<number> {
  const l = (await leftHalf(panel).boundingBox())!
  const r = (await rightBody(panel).boundingBox())!
  return l.width / (l.width + r.width)
}

/** Pick `title` from the list of path bar segment `j`. */
async function pickAtLevel(panel: Locator, j: number, heading: string, title: string): Promise<void> {
  await bar(panel).locator('.tree-path-seg').nth(j).locator('.tree-path-caret').click()
  const menu = panel.page().locator('.tree-path-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.tree-path-menu-heading')).toHaveText(heading)
  await menu.locator('.tree-path-menu-item', { hasText: title }).click()
  await expect(menu).toHaveCount(0)
}

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

  test('two pages, the current one and the one before it, and every way along the path keeps them', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    // The last two levels of the path, the question's own page on the right.
    await expectPages(panel, TWO_DEEP)
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${T.Q1}`, `1.1 ${T.Q11} [L]`, `1.1.1 ${T.Q111} [R]`])
    // Each page's header names it: its number and its title, readable.
    for (const [scope, title] of [[leftHalf(panel), T.Q11], [rightHeader(panel), T.Q111]] as const) {
      const t = scope.locator('.thread-half-title').first()
      await expect(t).toHaveText(title)
      expect((await t.boundingBox())!.width).toBeGreaterThan(50)
    }
    // The previous page a third of the width, the current one two thirds.
    const share = await leftShare(panel)
    expect(share, `left share ${share}`).toBeGreaterThan(0.30)
    expect(share, `left share ${share}`).toBeLessThan(0.37)
    await shot(page, 'two', panel)

    // Cmd+[ slides the two pages one level at a time; Main is at most the left page.
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, TWO_MID)
    expect(await segments(panel)).toEqual(['Main conversation', `1 ${T.Q1} [L]`, `1.1 ${T.Q11} [R]`, `1.1.1 ${T.Q111}`])
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, TWO_TOP)
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await page.waitForTimeout(300)
    await expectPages(panel, TWO_TOP)
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expectPages(panel, TWO_MID)
    await page.keyboard.press('ControlOrMeta+BracketRight')
    await expectPages(panel, TWO_DEEP)

    // A segment on screen only takes the focus: nothing moves.
    await bar(panel).locator('.tree-path-seg').nth(2).locator('.tree-path-seg-main').click()
    await expectPages(panel, TWO_DEEP)
    await expect(leftComposer(panel)).toBeFocused()
    // One left of the pages: they slide so it is the left page, still two.
    await bar(panel).locator('.tree-path-seg').nth(0).locator('.tree-path-seg-main').click()
    await expectPages(panel, TWO_TOP)
    expect(await segments(panel)).toEqual(['Main conversation [L]', `1 ${T.Q1} [R]`, `1.1 ${T.Q11}`, `1.1.1 ${T.Q111}`])
    // One right of them: it is the right page.
    await bar(panel).locator('.tree-path-seg').nth(3).locator('.tree-path-seg-main').click()
    await expectPages(panel, TWO_DEEP)

    // The question list: a question on screen only takes the focus.
    await openQuestion(panel, T.Q11)
    await expectPages(panel, TWO_DEEP)
    await expect(leftComposer(panel)).toBeFocused()
    // One left of the pages: they slide, still two.
    await openQuestion(panel, T.Q1)
    await expectPages(panel, TWO_MID)

    // An "Asked from this answer" row in the left page: a sibling of the right
    // page goes there, the pages stay two.
    const asked = leftHalf(panel).locator('.thread-asked-from .thread-asked-row', { hasText: T.Q12 })
    await asked.scrollIntoViewIfNeeded()
    await asked.click()
    await expectPages(panel, ['L 1', 'R 1.2'])

    // Another question (2, on Main): as asked, Main beside it.
    await openQuestion(panel, T.Q2)
    await expectPages(panel, ['L Main conversation', 'R 2'])
    expect(await segments(panel)).toEqual(['Main conversation [L]', `2 ${T.Q2} [R]`])
  })

  test('switching between siblings at one level keeps both pages (2026-11-10)', async ({ page }) => {
    // The user's report: going to the third question of a level showed it alone.
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, TWO_MID)
    // Level 2 (questions on 1): 1.1 to its sibling 1.2 and back; 1 stays the left page.
    await pickAtLevel(panel, 2, 'Level 2 \u00b7 questions on 1', T.Q12)
    await expectPages(panel, ['L 1', 'R 1.2'])
    await expect(sidePages(panel)).toHaveCount(1)
    await pickAtLevel(panel, 2, 'Level 2 \u00b7 questions on 1', T.Q11)
    await expectPages(panel, TWO_MID)
    // Level 1 (questions on Main): 1 to 2 and back; Main stays the left page.
    await pickAtLevel(panel, 1, 'Level 1 \u00b7 questions on Main', T.Q2)
    await expectPages(panel, ['L Main conversation', 'R 2'])
    await pickAtLevel(panel, 1, 'Level 1 \u00b7 questions on Main', T.Q1)
    await expectPages(panel, TWO_TOP)
    await shot(page, 'siblings', panel)
  })

  test('a narrow sheet still shows the current page and the one before it', async ({ page }) => {
    // About 780px of chat: two pages (one only under 600px, a phone width).
    const panel = await openSheet(page, 800, 800)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, TWO_DEEP)
    const share = await leftShare(panel)
    expect(share, `left share ${share}`).toBeGreaterThan(0.30)
    expect(share, `left share ${share}`).toBeLessThan(0.37)
    await rightComposer(panel).focus()
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectPages(panel, TWO_MID)
    await shot(page, 'narrow', panel)
  })

  test('a comment on either page waits in that page and goes with its question; no page moves', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, TWO_DEEP)

    // A comment in the left page (1.1).
    const leftWords = `Left page note ${Date.now()}`
    await commentOn(page, leftHalf(panel), SPLIT_PASSAGES.ASK_Q11, leftWords)
    await expectPages(panel, TWO_DEEP)
    const leftTray = leftHalf(panel).locator('[data-testid="pending-comments"]')
    await expect(leftTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    await expect(panel.locator('[data-testid="pending-comments"]')).toHaveCount(1)
    // Its passage and its note on lines of their own, the note whole (in a third of the sheet).
    const leftRow = leftTray.locator('[data-testid="pending-comment-row"]')
    const where = (await leftRow.locator('.pending-comments-where').boundingBox())!
    const note = (await leftRow.locator('.pending-comments-text').boundingBox())!
    expect(note.y).toBeGreaterThanOrEqual(where.y + where.height - 1)
    await shot(page, 'comment-left', panel)

    // A comment in the right page (1.1.1) waits in the right composer only.
    const rightWords = `Right page note ${Date.now()}`
    await commentOn(page, rightBody(panel), SPLIT_PASSAGES.ASK_Q111, rightWords)
    await expectPages(panel, TWO_DEEP)
    await expect(panel.locator('[data-testid="pending-comments"]')).toHaveCount(2)
    await expect(leftTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    const rightTray = panel.locator('.session-panel-input:not(.tree-split-input) [data-testid="pending-comments"]')
    await expect(rightTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    // The right page has the room: its note is whole.
    expect(await rightTray.locator('.pending-comments-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

    // The left page's message carries its own comment, into 1.1.
    const leftAsk = `And who reviews those edits ${Date.now()}?`
    await send(leftComposer(panel), leftAsk)
    await expect.poll(() => hintOf(sent, leftAsk), { timeout: 10_000 }).toBe('1.1')
    const leftSend = sent.find((x) => x.message.includes(leftAsk))!
    expect(leftSend.message).toContain(leftWords)
    expect(leftSend.message).not.toContain(rightWords)
    await expect(leftTray).toHaveCount(0)
    await expect(rightTray.locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    await expectPages(panel, TWO_DEEP)

    // The right page's comment goes alone (an empty message) into 1.1.1.
    await rightComposer(panel).click()
    await rightComposer(panel).press('Enter')
    await expect.poll(() => sent.find((x) => x.message.includes(rightWords))?.hints?.question?.arg, { timeout: 10_000 }).toBe('1.1.1')
    await expect(rightTray).toHaveCount(0)
    await expectPages(panel, TWO_DEEP)
  })

  for (const shape of [{ name: 'wide sheet', width: 1440, height: 640, pages: TWO_DEEP }, { name: 'narrow sheet', width: 800, height: 720, pages: TWO_DEEP }]) {
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
      await expectPages(panel, shape.pages)
    })
  }

  test('a file beside the chat narrows the pages for room only; closed, they come back', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, TWO_DEEP)
    await panel.getByRole('button', { name: 'Files', exact: true }).first().click()
    await expect(panel.locator('.session-file-explorer').first()).toBeVisible({ timeout: 15_000 })
    // The chat is narrower; Tree Mode and the path bar stay, the question on the right
    // (two pages while the chat holds 600px, else the page alone).
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
    await expectPages(panel, TWO_DEEP)
  })

  test('only the page a turn answers offers Stop; the others still send', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, TWO_MID)
    // A slow answer in the left page (1).
    await send(leftComposer(panel), 'chunk-delay:2500 stream-partial-long-text')
    await expect(leftHalf(panel).locator('.session-history')).toContainText('Claude Code is working', { timeout: 20_000 })
    const stopIn = (scope: Locator) => scope.getByRole('button', { name: 'Stop the running turn' })
    await expect(stopIn(leftHalf(panel))).toBeVisible()
    // The sibling and the right page are not answering: their composers send.
    for (const other of [siblingPage(panel), panel.locator('.session-panel-input:not(.tree-split-input)')]) {
      await expect(stopIn(other)).toHaveCount(0)
    }
    await shot(page, 'stop', panel)
  })

  test('closing the left page shows one page until Split brings the two back', async ({ page }) => {
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q111)
    await expectPages(panel, TWO_DEEP)
    // The left page closes: the right page alone, the path bar stays.
    await leftHalf(panel).getByRole('button', { name: 'Close the left page' }).click()
    await expect(sidePages(panel)).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(T.Q111)
    await expect(bar(panel)).toBeVisible()
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expectPages(panel, TWO_DEEP)
  })

  test('the sibling sits above the right page with its own composer; Swap trades the two', async ({ page }) => {
    test.setTimeout(120_000)
    const sent = captureSends(page)
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, TWO_MID)
    // 1.1 is the first asked on 1: its sibling above it is the next one, 1.2.
    const sib = siblingPage(panel)
    await expect(sib).toBeVisible()
    // 2 of 2 on a fresh fixture; more when an earlier spec of the run asked on 1 (a reset keeps old turns).
    await expect(sib.locator('.thread-half-where')).toHaveText(/^Next \u00b7 2 of \d+$/)
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
    await expectPages(panel, TWO_MID)

    // Swap: 1.2 is the right page, 1.1 comes up. The left page, scrolled by
    // the reader, stays where it is (only the two siblings trade places).
    await wheelUp(page, leftHalf(panel))
    await settle(page)
    const leftTop = await scrollTopOf(leftHalf(panel))
    await sib.getByRole('button', { name: 'Swap with the page below' }).click()
    await expectPages(panel, ['L 1', 'R 1.2'])
    await settle(page)
    expect(await scrollTopOf(leftHalf(panel))).toBe(leftTop)
    await expect(sib.locator('.thread-half-name')).toHaveText('1.1')
    await expect(sib.locator('.thread-half-title')).toHaveText(T.Q11)
    await expect(sib.locator('.thread-half-where')).toHaveText(/^Previous \u00b7 1 of \d+$/)
    // The knob on the divider swaps back.
    await sib.locator('.tree-sibling-knob').click()
    await expectPages(panel, TWO_MID)
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
    await page.waitForLoadState('load')
    await expect(siblingPage(panel)).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => Math.round((await siblingPage(panel).boundingBox())!.height)).toBeGreaterThan(sibBox.height + 80)

    // Closed: gone, the right page offers it back.
    await siblingPage(panel).getByRole('button', { name: 'Close the sibling page' }).click()
    await expect(siblingPage(panel)).toHaveCount(0)
    await expectPages(panel, TWO_MID)
    await rightHeader(panel).getByRole('button', { name: 'Show the sibling question' }).click()
    await expect(siblingPage(panel)).toBeVisible()
  })

  test('a notice beside the sheet never takes a page away', async ({ page }) => {
    // The sheet moves its left edge past the notice corner while a notice shows
    // (--corner-sheet-inset). 2026-11-09, main CI: another spec's notice held the
    // corner, the 1440px sheet's chat fell under the width tier of its pages, and a
    // page went away. The inset is set as the corner sets it.
    const panel = await openSheet(page)
    await openQuestion(panel, T.Q11)
    await expectPages(panel, TWO_MID)
    const width = () => panel.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    const wide = await width()
    await panel.evaluate((el) => el.style.setProperty('--corner-sheet-inset', '140px'))
    await expect.poll(width).toBeLessThan(wide - 100)
    // Two frames: the resize observer's read has rendered.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(await pagesOnScreen(panel)).toEqual(TWO_MID)
    await panel.evaluate((el) => el.style.removeProperty('--corner-sheet-inset'))
    await expect.poll(width).toBe(wide)
    await expectPages(panel, TWO_MID)
  })

  test('only the main conversation\'s composer has the "+" menu, the mode and the model', async ({ page }) => {
    const panel = await openSheet(page)
    // Main on screen as the left page, beside question 1.
    await openQuestion(panel, T.Q1)
    await expectPages(panel, TWO_TOP)
    const box = (scope: Locator) => scope.locator('.chat-input-box').last()
    const main = box(leftHalf(panel))
    await expect(main.locator('.chat-plus-btn')).toBeVisible()
    await expect(main.locator('.session-mode-bar')).toBeVisible()
    const own = panel.locator('.session-panel-input:not(.tree-split-input) .chat-input-box')
    const lights = [own]
    if (await siblingPage(panel).count()) lights.push(box(siblingPage(panel)))
    for (const light of lights) {
      await expect(light).toHaveAttribute('data-light', 'true')
      await expect(light.locator('.chat-plus-btn')).toHaveCount(0)
      await expect(light.locator('.session-mode-bar')).toHaveCount(0)
      await expect(light.locator('.mic-btn-wrapper')).toBeVisible()
      await expect(light.locator('.chat-send-group')).toBeVisible()
    }
    // One set of the session's controls on screen, Main's.
    await expect(panel.locator('.session-mode-bar')).toHaveCount(1)
    await shot(page, 'composers', panel)
    // Main off screen: the left page (1.1) has a light composer too, one row:
    // the text, the mic and send side by side, inside its third of the sheet.
    await openQuestion(panel, T.Q111)
    await expectPages(panel, TWO_DEEP)
    await expect(panel.locator('.session-mode-bar')).toHaveCount(0)
    for (const light of [box(leftHalf(panel)), own]) {
      await expect(light).toHaveAttribute('data-light', 'true')
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
    // Main alone on screen: the panel's own composer is the full one again.
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
