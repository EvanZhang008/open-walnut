/**
 * The question path as a menu: every ancestor of the page, nearest first. The
 * stack row's back button opens it from a long press or a right click in a
 * narrow column. The path itself is drawn by Tree Mode's path bar
 * (ThreadPathBar.tsx), which replaced the crumbs that used to sit in this row.
 *
 * Menus follow web/src/AGENTS.md: portal to body, useMenuPlacement,
 * pointerdown stops at the portal, Escape and an outside press close it
 * through the one overlay layer (the other thread portals count as inside).
 */
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { THREAD_OVERLAY_SELECTOR } from '@/components/sessions/ThreadConfirm';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY, type ThreadNode } from '@/utils/thread-tree';

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
  // Escape gives the focus back to the back button. No focus trap: Tab leaves the menu (onKey).
  useOverlayLayer({
    passOutsideClick: true,
    open: true,
    refs: [menuRef, triggerRef],
    exemptSelectors: [MENU_EXEMPT],
    trapFocus: false,
    onClose: (reason) => { onClose(); if (reason === 'escape') anchorEl?.focus({ preventScroll: true }); },
  });
  useEffect(() => {
    if (place) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [place]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="thread-menu thread-path-menu wn-overlay wn-menu"
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
