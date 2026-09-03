/**
 * Pinned messages + outline, per-message time, and the rewind dialog.
 *
 * Three features, one surface (the session timeline), so one spec: they share the
 * hover strip under every message. What each assertion is protecting:
 *
 *  · the hover strip is HOVER-ONLY — `opacity` has to be checked explicitly,
 *    because Playwright counts an opacity:0 element as visible, so `toBeVisible()`
 *    alone would pass even if the strip were permanently on screen (which would
 *    turn a conversation into a log file);
 *  · the outline reads in transcript order and survives a reload — a pin that only
 *    lived in React state would look identical until the page came back;
 *  · a jump has a way back. Losing your reading place is the cost of glancing at a
 *    pin otherwise;
 *  · the rewind dialog opens on a DRY RUN and refuses to promise a file restore it
 *    can't perform. The fixture session has no live CLI, which is exactly the case
 *    where a checked-by-default box would lie.
 *
 * The fixture (`pw-pins-session`, see test-server.ts) carries REAL v4 uuids on its
 * user lines: `--resume-session-at` only accepts transcript uuids, so the rewind
 * button is gated on one.
 */
import { expect, test, type Page, type Locator } from '@playwright/test'

const SESSION_ID = 'pw-pins-session'
const TASK_ID = 'pw-task-pins'
/** Second user message (index 2 of 52) — outside the 30-row render window, so the
 *  outline has to reveal it. NOT the first message: that one is also rendered as the
 *  header's initial-prompt block, which has no hover strip of its own. */
const EARLY_ASK = 'Now bump the version'
/** Inside the initial window (indices 22-51 are rendered). */
const LATE_ASK = 'outline filler ask 20'
const LAST_REPLY = 'outline filler reply 24'

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
  await expect(panel.locator('.session-history')).toContainText(LAST_REPLY, { timeout: 20000 })
  return panel
}

/** The transcript row whose text contains `text`, as the hover target. */
function row(panel: Locator, text: string): Locator {
  return panel.locator('.session-msg', { hasText: text }).first()
}

async function opacityOf(locator: Locator): Promise<number> {
  return Number(await locator.evaluate((el) => getComputedStyle(el).opacity))
}

/**
 * Scroll the timeline with a REAL wheel gesture.
 *
 * Assigning `scrollTop` (or calling `scrollIntoView`) does not work here: the
 * timeline follows the bottom, and a programmatic scroll is snapped straight back
 * to the end (measured: scrollTop 400 → 1743 within a frame). A wheel event is what
 * a person does, so it also tells the component the reader left the tail.
 */
async function wheel(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(140)
}

/** Park a row in the middle of the timeline: under the sticky header or behind the
 *  composer it can be neither hovered nor clicked. */
async function centreRow(page: Page, panel: Locator, target: Locator): Promise<void> {
  const history = panel.locator('.session-history')
  let lastTop = -1
  for (let i = 0; i < 30; i++) {
    const delta = await target.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const h = (el.closest('.session-history') as HTMLElement).getBoundingClientRect()
      return (r.y + r.height / 2) - (h.y + h.height / 2)
    })
    if (Math.abs(delta) < 60) return
    await wheel(page, panel, Math.max(-500, Math.min(500, Math.round(delta))))
    // Both ends of the transcript can't be centred; stop when scrolling stops.
    const top = await history.evaluate((el) => el.scrollTop)
    if (top === lastTop) return
    lastTop = top
  }
}

async function hoverRow(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreRow(page, panel, target)
  await target.hover()
}

test.describe('Session outline, message time, and rewind', () => {
  // Serial: pins are SERVER state on ONE shared fixture session, and the project
  // runs fullyParallel — concurrent tests would reset each other's outline
  // mid-assertion (it presents as "the pin I just made vanished").
  test.describe.configure({ mode: 'serial' })

  // Each test still starts from an empty outline, since the previous one left pins.
  test.beforeEach(async ({ request }) => {
    const reset = await request.patch(`/api/sessions/${SESSION_ID}`, { data: { pinned_messages: [] } })
    expect(reset.ok()).toBe(true)
  })

  test('the hover strip carries a relative time with the exact stamp in its tooltip', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    const target = row(panel, LATE_ASK)
    const strip = target.locator('.session-msg-actions')
    await expect(strip).toBeAttached()

    // 1. Hidden until hover — the whole point of "show the time hidden like this".
    expect(await opacityOf(strip)).toBe(0)

    await hoverRow(page, panel, target)
    // Re-hover on every poll: a reflow between the move and the read would
    // otherwise look like the hover rule never applied.
    await expect.poll(async () => { await target.hover(); return opacityOf(strip) }).toBe(1)

    // 2. Relative age on screen ("2 minutes ago" / "just now" — fixture is fresh).
    const time = strip.locator('.msg-time')
    await expect(time).toHaveText(/\S/)

    // 3. Exact timestamp in the tooltip: month name, day, year, clock.
    const abs = await time.getAttribute('data-tip')
    expect(abs).toBeTruthy()
    expect(abs).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/)
    expect(abs).toMatch(/\d{1,2}:\d{2}/)
    // The title attribute mirrors it, so a keyboard/touch user gets the native tip.
    expect(await time.getAttribute('title')).toBe(abs)
  })

  test('pinning builds the outline, and the outline jumps and comes back', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    // No pins yet → no outline at all (an unused feature shows nothing).
    await expect(panel.locator('.session-toc')).toHaveCount(0)

    // Reveal the head of the transcript so the FIRST message can be pinned; the
    // jump path back to it (after a reload re-windows to the tail) is the
    // interesting one.
    const showEarlier = panel.locator('.session-show-earlier-btn').first()
    while (await showEarlier.count() > 0 && !(await panel.locator('.session-history').textContent())?.includes(EARLY_ASK)) {
      await showEarlier.click()
      await page.waitForTimeout(250)
    }
    await expect(panel.locator('.session-history')).toContainText(EARLY_ASK)

    // Pin the first ask, then a later one: the outline must read in TRANSCRIPT
    // order regardless of the order they were pinned in.
    const late = row(panel, LATE_ASK)
    await hoverRow(page, panel, late)
    await late.locator('.msg-pin-btn').click()
    await expect(panel.locator('.session-toc-tick')).toHaveCount(1)
    const early = row(panel, EARLY_ASK)
    await hoverRow(page, panel, early)
    await early.locator('.msg-pin-btn').click()

    // Pinned state is visible on the row itself.
    await expect(early.locator('.msg-pin-btn')).toHaveClass(/is-pinned/)
    await expect(early.locator('.msg-pin-btn')).toHaveAttribute('aria-pressed', 'true')

    // 1. Collapsed rail: one tick per pin, no labels. The rail is what's on screen
    //    (the .session-toc container is a zero-height sticky anchor by design, so it
    //    doesn't reserve a strip of the reading surface).
    const toc = panel.locator('.session-toc')
    const rail = toc.locator('.session-toc-rail')
    await expect(rail).toBeVisible()
    await expect(toc.locator('.session-toc-tick')).toHaveCount(2)
    await expect(toc.locator('.session-toc-panel')).toHaveCount(0)

    // 2. Hover expands it into the labelled list, in transcript order.
    await rail.hover()
    const items = toc.locator('.session-toc-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText(EARLY_ASK)
    await expect(items.nth(1)).toContainText(LATE_ASK)

    // 3. Jump to the first ask from the bottom of the transcript, then come back.
    const history = panel.locator('.session-history')
    await wheel(page, panel, 4000)
    await wheel(page, panel, 4000)
    await page.waitForTimeout(300)
    const beforeJump = await history.evaluate((el) => el.scrollTop)
    expect(beforeJump).toBeGreaterThan(0)

    await rail.hover()
    await items.nth(0).click()
    await page.waitForTimeout(900) // smooth scroll + the render-window expansion
    const afterJump = await history.evaluate((el) => el.scrollTop)
    expect(afterJump).toBeLessThan(beforeJump - 100)
    // The target row is on screen, not merely in the DOM.
    const targetBox = await row(panel, EARLY_ASK).boundingBox()
    const historyBox = (await history.boundingBox())!
    expect(targetBox).not.toBeNull()
    expect(targetBox!.y).toBeGreaterThanOrEqual(historyBox.y - 10)
    expect(targetBox!.y).toBeLessThanOrEqual(historyBox.y + historyBox.height)

    // 4. "Back" restores the pre-jump position.
    await rail.hover()
    const back = toc.locator('.session-toc-back')
    await expect(back).toBeVisible()
    await back.click()
    await page.waitForTimeout(900)
    expect(Math.abs((await history.evaluate((el) => el.scrollTop)) - beforeJump)).toBeLessThanOrEqual(60)
  })

  test('pins are server state: they survive a reload, and unpin removes them', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let panel = await openSession(page)

    const target = row(panel, LATE_ASK)
    await hoverRow(page, panel, target)
    await target.locator('.msg-pin-btn').click()
    await expect(panel.locator('.session-toc-tick')).toHaveCount(1)

    // Round-trip through the server, not just React state.
    const stored = await page.request.get(`/api/sessions/${SESSION_ID}`)
    expect(stored.ok()).toBe(true)
    const body = await stored.json()
    expect(body.session.pinnedMessages).toHaveLength(1)
    expect(body.session.pinnedMessages[0].label).toContain(LATE_ASK)
    expect(body.session.pinnedMessages[0].role).toBe('user')

    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openSession(page)
    const toc = panel.locator('.session-toc')
    await expect(toc.locator('.session-toc-tick')).toHaveCount(1)

    // Unpin from the outline itself; the last pin taking the whole outline with it
    // is intended (nothing pinned ⇒ nothing to show).
    await toc.locator('.session-toc-rail').hover()
    await toc.locator('.session-toc-unpin').first().click()
    await expect(panel.locator('.session-toc')).toHaveCount(0)
    await expect(row(panel, LATE_ASK).locator('.msg-pin-btn')).not.toHaveClass(/is-pinned/)
  })

  test('rewind is offered on your own messages only, and its dialog dry-runs first', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)

    // Not on a reply: a rewind point is a user message (the CLI only checkpoints
    // files there), so offering it on an assistant row would always fail.
    const reply = row(panel, LAST_REPLY)
    await hoverRow(page, panel, reply)
    await expect(reply.locator('.msg-rewind-btn')).toHaveCount(0)

    const target = row(panel, LATE_ASK)
    await hoverRow(page, panel, target)
    const rewindBtn = target.locator('.msg-rewind-btn')
    await expect(rewindBtn).toHaveCount(1)
    await rewindBtn.click()

    const dialog = page.locator('.rewind-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(LATE_ASK)
    // Same skin as every other confirm in the app: the shared modal classes, not
    // a bespoke one (the bare-blue unstyled button of 2026-09-03 came from a
    // class that did not exist).
    await expect(dialog).toHaveClass(/app-modal/)
    await expect(dialog.locator('.app-modal-actions .app-modal-btn.primary')).toHaveCount(1)

    // The dry run reports the blast radius: how many messages get dropped. The
    // DEFAULT is an in-place rewind, so the copy says they leave THIS conversation
    // (not that a new session is spawned / this one archived).
    await expect(dialog.locator('.app-modal-message')).toContainText(/\d+ later messages? will be dropped from this conversation/)

    // The fixture session has no live CLI, so the file half is unavailable — the
    // FILES row (first) must be OFF and disabled, with the reason spelled out.
    // A default-on box here would promise a restore that silently doesn't happen.
    const filesCheck = dialog.locator('.rewind-dialog-option').first().locator('input[type="checkbox"]')
    await expect(filesCheck).toBeDisabled()
    await expect(filesCheck).not.toBeChecked()
    await expect(dialog.locator('.rewind-dialog-option').first()).toHaveClass(/is-disabled/)
    await expect(dialog).toContainText(/not running|checkpoint/i)

    // The "into a copy" (fork) toggle is present and OFF by default — the default
    // is an in-place rewind of THIS conversation.
    const copyCheck = dialog.getByText('Rewind into a copy instead', { exact: false })
    await expect(copyCheck).toBeVisible()
    const copyInput = dialog.locator('.rewind-dialog-option', { hasText: 'into a copy' }).locator('input')
    await expect(copyInput).not.toBeChecked()

    // The primary button says what it will actually do (conversation only, in place).
    await expect(dialog.getByRole('button', { name: 'Rewind', exact: true })).toBeVisible()

    // Toggling "into a copy" flips the copy to the fork wording and relabels the
    // button — the two modes must read differently before the user commits.
    await copyInput.check()
    await expect(dialog).toContainText(/continues in a new session; this one stays as it is/)
    await expect(dialog.getByRole('button', { name: 'Rewind into a copy', exact: true })).toBeVisible()

    // Cancel leaves the session exactly as it was — nothing was rewound.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.rewind-dialog')).toHaveCount(0)
    await expect(panel.locator('.session-history')).toContainText(LAST_REPLY)
    const after = await (await page.request.get(`/api/sessions/${SESSION_ID}`)).json()
    expect(after.session.archived ?? false).toBe(false)
  })
})
