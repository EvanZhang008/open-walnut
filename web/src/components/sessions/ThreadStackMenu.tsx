/**
 * The stack's More menu (spec 5.6): its own trigger (`More`, aria-haspopup
 * menu) plus a portalled menu. Menu rules (web/src/AGENTS.md): portal to body,
 * placed by useMenuPlacement, pointerdown stops at the portal, no native
 * select, no submenus, and the outside-click closer exempts the drawer, the
 * toast, the confirm layer and the crumb menu.
 *
 * Page rows: `Rename…`, `Mark done` / `Reopen`, `Show in tree`, `Show all in
 * order` / `Back to questions`, red `Remove question…` (confirm follows) or
 * `Remove question` (no follow-ups, no confirm). Root rows: `Show all in
 * order` and `Show hidden questions (<n>)`. The only verb is Remove (C78).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ThreadStackMenuProps } from '@/components/sessions/thread-ui-contract';
import { ThreadConfirm, THREAD_OVERLAY_SELECTOR } from '@/components/sessions/ThreadConfirm';
import { ThreadCheckIcon, ThreadMoreIcon, ThreadReopenIcon, ThreadTrashIcon } from '@/components/sessions/ThreadIcons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { pluralFollowUps } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

export const REMOVE_CONFIRM_BODY = 'Walnut hides them from this view. The session transcript is owned by the CLI and keeps every message; you can still read them in Conversation Mode.';
export const removeQuestionTitle = (n: number): string => `Remove this question and ${pluralFollowUps(n)}?`;
/** Portals that are not "outside" for a thread menu. */
export const THREAD_MENU_EXEMPT = `${THREAD_OVERLAY_SELECTOR}, .thread-drawer, .thread-menu`;

export interface ThreadStackMenuExtraProps {
  /** The page's question is resolved (`Reopen` instead of `Mark done`). */
  resolved?: boolean;
  /** Done as the header button does it (confirm when follow-ups are open). */
  onDone?: () => void;
  className?: string;
}

interface Item {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  run: () => void;
}

export function ThreadStackMenu(props: ThreadStackMenuProps & ThreadStackMenuExtraProps) {
  const { variant, threadKey, visibleDescendants, hiddenCount, viewMode, actions } = props;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const place = useMenuPlacement(open, triggerRef, menuRef, { minHeight: 60, onAnchorLost: close });

  const linear = viewMode === 'linear';
  const items: Item[] = [];
  const orderItem: Item = linear
    ? { id: 'back-to-questions', label: 'Tree Mode', run: props.onBackToQuestions }
    : { id: 'show-all', label: 'Conversation Mode', run: props.onShowAllInOrder };
  if (variant === 'page' && threadKey !== undefined) {
    if (props.onRename) items.push({ id: 'rename', label: 'Rename…', run: props.onRename });
    items.push(props.resolved
      ? { id: 'reopen', label: 'Reopen', icon: <ThreadReopenIcon size={13} />, run: () => { void actions.reopen(threadKey); } }
      : { id: 'done', label: 'Mark done', icon: <ThreadCheckIcon size={13} />, run: props.onDone ?? (() => { void actions.done(threadKey); }) });
    items.push({ id: 'show-in-tree', label: 'Show in tree', run: props.onShowInTree });
    items.push(orderItem);
    items.push({
      id: 'remove', danger: true, icon: <ThreadTrashIcon size={13} />,
      label: visibleDescendants > 0 ? 'Remove question…' : 'Remove question',
      run: () => { if (visibleDescendants > 0) setConfirming(true); else void actions.remove(threadKey); },
    });
  } else {
    items.push(orderItem);
    if (hiddenCount > 0) items.push({ id: 'show-hidden', label: `Show hidden questions (${hiddenCount})`, run: props.onShowHidden });
  }

  // Outside click closes; the drawer, toast, confirm and crumb menu are exempt.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t) || t.closest(THREAD_MENU_EXEMPT)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus the first item once placed (keyboard users land in the menu).
  useEffect(() => {
    if (!open || !place) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open, place]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };

  const run = (item: Item) => {
    setOpen(false);
    item.run();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={props.className ? `thread-stack-more ${props.className}` : 'thread-stack-more'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((o) => !o)}
      >
        <ThreadMoreIcon size={14} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="thread-menu"
          role="menu"
          aria-label="More"
          style={menuPlacementStyle(place)}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger ? 'thread-menu-item thread-menu-item--danger' : 'thread-menu-item'}
              data-item={item.id}
              onClick={() => run(item)}
            >
              <span className="thread-menu-icon" aria-hidden="true">{item.icon}</span>
              <span className="thread-menu-label">{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {confirming && threadKey !== undefined && (
        <ThreadConfirm
          anchorEl={triggerRef.current}
          title={removeQuestionTitle(visibleDescendants)}
          body={REMOVE_CONFIRM_BODY}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          danger
          onConfirm={() => { setConfirming(false); void actions.remove(threadKey); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
