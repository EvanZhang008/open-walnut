/**
 * CodeContextMenu — the right-click menu for code-reading surfaces (the Files
 * viewer's render modes and the Changed tab's diff), replacing the browser
 * menu with the actions those surfaces already support:
 *
 *   Copy               — the current selection
 *   Ask about this     — quote the selection into the session chat (prefill)
 *   Find references    — the selected identifier (or the word under the cursor)
 *   Find in file       — open the ⌘F bar prefilled with the selection/word
 *
 * Items whose ingredient is missing (no selection / no identifier / no handler
 * wired) don't render — a menu of disabled rows helps nobody. Anchored at the
 * pointer via useMenuPlacement's anchorPoint mode (the menus hard rules).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

export interface CodeContextTarget {
  point: { x: number; y: number };
  /** Trimmed selected text ('' when the click landed outside a selection). */
  selText: string;
  /** Identifier for reference lookup: the selection when it IS one, else the
   *  word under the pointer. Null when neither qualifies. */
  symbol: string | null;
  /** 1-based line of the click, when the surface can resolve one. */
  line?: number;
}

interface Props {
  target: CodeContextTarget;
  onClose: () => void;
  onCopy?: (text: string) => void;
  /** Quote the selection into chat. Absent = surface has no chat hook. */
  onAsk?: (text: string, line?: number) => void;
  onFindReferences?: (symbol: string, line?: number) => void;
  /** Open the in-file search bar prefilled. */
  onFindInFile?: (query: string) => void;
}

/** Middle-truncate a symbol/selection for a menu label (newlines collapsed —
 *  a multi-line selection must not blow the row open). */
function short(s: string, max = 24): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function CodeContextMenu({ target, onClose, onCopy, onAsk, onFindReferences, onFindInFile }: Props) {
  // anchorPoint mode: the menu anchors to the click coordinates, so this ref is
  // deliberately never attached to an element — it only satisfies the hook
  // signature. Callers must hold `target` in STATE (a fresh object every render
  // would put the placement hook in a reposition loop).
  const anchorRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef, { anchorPoint: target.point });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    // Capture-phase listener. NOTE: stopPropagation does NOT silence sibling
    // window-capture listeners (that would need stopImmediatePropagation and
    // registration order on our side), so one Esc may also close a reference
    // panel that is open underneath — acceptable: Esc means "dismiss".
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const run = (fn: () => void) => () => { fn(); onClose(); };

  const { selText, symbol, line } = target;
  // A multi-line selection can never match in-file search (the text index has
  // no newlines) — fall back to the identifier for that action.
  const findQuery = (selText && !selText.includes('\n') ? selText : symbol) || '';
  const items: Array<{ key: string; label: React.ReactNode; hint?: string; action: () => void }> = [];
  if (selText && onCopy) items.push({ key: 'copy', label: 'Copy', action: () => onCopy(selText) });
  if (selText && onAsk) items.push({ key: 'ask', label: 'Ask about this', action: () => onAsk(selText, line) });
  if (symbol && onFindReferences) {
    items.push({
      key: 'refs',
      label: <>Find references <code>{short(symbol)}</code></>,
      hint: '⌘Click',
      action: () => onFindReferences(symbol, line),
    });
  }
  if (findQuery && onFindInFile) {
    items.push({
      key: 'find',
      label: <>Find in file <code>{short(findQuery)}</code></>,
      hint: '⌘F',
      action: () => onFindInFile(findQuery),
    });
  }
  // Nothing applicable → render nothing. NOTE this is a last-resort guard, not
  // the native-menu fallback: by the time we run, the caller already called
  // preventDefault(). The "no items → browser's own menu" contract lives in the
  // CALLERS, which gate on buildCodeContextTarget() returning null BEFORE
  // preventing the event — keep the emptiness decision there.
  if (!items.length) return null;

  // stopPropagation on mouse events everywhere below: the menu portals to
  // document.body but React events still bubble through the REACT tree to the
  // owning surface's own onMouseUp/onMouseDown (selection pill, cmd+click,
  // selection-match repaint) — same trap SelectionAskPill documents.
  const stopMouse = {
    onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
    onMouseDown: (e: React.SyntheticEvent) => e.stopPropagation(),
    onMouseUp: (e: React.SyntheticEvent) => e.stopPropagation(),
  };

  return createPortal(
    <>
      {/* code-ctx-backdrop lifts the z-index above fullscreen panels (the
          shared cal backdrop sits at 999, BELOW .open-walnut-fullscreen /
          .fv-fullscreen) — otherwise outside-click never reaches it there. */}
      <div
        className="cal-popover-backdrop code-ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        {...stopMouse}
      />
      <div
        className="cal-ctx-menu code-ctx-menu"
        ref={menuRef}
        // The inline zIndex must beat .fv-fullscreen (10000) and
        // .file-viewer-overlay (9999) — menuPlacementStyle's default 9999 ties
        // or loses inside those, leaving an invisible menu on a dead click.
        style={{ ...menuPlacementStyle(placement), zIndex: 10010 }}
        role="menu"
        data-testid="code-ctx-menu"
        onContextMenu={(e) => e.preventDefault()}
        {...stopMouse}
      >
        {items.map((it) => (
          <button key={it.key} role="menuitem" onClick={run(it.action)}>
            <span className="code-ctx-label">{it.label}</span>
            {it.hint && <span className="code-ctx-hint">{it.hint}</span>}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/**
 * Build the menu target for a contextmenu event over a code surface: the
 * selection when the click landed inside it, else the word under the pointer.
 * Returns null when the surface has nothing to offer there (caller then lets
 * the NATIVE menu open — never a dead right-click).
 */
export function buildCodeContextTarget(
  e: { clientX: number; clientY: number; target: EventTarget | null },
  container: HTMLElement,
  wordAt: (doc: Document, x: number, y: number) => { word: string; node: Text } | null,
  symbolRe: RegExp,
  resolveLine?: (node: Node) => number | undefined,
): CodeContextTarget | null {
  const sel = window.getSelection();
  let selText = '';
  let selInside = false;
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    if (container.contains(range.commonAncestorContainer)) {
      selText = sel.toString().trim();
      selInside = true;
    }
  }
  const hit = wordAt(document, e.clientX, e.clientY);
  const hitWord = hit && container.contains(hit.node) ? hit.word : null;
  // Symbol preference: a selection that IS an identifier wins (precise intent),
  // else the word under the pointer.
  const symbol = selText && symbolRe.test(selText) ? selText : hitWord;
  if (!selText && !symbol) return null;
  const lineNode = selInside && sel!.rangeCount ? sel!.getRangeAt(0).startContainer : hit?.node;
  const line = lineNode && resolveLine ? resolveLine(lineNode) : undefined;
  return { point: { x: e.clientX, y: e.clientY }, selText, symbol, line };
}
