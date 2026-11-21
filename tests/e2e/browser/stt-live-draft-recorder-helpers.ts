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
    let transcribes = 0
    await page.route('**/api/stt/transcribe**', (route) => {
      transcribes++
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 60 }) })
    })
    await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-live-1"}' }))
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(DRAFT_TEXT, { timeout: 15_000 })
    await expect.poll(() => drafts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })

    // The synthetic mic plays a 220 Hz tone at 0.3: its level is about 0.2.
    // Every draft slice carries the sound the side capture never saw; the stop
    // sends the whole recording to /transcribe once, never through the drafts.
    await expect.poll(() => transcribes, { timeout: 10_000 }).toBe(1)
    const slices = drafts.filter((x) => x.format === 'wav')
    expect(slices.length).toBeGreaterThanOrEqual(2)
    for (const slice of slices) expect(slice.rms, 'the slice carries the recording\'s sound').toBeGreaterThan(0.1)
    expect(drafts.filter((x) => x.format !== 'wav').map((x) => x.format)).toEqual([])
    expect(logs.some((l) => l.includes("live draft reads the recorder's own audio")), logs.join('\n')).toBe(true)
  })

  test('the first live text comes about a second after the recorder starts, and the stop sends the clip at once', async ({ page }) => {
    // 2026-11-20, the user: "I talk and it just doesn't show anything for long
    // time ... it take super long at the end". The first draft waited for the
    // 2 s interval; this holds it near a second, and the stop's upload close
    // behind the stop, whatever the engine does with it.
    test.setTimeout(120_000)
    const sttLogs: string[] = []
    page.on('console', (m) => { if (/\[stt\]/.test(m.text())) sttLogs.push(m.text().slice(0, 160)) })
    await useSyntheticMic(page)
    await stubSttStatus(page)
    await page.addInitScript(() => {
      const marks: Record<string, number> = {}
      Object.assign(window, { __sttMarks: marks })
      const MR = window.MediaRecorder
      if (MR) {
        const start = MR.prototype.start, stop = MR.prototype.stop
        MR.prototype.start = function (this: MediaRecorder, ...a: Parameters<MediaRecorder['start']>) {
          marks.start ??= performance.now()
          const chunks: string[] = []
          Object.assign(window, { __sttChunks: chunks })
          this.addEventListener('dataavailable', (e) => chunks.push(`${Math.round(performance.now() - marks.start)}ms:${e.data.size}B`))
          return start.apply(this, a)
        }
        MR.prototype.stop = function (this: MediaRecorder) { marks.stop ??= performance.now(); return stop.apply(this) }
      }
      const f = window.fetch
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/api/stt/draft')) marks.draft ??= performance.now()
        if (url.includes('/api/stt/transcribe')) marks.transcribe ??= performance.now()
        return f.call(this, input, init)
      } as typeof window.fetch
    })
    await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
    await page.route('**/api/stt/draft', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 30 }) }))
    await page.route('**/api/stt/transcribe**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 60 }) }))
    await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-live-2"}' }))
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(DRAFT_TEXT, { timeout: 15_000 })
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sttMarks: Record<string, number> }).__sttMarks.transcribe), { timeout: 10_000 }).toBeDefined()
    const m = await page.evaluate(() => (window as unknown as { __sttMarks: Record<string, number> }).__sttMarks)
    const chunks = await page.evaluate(() => (window as unknown as { __sttChunks?: string[] }).__sttChunks ?? [])
    console.log(`[stt-latency] recorder chunks: ${chunks.slice(0, 8).join(' ')}`)
    console.log(`[stt-latency] page log: ${sttLogs.slice(0, 12).join(' | ')}`)
    const firstDraftMs = m.draft - m.start
    const stopToUploadMs = m.transcribe - m.stop
    console.log(`[stt-latency] first draft ${Math.round(firstDraftMs)} ms after start; stop to upload ${Math.round(stopToUploadMs)} ms`)
    // The first tick fires at 1150 ms; the old 2 s interval can never pass this.
    expect(firstDraftMs, 'first live draft request after the recorder starts (ms)').toBeLessThan(1800)
    expect(stopToUploadMs, 'stop to the whole-clip upload (ms)').toBeLessThan(1500)
  })

  test('a take that starts with a pause shows its first words soon after the speech starts', async ({ page }) => {
    // 2026-11-20, the user's own take began with a pause. Measured here at
    // about 0.9 s from the first sound to the first words; 2 s is the limit.
    test.setTimeout(120_000)
    await useSyntheticMic(page)
    // The mic is silent from its first sample until the test speaks.
    await page.addInitScript(() => {
      let held: GainNode | undefined
      Object.defineProperty(window, '__syntheticMicGain', {
        configurable: true,
        get: () => held,
        set: (g: GainNode) => { g.gain.value = 0; held = g },
      })
    })
    await stubSttStatus(page)
    await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
    await page.route('**/api/stt/draft', async (route) => {
      const body = route.request().postDataJSON() as { audio: string; format: string }
      // Words only for audio that holds the tone.
      const text = body.format === 'wav' && wavRms(body.audio) > 0.02 ? DRAFT_TEXT : ''
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, durationMs: 30 }) })
    })
    await page.route('**/api/stt/transcribe**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFT_TEXT, durationMs: 60 }) }))
    await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-live-3"}' }))
    const d = await openComposer(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    // 2.5 s of silence first.
    await page.waitForTimeout(2500)
    await page.evaluate(() => { (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = 0.3 })
    const spokeAt = Date.now()
    await expect(d.textarea).toHaveValue(DRAFT_TEXT, { timeout: 15_000 })
    const wordsMs = Date.now() - spokeAt
    console.log(`[stt-latency] first words ${wordsMs} ms after the speech started`)
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    expect(wordsMs, 'first words after the speech starts (ms)').toBeLessThan(2000)
  })
}

