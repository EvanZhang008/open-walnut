/**
 * Put the caret into a block of a ProseMirror (TipTap) editor with a real click, and
 * wait until the EDITOR's selection is there, not only the page's.
 *
 * A click moves the page's selection at once, but ProseMirror learns of it from the
 * `selectionchange` event, which Chromium runs as a task of its own after the click's
 * input events. A key Playwright sends right after the click is input too and can be
 * handled first (measured 2026-11-02: the key landed 14 ms after mouseup, the
 * selectionchange 3 ms after that). Typed characters do not care, the browser puts
 * them at the page's caret; a key ProseMirror's keymap handles itself (Enter,
 * Backspace, Tab, Delete) acts on the selection ProseMirror still holds. So a spec's
 * Enter split the heading at the top of the note instead of the line it had clicked
 * (notes-code-fence-input, most CI runs). The same check also catches TipTap's
 * `autofocus: 'start'` timer moving the caret back to the top after the click.
 *
 * tests/scripts/browser-spec-ratchets.test.ts keeps every click followed by such a key
 * in an editor spec going through here.
 */
import { expect, type Locator } from '@playwright/test'

type ClickOptions = Parameters<Locator['click']>[0]

/** Whether the editor around `el` holds its selection inside `el` (TipTap keeps the
 *  editor on its root element as `editor`). */
function selectionInside(el: Element): boolean {
  const root = el.closest('.ProseMirror') as (HTMLElement & {
    editor?: { state: { selection: { from: number } }; view: { domAtPos(pos: number): { node: Node } } }
  }) | null
  const editor = root?.editor
  if (!editor) return false
  const { node } = editor.view.domAtPos(editor.state.selection.from)
  return el === node || el.contains(node)
}

/** Click `target` (a block inside the editor) until the editor's caret is in it. */
export async function clickCaretInto(target: Locator, options?: ClickOptions): Promise<void> {
  await expect(async () => {
    await target.click(options)
    await expect.poll(() => target.evaluate(selectionInside), { timeout: 2_000 }).toBe(true)
  }).toPass({ timeout: 15_000 })
}
