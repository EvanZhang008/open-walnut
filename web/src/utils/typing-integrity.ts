/**
 * Typing integrity: does every key the person presses reach the box they type in?
 *
 * 2026-11-10, the user in the Mac app: "all of a sudden walnut can only type slow, if fast
 * walnut lost text in the input". A headless WebKit run on the same server kept every key,
 * busy page or not, so the window he types in has to say where a key went. For each printable
 * key pressed in a text box it tells one of four ends apart:
 *
 *   inserted   the box got an input event for it (the normal end)
 *   prevented  a handler called preventDefault on the keydown, so no text went in; the line
 *              names that handler's place in the code (its stack, a few frames)
 *   dropped    no input event and nobody prevented it: the engine or the native text input
 *              lost it before the page saw any text
 *   overwrite  code set the box's value and took away text typed in the last few seconds;
 *              the line names that code too
 *   offBox     the key landed outside every text box within 2 s of typing in one: the box
 *              lost the caret mid-word (a re-mount, a disable, a focus move); the line names
 *              what took it (the element that got focus) and why the box lost it: replaced,
 *              disabled, read-only, hidden or inert, a person's click, or the code that blurred it
 *
 * One `[perf] typing integrity` line per 30 s window that lost anything, and one every
 * 5 minutes of typing otherwise, so a good baseline sits beside a bad one in the log.
 * Cheap: a few counters per key; a stack is read only when something is lost.
 */

const WINDOW_MS = 30_000;
const REPORT_QUIET_MS = 5 * 60_000;
/** A key with no input event this long after its keydown counts as dropped. */
const SETTLE_MS = 1_000;
/** Text typed this recently is the person's: code taking it away is an overwrite. */
const TYPED_RECENT_MS = 3_000;
const MIN_KEYS_FOR_REPORT = 5;
const MAX_STACKS = 3;
/** A key outside any box this soon after typing in one is a key the box lost. */
const OFF_BOX_MS = 2_000;

export interface IntegrityWindow {
  keys: number;
  inserted: number;
  prevented: number;
  dropped: number;
  overwrites: number;
  /** Characters the overwrites took away. */
  overwrittenChars: number;
  /** An "@" or "/" query replaced by what was picked from its menu: not lost. */
  picks: number;
  offBox: number;
  /** Keys that reached no box and were moved into the replacement of the box typed in (utils/composer-caret-keep.ts). */
  rescued: number;
  preventedBy: string[];
  overwrittenBy: string[];
  /** Where the caret was when a key landed outside the box (tag.class of the active element). */
  offBoxAt: string[];
}

export function emptyWindow(): IntegrityWindow {
  return { keys: 0, inserted: 0, prevented: 0, dropped: 0, overwrites: 0, overwrittenChars: 0, picks: 0, offBox: 0, rescued: 0, preventedBy: [], overwrittenBy: [], offBoxAt: [] };
}

/** Two windows summed: what a test reads across the 30 s windows its run spans. */
export function sumWindows(a: IntegrityWindow, b: IntegrityWindow): IntegrityWindow {
  const out = emptyWindow();
  for (const k of ['keys', 'inserted', 'prevented', 'dropped', 'overwrites', 'overwrittenChars', 'picks', 'offBox', 'rescued'] as const) out[k] = a[k] + b[k];
  for (const k of ['preventedBy', 'overwrittenBy', 'offBoxAt'] as const) out[k] = [...new Set([...a[k], ...b[k]])].slice(0, 10);
  return out;
}

export function lostAny(w: IntegrityWindow): boolean {
  return w.prevented + w.dropped + w.overwrites + w.offBox > 0;
}

/** A printable key typed into a text box: one character, no command chord, not mid-IME. */
export function isTypedKey(e: KeyboardEvent): boolean {
  return isPrintable(e) && isTextBox(e.target);
}

function isPrintable(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && e.keyCode !== 229;
}

function describe(el: Element | null): string {
  if (!el) return 'none';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
}

function isTextBox(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
  return el.isContentEditable === true;
}

/** Where in the code a call came from: a few frames past this module's own. */
export function callerOf(stack: string | undefined): string {
  if (!stack) return '?';
  const frames = stack.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/typing-integrity|^Error$/.test(l));
  return frames.slice(0, 4).join(' < ').slice(0, 400);
}

/** Text the set takes away from what the box held: a cut at the end, or a whole replace. */
export function charsTaken(before: string, after: string): number {
  return removedSpan(before, after).taken;
}

/**
 * What a set of the box's value took away, between the part both texts start with and the part
 * both end with. `pick` says the span was an "@" or "/" query the person was typing, replaced by
 * what they picked from its menu (2026-11-11: the first real window counted two "@" mention
 * picks as lost text).
 */
export function removedSpan(before: string, after: string): { taken: number; pick: boolean } {
  if (after.startsWith(before)) return { taken: 0, pick: false };
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const taken = before.length - head - tail;
  if (taken <= 0) return { taken: 0, pick: false };
  // The word the removed part sits in, from its start up to the end of what was removed.
  const wordStart = Math.max(before.lastIndexOf(' ', head - 1), before.lastIndexOf('\n', head - 1)) + 1;
  const word = before.slice(wordStart, before.length - tail);
  return { taken, pick: /^[@/]/.test(word) };
}

export interface TypingIntegrityDeps {
  now: () => number;
  report: (w: IntegrityWindow & { url: string; reason: 'lost' | 'periodic' }) => void;
  doc: Document;
  win: Window;
}

interface PendingKey { at: number; ev: KeyboardEvent }

let installed = false;

export function initTypingIntegrity(overrides: Partial<TypingIntegrityDeps> = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (installed && !overrides.doc) return () => {};
  installed = true;
  const deps: TypingIntegrityDeps = {
    now: overrides.now ?? (() => performance.now()),
    report: overrides.report ?? ((w) => {
      const { reason, ...rest } = w;
      (reason === 'lost' ? console.warn : console.info)('[perf] typing integrity', rest);
    }),
    doc: overrides.doc ?? document,
    win: overrides.win ?? window,
  };
  const { doc, win } = deps;

  let w = emptyWindow();
  /** Every window already flushed, for the test probe below. */
  let flushed = emptyWindow();
  let windowStart = deps.now();
  let lastReport = deps.now();
  /** Keydowns still waiting for their input event, per box. */
  const pending = new Map<EventTarget, PendingKey[]>();
  const typedAt = new WeakMap<EventTarget, number>();
  let lastTypedAt = -Infinity;
  /** The box typed in last: gone from the page means it was replaced under the person. */
  let lastBox: Element | null = null;
  const preventers = new WeakMap<Event, string>();
  /** The person's last press: a key after it outside the box is their choice, not a loss. */
  let lastPressAt = -Infinity;
  /** The last time a text box lost the caret to nothing, and the code that did it. */
  let lastBlur: { at: number; by: string } | null = null;
  /** Why the box typed in last no longer holds the caret. */
  const whyOff = (): string => {
    const b = lastBox as HTMLTextAreaElement | null;
    if (!b) return '';
    if (!b.isConnected) return ' (box replaced)';
    if (b.disabled) return ' (box disabled)';
    if (b.readOnly) return ' (box read-only)';
    if (b.closest?.('[inert]')) return ' (box inert)';
    if (b.getClientRects && b.getClientRects().length === 0) return ' (box hidden)';
    if (lastPressAt >= lastTypedAt) return ' (after a click)';
    if (lastBlur && lastBlur.at >= lastTypedAt) return ` (blurred by ${lastBlur.by || 'the engine'})`;
    return ' (box kept)';
  };

  const flush = (t: number) => {
    if (w.keys >= MIN_KEYS_FOR_REPORT) {
      const lost = lostAny(w);
      if (lost || t - lastReport >= REPORT_QUIET_MS) {
        deps.report({ ...w, url: safePath(win), reason: lost ? 'lost' : 'periodic' });
        lastReport = t;
      }
    }
    flushed = sumWindows(flushed, w);
    w = emptyWindow();
    windowStart = t;
  };
  const tick = (t: number) => {
    for (const [box, list] of pending) {
      while (list.length && t - list[0].at >= SETTLE_MS) settle(list.shift()!, false);
      if (!list.length) pending.delete(box);
    }
    if (t - windowStart >= WINDOW_MS) flush(t);
  };
  const note = (list: string[], where: string) => { if (list.length < MAX_STACKS && !list.includes(where)) list.push(where); };

  // Who prevents a typed key: read only while that key's own dispatch runs.
  const EventProto = (win as Window & typeof globalThis).Event?.prototype;
  const realPrevent = EventProto?.preventDefault;
  if (EventProto && realPrevent) {
    EventProto.preventDefault = function preventDefault(this: Event) {
      // Known by the event itself, not by which listener saw it first: a page listener on the
      // window's capture phase runs before any of this module's own (2026-11-11: the gate's
      // eater on window capture was named only "a listener before the page's own").
      if (this.type === 'keydown' && !preventers.has(this) && isTypedKey(this as KeyboardEvent)) {
        preventers.set(this, callerOf(new Error().stack));
      }
      return realPrevent.call(this);
    };
  }

  const onKeyCapture = (e: Event) => {
    const k = e as KeyboardEvent;
    if (!isPrintable(k)) return;
    const t = deps.now();
    // The caret keeper moved this key into the replacement of the box typed in: that box's key.
    const rescued = !isTextBox(k.target) && isTextBox(doc.activeElement);
    if (!isTextBox(k.target) && !rescued) {
      // Typing went on, but the caret is no longer in a box.
      if (t - lastTypedAt < OFF_BOX_MS) { w.offBox++; note(w.offBoxAt, `${describe(doc.activeElement)}${whyOff()}`); }
      return;
    }
    const box = (rescued ? doc.activeElement : k.target) as EventTarget;
    lastTypedAt = t;
    lastBox = box as Element;
    tick(t);
    w.keys++;
    if (rescued) w.rescued++;
    const list = pending.get(box) ?? [];
    list.push({ at: t, ev: k });
    pending.set(box, list);
  };
  /** A key's end, once its dispatch is over (its input event came, or it never will). */
  const settle = (p: PendingKey, inserted: boolean) => {
    if (p.ev.defaultPrevented) { w.prevented++; note(w.preventedBy, preventers.get(p.ev) ?? 'a listener before the page\'s own'); }
    else if (inserted) w.inserted++;
    else w.dropped++;
  };
  const onInput = (e: Event) => {
    const ie = e as InputEvent;
    if (!isTextBox(e.target)) return;
    typedAt.set(e.target as EventTarget, deps.now());
    if (typeof ie.inputType === 'string' && !ie.inputType.startsWith('insert')) return;
    const list = pending.get(e.target as EventTarget);
    if (!list?.length) return;
    // One input event covers every key the engine coalesced into it.
    pending.delete(e.target as EventTarget);
    for (const p of list) settle(p, true);
  };

  // Code that sets a box's value and takes away what was just typed.
  const AreaProto = (win as Window & typeof globalThis).HTMLTextAreaElement?.prototype;
  const desc = AreaProto ? Object.getOwnPropertyDescriptor(AreaProto, 'value') : undefined;
  if (AreaProto && desc?.set && desc.get) {
    const get = desc.get;
    const set = desc.set;
    Object.defineProperty(AreaProto, 'value', {
      ...desc,
      set(this: HTMLTextAreaElement, next: string) {
        const at = typedAt.get(this);
        if (at !== undefined && next !== '' && deps.now() - at < TYPED_RECENT_MS) {
          const { taken, pick } = removedSpan(get.call(this) as string, String(next));
          if (taken > 0 && pick) w.picks++;
          else if (taken > 0) { w.overwrites++; w.overwrittenChars += taken; note(w.overwrittenBy, callerOf(new Error().stack)); }
        }
        set.call(this, next);
      },
    });
  }

  // A test browser reads the running window (tests/e2e/browser/composer-fast-typing.spec.ts).
  const probe = win as Window & { __walnutTypingIntegrity?: () => IntegrityWindow };
  if ((win.navigator as Navigator | undefined)?.webdriver) probe.__walnutTypingIntegrity = () => { tick(deps.now()); return sumWindows(flushed, w); };
  const onPress = () => { lastPressAt = deps.now(); };
  const onFocusOut = (e: Event) => {
    const f = e as FocusEvent;
    if (f.target !== lastBox || f.relatedTarget) return;
    // Past this listener's own frame (named or minified), what is left is the code that blurred.
    const frames = (new Error().stack ?? '').split('\n').filter((l) => l.trim() && !/^Error\b/.test(l.trim()));
    lastBlur = { at: deps.now(), by: frames.length > 1 ? callerOf(frames.slice(1).join('\n')) : '' };
  };
  doc.addEventListener('keydown', onKeyCapture, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('pointerdown', onPress, true);
  doc.addEventListener('mousedown', onPress, true);
  doc.addEventListener('focusout', onFocusOut, true);
  const timer = win.setInterval(() => tick(deps.now()), SETTLE_MS);
  return () => {
    doc.removeEventListener('keydown', onKeyCapture, true);
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('pointerdown', onPress, true);
    doc.removeEventListener('mousedown', onPress, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    win.clearInterval(timer);
    if (EventProto && realPrevent) EventProto.preventDefault = realPrevent;
    if (AreaProto && desc) Object.defineProperty(AreaProto, 'value', desc);
    installed = false;
  };
}

function safePath(win: Window): string {
  try { return win.location.pathname; } catch { return ''; }
}
