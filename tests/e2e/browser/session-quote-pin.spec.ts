/**
 * Quote pins: pin a SELECTION inside a message, not just the whole message.
 *
 * What each part is protecting:
 *
 *  · the pill is offered on a REAL drag (mousedown → move → mouseup), because that
 *    is the only gesture that exercises the selection listeners, the pointer-held
 *    auto-scroll guard, and the placement of an overlay against a live selection
 *    rect. `selectText()` would set a selection without any of it;
 *  · the pill is placed by useMenuPlacement, so it must sit fully inside the
 *    viewport — an overlay hanging off the edge is the repo's oldest overlay bug;
 *  · the paint is asserted through `CSS.highlights`, not by looking for a <mark>:
 *    the feature deliberately does not touch the message DOM (React re-sets the
 *    body's innerHTML on every streaming delta, which would wipe any wrapper);
 *  · the pin is asserted on the SERVER record too, and again after a reload. A pin
 *    that only lived in React state would look identical until the page came back;
 *  · the whole-message pin button is re-checked at the end: quote pins share the
 *    same list and the same outline, and must not have changed what it means.
 *
 * The fixture (`pw-pins-session`, see test-server.ts) ends with a three-sentence
 * assistant paragraph, which is what gives a phrase worth dragging out of the
 * middle of. "rewrites the index in place" appears exactly once in the transcript.
 */
import { expect, test, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'

const SESSION_ID = 'pw-pins-session'
const TASK_ID = 'pw-task-pins'
/** The tail paragraph, inside the initial 30-row render window. */
const PARAGRAPH = 'The migration runs in three phases'
/** The phrase the drag selects — mid-sentence, so it proves a PASSAGE was pinned
 *  and not the message. */
const PHRASE = 'rewrites the index in place'
/** A user row used for the whole-message-pin regression check. */
const USER_ASK = 'outline filler ask 20'

const SHOTS = '/tmp/quote-pin/shots'

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  // Open columns are persisted, so after a reload the panel is already there —
  // clicking the kebab row again would TOGGLE it shut.
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: 'More actions' }).click()
    // Positional, not by label: the kebab's session row text is derived from live state.
    await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  }
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history')).toContainText(PARAGRAPH, { timeout: 20000 })
  return panel
}

/** Scroll the timeline with a REAL wheel gesture: the timeline follows the bottom,
 *  and a programmatic scrollTop write is snapped straight back to the end. */
async function wheel(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(140)
}

/** Park a row in the middle of the timeline: under the sticky header or behind the
 *  composer it can be neither dragged over nor clicked. */
async function centreRow(page: Page, panel: Locator, target: Locator): Promise<void> {
  let lastTop = -1
  const history = panel.locator('.session-history')
  for (let i = 0; i < 30; i++) {
    const delta = await target.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const h = (el.closest('.session-history') as HTMLElement).getBoundingClientRect()
      return (r.y + r.height / 2) - (h.y + h.height / 2)
    })
    if (Math.abs(delta) < 40) return
    await wheel(page, panel, Math.max(-500, Math.min(500, Math.round(delta))))
    const top = await history.evaluate((el) => el.scrollTop)
    if (top === lastTop) return
    lastTop = top
  }
}

interface PhraseGeometry {
  rects: Array<{ left: number; right: number; top: number; height: number }>
  msgId: string
}

/** Viewport geometry of a phrase inside a rendered message, found by walking the
 *  message bodies' text nodes — the same way a person locates it with their eyes,
 *  and the only way to aim a real mouse drag at specific words. */
async function phraseGeometry(page: Page, phrase: string): Promise<PhraseGeometry> {
  const geo = await page.evaluate((needle) => {
    const bodies = Array.from(
      document.querySelectorAll('.session-history [data-message-id] .session-msg-content'),
    )
    for (const body of bodies) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n as Text
        const at = text.data.indexOf(needle)
        if (at === -1) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + needle.length)
        const rects = Array.from(range.getClientRects()).map((r) => ({
          left: r.left, right: r.right, top: r.top, height: r.height,
        }))
        const row = body.closest('[data-message-id]') as HTMLElement
        return { rects, msgId: row.getAttribute('data-message-id') ?? '' }
      }
    }
    return null
  }, phrase)
  expect(geo, `phrase "${phrase}" is not rendered`).not.toBeNull()
  expect(geo!.rects.length).toBeGreaterThan(0)
  return geo!
}

/** Drag-select `phrase` with the mouse, exactly as a person would. */
async function dragSelect(page: Page, phrase: string): Promise<string> {
  const { rects } = await phraseGeometry(page, phrase)
  const first = rects[0]
  const last = rects[rects.length - 1]
  const startX = first.left + 1
  const startY = first.top + first.height / 2
  const endX = last.right - 1
  const endY = last.top + last.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 5 })
  await page.mouse.up()
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected.trim().length).toBeGreaterThan(0)
  return selected
}

/** How many passages are painted right now (the registry is document-global). */
function paintedCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights
    return highlights?.get('walnut-pin')?.size ?? 0
  })
}

/** Passages flashing right now (the brighter highlight a jump leaves for ~1.5s). */
function flashCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights
    return highlights?.get('walnut-pin-flash')?.size ?? 0
  })
}

/** Viewport boxes of the first PAINTED passage, read out of the highlight registry
 *  itself (a Highlight is an iterable of live Ranges). Clicking one of these is
 *  literally clicking the yellow the reader sees — a rect re-derived from the
 *  phrase would only agree with it as long as nothing scrolled in between. */
type Box = { left: number; right: number; top: number; bottom: number }

function readPaintedRects(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights
    const hl = highlights?.get('walnut-pin')
    if (!hl) return [] as Box[]
    for (const range of hl) {
      const boxes = Array.from(range.getClientRects()).map((r) => ({
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      }))
      if (boxes.length) return boxes
    }
    return [] as Box[]
  })
}

/** Polled, not sampled once: a re-render replaces the body's text nodes, which
 *  detaches the painted Range for a frame until the paint is re-derived. */
async function paintedRects(page: Page): Promise<Box[]> {
  let boxes: Box[] = []
  await expect
    .poll(async () => (boxes = await readPaintedRects(page)).length, {
      timeout: 10000,
      message: 'the pinned passage is painted somewhere on screen',
    })
    .toBeGreaterThan(0)
  return boxes
}

async function storedPins(page: Page): Promise<Array<Record<string, any>>> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  return (await res.json()).session.pinnedMessages ?? []
}

test.describe('Quote pins', () => {
  // Serial: pins are SERVER state on ONE shared fixture session, and the project
  // runs fullyParallel — concurrent tests would reset each other's outline
  // mid-assertion (it presents as "the pin I just made vanished").
  test.describe.configure({ mode: 'serial' })
  // Each test does a full page load, opens the panel, wheel-scrolls a row to the
  // middle and then drags a selection across it. That is comfortably inside 30s on
  // an idle machine and comfortably outside it when something else is building
  // (measured: a cold fixture boot alone is ~20s idle, ~70s at load 130).
  test.setTimeout(90_000)

  test.beforeEach(async ({ request }) => {
    const reset = await request.patch(`/api/sessions/${SESSION_ID}`, { data: { pinned_messages: [] } })
    expect(reset.ok()).toBe(true)
  })

  test('a drag over a phrase offers a pill that pins exactly that passage', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)
    const paragraph = panel.locator('.session-msg', { hasText: PARAGRAPH }).first()
    await centreRow(page, panel, paragraph)

    const selected = await dragSelect(page, PHRASE)

    // 1. The pill appears, and lands fully inside the viewport (overlay rule #1).
    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()
    const box = (await pill.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    await shot(page, '01-selection-pill')

    // 2. Pin it.
    await pill.getByRole('button', { name: 'Pin' }).click()
    await expect(pill).toHaveCount(0)

    // 3. The outline gains a ❝ row (and the collapsed rail a tick).
    const toc = panel.locator('.session-toc')
    await expect(toc.locator('.session-toc-tick')).toHaveCount(1)
    await toc.locator('.session-toc-rail').hover()
    const item = toc.locator('.session-toc-item').first()
    await expect(item).toContainText('❝')
    await expect(item).toContainText('index in place')

    // 4. The passage is painted — through CSS.highlights, with no DOM wrapper.
    await expect.poll(() => paintedCount(page)).toBeGreaterThanOrEqual(1)
    await page.mouse.move(2, 2) // un-hover the outline before the screenshot
    await shot(page, '02-painted-passage')

    // 5. It persisted on the session record, and what was stored is the passage the
    //    user dragged over. Asserted by CONTENT, not by equality with
    //    `selection.toString()`: the quote is captured from the message's text
    //    index, and the two legitimately differ once the paragraph holds an inline
    //    element (see the whitespace/serialisation note in text-quote-anchor.ts), so
    //    equality here would fail the day someone bolds a word in the fixture.
    const pins = await storedPins(page)
    expect(pins).toHaveLength(1)
    expect(pins[0].quote?.exact).toContain('index in place')
    expect(selected).toContain('index in place')
    expect(pins[0].id).toBeTruthy()
    expect(pins[0].role).toBe('assistant')

    // 6. A pinned PASSAGE does not make the row's pin button read as pinned — that
    //    button owns the whole message, and pressing it must not unpin a passage.
    await paragraph.hover()
    await expect(paragraph.locator('.msg-pin-btn')).not.toHaveClass(/is-pinned/)

    // 7. Jumping from the outline flashes the PASSAGE, not the row. A quote row that
    //    fell back to the whole-message flash would look like it worked while
    //    pointing the eye at the wrong thing, so both halves are asserted: the
    //    passage highlight lights up, and the row highlight never does.
    await wheel(page, panel, -1400) // scroll the passage away so the jump has work
    await toc.locator('.session-toc-rail').hover()
    await toc.locator('.session-toc-item').first().click()
    await expect.poll(() => flashCount(page), { timeout: 3000 }).toBe(1)
    expect(await panel.locator('.user-messages-highlight').count()).toBe(0)
    await expect.poll(() => flashCount(page), { timeout: 5000 }).toBe(0) // and it fades
  })

  test('the paint comes back after a reload', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let panel = await openSession(page)
    await centreRow(page, panel, panel.locator('.session-msg', { hasText: PARAGRAPH }).first())
    await dragSelect(page, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"]').getByRole('button', { name: 'Pin' }).click()
    await expect.poll(() => paintedCount(page)).toBeGreaterThanOrEqual(1)

    // A real reload: this is the persistence check, so the browser state that would
    // make it pass for free has to be thrown away.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openSession(page)

    await expect(panel.locator('.session-toc-tick')).toHaveCount(1)
    // The row has to be rendered for its passage to be painted — it is in the
    // initial window, but the paint is re-derived after the body renders.
    await expect.poll(() => paintedCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
    // …and it is REALLY painted: a Range left over from a previous render still
    // counts in the registry while drawing nothing, so ask for its line boxes.
    await paintedRects(page)
  })

  test('clicking a painted passage opens a popover that unpins it', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)
    await centreRow(page, panel, panel.locator('.session-msg', { hasText: PARAGRAPH }).first())
    await dragSelect(page, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"]').getByRole('button', { name: 'Pin' }).click()
    await expect.poll(() => paintedCount(page)).toBeGreaterThanOrEqual(1)

    // Click the MIDDLE of the painted words. `::highlight` receives no events, so
    // this is the geometric hit test doing the work.
    const mid = (await paintedRects(page))[0]
    await page.mouse.click((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2)

    const popover = page.locator('[data-testid="quote-pin-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText('index in place')
    const box = (await popover.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    await shot(page, '03-popover')

    // A scroll RE-ANCHORS it rather than dismissing it. Closing on scroll looked
    // tidy and broke twice: the listener is document-wide, so a scroll in another
    // pane shut a popover the user was reading, and the timeline's own
    // follow-the-bottom shut this one a frame after it opened.
    await wheel(page, panel, -60)
    await expect(popover).toBeVisible()

    await popover.getByRole('button', { name: 'Unpin' }).click()
    await expect(popover).toHaveCount(0)
    // Paint, outline row and record all go together.
    await expect.poll(() => paintedCount(page)).toBe(0)
    await expect(panel.locator('.session-toc')).toHaveCount(0)
    expect(await storedPins(page)).toHaveLength(0)
  })

  test('the whole-message pin button still toggles as before', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    const row = panel.locator('.session-msg', { hasText: USER_ASK }).first()
    await centreRow(page, panel, row)
    await row.hover()
    const button = row.locator('.msg-pin-btn')
    await button.click()
    await expect(button).toHaveClass(/is-pinned/)
    await expect(button).toHaveAttribute('aria-pressed', 'true')

    const toc = panel.locator('.session-toc')
    await expect(toc.locator('.session-toc-tick')).toHaveCount(1)
    await toc.locator('.session-toc-rail').hover()
    // A whole-message row carries NO quote glyph — the two kinds stay tellable apart.
    await expect(toc.locator('.session-toc-item').first()).not.toContainText('❝')
    await expect(toc.locator('.session-toc-item').first()).toContainText(USER_ASK)

    const pins = await storedPins(page)
    expect(pins).toHaveLength(1)
    expect(pins[0].quote).toBeUndefined()

    await row.hover()
    await button.click()
    await expect(button).not.toHaveClass(/is-pinned/)
    await expect(panel.locator('.session-toc')).toHaveCount(0)
  })
})
