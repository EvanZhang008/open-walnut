/**
 * Number keys and Enter answer the prompt card in front of the person: a digit
 * picks that option (1 is the first), Enter sends the picked one. Two keys, never
 * one, so a stray digit cannot approve anything.
 *
 * Which card: the one holding focus, else the last pending card in the panel
 * keys go to (usePanelKeyRouter's pick: focus, then the last press, then the
 * pointer), else the only card on the page. Keys typed into a field (the
 * composer, an answer box, the note box) are text and never reach a card, and
 * Enter on a focused button stays that button's own click.
 *
 * A card takes keys only PROMPT_KEY_ARM_MS after it appears, so a key already on
 * its way when the prompt arrives does not land on it.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { isImeKey, keyTargetPanel } from '@/hooks/usePanelKeyRouter';

export const PROMPT_KEY_ARM_MS = 400;

export interface PromptKeyHandler {
  /** Digit 1..9 pressed: true when the card used it. */
  onDigit(n: number): boolean;
  /** Enter pressed: true when the card sent something. */
  onEnter(): boolean;
}

interface Registration {
  ref: RefObject<HTMLElement | null>;
  handler: { current: PromptKeyHandler };
  /** When the card was first seen shown (shownNow), or null while it has not been. */
  since: number | null;
}

/**
 * Shown to the person: laid out with a size and not hidden by itself or an ancestor
 * (a page still restoring its scroll keeps the history hidden). The arm counts from
 * here, not from the mount: on a full load the card mounted hidden and took a key
 * 200 ms after it could first be seen.
 */
function shownNow(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const check = (el as HTMLElement & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el, { opacityProperty: true, visibilityProperty: true }) : true;
}

let shownPoll: ReturnType<typeof setInterval> | null = null;

/** Stamps each card's `since` once it is shown; runs only while a card has not been. */
function watchShown(): void {
  if (shownPoll || typeof window === 'undefined') return;
  const tick = () => {
    let waiting = false;
    for (const reg of registrations) {
      if (reg.since !== null) continue;
      const el = reg.ref.current;
      if (el && shownNow(el)) reg.since = Date.now();
      else waiting = true;
    }
    if (!waiting && shownPoll) { clearInterval(shownPoll); shownPoll = null; }
  };
  shownPoll = setInterval(tick, 50);
  tick();
}

const registrations = new Set<Registration>();
let installed = false;
// Bumped on every register / unregister, so a card can re-read whether it is the one keys answer.
let version = 0;
const listeners = new Set<() => void>();
function changed(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

export type PromptKey = { digit: number } | 'enter';

/** The prompt key this event is, if any: a bare digit 1..9 or a bare Enter. */
export function promptKeyOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): PromptKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'Enter') return e.shiftKey ? null : 'enter';
  if (e.shiftKey || e.key.length !== 1 || e.key < '1' || e.key > '9') return null;
  return { digit: Number(e.key) };
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Is this node somewhere the person types text? */
export function isTextEntry(node: unknown): boolean {
  const el = node as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof (el as Element).closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type ?? '').toLowerCase());
  if (el.isContentEditable) return true;
  return !!el.closest('[contenteditable=""], [contenteditable="true"], .cm-editor, .xterm');
}

function isActivatable(node: unknown): boolean {
  const el = node as Element | null;
  return !!el && typeof el.closest === 'function' && !!el.closest('button, a[href], summary, [role="button"]');
}

interface Candidate<T> { el: Pick<Element, 'contains' | 'compareDocumentPosition'>; item: T }
/** Node.DOCUMENT_POSITION_FOLLOWING (the constant, so the pick runs without a DOM). */
const FOLLOWING = 4;

/** The card keys answer (the pure pick; exported for tests). */
export function pickPromptCard<T>(cards: readonly Candidate<T>[], active: Node | null, panel: Pick<Element, 'contains'> | null): T | null {
  if (active) {
    const focused = cards.find((c) => c.el.contains(active));
    if (focused) return focused.item;
  }
  const inPanel = panel ? cards.filter((c) => panel.contains(c.el as unknown as Node)) : [];
  const pool = inPanel.length > 0 ? inPanel : panel ? [] : cards.length === 1 ? cards : [];
  if (pool.length === 0) return null;
  // The last in document order: the newest ask, nearest the composer.
  let last = pool[0];
  for (const c of pool) {
    if (last.el.compareDocumentPosition(c.el as unknown as Node) & FOLLOWING) last = c;
  }
  return last.item;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || isImeKey(e) || hasActiveModalOverlay()) return;
  const key = promptKeyOf(e);
  if (!key) return;
  const active = document.activeElement;
  if (isTextEntry(e.target) || isTextEntry(active)) return;
  if (key === 'enter' && active && active !== document.body && isActivatable(active)) return;
  const now = Date.now();
  const live: Candidate<Registration>[] = [];
  for (const reg of registrations) {
    const el = reg.ref.current;
    if (el && el.isConnected && reg.since !== null && now - reg.since >= PROMPT_KEY_ARM_MS) live.push({ el, item: reg });
  }
  if (live.length === 0) return;
  // The card the page marks as taking keys (its ring and hint) takes them when the
  // pick from focus and pointer finds none: what the page promised is what happens.
  const card = pickPromptCard(live, active, panelOfFocus(active) ?? keyTargetPanel())
    ?? live.find((c) => c.el === targetEl)?.item ?? null;
  if (!card) return;
  const used = key === 'enter' ? card.handler.current.onEnter() : card.handler.current.onDigit(key.digit);
  scheduleTargetRefresh();
  if (!used) return;
  e.preventDefault();
  e.stopPropagation();
  // A digit picked here while focus sat on a control elsewhere (a copy button): focus
  // comes to the card, so the Enter its hint offers sends the pick, not that control's click.
  const el = card.ref.current;
  if (key !== 'enter' && el && !el.contains(document.activeElement)) (el as HTMLElement).focus?.({ preventScroll: true });
}

/** Focus on a control of a session panel (its header's buttons) names that panel, before the router's pick. */
function panelOfFocus(active: Element | null): Element | null {
  return active && active !== document.body ? active.closest?.('.session-panel') ?? null : null;
}

// ── Which card keys would answer right now, so the page can show it ──
// The router's pick follows focus, the last press and the pointer, so it is read
// again (once a frame at most) whenever one of those moves, and the cards re-render
// only when the answer changes.
let targetEl: Element | null = null;
let refreshQueued = false;

function computeTarget(): Element | null {
  const live: Candidate<Element>[] = [];
  for (const reg of registrations) {
    const el = reg.ref.current;
    if (el && el.isConnected) live.push({ el, item: el });
  }
  if (live.length === 0) return null;
  const active = document.activeElement;
  return pickPromptCard(live, active, panelOfFocus(active) ?? keyTargetPanel());
}

function scheduleTargetRefresh(): void {
  if (refreshQueued || typeof window === 'undefined') return;
  refreshQueued = true;
  window.requestAnimationFrame(() => {
    refreshQueued = false;
    const next = computeTarget();
    if (next !== targetEl) { targetEl = next; changed(); }
  });
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', scheduleTargetRefresh, { passive: true });
  window.addEventListener('pointerdown', scheduleTargetRefresh, { passive: true });
  window.addEventListener('focusin', scheduleTargetRefresh);
  // Focus leaving for the page body moves the router's pick too: the ring follows.
  window.addEventListener('focusout', scheduleTargetRefresh);
}

function uninstall(): void {
  if (!installed || registrations.size > 0) return;
  installed = false;
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('pointermove', scheduleTargetRefresh);
  window.removeEventListener('pointerdown', scheduleTargetRefresh);
  window.removeEventListener('focusin', scheduleTargetRefresh);
  window.removeEventListener('focusout', scheduleTargetRefresh);
  targetEl = null;
}

/**
 * Whether keys would answer this card, and whether that needs saying: with more than
 * one card taking keys on the page, the one they go to is marked and the others say
 * how to take them.
 */
export function usePromptKeyTarget(ref: RefObject<HTMLElement | null>, enabled: boolean): { target: boolean; several: boolean } {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const several = registrations.size > 1;
  return { target: enabled && !!ref.current && targetEl === ref.current, several };
}

/**
 * Register a pending card (test seam; the hook's body). Returns the unregister function.
 * `since` (tests) says when it was shown; otherwise it is stamped once it is (watchShown).
 */
export function registerPromptCard(ref: RefObject<HTMLElement | null>, handler: { current: PromptKeyHandler }, since?: number): () => void {
  const reg: Registration = { ref, handler, since: since ?? null };
  registrations.add(reg);
  install();
  if (reg.since === null) watchShown();
  changed();
  scheduleTargetRefresh();
  return () => {
    registrations.delete(reg);
    uninstall();
    changed();
    scheduleTargetRefresh();
  };
}

/** Is this card the newest registered one in its session panel (the one keys answer when no card holds focus)? */
function isNewestInPanel(el: HTMLElement | null): boolean {
  if (!el) return false;
  const panel = el.closest('.session-panel');
  for (const reg of registrations) {
    const other = reg.ref.current;
    if (!other || other === el || !other.isConnected) continue;
    if ((other.closest('.session-panel') ?? null) !== (panel ?? null)) continue;
    if (el.compareDocumentPosition(other) & FOLLOWING) return false;
  }
  return true;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Let this card take number keys and Enter while `enabled` (pending, on a keyboard surface).
 * Returns whether the card shows its key hints: it is the newest pending card in its panel, so
 * with two asks open only the one a digit would answer is numbered.
 */
export function usePromptKeys(ref: RefObject<HTMLElement | null>, handler: PromptKeyHandler, enabled: boolean): boolean {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerPromptCard(ref, latest);
  }, [enabled, ref]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return enabled && isNewestInPanel(ref.current);
}

/** Where focus is, for a card's key hint: free (keys reach it), in a text box elsewhere, or in its own box. */
export type PromptKeyFocus = 'free' | 'typing' | 'own-box';

export function promptKeyFocusOf(card: Element | null, active: Element | null): PromptKeyFocus {
  if (!active || !isTextEntry(active)) return 'free';
  return card && card.contains(active) ? 'own-box' : 'typing';
}

/** Follows focus while `enabled`, so a card can say why its keys are not reaching it. */
export function usePromptKeyFocus(ref: RefObject<HTMLElement | null>, enabled: boolean): PromptKeyFocus {
  const [focus, setFocus] = useState<PromptKeyFocus>('free');
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    // focusout fires before the next element has focus: read it a frame later.
    const read = () => setFocus(promptKeyFocusOf(ref.current, document.activeElement));
    const later = () => { window.requestAnimationFrame(read); };
    read();
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', later);
    };
  }, [enabled, ref]);
  return focus;
}

/** The key hint for where focus is: keys typed into a text box are words, so say how to get them back. */
export function promptKeyHint(focus: PromptKeyFocus, keys: string, ownBox = `Click outside this box, then ${keys}`, elsewhere = false): string {
  // Another card on the page has the keys (usePromptKeyTarget): say how to take them here.
  if (focus === 'free' && elsewhere) return `Click this card to use ${keys}`;
  // Typing: the line above the composer already says a message answers the prompt.
  if (focus === 'typing') return `Click this card, then ${keys}`;
  if (focus === 'own-box') return ownBox;
  return keys;
}

/** "1–4": the keys a card with `count` options answers to. */
export function promptKeyRange(count: number): string {
  return count <= 1 ? '1' : `1–${Math.min(count, 9)}`;
}

/** A Claude prompt's choices keep their numbers on every card: 3 is never Deny on one and Always on another. */
const CLAUDE_KEYS: Record<string, number> = { allow_once: 1, allow_session: 2, allow_always: 3, reject_once: 4 };

/**
 * The digit for each choice: a Claude prompt's fixed numbers (a choice the card does not
 * offer leaves its number unused), any other list numbered in order.
 */
export function choiceKeys(optionIds: ReadonlyArray<string | undefined>): number[] {
  const fixed = optionIds.length > 1 && optionIds.includes('reject_once') && optionIds.every((id) => !!id && id in CLAUDE_KEYS);
  return optionIds.map((id, i) => (fixed ? CLAUDE_KEYS[id!] : i + 1));
}

/** The digits a hint names: "1–4" for a run from 1, otherwise each ("1 or 4", "1, 2 or 4"). */
export function promptKeyList(keys: ReadonlyArray<number>): string {
  const ks = keys.filter((k) => k <= 9);
  if (ks.every((k, i) => k === i + 1)) return promptKeyRange(ks.length);
  return ks.length === 1 ? String(ks[0]) : `${ks.slice(0, -1).join(', ')} or ${ks[ks.length - 1]}`;
}

/** The deny message that carries the person's note: the model reads it as the tool's result. */
const NOTE_PREFIX = 'The user denied this tool call and said: ';
export function denyNoteMessage(note: string): string {
  return `${NOTE_PREFIX}${note.trim()}`;
}
/** The note inside a deny message this browser sent, for the settled card. */
export function noteOfDenyMessage(message: string | undefined): string | null {
  return message?.startsWith(NOTE_PREFIX) ? message.slice(NOTE_PREFIX.length) : null;
}

/**
 * A word about the whole prompt the server put on its plain yes (why nothing can be
 * remembered, claude-permission-options.ts): said above the choices, since inside the
 * Allow once button it read as if Allow once itself were unavailable.
 */
export function splitPromptHint<T extends { kind?: string; detail?: string }>(options: readonly T[]): { hint: string | null; options: T[] } {
  const once = options.find((o) => o.kind === 'allow_once' && o.detail);
  if (!once) return { hint: null, options: [...options] };
  return { hint: once.detail ?? null, options: options.map((o) => (o === once ? { ...o, detail: undefined } : o)) };
}

/**
 * A choice kept in a settings file outlives the session: its first click arms it and the
 * second sends it (a stray click never writes a lasting rule). Armed for a few seconds.
 * `confirm(id)` is true when the click may send.
 */
export function useSecondClick(ms = 5000): { armed: string | null; confirm: (id: string) => boolean } {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const confirm = (id: string): boolean => {
    if (armed === id) { setArmed(null); return true; }
    setArmed(id);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setArmed(null), ms);
    return false;
  };
  return { armed, confirm };
}

/** The sessions whose pending prompt card is on screen now: their toast would repeat the card. */
export function sessionsWithPromptCard(): Set<string> {
  const out = new Set<string>();
  for (const reg of registrations) {
    const sid = reg.ref.current?.isConnected ? reg.ref.current.closest<HTMLElement>('.session-panel[data-session-id]')?.dataset.sessionId : undefined;
    if (sid) out.add(sid);
  }
  return out;
}

/** Re-render when a card registers or leaves (the toaster's rule above). */
export function usePromptCardsChanged(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
