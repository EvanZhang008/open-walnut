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
async function useControllableMic(page: Page, startGain: number, openDelayMs = 0): Promise<void> {
  await page.addInitScript(([g0, delay]: [number, number]) => {
    const fake = async (): Promise<MediaStream> => {
      if (delay) await new Promise((r) => setTimeout(r, delay))
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
      const w = window as unknown as { __micStreams?: MediaStream[] }
      w.__micStreams = [...(w.__micStreams ?? []), dst.stream];
      (window as unknown as { __micGain: (g: number) => void }).__micGain = (g: number) => { gain.gain.setValueAtTime(g, ctx.currentTime) }
      return dst.stream
    }
    if (typeof MediaDevices !== 'undefined') {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fake, configurable: true, writable: true })
    }
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true, writable: true })
  }, [startGain, openDelayMs] as [number, number])
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
    // A mic that opens at once never shows the slow-start note.
    await expect(d.panel.locator('.mic-start-hint')).toHaveCount(0)
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

  // 2026-11-10: with AirPods the mic sent its first sound 0.9 to 1.9 s after the
  // press in 17 of 52 takes, and some recordings began mid-word: what was said
  // before then is not recorded. The button stays grey until the first sound.
  test('a headset mic that opens late: the button stays grey until the first sound, then turns red', async ({ page }) => {
    test.setTimeout(90_000)
    await useControllableMic(page, 0)
    const lane = await stubEngine(page)
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.mic).toHaveClass(/mic-starting/)
    await expect(d.mic).toHaveAttribute('title', 'Starting the microphone: speak when it turns red')
    // Really the muted grey of the theme (a missing colour variable once left it
    // black in light mode and white in dark), with a thin ring, not a thick one.
    const look = await d.mic.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--fg-muted)'
      el.parentElement!.appendChild(probe)
      const muted = getComputedStyle(probe).color
      probe.remove()
      const cs = getComputedStyle(el)
      return { muted, ring: parseFloat(cs.outlineWidth), style: cs.outlineStyle, width: el.getBoundingClientRect().width }
    })
    // The button fades its colour (a 0.15 s transition), so wait for it to settle.
    await expect.poll(async () => d.mic.evaluate((el) => getComputedStyle(el).color), { message: 'the muted grey', timeout: 3000 }).toBe(look.muted)
    expect(look.style).toBe('dashed')
    expect(look.ring, 'a thin ring').toBeLessThanOrEqual(2)
    const grey = look.muted
    await page.waitForTimeout(1200)
    await expect(d.mic).toHaveClass(/mic-starting/)
    // Slow to open: the button says in words to wait.
    const hint = page.locator('.mic-start-hint')
    await expect(hint).toHaveText('Starting the microphone: speak when it turns red')
    await shot(page, 'mic-starting-grey')
    // The headset's first sound.
    await setGain(page, 0.3)
    await expect(d.mic).not.toHaveClass(/mic-starting/, { timeout: 3000 })
    await expect(d.mic).toHaveAttribute('title', 'Stop recording')
    await expect(hint).toHaveCount(0)
    const red = await d.mic.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--error)'
      el.parentElement!.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    expect(red).not.toBe(grey)
    await expect.poll(async () => d.mic.evaluate((el) => getComputedStyle(el).color), { message: 'red once it hears', timeout: 3000 }).toBe(red)
    expect(await d.mic.evaluate((el) => el.getBoundingClientRect().width), 'the button keeps its size').toBe(look.width)
    await shot(page, 'mic-live-red')
    // A pause after that is no new start: it stays red.
    await setGain(page, 0)
    await page.waitForTimeout(1000)
    await expect(d.mic).not.toHaveClass(/mic-starting/)
    await setGain(page, 0.3)
    lane.phase = 'recovered'
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    // The next press starts grey again.
    await setGain(page, 0)
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-starting/, { timeout: 15_000 })
    await setGain(page, 0.3)
    await expect(d.mic).not.toHaveClass(/mic-starting/, { timeout: 3000 })
    await d.mic.click()
  })

  test('a mic the browser is slow to open: grey from the press, with the note, never the idle look', async ({ page }) => {
    test.setTimeout(90_000)
    await useControllableMic(page, 0.3, 1500)
    await stubEngine(page)
    const d = await openComposer(page)

    await d.mic.click()
    // Before the stream opens: not recording yet, but already the starting look.
    await expect(d.mic).toHaveClass(/mic-starting/, { timeout: 1000 })
    await expect(d.mic).not.toHaveClass(/mic-recording/)
    await expect(d.mic).toHaveAttribute('title', 'Starting the microphone: speak when it turns red')
    await expect(page.locator('.mic-start-hint')).toBeVisible({ timeout: 2000 })
    await shot(page, 'mic-opening-grey')
    // The stream opens with sound: red, the note gone.
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.mic).not.toHaveClass(/mic-starting/, { timeout: 3000 })
    await expect(page.locator('.mic-start-hint')).toHaveCount(0)
    await d.mic.click()
  })

  test('a second press while the mic is opening cancels it, and no mic stream is left open', async ({ page }) => {
    test.setTimeout(90_000)
    await useControllableMic(page, 0.3, 1500)
    await stubEngine(page)
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-starting/, { timeout: 1000 })
    await page.waitForTimeout(500)
    await d.mic.click()
    // Back to idle at once, and it never starts recording once the open finishes.
    await expect(d.mic).not.toHaveClass(/mic-starting/, { timeout: 1000 })
    await page.waitForTimeout(2000)
    await expect(d.mic).not.toHaveClass(/mic-recording/)
    await expect(page.locator('.mic-start-hint')).toHaveCount(0)
    const tracks = await page.evaluate(() =>
      ((window as unknown as { __micStreams?: MediaStream[] }).__micStreams ?? []).flatMap((s) => s.getTracks().map((t) => t.readyState)))
    expect(tracks.length, 'the browser opened the mic once').toBe(1)
    expect(tracks, 'every mic stream is closed').toEqual(['ended'])
    // The next press records normally.
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect(d.mic).not.toHaveClass(/mic-starting/, { timeout: 3000 })
    await d.mic.click()
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
