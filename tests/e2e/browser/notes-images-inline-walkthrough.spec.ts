/**
 * A paced walkthrough of notes images, recorded as a video, for showing the
 * change in macOS WebKit (the Mac app's engine):
 *   walnut-dev webkit tests/e2e/browser/notes-images-inline-walkthrough.spec.ts
 * The checks live in notes-images-inline.spec.ts; this file only paces and
 * films the same flow, and runs only in a WebKit run (never in CI's Chromium).
 */
import { test, expect } from '@playwright/test'
import { clickCaretInto } from './prosemirror-caret'
import { api, seed, openNote, drawn, placeImage, pngOf } from './notes-images-helpers'

test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

test('image walkthrough', async ({ page }) => {
  test.skip(test.info().project.name !== 'webkit', 'a video for WebKit runs only')
  test.setTimeout(120_000)
  const { root } = await seed()
  const editor = await openNote(page, root)
  await expect.poll(() => drawn(page), { timeout: 10_000 }).toBe(5)
  await page.waitForTimeout(1500)
  const scroller = page.locator('.notes-editor-pane .notes-editor-content').first()
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

test('paste and tall zoom walkthrough', async ({ page }) => {
  test.skip(test.info().project.name !== 'webkit', 'a video for WebKit runs only')
  test.setTimeout(120_000)
  const root = `ImgPasteTall${Date.now()}`
  const note = `${root}/Trips/Plan.md`
  await api('PUT', `/api/notes-v2/content/${note}`, { content: 'seeding\n' })
  await placeImage(note, `${root}/Trips/tall.png`, [90, 90, 200], 300, 1400)
  await api('PUT', `/api/notes-v2/content/${note}`, { content: 'Paste here\n\n![tall](tall.png)\n' })
  const editor = await openNote(page, root, 'Paste here')
  await page.waitForTimeout(1200)

  // A screenshot on the clipboard, pasted into the note.
  // The line's end, by a click at its right edge: End on macOS scrolls to the
  // note's end and leaves the caret where it was.
  const line = editor.locator('p', { hasText: 'Paste here' })
  const box = (await line.boundingBox())!
  await clickCaretInto(line, { position: { x: box.width - 4, y: box.height / 2 } })
  const wrote = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      return 'ok'
    } catch (e) { return String(e) }
  }, pngOf(320, 180, [20, 180, 120]))
  if (wrote === 'ok') {
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => editor.locator('img').evaluateAll((imgs) =>
      (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth === 320).length), { timeout: 10_000 }).toBe(1)
    // Drawn where it was pasted, on screen.
    await expect(editor.locator('img.notes-wikiembed-img')).toBeInViewport()
  }
  await page.waitForTimeout(2000)

  // A tall picture: the zoom shows all of it, a click fills the width, the wheel scrolls.
  const pic = editor.locator('img[alt="tall"]')
  await pic.scrollIntoViewIfNeeded()
  await page.waitForTimeout(900)
  await pic.dblclick()
  await page.waitForTimeout(1800)
  await page.locator('.lightbox-image').click()
  await page.waitForTimeout(1500)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(500) }
  await page.waitForTimeout(800)
  await page.locator('.lightbox-image').click()
  await page.waitForTimeout(1200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
})
