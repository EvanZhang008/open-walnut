/**
 * Voice input pauses the music while the mic listens (src/core/stt/media-hold.ts), in Chromium.
 *
 * The user, 2026-11-20: "when the voice to text, make sure the music is paused, and
 * afterward it is restarted, default on, can be turned off". The fixture server is an
 * isolated one, so it never touches this machine's player (media-hold-runtime.ts): what
 * the page asks of it (/api/stt/media-hold) and what the server holds (its GET) are what
 * these check, through the real mic button, the stop, a cancel while the mic still opens,
 * and the switch in Settings, Voice.
 */
import { expect, test, type Page } from '@playwright/test'
import { stubEngine, openComposer, shot } from './stt-failure-helpers'
import { useSyntheticMic } from './fake-mic'

interface HoldPost { id: string; action: string; source?: string }

function watchHolds(page: Page): HoldPost[] {
  const posts: HoldPost[] = []
  page.on('request', (req) => {
    if (!req.url().includes('/api/stt/media-hold') || req.method() !== 'POST') return
    try { posts.push(JSON.parse(req.postData() ?? '{}') as HoldPost) } catch { /* not ours */ }
  })
  return posts
}

async function held(page: Page): Promise<{ active: boolean; enabled: boolean }> {
  return page.evaluate(async () => (await fetch('/api/stt/media-hold')).json())
}

/** Writes stt.pause_media (null: unset, which reads as on), merged into the stored stt section. */
async function setPauseMedia(page: Page, on: boolean | null): Promise<void> {
  await page.evaluate(async (value) => {
    const { config } = await (await fetch('/api/config')).json() as { config: { stt?: Record<string, unknown> } }
    const r = await fetch('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-walnut-config-write': 'merge' },
      body: JSON.stringify({ stt: { ...config.stt, pause_media: value } }),
    })
    if (!r.ok) throw new Error(`config write: ${r.status}`)
  }, on)
}

test.describe('the music while you dictate', () => {
  test('the mic holds the music from the press to the stop, and gives it back once', async ({ page }) => {
    test.setTimeout(90_000)
    await useSyntheticMic(page, { gain: 0.3 })
    const lane = await stubEngine(page)
    const posts = watchHolds(page)
    const d = await openComposer(page)

    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect.poll(() => posts.filter((p) => p.action === 'hold').length).toBeGreaterThanOrEqual(1)
    await expect.poll(async () => (await held(page)).active, { message: 'the server holds the music' }).toBe(true)
    await shot(page, 'media-hold-recording')

    lane.phase = 'recovered'
    await d.mic.click()
    await expect(d.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect.poll(async () => (await held(page)).active, { message: 'released at the stop' }).toBe(false)
    const ids = new Set(posts.map((p) => p.id))
    expect(ids.size, 'one hold for one take').toBe(1)
    expect(posts.filter((p) => p.action === 'release')).toHaveLength(1)
    expect(posts[0]).toMatchObject({ action: 'hold', source: 'mic' })

    // A second take is a new hold, released again.
    await d.mic.click()
    await expect(d.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect.poll(async () => (await held(page)).active).toBe(true)
    await d.mic.click()
    await expect.poll(async () => (await held(page)).active).toBe(false)
    expect(new Set(posts.map((p) => p.id)).size).toBe(2)
  })

  test('pressed again while the mic still opens: the hold is given back too', async ({ page }) => {
    test.setTimeout(60_000)
    await useSyntheticMic(page, { gain: 0.3, openDelayMs: 2_500 })
    await stubEngine(page)
    const posts = watchHolds(page)
    const d = await openComposer(page)
    await d.mic.click()
    await expect.poll(() => posts.some((p) => p.action === 'hold')).toBe(true)
    await d.mic.click() // cancel the opening
    await page.waitForTimeout(3_500)
    await expect(d.mic).not.toHaveClass(/mic-recording/)
    await expect.poll(async () => (await held(page)).active).toBe(false)
    expect(posts.filter((p) => p.action === 'release')).toHaveLength(1)
  })

  test('Settings, Voice: the switch is on by default, and off means the server holds nothing', async ({ page }) => {
    test.setTimeout(90_000)
    await useSyntheticMic(page, { gain: 0.3 })
    const lane = await stubEngine(page)
    await openComposer(page)
    await setPauseMedia(page, null)

    await page.locator('.sidebar-nav a[href^="/settings"]').click()
    await page.getByTestId('settings-nav-stt').click()
    const toggle = page.getByTestId('stt-pause-media')
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Pause music while you dictate')).toBeVisible()
    await page.getByTestId('stt-while-dictating').screenshot({ path: '/tmp/voice-flaky/shots/chromium-media-hold-switch-on.png' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/config')).json()) as { config: { stt?: { pause_media?: boolean } } }).config.stt?.pause_media)).toBe(false)
    await page.getByTestId('stt-while-dictating').screenshot({ path: '/tmp/voice-flaky/shots/chromium-media-hold-switch-off.png' })

    // Off: a take asks once, hears "off", and the server holds nothing.
    const posts = watchHolds(page)
    const again = await openComposer(page)
    await again.mic.click()
    await expect(again.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
    await expect.poll(() => posts.some((p) => p.action === 'hold')).toBe(true)
    expect((await held(page))).toMatchObject({ active: false, enabled: false })
    lane.phase = 'recovered'
    await again.mic.click()
    await expect(again.mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })

    // Back on, from the same switch.
    await page.locator('.sidebar-nav a[href^="/settings"]').click()
    await page.getByTestId('settings-nav-stt').click()
    await page.getByTestId('stt-pause-media').click()
    await expect(page.getByTestId('stt-pause-media')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await held(page)).enabled).toBe(true)
  })
})
