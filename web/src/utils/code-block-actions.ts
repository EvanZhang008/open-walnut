/**
 * The Copy and Wrap buttons of every rendered code block (utils/code-block.ts).
 *
 * One capturing document listener instead of a handler per block: the blocks
 * live inside HTML strings written with innerHTML on a dozen surfaces, and a
 * streaming reply rewrites its blocks on every delta, so nothing could hold a
 * per-element handler. Capturing, and stopped there, so a click on a button is
 * never also a click on the message row under it.
 *
 * Wrap is per block, for as long as the tab is open (a reload keeps it,
 * sessionStorage). A block's state hangs on its message's id
 * (`data-message-id` on the row) and its key (`data-md-code-key`,
 * code-block.ts), not on the element: a streaming
 * reply rebuilds its blocks on every delta, and a message's HTML is cached and
 * written again whenever its row remounts. One observer puts the state back on
 * every block the page inserts.
 */
import { copyTextRobust } from './clipboard';

const COPIED_MS = 1600;
const KEY_ATTR = 'data-md-code-key';
const WRAP_ATTR = 'data-wrap';
/** On a block with no line too long for it: its Wrap would do nothing, so it
 *  is not shown (code-block.css). */
const FITS_ATTR = 'data-fits';

/** Measures each block as it is laid out and whenever its size changes (a
 *  narrower window, a block still streaming). */
let fitObserver: ResizeObserver | null = null;
/** Each <pre>'s right padding as the stylesheet gives it. */
const basePad = new WeakMap<Element, number>();

/**
 * WebKit can give a <pre> its scrollbar track (6px) after the block around it
 * was laid out, and not lay the block out again: the block then cuts off the
 * code's bottom edge and the track. Seen from the <pre>'s own size change, the
 * block is told to lay out again (a style it reads as new).
 */
function keepFrameAroundCode(frame: Element, pre: Element): void {
  if (pre.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom <= 0.5) return;
  // Next frame, not from inside the observer: a size change made there is one
  // it would have to report again in the same frame (a "loop" error).
  requestAnimationFrame(() => {
    if (pre.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom <= 0.5) return;
    const style = (frame as HTMLElement).style;
    style.minHeight = style.minHeight ? '' : '0px';
  });
}

/** Blocks to measure again on the next frame (see the observer). */
const refits = new Set<Element>();

/** Writes only what changes: WebKit relays out a <pre> whose attributes were
 *  touched (even to the same value) without resizing the blocks around it,
 *  and a block then clipped its own bottom 6px, the scrollbar track. */
function setTabStop(pre: HTMLElement, on: boolean): void {
  const want = on ? '0' : '-1';
  if (pre.getAttribute('tabindex') !== want) pre.setAttribute('tabindex', want);
}

/** The box a block scrolls in (whether or not it scrolls yet), found once. */
const scrollBoxes = new WeakMap<Element, HTMLElement>();
function scrollBox(frame: Element): HTMLElement {
  let box = scrollBoxes.get(frame);
  if (box?.isConnected && box.contains(frame)) return box;
  box = undefined;
  for (let p = frame.parentElement; p && !box; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') box = p;
  }
  box ??= (document.scrollingElement ?? document.documentElement) as HTMLElement;
  scrollBoxes.set(frame, box);
  return box;
}

/** A block that fits in half the visible timeline: its header need not stick. */
function markShort(frame: Element): void {
  const short = frame.getBoundingClientRect().height <= scrollBox(frame).clientHeight / 2;
  if (frame.hasAttribute(SHORT_ATTR) !== short) frame.toggleAttribute(SHORT_ATTR, short);
}
const SHORT_ATTR = 'data-short';

function markFit(frame: Element): void {
  markShort(frame);
  const pre = frame.querySelector('pre');
  if (!pre) return;
  if (frame.hasAttribute(WRAP_ATTR)) {
    // Wrapped: its Wrap stays (to undo it), nothing scrolls sideways.
    setTabStop(pre, false);
    if (pre.style.paddingRight) pre.style.paddingRight = '';
    return;
  }
  // A line that only reaches into the right padding is whole on screen: no
  // Wrap, and that padding gives up the few pixels so nothing scrolls (a
  // scrollbar for 2px). The stylesheet's padding is read once, before any of
  // ours; the width it changes is inside the box, never the block's height.
  let pad = basePad.get(pre);
  if (pad === undefined) {
    pad = parseFloat(getComputedStyle(pre).paddingRight) || 0;
    basePad.set(pre, pad);
  }
  const ours = pre.style.paddingRight ? parseFloat(pre.style.paddingRight) : pad;
  const over = pre.scrollWidth - pre.clientWidth + (pad - ours);
  const fits = over <= Math.max(1, pad / 2);
  const want = fits && over > 0 ? `${Math.max(0, Math.floor(pad - over - 1))}px` : '';
  if (pre.style.paddingRight !== want) pre.style.paddingRight = want;
  if (frame.hasAttribute(FITS_ATTR) !== fits) frame.toggleAttribute(FITS_ATTR, fits);
  // A Tab stop only where the keyboard has something to scroll.
  setTabStop(pre, !fits);
  if (!fits && frame.hasAttribute('data-long')) keepRail(frame, pre);
}

/** A long block's sideways scrollbar that stays in sight (code-block.css):
 *  as wide as the code's scroll, scrolled with it both ways. */
function keepRail(frame: Element, pre: HTMLElement): void {
  let rail = frame.querySelector(':scope > .md-code-rail') as HTMLElement | null;
  if (!rail) {
    const r = document.createElement('div');
    r.className = 'md-code-rail';
    r.setAttribute('aria-hidden', 'true');
    r.tabIndex = -1;
    r.appendChild(document.createElement('div'));
    pre.after(r);
    // Down to the visible foot of the timeline, past its bottom padding
    // (where sticking stops on its own).
    const pad = parseFloat(getComputedStyle(scrollParent(frame)).paddingBottom) || 0;
    if (pad > 0) r.style.bottom = `${-pad}px`;
    // Each side ignores the scroll it was just given, so a late echo of an
    // earlier step never pulls the other side back.
    const sync = { toPre: -1, toRail: -1 };
    railSync.set(r, sync);
    r.addEventListener('scroll', () => {
      if (Math.abs(r.scrollLeft - sync.toRail) < 1) { sync.toRail = -1; return; }
      if (Math.abs(pre.scrollLeft - r.scrollLeft) < 1) return;
      sync.toPre = r.scrollLeft;
      pre.scrollLeft = r.scrollLeft;
    }, { passive: true });
    pre.addEventListener('scroll', () => {
      if (Math.abs(pre.scrollLeft - sync.toPre) < 1) { sync.toPre = -1; return; }
      if (Math.abs(r.scrollLeft - pre.scrollLeft) < 1) return;
      sync.toRail = pre.scrollLeft;
      r.scrollLeft = pre.scrollLeft;
    }, { passive: true });
    rail = r;
  }
  // The same scroll range as the code's, whatever the two boxes' widths.
  const inner = rail.firstElementChild as HTMLElement;
  const width = `${(rail.clientWidth || pre.clientWidth) + pre.scrollWidth - pre.clientWidth}px`;
  if (inner.style.width !== width) inner.style.width = width;
  if (Math.abs(rail.scrollLeft - pre.scrollLeft) >= 1) {
    const sync = railSync.get(rail);
    if (sync) sync.toRail = pre.scrollLeft;
    rail.scrollLeft = pre.scrollLeft;
  }
}

const railSync = new WeakMap<Element, { toPre: number; toRail: number }>();

/** The block's identity for its Wrap state: its message, then its place and
 *  first line there. Two replies that open with the same command are two
 *  blocks. Surfaces with no message id fall back to the block key alone. */
function stateKey(frame: Element): string {
  const key = frame.getAttribute(KEY_ATTR) ?? '';
  const msg = frame.closest('[data-message-id]')?.getAttribute('data-message-id');
  return msg ? `${msg}|${key}` : key;
}

const WRAPPED_STORE = 'walnut.codeBlocksWrapped';
const EXPANDED_STORE = 'walnut.codeBlocksExpanded';
const COLLAPSED_ATTR = 'data-collapsed';
/** Keys kept for a reload; the oldest go first. */
const WRAPPED_MAX = 200;

/** Keys of the blocks wrapped in this tab. */
const wrappedKeys = new Set<string>();
/** Long blocks the reader unfolded in this tab. */
const expandedKeys = new Set<string>();
/** Blocks seen while still streaming: they stay open when their fence closes
 *  (folding what the reader just watched arrive would yank the page). */
const seenOpen = new Set<string>();

function loadKeys(store: string, into: Set<string>): void {
  try {
    const saved = JSON.parse(sessionStorage.getItem(store) ?? '[]');
    if (Array.isArray(saved)) for (const k of saved) if (typeof k === 'string') into.add(k);
  } catch { /* none kept */ }
}

function saveKeys(store: string, keys: Set<string>): void {
  try {
    sessionStorage.setItem(store, JSON.stringify([...keys].slice(-WRAPPED_MAX)));
  } catch { /* storage off: this page only */ }
}

function loadWrapped(): void {
  loadKeys(WRAPPED_STORE, wrappedKeys);
  loadKeys(EXPANDED_STORE, expandedKeys);
}

function saveWrapped(): void {
  saveKeys(WRAPPED_STORE, wrappedKeys);
}

function applyWrap(frame: Element, on: boolean): void {
  if (frame.hasAttribute(WRAP_ATTR) === on) return;
  frame.toggleAttribute(WRAP_ATTR, on);
  // Its name stays "Wrap long lines"; pressed or not says the state.
  frame.querySelector('[data-md-code-action="wrap"]')?.setAttribute('aria-pressed', on ? 'true' : 'false');
}

let statusSeq = 0;

/** Copy is described by the block's status region, so "Copied" or the failure
 *  is read as Copy's own outcome. Ids are made here, per element: the same
 *  cached HTML can be on the page twice. */
function describeCopy(frame: Element): void {
  const status = frame.querySelector('.md-code-status');
  const copy = frame.querySelector('[data-md-code-action="copy"]');
  if (!status || !copy) return;
  if (!status.id) status.id = `md-code-status-${++statusSeq}`;
  if (copy.getAttribute('aria-describedby') !== status.id) copy.setAttribute('aria-describedby', status.id);
}

/** Give each block among `nodes` (and inside them) its own Wrap state, and
 *  have it measured. */
function adoptBlocks(nodes: Iterable<Node>): void {
  for (const n of nodes) {
    if (!(n instanceof Element)) continue;
    const frames = n.matches('.md-code') ? [n] : n.querySelectorAll(`.md-code[${KEY_ATTR}]`);
    for (const f of frames) {
      if (wrappedKeys.size > 0) applyWrap(f, wrappedKeys.has(stateKey(f)));
      if (f.hasAttribute('data-open')) seenOpen.add(stateKey(f));
      else if (f.hasAttribute('data-long')) {
        const k = stateKey(f);
        const folded = !expandedKeys.has(k) && !seenOpen.has(k);
        if (f.hasAttribute(COLLAPSED_ATTR) !== folded) f.toggleAttribute(COLLAPSED_ATTR, folded);
      }
      describeCopy(f);
      fitObserver?.observe(f);
      const pre = f.querySelector(':scope > pre');
      if (pre) fitObserver?.observe(pre, { box: 'border-box' });
    }
  }
}

/** The code as shown: no trailing newline, so a pasted shell command waits
 *  for Enter instead of running. `innerText` (what is drawn), not
 *  `textContent`: text hidden inside a block never reaches the clipboard. */
export function codeBlockText(frame: Element): string {
  const code = (frame.querySelector('pre code') ?? frame.querySelector('pre')) as HTMLElement | null;
  if (!code) return '';
  const shown = typeof code.innerText === 'string' ? code.innerText : code.textContent ?? '';
  return shown.replace(/\n+$/, '');
}

const resetTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** What to do with the selected code, short enough for a phone's header. */
function copyHint(): string {
  // Touch: holding the selection opens the system menu with Copy.
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 'Hold to copy';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Press \u2318C' : 'Press Ctrl+C';
}

/** Marks a block whose code was selected for the system copy gesture: the
 *  message selection bar (selection-quote.ts) leaves that selection alone, so
 *  it does not cover the hint. */
export const COPY_FALLBACK_ATTR = 'data-md-code-select-to-copy';

/** The block whose code a failed copy selected, and how to undo its hint. */
let failedHint: { frame: Element; reset: () => void } | null = null;

/** A failed copy's words: beside the buttons when the header has room for
 *  them; else they hang under it, whole, and the code moves down by their
 *  height (code-block.css), so they cover none of it. Placed again whenever
 *  the block's width changes. */
function placeWhy(frame: Element): void {
  const status = frame.querySelector('.md-code-status') as HTMLElement | null;
  const el = frame as HTMLElement;
  if (!status?.hasAttribute('data-visible')) {
    if (frame.hasAttribute(WHY_BELOW_ATTR)) {
      frame.removeAttribute(WHY_BELOW_ATTR);
      el.style.removeProperty('--md-code-why-h');
    }
    return;
  }
  frame.removeAttribute(WHY_BELOW_ATTR);
  if (status.scrollWidth > status.clientWidth + 1) {
    frame.setAttribute(WHY_BELOW_ATTR, '');
    el.style.setProperty('--md-code-why-h', `${status.offsetHeight}px`);
  } else el.style.removeProperty('--md-code-why-h');
}
const WHY_BELOW_ATTR = 'data-why-below';

function showCopyState(btn: HTMLElement, frame: Element, state: 'copied' | 'failed'): void {
  // Another block's "Press Ctrl+C" would now copy this block: it goes.
  if (failedHint && failedHint.frame !== frame) failedHint.reset();
  const label = btn.querySelector('.md-code-copy-label');
  const status = frame.querySelector('.md-code-status');
  btn.dataset.state = state;
  // The button keeps its width ("Copied" fits Copy's room, code-block.css), so
  // Wrap beside it never moves under the pointer. A failure is spelled out
  // beside the buttons, not inside one.
  // The outcome is read out once, from the status region; the button keeps
  // its name.
  if (label) label.textContent = state === 'copied' ? 'Copied' : 'Copy';
  if (status) {
    if (state === 'copied') status.textContent = 'Copied';
    else {
      // Read out whole and shown whole: what happened, then the step to take.
      const why = document.createElement('span');
      why.className = 'md-code-why';
      why.textContent = 'Copy failed, code selected. ';
      // The step stays on one line.
      const step = document.createElement('span');
      step.className = 'md-code-step';
      step.textContent = copyHint();
      status.replaceChildren(why, step);
    }
    status.toggleAttribute('data-visible', state === 'failed');
    placeWhy(frame);
  }
  const reset = () => {
    const t = resetTimers.get(btn);
    if (t) clearTimeout(t);
    resetTimers.delete(btn);
    delete btn.dataset.state;
    if (label) label.textContent = 'Copy';
    if (status) {
      status.textContent = '';
      status.removeAttribute('data-visible');
    }
    placeWhy(frame);
    frame.removeAttribute(COPY_FALLBACK_ATTR);
    if (failedHint?.frame === frame) failedHint = null;
  };
  const prev = resetTimers.get(btn);
  if (prev) clearTimeout(prev);
  resetTimers.delete(btn);
  // "Copied" is a moment. A failure's hint stays while what it says is true:
  // the code is still selected (onSelectionChange), so a reader who looked
  // away still finds the step to take.
  if (state === 'copied') resetTimers.set(btn, setTimeout(reset, COPIED_MS));
  failedHint = state === 'failed' ? { frame, reset } : (failedHint?.frame === frame ? null : failedHint);
}

/** The hint says the code is selected: once the selection leaves the block,
 *  it no longer is. */
function onSelectionChange(): void {
  if (!failedHint) return;
  const sel = window.getSelection();
  const inside = !!sel && sel.rangeCount > 0 && !sel.isCollapsed
    && failedHint.frame.contains(sel.getRangeAt(0).commonAncestorContainer);
  if (!inside) failedHint.reset();
}

/** No clipboard at all (plain-HTTP LAN page, old WebView): select the code so
 *  the system copy gesture takes it. */
function selectCode(frame: Element): void {
  const code = frame.querySelector('pre code') ?? frame.querySelector('pre');
  if (!code) return;
  frame.setAttribute(COPY_FALLBACK_ATTR, '');
  const range = document.createRange();
  range.selectNodeContents(code);
  // Stop before the block's last newline, as Copy does: a shell command
  // pasted from this selection waits for Enter too.
  let last: Node | null = code.lastChild;
  while (last && last.nodeType !== Node.TEXT_NODE) last = last.lastChild;
  if (last?.textContent?.endsWith('\n')) range.setEnd(last, last.textContent.length - 1);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function scrollParent(el: Element): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

/** Toggle this block's wrap without moving what the reader is looking at:
 *  from a header stuck mid-block, the block's top is off screen and it is the
 *  line under the header that stays put (by its share of the block's height).
 *  The same message shown twice (a split view) wraps in both places. */
/** The line of code at a height on screen, and how far into it that is. */
function lineAt(frame: Element, y: number): { line: Element; into: number } | null {
  for (const line of frame.querySelectorAll('.md-code-ln')) {
    const r = line.getBoundingClientRect();
    if (r.bottom > y && r.height > 0) return { line, into: Math.max(0, Math.min(1, (y - r.top) / r.height)) };
  }
  return null;
}

function toggleWrapKeepingPlace(frame: Element): void {
  const head = frame.querySelector('.md-code-head');
  const before = frame.getBoundingClientRect();
  const headRect = head?.getBoundingClientRect();
  const stuck = !!headRect && headRect.top > before.top + 2;
  const share = stuck && before.height > 0 ? (headRect!.bottom - before.top) / before.height : 0;
  // Stuck mid-block: the line just under the header stays just under it,
  // however many rows it takes before and after.
  const under = stuck ? lineAt(frame, headRect!.bottom + 1) : null;
  const on = !frame.hasAttribute(WRAP_ATTR);
  const key = frame.getAttribute(KEY_ATTR);
  if (key) {
    const state = stateKey(frame);
    if (on) wrappedKeys.add(state);
    else wrappedKeys.delete(state);
    saveWrapped();
    document.querySelectorAll(`.md-code[${KEY_ATTR}="${key}"]`).forEach((f) => {
      if (stateKey(f) === state) applyWrap(f, on);
    });
  }
  applyWrap(frame, on);
  markFit(frame);
  const after = frame.getBoundingClientRect();
  let drift: number;
  if (under) {
    const r = under.line.getBoundingClientRect();
    drift = r.top + under.into * r.height - (headRect!.bottom + 1);
  } else {
    const wantTop = stuck ? headRect!.bottom - share * after.height : before.top;
    drift = after.top - wantTop;
  }
  if (Math.abs(drift) >= 1) scrollParent(frame).scrollTop += drift;
}

/** Fold a long block again. The reader may be deep inside it, its header
 *  stuck to the top of the screen: the header stays where it is on screen
 *  (the page moves up to the block's top), never leaving them in the next
 *  message. Focus goes to "Show all", the button that undoes it. */
function foldKeepingPlace(frame: Element): void {
  const headTop = frame.querySelector('.md-code-head')?.getBoundingClientRect().top ?? 0;
  const k = stateKey(frame);
  expandedKeys.delete(k);
  seenOpen.delete(k);
  saveKeys(EXPANDED_STORE, expandedKeys);
  // Chromium's scroll anchoring would move the page again after this (by
  // the anchor it picked inside the old height): off for the fold.
  const scroller = scrollParent(frame);
  const anchor = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  frame.setAttribute(COLLAPSED_ATTR, '');
  const settle = () => {
    const drift = frame.getBoundingClientRect().top + 1 - headTop;
    if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
  };
  settle();
  (frame.querySelector('[data-md-code-action="expand"]') as HTMLElement | null)?.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    settle();
    scroller.style.overflowAnchor = anchor;
  });
}

/** The latest Copy press per block: an older press that settles later says nothing. */
const copyTurns = new WeakMap<Element, number>();

async function copyBlock(btn: HTMLElement, frame: Element): Promise<void> {
  const turn = (copyTurns.get(frame) ?? 0) + 1;
  copyTurns.set(frame, turn);
  // A failed copy moves focus and the selection around (clipboard.ts's
  // textarea, then the code selected here); an engine may scroll for either.
  // The reader stays where they clicked.
  const scroller = scrollParent(frame);
  const top = scroller.scrollTop;
  const result = await copyTextRobust(codeBlockText(frame));
  if (copyTurns.get(frame) !== turn) return;
  if (result === 'failed') {
    selectCode(frame);
    if (scroller.scrollTop !== top) scroller.scrollTop = top;
    showCopyState(btn, frame, 'failed');
  } else {
    showCopyState(btn, frame, 'copied');
  }
}

type Caret = { node: Node; offset: number };

/** The text position under a point (both engines' APIs). */
function caretAt(x: number, y: number): Caret | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** Install the listener; returns its remover. */
export function installCodeBlockActions(): () => void {
  loadWrapped();
  // Runs after layout and before paint: a block never shows a Wrap it then hides.
  fitObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      for (const e of entries) {
        if (!e.target.isConnected) {
          fitObserver?.unobserve(e.target); // removed (a streaming delta's old copy)
        } else if (e.target.tagName === 'PRE') {
          const frame = e.target.parentElement;
          if (frame) keepFrameAroundCode(frame, e.target);
        } else if (!basePad.has(e.target.querySelector('pre') as HTMLElement)) {
          // First sight, before its first paint: a block never shows a Wrap
          // it then hides.
          markFit(e.target);
        } else {
          // A resize. What markFit writes can move the scrollbar track and so
          // the block's own height, which this observer would have to report
          // again in this same frame (the "loop" error): next frame instead.
          if (refits.size === 0) requestAnimationFrame(() => {
            for (const f of refits) if (f.isConnected) { markFit(f); placeWhy(f); }
            refits.clear();
          });
          refits.add(e.target);
        }
      }
    })
    : null;
  adoptBlocks([document.documentElement]);

  const onClick = (ev: MouseEvent) => {
    const btn = (ev.target as Element | null)?.closest?.('[data-md-code-action]') as HTMLElement | null;
    if (!btn) return;
    const frame = btn.closest('.md-code');
    if (!frame) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.dataset.mdCodeAction === 'copy') void copyBlock(btn, frame);
    else if (btn.dataset.mdCodeAction === 'wrap') toggleWrapKeepingPlace(frame);
    else if (btn.dataset.mdCodeAction === 'expand') {
      frame.removeAttribute(COLLAPSED_ATTR);
      expandedKeys.add(stateKey(frame));
      saveKeys(EXPANDED_STORE, expandedKeys);
      // Focus stays in the block, on its code (the button is gone). A press
      // from the keyboard (no pointer: detail 0) shows its ring, which an
      // engine may not count as :focus-visible when script moves focus.
      const pre = frame.querySelector('pre') as HTMLElement | null;
      if (pre) {
        if (ev.detail === 0) {
          frame.setAttribute('data-kbd-focus', '');
          pre.addEventListener('blur', () => frame.removeAttribute('data-kbd-focus'), { once: true });
        }
        pre.focus({ preventScroll: true });
      }
    } else if (btn.dataset.mdCodeAction === 'fold') foldKeepingPlace(frame);
  };
  // Blocks are drawn unwrapped; a wrapped one gets its state back the moment
  // it is inserted (before the frame paints).
  // Dragging from the header (its words not selectable; stuck mid-block it
  // lies over the code) would start the selection at the block's first line,
  // maybe far off screen. The selection starts where the pointer first meets
  // the code instead, and follows it from there.
  const pressOnHead = (ev: MouseEvent): Element | null => {
    const t = ev.target as Element | null;
    const head = t?.closest?.('.md-code-head') ?? null;
    if (!head || t!.closest('[data-md-code-action]') || ev.button !== 0) return null;
    return head;
  };
  // The engine's own selection would start at the header: never let it begin.
  const onMouseDown = (ev: MouseEvent) => { if (pressOnHead(ev)) ev.preventDefault(); };
  // The drag is the header's own pointer (captured), so it keeps following
  // over an iframe or past the window's edge.
  const onPress = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse') return;
    const head = pressOnHead(ev) as HTMLElement | null;
    if (!head) return;
    const pre = head.parentElement?.querySelector(':scope > pre');
    if (!pre) return;
    const code = pre.querySelector('code');
    const onLabel = !!(ev.target as Element).closest('.md-code-lang');
    let anchor: Caret | null = null;
    const move = (e: PointerEvent) => {
      // It starts on the code itself: the <pre>'s padding above the first
      // line would read as that line's start.
      if (!anchor && code && e.clientY < code.getBoundingClientRect().top) return;
      const at = caretAt(e.clientX, e.clientY);
      if (!at || !pre.contains(at.node) || head.contains(at.node)) return;
      // On the first line the pointer reaches: from its start when pressed
      // on the language, else from the column the press was in.
      if (!anchor) {
        const x = onLabel && code ? code.getBoundingClientRect().left + 1 : ev.clientX;
        const from = caretAt(x, e.clientY);
        anchor = from && pre.contains(from.node) && !head.contains(from.node) ? from : at;
      }
      window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, at.node, at.offset);
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('lostpointercapture', up);
    };
    try { head.setPointerCapture(ev.pointerId); } catch { /* the pointer is gone */ }
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('lostpointercapture', up);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) if (r.addedNodes.length > 0) adoptBlocks(r.addedNodes);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', onPress, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('selectionchange', onSelectionChange);
  // A taller or shorter window changes which blocks are short; their own
  // size (observed above) may not change.
  let resizing = 0;
  const onResize = () => {
    if (resizing) return;
    resizing = requestAnimationFrame(() => {
      resizing = 0;
      document.querySelectorAll(`.md-code[${KEY_ATTR}]`).forEach(markShort);
    });
  };
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
    if (resizing) cancelAnimationFrame(resizing);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('pointerdown', onPress, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    observer.disconnect();
    fitObserver?.disconnect();
    fitObserver = null;
    document.removeEventListener('click', onClick, true);
  };
}
