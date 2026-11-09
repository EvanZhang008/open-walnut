/**
 * The words a dictation ends with come from the recording itself, never from
 * the live preview's pieces.
 *
 * 2026-11-08, the user: "the freaking speech to text the quality is dogshit
 * right now". The final text was assembled from the live draft: pieces of 3 to
 * 12 s cut from the raw-PCM side capture, which in the Mac app dropped words the
 * recorder kept (a 240 s take arrived with about half its words) and heard
 * short pieces worse than the whole take. Now the stop always transcribes the
 * recorder's whole clip and swaps it in for the preview.
 *
 * The engine is canned so the two lanes say different things: every preview
 * (the side capture's pieces and its tail) answers PREVIEW, the whole clip
 * answers WHOLE. Either way the user stops, the box must end with WHOLE.
 * Synthetic mic: stt-failure-helpers.ts. Registered by stt-final-whole-clip.spec.ts
 * (Chromium) and stt-final-whole-clip.webkit.spec.ts (the Mac app's engine).
 */
import { expect, test, type Page } from '@playwright/test'
import { openComposer, shot, useSyntheticMic } from './stt-failure-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const PREVIEW = 'administering this quickly'
const WHOLE = 'as an administrator I think this question is not complete'

async function stubLanes(page: Page): Promise<{ transcribe: number; draft: number }> {
  const seen = { transcribe: 0, draft: 0 }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route('**/api/stt/draft', async (route) => {
    seen.draft++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: PREVIEW, durationMs: 30 }) })
  })
  await page.route('**/api/stt/transcribe', async (route) => {
    seen.transcribe++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: WHOLE, durationMs: 60 }) })
  })
  await page.route('**/api/stt/save', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"recordingId":"rec-whole-1"}' }))
  return seen
}

export function registerWholeClipScenarios(): void {
  for (const stop of ['mid-sentence', 'after a pause'] as const) {
    test(`stopping ${stop}: the box ends with the whole clip's words, not the preview's`, async ({ page }) => {
      test.setTimeout(120_000)
      await useSyntheticMic(page)
      const seen = await stubLanes(page)
      const d = await openComposer(page)

      for (let round = 1; round <= 2; round++) {
        await d.textarea.fill('')
        await d.mic.click()
        await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
        // The live preview still shows while speaking.
        await expect(d.textarea).toHaveValue(PREVIEW, { timeout: 15_000 })
        if (stop === 'after a pause') {
          // Silence long enough that the newest preview has heard every word:
          // the stop that used to keep the preview as the result.
          await page.evaluate(() => { (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = 0 })
          await page.waitForTimeout(3000)
        }
        const before = seen.transcribe
        await d.mic.click()
        await expect(d.textarea).toHaveValue(WHOLE, { timeout: 20_000 })
        expect(seen.transcribe, 'the stop sent the whole clip once').toBe(before + 1)
        await shot(page, `whole-clip-${stop.replace(/ /g, '-')}-${round}`)
        await page.evaluate(() => { (window as unknown as { __syntheticMicGain: GainNode }).__syntheticMicGain.gain.value = 0.3 })
      }
    })
  }
}
