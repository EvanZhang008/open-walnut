/**
 * A composer that is replaced while the person types keeps the caret.
 *
 * 2026-11-11, the Mac app's typing record: 3 keys landed on the page body two seconds after
 * keys in a composer, with nothing else focused. A focused textarea that React removes and
 * mounts again (a parent re-keyed, a layout switch) leaves the caret on the body, and every
 * key after it is lost, while the new box under the same draft key already holds the text
 * (its draft is written at unmount). Two answers, both keyed on the box's `data-draft-key`:
 *
 *   at mount    a box whose draft key is the one the person was just typing in, mounted while
 *               the caret is on the body, takes the caret back where it was
 *   at a key    a printable key that reaches no text box while the box the person was typing
 *               in is gone moves the caret into its replacement first; a focus moved during
 *               keydown takes that key's character, so it is not lost either
 *
 * 2026-11-12, the same record five times in a day: 3 to 8 keys on the body right after a send,
 * the box still on the page ("body", no "box replaced"). A box that stays but loses the caret
 * (code blurred it, a focused neighbour went away, the engine moved focus) loses the keys the
 * same way, so the key path gives the caret back to that box too, when it can still take text.
 *
 * Only a caret code took away: a person who clicked, tapped, pressed Tab or Escape after typing
 * keeps their choice, and a remount after such a press (a Save that re-keys the composer) leaves
 * the caret where the person put it.
 */

/** Keys within this long after typing in a box still belong to it. */
export const KEEP_MS = 2_000;

interface Typed { box: HTMLTextAreaElement; key: string; at: number; start: number; end: number }

let typed: Typed | null = null;
let installed = false;
let onRestore: ((via: 'mount' | 'key', key: string, kept: boolean) => void) | null = null;

function isTextBox(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

/** The caret sits nowhere a person put it: the body, or nothing. */
function caretOnNothing(doc: Document): boolean {
  const a = doc.activeElement;
  return !a || a === doc.body || a === doc.documentElement;
}

/** A box still on the page that can take text: enabled, writable, drawn, not inert. */
export function canTakeCaret(box: HTMLTextAreaElement): boolean {
  if (!box.isConnected || box.disabled || box.readOnly) return false;
  if (box.closest('[inert]')) return false;
  return box.getClientRects().length > 0;
}

/** The person typed in a box a moment ago and the caret is now on nothing: the box they lost. */
function lostBox(doc: Document, now: number): Typed | null {
  const t = typed;
  if (!t || now - t.at > KEEP_MS || !caretOnNothing(doc)) return null;
  return t;
}

/** The person's box is gone and they typed in it a moment ago: the draft key it had. */
function lostKey(doc: Document, now: number): string | null {
  const t = lostBox(doc, now);
  return t && !t.box.isConnected ? t.key : null;
}

function giveBack(box: HTMLTextAreaElement, via: 'mount' | 'key'): void {
  const t = typed;
  if (!t) return;
  typed = null;
  const kept = box === t.box;
  box.focus({ preventScroll: true });
  const len = box.value.length;
  try { box.setSelectionRange(Math.min(t.start, len), Math.min(t.end, len)); } catch { /* not a text box any more */ }
  if (box.ownerDocument.activeElement === box) onRestore?.(via, t.key, kept);
}

function note(box: EventTarget | null, now: number): void {
  // Typing in any other text box (a search field, an input) is the person's new place.
  if (!(box instanceof HTMLTextAreaElement)) { if (isTextBox(box as Element | null)) typed = null; return; }
  const key = box.dataset.draftKey;
  if (!key) { typed = null; return; }
  typed = { box, key, at: now, start: box.selectionStart, end: box.selectionEnd };
}

/** Watch where the person types; call once at startup. */
export function initComposerCaretKeep(opts: { now?: () => number; doc?: Document; restored?: (via: 'mount' | 'key', key: string, kept: boolean) => void } = {}): () => void {
  const doc = opts.doc ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc || (installed && !opts.doc)) return () => {};
  installed = true;
  const now = opts.now ?? (() => performance.now());
  onRestore = opts.restored ?? null;
  const onInput = (e: Event) => note(e.target, now());
  // The person moves the caret themself: a press anywhere outside the box (a button, another
  // box, the page), Tab or Escape. A remount after it gives nothing back either. 2026-11-12: the
  // extension's Save as todo re-keyed its composer after the click on Save, and the new box took
  // the caret, so it never docked.
  const onPress = (e: Event) => {
    const t = typed;
    if (t && !t.box.contains(e.target as Node | null)) typed = null;
  };
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (typeof k.key !== 'string') return;
    if (k.key === 'Tab' || k.key === 'Escape') { typed = null; return; }
    if (k.key.length !== 1 || k.metaKey || k.ctrlKey || k.altKey || k.isComposing) return;
    if (isTextBox(k.target as Element | null)) return;
    const t = lostBox(doc, now());
    if (!t) return;
    if (t.box.isConnected) {
      // The box stayed but lost the caret: back into it, if it can still take text.
      if (canTakeCaret(t.box)) giveBack(t.box, 'key');
      return;
    }
    const box = [...doc.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft-key]')].find((b) => b.dataset.draftKey === t.key && !b.disabled);
    if (box) giveBack(box, 'key');
  };
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('select', onInput, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPress, true);
  doc.addEventListener('mousedown', onPress, true);
  doc.addEventListener('touchstart', onPress, true);
  return () => {
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('select', onInput, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPress, true);
    doc.removeEventListener('mousedown', onPress, true);
    doc.removeEventListener('touchstart', onPress, true);
    typed = null;
    installed = false;
    onRestore = null;
  };
}

/** A composer just mounted: take the caret back when it replaces the box the person typed in. */
export function caretBackOnMount(box: HTMLTextAreaElement | null, now = performance.now()): void {
  if (!box || box.disabled || !box.dataset.draftKey) return;
  if (lostKey(box.ownerDocument, now) === box.dataset.draftKey) giveBack(box, 'mount');
}
