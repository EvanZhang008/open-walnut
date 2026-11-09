/**
 * The text a dictation sends is the whole recording, heard once, as the engine
 * gave it.
 *
 * 2026-11-09, the user: "every 2 second, can we just make the right way, just
 * send full, idc, just what ever we said it should send it, without modify".
 * The live drafts every 2 s still show while he speaks, as a preview; at the
 * stop the recording goes to /transcribe once, and its answer replaces the
 * preview wholesale and is what Send sends, byte for byte: no draft, tail
 * pass or join shapes it.
 *
 * The engine is canned: previews answer PREVIEW, any draft pass after the stop
 * TAIL (none must come), the whole clip WHOLE, a string with what an edit
 * would touch: a doubled space, an ellipsis, a curly quote, CJK, digits.
 * Synthetic mic: stt-failure-helpers.ts. Registered by
 * stt-final-whole-clip.spec.ts (Chromium) and its .webkit twin (the Mac app's
 * engine).
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { openComposer, shot, useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const PREVIEW = 'administering this quickly'
const TAIL = 'as an administrator I think this question is not complete'
// \u2019 curly quote, \u2026 ellipsis, \u55ef a CJK filler word, and a doubled space.
const WHOLE = 'so the p95\u2019s at 2.5 s\u2026 right?  \u55ef, OK we ship it'

/** Level of a base64 16-bit mono WAV: a slice of silence hears no words, as a real engine. */
function wavLevel(base64: string): number {
  const bytes = Buffer.from(base64, 'base64')
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
  let sum = 0
  for (const v of samples) sum += (v / 32768) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

interface Lanes {
  transcribe: number
  drafts: number
  draftsAfterStop: string[]
  stopped: boolean
  /** The whole-clip pass hears no words (and Retry's pass with it). */
  emptyWhole: boolean
}

async function stubLanes(page: Page): Promise<Lanes> {
  const seen: Lanes = { transcribe: 0, drafts: 0, draftsAfterStop: [], stopped: false, emptyWhole: false }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route('**/api/stt/draft', async (route) => {
    const { format, audio } = route.request().postDataJSON() as { format: string; audio: string }
    if (seen.stopped) seen.draftsAfterStop.push(format)
    else seen.drafts++
    // After the stop: the tail is a WAV slice, the check sends the whole webm.
    const silent = format === 'wav' && wavLevel(audio) < 0.01
    const text = silent ? '' : !seen.stopped ? PREVIEW : format === 'wav' ? TAIL : WHOLE
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, durationMs: 30 }) })
  })
  const whole = async (route: Route) => {
    seen.transcribe++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: seen.emptyWhole ? '' : WHOLE, durationMs: 60 }) })
  }
  await page.route('**/api/stt/transcribe', whole)
  // Retry re-runs the stored recording.
  await page.route('**/api/stt/recordings/*/transcribe', whole)
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-whole-1"}' }))
  return seen
}

/** The browser cannot decode the recorder's audio: the draft falls back to the side capture. */
async function breakRecorderDecode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Offline = window.OfflineAudioContext
    if (Offline) Offline.prototype.decodeAudioData = () => Promise.reject(new DOMException('test: no decode', 'EncodingError'))
  })
}

const setGain = (page: Page, value: number) => page.evaluate((v) => {
  (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = v
}, value)

/** The text of every session:send the page makes for `sid`. */
function captureSends(page: Page): string[] {
  const sent: string[] = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload) as { method?: string; payload?: { message?: string } }
      if (row.method === 'session:send') sent.push(row.payload?.message ?? '')
    } catch { /* not JSON */ }
  }))
  return sent
}

export function registerWholeClipScenarios(): void {
  test('stopping mid-sentence: the preview gives way to the whole clip, and Send sends it byte for byte', async ({ page }) => {
    test.setTimeout(150_000)
    await useSyntheticMic(page)
    const seen = await stubLanes(page)
    const sent = captureSends(page)
    const d = await openComposer(page)
    const send = d.panel.locator('.chat-send-btn-icon').first()
    for (let round = 1; round <= 2; round++) {
      seen.stopped = false
      seen.draftsAfterStop = []
      const before = seen.transcribe
      await d.textarea.fill('')
      await d.mic.click()
      await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      // The drafts show while he speaks.
      await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
      seen.stopped = true
      await d.mic.click()
      await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
      expect(seen.transcribe, 'the stop sent the whole clip once').toBe(before + 1)
      await page.waitForTimeout(800)
      expect(seen.draftsAfterStop, 'no draft or tail pass after the stop').toEqual([])
      await expect(d.textarea).toHaveValue(WHOLE)
      await shot(page, `whole-clip-mid-sentence-${round}`)
      await send.click()
      await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(round)
      expect(sent[round - 1], 'the sent text is the engine\'s whole-clip text, byte for byte').toBe(WHOLE)
    }
  })

  test('stopping after a pause: the whole clip still replaces the drafts that heard every word', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
    await setGain(page, 0)
    await page.waitForTimeout(3000)
    const heard = seen.drafts
    await expect.poll(() => seen.drafts, { timeout: 15_000 }).toBeGreaterThanOrEqual(heard + 2)
    seen.stopped = true
    await d.mic.click()
    await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
    expect(seen.transcribe).toBe(1)
    expect(seen.draftsAfterStop).toEqual([])
    await shot(page, 'whole-clip-after-a-pause')
  })

  test('where the recorder\'s audio does not decode, the side capture drafts and the stop still sends the whole clip', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    await breakRecorderDecode(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 30_000 })
    seen.stopped = true
    await d.mic.click()
    await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
    expect(seen.transcribe, 'the stop sent the whole clip once').toBe(1)
    expect(seen.draftsAfterStop).toEqual([])
    await shot(page, 'whole-clip-side-capture')
  })

  test('a whole clip that comes back with no words keeps the preview as an error, and Retry puts the whole clip in its place', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const seen = await stubLanes(page)
    const sent = captureSends(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
    seen.stopped = true
    seen.emptyWhole = true
    await d.mic.click()
    // The preview is not taken for the text: it stays, flagged, with Retry.
    await expect(d.bubble).toContainText('came back with no words', { timeout: 20_000 })
    await expect(d.textarea).toHaveValue(PREVIEW)
    expect(sent, 'nothing was sent by itself').toEqual([])
    await shot(page, 'whole-clip-empty-final')
    seen.emptyWhole = false
    await d.bubble.getByRole('button', { name: 'Retry' }).click()
    await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
    await expect(d.bubble).toBeHidden()
    await d.panel.locator('.chat-send-btn-icon').first().click()
    await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1)
    expect(sent[0]).toBe(WHOLE)
  })
}
