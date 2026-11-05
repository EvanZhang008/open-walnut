/**
 * E2E: every way a vault note names a picture draws it inline, and a click
 * opens it large.
 *
 * The reported bug (2026-11-05, "can images inside a note not be shown?"): a
 * standard markdown image with a relative path, `![](photo.png)`, drew nothing
 * in the notes editor (the plain Image node handed the browser the bare name),
 * and a percent-encoded one, `![](Untitled%201.png)`, was also 404 on the server.
 * Only `![[embeds]]` worked. Unit guard: tests/web/notes-image-forms.test.ts.
 *
 * Seeds only invented notes and generated pictures through the public API.
 */
import { test, expect } from '@playwright/test'

import { api, seed, openNote, drawn, placeImage } from './notes-images-helpers'

test('every image form in a vault note draws inline, a missing one names its file, a click zooms', async ({ page }) => {
  const { root, note } = await seed()
  const failed: string[] = []
  // This note's pictures only: the app reopens the last note first, which may
  // be another test's with a missing picture of its own.
  page.on('response', (r) => {
    const url = decodeURIComponent(r.url())
    if (url.includes('/api/notes-v2/attachment') && url.includes(`note=${note}`) && r.status() >= 400) failed.push(`${r.status()} ${url}`)
  })
  const editor = await openNote(page, root)

  // Five pictures draw: bare, percent-encoded, ../, embed, sized embed.
  await expect.poll(() => drawn(page), { timeout: 10_000 }).toBe(5)

  // The missing one is a card naming its file, not an empty gap.
  const missing = editor.locator('.notes-image-missing:visible')
  await expect(missing).toHaveCount(1)
  await expect(missing).toContainText('Image not found')
  await expect(missing).toContainText('nowhere.png')
  // The only failed requests are that one's two places (beside the note, then
  // from the vault root), each asked once, however often the note repaints.
  expect(failed.every((f) => f.includes('nowhere.png')), failed.join('\n')).toBe(true)
  expect(new Set(failed).size, failed.join('\n')).toBe(failed.length)
  expect(failed, failed.join('\n')).toHaveLength(2)

  // Obsidian's |120 sets the width.
  const sized = editor.locator('img.notes-wikiembed-img[alt="sized.png"]')
  await expect(sized).toHaveCSS('width', '120px')

  // Editing: a click selects the picture, a click on the selected one opens it
  // large; Escape closes it and leaves the caret after it. Both kinds of image.
  const big = page.locator('.lightbox-overlay img.lightbox-image')
  // Escape closes the zoom only: a popup or page listener under it never sees it.
  await page.evaluate(() => {
    const w = window as unknown as { outerEscapes: number }
    w.outerEscapes = 0
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') w.outerEscapes++ })
  })
  for (const img of [editor.locator('img[alt="encoded"]'), editor.locator('img.notes-wikiembed-img[alt="embed.png"]')]) {
    await img.click()
    await expect(page.locator('.lightbox-overlay')).toHaveCount(0)
    await img.click()
    await expect(big).toBeVisible()
    await expect.poll(() => big.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-overlay')).toHaveCount(0)
    await expect(editor.locator('.notes-picture-selected')).toHaveCount(0)
    // Focus is back in the note, so the next key types there.
    await expect(editor).toBeFocused()
  }
  expect(await page.evaluate(() => (window as unknown as { outerEscapes: number }).outerEscapes)).toBe(0)
  // Keys typed while it is open never reach the note behind it.
  await editor.locator('img[alt="encoded"]').click()
  await editor.locator('img[alt="encoded"]').click()
  await expect(big).toBeVisible()
  await page.keyboard.type('q')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Escape')
  await expect(editor.locator('img[alt="encoded"]')).toHaveCount(1)
  // A double click opens it too; so does Enter on a selected picture, which no
  // longer deletes it.
  await editor.locator('img[alt="bare"]').dblclick()
  await expect(big).toBeVisible()
  await page.locator('.lightbox-close').click()
  await editor.locator('img[alt="up"]').click()
  await page.keyboard.press('Enter')
  await expect(big).toBeVisible()
  // The zoom grows a picture smaller than the screen.
  await expect.poll(() => big.evaluate((i: HTMLImageElement) => i.getBoundingClientRect().width)).toBeGreaterThan(240)
  await page.keyboard.press('Escape')
  await expect(editor.locator('img[alt="up"]')).toHaveCount(1)
  // A missing picture opens nothing.
  await missing.click()
  await expect(page.locator('.lightbox-overlay')).toHaveCount(0)

  // Editing the note never rewrites an image path into a proxy URL.
  await editor.locator('p', { hasText: 'Image forms' }).click()
  // Chromium reports a caret move a moment after the click: let it land.
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  await page.keyboard.type(' ok')
  await expect.poll(async () => (await api('GET', `/api/notes-v2/content/${note}`)).content as string, { timeout: 15_000 })
    .toContain('Image forms ok')
  const saved = (await api('GET', `/api/notes-v2/content/${note}`)).content as string
  for (const line of ['![bare](photo.png)', '![encoded](Untitled%201.png)', '![up](../shared/map.png)', '![[embed.png]]', '![[sized.png|120]]', '![gone](nowhere.png)']) {
    expect(saved).toContain(line)
  }
  expect(saved).not.toContain('/api/')
})


test('Backspace below a picture selects it before deleting it; a click selects an embed after editing', async ({ page }) => {
  const { root, note } = await seed()
  await api('PUT', `/api/notes-v2/content/${note}`, { content: 'Image forms\n\n![bare](photo.png)\n\nBelow line\n\n![[embed.png]]\n' })
  const editor = await openNote(page, root)
  const bare = editor.locator('img[alt="bare"]')
  await expect.poll(() => bare.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)

  await editor.locator('p', { hasText: 'Below line' }).click({ position: { x: 1, y: 8 } })
  // Chromium reports a caret move a moment after the click: let it land.
  await page.waitForTimeout(300)
  await page.keyboard.press('Backspace')
  await expect(editor.locator('.notes-picture-selected img[alt="bare"]')).toHaveCount(1)
  await expect(editor.locator('p', { hasText: 'Below line' })).toHaveCount(1)
  await page.keyboard.press('Backspace')
  await expect(bare).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(bare).toHaveCount(1)

  // After typing, a click on an ![[embed]] still selects it, and a second click opens it.
  await editor.locator('p', { hasText: 'Below line' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  const embed = editor.locator('img.notes-wikiembed-img[alt="embed.png"]')
  await embed.click()
  await expect(editor.locator('.notes-picture-selected img.notes-wikiembed-img')).toHaveCount(1)
  await embed.click()
  await expect(page.locator('.lightbox-overlay')).toBeVisible()
  await expect(page.locator('.lightbox-caption')).toHaveText('embed.png')
  await page.keyboard.press('Escape')
})


test('a missing picture shows once its file is back; a cut pasted into another note names the file it drew', async ({ page }) => {
  const { root, note } = await seed()
  // `shared/map.png` is not beside the note: it draws the vault-root path.
  await api('PUT', `/api/notes-v2/content/${note}`, {
    content: `Recover\n\n![later](later.png)\n\n![rooted](${root}/shared/map.png)\n`,
  })
  const other = `${root}/Notes/Other.md`
  await api('PUT', `/api/notes-v2/content/${other}`, { content: 'Other note\n' })
  const editor = await openNote(page, root, 'Recover')
  await expect(editor.locator('.notes-image-missing:visible')).toContainText('later.png')
  const rooted = editor.locator('img[alt="rooted"]')
  await expect.poll(() => rooted.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)

  // The file comes back; a few seconds on, coming back to the page draws it.
  await placeImage(note, `${root}/Trips/later.png`, [40, 120, 160])
  await page.waitForTimeout(10_500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => editor.locator('img[alt="later"]').evaluate((i: HTMLImageElement) => !i.hidden && i.complete && i.naturalWidth > 0), { timeout: 10_000 }).toBe(true)
  await expect(editor.locator('.notes-image-missing:visible')).toHaveCount(0)

  // Cut the root-drawn picture and paste it into a note in another folder (a cut
  // runs after ProseMirror deleted the selection: the file it drew must survive).
  await rooted.click()
  await expect(editor.locator('.notes-picture-selected img[alt="rooted"]')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+x')
  await expect(rooted).toHaveCount(0)
  await page.locator(`[data-drop-folder="${root}"] .notes-tree-folder`, { hasText: 'Notes' }).click()
  await page.locator(`[data-drop-folder="${root}/Notes"] .notes-tree-file`, { hasText: 'Other' }).click()
  await expect(editor).toContainText('Other note')
  await editor.locator('p', { hasText: 'Other note' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  const pasted = editor.locator('img[alt="rooted"]')
  await expect.poll(() => pasted.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { timeout: 10_000 }).toBe(true)
  await expect.poll(async () => (await api('GET', `/api/notes-v2/content/${other}`)).content as string, { timeout: 15_000 })
    .toContain('![rooted](../shared/map.png)')
})
