/**
 * Selecting a passage WHILE THE REPLY IS STILL ARRIVING — the real pipeline.
 *
 * Reported 2026-09-08: "while it is still generating I select text, Copy and Ask
 * question show up, and then it gets cancelled." Three separate defects were
 * behind that one sentence, and this spec exercises all three through the real
 * chain (composer send → mock CLI → real stream events → real render), because
 * two of them only exist in real GEOMETRY that a mocked timeline never produces:
 *
 *  1. the streaming bubble carried no `data-message-id`, so the pill's
 *     `selectionBody` refused the passage and no pill was offered at all;
 *  2. React 19 rewrites `innerHTML` whenever the `dangerouslySetInnerHTML` prop
 *     OBJECT identity changed — even for a byte-identical string — so the next
 *     delta detached the text node the drag was anchored in and took the
 *     selection with it (the selection freeze had held the string, which was no
 *     longer enough). Fix: `hooks/useStableHtml.ts`;
 *  3. any scroll DISMISSED the pill, and a streaming timeline scrolls without
 *     anybody asking: every shrink (the Queued badge becoming Delivered, the
 *     working indicator going at turn end) makes the browser clamp scrollTop
 *     when the reader is parked at the bottom. Now a scroll RE-ANCHORS the pill
 *     and only a passage scrolled clear of the timeline dismisses it.
 *
 * The mock CLI mode `stream-partial-long-text` (with a `chunk-delay:` prefix)
 * exists for this: a reply long enough to drag a phrase out of, arriving over
 * seconds so the assertions are not racing a synchronous burst. 2.5s per sentence
 * (four sentences, so ~10s of live turn) because the mid-stream assertions have to
 * hold while several OTHER spec files run in parallel on the same machine: at
 * 1.2s the reply finished under load before the hold below was done, and the
 * turn-live assertions failed in the batch while passing alone.
 */
import { expect, test, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { dragPhrase, selectionAnchorNodeType } from './selection-helpers'

/** Own fixture records: this spec SENDS turns, which append to a session's stream
 *  file, and a reply the first test left behind is PERSISTED history for the
 *  second — a drag would land on finished text and pass for the wrong reason. So
 *  one session per test (see test-server.ts), and serial: two turns in one fixture
 *  server would also fight over the working indicator. */
const SESSION_ID = 'pw-stream-select-session'
const TASK_ID = 'pw-task-stream-select'
const SESSION_ID_2 = 'pw-streamsel2-session'
const TASK_ID_2 = 'pw-task-streamsel2'
const SESSION_ID_3 = 'pw-streamsel3-session'
const TASK_ID_3 = 'pw-task-streamsel3'
/** A line from the seeded transcript, so we know the panel is loaded. */
const SEEDED = 'The migration runs in three phases'
/** Sentence 1 of the streamed reply, and the phrase dragged out of it. Neither
 *  string appears in the seeded transcript — a phrase shared with an already
 *  persisted message would let the drag land on a STATIC row and pass for the
 *  wrong reason. */
const STREAM_PHRASE = 'never blocks on a slow writer'
const STREAM_LATER = 'Every batch is fenced'

const SHOTS = '/tmp/stream-selection/shots'

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function openSession(page: Page, sid = SESSION_ID, taskId = TASK_ID): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(sid)
    const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
    await expect(task).toBeVisible()
    // Click the row's title: the task menu has no open-session row.
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history')).toContainText(SEEDED, { timeout: 20000 })
  return panel
}

/** Scroll with a REAL wheel gesture: the timeline follows the bottom, and a
 *  programmatic scrollTop write is snapped straight back to the end. */
async function wheel(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(150)
}

function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

test.describe('Selecting inside a reply that is still streaming', () => {
  test.describe.configure({ mode: 'serial' })

  test('the pill comes up on a live reply, survives the deltas and the turn end, and re-anchors on scroll', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const panel = await openSession(page)
    const history = panel.locator('.session-history')

    // Send a slow reply and stay at the bottom — the reader watching an answer
    // arrive, which is the only place the clamp-on-shrink bug lives.
    const textarea = panel.locator('.chat-input-textarea').first()
    await textarea.click()
    await textarea.fill('chunk-delay:2500 stream-partial-long-text')
    await textarea.press('Enter')

    // Sentence 1 painted; three more still to come. Asserting the working
    // indicator HERE (not at the turn-end check below) is deliberate: this is the
    // one moment the turn is guaranteed live, so the shrink further down is an
    // event this test watched happen even when the machine is loaded.
    await expect(history).toContainText(STREAM_PHRASE, { timeout: 40_000 })
    await expect(panel.locator('.session-working-indicator')).toHaveCount(1)
    await wheel(page, panel, 600) // park exactly at the bottom, as follow-bottom does

    await dragPhrase(page, '.session-streaming-panel', STREAM_PHRASE)
    expect(await selectedText(page)).toBe(STREAM_PHRASE)
    // Non-vacuity: anchored in a TEXT node, the thing an innerHTML rewrite kills.
    expect(await selectionAnchorNodeType(page)).toBe(3)

    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()
    await expect(pill.getByText('Copy')).toBeVisible()
    // Ask is the whole point of identity on a live block: the anchor names the
    // reply by the msgId the persisted twin will carry.
    await expect(pill.locator('[data-testid="quote-ask-btn"]')).toBeVisible()
    await shot(page, '01-pill-mid-stream')

    // Two more deltas arrive. The VISIBLE text stays at sentence 1 on purpose —
    // the selection freeze holds the rendered html back so the nodes under the
    // selection are not replaced — but the component re-renders on every one of
    // them, which is exactly when React 19 used to rewrite innerHTML anyway. So
    // the selection and the pill must both still be pointing at the same words.
    // (That deltas really did keep arriving is proven at the end of this test,
    // where the released block catches up to the LAST sentence.)
    await page.waitForTimeout(3200)
    expect(await selectedText(page)).toBe(STREAM_PHRASE)
    await expect(pill).toBeVisible()

    // A small scroll: the passage moves, so the pill FOLLOWS it (it used to be
    // dismissed by any scroll at all, which is what the turn-end clamp did).
    const before = await pill.boundingBox()
    await wheel(page, panel, -60)
    await expect(pill).toBeVisible()
    expect(await selectedText(page)).toBe(STREAM_PHRASE)
    const after = await pill.boundingBox()
    expect(before && after && after.y !== before.y, 'the pill re-anchored to the moved passage').toBe(true)
    await shot(page, '02-pill-followed-the-scroll')

    // Turn end: the working indicator goes, the timeline shrinks, the browser
    // clamps scrollTop. The pill stays. (It was asserted PRESENT above, while the
    // reply was mid-flight, so this really is a shrink the test watched happen.)
    await expect(panel.locator('.session-working-indicator')).toHaveCount(0, { timeout: 40_000 })
    expect(await selectedText(page)).toBe(STREAM_PHRASE)
    await expect(pill).toBeVisible()
    // And the words stayed WHERE THEY WERE. At turn end the persisted twin
    // renders above the frozen streaming copy, which used to shove the selected
    // line below the fold with nobody scrolling (measured in production: the
    // scroller grew 628px above the anchor, the line went 331px past the bottom
    // edge). useSelectionAnchoredScroll answers that growth with scrollTop.
    const stillOnScreen = await panel.evaluate((root) => {
      const box = root.querySelector('.session-history')!.getBoundingClientRect()
      const sel = window.getSelection()!
      const r = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom) }
    })
    expect(stillOnScreen.bottom, `selection left the scroller: ${JSON.stringify(stillOnScreen)}`)
      .toBeGreaterThan(stillOnScreen.boxTop)
    expect(stillOnScreen.top).toBeLessThan(stillOnScreen.boxBottom)
    await shot(page, '03-pill-survived-turn-end')

    // Ask still works after all that, and lands the composer chip on the passage.
    //
    // Pressed the way a HAND presses it: mouse down, a beat, mouse up. Playwright's
    // .click() sends down+up with no frame in between, which hides the real defect
    // here — the press clears the selection (main.tsx), the freeze releases, the
    // timeline resizes, the browser clamps scrollTop, and the pill's own click
    // arrives as a scroll with nothing selected. Dismissing in that frame unmounts
    // the button before React can deliver the click, so Ask silently did nothing.
    const askBtn = pill.locator('[data-testid="quote-ask-btn"]')
    const btnBox = (await askBtn.boundingBox())!
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(180)
    await page.mouse.up()
    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('never blocks')
    await shot(page, '04-composer-chip-from-live-reply')

    // Ask clears the selection, so the freeze releases and the frozen block
    // collapses into its persisted twin. Content alone would prove nothing here
    // (the twin renders whether or not the frozen block ever caught up) — ONE
    // copy of each sentence is the invariant: the deltas were real, the deferred
    // render caught up, and the double render is gone.
    await expect(history).toContainText(STREAM_LATER, { timeout: 20_000 })
    await expect(history).toContainText('flips the read path over', { timeout: 20_000 })
    await expect.poll(async () => page.evaluate((needle) => {
      const text = document.querySelector('.session-history')?.textContent ?? ''
      return text.split(needle).length - 1
    }, STREAM_PHRASE), { timeout: 20_000 }).toBe(1)
  })

  test('scrolling the passage clear of the timeline still dismisses the pill', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const panel = await openSession(page, SESSION_ID_2, TASK_ID_2)
    const history = panel.locator('.session-history')

    const textarea = panel.locator('.chat-input-textarea').first()
    await textarea.click()
    await textarea.fill('chunk-delay:2500 stream-partial-long-text')
    await textarea.press('Enter')
    await expect(history).toContainText(STREAM_PHRASE, { timeout: 40_000 })
    await wheel(page, panel, 600)

    await dragPhrase(page, '.session-streaming-panel', STREAM_PHRASE)
    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()

    // Far enough up that the passage leaves the scroller: a viewport-anchored
    // pill has nothing left to point at, so it goes rather than hovering over
    // unrelated words.
    for (let i = 0; i < 6; i++) await wheel(page, panel, -700)
    await expect(pill).toHaveCount(0)
    await shot(page, '05-pill-dismissed-when-passage-left')
  })

  test('Ask pressed MID-ANSWER still delivers its click', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const panel = await openSession(page, SESSION_ID_3, TASK_ID_3)
    const history = panel.locator('.session-history')

    const textarea = panel.locator('.chat-input-textarea').first()
    await textarea.click()
    await textarea.fill('chunk-delay:2500 stream-partial-long-text')
    await textarea.press('Enter')
    await expect(history).toContainText(STREAM_PHRASE, { timeout: 40_000 })
    // Parked at the bottom with the reply still arriving: the state where the
    // press's own side effects move the timeline the most.
    await wheel(page, panel, 600)

    await dragPhrase(page, '.session-streaming-panel', STREAM_PHRASE)
    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()
    await expect(panel.locator('.session-working-indicator')).toHaveCount(1)

    // The press itself is the hazard: mousedown clears the selection (main.tsx),
    // the freeze releases, every delta the frozen block held back flushes in at
    // once, the timeline jumps, the browser clamps scrollTop and fires a scroll —
    // all BEFORE mouseup. A pill that dismisses on that scroll unmounts the button
    // it was about to deliver a click to, and Ask does nothing at all. Playwright's
    // .click() has no frame between down and up, so the hold is the test.
    //
    // Honest scope: on this machine the clamp scroll lands ~700ms after mouseup, so
    // this test passes with and without the scroll handler's pressedPill guard. It
    // pins the USER-VISIBLE contract (a held press mid-answer still asks about the
    // passage), not that one guard.
    const askBtn = pill.locator('[data-testid="quote-ask-btn"]')
    const box = (await askBtn.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(220)
    await page.mouse.up()

    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('never blocks')
    await shot(page, '06-ask-pressed-mid-answer')
  })
})
