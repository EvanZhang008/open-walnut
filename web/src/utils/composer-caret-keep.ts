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
 * Only the box that was removed: a person who clicked somewhere else keeps their choice.
 */

/** Keys within this long after typing in a box still belong to it. */
export const KEEP_MS = 2_000;

interface Typed { box: HTMLTextAreaElement; key: string; at: number; start: number; end: number }

let typed: Typed | null = null;
let installed = false;
let onRestore: ((via: 'mount' | 'key', key: string) => void) | null = null;

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

/** The person's box is gone and they typed in it a moment ago: the draft key it had. */
function lostKey(doc: Document, now: number): string | null {
  const t = typed;
  if (!t || now - t.at > KEEP_MS || t.box.isConnected) return null;
  return caretOnNothing(doc) ? t.key : null;
}

function giveBack(box: HTMLTextAreaElement, via: 'mount' | 'key'): void {
  const t = typed;
  if (!t) return;
  typed = null;
  box.focus({ preventScroll: true });
  const len = box.value.length;
  try { box.setSelectionRange(Math.min(t.start, len), Math.min(t.end, len)); } catch { /* not a text box any more */ }
  onRestore?.(via, t.key);
}

function note(box: EventTarget | null, now: number): void {
  if (!(box instanceof HTMLTextAreaElement)) return;
  const key = box.dataset.draftKey;
  if (!key) { typed = null; return; }
  typed = { box, key, at: now, start: box.selectionStart, end: box.selectionEnd };
}

/** Watch where the person types; call once at startup. */
export function initComposerCaretKeep(opts: { now?: () => number; doc?: Document; restored?: (via: 'mount' | 'key', key: string) => void } = {}): () => void {
  const doc = opts.doc ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc || (installed && !opts.doc)) return () => {};
  installed = true;
  const now = opts.now ?? (() => performance.now());
  onRestore = opts.restored ?? null;
  const onInput = (e: Event) => note(e.target, now());
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key.length !== 1 || k.metaKey || k.ctrlKey || k.altKey || k.isComposing) return;
    if (isTextBox(k.target as Element | null)) return;
    const key = lostKey(doc, now());
    if (!key) return;
    const box = [...doc.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft-key]')].find((b) => b.dataset.draftKey === key && !b.disabled);
    if (box) giveBack(box, 'key');
  };
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('select', onInput, true);
  doc.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('select', onInput, true);
    doc.removeEventListener('keydown', onKey, true);
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
