/**
 * A take has no time limit, and never stops silently.
 *
 * 2026-11-20, the user's mock interview in the Mac app: the live text froze at 5
 * minutes (the draft stopped decoding a recorder that long, saying so only in the
 * log), and at 11 minutes the app recycled the page under the recording, so the
 * take was gone. These scenarios hold the whole path on a synthetic mic (a steady
 * tone, never played):
 *  - the live text keeps growing through several draft-recorder lanes, and the
 *    stop sends the whole clip as raw bytes, whatever its length;
 *  - while a take records, the page reports unsaved work, so no reload or page
 *    recycle runs over it;
 *  - a live text that does stop says so on screen, and the recording goes on.
 *
 * STT_LONG_TAKE_S sets the take's length (default 75 s with 20 s lanes, so three
 * lane moves show); with 660 or more it runs at the real lane length, the
 * ten-minute acceptance run. Registered by stt-long-take.spec.ts and its .webkit twin.
 */
import { expect, test, type Page } from '@playwright/test'
import { openComposer, useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const TAKE_S = Number(process.env.STT_LONG_TAKE_S ?? 75)
const SHORT_LANES = TAKE_S < 660

interface Engine { drafts: number; finals: Array<{ type: string; url: string }>; failDrafts: boolean }

async function stubEngine(page: Page): Promise<Engine> {
  const engine: Engine = { drafts: 0, finals: [], failDrafts: false }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route('**/api/stt/draft', async (route) => {
    if (engine.failDrafts) {
      await route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'Draft audio too large' }) })
      return
    }
    // Every answer is a new word, so committed segments make the text grow.
    engine.drafts++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `word${engine.drafts}`, durationMs: 20 }) })
  })
  await page.route('**/api/stt/transcribe**', async (route) => {
    const req = route.request()
    engine.finals.push({ type: req.headers()['content-type'] ?? '', url: req.url() })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'the whole take', durationMs: 50, recordingId: 'rec-long-1' }) })
  })
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-long-2"}' }))
  return engine
}

export function registerLongTakeScenarios(): void {
  test(`a ${TAKE_S} s take keeps its live text moving to the end, and the stop sends the whole clip`, async ({ page }) => {
    test.setTimeout((TAKE_S + 150) * 1000)
    const moves: string[] = []
    page.on('console', (m) => { if (m.text().includes('moved onto a fresh draft recorder')) moves.push(m.text()) })
    if (SHORT_LANES) await page.addInitScript(() => { Object.assign(window, { __walnutSttLaneMaxMs: 20_000 }) })
    // The clip the stop sends, kept in the page: its length is checked by decoding it there.
    await page.addInitScript(() => {
      const f = window.fetch
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/api/stt/transcribe') && init?.body instanceof Blob) Object.assign(window, { __sttFinalClip: init.body })
        return f.call(this, input, init)
      } as typeof window.fetch
    })
    await useSyntheticMic(page)
    const engine = await stubEngine(page)
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    // While it records the page holds unsaved work: a reload or a recycle waits.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __walnutDesktop?: { hasUnsavedWork(s: string): boolean } }).__walnutDesktop?.hasUnsavedWork('reload')), { timeout: 10_000 }).toBe(true)

    // The text must grow in every stretch of the take, the last one included.
    const stepMs = 15_000
    let last = ''
    const startedAt = Date.now()
    while (Date.now() - startedAt < TAKE_S * 1000) {
      await page.waitForTimeout(stepMs)
      const now = await d.textarea.inputValue()
      const at = Math.round((Date.now() - startedAt) / 1000)
      console.log(`[stt-long-take] ${at} s: ${now.length} chars, ${moves.length} lane moves, ${engine.drafts} drafts`)
      expect(now.length, `the live text grew between ${at - stepMs / 1000} s and ${at} s`).toBeGreaterThan(last.length)
      await expect(page.locator('.mic-draft-notice')).toHaveCount(0)
      last = now
    }
    expect(moves.length, 'the draft moved onto fresh recorders').toBeGreaterThanOrEqual(SHORT_LANES ? 2 : 1)

    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue('the whole take', { timeout: 30_000 })
    // One whole clip, as raw bytes: no base64 JSON with a size cap a take reaches.
    expect(engine.finals).toHaveLength(1)
    expect(engine.finals[0]!.type).toContain('application/octet-stream')
    expect(engine.finals[0]!.url).toContain('format=')
    // The whole take is in it, start to end, while draft recorders came and went.
    const clipSeconds = await page.evaluate(async () => {
      const clip = (window as unknown as { __sttFinalClip?: Blob }).__sttFinalClip
      if (!clip) return -1
      const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext
      const audio = await new Ctx(1, 1, 16000).decodeAudioData(await clip.arrayBuffer())
      return audio.duration
    })
    console.log(`[stt-long-take] the stop sent ${clipSeconds.toFixed(1)} s of audio for a ${TAKE_S} s take`)
    expect(clipSeconds).toBeGreaterThan(TAKE_S - 3)
    // Delivered: nothing is held any more.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __walnutDesktop?: { hasUnsavedWork(s: string): boolean } }).__walnutDesktop?.hasUnsavedWork('reload'))).toBe(false)
  })

  test('a live text that stops says so where the user looks, and the take records on', async ({ page }) => {
    test.setTimeout(90_000)
    await useSyntheticMic(page)
    const engine = await stubEngine(page)
    engine.failDrafts = true
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    const notice = page.locator('.mic-draft-notice')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('Live text paused')
    await expect(notice).toContainText('Still recording')
    await expect(d.mic).toHaveClass(/mic-recording/)

    engine.failDrafts = false
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue('the whole take', { timeout: 30_000 })
    await expect(notice).toHaveCount(0)
  })
}
