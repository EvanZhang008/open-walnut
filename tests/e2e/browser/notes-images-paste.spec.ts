/**
 * A picture on the system clipboard (a screenshot, a copied image) pasted into
 * a vault note is saved beside it and drawn. 2026-11-07 review, round 7: in
 * macOS WebKit the paste carried the PNG in `files` while the editor read only
 * `items`, and nothing happened.
 */
import { test, expect } from '@playwright/test'
import { clickCaretInto } from './prosemirror-caret'
import { api, seed, openNote, pngOf } from './notes-images-helpers'

test('a picture pasted from the clipboard is saved beside the note and drawn', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { root, note } = await seed()
  const editor = await openNote(page, root)
  const embedsBefore = ((await api('GET', `/api/notes-v2/content/${note}`)).content as string).match(/!\[\[/g)?.length ?? 0

  // What the paste event itself carried (an engine with no system clipboard,
  // headless Linux WebKit, hands it nothing at all).
  await page.evaluate(() => document.addEventListener('paste', (e) => {
    (window as unknown as { pasteTypes: string[] }).pasteTypes = [...(e.clipboardData?.types ?? [])]
  }, true))
  await clickCaretInto(editor.locator('p', { hasText: 'Image forms' }))
  await page.keyboard.press('End')
  // What a screenshot tool leaves on the clipboard: a PNG and nothing else.
  const wrote = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      return 'ok'
    } catch (e) { return String(e) }
  }, pngOf(90, 60, [20, 180, 120]))
  test.skip(wrote !== 'ok', `this engine let no script put a picture on the clipboard: ${wrote}`)
  await page.keyboard.press('ControlOrMeta+v')
  const carried = await page.evaluate(() => (window as unknown as { pasteTypes?: string[] }).pasteTypes ?? [])
  test.skip(carried.length === 0, 'this engine has no system clipboard: the paste event carried nothing')

  // Saved into the note's _attachment folder as an embed, and drawn there.
  await expect.poll(async () => ((await api('GET', `/api/notes-v2/content/${note}`)).content as string).match(/!\[\[/g)?.length ?? 0, { timeout: 15_000 })
    .toBe(embedsBefore + 1)
  await expect.poll(() => editor.locator('img').evaluateAll((imgs) =>
    (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth === 90).length), { timeout: 10_000 }).toBe(1)
})
