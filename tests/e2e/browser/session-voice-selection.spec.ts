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
 *     engines). So the passage is carried into the durable form the app already has
 *     for it — the composer's thread anchor, the same state the pill's Ask produces
 *     — one moment before the focus moves. Red-checked the same way: without the
 *     carry-over there is no chip.
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
 * ⚠️ THE DRAFT LANE ANSWERS SLOWLY ON PURPOSE (`stubDictation`). While recording, the
 * hook posts a live preview every `DRAFT_INTERVAL_MS` (2000ms) and each preview is a
 * real write into the composer — focus moves, the selection collapses. A test that
 * records for ~1.2s only stays under that tick while the machine is idle, so the draft
 * route is answered after `DRAFT_LAG_MS`, longer than any of these recordings: a
 * preview started under load cannot land inside the window being asserted, and one that
 * arrives after the stop is dropped by the hook (it checks the recorder is still the
 * live one). So "the passage is still selected while recording" is about the press, not
 * about the clock.
 *
 * It must be a LAG and not a hang, because `/api/stt/draft` is BOTH lanes: the live
 * preview AND the stop's fast tail pass (`useSpeechToText.ts`, the `pcm` branch posts
 * `sliceWavBase64` to `draftTranscribe`). Routing it and never answering leaves the
 * composer empty forever — measured: all four dictation tests failed that way. The
 * draft's own write path is the same `writeDictation` as the final transcript, so it is
 * covered by the assertions below either way.
 */
import { expect, test, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { dragPhrase, selectionAnchorNodeType } from './selection-helpers'

/** Own fixture record (test-server.ts): this spec WRITES a thread anchor to the
 *  session, and an anchor left on a session another spec reads makes a thread rail
 *  exist where that spec expects none (they run in parallel workers). */
const SESSION_ID = 'pw-voicesel-session'
const TASK_ID = 'pw-task-voicesel'
/** The tail paragraph of the seeded transcript, inside the first render window. */
const PARAGRAPH = 'The migration runs in three phases'
/** Dragged out of the middle of that paragraph: a PASSAGE, not a whole message. */
const PHRASE = 'rewrites the index in place'
/** A SECOND passage in the same paragraph, for the tests that dictate twice. */
const PHRASE2 = 'only verifies checksums'
/** What the mocked engine "hears". */
const DICTATED = 'why does phase two matter'
/** Sentence 1 of the streamed reply the live-reply test sends, and the phrase dragged
 *  out of it. Neither string is in the seeded transcript, so a drag can only land on
 *  the LIVE block. */
const STREAM_PHRASE = 'never blocks on a slow writer'
/** Each test that SENDS a turn gets its own session: the reply it leaves behind is
 *  persisted history for the others, where a drag would land on finished text and pass
 *  for the wrong reason. */
const STREAM_SESSION_ID = 'pw-voicesel2-session'
const STREAM_TASK_ID = 'pw-task-voicesel2'
const STICKY_SESSION_ID = 'pw-voicesel3-session'
const STICKY_TASK_ID = 'pw-task-voicesel3'
const TREE_SESSION_ID = 'pw-voicesel4-session'
const TREE_TASK_ID = 'pw-task-voicesel4'
/** Words from the mock engine's reply — the one assistant row the node view shows
 *  after a branch is created, so it is what a selection there can be made of. */
const REPLY_PHRASE = 'processed your message'

const SHOTS = '/tmp/voice-select/shots'

/** A fake capture device for the dictation tests below. File-level because
 *  Playwright refuses `launchOptions` inside a describe (it would force a second
 *  worker), and harmless for the WebKit project, which skips that describe and
 *  ignores Chromium args. The microphone PERMISSION is deliberately not here:
 *  WebKit rejects that name outright ("Unknown permission: microphone") and would
 *  fail every test in the file, so it is granted per test where it is needed. */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
})

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** A configured, available engine — otherwise the mic is a link to Settings and a
 *  click NAVIGATES AWAY from the panel instead of recording. */
async function stubSttStatus(page: Page): Promise<void> {
  await page.route('**/api/stt/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ engine: 'whisper-cpp', available: true }),
  }))
}

/** Longer than any recording here, so no live preview can land mid-assertion (see the
 *  file header for why this is a lag and not a hang). */
const DRAFT_LAG_MS = 4000

/** Canned words for both engine lanes: `/transcribe` answers at once, `/draft` after a
 *  lag. Returns the requests seen on each, so a test can prove the recorder really
 *  posted audio rather than the words appearing some other way. */
async function stubDictation(page: Page): Promise<{ transcribe: string[]; draft: string[] }> {
  const seen = { transcribe: [] as string[], draft: [] as string[] }
  const body = JSON.stringify({ text: DICTATED, durationMs: 120 })
  await page.route('**/api/stt/transcribe', async (route) => {
    seen.transcribe.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
  await page.route('**/api/stt/draft', async (route) => {
    seen.draft.push(route.request().url())
    await new Promise((r) => setTimeout(r, DRAFT_LAG_MS))
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
  return seen
}

async function openSession(page: Page, sid = SESSION_ID, taskId = TASK_ID): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  // Open columns are persisted, so after a reload the panel is already there —
  // clicking the kebab row again would TOGGLE it shut.
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(sid)
    const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
    await expect(task).toBeVisible()
    // Click the row's title: the task menu has no open-session row.
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history')).toContainText(PARAGRAPH, { timeout: 20000 })
  return panel
}

/** Scroll with a REAL wheel gesture: the timeline follows the bottom, and a
 *  programmatic scrollTop write is snapped straight back to the end. */
async function wheel(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(140)
}

/** Park a row mid-timeline: under the sticky header or behind the composer its words
 *  can be neither dragged over nor pointed at. */
async function centreRow(page: Page, panel: Locator, needle = PARAGRAPH): Promise<void> {
  const history = panel.locator('.session-history')
  const row = panel.locator('.session-msg-content', { hasText: needle }).last()
  let lastTop = -1
  for (let i = 0; i < 30; i++) {
    const delta = await row.evaluate((el) => {
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

function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

/** Select a passage and prove the selection is real (anchored in a TEXT node, the
 *  thing every clear in this story destroys). */
async function selectPassage(
  page: Page,
  panel: Locator,
  phrase = PHRASE,
  sid = SESSION_ID,
): Promise<Locator> {
  await centreRow(page, panel)
  await dragPhrase(page, `.session-panel[data-session-id="${sid}"] .session-history`, phrase)
  expect(await selectedText(page)).toBe(phrase)
  expect(await selectionAnchorNodeType(page)).toBe(3)
  const pill = page.locator('[data-testid="quote-pin-pill"]')
  await expect(pill).toBeVisible()
  return pill
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

    test('dictated words land in the composer and the passage rides along as the anchor', async ({ page }) => {
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
      await mic.click()
      await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      // Speaking. The passage stays selected the whole time — this is the state the
      // report described, and the pill is still there to act on.
      await page.waitForTimeout(1200)
      expect(await selectedText(page)).toBe(PHRASE)
      await expect(pill).toBeVisible()
      await shot(page, '03-recording-with-the-passage-still-selected')

      // Stop. The transcript comes back and is written into the composer, which
      // takes focus — the moment the selection cannot survive.
      await mic.click()
      const textarea = panel.locator('.chat-input-textarea').first()
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })
      expect(
        seen.transcribe.length + seen.draft.length,
        'the recorder really posted audio (which lane depends on whether PCM capture ran)',
      ).toBeGreaterThan(0)

      // The passage is not lost: it is now the composer's anchor, named by the
      // words that were selected, and clearable with its own ×.
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('rewrites the index')
      await shot(page, '04-dictation-kept-the-passage-as-the-anchor')

      // Not a one-way door: the chip's × puts the composer back to talking to the
      // session, with the dictated text untouched.
      await chip.locator('.thread-anchor-chip-clear').click()
      await expect(chip).toHaveCount(0)
      await expect(textarea).toHaveValue(new RegExp(DICTATED))
    })

    test('dictation does not overwrite an anchor the user aimed themselves', async ({ page }) => {
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

      // Now select something else and dictate. The chip must not be rewritten
      // under them: an anchor they chose outranks one inferred from a selection.
      await selectPassage(page, panel, PHRASE2)
      const textarea = panel.locator('.chat-input-textarea').first()
      await dictate(page, panel)
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })
      await expect(chip).toBeVisible()
      expect((await chip.textContent()) ?? '').toContain('rewrites the index')
      await shot(page, '05-existing-anchor-untouched')

      // …and that deference is CONDITIONAL, not a dead branch: clear the aimed
      // anchor and the same gesture now anchors to the second passage. Without this
      // half the test above would pass just as well if dictation never anchored
      // anything at all.
      await chip.locator('.thread-anchor-chip-clear').click()
      await expect(chip).toHaveCount(0)
      await selectPassage(page, panel, PHRASE2)
      await dictate(page, panel)
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('only verifies checksums')
      await shot(page, '05b-cleared-anchor-then-dictation-anchors-again')
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

      const textarea = panel.locator('.chat-input-textarea').first()
      await dictate(page, panel)
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })
      // Words landed, no chip: dictating after scrolling away is a plain message.
      await expect(panel.locator('[data-testid="thread-anchor-chip"]')).toHaveCount(0)
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

    test('tree mode stands down: the passage is the pill\'s job there', async ({ page }) => {
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
      // which the user picked. A highlight must not quietly re-aim it; the pill's Ask
      // (the only path that can open a branch properly here) stays the way to do that.
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
      await expect(page.locator('[data-testid="quote-pin-pill"]')).toBeVisible()
      await dictate(page, panel)
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })
      const after = (await chip.count()) ? ((await chip.textContent()) ?? '') : ''
      expect(after, 'the node view keeps aiming where the user pointed it').toBe(before)
      expect(after).not.toContain(REPLY_PHRASE)
      await shot(page, '10-tree-mode-stands-down')
    })

    test('a sticky anchor left by an earlier send is replaced by the next dictation', async ({ page }) => {
      test.setTimeout(150_000)
      await page.context().grantPermissions(['microphone'])
      await stubSttStatus(page)
      await stubDictation(page)

      // Own session: this one SENDS, and a sticky anchor is what the send path
      // leaves behind.
      await page.goto('/')
      const panel = await openSession(page, STICKY_SESSION_ID, STICKY_TASK_ID)
      const textarea = panel.locator('.chat-input-textarea').first()
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')

      // Ask about passage one, send it. Linear mode then keeps the anchor STICKY so a
      // follow-up stays in the thread without re-selecting anything — and never
      // clears it, which is exactly the state that used to swallow every later
      // dictation in the session ("I select a new passage, dictate, and the chip
      // still names the old one").
      const pill = await selectPassage(page, panel, PHRASE, STICKY_SESSION_ID)
      await pill.locator('[data-testid="quote-ask-btn"]').click()
      await expect(chip).toBeVisible()
      await textarea.click()
      await textarea.fill('and what does that cost')
      await textarea.press('Enter')
      await expect(textarea).toHaveValue('')
      await expect(chip).toBeVisible()
      expect((await chip.textContent()) ?? '', 'sticky, still naming passage one').toContain('rewrites the index')

      // A second passage, dictated. The chip must follow the new selection.
      await selectPassage(page, panel, PHRASE2, STICKY_SESSION_ID)
      await dictate(page, panel)
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('only verifies checksums')
      await shot(page, '07-sticky-anchor-followed-the-new-passage')
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
      await expect(textarea).toHaveValue(new RegExp(DICTATED), { timeout: 30_000 })

      // A live block DOES carry its message id, so the passage can be anchored.
      const chip = panel.locator('[data-testid="thread-anchor-chip"]')
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('never blocks')

      // The freeze released with the selection, so the held-back deltas land and the
      // turn's later sentences appear — exactly once each (a frozen copy left beside
      // its persisted twin would show two).
      await expect(history).toContainText('flips the read path over', { timeout: 30_000 })
      await expect.poll(async () => page.evaluate(({ needle, sid }) => {
        const text = document.querySelector(`.session-panel[data-session-id="${sid}"] .session-history`)?.textContent ?? ''
        return text.split(needle).length - 1
      }, { needle: STREAM_PHRASE, sid: STREAM_SESSION_ID }), { timeout: 30_000 }).toBe(1)
      await shot(page, '06-live-reply-caught-up-after-dictation')
    })
  })
})
