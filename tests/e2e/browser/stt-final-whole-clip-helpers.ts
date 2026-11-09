/**
 * Which text a dictation ends with, and the check that hears the whole recording.
 *
 * 2026-11-08, the user: "the freaking speech to text the quality is dogshit
 * right now". The live draft was built from a Web Audio side capture that in the
 * Mac app (WebKit) heard holes the recording never had, and the final text was
 * assembled from it. Now the draft reads the recorder's own audio
 * (recorder-pcm.ts), so its pieces are the user's words and the stop only hears
 * the open tail; the whole recording is heard once more afterwards, through the
 * draft lane, as a check that logs a mismatch and never replaces the text. Where
 * the recorder's audio does not decode, the side capture is still the draft's
 * source, and then the stop transcribes the whole clip as before.
 *
 * The engine is canned: previews answer PREVIEW, the stop's tail pass TAIL, the
 * whole clip WHOLE. Synthetic mic: stt-failure-helpers.ts. Registered by
 * stt-final-whole-clip.spec.ts (Chromium) and its .webkit twin (the Mac app's engine).
 */
import { expect, test, type Page } from '@playwright/test'
import { openComposer, shot, useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const PREVIEW = 'administering this quickly'
const TAIL = 'as an administrator I think this question is not complete'
const WHOLE = 'the whole clip heard once more'

/** Level of a base64 16-bit mono WAV: a slice of silence hears no words, as a real engine. */
function wavLevel(base64: string): number {
  const bytes = Buffer.from(base64, 'base64')
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
  let sum = 0
  for (const v of samples) sum += (v / 32768) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

interface Lanes { transcribe: number; drafts: number; draftsAfterStop: string[]; stopped: boolean }

async function stubLanes(page: Page): Promise<Lanes> {
  const seen: Lanes = { transcribe: 0, drafts: 0, draftsAfterStop: [], stopped: false }
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
  await page.route('**/api/stt/transcribe', async (route) => {
    seen.transcribe++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: WHOLE, durationMs: 60 }) })
  })
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

/** Decoding works until the test flips `__sttFailDecode`, then every decode fails. */
async function decodeFailsOnCue(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Offline = window.OfflineAudioContext
    if (!Offline) return
    const real = Offline.prototype.decodeAudioData
    Offline.prototype.decodeAudioData = function (this: OfflineAudioContext, bytes: ArrayBuffer) {
      if ((window as unknown as { __sttFailDecode?: boolean }).__sttFailDecode) {
        return Promise.reject(new DOMException('test: no decode', 'EncodingError'))
      }
      return real.call(this, bytes)
    } as typeof real
  })
}

const setGain = (page: Page, value: number) => page.evaluate((v) => {
  (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = v
}, value)

export function registerWholeClipScenarios(): void {
  test('stopping mid-sentence: the box ends with the drafts plus the tail, and the whole recording only checks it', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    for (let round = 1; round <= 2; round++) {
      seen.stopped = false
      seen.draftsAfterStop = []
      await d.textarea.fill('')
      await d.mic.click()
      await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
      seen.stopped = true
      await d.mic.click()
      await expect(d.textarea).toHaveValue(TAIL, { timeout: 20_000 })
      // The check heard the whole webm once, and the text stayed the live one.
      await expect.poll(() => seen.draftsAfterStop, { timeout: 15_000 }).toEqual(['wav', 'webm'])
      await page.waitForTimeout(500)
      await expect(d.textarea).toHaveValue(TAIL)
      expect(seen.transcribe, 'no whole-clip pass replaced the text').toBe(0)
      await shot(page, `live-text-mid-sentence-${round}`)
    }
  })

  test('stopping after a pause: the drafts are the answer, checked against the whole recording', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
    // Silence long enough that the newest draft has heard every word.
    await setGain(page, 0)
    await page.waitForTimeout(3000)
    // Two more draft ticks heard the silence (the first may only commit the
    // phrase before it), so the newest preview covers the last word spoken.
    const heard = seen.drafts
    await expect.poll(() => seen.drafts, { timeout: 15_000 }).toBeGreaterThanOrEqual(heard + 2)
    seen.stopped = true
    await d.mic.click()
    await expect.poll(() => seen.draftsAfterStop, { timeout: 15_000 }).toEqual(['webm'])
    await page.waitForTimeout(500)
    await expect(d.textarea).toHaveValue(PREVIEW)
    expect(seen.transcribe).toBe(0)
    await shot(page, 'live-text-after-a-pause')
  })

  test('where the recorder\'s audio does not decode, the side capture drafts and the stop takes the whole clip', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    await breakRecorderDecode(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    for (const stop of ['mid-sentence', 'after a pause'] as const) {
      seen.stopped = false
      await d.textarea.fill('')
      await setGain(page, 0.3).catch(() => {})
      await d.mic.click()
      await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
      // Three ticks try the recorder's audio first, then the side capture drafts.
      await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 30_000 })
      if (stop === 'after a pause') {
        await setGain(page, 0)
        await page.waitForTimeout(3000)
      }
      const before = seen.transcribe
      seen.stopped = true
      await d.mic.click()
      await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
      expect(seen.transcribe, 'the stop sent the whole clip once').toBe(before + 1)
      await shot(page, `side-capture-${stop.replace(/ /g, '-')}`)
    }
  })

  test('when the recorder\'s audio stops decoding at the stop, the box ends with the whole clip, never the pieces alone', async ({ page }) => {
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    await decodeFailsOnCue(page)
    const seen = await stubLanes(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
    await page.evaluate(() => { (window as unknown as { __sttFailDecode?: boolean }).__sttFailDecode = true })
    seen.stopped = true
    await d.mic.click()
    await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
    expect(seen.transcribe, 'the stop sent the whole clip once').toBe(1)
    expect(seen.draftsAfterStop, 'no tail pass over an old timeline').toEqual([])
    await shot(page, 'recorder-decode-fails-at-stop')
  })
}
