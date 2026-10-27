/**
 * Fullscreen shows a review sidebar (2026-10-27, the user: "when in full screen
 * it default become the word like have a side bar on right like review show the
 * comments there"): one card per asked passage of the visible conversation, each
 * level with its passage (pushed down, never overlapping), scrolling with the
 * text. A card click scrolls to its passage and flashes it; a click on a passage
 * selects (outlines) its card instead of opening the popover; the picked card
 * takes a follow-up in its own box, and Enlarge opens the question's full card
 * right over it, the timeline staying put (2026-10-27, the user: "where is the
 * ask question and enlarge instead of open which jump to another place"); Quote
 * in chat quotes the question into the composer. Outside fullscreen nothing
 * changes.
 *
 * Chromium and WebKit. The review fixture: one long reply with 22 asked passages.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, readRecord, resetThreadsFixture } from './threads-helpers'
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
 *  programmatic scroll (WebKit snapped scrollIntoView straight back). */
async function wheelIntoView(page: Page, scroller: Locator, target: Locator): Promise<void> {
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  for (let i = 0; i < 80; i++) {
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
    await expect(panel.locator('.session-history[data-review-sidebar="on"]')).toHaveCount(1)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    await centreInHistory(page, panel, reviewPassage(3).slice(0, 30), { at: 0.2 })
    await page.waitForTimeout(300)

    const { cards, passageTops } = await layout(panel)
    // In passage order, by title.
    const byTop = [...cards].sort((a, b) => a.top - b.top).map((c) => c.title)
    expect(byTop).toEqual(REVIEW_TITLES)
    // The answer's start never shows the reply's `[Qn]` tag line (the fixture's
    // answers carry it, as live replies do).
    const answers = await sidebarCards(panel).locator('.thread-review-a').allTextContents()
    expect(answers.filter((t) => /\[Q\s?\d+\]/.test(t))).toEqual([])
    expect(answers.filter((t) => t.trim().length > 0).length).toBeGreaterThan(REVIEW_COUNT / 2)
    // A long question is clamped to one line inside its bubble: the bubble is
    // that line plus its padding, so the next line never shows through the
    // bottom padding (prod, 2026-10-27, both engines).
    const bubbles = await sidebarCards(panel).locator('.thread-review-q').evaluateAll((els) => els.map((el) => {
      const text = el.querySelector('.thread-review-q-text') as HTMLElement
      const cs = getComputedStyle(el)
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      return { box: el.getBoundingClientRect().height, text: text.getBoundingClientRect().height, line: parseFloat(cs.lineHeight), pad, clamped: text.scrollHeight > text.clientHeight + 1 }
    }))
    expect(bubbles.some((b) => b.clamped), 'a question is long enough to clamp').toBe(true)
    for (const b of bubbles) {
      expect(b.text).toBeLessThan(b.line * 1.5)
      expect(Math.abs(b.box - b.text - b.pad)).toBeLessThan(1.5)
    }
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

  test('a card click scrolls to its passage and flashes it; a passage click selects its card; Enlarge and Quote in chat', async ({ page }) => {
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    await history.evaluate((el) => { el.scrollTop = 0 })
    await page.waitForTimeout(200)

    // The card of passage 18, far below: a click brings its passage to the middle and flashes it.
    const target = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[17] })
    await wheelIntoView(page, history, target)
    await target.locator('.thread-review-a').click()
    await expect(target).toHaveAttribute('data-selected', 'true')
    const passage = reviewPassage(17)
    await expect.poll(() => page.evaluate((p) => {
      const h = CSS.highlights?.get('walnut-pin-flash') as unknown as Iterable<Range> | undefined
      return !!h && Array.from(h).some((r) => r.toString().includes(p.slice(0, 20)))
    }, passage), { timeout: 5_000 }).toBe(true)
    const box = (await history.boundingBox())!
    const at = (await passageRects(panel, passage.slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0].top
    expect(at).toBeGreaterThan(box.y + box.height * 0.2)
    expect(at).toBeLessThan(box.y + box.height * 0.8)
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    await shot(page, '3-card-click-flash')

    // A click on passage 4 selects its card; no popover opens.
    await centreInHistory(page, panel, reviewPassage(3).slice(0, 30))
    const r = (await passageRects(panel, reviewPassage(3).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
    await page.mouse.click(r.left + 20, r.top + r.height / 2)
    const fourth = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[3] })
    await expect(fourth).toHaveAttribute('data-selected', 'true')
    await expect(target).not.toHaveAttribute('data-selected', 'true')
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    // The selected card sits level with its passage.
    const sel = (await fourth.boundingBox())!
    const pr = (await passageRects(panel, reviewPassage(3).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
    expect(Math.abs(sel.y - pr.top)).toBeLessThan(4)
    await shot(page, '4-mark-click-selects')

    // The card's own control is a button that says it is the picked one.
    await expect(fourth.locator('button.thread-review-head')).toHaveAttribute('aria-pressed', 'true')
    await expect(target.locator('button.thread-review-head')).toHaveAttribute('aria-pressed', 'false')
    // The keyboard reaches it too: Enter on another card's button picks that card.
    const third = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[2] })
    await third.locator('button.thread-review-head').focus()
    await page.keyboard.press('Enter')
    await expect(third).toHaveAttribute('data-selected', 'true')
    await expect(third.locator('button.thread-review-head')).toHaveAttribute('aria-pressed', 'true')
    // Back to card 4 by its passage.
    await centreInHistory(page, panel, reviewPassage(3).slice(0, 30))
    const r4 = (await passageRects(panel, reviewPassage(3).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
    await page.mouse.click(r4.left + 20, r4.top + r4.height / 2)
    await expect(fourth).toHaveAttribute('data-selected', 'true')
    await expect(fourth.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0)
    await fourth.getByRole('button', { name: 'Enlarge question 4' }).click()
    await expect(panel.locator('.thread-card .thread-card-title')).toHaveText(REVIEW_TITLES[3])
    await panel.locator('.thread-card .thread-card-input').press('Escape')
    await expect(panel.locator('.thread-card')).toHaveCount(0)
    // Quote in chat: the composer names the question.
    await fourth.getByRole('button', { name: 'Quote in chat' }).click()
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toContainText(REVIEW_TITLES[3])
    await shot(page, '5-quoted-from-review')
  })

  test('the picked card asks a follow-up right there, and Enlarge opens the whole question over it', async ({ page, request }) => {
    const panel = await openFullscreen(page)
    await goFullscreen(panel)
    await expect(sidebarCards(panel)).toHaveCount(REVIEW_COUNT, { timeout: 15_000 })
    const history = panel.locator('.session-history')
    const mainBox = panel.locator('.session-panel-input .chat-input-textarea')
    const seeded = new Set(((await readRecord(request, REVIEW_SESSION)).threadAnchors ?? []).map((x) => x.msgId))

    // Pick card 5: its own box shows (no other card has one).
    const fifth = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[4] })
    await wheelIntoView(page, history, fifth)
    await fifth.locator('.thread-review-a').click()
    await expect(fifth).toHaveAttribute('data-selected', 'true')
    const box = fifth.locator('.thread-review-composer textarea')
    await expect(box).toBeVisible()
    await expect(panel.locator('.thread-review-composer')).toHaveCount(1)
    await expect(box).toHaveAttribute('placeholder', /Point 5 order/)
    await page.waitForTimeout(400)
    const topBefore = await history.evaluate((el) => el.scrollTop)
    // A click into the box is not a trip to the passage.
    await box.click()
    await page.waitForTimeout(300)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - topBefore)).toBeLessThan(2)

    // Every state the card takes from here on (a poll would miss a short red).
    await fifth.evaluate((el) => {
      const rec = el as HTMLElement & { _states?: string[] }
      rec._states = []
      new MutationObserver(() => { rec._states!.push(el.getAttribute('data-state') ?? '') }).observe(el, { attributes: true, attributeFilter: ['data-state'] })
    })
    // Sent from the card: into question 5, the main composer untouched, the timeline in place.
    await box.fill('slow:9000 MOCK_SPEAK_AT:1500 What breaks if it is skipped?')
    await box.press('Enter')
    await expect(box).toHaveValue('')
    // The card says what was asked at once, then where its answer stands.
    // (the mock CLI's timing words are part of what was typed)
    await expect(fifth.locator('.thread-review-q')).toHaveText('slow:9000 MOCK_SPEAK_AT:1500 What breaks if it is skipped?')
    await expect(fifth).toHaveAttribute('data-state', /waiting|answering/, { timeout: 10_000 })
    await expect(fifth.locator('.thread-review-a')).toContainText('processed your message: What breaks if it is skipped?', { timeout: 30_000 })
    // Picked while its answer lands: read (green), never the red "New answer".
    await expect(fifth).toHaveAttribute('data-state', /answering|read/)
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

    // Unsent words stay with the question: away to card 4 and back.
    await box.fill('half a thought')
    const fourth = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[3] })
    await fourth.locator('.thread-review-a').click()
    await expect(fourth).toHaveAttribute('data-selected', 'true')
    await expect(fifth.locator('.thread-review-composer')).toHaveCount(0)
    await wheelIntoView(page, history, fifth)
    await fifth.locator('.thread-review-a').click()
    await expect(box).toHaveValue('half a thought')
    // Typed and enlarged at once (inside the draft store's write delay): the full card has the words.
    await box.fill('half a thought, and more')

    // Enlarge: the full card lies over the review card (its top and right edge),
    // wider, with the same unsent words, and the timeline does not move.
    await page.waitForTimeout(400)
    const rc = (await fifth.boundingBox())!
    const scrollAt = await history.evaluate((el) => el.scrollTop)
    await fifth.getByRole('button', { name: 'Enlarge question 5' }).click()
    const card = panel.locator('.thread-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[4])
    await page.waitForTimeout(300)
    const cb = (await card.boundingBox())!
    expect(Math.abs(cb.y - rc.y), 'same top').toBeLessThan(3)
    expect(Math.abs(cb.x + cb.width - (rc.x + rc.width)), 'same right edge').toBeLessThan(3)
    expect(cb.width).toBeGreaterThan(rc.width + 200)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - scrollAt), 'the timeline stays put').toBeLessThan(2)
    await expect(fifth).toHaveAttribute('data-enlarged', 'true')
    expect(await fifth.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden')
    await expect(card.locator('.thread-card-input')).toHaveValue('half a thought, and more')
    // Nothing of the timeline floats over the card (2026-10-27 on prod: the
    // jump-to-bottom arrow sat on the enlarged card's box).
    const covered = await card.evaluate((el) => {
      const c = el.getBoundingClientRect()
      for (const o of document.querySelectorAll('.scroll-to-bottom-btn, .session-toc')) {
        const r = o.getBoundingClientRect()
        const x0 = Math.max(c.left, r.left), x1 = Math.min(c.right, r.right), y0 = Math.max(c.top, r.top), y1 = Math.min(c.bottom, r.bottom)
        if (x1 - x0 < 2 || y1 - y0 < 2) continue
        const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2)
        if (!hit || !el.contains(hit)) return o.className
      }
      return null
    })
    expect(covered, 'the card is on top').toBeNull()
    // The whole conversation: each question as the blue bubble (the follow-up
    // just asked from the review card is the second), the answers in full.
    await expect(card.locator('.thread-card-q .session-msg-user')).toHaveCount(2)
    await expect(card.locator('.thread-card-q').nth(1)).toContainText('What breaks if it is skipped?')
    const excerpt = (await fifth.locator('.thread-review-a').textContent()) ?? ''
    const full = (await card.locator('.thread-card-body .session-msg-assistant').first().textContent()) ?? ''
    expect(full.length).toBeGreaterThan(excerpt.replace(/…$/, '').length)
    await shot(page, '7-enlarged-over-card')
    // Typed in the full card and closed at once with Esc: back to the review
    // card, still picked, its box focused with those words.
    await card.locator('.thread-card-input').fill('typed in the big one')
    await card.locator('.thread-card-input').press('Escape')
    await expect(card).toHaveCount(0)
    await expect(fifth).not.toHaveAttribute('data-enlarged', 'true')
    await expect(fifth).toHaveAttribute('data-selected', 'true')
    await expect(box).toHaveValue('typed in the big one')
    await expect(box).toBeFocused()
    // Esc in the review box leaves the box, not the fullscreen.
    await box.press('Escape')
    await expect(box).not.toBeFocused()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)

    // The question of three rounds, enlarged from its mark's right-click menu.
    await centreInHistory(page, panel, reviewPassage(0).slice(0, 30), { at: 0.3 })
    const r0 = (await passageRects(panel, reviewPassage(0).slice(0, 30), '[data-message-id][data-msg-role="assistant"]'))[0]
    await page.mouse.click(r0.left + 20, r0.top + r0.height / 2, { button: 'right' })
    await page.getByTestId('thread-mark-menu').getByText('Enlarge question').click()
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[0])
    await expect(card.locator('.thread-card-q')).toHaveCount(REVIEW_ROUNDS.length)
    await expect(card.locator('.thread-card-body pre')).toContainText(REVIEW_ROUND_CODE)
    const first = sidebarCards(panel).filter({ hasText: REVIEW_TITLES[0] })
    await expect(first).toHaveAttribute('data-enlarged', 'true')
    await shot(page, '8-enlarged-three-rounds')
    await card.locator('.thread-card-input').press('Escape')
    await expect(card).toHaveCount(0)
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
