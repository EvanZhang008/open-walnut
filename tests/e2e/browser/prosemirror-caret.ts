/**
 * Helpers that act on a ProseMirror (TipTap) editor the way the editor hears them: a
 * caret by click, a selection by range, a copy, and the editor's own pictures.
 *
 * clickCaretInto: put the caret into a block with a real click, and
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
import { expect, type Locator, type Page } from '@playwright/test'

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

/**
 * Select `needle` (inside one text node) in the editor `editor` and wait until the
 * EDITOR holds that selection, not only the page.
 *
 * Focus first, then the range. ProseMirror (1.42.9 on) notes the page's selection when
 * the editor gains focus and, 20 ms later, writes its OWN selection back over it when
 * the page's has not moved since; a range put in before focus() is that range, so the
 * editor kept its caret at the top of the document: ⌘C copied nothing and typed text
 * landed before the first heading (file-angle-brackets, 2026-11-15, CI on the
 * prosemirror-view 1.41.8 -> 1.42.9 bump). A range put in while the editor has focus
 * reaches it through `selectionchange`, as a person's selection does.
 *
 * tests/scripts/browser-spec-ratchets.test.ts refuses a spec that focuses an editor
 * after putting its range in.
 */
export async function selectTextInEditor(editor: Locator, needle: string): Promise<void> {
  await expect(editor).toContainText(needle)
  await editor.evaluate((root, needle) => {
    ;(root as HTMLElement).focus()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const i = node.data.indexOf(needle)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + needle.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    throw new Error(`text not in editor: ${needle}`)
  }, needle)
  await expect.poll(() => editor.evaluate((root) => {
    const view = (root as HTMLElement & {
      editor?: { view: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number): string } } } }
    }).editor?.view
    if (!view) return null
    const { from, to } = view.state.selection
    return { dom: window.getSelection()?.toString(), editor: view.state.doc.textBetween(from, to) }
  })).toEqual({ dom: needle, editor: needle })
}

/**
 * ⌘C on the editor's current selection; returns the text/plain flavour ProseMirror
 * wrote, read off the copy event itself (no clipboard permission, and the exact string
 * the OS clipboard receives).
 */
export async function copyEditorSelection(page: Page): Promise<string> {
  await page.evaluate(() => {
    ;(window as any).__copied = undefined
    document.addEventListener('copy', (e) => {
      ;(window as any).__copied = e.clipboardData?.getData('text/plain')
    }, { once: true })
  })
  await page.keyboard.press('ControlOrMeta+C')
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).not.toBeUndefined()
  return page.evaluate(() => (window as any).__copied as string)
}

/**
 * A picture the document holds, never ProseMirror's own hidden `<img
 * class="ProseMirror-separator">`. prosemirror-view 1.42.6 on puts that separator in
 * FRONT of an inline atom (an image) at the start of a block in WebKit and Firefox, so a
 * bare `img` locator's first match became the hidden separator
 * (file-image-refresh, 2026-11-15). The ratchet in browser-spec-ratchets.test.ts keeps
 * editor `img` locators on this.
 */
export const EDITOR_IMG = 'img:not(.ProseMirror-separator)'
