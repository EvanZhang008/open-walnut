/**
 * ContextMenu — Walnut's OWN right-click menu, for any surface that is an app
 * object rather than a document (tabs, rows, icons, message bubbles).
 *
 * Why a shared one: four surfaces had each hand-rolled a portal + clamp + Escape
 * + backdrop (notes tree, session file tree, code view, calendar), and every new
 * surface either copied ~80 lines or shipped the browser menu instead. This is
 * the same behaviour once:
 *
 *   · placed by `useMenuPlacement` (measured flip + viewport clamp + height cap,
 *     so a long menu near the bottom edge scrolls instead of hanging off it),
 *   · portalled to <body> so a scroll container can't clip it,
 *   · a backdrop that swallows the NEXT right-click too (a second right-click
 *     elsewhere moves the menu instead of stacking two),
 *   · Escape / outside-click / scroll dismissal — a cursor anchor is a frozen
 *     viewport point, so once the page scrolls it no longer points at its row,
 *   · arrow-key + Home/End navigation with Enter to run the focused item.
 *
 * `useContextMenu` is the call-site half: it holds the target and applies the
 * keep-the-native-menu rules (`utils/context-menu.ts`). Typical use is two lines:
 *
 *   const menu = useContextMenu<Row>()
 *   <div onContextMenu={(e) => menu.open(e, row)} />
 *   {menu.state && <ContextMenu point={menu.state.point} items={…} onClose={menu.close} />}
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import {
  keepNativeContextMenu,
  normalizeContextMenuItems,
  type ContextMenuItem,
} from '@/utils/context-menu';

export { normalizeContextMenuItems };
export type { ContextMenuItem };

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface ContextMenuProps {
  point: ContextMenuPoint;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Accessible name — say what the menu acts on ("Note tab actions"). */
  ariaLabel?: string;
  testId?: string;
}

const isFocusable = (item: ContextMenuItem) =>
  !item.divider && !item.section && !item.info && !item.disabled && !!item.onSelect;

export function ContextMenu({ point, items, onClose, ariaLabel, testId }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // useMenuPlacement takes a trigger ref for the button path; a context menu has
  // no trigger element, only the cursor, so the ref stays empty by design.
  const noTrigger = useRef<HTMLElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rows = useMemo(() => normalizeContextMenuItems(items), [items]);
  // align 'left' = the menu's LEFT edge sits at the cursor and it opens
  // rightward, which is the platform convention (and never covers the row the
  // click landed on). The hook still flips/clamps at the viewport edges.
  const placement = useMenuPlacement(true, noTrigger, menuRef, { anchorPoint: point, align: 'left', gap: 2 });

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Dismissal. Scroll closes outright: the anchor is a viewport point, so after
  // a scroll the menu would describe a row that has moved out from under it.
  //
  // The scroll dismisser arms ONE FRAME LATE, and that delay is load-bearing: it
  // is what stops the menu from dismissing ITSELF on its own opening. Opening a
  // menu re-renders its host row, and when that row lives in a scroll container
  // the commit can clamp the container's scrollTop, which fires `scroll` — so the
  // menu vanished a few milliseconds after it appeared. Measured on the main
  // list's project header (menu mounted at t=4175ms, `scroll` on
  // `.todo-panel-list` at t=4183, menu gone at t=4186), where it surfaced as a
  // right-click that intermittently produced no menu at all, and as a menu whose
  // rows a test could see and then not find. The settle scroll belongs to the
  // mount commit's own frame, so anything arriving in a LATER frame is a real
  // scroll and still closes; a user cannot scroll inside the frame in which their
  // own right-click opened the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    let scrollArmed = false;
    const arm = requestAnimationFrame(() => { scrollArmed = true; });
    const onScroll = (e: Event) => {
      if (!scrollArmed) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      cancelAnimationFrame(arm);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = useCallback((delta: number) => {
    setFocusIndex((current) => {
      const focusables = rows.map((row, index) => (isFocusable(row) ? index : -1)).filter((i) => i >= 0);
      if (!focusables.length) return -1;
      const position = focusables.indexOf(current);
      const next = position === -1
        ? (delta > 0 ? 0 : focusables.length - 1)
        : (position + delta + focusables.length) % focusables.length;
      return focusables[next];
    });
  }, [rows]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Home') { e.preventDefault(); setFocusIndex(rows.findIndex(isFocusable)); return; }
    if (e.key === 'End') {
      e.preventDefault();
      const last = [...rows].reverse().findIndex(isFocusable);
      setFocusIndex(last === -1 ? -1 : rows.length - 1 - last);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const row = rows[focusIndex];
      if (row && isFocusable(row)) { e.preventDefault(); row.onSelect?.(); onClose(); }
    }
  };

  return createPortal(
    <>
      <div
        className="wn-context-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={menuRef}
        className="wn-context-menu"
        style={menuPlacementStyle(placement)}
        role="menu"
        aria-label={ariaLabel}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        // A right-click INSIDE the menu must not open the browser's menu on top
        // of ours, and must not close it either (that reads as a mis-click).
        onContextMenu={(e) => e.preventDefault()}
        // Menu-portal hard rule (web/src/AGENTS.md): React events bubble through
        // portals into the OWNING component tree, so without this a press inside
        // the menu reaches a dnd-kit activator row and arms a drag of that row.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {rows.map((row, index) => {
          if (row.divider) return <div key={row.key ?? `div-${index}`} className="wn-context-menu-divider" />;
          if (row.section) {
            return (
              <div key={row.key ?? `sec-${index}`} className="wn-context-menu-section">{row.label}</div>
            );
          }
          if (row.info) {
            return (
              <div key={row.key ?? `info-${index}`} className="wn-context-menu-info" title={row.title}>
                {row.icon && <span className="wn-context-menu-icon">{row.icon}</span>}
                <span className="wn-context-menu-label">{row.label}</span>
              </div>
            );
          }
          return (
            <button
              key={row.key ?? `item-${index}`}
              type="button"
              role="menuitem"
              className={`wn-context-menu-item${row.danger ? ' danger' : ''}${focusIndex === index ? ' focused' : ''}`}
              disabled={row.disabled}
              title={row.title}
              onMouseEnter={() => setFocusIndex(index)}
              onClick={(e) => {
                e.stopPropagation();
                row.onSelect?.();
                onClose();
              }}
            >
              {row.icon && <span className="wn-context-menu-icon">{row.icon}</span>}
              <span className="wn-context-menu-label">{row.label}</span>
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

export interface ContextMenuState<T> {
  point: ContextMenuPoint;
  payload: T;
}

/**
 * Call-site half of the pair: holds the open menu's cursor point + payload and
 * enforces the native-menu exemptions. `open` returns false when it deliberately
 * let the browser menu through, so a caller can log/branch on it.
 */
export function useContextMenu<T = undefined>(options: { overrideLinks?: boolean } = {}) {
  const { overrideLinks } = options;
  const [state, setState] = useState<ContextMenuState<T> | null>(null);

  const open = useCallback((event: ReactMouseEvent | MouseEvent, payload: T): boolean => {
    const target = event.target as Element | null;
    const scope = (event.currentTarget as Element | null) ?? null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (keepNativeContextMenu(target, {
      selectionText: selection && !selection.isCollapsed ? selection.toString() : '',
      selectionAnchor: selection?.anchorNode ?? null,
      scope,
      overrideLinks,
    })) {
      return false;
    }
    event.preventDefault();
    // Don't let an ancestor row open its own menu for the same click — the
    // innermost surface owns the gesture (nested rows: message inside a column).
    event.stopPropagation();
    setState({ point: { x: event.clientX, y: event.clientY }, payload });
    return true;
  }, [overrideLinks]);

  const close = useCallback(() => setState(null), []);

  return { state, open, close, isOpen: state !== null };
}
