/**
 * The quote pill's HOLD, in WEBKIT — the Mac app's engine, where the 2026-09-16
 * report came from.
 *
 * Dictation cannot run here (no fake capture device in WebKit), so this file drives
 * the one act of the landing that matters to the pill: the composer's hold request,
 * sent from the page exactly as the composer sends it, followed by the focus move that
 * collapses the selection. What is pinned is the pill's LIFECYCLE around that:
 *
 *  · it survives the collapse, painted, with Ask still working — and Ask, not the
 *    landing, is what makes the "asking about" chip;
 *  · it lets go on Escape, on a press elsewhere in the timeline, on a press into
 *    ANOTHER panel's composer, and on a new selection (which it follows);
 *  · it does NOT let go on a press into this panel's composer (writing the question)
 *    or on its mic (`data-keep-selection`: acting on the passage);
 *  · a scroll moves it with the words and dismisses it once they leave the scroller
 *    (the held branch of the scroll handler, which has no live selection to read);
 *  · a hold request with nothing selected on screen is declined, so a dictation with
 *    nothing selected changes nothing.
 *
 * The dictation itself, and the stray-word report end to end, are in
 * session-voice-selection.spec.ts (Chromium).
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PHRASE, PHRASE2, SESSION_ID, heldPainted, highlightsSupported, openSession, requestHoldFromPage,
  selectPassage, selectedText, shot, stubSttStatus, wheel,
} from './voice-selection-helpers'

test.use({ browserName: 'webkit' })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

/** Take focus the way the dictation landing does: programmatically, with no press
 *  (a click would be a pointerdown with rules of its own, tested separately). */
async function focusComposer(page: Page): Promise<void> {
  await page.evaluate((sid) => {
    const el = document.querySelector<HTMLTextAreaElement>(`.session-panel[data-session-id="${sid}"] .chat-input-textarea`)
    el?.focus()
  }, SESSION_ID)
}

test.describe('the held pill in the Mac app engine', () => {
  test('a held passage survives the focus move, and Ask makes the chip', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    const textarea = panel.locator('.chat-input-textarea').first()
    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    const pill = await selectPassage(page, panel)
    const painted = await highlightsSupported(page)

    expect(await requestHoldFromPage(page, SESSION_ID), 'the pill took the hold').toBe(true)
    await focusComposer(page)
    await expect.poll(() => selectedText(page), 'focus collapsed the selection').toBe('')
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('chat-input-textarea')

    // Held: still up, still painted, still offering Ask — and no chip was made for the user.
    await expect(pill).toBeVisible()
    await expect(pill.locator('[data-testid="quote-ask-btn"]')).toBeVisible()
    if (painted) expect(await heldPainted(page), 'the passage is painted').toBe(true)
    await expect(chip).toHaveCount(0)
    await shot(page, 'wk-01-held-after-focus-move')

    // Writing the question keeps the hold; a keystroke also re-runs the pill's
    // evaluation, which must treat the composer's caret as "still held".
    await textarea.type('so what does')
    await expect(pill).toBeVisible()
    if (painted) expect(await heldPainted(page)).toBe(true)

    await pill.locator('[data-testid="quote-ask-btn"]').click()
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('rewrites the index')
    await expect(pill).toHaveCount(0)
    if (painted) expect(await heldPainted(page)).toBe(false)
    await expect(textarea).toHaveValue('so what does')
    await shot(page, 'wk-02-ask-made-the-chip')
    await chip.locator('.thread-anchor-chip-clear').click()
    await expect(chip).toHaveCount(0)
  })

  test('Escape lets go of a held passage', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    const pill = await selectPassage(page, panel)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(true)
    await focusComposer(page)
    await expect(pill).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pill).toHaveCount(0)
    expect(await heldPainted(page)).toBe(false)
    await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toHaveCount(0)
  })

  test('a press elsewhere in the timeline lets go; a press into the composer or on the mic does not', async ({ page }) => {
    test.setTimeout(120_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    const textarea = panel.locator('.chat-input-textarea').first()
    const pill = await selectPassage(page, panel)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(true)
    await focusComposer(page)
    await expect(pill).toBeVisible()

    // Into the composer: writing. The document selection is already collapsed, so the
    // instant-clear guard has nothing to do; the pill's own pointerdown rule decides.
    await textarea.click()
    await expect(pill).toBeVisible()
    // On the mic: acting on the passage. Without a microphone the recording never
    // starts, and whatever the mic does about that must not take the held pill.
    const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
    const micBox = (await mic.boundingBox())!
    await page.mouse.move(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(150)
    await expect(pill).toBeVisible()
    await page.mouse.up()
    await page.waitForTimeout(600)
    await expect(pill).toBeVisible()
    await shot(page, 'wk-03-held-through-composer-and-mic-presses')

    // Elsewhere in the timeline: moving on. A press on prose the passage is not part
    // of, where before the hold the guard would have cleared the selection.
    const other = panel.locator('.session-msg-content', { hasText: 'The migration runs in three phases' }).last()
    const box = (await other.boundingBox())!
    await page.mouse.click(box.x + 4, box.y + 4)
    await expect(pill).toHaveCount(0)
    expect(await heldPainted(page)).toBe(false)
  })

  test('a new selection ends the hold and the pill follows it', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    await selectPassage(page, panel)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(true)
    await focusComposer(page)
    const pill = await selectPassage(page, panel, PHRASE2)
    await expect(pill).toBeVisible()
    // The hold is over: the pill is on the LIVE selection again, and the held paint is gone.
    expect(await heldPainted(page)).toBe(false)
    expect(await selectedText(page)).toBe(PHRASE2)
    await pill.locator('[data-testid="quote-ask-btn"]').click()
    const chip = panel.locator('[data-testid="thread-anchor-chip"]')
    await expect(chip).toContainText('only verifies checksums')
    await chip.locator('.thread-anchor-chip-clear').click()
  })

  test('a scroll while held moves the pill with the words, and lets go once they leave the scroller', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    const pill = await selectPassage(page, panel)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(true)
    await focusComposer(page)
    await expect(pill).toBeVisible()
    const before = (await pill.boundingBox())!

    // A short scroll: the passage is still on screen, so the pill follows it (this is
    // the held branch of the scroll handler, which has no live selection to read and
    // must use the held Range instead).
    await wheel(page, panel, -120)
    await expect.poll(async () => (await pill.boundingBox())?.y ?? before.y).not.toBe(before.y)
    await expect(pill).toBeVisible()
    expect(await heldPainted(page)).toBe(true)
    await shot(page, 'wk-04-held-pill-followed-the-scroll')

    // A long one: the words leave the scroller, and a pill pointing at words nobody
    // can see would be clamped into the viewport over the composer — so it goes, and
    // the paint with it.
    await wheel(page, panel, -1400)
    await expect(pill).toHaveCount(0)
    expect(await heldPainted(page)).toBe(false)
  })

  test('a press into ANOTHER panel\'s composer lets go: the exemption is this panel\'s only', async ({ page }) => {
    test.setTimeout(120_000)
    await stubSttStatus(page)
    await page.goto('/')
    // Two columns side by side. The second's composer is a text control too, but not
    // the one the held passage's question is being written in — a pill kept alive
    // across a press there would point at a passage from a conversation the user
    // has left.
    const other = await openSession(page, 'pw-voicesel3-session', 'pw-task-voicesel3')
    const panel = await openSession(page)
    const pill = await selectPassage(page, panel)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(true)
    await focusComposer(page)
    await expect(pill).toBeVisible()
    // This panel's composer keeps it…
    await panel.locator('.chat-input-textarea').first().click()
    await expect(pill).toBeVisible()
    // …the other panel's does not.
    await other.locator('.chat-input-textarea').first().click()
    await expect(pill).toHaveCount(0)
    expect(await heldPainted(page)).toBe(false)
  })

  test('with nothing selected on screen there is nothing to hold: the request is declined', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    await page.goto('/')
    const panel = await openSession(page)
    // Nothing selected at all.
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(false)
    expect(await heldPainted(page)).toBe(false)
    // Selected, but scrolled out of sight: the pill dismissed itself, so no hold —
    // a passage the reader scrolled away from is not carried anywhere.
    const pill = await selectPassage(page, panel, PHRASE)
    await wheel(page, panel, -1400)
    await expect(pill).toHaveCount(0)
    expect(await selectedText(page), 'still selected, just out of sight').toBe(PHRASE)
    expect(await requestHoldFromPage(page, SESSION_ID)).toBe(false)
    expect(await heldPainted(page)).toBe(false)
  })
})
