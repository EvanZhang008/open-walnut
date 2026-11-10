/**
 * Home's keyboard: move between the session columns and work through the tasks that need
 * the person without the mouse (the keys are listed in keyboard/shortcuts.ts):
 *   - mod+1..9: the Nth column from the left (drafts included), caret in its composer;
 *   - mod+shift+[ / ]: the previous / next column, wrapping;
 *   - mod+i: the caret into the current column's composer;
 *   - mod+shift+D: complete the current column's task, close it, go to the next task that
 *     needs the person (MainPage's `completeColumn`, through useColumnCompleteClose);
 *   - holding the jump modifier alone shows each column's number.
 * "Current" is the column holding the caret, else the one the person last pressed in; the
 * hook reports it (`current`) so Home can mark that column, the one the keys act on.
 * Off Home (MainPage stays mounted behind other routes) nothing here listens.
 */
import { useEffect, useRef, useState } from 'react';
import type { SessionSlot } from './sessionColumns';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { hasOpenOverlayLayer } from '@/hooks/useOverlayLayer';
import { getActiveSessionId, setActiveSession } from '@/stores/active-session';
import { focusWhenShown } from '@/utils/focus-when-shown';
import { installFindPointerTracking, lastPointerTarget } from '@/utils/find-scope';
import { COMPOSER_FOCUS_EVENT, type ComposerFocusDetail } from '@/utils/composer-insert';
import {
  cycleDir, detectKeyEnv, isCompleteNextChord, isFocusComposerChord, isJumpHintModifier, jumpIndex,
  type KeyEnv,
} from '@/keyboard/shortcuts';

const HINT_DELAY_MS = 350;
const COLUMN = '.main-page-session-column[data-column-id]';

function columnEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.main-page-session-column[data-column-id="${CSS.escape(id)}"]`);
}

// When the caret last moved by keyboard (a jump, an advance) and when the pointer last
// pressed: a press older than a keyboard move no longer says where the person is.
let keyMoveAt = 0;
let pointerAt = 0;
/** When the person last moved by a key of their own (a jump, a cycle, mod+i), and last typed. */
let personKeyAt = 0;
let typedAt = 0;
let pointerTracked = false;
function trackPointer(): void {
  if (pointerTracked || typeof document === 'undefined') return;
  pointerTracked = true;
  document.addEventListener('pointerdown', () => { pointerAt = performance.now(); }, { capture: true, passive: true });
  // A carry putting kept keys into the next box is not the person typing there.
  document.addEventListener('input', () => { if (!carryPutting) typedAt = performance.now(); }, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => { if (isText(e.target as Element | null)) lastText = e.target as HTMLElement; }, { capture: true, passive: true });
}
let lastText: HTMLElement | null = null;
/** The text box the person was last in (a press on a button since may have taken the caret). */
export function lastTextBox(): HTMLElement | null {
  return lastText?.isConnected ? lastText : null;
}
/** The caret moved by keyboard (a jump, or an advance to the next task). */
export function noteKeyboardMove(): void {
  keyMoveAt = performance.now();
}

/** Whether the person moved on since `at` (performance.now()): a jump of theirs, a press
 *  anywhere, or typing (in the next task's box, say). An advance to the next task is not theirs
 *  and does not count. */
export function personMovedSince(at: number): boolean {
  return personKeyAt > at || pointerAt > at || typedAt > at;
}

/** The column the person is in: the one holding the caret, else, while the caret is
 *  nowhere (reading a transcript focuses nothing), the one they last pressed in, unless the
 *  keyboard moved them since. */
export function intentColumnId(): string | null {
  const active = document.activeElement as HTMLElement | null;
  const caretCol = active && active !== document.body ? active.closest?.(COLUMN) : null;
  if (caretCol) return caretCol.getAttribute('data-column-id');
  if (active && active !== document.body) return null;
  if (keyMoveAt > pointerAt) return null;
  return lastPointerTarget()?.closest(COLUMN)?.getAttribute('data-column-id') ?? null;
}

/** The column the person is in, else the session they last pressed or typed in. */
export function currentColumnId(ids: readonly string[]): string | null {
  const caret = intentColumnId();
  if (caret && ids.includes(caret)) return caret;
  const active = getActiveSessionId();
  return active && ids.includes(active) ? active : null;
}

/**
 * Put the caret in a column's composer. A session column takes the request itself (it
 * reveals a collapsed chat first, SessionPanel); a draft's box is focused directly. A column
 * that is only just opening is waited for (up to 3 s).
 */
let activeFocus: (() => void) | null = null;
export function focusColumnComposer(id: string): () => void {
  // One caret request at a time: a newer jump wins over an older one still waiting.
  activeFocus?.();
  noteKeyboardMove();
  let cancelled = false;
  let cancelFocus: (() => void) | null = null;
  const until = Date.now() + 3000;
  let raf = 0;
  const attempt = () => {
    if (cancelled) return;
    const col = columnEl(id);
    if (col) {
      col.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const detail: ComposerFocusDetail = { sessionId: id, within: col, handled: false };
      window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail }));
      const box = () => col.querySelector<HTMLTextAreaElement>('textarea.chat-input-textarea');
      // A box on screen takes the caret now, so what is typed right after the key lands in it.
      const now = box();
      if (now && now.offsetParent !== null && document.activeElement !== now) now.focus({ preventScroll: true });
      if (detail.handled || box()) {
        cancelFocus = focusWhenShown(box);
        setActiveSession(id);
        return;
      }
    }
    if (Date.now() < until) raf = requestAnimationFrame(attempt);
  };
  const cancel = () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    cancelFocus?.();
    if (activeFocus === cancel) activeFocus = null;
  };
  activeFocus = cancel;
  attempt();
  return cancel;
}

/**
 * What is typed between a completion key and the caret reaching the next task's box: kept, and
 * put into that box once it has the caret (the next column opens a moment after the key). The
 * closing column's box gives the caret up at once, so nothing lands in a box that is going.
 * Only a session column's composer takes it, never the closing column's or any other box.
 * Backspace takes back a kept character; Enter is held back (never a send into the wrong task).
 * A chord (a jump, an Undo, the search) is the person going somewhere else: what was kept is
 * dropped and the key does its own thing. It also ends at a press, when the caret lands
 * anywhere but such a composer, or after CARRY_MS with nowhere to go. The completion ends it
 * sooner when it knows (endCarry): refused, the text and the caret go back to the box they
 * came from; no box to go to, it stops at once.
 */
const CARRY_MS = 6000;
let stopCarry: ((giveBack: boolean) => void) | null = null;
let carryPutting = false;
/** What the last carry put into the next task's box, so a refusal that takes the advance back
 *  can take the text back too (while the box still holds just that). */
let carried: { box: HTMLTextAreaElement; text: string; fromColumn: string } | null = null;
const isText = (el: Element | null): el is HTMLElement =>
  !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);
/** End the carry of a completion: `giveBack` puts what was kept, and the caret, back where it was. */
export function endCarry(giveBack: boolean): void {
  stopCarry?.(giveBack);
}
/** Insert text at the caret as typed (the box's input event, so React's state and its text undo
 *  see it), without counting as the person typing (personMovedSince). */
function insertQuietly(box: HTMLElement, text: string): void {
  carryPutting = true;
  try {
    if (!document.execCommand?.('insertText', false, text) && (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement)) {
      const at = box.selectionStart ?? box.value.length;
      box.setRangeText(text, at, box.selectionEnd ?? at, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } finally {
    carryPutting = false;
  }
}

/**
 * A completion refused after its column went takes the advance back: what the carry put into
 * the next task's box leaves it and goes into the completed column's box once that is back and
 * takes the caret (up to 3 s). Only while the next box still holds exactly what was put there.
 */
export function takeBackCarried(): void {
  const c = carried;
  carried = null;
  if (!c || typeof document === 'undefined' || !c.box.isConnected || c.box.value !== c.text) return;
  carryPutting = true;
  try {
    c.box.setRangeText('', 0, c.box.value.length, 'end');
    c.box.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    carryPutting = false;
  }
  const onFocus = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el?.classList.contains('chat-input-textarea') || el.closest(COLUMN)?.getAttribute('data-column-id') !== c.fromColumn) return;
    done();
    insertQuietly(el, c.text);
  };
  const done = () => { clearTimeout(timer); document.removeEventListener('focusin', onFocus, true); };
  const timer = setTimeout(done, 3000);
  document.addEventListener('focusin', onFocus, true);
}

export function carryTypingToNextBox(closingColumnId: string): void {
  stopCarry?.(false);
  carried = null;
  if (typeof document === 'undefined') return;
  const active = document.activeElement as HTMLElement | null;
  const from = active?.closest(COLUMN) && isText(active) ? active : null;
  from?.blur();
  const kept: string[] = [];
  /** The box the keys came from: itself, or its column's composer drawn anew since (a refused
   *  completion re-renders it). */
  const ownBox = (): HTMLElement | null => (from?.isConnected ? from : null)
    ?? (from ? columnEl(closingColumnId)?.querySelector<HTMLElement>('textarea.chat-input-textarea') ?? null : null);
  const isNextComposer = (el: Element | null): el is HTMLTextAreaElement => {
    if (!el || !el.classList.contains('chat-input-textarea')) return false;
    const column = el.closest(COLUMN);
    return !!column && column.getAttribute('data-column-id') !== closingColumnId;
  };
  const put = (box: HTMLElement) => {
    if (!kept.length) return;
    const text = kept.join('');
    kept.length = 0;
    insertQuietly(box, text);
    carried = box instanceof HTMLTextAreaElement && box !== ownBox() ? { box, text, fromColumn: closingColumnId } : null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) stop();
      return;
    }
    if (e.isComposing) return;
    const el = document.activeElement;
    if (isText(el)) { stop(); return; }
    if (e.key.length === 1) kept.push(e.key);
    else if (e.key === 'Backspace') kept.pop();
    else if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.target as Element | null;
    // The next box, or the box it came from given back (a refusal puts the caret there).
    if (isNextComposer(el) || (el && el === ownBox())) put(el as HTMLElement);
    stop();
  };
  const timer = setTimeout(() => stop(), CARRY_MS);
  const onPress = () => stop();
  const stop = (giveBack = false) => {
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('pointerdown', onPress, true);
    if (stopCarry === stop) stopCarry = null;
    // Only while the caret is still nowhere (the person did not go on meanwhile).
    const nowhere = !document.activeElement || document.activeElement === document.body;
    const back = giveBack && nowhere ? ownBox() : null;
    if (back) {
      back.focus({ preventScroll: true });
      put(back);
    }
  };
  stopCarry = stop;
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('pointerdown', onPress, true);
}

/** Put the caret on a task's row in the list (an advance to a task with no session), once the
 *  list draws it (up to 2 s). One caret request like a jump's: a newer one cancels it, and so
 *  does the person moving on (a key, a press, typing) while the row is still being drawn. */
export function focusTaskRow(taskId: string): () => void {
  activeFocus?.();
  const start = performance.now();
  const until = Date.now() + 2000;
  let raf = 0;
  const cancel = () => {
    cancelAnimationFrame(raf);
    if (activeFocus === cancel) activeFocus = null;
  };
  const attempt = () => {
    if (personMovedSince(start)) { cancel(); return; }
    const row = [...document.querySelectorAll<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`)]
      .find((el) => el.getClientRects().length > 0 && !el.closest(COLUMN) && el.hasAttribute('tabindex'));
    if (row) { row.focus({ preventScroll: true }); cancel(); return; }
    if (Date.now() < until) raf = requestAnimationFrame(attempt); else cancel();
  };
  activeFocus = cancel;
  raf = requestAnimationFrame(attempt);
  return cancel;
}

interface Deps {
  visible: boolean;
  /** The strip, left to right, as last rendered. */
  columnsRef: { current: SessionSlot[] };
  /** Complete the task of this column and go on; false when the column has no task to complete. */
  completeColumn: (columnId: string) => boolean;
  /** No column is current: complete the task selected in the list, if any. */
  completeSelected: () => boolean;
  /** Whether this column's task is already complete (the key then says so). */
  columnTaskDone?: (columnId: string) => boolean;
  /** Say why a key did nothing (`ms`: how long, when shorter than a hint's own). */
  hint: (message: string, ms?: number) => void;
  /** A key moved the person to this column (the list selects its task). */
  onJump?: (columnId: string) => void;
}

/** After a completion the complete key rests while the strip moves on: a double tap must never
 *  complete a task the person has not seen. From the list, for this long. */
const SETTLING_MS = 1200;
/** From a column, until the caret has been in the next place this long... */
const SEEN_MS = 1000;
/** ...and never longer than this (the next task may take the caret nowhere). */
const SETTLE_CAP_MS = 5000;

function editorFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.isContentEditable || !!el.closest?.('.cm-editor, .xterm, .monaco-editor'));
}

export function useHomeKeyboard(deps: Deps): { jumpHints: boolean; env: KeyEnv; current: string | null } {
  const latest = useRef(deps);
  latest.current = deps;
  const [jumpHints, setJumpHints] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const env = useRef<KeyEnv>(detectKeyEnv()).current;
  const { visible } = deps;

  useEffect(() => {
    if (!visible) { setJumpHints(false); return; }
    installFindPointerTracking();
    trackPointer();
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let hintsShown = false;
    let cancelFocus: (() => void) | null = null;
    // Runs on every key, typing included: it touches React only when the numbers are up, so a
    // typed letter never sets Home's state (2026-11-10, the user: "did we hook anything to the input").
    const hideHints = () => {
      if (hintTimer) { clearTimeout(hintTimer); hintTimer = undefined; }
      if (!hintsShown) return;
      hintsShown = false;
      setJumpHints(false);
    };
    /** The column the keys act on, and the one Home marks: one value for both. A jump sets it
     *  at once (so keys faster than the caret stack up), the caret or a press inside a column
     *  sets it to that column, and focus or a press outside every column clears it (the keys
     *  then act on the task selected in the list). */
    let target: string | null = intentColumnId();
    // The column the keys act on going away (it closed): the keys go back to where the caret is.
    let stripObserver: MutationObserver | null = null;
    const watchStrip = () => {
      stripObserver?.disconnect();
      stripObserver = null;
      const strip = target ? columnEl(target)?.parentElement : null;
      if (!strip || typeof MutationObserver === 'undefined') return;
      stripObserver = new MutationObserver(() => {
        if (!target || columnEl(target)) return;
        const next = intentColumnId();
        setTarget(next && columnEl(next) ? next : null);
      });
      stripObserver.observe(strip, { childList: true });
    };
    const setTarget = (id: string | null) => { target = id; setCurrent(id); watchStrip(); };
    setCurrent(target);
    const intended = (ids: readonly string[]): string | null => (target && ids.includes(target) ? target : null);
    const goTo = (id: string) => {
      personKeyAt = performance.now();
      completedAt = -Infinity;
      cancelFocus?.();
      setTarget(id);
      cancelFocus = focusColumnComposer(id);
      latest.current.onJump?.(id);
    };
    let completedAt = -Infinity;
    /** The column the last completion closed, and when the caret first landed outside it. */
    let closedColumn: string | null = null;
    let arrivedAt = -Infinity;
    const settling = () => {
      const now = performance.now();
      if (!closedColumn) return now - completedAt < SETTLING_MS;
      if (now - completedAt >= SETTLE_CAP_MS) return false;
      // Refused (the column is back with its task open): nothing is moving on, the key is free.
      if (columnEl(closedColumn) && latest.current.columnTaskDone && !latest.current.columnTaskDone(closedColumn)) return false;
      return arrivedAt < completedAt || now - arrivedAt < SEEN_MS;
    };
    const onArrive = (e: FocusEvent) => {
      if (!closedColumn || arrivedAt >= completedAt) return;
      const el = e.target as Element | null;
      if (columnEl(closedColumn) || el?.closest?.(`[data-column-id="${CSS.escape(closedColumn)}"]`)) return;
      arrivedAt = performance.now();
    };
    // A click is the person choosing: the complete key is theirs again at once.
    const onPersonPress = () => { completedAt = -Infinity; };
    document.addEventListener('focusin', onArrive, true);
    document.addEventListener('pointerdown', onPersonPress, true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isJumpHintModifier(e, env)) {
        if (!e.repeat && !hintTimer && latest.current.columnsRef.current.length > 0 && !hasActiveModalOverlay()) {
          hintTimer = setTimeout(() => { hintTimer = undefined; hintsShown = true; setJumpHints(true); }, HINT_DELAY_MS);
        }
        return;
      }
      // Cmd still held after a jump: the numbers stay up for the next one.
      const keepHints = hintsShown;
      hideHints();
      const showHintsAgain = () => { if (keepHints) { hintsShown = true; setJumpHints(true); } };
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (hasActiveModalOverlay() || hasOpenOverlayLayer() || document.querySelector('.wn-context-menu')) return;
      const ids = latest.current.columnsRef.current.map((c) => c.id);

      const n = jumpIndex(e, env);
      if (n > 0) {
        // 9 is the last column, as in a browser's tabs.
        const id = n === 9 ? ids[ids.length - 1] : ids[n - 1];
        if (!id) return;
        e.preventDefault();
        goTo(id);
        showHintsAgain();
        return;
      }
      const dir = cycleDir(e, env);
      if (dir !== 0) {
        if (ids.length === 0) return;
        e.preventDefault();
        const at = ids.indexOf(intended(ids) ?? currentColumnId(ids) ?? '');
        const next = at < 0 ? (dir > 0 ? 0 : ids.length - 1) : (at + dir + ids.length) % ids.length;
        goTo(ids[next]);
        showHintsAgain();
        return;
      }
      if (isFocusComposerChord(e, env)) {
        if (ids.length === 0 || editorFocused()) return;
        e.preventDefault();
        goTo(intended(ids) ?? currentColumnId(ids) ?? ids[0]);
        return;
      }
      if (isCompleteNextChord(e, env)) {
        e.preventDefault();
        if (e.repeat) return;
        // Pressed again while the strip moves on: nothing, and nothing to say. The completion's
        // own toast already names the next task, and a hint would hide its Undo.
        if (settling()) return;
        const id = intended(ids);
        const done = id ? latest.current.completeColumn(id) : latest.current.completeSelected();
        if (done) { completedAt = performance.now(); closedColumn = id; if (id) carryTypingToNextBox(id); return; }
        if (id && latest.current.columnTaskDone?.(id)) { latest.current.hint('This task is already complete.'); return; }
        latest.current.hint(id ? 'This column has no task to complete.' : 'Select a task, or click into a session, to complete it.');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Alt held to read the numbers, then let go: on Windows that release would open the
      // browser's menu.
      if (e.key === 'Alt' && hintsShown) e.preventDefault();
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || !(e.metaKey || e.ctrlKey || e.altKey)) hideHints();
    };
    const onBlur = () => hideHints();
    const mark = (e: Event) => {
      const el = e.target as Element | null;
      if (!el || el === document.body || el === document.documentElement) return;
      // A dialog, menu or toast over the page is not a place the person moved to.
      if (el.closest?.('[role="dialog"], [role="menu"], .wn-context-menu, .task-kebab-menu, .task-kebab-project-flyout, .adopt-worker-flyout, .notification-toaster')) return;
      setTarget(el.closest?.(COLUMN)?.getAttribute('data-column-id') ?? null);
    };
    document.addEventListener('focusin', mark, true);
    document.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onBlur);
    watchStrip();
    return () => {
      hideHints();
      cancelFocus?.();
      stripObserver?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onBlur);
      document.removeEventListener('focusin', mark, true);
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('focusin', onArrive, true);
      document.removeEventListener('pointerdown', onPersonPress, true);
    };
  }, [visible, env]);

  return { jumpHints, env, current };
}
