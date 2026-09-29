/**
 * Shared by stt-failure-recovery.spec.ts (Chromium) and
 * stt-failure-recovery.webkit.spec.ts (the Mac app's engine). A WebKit pin is
 * only legal at a spec file's top level, so the scenarios live here.
 *
 * The microphone is SYNTHETIC in both engines: getUserMedia returns a steady
 * oscillator. That makes the stop deterministic (speech right up to the end,
 * so a stop always hands over the draft and then runs the final pass), and it
 * lets WebKit record at all (it has no fake capture device). Everything after
 * the stream is the real app: MediaRecorder, the PCM side capture, the draft
 * loop, the insert into the composer, the error bubble, Retry.
 *
 * Only the engine is canned. The routes answer from a `lane` state the test
 * flips at the moment that matters: previews succeed while recording, the
 * stop's final pass fails, and the retry succeeds.
 */
import { expect, test, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { openSession, stubSttStatus } from './voice-selection-helpers'

export const SHOTS = '/tmp/stt-failure-recovery/shots'
/** What the live preview shows while recording. */
export const DRAFTED = 'why does phase'
/** What the engine hears in the whole clip: more than the preview had. */
export const FULL = 'why does phase two matter so much'

export async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

/** Page console lines about the mic, printed when a recording never starts. */
const micLogs = new WeakMap<Page, string[]>()

export async function useSyntheticMic(page: Page): Promise<void> {
  const lines: string[] = []
  micLogs.set(page, lines)
  page.on('console', (m) => { if (/synthetic-mic|\[stt\]|stt/i.test(m.text())) lines.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`))
  await page.addInitScript(() => {
    const fake = async (): Promise<MediaStream> => {
      console.log('[synthetic-mic] getUserMedia called')
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      // Never hang the recorder on a context that will not resume.
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
      console.log(`[synthetic-mic] context ${ctx.state}`)
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gain = ctx.createGain()
      gain.gain.value = 0.3
      const dst = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dst)
      osc.start()
      console.log('[synthetic-mic] stream ready')
      return dst.stream
    }
    // On the prototype as well as the instance: WebKit kept answering with the
    // native method after an instance-only patch in the app page.
    if (typeof MediaDevices !== 'undefined') {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fake, configurable: true, writable: true })
    }
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true, writable: true });
    (window as unknown as { __syntheticMic?: boolean }).__syntheticMic = true
  })
}

export interface EngineLane {
  /** 'previewing': drafts answer DRAFTED; 'failing': every pass 500s; 'recovered': passes answer FULL. */
  phase: 'previewing' | 'failing' | 'recovered'
  /** Preview text while previewing ('' = the engine hears nothing yet). */
  previewText: string
  saves: Array<{ text: string; error?: string }>
  finalPosts: string[]
}

/** Canned engine on every STT route the dictation touches. */
export async function stubEngine(page: Page, previewText = DRAFTED): Promise<EngineLane> {
  const lane: EngineLane = { phase: 'previewing', previewText, saves: [], finalPosts: [] }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route('**/api/stt/draft', async (route) => {
    if (lane.phase === 'failing') {
      lane.finalPosts.push('draft')
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fetch failed' }) })
      return
    }
    const text = lane.phase === 'recovered' ? FULL : lane.previewText
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, durationMs: 40 }) })
  })
  await page.route('**/api/stt/transcribe', async (route) => {
    lane.finalPosts.push('transcribe')
    if (lane.phase !== 'recovered') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fetch failed' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: FULL, durationMs: 60 }) })
  })
  await page.route('**/api/stt/save', async (route) => {
    const body = route.request().postDataJSON() as { text: string; error?: string }
    lane.saves.push({ text: body.text, ...(body.error ? { error: body.error } : {}) })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recordingId: 'rec-e2e-1', debugAudioPath: '/tmp/rec-e2e-1.webm' }) })
  })
  // The voice history lists what /save stored, the way the server would.
  await page.route((url) => url.pathname === '/api/stt/recordings', async (route) => {
    const recordings = lane.saves.map((s, i) => ({
      id: `rec-e2e-${i + 1}`,
      timestamp: new Date().toISOString(),
      format: 'webm',
      language: 'auto',
      audioSizeBytes: 1000,
      engine: 'mlx',
      ...(s.text || !s.error ? { result: { text: s.text, durationMs: 0 } } : {}),
      ...(s.error ? { error: s.error } : {}),
    })).reverse()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recordings }) })
  })
  await page.route('**/api/stt/recordings/rec-e2e-1/transcribe', async (route) => {
    lane.finalPosts.push('retranscribe')
    if (lane.phase !== 'recovered') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fetch failed' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: FULL, durationMs: 60, recordingId: 'rec-e2e-1' }) })
  })
  return lane
}

export interface Dictation { panel: Locator; mic: Locator; textarea: Locator; bubble: Locator }

/** The bubble stays up while the user edits, so it must sit above the text box, not on it. */
export async function expectBubbleClearOfTextBox(d: Dictation): Promise<void> {
  const box = (await d.panel.locator('.chat-input-box').first().boundingBox())!
  await expect.poll(async () => {
    const b = (await d.bubble.boundingBox())!
    return b.y + b.height <= box.y
  }).toBe(true)
}

export async function openComposer(page: Page): Promise<Dictation> {
  await page.goto('/')
  const panel = await openSession(page)
  return {
    panel,
    mic: panel.locator('.mic-btn-wrapper .mic-btn').first(),
    textarea: panel.locator('.chat-input-textarea').first(),
    bubble: panel.locator('.mic-error-bubble').first(),
  }
}

/** Start recording and wait until at least one live preview is in the box. */
export async function recordUntilPreview(page: Page, d: Dictation, expectPreview = true): Promise<void> {
  await d.mic.click()
  try {
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  } catch (err) {
    console.log(`[stt-failure-e2e] recording never started; mic console:\n${(micLogs.get(page) ?? []).join('\n')}`)
    throw err
  }
  if (expectPreview) await expect(d.textarea).toHaveValue(DRAFTED, { timeout: 15_000 })
  else await page.waitForTimeout(4500)
}

/** Stop with the engine failing, and wait for the error bubble. */
export async function stopIntoFailure(d: Dictation, lane: EngineLane): Promise<void> {
  lane.phase = 'failing'
  await d.mic.click()
  await expect(d.bubble).toBeVisible({ timeout: 20_000 })
}

/**
 * The scenarios, registered by each engine's spec file.
 *
 * Reported 2026-09-28 ("after fail, it can't retry, something just gone"): the
 * stop's final pass failed after the live draft was already in the box, the
 * error was swallowed because a draft existed, and the end of the dictation
 * was gone with no Retry and no history row.
 */
export function registerSttFailureScenarios(): void {
  test('a final pass that fails after the draft landed says so, keeps the clip, and Retry swaps in the complete words', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const d = await openComposer(page)

    await recordUntilPreview(page, d)
    await stopIntoFailure(d, lane)
    await shot(page, 'partial-01-failed')

    // The words the user watched appear stay, and the bubble says they are not all of it.
    await expect(d.textarea).toHaveValue(DRAFTED)
    await expect(d.bubble).toContainText('Only part was transcribed')
    await expect(d.bubble).toContainText('The transcription engine stopped responding')
    await expect(d.bubble).not.toContainText('fetch failed')
    // Sized to the message, not squeezed into the mic's width one word per line.
    expect((await d.bubble.boundingBox())!.width).toBeGreaterThan(240)
    await expectBubbleClearOfTextBox(d)
    const retry = d.bubble.getByRole('button', { name: 'Retry' })
    await expect(retry).toBeVisible()
    // The clip reached history with the words the user has, and why it stopped.
    await expect.poll(() => lane.saves.length).toBe(1)
    expect(lane.saves[0]).toEqual({ text: DRAFTED, error: 'The transcription engine stopped responding' })

    // The voice history (right-click on the mic) marks the row as partial.
    await d.mic.click({ button: 'right' })
    const row = d.panel.locator('.mic-retry-dropdown .mic-history-item').first()
    await expect(row).toContainText(`Partial: ${DRAFTED}`)
    // The menu opens where the bubble sits; the bubble steps aside meanwhile.
    await expect(d.bubble).toBeHidden()
    await shot(page, 'partial-01b-history')
    await d.textarea.click()
    await expect(d.panel.locator('.mic-retry-dropdown')).toBeHidden()
    await expect(d.bubble).toBeVisible()

    lane.phase = 'recovered'
    await retry.click()
    // Swapped in place: the complete words, once, not the draft plus the words.
    await expect(d.textarea).toHaveValue(FULL, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
    // Re-run from the stored recording, not re-uploaded as a new one.
    expect(lane.finalPosts.at(-1)).toBe('retranscribe')
    await shot(page, 'partial-02-retried')

    // The mic is usable again, and the next dictation starts clean.
    lane.phase = 'previewing'
    await d.textarea.fill('')
    await recordUntilPreview(page, d)
    lane.phase = 'recovered'
    await d.mic.click()
    await expect(d.textarea).toHaveValue(FULL, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
  })

  test('Retry swaps the partial words in place and keeps what the user typed after them', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const d = await openComposer(page)

    await recordUntilPreview(page, d)
    await stopIntoFailure(d, lane)
    await expect(d.textarea).toHaveValue(DRAFTED)

    // The user carries on typing after the partial words; the words themselves are untouched.
    await d.textarea.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' and more')
    await expect(d.textarea).toHaveValue(`${DRAFTED} and more`)

    lane.phase = 'recovered'
    await d.bubble.getByRole('button', { name: 'Retry' }).click()
    await expect(d.textarea).toHaveValue(`${FULL} and more`, { timeout: 20_000 })
    await shot(page, 'edited-01-swapped-kept-typing')
  })

  test('Retry after the partial words were typed over adds the complete words instead of dropping them', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const d = await openComposer(page)

    await recordUntilPreview(page, d)
    await stopIntoFailure(d, lane)
    await expect(d.textarea).toHaveValue(DRAFTED)

    // The user retypes the message themselves (what happened on 2026-09-28),
    // over several lines: the box grows and the bubble moves up with it.
    const typed = 'my own words\nsecond line\nthird line'
    await d.textarea.fill(typed)
    await d.textarea.press('End')
    await expectBubbleClearOfTextBox(d)

    lane.phase = 'recovered'
    await d.bubble.getByRole('button', { name: 'Retry' }).click()
    await expect(d.textarea).toHaveValue(`${typed} ${FULL}`, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
    await shot(page, 'edited-02-inserted')
  })

  test('a failure with no draft shown keeps the clip in history, and Retry recovers the words', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    // The engine hears nothing during the recording, so no preview ever lands.
    const lane = await stubEngine(page, '')
    const d = await openComposer(page)

    await recordUntilPreview(page, d, false)
    await expect(d.textarea).toHaveValue('')
    await stopIntoFailure(d, lane)
    await shot(page, 'nodraft-01-failed')

    await expect(d.bubble).toContainText('The transcription engine stopped responding')
    await expect(d.bubble).not.toContainText('Only part')
    await expect.poll(() => lane.saves.length).toBe(1)
    expect(lane.saves[0]).toEqual({ text: '', error: 'The transcription engine stopped responding' })

    // Dismissing the bubble does not lose the recording: the right-click
    // history keeps it (a stored row), and Retry still works from the bubble
    // until then. Here: Retry.
    lane.phase = 'recovered'
    await d.bubble.getByRole('button', { name: 'Retry' }).click()
    await expect(d.textarea).toHaveValue(FULL, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
    await shot(page, 'nodraft-02-retried')
  })

  test('a retry that fails again keeps the bubble and Retry, and the next Retry still lands the words', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const lane = await stubEngine(page)
    const d = await openComposer(page)

    await recordUntilPreview(page, d)
    await stopIntoFailure(d, lane)
    const retry = d.bubble.getByRole('button', { name: 'Retry' })

    // Still failing: the retry fails too.
    await retry.click()
    await expect(d.bubble).toBeVisible({ timeout: 20_000 })
    await expect(d.bubble).toContainText('The transcription engine stopped responding')
    await expect(d.textarea).toHaveValue(DRAFTED)
    await shot(page, 'retry-twice-01-failed-again')

    lane.phase = 'recovered'
    await d.bubble.getByRole('button', { name: 'Retry' }).click()
    await expect(d.textarea).toHaveValue(FULL, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
  })
}
