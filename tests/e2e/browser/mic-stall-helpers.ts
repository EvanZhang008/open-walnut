/**
 * The mic warning in a real browser engine, with a synthetic mic whose level
 * the test sets. Shared by mic-stall.spec.ts (Chromium) and
 * mic-stall.webkit.spec.ts (the Mac app's engine).
 *
 * Reported 2026-10-31 on the Mac app: "while I talk it suddenly says not
 * available, and two seconds later it is available". Under heavy load WebKit's
 * audio pipeline stops delivering samples for a few seconds; the analyser reads
 * digital zeros, and the old rule called that a dead mic after 3 s. A gain of
 * exactly 0 on the synthetic mic is that stall as the analyser sees it.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { stubEngine, openComposer } from './stt-failure-helpers'

const SHOTS = '/tmp/voice-flaky/shots'

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

/** getUserMedia answers an oscillator; `window.__micGain(g)` sets its level (0 = digital zero). */
async function useControllableMic(page: Page, startGain: number): Promise<void> {
  await page.addInitScript((g0: number) => {
    const fake = async (): Promise<MediaStream> => {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gain = ctx.createGain()
      gain.gain.value = g0
      const dst = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dst)
      osc.start();
      (window as unknown as { __micGain: (g: number) => void }).__micGain = (g: number) => { gain.gain.setValueAtTime(g, ctx.currentTime) }
      return dst.stream
    }
    if (typeof MediaDevices !== 'undefined') {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fake, configurable: true, writable: true })
    }
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true, writable: true })
  }, startGain)
}

const setGain = (page: Page, g: number) => page.evaluate((v) => (window as unknown as { __micGain: (g: number) => void }).__micGain(v), g)

export function registerMicStallScenarios(): void {
  test('a few seconds of stalled audio mid-speech shows no warning and the recording carries on', async ({ page }) => {
    test.setTimeout(90_000)
    await useControllableMic(page, 0.3)
    const lane = await stubEngine(page)
    const d = await openComposer(page)
    const warning = d.panel.locator('.mic-silence-warning')

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await page.waitForTimeout(1500)
    // The stall: digital zero for 6 s, the longest the user's recordings lost.
    await setGain(page, 0)
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      await expect(warning).toHaveCount(0)
      await expect(d.mic).toHaveClass(/mic-recording/)
      await expect(d.mic).toHaveAttribute('title', 'Stop recording')
      await page.waitForTimeout(250)
    }
    await shot(page, 'stall-no-warning')
    await setGain(page, 0.3)
    await page.waitForTimeout(500)
    await expect(warning).toHaveCount(0)
    // The same click still stops it, and the words arrive.
    lane.phase = 'recovered'
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.textarea).toHaveValue(/why does phase/, { timeout: 20_000 })
  })

  test('a mic that gives nothing from the start warns, sized to its words, and the warning clears on sound', async ({ page }) => {
    test.setTimeout(90_000)
    await useControllableMic(page, 0)
    await stubEngine(page)
    const d = await openComposer(page)
    const warning = d.panel.locator('.mic-silence-warning')

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(warning).toBeVisible({ timeout: 10_000 })
    await expect(warning).toContainText('No sound from the mic')
    // Not squeezed into the mic's width one word per line (the 2026-10-31
    // screenshot). Polled: the popover scales in, so the first box is small.
    await expect.poll(async () => (await warning.boundingBox())!.width, { timeout: 3000 }).toBeGreaterThan(240)
    expect((await warning.boundingBox())!.height).toBeLessThan(60)
    await shot(page, 'dead-from-start-warning')
    await setGain(page, 0.3)
    await expect(warning).toHaveCount(0, { timeout: 3000 })
    await expect(d.mic).toHaveClass(/mic-recording/)
    await d.mic.click()
  })
}
