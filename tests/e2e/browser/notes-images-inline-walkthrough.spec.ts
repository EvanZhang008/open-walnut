/**
 * A paced walkthrough of notes images, recorded as a video, for showing the
 * change in macOS WebKit (the Mac app's engine):
 *   walnut-dev webkit tests/e2e/browser/notes-images-inline-walkthrough.spec.ts
 * The checks live in notes-images-inline.spec.ts; this file only paces and
 * films the same flow, and runs only in a WebKit run (never in CI's Chromium).
 */
import { test, expect } from '@playwright/test'
import { seed, openNote, drawn } from './notes-images-helpers'

test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } })

test('image walkthrough', async ({ page }) => {
  test.skip(test.info().project.name !== 'webkit', 'a video for WebKit runs only')
  test.setTimeout(120_000)
  const { root } = await seed()
  const editor = await openNote(page, root)
  await expect.poll(() => drawn(page), { timeout: 10_000 }).toBe(5)
  await page.waitForTimeout(1500)
  const scroller = page.locator('.notes-editor-content').first()
  for (const alt of ['bare', 'encoded', 'up']) {
    await editor.locator(`img[alt="${alt}"]`).scrollIntoViewIfNeeded()
    await page.waitForTimeout(900)
  }
  await editor.locator('img[alt="encoded"]').click()
  await page.waitForTimeout(700)
  await editor.locator('img[alt="encoded"]').click()
  await page.waitForTimeout(1800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  await editor.locator('img.notes-wikiembed-img[alt="embed.png"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(900)
  await editor.locator('img.notes-wikiembed-img[alt="embed.png"]').dblclick()
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }))
  await page.waitForTimeout(1200)
  await editor.locator('.notes-image-missing:visible').scrollIntoViewIfNeeded()
  await page.waitForTimeout(2000)
})
