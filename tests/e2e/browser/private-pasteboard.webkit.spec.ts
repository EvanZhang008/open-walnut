/**
 * A WebKit test browser on a Mac copies and pastes on a pasteboard of its own and never writes the
 * person's clipboard (pw-pasteboard.ts; 2026-11-10: a paste spec replaced what the person had copied).
 * Reads the Mac's general pasteboard change count before and after a copy, a cut and a paste in a page;
 * elsewhere a browser's clipboard is its own already, so it skips.
 */
import { expect, test, webkit } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { PASTEBOARD_GUARDED } from './pw-pasteboard'

const SENTINEL = `private pasteboard check ${Date.now().toString(36)}`
// osascript exists only on macOS; the test skips elsewhere before it reads the pasteboard.
const general = (expr: string) => (process.platform === 'darwin' ? execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import("AppKit"); ${expr}`], { encoding: 'utf8' }).trim() : '')
const changeCount = () => Number(general('$.NSPasteboard.generalPasteboard.changeCount'))

test('copy, cut and paste in WebKit on a Mac stay off the real clipboard', async () => {
  test.skip(process.platform !== 'darwin', 'only Playwright WebKit on macOS uses the system pasteboard')
  // Never copy unless the guard is on this launch: without it the copy below lands on the person's clipboard.
  expect((webkit.launch as unknown as Record<symbol, boolean>)[PASTEBOARD_GUARDED], 'webkit.launch is not guarded (pw-silence.ts)').toBe(true)
  const before = changeCount()
  const browser = await webkit.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(`<textarea id="t">${SENTINEL}</textarea>`)
    const box = page.locator('#t')
    await box.click(); await page.keyboard.press('Meta+A'); await page.keyboard.press('Meta+C')
    await box.fill(''); await box.click(); await page.keyboard.press('Meta+V')
    await expect(box).toHaveValue(SENTINEL)
    await page.keyboard.press('Meta+A'); await page.keyboard.press('Meta+X')
    await expect(box).toHaveValue('')
    await page.keyboard.press('Meta+V')
    await expect(box).toHaveValue(SENTINEL)
  } finally {
    await browser.close()
  }
  // The person may copy something meanwhile; only our own text there is a failure.
  if (changeCount() !== before) expect(general('ObjC.unwrap($.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString)) || ""'), 'the test text reached the Mac clipboard').not.toBe(SENTINEL)
})
