/**
 * Conversation threads: a navigation tree over ONE linear session.
 *
 * The feature has two renderers over the same data (`session.threadAnchors`), and
 * this spec covers both plus the gesture that creates an anchor:
 *
 *  · B (light) — the timeline is untouched; an anchored turn gains a gutter bar
 *    (`.session-msg--threaded[data-thread-depth]`) and a `↳ <passage>` tag, and the
 *    outline rail gains one indented row per thread. Asserted from PATCHed anchors
 *    rather than from a send, because the fixture session has no live CLI: the
 *    anchors are the input to the renderers, and a send is a different contract
 *    (covered by the unit + live layers);
 *  · the Ask pill → composer chip → `×` loop, which is the only way a person makes
 *    an anchor. Driven with a REAL mouse drag, the way `session-quote-pin.spec.ts`
 *    does: the quote is captured when the SELECTION CHANGES (main.tsx clears the
 *    range on the mousedown that presses the pill), so a synthetic Range that never
 *    fires the listeners would assert nothing about the path that ships;
 *  · A (tree mode) — the same anchors, second renderer: toggle, breadcrumb,
 *    collapsed ancestors, child cards, keyboard navigation, and the per-session
 *    memory of the mode.
 *
 * Two properties of the ANCHORS matter for every assertion below and are easy to
 * break while editing them: an anchor's `parent` row must PRECEDE its `msgId` row
 * (`buildThreadTree` treats a forward reference as dangling, so the thread would
 * silently not exist), and two turns sharing `parent` + `quote.exact` are ONE
 * thread — that is what makes a sticky follow-up land where the user is typing.
 *
 * Every row used here sits inside the initial 30-row render window (the fixture
 * holds 53 messages, so indices 23+ are rendered), which is why no "Show earlier"
 * dance is needed. The window matters for tree mode too: a thread whose head is
 * above the window would render as an empty view.
 */
import { expect, test, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'

/** Own fixture record (test-server.ts): the outline transcript, re-written under a
 *  second session id and uuid prefix, so this spec's pin reset + anchors never race
 *  session-outline-rewind.spec.ts on the shared `pw-pins-session` record. */
const SESSION_ID = 'pw-threads-session'
const TASK_ID = 'pw-task-threads'

/** Last row of the fixture's filler, inside the initial window — the "history has
 *  landed" signal, same as the outline spec's. */
const LAST_REPLY = 'outline filler reply 24'
/** The fixture's tail paragraph: the one message long enough to drag a phrase out
 *  of the middle of. */
const PARAGRAPH = 'The migration runs in three phases'
/** Selected in test 2 — appears exactly once in the whole transcript. */
const PHRASE = 'rewrites the index in place'

/**
 * Fixture transcript uuids (test-server.ts). Filler pair `n` (1-based, n = 1..24)
 * is `outline filler ask n` / `outline filler reply n`, written under
 * `0199bb02-…-<i>` / `0199bb03-…-<i>` with i = n - 1.
 */
const askUuid = (n: number) => `0199bb02-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`
const replyUuid = (n: number) => `0199bb03-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`

/** Passages the two threads hang off. Substrings of the real reply text, so a quote
 *  the product would have captured from a selection — not a synthetic string. */
const QUOTE_A = 'filler reply 20'
const QUOTE_B = 'filler reply 21'

/**
 * Three anchors, two threads:
 *
 *  · ask 21 asks about a passage of reply 20  → thread A, depth 1
 *  · ask 22 repeats the SAME parent + passage → sticky follow-up, same thread A
 *  · ask 23 asks about a passage of reply 21, which is INSIDE thread A → thread B,
 *    depth 2
 *
 * ask 24 is left unanchored: it is the control row (never threaded) and, in tree
 * mode, the top-level row that must NOT be in the DOM while a thread is open.
 */
const ANCHORS = [
  {
    msgId: askUuid(21),
    parent: replyUuid(20),
    quote: { exact: QUOTE_A },
    source: 'selection',
    at: new Date(Date.now() - 30_000).toISOString(),
  },
  {
    msgId: askUuid(22),
    parent: replyUuid(20),
    quote: { exact: QUOTE_A },
    source: 'sticky',
    at: new Date(Date.now() - 20_000).toISOString(),
  },
  {
    msgId: askUuid(23),
    parent: replyUuid(21),
    quote: { exact: QUOTE_B },
    source: 'selection',
    at: new Date(Date.now() - 10_000).toISOString(),
  },
]

/** Per-engine, so a WebKit run does not overwrite the chromium evidence (the two
 *  engines are the point of running this twice). */
function shotsDir(): string {
  return `/tmp/threads/e2e/${test.info().project.name}`
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = shotsDir()
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function patchAnchors(request: APIRequestContext, anchors: unknown[]): Promise<void> {
  const res = await request.patch(`/api/sessions/${SESSION_ID}`, { data: { thread_anchors: anchors } })
  expect(res.ok(), `PATCH thread_anchors: ${res.status()} ${await res.text()}`).toBe(true)
}

/** Open the session column (idempotent: open columns are persisted, so clicking the
 *  kebab row again after a reload would TOGGLE it shut). */
async function revealPanel(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: 'More actions' }).click()
    // Positional, not by label: the kebab's session row text is derived from live state.
    await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  }
  await expect(panel).toBeVisible()
  return panel
}

async function openSession(page: Page, ready = LAST_REPLY): Promise<Locator> {
  const panel = await revealPanel(page)
  await expect(panel.locator('.session-history')).toContainText(ready, { timeout: 20000 })
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
  const history = panel.locator('.session-history')
  let lastTop = -1
  for (let i = 0; i < 30; i++) {
    const delta = await target.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const h = (el.closest('.session-history') as HTMLElement).getBoundingClientRect()
      return (r.y + r.height / 2) - (h.y + h.height / 2)
    })
    if (Math.abs(delta) < 40) return
    await wheel(page, panel, Math.max(-500, Math.min(500, Math.round(delta))))
    // Both ends of the transcript can't be centred; stop when scrolling stops.
    const top = await history.evaluate((el) => el.scrollTop)
    if (top === lastTop) return
    lastTop = top
  }
}

/** Viewport geometry of a phrase inside a rendered message — the only way to aim a
 *  real mouse drag at specific words. */
async function phraseRects(page: Page, phrase: string) {
  const rects = await page.evaluate((needle) => {
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
        return Array.from(range.getClientRects()).map((r) => ({
          left: r.left, right: r.right, top: r.top, height: r.height,
        }))
      }
    }
    return null
  }, phrase)
  expect(rects, `phrase "${phrase}" is not rendered`).not.toBeNull()
  expect(rects!.length).toBeGreaterThan(0)
  return rects!
}

/** Drag-select `phrase` with the mouse, exactly as a person would. The pill's quote
 *  is captured from these selection events, so the gesture is the test. */
async function dragSelect(page: Page, phrase: string): Promise<string> {
  const rects = await phraseRects(page, phrase)
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

/** The wrapper div carrying a row's thread decoration. `.session-msg` is the INNER
 *  element (SessionMessage's own root), so the gutter class and depth live one level
 *  up, on the element that also holds `data-message-id`. */
function rowWrap(panel: Locator, uuid: string): Locator {
  return panel.locator(`.session-history [data-message-id="${uuid}"]`)
}

function paddingLeftOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
}

test.describe('Conversation threads', () => {
  // Serial: anchors are SERVER state on ONE shared fixture session, and the project
  // runs fullyParallel — concurrent tests would reset each other's threads
  // mid-assertion (it presents as "the thread I just opened vanished").
  test.describe.configure({ mode: 'serial' })
  // Each test does a full page load, opens the panel, wheel-scrolls a row into
  // place and drags across it. Comfortably inside 30s idle, comfortably outside it
  // when something else is building (a cold fixture boot alone is ~20s idle, ~70s
  // at load 130).
  test.setTimeout(90_000)

  // Both lists, every time: pins and anchors share the rail, and a pin left behind
  // by an earlier test in this file would add rail rows the next one counts.
  test.beforeEach(async ({ request }) => {
    const reset = await request.patch(`/api/sessions/${SESSION_ID}`, {
      data: { pinned_messages: [], thread_anchors: [] },
    })
    expect(reset.ok()).toBe(true)
  })

  test('anchored turns wear their thread, and the rail shows the shape', async ({ page, request }) => {
    await patchAnchors(request, ANCHORS)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    // 1. The two turns sharing one parent + passage are ONE thread at depth 1 — the
    //    sticky follow-up (ask 22) is not a second branch.
    for (const uuid of [askUuid(21), askUuid(22)]) {
      await expect(rowWrap(panel, uuid)).toHaveClass(/session-msg--threaded/)
      await expect(rowWrap(panel, uuid)).toHaveAttribute('data-thread-depth', '1')
    }

    // 2. A question about a reply INSIDE that thread nests one level deeper.
    await expect(rowWrap(panel, askUuid(23))).toHaveAttribute('data-thread-depth', '2')

    // 3. An unanchored turn is untouched. Asserted as a COUNT of the decorated
    //    selector rather than not.toHaveClass: a top-level row carries no class
    //    attribute at all, which is the point (the transcript reads identically
    //    with and without threads).
    await expect(rowWrap(panel, askUuid(24))).toBeVisible()
    await expect(panel.locator(`[data-message-id="${askUuid(24)}"].session-msg--threaded`)).toHaveCount(0)
    // …and the row it hangs off is not decorated either — only the QUESTION's turn
    // belongs to the thread, not the reply it is about.
    await expect(panel.locator(`[data-message-id="${replyUuid(20)}"].session-msg--threaded`)).toHaveCount(0)

    // 4. The tag above the user bubble names the PASSAGE (pinLabelFor of
    //    quote.exact), so the reader can tell two threads on one reply apart.
    await expect(rowWrap(panel, askUuid(21)).locator('.session-msg-thread-tag')).toContainText(QUOTE_A)
    await expect(rowWrap(panel, askUuid(23)).locator('.session-msg-thread-tag')).toContainText(QUOTE_B)
    // The nested thread's tag must not read as the parent thread's.
    await expect(rowWrap(panel, askUuid(23)).locator('.session-msg-thread-tag')).not.toContainText(QUOTE_A)

    // 5. The rail exists on threads ALONE (no pins in this session) — one row per
    //    thread, indented by depth. 12px per level, from `--thread-indent`.
    const toc = panel.locator('.session-toc')
    await expect(toc.locator('.session-toc-tick')).toHaveCount(2)
    await toc.locator('.session-toc-rail').hover()
    const threadRows = toc.locator('.session-toc-row--thread')
    await expect(threadRows).toHaveCount(2)
    // Transcript order: thread A's head (ask 21) precedes thread B's (ask 23).
    await expect(threadRows.nth(0)).toContainText(QUOTE_A)
    await expect(threadRows.nth(1)).toContainText(QUOTE_B)
    const indent1 = await paddingLeftOf(threadRows.nth(0))
    const indent2 = await paddingLeftOf(threadRows.nth(1))
    expect(indent1).toBe(12)
    expect(indent2).toBe(24)
    // The dash is the thread-coloured variant, not a pin tick.
    await expect(threadRows.nth(0).locator('.session-toc-dash--thread')).toHaveCount(1)

    // 6. Hovering a thread row offers "Ask here" and tints that thread's turns —
    //    the rail's answer to "which parts of this conversation are that thread?".
    //    The action is opacity-gated, so being visible to Playwright is not enough.
    const ask = threadRows.nth(0).locator('.session-toc-ask')
    await expect(ask).toBeAttached()
    await expect
      .poll(async () => {
        await threadRows.nth(0).hover()
        return Number(await ask.evaluate((el) => getComputedStyle(el).opacity))
      })
      .toBe(1)
    await expect(rowWrap(panel, askUuid(21))).toHaveClass(/is-thread-hover/)
    await shot(page, '01-light-view-rail-open')
  })

  test('Ask on a selection sets the composer chip, and × clears it', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page, PARAGRAPH)

    await centreRow(page, panel, panel.locator('.session-msg', { hasText: PARAGRAPH }).first())
    const selected = await dragSelect(page, PHRASE)
    expect(selected).toContain(PHRASE)

    // 1. The pill offers Ask next to Pin — on a REPLY, which is what "ask about
    //    this" means.
    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()
    const askBtn = pill.locator('[data-testid="quote-ask-btn"]')
    await expect(askBtn).toBeVisible()
    await shot(page, '02-pill-with-ask')

    await askBtn.click()
    await expect(pill).toHaveCount(0)

    // 2. The chip is the one visible answer to "where will this message go?": the
    //    passage in the label, the whole passage in the title (the label is one
    //    clipped line, and the user must be able to check WHICH passage).
    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText(PHRASE)
    expect(await chip.getAttribute('title')).toContain(PHRASE)

    // 3. Focus followed the gesture into the composer — Ask is the start of typing
    //    a question, not a bookmark.
    await expect(panel.locator('.chat-input-textarea')).toBeFocused()
    await shot(page, '03-composer-chip')

    // 4. Nothing was written to the record yet. An anchor names a user message that
    //    does not exist until the send, so Ask is composer state ONLY — a write
    //    here would leave a permanently dangling anchor if the user changed
    //    their mind.
    const stored = await page.request.get(`/api/sessions/${SESSION_ID}`)
    expect(stored.ok()).toBe(true)
    expect((await stored.json()).session.threadAnchors ?? []).toHaveLength(0)

    // 5. `×` goes back to the top level.
    await chip.locator('[data-testid="thread-anchor-clear"]').click()
    await expect(chip).toHaveCount(0)

    // 6. No Ask on a USER row. Asking about your own message has no reply to hang
    //    off, so the pill offers Pin and Copy and nothing else.
    const userRow = panel.locator('.session-msg', { hasText: 'outline filler ask 22' }).first()
    await centreRow(page, panel, userRow)
    await dragSelect(page, 'filler ask 22')
    await expect(pill).toBeVisible()
    await expect(pill.getByRole('button', { name: 'Pin' })).toBeVisible()
    await expect(pill.locator('[data-testid="quote-ask-btn"]')).toHaveCount(0)
    await shot(page, '04-user-row-pill-no-ask')
  })

  test('the chip is sticky across a reload', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let panel = await openSession(page, PARAGRAPH)

    await centreRow(page, panel, panel.locator('.session-msg', { hasText: PARAGRAPH }).first())
    await dragSelect(page, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toBeVisible()

    // A real reload: a half-typed question must not silently be re-aimed at the top
    // level, so the anchor is remembered per tab (sessionStorage).
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openSession(page, PARAGRAPH)

    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toBeVisible({ timeout: 20000 })
    await expect(chip).toContainText(PHRASE)
  })

  test('tree mode renders one thread at a time and navigates', async ({ page, request }) => {
    await patchAnchors(request, ANCHORS)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)
    const history = panel.locator('.session-history')

    // 1. The toggle appears because this session HAS threads (test 5 pins the
    //    other half of that rule).
    const toggle = panel.locator('.session-view-toggle')
    await expect(toggle).toBeVisible()
    await toggle.locator('.session-view-toggle-btn[data-view="tree"]').click()
    await expect(history).toHaveAttribute('data-view-mode', 'tree')

    // 2. Opens at the top level — where the newest message is. The root crumb's key
    //    is the EMPTY STRING, which is why every key check in this feature has to
    //    compare against undefined rather than test truthiness.
    const crumbs = panel.locator('.thread-crumb')
    await expect(crumbs).toHaveCount(1)
    await expect(crumbs.first()).toHaveAttribute('data-thread-key', '')
    await expect(crumbs.first()).toHaveClass(/is-current/)
    await expect(crumbs.first()).toHaveText('Top level')

    // 3. The branch leaving the top level is offered as a card labelled by its
    //    passage. Only the top-level thread — the nested one belongs to ITS parent.
    const cards = panel.locator('.thread-child-card')
    await expect(cards).toHaveCount(1)
    await expect(cards.first().locator('.thread-child-card-label')).toHaveText(QUOTE_A)
    await shot(page, '05-tree-root')

    await cards.first().click()

    // 4. Inside thread A: two crumbs, the thread is current, and its own turns are
    //    on screen.
    await expect(panel.locator('.thread-crumb')).toHaveCount(2)
    await expect(panel.locator('.thread-crumb.is-current')).toHaveText(QUOTE_A)
    await expect(rowWrap(panel, askUuid(21))).toBeVisible()
    await expect(rowWrap(panel, askUuid(22))).toBeVisible()

    // 5. …and an unrelated TOP-LEVEL turn is not merely scrolled away, it is out of
    //    the DOM. That is the whole difference between tree mode and the timeline.
    await expect(history).not.toContainText('outline filler ask 24')
    await expect(panel.locator(`[data-message-id="${askUuid(24)}"]`)).toHaveCount(0)

    // 6. The context above is collapsed to one line per turn, expandable in place.
    const ancestors = panel.locator('.thread-ancestor-turn')
    expect(await ancestors.count()).toBeGreaterThanOrEqual(1)
    const boundary = ancestors.last()
    await expect(boundary).toHaveAttribute('aria-expanded', 'false')
    await boundary.click()
    await expect(boundary).toHaveAttribute('aria-expanded', 'true')
    // The expanded turn renders the REAL rows, through the same renderer the
    // timeline uses — the reply this thread hangs off is now readable in full.
    await expect(rowWrap(panel, replyUuid(20))).toBeVisible()

    // 7. Navigating also points the composer at the thread: the node view needs no
    //    send logic of its own.
    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText(QUOTE_A)

    // 8. The rail marks where you are (tree mode only — in the timeline every
    //    thread is visible at once, so nothing is "current").
    const toc = panel.locator('.session-toc')
    await toc.locator('.session-toc-rail').hover()
    await expect(toc.locator('.session-toc-row.is-current')).toHaveCount(1)
    await expect(toc.locator('.session-toc-row.is-current')).toContainText(QUOTE_A)
    await page.mouse.move(4, 4) // un-hover so the panel collapses before the shot
    await shot(page, '06-tree-thread-a')

    // 9. The nested thread is offered from here, and ↓ walks into it.
    await expect(panel.locator('.thread-child-card-label')).toHaveText(QUOTE_B)
    await history.focus()
    await page.keyboard.press('ArrowDown')
    await expect(panel.locator('.thread-crumb')).toHaveCount(3)
    await expect(panel.locator('.thread-crumb.is-current')).toHaveText(QUOTE_B)
    // A leaf thread says how to make the next branch instead of showing an empty
    // card row.
    await expect(panel.locator('.thread-child-hint')).toBeVisible()
    await shot(page, '07-tree-thread-b')

    // 10. ⌘/Ctrl+↑ is the way out from any depth, and the top level has no anchor.
    await history.focus()
    await page.keyboard.press('ControlOrMeta+ArrowUp')
    await expect(panel.locator('.thread-crumb')).toHaveCount(1)
    await expect(panel.locator('.thread-crumb.is-current')).toHaveText('Top level')
    await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toHaveCount(0)

    // 11. Back to the timeline: everything is in the DOM again.
    await toggle.locator('.session-view-toggle-btn[data-view="linear"]').click()
    await expect(history).toHaveAttribute('data-view-mode', 'linear')
    await expect(history).toContainText('outline filler ask 24')

    // 12. The mode is a per-session reading preference, so it survives a reload.
    await toggle.locator('.session-view-toggle-btn[data-view="tree"]').click()
    await expect(history).toHaveAttribute('data-view-mode', 'tree')
    await page.reload()
    await page.waitForLoadState('networkidle')
    const reopened = await revealPanel(page)
    await expect(reopened.locator('.session-history'))
      .toHaveAttribute('data-view-mode', 'tree', { timeout: 20000 })
    await expect(reopened.locator('.thread-crumb').first()).toHaveText('Top level')
  })

  test('no threads, no toggle', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    // An unused feature shows nothing: no toggle, no rail, no decorated rows.
    await expect(panel.locator('.session-view-toggle')).toHaveCount(0)
    await expect(panel.locator('.session-toc')).toHaveCount(0)
    await expect(panel.locator('.session-msg--threaded')).toHaveCount(0)
    await expect(panel.locator('.session-msg-thread-tag')).toHaveCount(0)
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'linear')
  })
})
