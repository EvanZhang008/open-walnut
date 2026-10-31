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
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, settledScrollTop, passageRects, readRecord, resetThreadsFixture } from './threads-helpers'
import { REVIEW_COUNT, REVIEW_READY, REVIEW_ROUNDS, REVIEW_ROUND_CODE, REVIEW_SESSION, REVIEW_TASK, REVIEW_TITLES, reviewPassage } from './threads-review-fixture'

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
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
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
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  for (let i = 0; i < 80; i++) {
    await settledScrollTop(scroller)
    const t = await target.boundingBox()
    if (t && t.y >= box.y + 40 && t.y + t.height <= box.y + box.height - 40) return
    await page.mouse.wheel(0, t && t.y < box.y + 40 ? -300 : 300)
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
        questions: el.querySelectorAll('.thread-card-q .session-msg-user').length,
        answers: el.querySelectorAll('.session-msg-assistant').length,
        bodyH: body?.getBoundingClientRect().height ?? 0,
        scrolls: !!body && body.scrollHeight > body.clientHeight + 1 && getComputedStyle(body).overflowY === 'auto',
        oneLine: title.scrollHeight <= title.clientHeight + 1,
        bodyText: body?.textContent ?? '',
      }
    }))
    const cap = Math.min(420, 900 * 0.55)
    for (const r of rows) {
      expect(r.questions, `the question shows: ${r.text.slice(0, 80)}`).toBeGreaterThanOrEqual(1)
      expect(r.oneLine).toBe(true)
      expect(r.bodyH, 'capped').toBeLessThanOrEqual(cap + 1)
      expect(r.bodyText).not.toMatch(/\[Q\s?\d+\]/)
    }
    expect(rows.filter((r) => r.answers > 0).length, 'answers show').toBeGreaterThan(REVIEW_COUNT / 2)
    await expect(sidebarCards(panel).locator('textarea')).toHaveCount(0)
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
    await expect(body.locator('.thread-card-q')).toHaveCount(REVIEW_ROUNDS.length)
    for (const q of REVIEW_ROUNDS) await expect(body).toContainText(q)
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
    const textRightFolded = await panel.evaluate((root) => root.querySelector('.session-history [data-message-id][data-msg-role="assistant"] .session-msg-content')!.getBoundingClientRect().right)
    expect(textRightFolded - textRightOpen, 'the text widened by the column').toBeGreaterThan(250)
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
    await target.locator('button.thread-review-head').click()
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
    await fifth.locator('button.thread-review-head').click()
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
