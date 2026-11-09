/**
 * Dictate to the clipboard (ClipboardMicButton beside the composer's mic).
 *
 * 2026-11-09, the user: "sometimes I don't want to say it ... the final text,
 * copy to my clipboard, can we also have that button?" Press, speak, press
 * again: the final words go to the clipboard, a "Copied" note shows, and
 * nothing is put in the box or sent.
 *
 * The microphone plays an audio FILE (a WAV the test writes and serves), fed
 * into a MediaStream and never to the speakers. The engine is canned the way
 * stt-final-whole-clip-helpers.ts cans it: drafts answer PREVIEW, the stop's
 * tail pass TAIL, the whole clip WHOLE, a slice of silence nothing. The
 * clipboard is the page's own: its write is recorded with whether the click's
 * activation was still live (Safari and the Mac app refuse a write asked for
 * after it), and the Mac app's native bridge is stood in for where a scenario
 * says so. Registered by stt-clipboard.spec.ts (Chromium) and its .webkit twin.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openComposer, shot } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'
import { clampColumn } from './composer-controls-overflow-helpers'

const PREVIEW = 'copy this for the release notes'
const TAIL = 'copy this for the release notes and send it later'
const WHOLE = 'the whole clip heard once more'
const MIC_FILE = '/__voice-test/mic.wav'

/** Ten seconds of a voiced 16 kHz tone (the file loops), loud enough to count as speech. */
function micWav(): Buffer {
  const rate = 16_000
  const n = rate * 10
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const v = 0.3 * (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** getUserMedia answers with the file playing into a stream; nothing reaches an output. */
async function useFileMic(page: Page): Promise<void> {
  const wav = micWav()
  await page.route(`**${MIC_FILE}`, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }))
  await page.addInitScript((file) => {
    const fake = async (): Promise<MediaStream> => {
      const w = window as unknown as { __gum?: number }
      w.__gum = (w.__gum ?? 0) + 1
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
      const bytes = await (await fetch(file)).arrayBuffer()
      const buffer = await ctx.decodeAudioData(bytes)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      const gain = ctx.createGain()
      const dst = ctx.createMediaStreamDestination()
      src.connect(gain).connect(dst)
      src.start()
      // A test falls silent (a pause before the stop) through this node.
      Object.assign(window, { __syntheticMicGain: gain })
      console.log('[file-mic] stream ready')
      return dst.stream
    }
    if (typeof MediaDevices !== 'undefined') {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fake, configurable: true, writable: true })
    }
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true, writable: true })
  }, MIC_FILE)
}

interface ClipWrite { via: 'write' | 'writeText'; active: boolean | null; text: string | null; error: string | null }

/** Records every clipboard write the page asks for; `bridge` also stands in for the Mac app's. */
async function recordClipboard(page: Page, bridge = false): Promise<void> {
  await page.addInitScript((withBridge) => {
    const w = window as unknown as { __clip: ClipWrite[]; __bridge: string[] }
    w.__clip = []
    w.__bridge = []
    const active = () => (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? null
    const proto = (window as unknown as { Clipboard?: { prototype: object } }).Clipboard?.prototype
    if (proto) {
      Object.defineProperty(proto, 'write', {
        configurable: true,
        writable: true,
        value: async (items: ClipboardItem[]) => {
          const entry: ClipWrite = { via: 'write', active: active(), text: null, error: null }
          w.__clip.push(entry)
          try {
            entry.text = await (await items[0].getType('text/plain')).text()
          } catch (err) {
            entry.error = String(err)
            throw err
          }
        },
      })
      Object.defineProperty(proto, 'writeText', {
        configurable: true,
        writable: true,
        value: async (text: string) => { w.__clip.push({ via: 'writeText', active: active(), text, error: null }) },
      })
    }
    if (withBridge) {
      const wk = ((window as unknown as { webkit?: Record<string, unknown> }).webkit ??= {})
      wk.messageHandlers = { ...(wk.messageHandlers as object | undefined), walnutClipboard: { postMessage: (t: string) => w.__bridge.push(t) } }
    }
  }, bridge)
}

const clipWrites = (page: Page) => page.evaluate(() => (window as unknown as { __clip: ClipWrite[] }).__clip)
const micOpens = (page: Page) => page.evaluate(() => (window as unknown as { __gum?: number }).__gum ?? 0)
const bridgeWrites = (page: Page) => page.evaluate(() => (window as unknown as { __bridge: string[] }).__bridge)

interface Lanes {
  drafts: number
  stopped: boolean
  /** Every pass hears nothing. */
  mute: boolean
  /** Every pass after the stop fails (the engine went away mid-dictation). */
  failAfterStop: boolean
  /** The stop's tail pass answers this late (ms). */
  slowTailMs: number
}

/** Level of a base64 16-bit mono WAV. */
function wavLevel(base64: string): number {
  const bytes = Buffer.from(base64, 'base64')
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
  let sum = 0
  for (const v of samples) sum += (v / 32768) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

async function stubLanes(page: Page): Promise<Lanes> {
  const seen: Lanes = { drafts: 0, stopped: false, mute: false, failAfterStop: false, slowTailMs: 0 }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route('**/api/stt/draft', async (route) => {
    const { format, audio } = route.request().postDataJSON() as { format: string; audio: string }
    if (!seen.stopped) seen.drafts++
    if (seen.stopped && seen.failAfterStop) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test: the engine went away"}' })
      return
    }
    if (seen.stopped && format === 'wav' && seen.slowTailMs) await new Promise((r) => setTimeout(r, seen.slowTailMs))
    const silent = seen.mute || (format === 'wav' && wavLevel(audio) < 0.01)
    const text = silent ? '' : !seen.stopped ? PREVIEW : format === 'wav' ? TAIL : WHOLE
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, durationMs: 30 }) })
  })
  await page.route('**/api/stt/transcribe', (route) => seen.failAfterStop
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test: the engine went away"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: seen.mute ? '' : WHOLE, durationMs: 60 }) }))
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-clip-1"}' }))
  return seen
}

const setGain = (page: Page, value: number) => page.evaluate((v) => {
  (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = v
}, value)

async function open(page: Page, bridge = false) {
  await useFileMic(page)
  await recordClipboard(page, bridge)
  const seen = await stubLanes(page)
  const d = await openComposer(page)
  const clip: Locator = d.panel.getByTestId('clipboard-mic')
  const note = d.panel.getByTestId('clipboard-mic-note')
  const live = d.panel.getByTestId('clipboard-mic-live')
  return { seen, d, clip, note, live }
}

export function registerClipboardDictationScenarios(): void {
  test('stopping mid-sentence copies the final words, shows Copied, and puts nothing in the box', async ({ page }) => {
    test.setTimeout(150_000)
    const { seen, d, clip, note, live } = await open(page)
    for (let round = 1; round <= 2; round++) {
      seen.stopped = false
      const before = (await clipWrites(page)).length
      await clip.click()
      await expect(clip).toHaveClass(/mic-recording/, { timeout: 15_000 })
      // One recording at a time: it records in the composer mic's place.
      await expect(d.mic).toBeHidden()
      // The live words show above the button, never in the box.
      await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
      await expect(d.textarea).toHaveValue('')
      if (round === 1) await shot(page, 'clipboard-dictation-live')
      seen.stopped = true
      await clip.click()
      await expect(note).toHaveText('Copied', { timeout: 20_000 })
      const writes = (await clipWrites(page)).slice(before)
      expect(writes.length, JSON.stringify(writes)).toBe(1)
      expect(writes[0].text).toBe(TAIL)
      // Asked for inside the stop click, where Safari and the Mac app allow it.
      expect(writes[0].active).not.toBe(false)
      await expect(d.textarea).toHaveValue('')
      await expect(d.mic).toBeVisible()
      await expect(d.mic).toBeEnabled()
      if (round === 1) await shot(page, 'clipboard-dictation-copied')
      await expect(note).toBeHidden({ timeout: 5_000 })
    }
  })

  test('stopping after a pause copies the words the drafts heard', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, d, clip, note, live } = await open(page)
    await clip.click()
    await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
    await setGain(page, 0)
    await page.waitForTimeout(3000)
    const heard = seen.drafts
    await expect.poll(() => seen.drafts, { timeout: 15_000 }).toBeGreaterThanOrEqual(heard + 2)
    seen.stopped = true
    await clip.click()
    await expect(note).toHaveText('Copied', { timeout: 20_000 })
    expect((await clipWrites(page)).map((w) => w.text)).toEqual([PREVIEW])
    await expect(d.textarea).toHaveValue('')
  })

  test('in the Mac app the words go through its native clipboard', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, d, clip, note, live } = await open(page, true)
    await clip.click()
    await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
    seen.stopped = true
    await clip.click()
    await expect(note).toHaveText('Copied', { timeout: 20_000 })
    expect(await bridgeWrites(page)).toEqual([TAIL])
    expect(await clipWrites(page)).toEqual([])
    await expect(d.textarea).toHaveValue('')
  })

  test('when no words were heard nothing is copied and the note says so', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, d, clip, note } = await open(page)
    seen.mute = true
    await clip.click()
    await expect(clip).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await page.waitForTimeout(3000)
    seen.stopped = true
    await clip.click()
    await expect(note).toHaveClass(/is-error/, { timeout: 20_000 })
    await expect(note).not.toHaveText('Copied')
    expect((await clipWrites(page)).filter((w) => w.text)).toEqual([])
    await expect(d.textarea).toHaveValue('')
    await shot(page, 'clipboard-dictation-nothing-heard')
    // Dismissed, it stays gone.
    await note.getByRole('button', { name: 'Dismiss' }).click()
    await expect(note).toBeHidden()
  })

  test('while the composer\'s mic records, the clipboard mic does not start a second recording', async ({ page }) => {
    test.setTimeout(120_000)
    const { d, clip } = await open(page)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    expect(await micOpens(page)).toBe(1)
    await clip.click()
    await clip.click()
    // Long enough for a wrongly started recording to open the file mic.
    await page.waitForTimeout(2500)
    expect(await micOpens(page), 'the clipboard mic opened no second microphone').toBe(1)
    await expect(clip).not.toHaveClass(/mic-recording/)
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
  })

  test('a final pass slower than the click\'s activation still copies: the write was asked in the click', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, clip, note, live } = await open(page)
    // User activation lasts about 5 s; a write asked after the answer would come too late.
    seen.slowTailMs = 7000
    await clip.click()
    await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
    seen.stopped = true
    await clip.click()
    await expect(note).toHaveText('Copied', { timeout: 30_000 })
    const writes = await clipWrites(page)
    expect(writes.map((w) => w.text)).toEqual([TAIL])
    expect(writes[0].active, 'the write was asked while the click was live').toBe(true)
  })

  test('when the final pass fails, the words heard so far are copied and the note says it is only part', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, d, clip, note, live } = await open(page)
    await clip.click()
    await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
    seen.stopped = true
    seen.failAfterStop = true
    await clip.click()
    await expect(note).toHaveClass(/is-error/, { timeout: 30_000 })
    await expect(note).toContainText('Copied, but only part was transcribed')
    expect((await clipWrites(page)).map((w) => w.text)).toEqual([PREVIEW])
    await expect(d.textarea).toHaveValue('')
    await shot(page, 'clipboard-dictation-partial')
  })

  test('in a narrow composer the button leaves the row; the "+" menu starts it and it records in the mic\'s place', async ({ page }) => {
    test.setTimeout(120_000)
    const { seen, d, clip, note, live } = await open(page)
    await expect(clip).toBeVisible()
    await clampColumn(page, 300)
    await expect(clip).toBeHidden()
    await expect(d.mic).toBeVisible()
    await d.panel.locator('.chat-plus-btn').first().click()
    await d.panel.getByTestId('plus-dictate-clipboard').click()
    await expect(clip).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.mic).toBeHidden()
    await expect(live).toContainText(PREVIEW, { timeout: 15_000 })
    await shot(page, 'clipboard-dictation-narrow-live')
    seen.stopped = true
    await clip.click()
    await expect(note).toHaveText('Copied', { timeout: 20_000 })
    expect((await clipWrites(page)).map((w) => w.text)).toEqual([TAIL])
    await expect(d.textarea).toHaveValue('')
    // The note gone, the row is the mic's again.
    await expect(note).toBeHidden({ timeout: 5_000 })
    await expect(clip).toBeHidden()
    await expect(d.mic).toBeVisible()
    await clampColumn(page, null)
    await expect(clip).toBeVisible()
  })
}
