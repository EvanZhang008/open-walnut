import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useEffect } from 'react';
import { tokenizeUrls } from '@/utils/url-display';

/**
 * Plain-text editor whose URLs display COLLAPSED (ellipsized pill) until the
 * caret enters them — then they expand to the full text for editing, and
 * re-collapse when the caret leaves. Built for the session-note editor
 * (2026-07-30: "paste 的时候把 link 变小,但所有的 Edit 还在;Cursor 进到里面
 * 它还是会展开").
 *
 * Why contentEditable and not <textarea>: a textarea cannot style ranges of its
 * value, so a long URL always occupies its full width there. Here the URL's
 * characters all stay in the DOM (copy/select/caret behave normally); collapsing
 * is pure CSS (max-width + ellipsis on the span), so nothing is ever lost.
 *
 * Model: `value` (plain text incl. '\n') is the single source of truth. The DOM
 * is a FLAT list: text nodes (newlines as literal '\n' under pre-wrap), one
 * <span.cue-url> per URL, plus a sentinel <br> iff the text ends with '\n'
 * (pre-wrap won't render a trailing newline without it; the sentinel counts as
 * zero-length when reading back). The DOM is rebuilt only when the URL SET
 * changes — ordinary prose typing edits text nodes in place (native undo/IME
 * intact); typing that creates/destroys/edits a URL triggers a rebuild with
 * caret restoration.
 */

export interface CollapsibleUrlEditorHandle {
  /** Focus the editor with the caret at the end. */
  focus(): void;
}

interface CollapsibleUrlEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}

const isBr = (n: Node): boolean => n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'BR';

/** Flattened text of a node tree; <br> counts as '\n'. */
function flatText(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
  if (isBr(n)) return '\n';
  let t = '';
  n.childNodes.forEach((c) => { t += flatText(c); });
  return t;
}

/** Read the model text back from the DOM (drops the trailing sentinel <br>). */
function domToText(root: HTMLElement): string {
  let t = '';
  root.childNodes.forEach((c) => { t += flatText(c); });
  const last = root.childNodes[root.childNodes.length - 1];
  if (last && isBr(last)) t = t.slice(0, -1);
  return t;
}

/** Text offset of a DOM position, measured by cloning the range's contents. */
function offsetAt(root: HTMLElement, container: Node, off: number, textLen: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  try { r.setEnd(container, off); } catch { return textLen; }
  let n = 0;
  const walk = (x: Node) => {
    if (x.nodeType === Node.TEXT_NODE) n += (x.textContent ?? '').length;
    else if (isBr(x)) n += 1;
    else x.childNodes.forEach(walk);
  };
  walk(r.cloneContents());
  return Math.min(n, textLen); // clamps a position after the sentinel <br>
}

/** Place a collapsed caret at a text offset. */
function setCaret(root: HTMLElement, offset: number) {
  const sel = document.getSelection();
  if (!sel) return;
  let remaining = offset;
  const place = (n: Node): boolean => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? '').length;
      if (remaining <= len) { sel.setPosition(n, remaining); return true; }
      remaining -= len;
      return false;
    }
    if (isBr(n)) {
      // Caret positions around a <br> live on the parent as child indices.
      const p = n.parentNode!;
      const idx = Array.prototype.indexOf.call(p.childNodes, n);
      if (remaining <= 0) { sel.setPosition(p, idx); return true; }
      remaining -= 1;
      if (remaining <= 0) { sel.setPosition(p, idx + 1); return true; }
      return false;
    }
    for (const c of Array.from(n.childNodes)) if (place(c)) return true;
    return false;
  };
  for (const c of Array.from(root.childNodes)) if (place(c)) return;
  sel.setPosition(root, root.childNodes.length); // end (or empty editor)
}

/** Identity of the URL set — rebuild only when this changes. */
const urlSig = (text: string): string =>
  tokenizeUrls(text).filter((t) => t.kind === 'url').map((t) => t.href).join(' ');

export const CollapsibleUrlEditor = forwardRef<CollapsibleUrlEditorHandle, CollapsibleUrlEditorProps>(
  function CollapsibleUrlEditor({ value, onChange, placeholder, className }, handle) {
    const rootRef = useRef<HTMLDivElement>(null);
    const sigRef = useRef<string>(''); // never matches → first render builds
    const composingRef = useRef(false);
    const normalizingRef = useRef(false);

    const rebuild = (text: string, caret: number | null) => {
      const root = rootRef.current!;
      const frag = document.createDocumentFragment();
      for (const t of tokenizeUrls(text)) {
        if (t.kind === 'url') {
          const s = document.createElement('span');
          s.className = 'cue-url';
          s.textContent = t.text;
          frag.appendChild(s);
        } else {
          frag.appendChild(document.createTextNode(t.text));
        }
      }
      if (text.endsWith('\n')) frag.appendChild(document.createElement('br'));
      root.replaceChildren(frag);
      sigRef.current = urlSig(text);
      if (caret != null) setCaret(root, Math.min(caret, text.length));
    };

    // External value changes (session switch, mic transcribe, prop lag) — only
    // rebuild when the DOM genuinely disagrees, so per-keystroke re-renders
    // (value echoing what onInput just reported) never touch the DOM.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root || composingRef.current) return;
      if (domToText(root) !== value) {
        rebuild(value, document.activeElement === root ? value.length : null);
      }
    }, [value]);

    // Caret offset of the current selection, or null when it's outside us.
    const selectionOffsets = (): [number, number] | null => {
      const root = rootRef.current;
      const sel = document.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
      const len = domToText(root).length;
      const a = offsetAt(root, r.startContainer, r.startOffset, len);
      const b = offsetAt(root, r.endContainer, r.endOffset, len);
      return a <= b ? [a, b] : [b, a];
    };

    const syncFromDom = () => {
      const root = rootRef.current!;
      const text = domToText(root);
      if (urlSig(text) !== sigRef.current) {
        // A URL was created/destroyed/edited — re-wrap the spans.
        const offs = selectionOffsets();
        rebuild(text, offs ? offs[1] : null);
      }
      onChange(text);
    };

    const handleInput = () => {
      if (composingRef.current) return;
      syncFromDom();
    };

    // Enter → literal '\n' through the model. Left to the browser it inserts
    // <div>/<br> soup whose shape differs per engine; one deterministic path
    // keeps domToText/setCaret honest.
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
      e.preventDefault();
      const root = rootRef.current!;
      const offs = selectionOffsets();
      const text = domToText(root);
      const [a, b] = offs ?? [text.length, text.length];
      const next = text.slice(0, a) + '\n' + text.slice(b);
      rebuild(next, a + 1);
      onChange(next);
    };

    // Paste as plain text through the model (also collapses a pasted URL
    // immediately — the headline use case).
    const handlePaste = (e: React.ClipboardEvent) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text/plain');
      if (!pasted) return;
      const root = rootRef.current!;
      const offs = selectionOffsets();
      const text = domToText(root);
      const [a, b] = offs ?? [text.length, text.length];
      const next = text.slice(0, a) + pasted + text.slice(b);
      rebuild(next, a + pasted.length);
      onChange(next);
    };

    // Expand the URL the caret is inside; collapse the rest. Runs on every
    // selectionchange while mounted (cheap: a handful of spans).
    useEffect(() => {
      const onSelectionChange = () => {
        const root = rootRef.current;
        if (!root || normalizingRef.current) return;
        const spans = Array.from(root.querySelectorAll<HTMLElement>('.cue-url'));
        if (spans.length === 0) return;
        const offs = document.activeElement === root ? selectionOffsets() : null;
        if (!offs) { spans.forEach((s) => s.classList.remove('cue-active')); return; }
        const [lo, hi] = offs;

        // Walk top-level flat structure to get each span's [start, end).
        let off = 0;
        const sel = document.getSelection();
        for (const child of Array.from(root.childNodes)) {
          const len = flatText(child).length;
          if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList?.contains('cue-url')) {
            const el = child as HTMLElement;
            const start = off, end = off + len;
            // Caret strictly inside (or a range overlapping) → expanded.
            const active = lo === hi ? lo > start && lo < end : lo < end && hi > start;
            el.classList.toggle('cue-active', active);
            // A caret at the span's exact BOUNDARY belongs outside it: Chrome
            // would otherwise grow the URL when you type right after the pill.
            if (lo === hi && sel && el.contains(sel.anchorNode) && (lo === start || lo === end)) {
              normalizingRef.current = true;
              const r = document.createRange();
              if (lo === start) r.setStartBefore(el); else r.setStartAfter(el);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
              normalizingRef.current = false;
            }
          }
          off += len;
        }
      };
      document.addEventListener('selectionchange', onSelectionChange);
      return () => document.removeEventListener('selectionchange', onSelectionChange);
    }, []);

    useImperativeHandle(handle, () => ({
      focus() {
        const root = rootRef.current;
        if (!root) return;
        root.focus();
        setCaret(root, domToText(root).length);
      },
    }), []);

    return (
      <div
        ref={rootRef}
        className={className}
        // plaintext-only blocks rich insertions in Chrome/Safari; unsupporting
        // engines still work — paste/Enter are normalized above anyway.
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; syncFromDom(); }}
        onBlur={() => {
          rootRef.current?.querySelectorAll('.cue-active').forEach((s) => s.classList.remove('cue-active'));
        }}
      />
    );
  },
);
