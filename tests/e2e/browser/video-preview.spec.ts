/**
 * Playwright browser tests for inline video playback + Download fallback.
 *
 * A reply of the chat content session (chat-content-helpers.ts) contains an .mp4
 * path. Clicking it must open the session's Files tab with a real <video> player
 * (src = the raw file URL) and a Download button, never a "Binary file, cannot
 * display" dead end.
 */
import { test, expect } from '@playwright/test'
import { openChatContent } from './chat-content-helpers'

const SCREENSHOT_DIR = 'test-results/video-preview-verify'

test.describe('video file preview in chat', () => {
  test('mp4 path renders as a clickable file link', async ({ page }) => {
    await openChatContent(page)
    const link = page.locator('a.file-link', { hasText: 'walkthrough.mp4' })
    await expect(link.first()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-link.png` })
  })

  test('clicking the mp4 link opens a playing-capable video viewer with Download', async ({ page }) => {
    const panel = await openChatContent(page)
    const link = page.locator('a.file-link', { hasText: 'walkthrough.mp4' })
    await expect(link.first()).toBeVisible({ timeout: 5000 })
    const urlBefore = page.url()
    await link.first().click()

    // The session's Files tab shows it, beside the chat (no SPA navigation)
    const overlay = panel
    await expect(panel.locator('.fv-media-preview')).toBeVisible({ timeout: 5000 })
    expect(new URL(page.url()).pathname).toBe(new URL(urlBefore).pathname)

    // A real <video controls> whose src is the raw streaming endpoint (by host and path)
    const video = overlay.locator('.fv-media-preview video')
    await expect(video).toBeVisible({ timeout: 5000 })
    const src = await video.getAttribute('src')
    expect(src).toContain('/api/file-raw/')
    expect(src).toContain('walkthrough.mp4')
    await expect(video).toHaveAttribute('controls', '')

    // Download button present, pointing at the attachment URL
    const download = overlay.locator('a.fv-download-btn')
    await expect(download).toBeVisible()
    const href = await download.getAttribute('href')
    expect(href).toContain('download=1')

    // Playback speed selector: selecting 2× applies to the media element
    const speed = overlay.locator('select.fv-speed-select')
    await expect(speed).toBeVisible()
    await speed.selectOption('2')
    await expect.poll(() =>
      video.evaluate((el) => (el as HTMLVideoElement).playbackRate),
    ).toBe(2)

    // Skip buttons: back 3s / forward 10s (asymmetric on purpose)
    const skipBtns = overlay.locator('button.fv-skip-btn')
    await expect(skipBtns).toHaveCount(2)
    await video.evaluate((el) => { (el as HTMLVideoElement).currentTime = 30 })
    await skipBtns.nth(0).click()
    await expect.poll(() =>
      video.evaluate((el) => Math.round((el as HTMLVideoElement).currentTime)),
    ).toBe(27)
    await skipBtns.nth(1).click()
    await expect.poll(() =>
      video.evaluate((el) => Math.round((el as HTMLVideoElement).currentTime)),
    ).toBe(37)

    // The endpoint really streams video bytes with Range support
    const probe = await page.request.get(src!, { headers: { Range: 'bytes=0-1' } })
    expect(probe.status()).toBe(206)
    expect(probe.headers()['content-type']).toBe('video/mp4')
    expect(probe.headers()['content-length']).toBe('2')

    await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-video-open.png` })
  })

  test('download URL serves the file as an attachment', async ({ page }) => {
    const panel = await openChatContent(page)
    const link = page.locator('a.file-link', { hasText: 'walkthrough.mp4' })
    await expect(link.first()).toBeVisible({ timeout: 5000 })
    await link.first().click()

    const download = panel.locator('a.fv-download-btn')
    await expect(download).toBeVisible({ timeout: 5000 })
    const href = (await download.getAttribute('href'))!

    const res = await page.request.get(href)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-disposition']).toContain('attachment')
    expect(res.headers()['content-disposition']).toContain('walkthrough.mp4')
    const body = await res.body()
    expect(body.length).toBeGreaterThan(2000)
  })
})
