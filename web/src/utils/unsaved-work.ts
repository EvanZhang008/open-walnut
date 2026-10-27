/**
 * What a reload or an app restart would throw away, and where it is.
 *
 * Every caller asks the same question (the update notice's Restart and Reload,
 * the silent stale-build reload, the Mac app shell's page recycle and window
 * close), so the rule lives here once:
 *
 *  - A composer draft that is already in storage is NOT lost: ChatInput (or any
 *    box on useDraft, hooks/useDraft.ts) restores it on the next mount. Before looking, every composer is asked to save its
 *    text now (DRAFT_FLUSH_EVENT), and only one that confirms the save is let
 *    through. 2026-10-24: the old rule counted every non-empty `<textarea>`, so
 *    one persisted draft in any mounted composer blocked the restart, and the
 *    user only got "Could not restart" with an OK button.
 *  - Text in any other box, an image attached to a message that is not sent, a
 *    file with unsaved edits, a note still saving or failing to save, and the
 *    text of the field being edited right now ARE lost, and each one is reported
 *    with the place it sits in, so the notice can take the user there.
 */
import { log } from '@/utils/log';

export const DRAFT_FLUSH_EVENT = 'walnut:flush-drafts';

/**
 * `reload`: this page loads again in place, so every draft key it reads comes back.
 * `leave`: the page goes away (an app restart, a popout window closing). A popout
 * is not reopened, so its own drafts (`…:popout` keys) are not read again.
 */
export type UnsavedScope = 'reload' | 'leave';

/** Each composer that saved its text claims it here: which box, under which key, what text. */
export interface DraftFlushDetail {
  scope: UnsavedScope;
  claims: Array<{ element: Element; key: string; text: string }>;
}

let lastWriteAt = 0;

/** A composer wrote a draft to storage (the browser commits it to disk a moment later). */
export function noteDraftWrite(): void {
  lastWriteAt = Date.now();
}

/**
 * Wait until a draft written by the last check has had time to reach disk. The
 * Mac app's restart ends the page process soon after; WebKit commits storage
 * writes on a short timer, so a restart right after a write could lose it.
 */
export function draftsSettled(ms = 1_500, always = false): Promise<void> {
  const left = always ? ms : lastWriteAt + ms - Date.now();
  return left > 0 ? new Promise((resolve) => { window.setTimeout(resolve, left); }) : Promise.resolve();
}

export type UnsavedKind = 'message' | 'attachment' | 'file' | 'note' | 'field';

export interface UnsavedItem {
  kind: UnsavedKind;
  /** What would be lost, in a few words ("Unsent text"). */
  what: string;
  /** Where it is ("session “Fix the login”", "Scratchpad"); '' when nothing names it. */
  where: string;
  /** The session whose panel holds it, so a hidden column can be opened. */
  sessionId?: string;
  element: Element | null;
}

/** Text-bearing input types only: a checked checkbox is not unsaved typing. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
/**
 * Editors whose contenteditable holds a DOCUMENT, not unsaved typing: the
 * CodeMirror source editor and the TipTap surfaces. Scanning them for text
 * reports "unsaved" for as long as any file is open; their real dirty state is
 * `.fv-dirty-dot` and the notes save status.
 */
const DOCUMENT_EDITOR_SELECTOR = '.cm-editor, .ProseMirror, .tiptap';
const EDITABLE_ATTR_VALUES = new Set(['', 'true', 'plaintext-only']);
/** A message composer's root (ChatInput.tsx). */
const COMPOSER = '.chat-input-container';

/** Ask every mounted composer to write its draft now; returns the ones that did. */
function flushDrafts(doc: Document, scope: UnsavedScope): Set<Element> {
  const detail: DraftFlushDetail = { scope, claims: [] };
  const saved = new Set<Element>();
  try {
    const view = doc.defaultView;
    if (view && typeof view.CustomEvent === 'function') {
      view.dispatchEvent(new view.CustomEvent<DraftFlushDetail>(DRAFT_FLUSH_EVENT, { detail }));
    }
    // Checked after every composer wrote: two boxes on one key (a dock and a column on the
    // same session) leave only the last text in storage, and only that box is saved.
    for (const claim of detail.claims) {
      if (view?.localStorage.getItem(claim.key) === claim.text) saved.add(claim.element);
    }
  } catch { /* nothing confirmed: every draft counts */ }
  return saved;
}

function quoted(text: string | null | undefined, max = 60): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}

/** The place an element sits in, named the way the user sees it. */
function placeOf(el: Element): { where: string; sessionId?: string } {
  const panel = el.closest('.session-panel[data-session-id]');
  if (panel) {
    const sessionId = panel.getAttribute('data-session-id') ?? undefined;
    const title = quoted(panel.querySelector('.session-panel-title')?.textContent);
    return { where: title ? `session ${title}` : 'a session', sessionId };
  }
  if (el.closest('.draft-session-panel')) return { where: 'the new session draft' };
  if (el.closest('.global-notes-section')) return { where: 'Scratchpad' };
  const label = quoted(el.getAttribute('aria-label') ?? el.getAttribute('placeholder'), 40);
  return { where: label ? `the ${label} box` : '' };
}

function item(kind: UnsavedKind, what: string, element: Element, where?: string): UnsavedItem {
  const place = placeOf(element);
  return { kind, what, element, where: where ?? place.where, ...(place.sessionId ? { sessionId: place.sessionId } : {}) };
}

/**
 * Everything in this document a reload would lose. `active` is a parameter (not
 * read straight off the document) so the rule can be tested against a headless
 * DOM that has no focus model.
 */
export function listUnsavedWork(doc: Document = document, active: Element | null = doc.activeElement, scope: UnsavedScope = 'leave'): UnsavedItem[] {
  const saved = flushDrafts(doc, scope);
  const items: UnsavedItem[] = [];
  for (const el of Array.from(doc.querySelectorAll('textarea'))) {
    const value = (el as HTMLTextAreaElement).value ?? '';
    if (value.trim() && !saved.has(el)) items.push(item('message', 'Unsent text', el));
  }
  // An image pasted into a composer lives only in React state: one entry per composer.
  // Only a composer's own previews count. The conversation draws an image it already
  // sent with the same classes (SessionChatHistory's OptimisticImagePreviews), and
  // counting those held a reload over images marked "Delivered" (2026-10-25).
  for (const group of Array.from(doc.querySelectorAll(`${COMPOSER} .chat-image-previews`))) {
    if (group.querySelector('.chat-image-preview')) items.push(item('attachment', 'An attached image that is not sent', group));
  }
  for (const el of Array.from(doc.querySelectorAll(`${COMPOSER} .chat-image-preview`))) {
    if (!el.closest('.chat-image-previews')) items.push(item('attachment', 'An attached image that is not sent', el));
  }
  for (const el of Array.from(doc.querySelectorAll('.fv-dirty-dot'))) items.push(item('file', 'Unsaved file changes', el));
  for (const el of Array.from(doc.querySelectorAll('.notes-save-status.saving, .global-notes-saving'))) {
    items.push(item('note', 'A note that is still saving', el, el.matches('.global-notes-saving') ? 'Scratchpad' : undefined));
  }
  for (const el of Array.from(doc.querySelectorAll('.notes-save-status.error, .global-notes-error'))) {
    items.push(item('note', 'A note that could not be saved', el, el.matches('.global-notes-error') ? 'Scratchpad' : undefined));
  }
  const tag = active?.tagName?.toUpperCase();
  // A box kept in the draft store (useDraft) comes back with its words.
  if (active && saved.has(active)) return items;
  if (tag === 'INPUT') {
    const type = (active!.getAttribute('type') ?? '').toLowerCase();
    // Focus-gated on purpose: most single-line inputs are search and filter boxes.
    if (TEXT_INPUT_TYPES.has(type) && ((active as HTMLInputElement).value ?? '').trim()) items.push(item('field', 'Text being edited', active!));
  } else if (active && EDITABLE_ATTR_VALUES.has((active.getAttribute('contenteditable') ?? 'off').toLowerCase())) {
    // An inline title being edited counts; a document editor's body does not.
    if (!active.closest?.(DOCUMENT_EDITOR_SELECTOR) && (active.textContent ?? '').trim()) items.push(item('field', 'Text being edited', active));
  }
  return items;
}

/** One line for the server log, so a blocked restart says what blocked it. */
export function describeUnsavedWork(items: UnsavedItem[]): Array<{ kind: UnsavedKind; where: string; sessionId?: string }> {
  return items.map(({ kind, where, sessionId }) => ({ kind, where, ...(sessionId ? { sessionId } : {}) }));
}

/** Home stays mounted behind every other page, in this wrapper (App.tsx). */
const HIDDEN_HOME = '.main-page-wrapper-hidden';

/**
 * On screen for the user. Laid out is not enough: Home behind an app page keeps
 * its boxes (visibility:hidden, height 0), so a composer there has client rects
 * and "Go there" used to scroll it inside the hidden page and stay put (2026-10-25).
 */
function visible(el: Element | null): el is HTMLElement {
  if (!el || !el.isConnected || typeof (el as HTMLElement).focus !== 'function') return false;
  if (el.getClientRects().length === 0 || el.closest(HIDDEN_HOME)) return false;
  const view = el.ownerDocument?.defaultView;
  return !view?.getComputedStyle || view.getComputedStyle(el).visibility !== 'hidden';
}

function show(el: HTMLElement): void {
  el.scrollIntoView?.({ block: 'center' });
  // An attachment is not a field: put the cursor in the composer it belongs to.
  const field = el.matches('textarea, input, [contenteditable]') ? el : el.closest(COMPOSER)?.querySelector<HTMLElement>('textarea') ?? el;
  field.focus?.({ preventScroll: true });
}

/** Opens Home, on a session's column when given one. Every window registers its router's. */
export type HomeOpener = (sessionId?: string) => void;
let homeOpener: HomeOpener | undefined;
export function setUnsavedWorkHomeOpener(open: HomeOpener | undefined): void { homeOpener = open; }

/** The same item after its column re-rendered: the box of that kind in that session. */
function relocate(target: UnsavedItem): Element | null {
  if (visible(target.element) || !target.sessionId) return target.element;
  const panels = Array.from((target.element?.ownerDocument ?? document).querySelectorAll('.session-panel[data-session-id]'))
    .filter((p) => p.getAttribute('data-session-id') === target.sessionId);
  const selector = target.kind === 'attachment' ? `${COMPOSER} .chat-image-previews` : target.kind === 'message' ? `${COMPOSER} textarea` : '';
  for (const panel of panels) {
    const found = selector ? panel.querySelector(selector) : null;
    if (visible(found)) return found;
  }
  return target.element;
}

/**
 * Take the user to an item, from any page. One on Home (a session column, the
 * Scratchpad) while another page shows is reached by opening Home first, on its
 * session's column when it has one, then revealed once it has rendered.
 */
export function revealUnsavedWork(target: UnsavedItem, openHome: HomeOpener | undefined = homeOpener): void {
  log.info('update', 'revealing unsaved work', describeUnsavedWork([target])[0]);
  if (visible(target.element)) { show(target.element); return; }
  const onHome = !!target.element?.closest('.main-page-wrapper');
  if (!openHome || (!target.sessionId && !onHome)) return;
  openHome(target.sessionId);
  let tries = 0;
  const retry = () => {
    const el = relocate(target);
    if (visible(el)) { show(el); return; }
    if (++tries < 30) window.setTimeout(retry, 100);
  };
  window.setTimeout(retry, 50);
}
