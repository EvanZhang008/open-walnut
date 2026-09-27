/**
 * The question path in the stack row (spec 5.3, depth >= 2): `Main / t1 / … /
 * parent`, in the SAME 36px row as the back button (it never adds a line).
 * Each segment is capped at 180px (120px in a narrow column) and ellipsized.
 * Narrower than 720px, or more than 3 segments: the middle ones fold into a
 * `…` button whose portalled menu lists them. Under 560px the header hides the
 * path and opens `ThreadPathMenu` (all ancestors, nearest first) from a long
 * press or right click on the back button instead.
 *
 * Menus follow web/src/AGENTS.md: portal to body, useMenuPlacement,
 * pointerdown stops at the portal, outside click exempts the other thread
 * portals.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { THREAD_OVERLAY_SELECTOR } from '@/components/sessions/ThreadConfirm';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY, type ThreadNode } from '@/utils/thread-tree';

export const CRUMB_FOLD_WIDTH = 720;
export const CRUMB_NARROW_SEGMENT = 120;
export const CRUMB_SEGMENT = 180;
const MENU_EXEMPT = `${THREAD_OVERLAY_SELECTOR}, .thread-drawer`;

export interface PathItem {
  key: string;
  label: string;
}

/** Labels of the ancestors of the page (root first, page excluded). */
export function pathItems(path: readonly ThreadNode[], index: ThreadMetaIndex): PathItem[] {
  return path.slice(0, -1).map((n) => ({
    key: n.key,
    label: n.key === ROOT_THREAD_KEY ? 'Main' : displayTitleOf(n, index).title,
  }));
}

/** Pure fold rule: which segments stay and which go into `…`. */
export function foldCrumbs(items: readonly PathItem[], panelWidth: number): { shown: PathItem[]; folded: PathItem[]; foldAt: number } {
  const fold = items.length > 2 && (panelWidth < CRUMB_FOLD_WIDTH || items.length > 3);
  if (!fold) return { shown: [...items], folded: [], foldAt: -1 };
  return { shown: [items[0], items[items.length - 1]], folded: items.slice(1, -1), foldAt: 1 };
}

export interface ThreadPathMenuProps {
  anchorEl: HTMLElement | null;
  items: PathItem[];
  label: string;
  onPick: (key: string) => void;
  onClose: () => void;
}

export function ThreadPathMenu({ anchorEl, items, label, onPick, onClose }: ThreadPathMenuProps) {
  const triggerRef = useMemo(() => ({ current: anchorEl }), [anchorEl]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const place = useMenuPlacement(true, triggerRef, menuRef, { align: 'start', minHeight: 60, onAnchorLost: onClose });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (menuRef.current?.contains(t) || anchorEl?.contains(t) || t.closest(MENU_EXEMPT)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchorEl]);
  useEffect(() => {
    if (place) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [place]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchorEl?.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="thread-menu thread-path-menu"
      role="menu"
      aria-label={label}
      style={menuPlacementStyle(place)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKey}
    >
      {items.map((it) => (
        <button key={it.key || 'root'} type="button" role="menuitem" className="thread-menu-item" title={it.label}
          onClick={() => { onClose(); onPick(it.key); }}>
          <span className="thread-menu-label">{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export interface ThreadStackCrumbsProps {
  path: readonly ThreadNode[];
  index: ThreadMetaIndex;
  panelWidth: number;
  onPopTo: (key: string) => void;
}

export function ThreadStackCrumbs({ path, index, panelWidth, onPopTo }: ThreadStackCrumbsProps) {
  const items = useMemo(() => pathItems(path, index), [path, index]);
  const { shown, folded, foldAt } = foldCrumbs(items, panelWidth);
  const [menuOpen, setMenuOpen] = useState(false);
  const foldRef = useRef<HTMLButtonElement | null>(null);
  const maxW = panelWidth < CRUMB_FOLD_WIDTH ? CRUMB_NARROW_SEGMENT : CRUMB_SEGMENT;

  const segs = shown.map((it) => (
    <button key={it.key || 'root'} type="button" className="thread-stack-crumb" style={{ maxWidth: maxW }}
      title={it.key === ROOT_THREAD_KEY ? 'Main conversation' : it.label} onClick={() => onPopTo(it.key)}>
      <span className="thread-stack-crumb-text">{it.label}</span>
    </button>
  ));
  if (foldAt >= 0) {
    segs.splice(foldAt, 0, (
      <button key="fold" ref={foldRef} type="button" className="thread-stack-crumb thread-stack-crumb--fold"
        aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`${folded.length} more`} title={folded.map((f) => f.label).join(' / ')}
        onClick={() => setMenuOpen((o) => !o)}>
        …
      </button>
    ));
  }
  return (
    <nav className="thread-stack-crumbs" aria-label="Question path">
      {segs.map((s, i) => (
        <span key={i} className="thread-stack-crumb-slot">
          {i > 0 && <span className="thread-stack-crumb-sep" aria-hidden="true">/</span>}
          {s}
        </span>
      ))}
      {menuOpen && (
        <ThreadPathMenu anchorEl={foldRef.current} items={folded} label="Question path" onPick={onPopTo} onClose={() => setMenuOpen(false)} />
      )}
    </nav>
  );
}
