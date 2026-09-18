/**
 * Voice input must not throw away the passage the user selected.
 *
 * Reported 2026-09-10: "when I select the voice to text and recognizing, the selection
 * will be deselected." Two separate things took it, and both were Walnut's own:
 *
 *  1. the MIC PRESS. `main.tsx` clears any selection a left mousedown lands outside
 *     of (it kills the macOS inactive-selection flash), and the pill went with it.
 *     Measured before the fix: 33 characters selected on mousemove, zero immediately
 *     after mousedown. Fixed at the press: `data-keep-selection` on the mic BUTTON
 *     opts out of the guard. Red-checked — with the opt-out removed the first test
 *     below fails on exactly that line;
 *  2. the TRANSCRIPT LANDING. Writing dictated words into the composer takes focus,
 *     and no fix can hold a document selection through that (measured in both
 *     engines). So one moment before the focus moves the composer asks the quote
 *     pill to HOLD: the pill keeps the passage it captured, paints it from the side
 *     (`::highlight(walnut-held-quote)`), and Pin / Ask / Copy keep working on it.
 *     Red-checked the same way: without the hold request the pill is gone.
 *
 * ⚠️ NOTHING IS INFERRED FROM THE SELECTION. From 2026-09-10 to 09-16 the landing
 * turned the selection into the composer's thread anchor ("asking about: …") instead.
 * Reported 2026-09-16 with a screenshot: the reader had dragged over one word while
 * reading, dictated a question about something else, and got a chip nobody asked for;
 * sent as-is, the turn would have been filed under that reply with the word quoted
 * above the question. The chip is the pill's Ask button's to create, and the stray-
 * word test below is that report, pinned.
 *
 * Which test runs where, and why:
 *  · the PRESS test runs in both engines, because a selection's fate around focus
 *    differs between them and the Mac app is the WebKit one. Honest scope: the mic's
 *    `preventDefault` (no focus on the press) is NOT what makes this pass — a macOS
 *    click does not focus a button in either engine, so the test is green with and
 *    without it. It pins the user-visible contract, and the focus assertion at the
 *    end is the one line that depends on that guard;
 *  · the dictation tests need a microphone, so they run in Chromium with a fake audio
 *    device and a mocked transcribe endpoint: real recorder, real insert path, canned
 *    words.
 *
 * ⚠️ THE LIVE DRAFTS ARE THE POINT, NOT NOISE TO MOCK AWAY. While recording, the hook
 * posts a preview of the words so far every `DRAFT_INTERVAL_MS` (2000ms) and writes it
 * into the composer. The first version of this spec answered that route after a 4s lag
 * so that no preview could land inside a 1.2s recording — and so it was green while
 * the user's real recordings, all longer than two seconds, lost the selection at the
 * first draft: every draft write focused the textarea. "It still deselects while I'm
 * talking" came back the same day. The draft lane now answers at once and the main
 * test speaks for long enough to take several drafts, asserting the selection, the
 * pill and the composer's focus at every one of them. That is the assertion that was
 * missing.
 *
 * `/api/stt/draft` is also the stop's fast tail pass (`useSpeechToText.ts`, the `pcm`
 * branch posts `sliceWavBase64` to `draftTranscribe`), so a test may never route it
 * without answering: that leaves the composer empty forever (measured).
 */
import { expect, test, type Page, type Locator } from '@playwright/test'
import {
  PHRASE, PHRASE2, WORD, centreRow, heldPainted, openSession, selectPassage, selectedText,
  shot, stubSttStatus, threadAnchorsOf, wheel,
} from './voice-selection-helpers'
import { dragPhrase, selectionAnchorNodeType } from './selection-helpers'

/** What the mocked engine "hears" — the final text, and the live preview of it. */
const DICTATED = 'why does phase two matter'
const DRAFTED = 'why does phase'
/** Either engine string: the stop's tail pass rides the draft route, so the final
 *  composer text can legitimately be the DRAFTED words. */
const ANY_WORDS = /why does phase/
/** Sentence 1 of the streamed reply the live-reply test sends, and the phrase dragged
 *  out of it. Neither string is in the seeded transcript, so a drag can only land on
 *  the LIVE block. */
const STREAM_PHRASE = 'never blocks on a slow writer'
/** Each test that SENDS a turn gets its own session: the reply it leaves behind is
 *  persisted history for the others, where a drag would land on finished text and pass
 *  for the wrong reason. */
const STREAM_SESSION_ID = 'pw-voicesel2-session'
const STREAM_TASK_ID = 'pw-task-voicesel2'
const SEND_SESSION_ID = 'pw-voicesel3-session'
const SEND_TASK_ID = 'pw-task-voicesel3'
const TREE_SESSION_ID = 'pw-voicesel4-session'
const TREE_TASK_ID = 'pw-task-voicesel4'
const STRAY_SESSION_ID = 'pw-voicesel5-session'
const STRAY_TASK_ID = 'pw-task-voicesel5'
/** Words from the mock engine's reply — the one assistant row the node view shows
 *  after a branch is created, so it is what a selection there can be made of. */
const REPLY_PHRASE = 'processed your message'

/** A fake capture device for the dictation tests below. File-level because
 *  Playwright refuses `launchOptions` inside a describe (it would force a second
 *  worker), and harmless for the WebKit project, which skips that describe and
 *  ignores Chromium args. The microphone PERMISSION is deliberately not here:
 *  WebKit rejects that name outright ("Unknown permission: microphone") and would
 *  fail every test in the file, so it is granted per test where it is needed. */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
})

/** Canned words for both engine lanes, answered at once. The draft lane says DRAFTED
 *  so a test can tell a live preview from the final text; the stop's tail pass rides
 *  the same route, so the final composer text may be either string — what the tests
 *  pin is WHEN each lands and what else it touched, not the words. Returns the requests
 *  seen on each lane, so a test can prove the recorder really posted audio. */
async function stubDictation(page: Page): Promise<{ transcribe: string[]; draft: string[] }> {
  const seen = { transcribe: [] as string[], draft: [] as string[] }
  await page.route('**/api/stt/transcribe', async (route) => {
    seen.transcribe.push(route.request().url())
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: DICTATED, durationMs: 120 }),
    })
  })
  await page.route('**/api/stt/draft', async (route) => {
    seen.draft.push(route.request().url())
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: DRAFTED, durationMs: 90 }),
    })
  })
  return seen
}

/** Record for a beat and stop, the way a short question is dictated. */
async function dictate(page: Page, panel: Locator): Promise<Locator> {
  const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
  await mic.click()
  await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await page.waitForTimeout(1200)
  await mic.click()
  return mic
}

test.describe('Voice input keeps the selected passage', () => {
  test('pressing the mic does not deselect the passage, in either engine', async ({ page }) => {
    test.setTimeout(90_000)
    await stubSttStatus(page)
    // No microphone is granted here, so recording may never start — the stubs exist
    // only so that if it does, nothing it posts can write into the composer.
    await stubDictation(page)
    await page.goto('/')
    const panel = await openSession(page)
    const pill = await selectPassage(page, panel)
    await shot(page, '01-passage-selected')

    // Pressed the way a HAND presses it: down, a beat, up. The bug lived in the
    // mousedown, so a `.click()` with no frame in between would still have caught
    // it — but the hold is what proves the selection is alive DURING the press,
    // which is when the guard used to have already wiped it.
    const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
    const box = (await mic.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(150)
    expect(await selectedText(page), 'the passage survived the mousedown').toBe(PHRASE)
    await page.mouse.up()

    // …and through what follows the press: the recorder starting up, the mic
    // re-rendering into its recording state, whatever the engine answers. The user
    // said "and recognizing", so the window that matters is the whole wait.
    await page.waitForTimeout(900)
    expect(await selectedText(page)).toBe(PHRASE)
    // Still a real selection over the words, not an element-level range that
    // re-resolved against replaced children.
    expect(await selectionAnchorNodeType(page)).toBe(3)
    // The pill is what the user acts on, and it is what visibly vanished before.
    await expect(pill).toBeVisible()
    await expect(pill.getByText('Copy')).toBeVisible()
    // Focus never moved onto the button. Focusing a button is what collapses a
    // selection in WebKit, so the mic declines the press's focus — on macOS a click
    // would not have given it anyway, which is why this assertion, and not the
    // selection ones, is the line that depends on that guard. That the click itself
    // still arrives is asserted in the dictation test below (it reaches the
    // recording state), where a microphone actually exists.
    const focused = await page.evaluate(() => document.activeElement?.className ?? '')
    expect(focused).not.toContain('mic-btn')
    await shot(page, '02-passage-survived-the-mic-press')
  })

  test.describe('the whole dictation, with a real recorder', () => {
    // A fake audio device is a Chromium launch flag; WebKit has no equivalent, and
    // the press half above is the part where the engines differ anyway. The flags
    // are set at FILE level (`test.use` for launchOptions in a describe is a
    // Playwright error: it would force a new worker), which is safe for the WebKit
    // project too — this describe never runs there, and WebKit ignores the args.
    test.skip(({ browserName }) => browserName !== 'chromium', 'needs a fake audio capture device')

    test('dictated words land in the composer, the pill holds the passage, and Ask is what makes the chip', async ({ page }) => {
      test.setTimeout(120_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      // The engine's answer is canned; everything before it is real (MediaRecorder
      // over the fake device, the POST, the insert into the composer).
      const seen = await stubDictation(page)

      await page.goto('/')
      const panel = await openSession(page)
      const pill = await selectPassage(page, panel)

      const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
      const textarea = panel.locator('.chat-input-textarea').first()
      await mic.click()
      await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })

      // Speaking — for long enough that several live drafts land (one every 2s).
      // THIS is the window the report was about: "while I'm talking, it deselects".
      // Each draft is a real write into the composer, and every one of them must
      // leave the selection, the pill and the page's focus exactly where they were.
      // Sampled every 250ms rather than asserted once at the end, so a single frame
      // of collapse anywhere in the recording fails the test.
      const deadline = Date.now() + 20_000
      let firstDraftAt = 0
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({
          selected: window.getSelection()?.toString() ?? '',
          active: document.activeElement?.className ?? '',
        }))
        expect(state.selected, 'the passage stayed selected while speaking').toBe(PHRASE)
        expect(state.active, 'no draft took focus').not.toContain('chat-input-textarea')
        await expect(pill).toBeVisible()
        if (!firstDraftAt && (await textarea.inputValue()).includes(DRAFTED)) firstDraftAt = Date.now()
        // Keep sampling through the NEXT draft tick as well: the first draft is the
        // fresh-dictation branch, the second is the swap-the-span branch.
        if (firstDraftAt && Date.now() - firstDraftAt > 2_600) break
        await page.waitForTimeout(250)
      }
      expect(firstDraftAt, 'a live preview landed in the box while recording').toBeGreaterThan(0)
      expect(seen.draft.length, 'live previews really posted while recording').toBeGreaterThan(0)
      // The preview is in the box the whole time, without the box owning focus.
      expect(await textarea.inputValue()).toContain(DRAFTED)
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).not.toContain('chat-input-textarea')
      await shot(page, '03-recording-with-the-passage-still-selected')

      // Stop. The final text is written into the composer, which takes focus — the
      // one moment the selection cannot survive, and the moment the caret is placed.
      await mic.click()
      await expect(mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? ''), { timeout: 10_000 })
        .toContain('chat-input-textarea')
      expect(
        seen.transcribe.length + seen.draft.length,
        'the recorder really posted audio (which lane depends on whether PCM capture ran)',
      ).toBeGreaterThan(0)

      // The passage is not lost, and it is not INFERRED either. The document selection
      // did collapse (focus took it) — but the pill is still up on the passage, the
      // words are still painted, and there is no chip: nobody pressed Ask.
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      expect(await selectedText(page), 'focus collapsed the selection, as it must').toBe('')
      await expect(pill).toBeVisible()
      await expect(pill.locator('[data-testid="quote-ask-btn"]')).toBeVisible()
      expect(await heldPainted(page), 'the held passage is painted').toBe(true)
      await expect(chip, 'a selection is not a request — no chip until Ask').toHaveCount(0)
      await shot(page, '04-dictation-landed-pill-holds-the-passage')

      // Typing into the composer is writing the question, not moving on: the pill
      // stays through it.
      await textarea.press('End')
      await textarea.type(' exactly')
      await expect(pill).toBeVisible()
      expect(await heldPainted(page)).toBe(true)

      // Ask is the request. It makes the chip, named by the words that were selected,
      // and the pill and its paint go because the chip is now the passage's mark.
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('rewrites the index')
      await expect(pill).toHaveCount(0)
      expect(await heldPainted(page)).toBe(false)
      await expect(textarea).toHaveValue(/why does phase.* exactly/)
      await shot(page, '04b-ask-made-the-chip')

      // Not a one-way door: the chip's × puts the composer back to talking to the
      // session, with the dictated text untouched.
      await chip.locator('.thread-anchor-chip-clear').click()
      await expect(chip).toHaveCount(0)
      await expect(textarea).toHaveValue(/why does phase.* exactly/)
    })

    test('a word dragged over while reading does not become the anchor: the question sends to the top level', async ({ page }) => {
      test.setTimeout(150_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      // Own session: this test SENDS.
      await page.goto('/')
      const panel = await openSession(page, STRAY_SESSION_ID, STRAY_TASK_ID)
      const textarea = panel.locator('.chat-input-textarea').first()
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      expect(await threadAnchorsOf(page, STRAY_SESSION_ID)).toEqual([])

      // The 2026-09-16 report: one word selected — a drag the reader did not think of
      // as "selecting" — then a dictated question about something else.
      const pill = await selectPassage(page, panel, WORD, STRAY_SESSION_ID)
      await dictate(page, panel)
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? ''), { timeout: 10_000 })
        .toContain('chat-input-textarea')
      // The pill holds the word (harmless, and Ask is one click away if it WAS meant)…
      await expect(pill).toBeVisible()
      // …and nothing was decided for the user.
      await expect(chip).toHaveCount(0)
      await shot(page, '11-stray-word-no-chip')

      // Enter, the way a dictated question is sent. It goes where the user was
      // talking: the top level, with nothing quoted above it, and the record keeps
      // no anchor. The pill let go on the send.
      await textarea.press('Enter')
      await expect(textarea).toHaveValue('')
      const history = panel.locator('.session-history')
      const sent = history.locator('.session-msg-user, [data-msg-role="user"]', { hasText: /why does phase/ }).last()
      await expect(sent).toBeVisible({ timeout: 30_000 })
      expect((await sent.textContent()) ?? '', 'no quoted passage above the question').not.toContain(WORD)
      await expect(pill).toHaveCount(0)
      expect(await heldPainted(page)).toBe(false)
      await expect(chip).toHaveCount(0)
      await expect.poll(() => threadAnchorsOf(page, STRAY_SESSION_ID), { timeout: 10_000 }).toEqual([])
      await shot(page, '12-stray-word-sent-at-the-top-level')
    })

    test('dictation does not touch an anchor the user aimed themselves; Ask on the held pill re-aims it', async ({ page }) => {
      test.setTimeout(150_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      await page.goto('/')
      const panel = await openSession(page)
      const pill = await selectPassage(page, panel)

      // Ask about the FIRST passage explicitly — the user's own aim.
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      await expect(chip).toBeVisible()
      expect((await chip.textContent()) ?? '').toContain('rewrites the index')

      // Now select something else and dictate. The chip must not be rewritten under
      // them — dictation decides nothing about anchors — while the pill holds the
      // second passage in case they DO want to ask about it.
      const held = await selectPassage(page, panel, PHRASE2)
      const textarea = panel.locator('.chat-input-textarea').first()
      await dictate(page, panel)
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      await expect(chip).toBeVisible()
      expect((await chip.textContent()) ?? '').toContain('rewrites the index')
      await expect(held).toBeVisible()
      await shot(page, '05-existing-anchor-untouched')

      // Re-aiming is the user's move: Ask on the held pill replaces the chip with the
      // second passage. Without this half, the test above would pass just as well if
      // the pill had simply died with the selection.
      await held.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('only verifies checksums')
      await expect(held).toHaveCount(0)
      await shot(page, '05b-ask-on-the-held-pill-re-aimed-the-chip')
    })

    test('a passage the reader scrolled away from is not adopted', async ({ page }) => {
      test.setTimeout(120_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      await page.goto('/')
      const panel = await openSession(page)
      const pill = await selectPassage(page, panel)

      // Scroll the passage clear of the timeline. The selection is still there (a
      // scroll cannot change what is selected) — this is the case a selection has no
      // timestamp for, and being on screen is the freshness test that stands in.
      await wheel(page, panel, -1400)
      await expect(pill).toHaveCount(0) // the pill dismisses itself for the same reason
      expect(await selectedText(page), 'still selected, just out of sight').toBe(PHRASE)

      // The press itself must not bring the pill back: its mouseup re-evaluates the
      // selection, and a pill hung on an off-screen passage was clamped into view
      // right over the mic, so the stop click hit the pill instead (seen in a run
      // that timed out after 120s of recording).
      const textarea = panel.locator('.chat-input-textarea').first()
      const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
      await mic.click()
      await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      await page.waitForTimeout(1200)
      await expect(pill, 'a press on the mic does not revive a pill for a passage out of sight').toHaveCount(0)
      await mic.click()
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      // Words landed, no chip, and nothing held either: there was no pill to hold, so
      // dictating after scrolling away is a plain message.
      await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toHaveCount(0)
      await expect(pill).toHaveCount(0)
      expect(await heldPainted(page)).toBe(false)
      await shot(page, '08-scrolled-away-passage-not-adopted')
    })

    test('a recording that delivers no text gives the selection back', async ({ page }) => {
      test.setTimeout(120_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      // An engine that hears nothing: the real empty-transcription path, which never
      // writes into the composer — so nothing focuses it, and nothing would collapse
      // the selection. The mic has to release it itself, because a selection left
      // inside a streaming reply freezes that reply and pauses auto-scroll.
      for (const path of ['**/api/stt/transcribe', '**/api/stt/draft']) {
        await page.route(path, (route) => route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ text: '', durationMs: 90 }),
        }))
      }

      await page.goto('/')
      const panel = await openSession(page)
      const pill = await selectPassage(page, panel)

      await dictate(page, panel)
      // The selection goes, and with it the freeze and the scroll pause. Polled: the
      // release lands when the transcribe answer does, not on the click.
      await expect.poll(() => selectedText(page), { timeout: 30_000 }).toBe('')
      await expect(pill).toHaveCount(0)
      // Nothing was inferred from a recording that produced nothing.
      await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toHaveCount(0)
      await expect(panel.locator('.chat-input-textarea').first()).toHaveValue('')
      await shot(page, '09-empty-recording-released-the-selection')
    })

    test('tree mode: dictation leaves the view\'s aim alone, and the pill holds the passage there too', async ({ page }) => {
      test.setTimeout(180_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      // Own session, and it has to EARN the node view: the Linear/Tree toggle only
      // appears once the conversation has a branch, so this test asks about a passage
      // and sends, exactly as a user would before switching views.
      await page.goto('/')
      const panel = await openSession(page, TREE_SESSION_ID, TREE_TASK_ID)
      const textarea = panel.locator('.chat-input-textarea').first()
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      const pill = await selectPassage(page, panel, PHRASE, TREE_SESSION_ID)
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await textarea.click()
      await textarea.fill('and what does that cost')
      await textarea.press('Enter')
      await expect(textarea).toHaveValue('')

      // In the node view the composer's target is DERIVED from the thread on screen,
      // which the user picked. A highlight must not quietly re-aim it (dictation never
      // re-aims anything now, in either view); the pill's Ask — the only path that can
      // open a branch properly here — stays the way to do that, and the pill holds
      // through the landing so it is still there to press.
      await panel.getByRole('button', { name: 'Tree', exact: true }).click()
      // The node view opens INSIDE the branch that was just created (it follows the
      // conversation), and it collapses the earlier turns — so the passage to select
      // here comes from the reply on screen, not from the seeded paragraph.
      const history = panel.locator('.session-history')
      await expect(history).toContainText(REPLY_PHRASE, { timeout: 20_000 })
      // Whatever the view landed on is the baseline: inside a thread the chip names
      // THAT thread, at the top level there is none. Either way dictation must not
      // change it. (Asserting "no chip" would fail for the unrelated reason that a
      // thread's own chip is correct.)
      const before = (await chip.count()) ? ((await chip.textContent()) ?? '') : ''

      await centreRow(page, panel, REPLY_PHRASE)
      await dragPhrase(page, `.session-panel[data-session-id="${TREE_SESSION_ID}"] .session-history`, REPLY_PHRASE)
      expect(await selectedText(page)).toBe(REPLY_PHRASE)
      const treePill = page.locator('[data-testid="quote-pin-pill"]')
      await expect(treePill).toBeVisible()
      await dictate(page, panel)
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      const after = (await chip.count()) ? ((await chip.textContent()) ?? '') : ''
      expect(after, 'the node view keeps aiming where the user pointed it').toBe(before)
      expect(after).not.toContain(REPLY_PHRASE)
      await expect(treePill, 'the pill holds in the node view as well').toBeVisible()
      expect(await heldPainted(page)).toBe(true)
      await shot(page, '10-tree-mode-stands-down')
    })

    test('a send consumes the chip; dictation brings none back; Ask on the held pill is what makes the next one', async ({ page }) => {
      test.setTimeout(150_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      // Own session: this one SENDS, and what the send path leaves behind is the
      // question this test asks.
      await page.goto('/')
      const panel = await openSession(page, SEND_SESSION_ID, SEND_TASK_ID)
      const textarea = panel.locator('.chat-input-textarea').first()
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')

      // Ask about passage one, send it. The send CONSUMES the chip (2026-09-18: "after
      // I ask the question I want it automatically de-selected") — until then linear
      // mode flipped it to sticky and the NEXT message went into the thread too. The
      // anchor itself was recorded: the message is filed, the composer is free.
      const pill = await selectPassage(page, panel, PHRASE, SEND_SESSION_ID)
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await textarea.click()
      await textarea.fill('and what does that cost')
      await textarea.press('Enter')
      await expect(textarea).toHaveValue('')
      await expect(chip, 'the send consumed the chip').toHaveCount(0)
      await expect.poll(async () => (await threadAnchorsOf(page, SEND_SESSION_ID)).length).toBe(1)
      // Let the reply land first: rows arriving under a drag move the words out from
      // under the mouse (a run selected from the row above down to mid-paragraph).
      await expect(panel.locator('.session-history')).toContainText(REPLY_PHRASE, { timeout: 30_000 })
      await expect(chip, 'and nothing brought it back at turn end').toHaveCount(0)

      // A second passage, dictated. A highlight is not a request: the composer stays
      // un-aimed, the held pill offers the move, and Ask is the move.
      const held = await selectPassage(page, panel, PHRASE2, SEND_SESSION_ID)
      await dictate(page, panel)
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })
      await expect(chip, 'dictation made no chip').toHaveCount(0)
      await expect(held).toBeVisible()
      await held.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toContainText('only verifies checksums')
      await shot(page, '07-chip-consumed-by-send-remade-only-by-ask')
    })

    test('a selection held inside a LIVE reply survives dictation, and the reply catches up after', async ({ page }) => {
      test.setTimeout(150_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      await page.goto('/')
      const panel = await openSession(page, STREAM_SESSION_ID, STREAM_TASK_ID)
      const history = panel.locator('.session-history')

      // The one cost of keeping the selection: a passage selected inside a
      // streaming body FREEZES that body's rendered html (useSelectionFrozen), and
      // the press used to release the freeze by wiping the selection. Now the
      // freeze lasts the whole dictation — so the thing to pin is that it RELEASES
      // and the answer catches up, rather than a message stuck mid-sentence.
      const textarea = panel.locator('.chat-input-textarea').first()
      await textarea.click()
      await textarea.fill('chunk-delay:2500 stream-partial-long-text')
      await textarea.press('Enter')
      await expect(history).toContainText(STREAM_PHRASE, { timeout: 40_000 })
      await expect(panel.locator('.session-working-indicator')).toHaveCount(1)
      await wheel(page, panel, 600) // park at the bottom, as follow-bottom does

      await dragPhrase(page, `.session-panel[data-session-id="${STREAM_SESSION_ID}"] .session-streaming-panel`, STREAM_PHRASE)
      expect(await selectedText(page)).toBe(STREAM_PHRASE)
      const pill = page.locator('[data-testid="quote-pin-pill"]')
      await expect(pill).toBeVisible()

      const mic = panel.locator('.mic-btn-wrapper .mic-btn').first()
      await mic.click()
      await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      await page.waitForTimeout(1200)
      // Still selected while the deltas keep arriving behind the freeze.
      expect(await selectedText(page)).toBe(STREAM_PHRASE)
      await expect(pill).toBeVisible()
      await mic.click()
      await expect(textarea).toHaveValue(ANY_WORDS, { timeout: 30_000 })

      // No chip — dictation does not ask. The freeze released with the selection, so
      // the held-back deltas land and the turn's later sentences appear — exactly once
      // each (a frozen copy left beside its persisted twin would show two).
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      await expect(chip).toHaveCount(0)
      await expect(history).toContainText('flips the read path over', { timeout: 30_000 })
      await expect.poll(async () => page.evaluate(({ needle, sid }) => {
        const text = document.querySelector(`.session-panel[data-session-id="${sid}"] .session-history`)?.textContent ?? ''
        return text.split(needle).length - 1
      }, { needle: STREAM_PHRASE, sid: STREAM_SESSION_ID }), { timeout: 30_000 }).toBe(1)

      // The catch-up re-rendered the body under the held Range (the live block became a
      // persisted row). The pill re-locates the passage from the quote it captured — a
      // live block DOES carry its message id — on its own, from the mutation, with no
      // keystroke or scroll to wake it: `heldPainted` is a client-rects check, so a
      // dead registered Range would read false here. Ask still works on it.
      await expect(pill).toBeVisible()
      await expect.poll(() => heldPainted(page), { timeout: 5_000 }).toBe(true)
      // …and the pill sits where the words are now, not where they were.
      const pillBox = (await pill.boundingBox())!
      const passageBox = await page.evaluate(() => {
        const entry = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get('walnut-held-quote')
        const r = entry ? [...entry][0]?.getBoundingClientRect() : undefined
        return r ? { top: r.top, bottom: r.bottom } : null
      })
      expect(passageBox).not.toBeNull()
      expect(Math.abs(pillBox.y + pillBox.height - passageBox!.top), 'pill hangs just above its passage').toBeLessThan(60)
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('never blocks')
      await shot(page, '06-live-reply-caught-up-after-dictation')
    })
  })
})
