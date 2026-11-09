/**
 * The live draft hears the recording, not the Web Audio side capture.
 *
 * 2026-11-08, the user on the Mac app: a clear sentence ("这个和它 overlap 和不
 * overlap 是没有关系") came out as "德莱和波文". The draft was built from the side
 * capture, which in WebKit gets zeros whenever its read of the mic runs ahead,
 * while the recorder kept every word. This scenario breaks the side capture on
 * purpose (every block it sees is silence, the worst case of those holes) and
 * checks that the audio each draft uploads still carries the tone the mic plays:
 * the draft reads the recorder's own audio. Registered by
 * stt-live-draft-recorder.spec.ts (Chromium) and its .webkit twin.
 */
import { expect, test, type Page } from '@playwright/test'
import { openComposer, useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const DRAFT_TEXT = 'the draft heard the tone'

/** Every block the side capture sees is silence. */
async function breakSideCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const original = Ctx.prototype.createScriptProcessor
    Ctx.prototype.createScriptProcessor = function (this: AudioContext, ...args: Parameters<AudioContext['createScriptProcessor']>) {
      const node = original.apply(this, args)
      let handler: ((e: AudioProcessingEvent) => void) | null = null
      node.onaudioprocess = (e) => {
        const zeros = new Float32Array(e.inputBuffer.length)
        handler?.({ inputBuffer: { length: zeros.length, getChannelData: () => zeros } } as unknown as AudioProcessingEvent)
      }
      Object.defineProperty(node, 'onaudioprocess', { set: (h) => { handler = h }, get: () => handler, configurable: true })
      return node
    }
  })
}

/** Root-mean-square level of a base64 16-bit mono WAV. */
function wavRms(base64: string): number {
  const bytes = Buffer.from(base64, 'base64')
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
  let sum = 0
  for (const s of samples) sum += (s / 32768) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

export function registerLiveDraftRecorderScenarios(): void {
  test('with the side capture hearing only silence, every draft uploads the recording\'s sound', async ({ page }) => {
    test.setTimeout(120_000)
    const logs: string[] = []
    page.on('console', (m) => { if (/\[stt\]/.test(m.text())) logs.push(m.text()) })
    await useSyntheticMic(page)
    await breakSideCapture(page)
    await stubSttStatus(page)
    const drafts: Array<{ format: string; rms: number }> = []
    await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
    await page.route('**/api/stt/draft', async (route) => {
      const body = route.request().postDataJSON() as { audio: string; format: string }
      drafts.push({ format: body.format, rms: body.format === 'wav' ? wavRms(body.audio) : -1 })
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 30 }) })
    })
    await page.route('**/api/stt/transcribe', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 60 }) }))
    await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-live-1"}' }))
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(DRAFT_TEXT, { timeout: 15_000 })
    await expect.poll(() => drafts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })

    // The synthetic mic plays a 220 Hz tone at 0.3: its level is about 0.2.
    // Every slice (the drafts and the stop's tail) carries the sound the side
    // capture never saw; the one webm is the whole recording, heard as a check.
    await expect.poll(() => logs.some((l) => l.includes('live text vs whole recording')), { timeout: 10_000 }).toBe(true)
    const slices = drafts.filter((x) => x.format === 'wav')
    expect(slices.length).toBeGreaterThanOrEqual(2)
    for (const slice of slices) expect(slice.rms, 'the slice carries the recording\'s sound').toBeGreaterThan(0.1)
    expect(drafts.filter((x) => x.format !== 'wav').map((x) => x.format)).toEqual(['webm'])
    expect(logs.some((l) => l.includes("live draft reads the recorder's own audio")), logs.join('\n')).toBe(true)
  })
}
