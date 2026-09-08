/** Shared text-selection gestures for the session/chat specs. */
import { expect, type Page } from '@playwright/test'

/** Drag-select `phrase` with a real mouse, inside `scope`, over its TEXT NODE.
 *
 *  Why a drag and not `click({clickCount: 3})`: a triple-click leaves an
 *  ELEMENT-level range (container + child offsets), so replacing that element's
 *  children re-resolves the same range against the NEW children and
 *  `toString()` reads whatever text is there now. Every "selection survived"
 *  assertion above a triple-click therefore passes even when the DOM under the
 *  selection was destroyed — which is how the React 19 innerHTML rewrite
 *  (web/src/hooks/useStableHtml.ts) hid for a whole release. A drag anchors in a
 *  TEXT NODE, which is exactly what a rewrite detaches.
 */
export async function dragPhrase(page: Page, scope: string, phrase: string): Promise<void> {
  const rects = await page.evaluate(({ scope, needle }) => {
    const root = document.querySelector(scope)
    if (!root) return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text
      const at = text.data.indexOf(needle)
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + needle.length)
      return Array.from(range.getClientRects()).map((r) => ({
        left: r.left, right: r.right, top: r.top, height: r.height,
      }))
    }
    return null
  }, { scope, needle: phrase })
  expect(rects, `phrase "${phrase}" is not rendered inside ${scope}`).not.toBeNull()
  expect(rects!.length).toBeGreaterThan(0)
  const first = rects![0]
  const last = rects![rects!.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 6 })
  await page.mouse.up()
}

/** Is the selection anchored in a TEXT node? The non-vacuity check that tells a
 *  surviving selection apart from an element-level range that merely re-resolved. */
export function selectionAnchorNodeType(page: Page): Promise<number | undefined> {
  return page.evaluate(() => window.getSelection()?.anchorNode?.nodeType)
}
