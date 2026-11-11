/**
 * Fullscreen shows a review sidebar (2026-10-27, the user: "when in full screen
 * it default become the word like have a side bar on right like review show the
 * comments there"): one card per asked passage of the visible conversation, each
 * level with its passage (pushed down, never overlapping), scrolling with the
 * text. A card is one compact row until opened (2026-10-29, the user: "没点之前，
 * 不需要扩展这么大"); a click on it, on its passage or the mark menu's Open opens
 * the question's full card over it, every round in full and scrollable, with its
 * own box, the timeline staying put; the card's top-right button makes it full
 * screen in place over the timeline, and the same button or Esc brings it back
 * ("它的这个 enlarge 应该就是像正常的一个 full screen 在右上角"). Outside fullscreen
 * nothing changes.
 *
 * Chromium and WebKit. The review fixture: one long reply with 22 asked passages.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { leaveFullscreen } from './draft-helpers'
import { centreInHistory, clickInPlace, openThreadsSession, settledScrollTop, passageRects, readRecord, resetThreadsFixture, test } from './threads-helpers'
import { REVIEW_COUNT, REVIEW_MIXED_PASSAGES, REVIEW_MIXED_READY, REVIEW_MIXED_SESSION, REVIEW_MIXED_TASK, REVIEW_OLD_PASSAGES, REVIEW_OLD_READY, REVIEW_OLD_SESSION, REVIEW_OLD_TASK, REVIEW_READY, REVIEW_ROUNDS, REVIEW_ROUND_CODE, REVIEW_SESSION, REVIEW_TASK, REVIEW_TITLES, reviewPassage } from './threads-review-fixture'

const SHOTS = () => `/tmp/ask-review/e2e/${test.info().project.name}`
async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS(), { recursive: true })
  await page.screenshot({ path: `${SHOTS()}/${name}.png` })
}

const sidebarCards = (panel: Locator) => panel.locator('[data-testid="thread-review"] .thread-review-card')

/** Every card's key, top and bottom, and each passage's top, in viewport px. */
async function layout(panel: Locator) {
  return panel.evaluate((root, passages) => {
    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="thread-review"] .thread-review-card'))
      .map((el) => { const r = el.getBoundingClientRect(); return { key: el.dataset.threadKey ?? '', top: r.top, bottom: r.bottom, title: el.querySelector('.thread-review-title')?.textContent ?? '' } })
    const tops: number[] = []
    const reply = root.querySelector('.session-history [data-message-id][data-msg-role="assistant"] .session-msg-content')
    for (const p of passages) {
      let top = Number.NaN
      const walker = document.createTreeWalker(reply ?? root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = (n as Text).data.indexOf(p)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(n, at)
        range.setEnd(n, at + p.length)
        top = range.getClientRects()[0]?.top ?? Number.NaN
        break
      }
      tops.push(top)
    }
    return { cards, passageTops: tops }
  }, Array.from({ length: REVIEW_COUNT }, (_, i) => reviewPassage(i)))
}

/** Fullscreen, with the long reply rendered: a question whose passage is not
 *  in the DOM (behind "Load earlier turns") has no line to sit beside. */
async function goFullscreen(panel: Locator): Promise<void> {
  // After a reload the panel may already be full screen: Walnut keeps it as it was left
  // (hooks/fullscreen-owner.ts).
  if (!/open-walnut-fullscreen/.test((await panel.getAttribute('class')) ?? '')) {
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  }
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  const history = panel.locator('.session-history')
  const first = reviewPassage(0).slice(0, 30)
  await expect.poll(async () => {
    if (await history.getByText(first).count()) return true
    const more = history.getByRole('button', { name: 'Load earlier turns', exact: true })
    // A DOM click: the timeline holds its bottom, so a scrolled click can miss.
    if (await more.count()) await more.first().evaluate((el) => (el as HTMLElement).click())
    else await history.evaluate((el) => { el.scrollTop = 0 })
    return false
  }, { timeout: 20_000, intervals: [300] }).toBe(true)
}

/** A real wheel, as a reader scrolls: the timeline holds its bottom against a
 *  programmatic scroll (WebKit snapped scrollIntoView straight back). Each step
 *  waits for the scroll to come to rest: WebKit animates a wheel scroll, so a
 *  fixed short wait read a frame of the glide, sent more steps than needed, and
 *  the queued ones landed after this returned (the "timeline moved" 690px of
 *  :266 on macOS WebKit, 2026-10-31). Returns with the timeline at rest. */
async function wheelIntoView(page: Page, scroller: Locator, target: Locator): Promise<void> {
  const box = (await scroller.boundingBox())!
  // The panel's glass header lies over the scroller's top padding: a target
  // there is under it, not in view (2026-10-31: card 18 stopped under the header
  // on macOS WebKit and a click there hit the header).
  const coveredTo = await scroller.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const header = el.closest('.session-panel')?.querySelector('.session-panel-header')
    const pad = r.top + (parseFloat(getComputedStyle(el).paddingTop) || 0)
    return Math.max(pad, header ? header.getBoundingClientRect().bottom : r.top)
  })
  const top = coveredTo + 8
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  for (let i = 0; i < 80; i++) {
    await settledScrollTop(scroller)
    const t = await target.boundingBox()
    if (t && t.y >= top && t.y + t.height <= box.y + box.height - 40) return
    await page.mouse.wheel(0, t && t.y < top ? -300 : 300)
    await page.waitForTimeout(80)
  }
  throw new Error('never scrolled the card into the timeline')
}

async function openFullscreen(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openThreadsSession(page, REVIEW_SESSION, REVIEW_TASK, REVIEW_READY, { view: 'linear' })
  return panel
}

test.describe('the fullscreen review sidebar', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, REVIEW_SESSION) })

  test('one card per passage, aligned in order, scrolling with the text; absent outside fullscreen', async ({ page }) => {
    const panel = await openFullscreen(page)
    // Not fullscreen: no sidebar, no gutter.
    await expect(sidebarCards(panel)).toHaveCount(0)
    await expect(panel.locator('.session-history[data-review-sidebar]')).toHaveCount(0)

    await goFullscreen(panel)
    await expect(panel.locator('.session-history[data-review-sidebar="open"]')).toHaveCount(1)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    await centreInHistory(page, panel, reviewPassage(3).slice(0, 30), { at: 0.2 })
    await page.waitForTimeout(300)

    const { cards, passageTops } = await layout(panel)
    // In passage order, by title.
    const byTop = [...cards].sort((a, b) => a.top - b.top).map((c) => c.title)
    expect(byTop).toEqual(REVIEW_TITLES)
    // A card shows its whole conversation (2026-10-31, the user: "show everything
    // normally ... a maximum height, but people can scroll"): the question as the
    // chat's bubble and the answer, under a one-line head, never the reply's `[Qn]`
    // tag; a long one scrolls inside its card. No composer in it.
    const rows = await sidebarCards(panel).evaluateAll((els) => els.map((el) => {
      const body = el.querySelector('.thread-review-body') as HTMLElement | null
      const title = el.querySelector('.thread-review-title') as HTMLElement
      return {
        text: el.textContent ?? '',
        // The newest question sits in the reply box (2026-11-10: no blue bubbles in a review card).
        questions: el.querySelectorAll('[data-testid="thread-reply-asked"]').length,
        bubbles: el.querySelectorAll('.session-msg-user').length,
        answers: el.querySelectorAll('.session-msg-assistant').length,
        bodyH: body?.getBoundingClientRect().height ?? 0,
        scrolls: !!body && body.scrollHeight > body.clientHeight + 1 && getComputedStyle(body).overflowY === 'auto',
        oneLine: title.scrollHeight <= title.clientHeight + 1,
        bodyText: body?.textContent ?? '',
      }
    }))
    const cap = Math.min(420, 900 * 0.55)
    for (const r of rows) {
      expect(r.questions, `the question shows: ${r.text.slice(0, 80)}`).toBe(1)
      expect(r.bubbles, 'no chat bubble in a review card').toBe(0)
      expect(r.oneLine).toBe(true)
      expect(r.bodyH, 'capped').toBeLessThanOrEqual(cap + 1)
      expect(r.bodyText).not.toMatch(/\[Q\s?\d+\]/)
    }
    expect(rows.filter((r) => r.answers > 0).length, 'answers show').toBeGreaterThan(REVIEW_COUNT / 2)
    // Each card has its one reply box (2026-11-08: a card with none had no way to reply).
    await expect(sidebarCards(panel).locator('textarea.thread-card-input')).toHaveCount(REVIEW_COUNT)
    // Level with its passage or below it (pushed down), never overlapping.
    const ordered = REVIEW_TITLES.map((t) => cards.find((c) => c.title === t)!)
    for (let i = 0; i < ordered.length; i++) {
      expect(ordered[i].top, `card ${i + 1} is not above its passage`).toBeGreaterThanOrEqual(passageTops[i] - 3)
      if (i > 0) expect(ordered[i].top, `card ${i + 1} clears card ${i}`).toBeGreaterThanOrEqual(ordered[i - 1].bottom + 6)
    }
    // The first sits right at its passage (nothing above pushes it).
    expect(Math.abs(ordered[0].top - passageTops[0])).toBeLessThan(4)
    // The cards stay right of the text.
    const textRight = await panel.evaluate((root) => {
      const body = root.querySelector('.session-history [data-message-id][data-msg-role="assistant"] .session-msg-content')!
      return body.getBoundingClientRect().right
    })
    const cardLeft = await sidebarCards(panel).first().evaluate((el) => el.getBoundingClientRect().left)
    expect(cardLeft).toBeGreaterThan(textRight)
    await shot(page, '1-sidebar-light')

    // Scrolling moves cards and passages together.
    const history = panel.locator('.session-history')
    const before = await layout(panel)
    await history.evaluate((el) => { el.scrollTop += 240 })
    await page.waitForTimeout(200)
    const after = await layout(panel)
    const k = REVIEW_TITLES.indexOf(ordered[5].title)
    const cardMoved = before.cards.find((c) => c.key === ordered[5].key)!.top - after.cards.find((c) => c.key === ordered[5].key)!.top
    const passageMoved = before.passageTops[k] - after.passageTops[k]
    expect(Math.abs(cardMoved - passageMoved)).toBeLessThan(2)

    // Dark: the cards read on the dark background.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(150)
    await shot(page, '2-sidebar-dark')
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))

    // Leaving fullscreen: the sidebar goes and the text gets its width back.
    await page.keyboard.press('Escape')
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(sidebarCards(panel)).toHaveCount(0)
    await expect(panel.locator('.session-history[data-review-sidebar]')).toHaveCount(0)
  })

  test('a card shows its whole thread with its own scroll; the vertical bar folds the column and brings it back, across a reload', async ({ page }) => {
    const panel = await openFullscreen(page)
    await page.evaluate(() => localStorage.removeItem('walnut:review-sidebar.v1'))
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')

    // The question of three rounds, in its review card: every round and the code
    // in full, past the cap it scrolls inside, and its ends never move the timeline.
    const first = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[0] })
    await history.evaluate((el) => { el.scrollTop = 0 })
    await wheelIntoView(page, history, first.locator('button.thread-review-head'))
    const body = first.locator('.thread-review-body')
    // Earlier rounds as muted lines in the body, the newest in the reply box.
    await expect(body.locator('.thread-card-q-line')).toHaveCount(REVIEW_ROUNDS.length - 1)
    for (const q of REVIEW_ROUNDS.slice(0, -1)) await expect(body).toContainText(q)
    await expect(first.getByTestId('thread-reply-asked')).toContainText(REVIEW_ROUNDS[REVIEW_ROUNDS.length - 1])
    await expect(body.locator('pre')).toContainText(REVIEW_ROUND_CODE)
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 20), 'three rounds overflow the cap').toBe(true)
    // The wheel goes over the part of the card the history box shows.
    const bb = (await body.boundingBox())!
    const hb = (await history.boundingBox())!
    const y0 = Math.max(bb.y, hb.y), y1 = Math.min(bb.y + bb.height, hb.y + hb.height)
    expect(y1 - y0, 'part of the card is on screen').toBeGreaterThan(40)
    const atWheel = await history.evaluate((el) => el.scrollTop)
    await page.mouse.move(bb.x + bb.width / 2, (y0 + y1) / 2)
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(80) }
    await page.waitForTimeout(250)
    expect(await body.evaluate((el) => el.scrollTop), 'the card scrolled').toBeGreaterThan(20)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atWheel), 'the timeline did not move').toBeLessThan(2)
    await shot(page, '1b-full-thread-in-card')

    // The cards end where the conversation ends: scrolled to the bottom, the
    // last row is at the bottom, not blank space under it (tall cards beside the
    // last passages shrink and scroll inside instead).
    const tail = await history.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      const rows = Array.from(el.children).filter((c) => (c as HTMLElement).offsetHeight > 0 && ['static', 'relative'].includes(getComputedStyle(c).position))
      const last = rows[rows.length - 1]!.getBoundingClientRect().bottom
      const box = el.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(el).paddingBottom) || 0)
      const cards = Array.from(el.querySelectorAll('.thread-review-card')).map((c) => c.getBoundingClientRect().bottom)
      return { gap: box - last, cardsEnd: Math.max(...cards) - last }
    })
    expect(Math.abs(tail.gap), 'no blank space under the last row').toBeLessThan(4)
    expect(tail.cardsEnd, 'no card runs past the conversation').toBeLessThan(2)

    // The bar: between the text and the cards, below the glass header.
    const bar = panel.getByTestId('thread-review-bar')
    await expect(bar).toHaveAttribute('aria-label', 'Hide questions')
    const header = (await panel.locator('.session-panel-header').boundingBox())!
    const barBox = (await bar.boundingBox())!
    expect(barBox.y, 'the bar starts below the header').toBeGreaterThanOrEqual(header.y + header.height - 1)
    const textRightOpen = await panel.evaluate((root) => root.querySelector('.session-history [data-message-id][data-msg-role="assistant"] .session-msg-content')!.getBoundingClientRect().right)
    expect(barBox.x).toBeGreaterThanOrEqual(textRightOpen - 1)
    expect(barBox.x + barBox.width).toBeLessThanOrEqual((await sidebarCards(panel).first().boundingBox())!.x + 1)
    // Stays put while the text scrolls.
    await history.evaluate((el) => { el.scrollTop += 300 })
    await page.waitForTimeout(150)
    expect(Math.abs((await bar.boundingBox())!.y - barBox.y), 'sticky').toBeLessThan(2)

    // Fold: the cards go, the text takes the room back, a narrow strip with the count stays.
    await bar.click()
    await expect(panel.locator('.session-history[data-review-sidebar="collapsed"]')).toHaveCount(1)
    await expect(sidebarCards(panel)).toHaveCount(0)
    await expect(bar).toHaveAttribute('aria-label', `Show questions (${REVIEW_COUNT})`)
    // (The sheet grows outward with the column open and comes back when it folds,
    // so the text's own width barely moves: the sheet test below pins that.)
    const strip = (await bar.boundingBox())!
    const historyBox = (await history.boundingBox())!
    expect(strip.x + strip.width, 'the strip sits at the right edge').toBeGreaterThan(historyBox.x + historyBox.width - 80)
    expect(strip.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
    await shot(page, '1c-folded')

    // The choice is kept: a reload comes back folded.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = await openThreadsSession(page, REVIEW_SESSION, REVIEW_TASK, REVIEW_READY, { view: 'linear' })
    await goFullscreen(again)
    await expect(again.locator('.session-history[data-review-sidebar="collapsed"]')).toHaveCount(1, { timeout: 15_000 })
    await expect(sidebarCards(again)).toHaveCount(0)
    // Reopen from the strip: the cards are back beside their passages.
    await again.getByTestId('thread-review-bar').click()
    await expect(again.locator('.session-history[data-review-sidebar="open"]')).toHaveCount(1)
    await expect(sidebarCards(again)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    expect(await page.evaluate(() => localStorage.getItem('walnut:review-sidebar.v1'))).toBe('open')
  })

  test('the sheet grows outward while the column is open and comes back when it folds; the chat keeps its width; a narrow window keeps its gutter', async ({ page }) => {
    // 2026-11-03, the user: "normally each side is ten percent; with this review it
    // can grow outward from there". The sheet's side margins: a tenth of the page
    // area (fullscreen-tab.css), less half the column (320px) while it is open,
    // never under the 12px gutter.
    const panel = await openFullscreen(page)
    await page.setViewportSize({ width: 2200, height: 1000 })
    await page.evaluate(() => localStorage.removeItem('walnut:review-sidebar.v1'))
    await goFullscreen(panel)
    await expect(panel.locator('.session-history[data-review-sidebar="open"]')).toHaveCount(1, { timeout: 15_000 })
    const geometry = () => panel.evaluate((root) => {
      const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fullscreen-left')) || 0
      const r = root.getBoundingClientRect()
      const text = root.querySelector('.session-history [data-message-id][data-msg-role="assistant"] .session-msg-content')!.getBoundingClientRect()
      return { area: innerWidth - left, marginLeft: r.left - left, marginRight: innerWidth - r.right, width: r.width, text: text.width }
    })
    const base = (area: number) => Math.max(12, Math.min(area * 0.1, (area - 960) / 2))
    const open = await geometry()
    expect(Math.abs(open.marginLeft - Math.max(12, base(open.area) - 160)), 'open: the left margin gave half the column').toBeLessThan(2)
    expect(Math.abs(open.marginRight - open.marginLeft), 'centred').toBeLessThan(2)
    await shot(page, '6a-sheet-grown')
    // Folded: back to a tenth on each side.
    await panel.getByTestId('thread-review-bar').click()
    await expect(panel.locator('.session-history[data-review-sidebar="collapsed"]')).toHaveCount(1)
    const folded = await geometry()
    expect(Math.abs(folded.marginLeft - base(folded.area)), 'folded: a tenth of the area').toBeLessThan(2)
    expect(open.width - folded.width, 'the sheet grew by the whole column').toBeGreaterThan(318)
    expect(Math.abs(open.text - folded.text), 'the chat kept its width').toBeLessThan(40)
    await shot(page, '6b-sheet-folded')
    // Open again: out again.
    await panel.getByTestId('thread-review-bar').click()
    await expect(panel.locator('.session-history[data-review-sidebar="open"]')).toHaveCount(1)
    expect(Math.abs((await geometry()).width - open.width)).toBeLessThan(2)
    // A window with less room: the margins give what they have, down to the gutter.
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(async () => Math.round((await geometry()).marginLeft)).toBe(Math.round(Math.max(12, base((await geometry()).area) - 160)))
    await shot(page, '6c-sheet-1440')
    // A narrow window: the plain gutter on each side, whatever the column does.
    await page.setViewportSize({ width: 1000, height: 800 })
    await expect.poll(async () => Math.round((await geometry()).marginLeft)).toBe(12)
    expect(Math.round((await geometry()).marginRight)).toBe(12)
    await shot(page, '6d-sheet-narrow')
    await page.evaluate(() => localStorage.removeItem('walnut:review-sidebar.v1'))
  })

  test('the bar between the text and the cards drags to resize; a click folds, a double click resets, a reload keeps it (2026-11-10)', async ({ page }) => {
    // The user, on a screenshot of this line: "can be drag".
    const panel = await openFullscreen(page)
    await page.evaluate(() => localStorage.removeItem('walnut:review-sidebar.v1'))
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const bar = panel.getByTestId('thread-review-bar')
    const cardW = async () => Math.round((await sidebarCards(panel).first().boundingBox())!.width)
    await expect.poll(cardW).toBe(300)
    // The reader's mouse: press on the line, move left 120px, release.
    const b = (await bar.boundingBox())!
    const x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 200)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 30, y, { steps: 4 })
    await page.mouse.move(x - 60, y, { steps: 4 })
    // The line follows the pointer while it drags.
    // (within a few frames: the sheet grows outward with the column, so the bar's
    // place for a width is measured as it goes)
    await expect.poll(async () => { const m = (await bar.boundingBox())!; return Math.abs(m.x + m.width / 2 - (x - 60)) },
      { timeout: 1_500, message: 'the bar stays under the pointer' }).toBeLessThan(12)
    await page.mouse.up()
    await expect.poll(cardW).toBeGreaterThan(340)
    const dragged = await cardW()
    // Dragged far: the column stops where the text keeps its least room (520px).
    const far = (await bar.boundingBox())!
    await page.mouse.move(far.x + far.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(far.x - 600, y, { steps: 8 })
    await page.mouse.up()
    const textW = await panel.locator('.session-history').evaluate((el) => {
      const cs = getComputedStyle(el)
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    })
    expect(textW, 'the text keeps its room').toBeGreaterThanOrEqual(500)
    const widest = await cardW()
    expect(widest).toBeGreaterThanOrEqual(dragged)
    await bar.dblclick()
    await expect.poll(cardW).toBe(300)
    // Back to the first drag's width for the reload check, in one quick flick
    // released at once: the release takes the bar the rest of the way to the
    // pointer (it kept 23 of 60px when the last frame was dropped).
    const again = (await bar.boundingBox())!
    await page.mouse.move(again.x + again.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(again.x + again.width / 2 - 60, y, { steps: 8 })
    await page.mouse.up()
    await expect.poll(cardW).toBeGreaterThan(340)
    const kept = await cardW()
    // A drag is not a click: the column stays open.
    await expect(bar).toHaveAttribute('aria-expanded', 'true')
    await shot(page, 'resize-dragged')
    // The width is kept across a reload (full screen left first: a reload brings
    // back no sheet the test did not open itself).
    await leaveFullscreen(page)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await goFullscreen(panel)
    await expect(sidebarCards(panel).first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(cardW).toBe(kept)
    // A double click puts it back to 300px, and the column stays open.
    await bar.dblclick()
    await expect.poll(cardW).toBe(300)
    await expect(bar).toHaveAttribute('aria-expanded', 'true')
    // A plain click still folds and brings it back.
    await bar.click()
    await expect(bar).toHaveAttribute('aria-expanded', 'false')
    await bar.click()
    await expect(bar).toHaveAttribute('aria-expanded', 'true')
    // Never narrower than 240px, however far it is dragged.
    const c = (await bar.boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + 100)
    await page.mouse.down()
    await page.mouse.move(c.x + 400, c.y + 100, { steps: 8 })
    await page.mouse.up()
    await expect.poll(cardW).toBe(240)
    await bar.dblclick()
    await expect.poll(cardW).toBe(300)
    // The width rides the synced view prefs (written 800ms after the last
    // change): let the reset reach them, or the next test opens at a dragged width.
    await page.waitForTimeout(1500)
  })

  test('a card holds no bubble of the reader\'s own: the newest ask sits inside its reply box (2026-11-10)', async ({ page }) => {
    // The user, of the blue bubbles on the cards: "too much, put it inside the input bar".
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    for (const c of (await sidebarCards(panel).all()).slice(0, 4)) {
      await expect(c.locator('.session-msg-user, .chat-bubble-user')).toHaveCount(0)
      const asked = c.getByTestId('thread-reply-asked')
      if (await asked.count() === 0) continue
      // Inside the box's frame, above the text field.
      const frame = (await c.locator('.thread-card-composer').boundingBox())!
      const line = (await asked.boundingBox())!
      const field = (await c.locator('textarea.thread-card-input').boundingBox())!
      expect(line.y).toBeGreaterThanOrEqual(frame.y - 1)
      expect(line.y + line.height).toBeLessThanOrEqual(field.y + 2)
      expect(line.x).toBeGreaterThanOrEqual(frame.x - 1)
      expect(line.x + line.width).toBeLessThanOrEqual(frame.x + frame.width + 1)
      expect(line.height, 'one or two lines').toBeLessThan(40)
    }
    await shot(page, 'asked-in-box')
  })

  test('a click on a card, its passage or Enter opens the full question over the card; Quote in chat', async ({ page }) => {
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    const card = panel.locator('.thread-card')
    await history.evaluate((el) => { el.scrollTop = 0 })
    await page.waitForTimeout(200)

    // Card 18, far below: a click opens its question over it, the timeline put.
    const target = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[17] })
    await wheelIntoView(page, history, target)
    const at = await settledScrollTop(history)
    const rc = (await target.boundingBox())!
    await clickInPlace(page, target.locator('button.thread-review-head'))
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[17])
    await expect(target).toHaveAttribute('data-selected', 'true')
    await expect(target).toHaveAttribute('data-enlarged', 'true')
    await page.waitForTimeout(300)
    const cb = (await card.boundingBox())!
    expect(Math.abs(cb.x + cb.width - (rc.x + rc.width)), 'same right edge').toBeLessThan(3)
    expect(cb.width, 'wider than the row, a comment\'s width').toBeGreaterThan(rc.width + 120)
    expect(cb.width).toBeLessThan(rc.width + 260)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - at), 'the timeline stays put').toBeLessThan(2)
    await shot(page, '3-card-click-opens')
    await card.locator('.thread-card-close').click()
    await expect(card).toHaveCount(0)
    await expect(target).not.toHaveAttribute('data-enlarged', 'true')
    await expect(target).toHaveAttribute('data-selected', 'true')

    // A click on passage 4 opens its question, over its review card.
    await centreInHistory(page, panel, reviewPassage(3).slice(0, 30))
    const r = (await passageRects(panel, reviewPassage(3).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
    await page.mouse.click(r.left + 20, r.top + r.height / 2)
    const fourth = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[3] })
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[3])
    await expect(fourth).toHaveAttribute('data-selected', 'true')
    await expect(target).not.toHaveAttribute('data-selected', 'true')
    await expect(fourth).toHaveAttribute('data-enlarged', 'true')
    await shot(page, '4-mark-click-opens')
    await card.locator('.thread-card-input').press('Escape')
    await expect(card).toHaveCount(0)

    // Closed, the keyboard is back on its row; Enter on a row opens it.
    await expect(fourth.locator('button.thread-review-head')).toBeFocused()
    await expect(fourth.locator('button.thread-review-head')).toHaveAttribute('aria-expanded', 'false')
    const third = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[2] })
    await third.locator('button.thread-review-head').focus()
    await page.keyboard.press('Enter')
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[2])
    await expect(third.locator('button.thread-review-head')).toHaveAttribute('aria-expanded', 'true')
    // Quote in chat from the open card: the composer names the question.
    await card.getByRole('button', { name: 'Quote in chat' }).click()
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toContainText(REVIEW_TITLES[2])
    await shot(page, '5-quoted-from-card')
  })

  test('the open card reads the whole question, asks a follow-up, and goes full screen in place', async ({ page, request }) => {
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    const mainBox = panel.locator('.session-panel-input .chat-input-textarea')
    const card = panel.locator('.thread-card')
    const box = card.locator('.thread-card-input')
    const seeded = new Set(((await readRecord(request, REVIEW_SESSION)).threadAnchors ?? []).map((x) => x.msgId))

    // Open card 5: its box, under the whole conversation.
    const fifth = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[4] })
    await wheelIntoView(page, history, fifth)
    const topBefore = await settledScrollTop(history)
    await clickInPlace(page, fifth.locator('button.thread-review-head'))
    await expect(box).toBeVisible()
    await expect(box).toHaveAttribute('placeholder', /Point 5 order/)
    // Every state the review card takes from here on (a poll would miss a short red).
    await fifth.evaluate((el) => {
      const rec = el as HTMLElement & { _states?: string[] }
      rec._states = []
      new MutationObserver(() => { rec._states!.push(el.getAttribute('data-state') ?? '') }).observe(el, { attributes: true, attributeFilter: ['data-state'] })
    })
    // Sent from the card: into question 5, the main composer untouched, the timeline in place.
    await box.fill('slow:9000 MOCK_SPEAK_AT:1500 What breaks if it is skipped?')
    await box.press('Enter')
    await expect(box).toHaveValue('')
    await expect(card.locator('.thread-card-q')).toHaveCount(2)
    await expect(card.locator('.thread-card-q').nth(1)).toContainText('What breaks if it is skipped?')
    await expect(card.locator('.thread-card-body')).toContainText('processed your message: What breaks if it is skipped?', { timeout: 30_000 })
    // Open while its answer lands: read (green), never the red "New answer".
    await expect.poll(() => fifth.getAttribute('data-state'), { timeout: 30_000 }).toBe('read')
    expect(await fifth.evaluate((el) => (el as HTMLElement & { _states?: string[] })._states ?? []), 'never red while it is being read').not.toContain('unread')
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toHaveCount(0)
    await expect(mainBox).toHaveValue('')
    const after = await history.evaluate((el) => ({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight }))
    expect(after.bottom - after.top, 'the timeline did not jump to the bottom').toBeGreaterThan(200)
    expect(Math.abs(after.top - topBefore), 'the timeline stayed where the reader was').toBeLessThan(40)
    await expect.poll(async () => {
      // A new anchor on passage 5 (by id: the other engine's run shares the fixture session).
      const anchors = ((await readRecord(request, REVIEW_SESSION)).threadAnchors ?? []) as Array<{ msgId: string; quote?: { exact?: string } }>
      return anchors.some((x) => !seeded.has(x.msgId) && x.quote?.exact === reviewPassage(4))
    }, { timeout: 10_000 }).toBe(true)
    await shot(page, '6-follow-up-from-card')

    // Nothing of the timeline floats over the open card (2026-10-27 on prod:
    // the jump-to-bottom arrow sat on it).
    const coveredBy = () => card.evaluate((el) => {
      const c = el.getBoundingClientRect()
      for (const o of document.querySelectorAll('.scroll-to-bottom-btn, .session-toc, .thread-map')) {
        const r = o.getBoundingClientRect()
        const x0 = Math.max(c.left, r.left), x1 = Math.min(c.right, r.right), y0 = Math.max(c.top, r.top), y1 = Math.min(c.bottom, r.bottom)
        if (x1 - x0 < 2 || y1 - y0 < 2) continue
        const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2)
        if (!hit || !el.contains(hit)) return o.className
      }
      return null
    })
    expect(await coveredBy(), 'the card is on top').toBeNull()

    // Full screen in place: the top-right button; the card fills the timeline's
    // visible box below the header, the timeline stays put, the words stay.
    await box.fill('half a thought')
    const atFull = await history.evaluate((el) => el.scrollTop)
    const small = (await card.boundingBox())!
    await card.getByRole('button', { name: 'Question full screen' }).click()
    await expect(card).toHaveAttribute('data-full', 'true')
    const want = await history.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(el).paddingTop) || 0
      return { top: r.top + pad + 12, left: r.left + 12, right: r.right - 12, bottom: r.bottom - 12 }
    })
    const big = (await card.boundingBox())!
    expect(Math.abs(big.y - want.top)).toBeLessThan(3)
    expect(Math.abs(big.x - want.left)).toBeLessThan(3)
    expect(Math.abs(big.x + big.width - want.right)).toBeLessThan(3)
    expect(Math.abs(big.y + big.height - want.bottom)).toBeLessThan(3)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atFull), 'the timeline stays put').toBeLessThan(2)
    await expect(box).toHaveValue('half a thought')
    await expect(card.getByRole('button', { name: 'Exit question full screen' })).toBeVisible()
    expect(await coveredBy(), 'nothing floats over the full-screen card').toBeNull()
    // A click on its text keeps the keyboard in the card: Esc still answers it.
    await card.locator('.thread-card-body .session-msg-assistant').first().click()
    await expect(card).toBeFocused()
    await shot(page, '7-full-screen')
    // The same button brings it back where it was.
    await card.getByRole('button', { name: 'Exit question full screen' }).click()
    await expect(card).not.toHaveAttribute('data-full', 'true')
    const back = (await card.boundingBox())!
    expect(Math.abs(back.x - small.x)).toBeLessThan(3)
    expect(Math.abs(back.width - small.width)).toBeLessThan(3)
    // Esc leaves full screen first, then closes the card; never the fullscreen panel.
    await card.getByRole('button', { name: 'Question full screen' }).click()
    await expect(card).toHaveAttribute('data-full', 'true')
    await box.press('Escape')
    await expect(card).not.toHaveAttribute('data-full', 'true')
    await expect(card).toBeVisible()
    await box.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await expect(fifth).not.toHaveAttribute('data-enlarged', 'true')
    // The unsent words wait in the question for the next open.
    await fifth.locator('button.thread-review-head').click()
    await expect(box).toHaveValue('half a thought')
    await box.fill('')

    // Every scroll into view a card asks for: its scroll margin moves the box
    // even when the card is on screen (2026-10-29: 40px on prod).
    await page.evaluate(() => {
      const w = window as unknown as { __cardScrolls: string[] }
      w.__cardScrolls = []
      const siv = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element['scrollIntoView']>) {
        if (this.classList.contains('thread-card')) w.__cardScrolls.push(this.className)
        return siv.apply(this, args)
      }
    })
    const cardScrolls = () => page.evaluate(() => (window as unknown as { __cardScrolls: string[] }).__cardScrolls.splice(0))
    const openByMenu = async (i: number) => {
      await centreInHistory(page, panel, reviewPassage(i).slice(0, 30), { at: 0.3 })
      const r = (await passageRects(panel, reviewPassage(i).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
      await page.mouse.click(r.left + 20, r.top + r.height / 2, { button: 'right' })
      await cardScrolls()
      const at = await history.evaluate((el) => el.scrollTop)
      await page.getByTestId('thread-mark-menu').getByText('Open question').click()
      await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[i])
      return at
    }
    // A question whose answer holds a table opens grown, over its row, and
    // nothing scrolls the timeline (it is on screen by placement).
    const atTable = await openByMenu(6)
    await expect(card, 'its table grew it').toHaveClass(/is-expanded/)
    await page.waitForTimeout(700)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atTable), 'the timeline stays put').toBeLessThan(2)
    expect(await cardScrolls(), 'no scroll into view over its row').toEqual([])
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    // The question of three rounds, opened from its mark's right-click menu:
    // every round, the code block in full.
    const atOpen = await openByMenu(0)
    await page.waitForTimeout(400)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atOpen), 'the timeline stays put').toBeLessThan(2)
    expect(await cardScrolls(), 'no scroll into view over its row').toEqual([])
    await expect(card.locator('.thread-card-q')).toHaveCount(REVIEW_ROUNDS.length)
    await expect(card.locator('.thread-card-body pre')).toContainText(REVIEW_ROUND_CODE)
    const first = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[0] })
    await expect(first).toHaveAttribute('data-enlarged', 'true')
    await shot(page, '8-three-rounds-open')
    // Its body scrolls inside the card, and its ends never scroll the timeline under it.
    const body = card.locator('.thread-card-body')
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 40), 'three rounds overflow the card').toBe(true)
    // A thread longer than the card reads as a page: most of the visible box tall.
    const seen = await history.evaluate((el) => el.clientHeight - (parseFloat(getComputedStyle(el).paddingTop) || 0))
    expect((await card.boundingBox())!.height, 'the open card is most of the box tall').toBeGreaterThan(seen * 0.65)
    const bb = (await body.boundingBox())!
    const atWheel = await history.evaluate((el) => el.scrollTop)
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
    for (const dy of [-600, -600, -600, 600, 600, 600, 600, 600]) { await page.mouse.wheel(0, dy); await page.waitForTimeout(80) }
    await page.waitForTimeout(250)
    expect(await body.evaluate((el) => el.scrollTop), 'the body scrolled to its end').toBeGreaterThan(20)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atWheel), 'the card\'s scroll does not move the timeline').toBeLessThan(2)
    await card.getByRole('button', { name: 'Question full screen' }).click()
    await expect(card).toHaveAttribute('data-full', 'true')
    await shot(page, '9-three-rounds-full-screen')
    // Leaving the panel's fullscreen with the card full: the sidebar goes and
    // the card is a normal card again (no fixed box left over the page).
    await panel.getByRole('button', { name: 'Collapse session' }).click()
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(sidebarCards(panel)).toHaveCount(0)
    await expect(card).toHaveCount(1)
    await expect(card).not.toHaveAttribute('data-full', 'true')
    expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe('absolute')
    await expect(card.getByRole('button', { name: 'Question full screen' })).toHaveCount(0)
  })

  test('every card has its reply box: a follow-up typed and sent in it goes into that question, the timeline in place', async ({ page, request }) => {
    // 2026-11-08, the user: the side comments are Ask here and "should have an
    // input box"; the review card showed the answer with no way to reply.
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    const mainBox = panel.locator('.session-panel-input .chat-input-textarea')
    // Every card, crowded or not, has its box with the mic and Send.
    for (const c of await sidebarCards(panel).all()) {
      await expect(c.locator('textarea.thread-card-input')).toHaveCount(1)
      await expect(c.locator('.thread-card-mic, .mic-btn').first()).toHaveCount(1)
      await expect(c.locator('button.thread-card-send')).toHaveCount(1)
    }
    const seeded = new Set(((await readRecord(request, REVIEW_SESSION)).threadAnchors ?? []).map((x) => x.msgId))
    const third = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[2] })
    await wheelIntoView(page, history, third)
    const box = third.locator('textarea.thread-card-input')
    await expect(box).toBeInViewport()
    await expect(box).toHaveAttribute('placeholder', /Point 3 order/)
    const topBefore = await settledScrollTop(history)
    // A reader's own pointer and keys.
    await clickInPlace(page, box)
    await expect(box).toBeFocused()
    await page.keyboard.type('What if the flush is retried?')
    await page.keyboard.press('Enter')
    await expect(box).toHaveValue('')
    // Into question 3: its card's conversation reads the new question and its answer.
    await expect(third.locator('.thread-review-body')).toContainText('What if the flush is retried?', { timeout: 15_000 })
    await expect(third.locator('.thread-review-body')).toContainText('processed your message: What if the flush is retried?', { timeout: 30_000 })
    await expect.poll(async () => {
      const anchors = ((await readRecord(request, REVIEW_SESSION)).threadAnchors ?? []) as Array<{ msgId: string; quote?: { exact?: string } }>
      return anchors.some((x) => !seeded.has(x.msgId) && x.quote?.exact === reviewPassage(2))
    }, { timeout: 10_000 }).toBe(true)
    // The main composer untouched, no question card opened over it, the timeline put.
    await expect(mainBox).toHaveValue('')
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toHaveCount(0)
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - topBefore), 'the timeline stayed where the reader was').toBeLessThan(40)
    await shot(page, '8-reply-from-review-card')
    // Two more in a row from the keyboard: each answer comes into view inside the
    // card, whose conversation now scrolls on its own (2026-11-10 review: the
    // third answer arrived below the card's fold).
    const body3 = third.locator('.thread-review-body')
    for (const q of ['And if it is retried twice?', 'And a third time?']) {
      await expect(box, 'the keyboard is back in the box').toBeFocused()
      await page.keyboard.type(q)
      await page.keyboard.press('Enter')
      await expect(body3).toContainText(`processed your message: ${q}`, { timeout: 30_000 })
      await expect.poll(() => body3.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 3_000 }).toBeLessThan(2)
    }
    expect(await body3.evaluate((el) => el.scrollHeight - el.clientHeight), 'the conversation scrolls in its card').toBeGreaterThan(40)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - topBefore), 'the timeline stayed where the reader was').toBeLessThan(40)
    // Words typed and left stay the question's: the open card holds them too.
    await clickInPlace(page, box)
    await page.keyboard.type('half a follow-up')
    // Esc leaves the box, never the full screen.
    await page.keyboard.press('Escape')
    await expect(box).not.toBeFocused()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    // The card grew with the new round: its head may sit under the glass header now.
    await wheelIntoView(page, history, third.locator('button.thread-review-head'))
    await clickInPlace(page, third.locator('button.thread-review-head'))
    const cardBox = panel.locator('.thread-card .thread-card-input')
    await expect(cardBox).toHaveValue('half a follow-up')
    // And back: words added in the open card are the review box's once it closes.
    await expect(cardBox).toBeFocused()
    await page.keyboard.type(' and more')
    await page.keyboard.press('Escape')
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    await expect(box).toHaveValue('half a follow-up and more')

    // At the bottom of the timeline (where a live session sits): a send from the
    // last card's box keeps the timeline still (2026-11-08, macOS WebKit: the
    // question's row added at the end pulled it 42px), and the keyboard stays in
    // the box for the next follow-up.
    const last = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[REVIEW_COUNT - 1] })
    const lastBox = last.locator('textarea.thread-card-input')
    const hb = (await history.boundingBox())!
    await page.mouse.move(hb.x + hb.width * 0.3, hb.y + hb.height / 2)
    await expect.poll(async () => {
      await page.mouse.wheel(0, 2000)
      await page.waitForTimeout(120)
      return history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    }, { timeout: 15_000 }).toBeLessThan(2)
    await expect(lastBox).toBeInViewport()
    const atBottom = await settledScrollTop(history)
    await clickInPlace(page, lastBox)
    await page.keyboard.type('And at the end?')
    await page.keyboard.press('Enter')
    await expect(lastBox).toHaveValue('')
    await expect(last.locator('.thread-review-body')).toContainText('processed your message: And at the end?', { timeout: 30_000 })
    await page.waitForTimeout(400)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - atBottom), 'the timeline stayed put at the bottom').toBeLessThan(2)
    await expect(lastBox, 'the keyboard is back in the box').toBeFocused()
  })

  test('a card whose box holds the keyboard keeps the box on screen as its answers come in; the timeline stays', async ({ page }) => {
    // 2026-11-10 review (macOS WebKit): a card's box near the view's foot; the
    // first follow-up's answer grew the card past the foot, and the next key
    // typed made the browser scroll the timeline 633px to the caret.
    await page.setViewportSize({ width: 1440, height: 640 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, REVIEW_MIXED_SESSION, REVIEW_MIXED_TASK, REVIEW_MIXED_READY, { view: 'linear' })
    const history = panel.locator('.session-history')
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(sidebarCards(panel)).toHaveCount(3, { timeout: 20_000 })
    // An early question: the conversation below it leaves its card room to grow.
    const card = sidebarCards(panel).filter({ hasText: 'Mixed point 1' })
    const box = card.locator('textarea.thread-card-input')
    const body = card.locator('.thread-review-body')
    await wheelIntoView(page, history, box)
    const hb = (await history.boundingBox())!
    // The reader wheels the passage down until the box sits in the lower part of the view.
    await page.mouse.move(hb.x + hb.width * 0.3, hb.y + hb.height / 2)
    await expect.poll(async () => {
      const y = (await box.boundingBox())!.y
      if (y < hb.y + hb.height * 0.6) { await page.mouse.wheel(0, -40); await page.waitForTimeout(80) }
      return (await box.boundingBox())!.y
    }, { timeout: 15_000 }).toBeGreaterThan(hb.y + hb.height * 0.6)
    await page.waitForTimeout(300)
    await clickInPlace(page, box)
    for (const q of ['First follow-up, long enough to grow the card by a few lines of its answer?', 'Second follow-up, long enough to grow the card by a few lines of its answer?', 'And a third?']) {
      await page.evaluate(() => {
        const h = document.querySelector('.session-history') as HTMLElement
        const w = window as unknown as { __st: { on: boolean; v: number[] } }
        w.__st = { on: true, v: [] }
        const tick = () => { if (!w.__st.on) return; w.__st.v.push(h.scrollTop); requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
      })
      await expect(box, 'the keyboard is in the box').toBeFocused()
      await page.keyboard.type(q)
      await page.keyboard.press('Enter')
      await expect(body).toContainText(`processed your message: ${q}`, { timeout: 30_000 })
      await page.waitForTimeout(600)
      const v = await page.evaluate(() => { const w = window as unknown as { __st: { on: boolean; v: number[] } }; w.__st.on = false; return w.__st.v })
      expect(Math.max(...v) - Math.min(...v), `the timeline stayed while "${q}" was typed, sent and answered`).toBeLessThan(3)
      const b = (await box.boundingBox())!
      expect(b.y + b.height, 'the box stays above the view\'s foot').toBeLessThanOrEqual(hb.y + hb.height)
      await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 3_000 }).toBeLessThan(2)
    }
    expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight), 'its conversation scrolls inside the card').toBeGreaterThan(40)
  })

  test('crowded cards: the one typed in at the view\'s foot keeps a readable piece of its conversation and its box on screen; one-line placeholder', async ({ page }) => {
    // 2026-11-11 review (macOS WebKit, 6 cards): a card whose box sat at the
    // view's foot squeezed its conversation to one clipped line (37px) to keep
    // the box on screen, and the box still sat partly past the foot: the
    // timeline moved 6px on the first send.
    await page.setViewportSize({ width: 1440, height: 640 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, REVIEW_SESSION, REVIEW_TASK, REVIEW_READY, { view: 'linear' })
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    const card = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[9] })
    const box = card.locator('textarea.thread-card-input')
    const body = card.locator('.thread-review-body')
    // A long question name: its placeholder stays one line in the 300px card
    // (the review saw a long one take two lines).
    const tall = await box.evaluate((el) => {
      const t = el as HTMLTextAreaElement
      const was = t.placeholder
      t.placeholder = 'Reply in \u201cthe slow flush worker and the index wr\u2026\u201d\u2026'
      const h = t.scrollHeight
      t.placeholder = was
      return h
    })
    expect.soft(tall, 'a long placeholder takes one line').toBeLessThanOrEqual(30)
    await wheelIntoView(page, history, box)
    const hb = (await history.boundingBox())!
    // Wheel until the box's middle is just above the view's foot (its buttons past it).
    const goal = hb.y + hb.height - 6
    await page.mouse.move(hb.x + hb.width * 0.3, hb.y + hb.height / 2)
    await expect.poll(async () => {
      const b = (await box.boundingBox())!
      const d = goal - (b.y + b.height / 2)
      if (d > 2 || d < -4) { await page.mouse.wheel(0, d > 0 ? -Math.min(40, Math.max(4, d)) : Math.min(40, Math.max(4, -d))); await page.waitForTimeout(80) }
      const n = (await box.boundingBox())!
      const e = goal - (n.y + n.height / 2)
      return e <= 2 && e >= -4
    }, { timeout: 20_000 }).toBe(true)
    await page.waitForTimeout(300)
    await clickInPlace(page, box)
    for (const q of ['A follow-up from the foot of the view, long enough to need a few lines?', 'And one more?']) {
      await page.evaluate(() => {
        const h = document.querySelector('.session-history') as HTMLElement
        const w = window as unknown as { __st: { on: boolean; v: number[] } }
        w.__st = { on: true, v: [] }
        const tick = () => { if (!w.__st.on) return; w.__st.v.push(h.scrollTop); requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
      })
      await expect(box, 'the keyboard is in the box').toBeFocused()
      await page.keyboard.type(q)
      await page.keyboard.press('Enter')
      await expect(body).toContainText(`processed your message: ${q}`, { timeout: 30_000 })
      await page.waitForTimeout(600)
      const v = await page.evaluate(() => { const w = window as unknown as { __st: { on: boolean; v: number[] } }; w.__st.on = false; return w.__st.v })
      expect(Math.max(...v) - Math.min(...v), `the timeline stayed while "${q}" was typed, sent and answered`).toBeLessThan(3)
      const b = (await box.boundingBox())!
      expect(b.y + b.height, 'the box stays above the view\'s foot').toBeLessThanOrEqual(hb.y + hb.height)
      await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 3_000 }).toBeLessThan(2)
      // The reader's newest ask sits in the box now (2026-11-10, "put it inside the
      // input bar"), so it counts with the conversation shown above it.
      const asked = await card.locator('.thread-card-asked').evaluateAll((els) => els.reduce((h, el) => h + (el as HTMLElement).offsetHeight, 0))
      const seen = await body.evaluate((el) => ({ shown: el.clientHeight, all: el.scrollHeight }))
      expect(seen.shown + asked, 'the card keeps a readable piece of its conversation, not one line').toBeGreaterThanOrEqual(Math.min(seen.all + asked, 130))
    }
  })

  test('scrolling a long reply with 22 cards stays smooth', async ({ page, browserName }) => {
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    // Frame gaps while the box scrolls a step every frame, top to bottom of the reply.
    const gaps = await history.evaluate(async (el) => {
      el.scrollTop = 0
      const out: number[] = []
      let last = performance.now()
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const now = performance.now()
        out.push(now - last)
        last = now
        el.scrollTop += 40
      }
      return out.sort((a, b) => a - b)
    })
    const p90 = gaps[Math.floor(gaps.length * 0.9)]
    test.info().annotations.push({ type: 'frame-p90-ms', description: `${browserName}: ${p90.toFixed(1)}` })
    console.log(`[review-perf] ${browserName} frame gaps p50=${gaps[30].toFixed(1)} p90=${p90.toFixed(1)} max=${gaps[gaps.length - 1].toFixed(1)}`)
    // Loose: a loaded test box runs slow frames too; a per-frame layout loop would be far worse.
    expect(p90).toBeLessThan(120)
  })
})

test.describe('asks on turns that are not loaded', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, REVIEW_OLD_SESSION)
    await resetThreadsFixture(request, REVIEW_MIXED_SESSION)
  })

  test('one card on screen: the column brings every older ask in with its card, no "Load earlier turns" pressed', async ({ page }) => {
    // 2026-11-09: after a few follow-ups and a reload, full screen showed 1 of 4
    // cards; the rest came back only after "Load earlier turns".
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, REVIEW_MIXED_SESSION, REVIEW_MIXED_TASK, REVIEW_MIXED_READY, { view: 'linear' })
    const history = panel.locator('.session-history')
    await expect(history.getByText(REVIEW_MIXED_PASSAGES[0])).toHaveCount(0)
    // The newest row on screen: the reader's place. (Not a fixed passage: the
    // session keeps the follow-ups earlier tests sent from its cards, since a
    // reset puts back the questions, not the transcript.)
    const newest = history.locator('[data-message-id]').last()
    await expect(newest).toBeInViewport()
    const newestId = await newest.getAttribute('data-message-id')
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await expect(sidebarCards(panel)).toHaveCount(3, { timeout: 20_000 })
    for (const t of ['Mixed point 1', 'Mixed point 2', 'Mixed point 3']) {
      await expect(sidebarCards(panel).filter({ hasText: t })).toHaveCount(1)
    }
    // The reader stays where they were: that row is still on screen.
    await expect(history.locator(`[data-message-id="${newestId}"]`).first()).toBeInViewport()

    // A picture sent from a card's box, read back from the transcript after a
    // reload: its bubble shows the picture and the words, never Walnut's
    // attachment header and its saved path (2026-11-09).
    const recent = sidebarCards(panel).filter({ hasText: 'Mixed point 3' })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    await wheelIntoView(page, history, recent.locator('[data-testid="thread-card-attach"]'))
    const chooser = page.waitForEvent('filechooser')
    await clickInPlace(page, recent.locator('[data-testid="thread-card-attach"]'))
    await (await chooser).setFiles({ name: 'board.png', mimeType: 'image/png', buffer: png })
    await expect(recent.locator('[data-testid="thread-card-pictures"] img')).toHaveCount(1)
    await clickInPlace(page, recent.locator('textarea.thread-card-input'))
    await page.keyboard.type('What is in this picture?')
    await page.keyboard.press('Enter')
    await expect(recent.locator('.thread-review-body')).toContainText('processed your message', { timeout: 30_000 })
    // Out of full screen before the load (the kept full screen is not what this checks).
    await leaveFullscreen(page)
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = await openThreadsSession(page, REVIEW_MIXED_SESSION, REVIEW_MIXED_TASK, undefined, { view: 'linear' })
    await again.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(again).toHaveClass(/open-walnut-fullscreen/)
    const card3 = sidebarCards(again).filter({ hasText: 'Mixed point 3' })
    // The newest question sits in the card's reply box as one line (2026-11-10:
    // no bubbles in a review card); its picture is in the open card.
    const asked = card3.getByTestId('thread-reply-asked').filter({ hasText: 'What is in this picture?' })
    await expect(asked).toHaveCount(1, { timeout: 30_000 })
    // (The mock engine's answer echoes the whole message it got: only the
    // question's own line and the card's head are the card's words.)
    for (const own of [asked, card3.locator('button.thread-review-head')]) {
      await expect(own).not.toContainText('Images attached')
      await expect(own).not.toContainText('/images/')
    }
  })

  test('no bar while every ask sits above "Load earlier turns"; loading them brings the cards and the bar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, REVIEW_OLD_SESSION, REVIEW_OLD_TASK, REVIEW_OLD_READY, { view: 'linear' })
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    const history = panel.locator('.session-history')
    await expect(history.getByRole('button', { name: 'Load earlier turns', exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await expect(history.getByText(REVIEW_OLD_PASSAGES[0])).toHaveCount(0)
    // Past the column's hold: nothing to show, so no gutter and no bar, folded or open.
    await page.waitForTimeout(1600)
    await expect(panel.locator('[data-testid="thread-review-bar"]')).toHaveCount(0)
    await expect(panel.locator('.session-history[data-review-sidebar]')).toHaveCount(0)

    // Load the turn: its two asks get their cards and the bar, which folds to a band
    // counting them.
    await expect.poll(async () => {
      if (await history.getByText(REVIEW_OLD_PASSAGES[0].slice(0, 20)).count()) return true
      const more = history.getByRole('button', { name: 'Load earlier turns', exact: true })
      if (await more.count()) await more.first().evaluate((el) => (el as HTMLElement).click())
      return false
    }, { timeout: 20_000, intervals: [300] }).toBe(true)
    await expect(sidebarCards(panel)).toHaveCount(2, { timeout: 15_000 })
    const bar = panel.locator('[data-testid="thread-review-bar"]')
    await bar.click()
    await expect(panel.locator('.session-history[data-review-sidebar="collapsed"]')).toHaveCount(1)
    await expect(bar).toHaveAttribute('aria-label', 'Show questions (2)')
    await expect(bar.locator('.thread-review-bar-count')).toHaveText('2')
    const shots = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/fullscreen-band/${test.info().project.name}`
    await page.screenshot({ path: `${shots}/folded-band.png` })
    await bar.click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/open-column.png` })
    await expect(panel.locator('.session-history[data-review-sidebar="open"]')).toHaveCount(1)
  })
})

