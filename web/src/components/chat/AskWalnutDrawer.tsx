/**
 * The Ask Walnut slot's session switcher: a ≡ button at the top-left of the
 * panel header, and the drawer it opens.
 *
 * The slot renders the ORDINARY session panel — same header, same chips, same
 * composer as a session column. The one thing it adds is this button, which
 * slides a drawer in from the left over the panel, the way the Claude app's
 * sidebar does: quick actions on top, the recent asks below, "New chat" pinned
 * to the bottom. Picking an ask (or an action) closes the drawer.
 *
 * The drawer is an overlay INSIDE the slot (absolute, inset 0), never a portal:
 * the slot has a definite height and clips itself, so the drawer can neither
 * overflow the viewport nor collide with the page. Its list scrolls internally.
 * Nothing here owns slot state; every choice is a callback.
 */

import { forwardRef, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useTaskCircle } from '@/hooks/useSessionStatus';

/** A row in the drawer's recents list. The just-launched task is not in the
 *  store yet, so a row is `{ id, title }` plus the Task when the store has it. */
export interface DrawerRow {
  id: string;
  title: string;
  task?: Task;
}

const ICON_MENU = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
    <line x1="2.5" y1="8" x2="13.5" y2="8" />
    <line x1="2.5" y1="11.5" x2="10" y2="11.5" />
  </svg>
);

interface MenuButtonProps {
  open: boolean;
  onToggle: () => void;
}

/** The ≡ button. A forwardRef so the slot can anchor its "+ Task" popover to it
 *  (the popover's own trigger lives inside the drawer, which unmounts on pick). */
export const AskWalnutMenuButton = forwardRef<HTMLButtonElement, MenuButtonProps>(
  function AskWalnutMenuButton({ open, onToggle }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={`task-action-btn ask-walnut-menu-btn${open ? ' is-open' : ''}`}
        data-testid="ask-walnut-menu"
        aria-label="Ask Walnut sessions"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Switch between your Ask Walnut sessions"
        onClick={onToggle}
      >
        {ICON_MENU}
      </button>
    );
  },
);

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Where focus goes back to on close when the element that had it is gone —
   *  the ≡ button. Without a restore, a user who opened the drawer from the
   *  composer and pressed Escape kept typing into <body>. */
  returnFocusRef: RefObject<HTMLElement | null>;
  rows: DrawerRow[];
  /** null while the slot shows the composer or a pending launch. */
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
  onNew: () => void;
  onOpenTaskComposer: () => void;
  onOpenDraftColumn: () => void;
  /** The session finder overlay. Absent hides the row. */
  onOpenSessionFinder?: () => void;
  onFixWalnut?: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onCloseChat: () => void;
}

export function AskWalnutDrawer({
  open, onClose, returnFocusRef, rows, selectedTaskId, onPick, onNew,
  onOpenTaskComposer, onOpenDraftColumn, onOpenSessionFinder, onFixWalnut,
  inspectorOpen, onToggleInspector, onCloseChat,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the drawer on open so the keyboard is in it
  // and the composer under the scrim stops receiving keystrokes — and goes BACK
  // on close, to whatever had it (the composer) or, if that is gone, the ≡.
  // preventDefault before stopPropagation: the repo's Escape ownership
  // convention (escape-beep-guard reads defaultPrevented to know who consumed it).
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      const target = previous && previous.isConnected && previous !== document.body
        ? previous
        : returnFocusRef.current;
      target?.focus({ preventScroll: true });
    };
  }, [open, onClose, returnFocusRef]);

  // Keep the selected ask on screen when the list is long.
  useEffect(() => {
    if (!open || !selectedTaskId) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-task-id="${selectedTaskId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedTaskId]);

  if (!open) return null;

  const act = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <div
      className="ask-walnut-drawer-layer"
      data-testid="ask-walnut-drawer-layer"
      // Portals escape clipping, not bubbling — and this is not even a portal.
      // The stop keeps a click in the drawer out of any drag sensor above.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ask-walnut-scrim" data-testid="ask-walnut-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ask-walnut-drawer"
        data-testid="ask-walnut-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Ask Walnut sessions"
        tabIndex={-1}
      >
        <div className="ask-walnut-drawer-head">
          <span className="ask-walnut-drawer-title">Ask Walnut</span>
          <button
            type="button"
            className="task-action-btn ask-walnut-drawer-close"
            onClick={onClose}
            aria-label="Close the session list"
            title="Close"
          >
            &times;
          </button>
        </div>

        <div className="ask-walnut-drawer-actions" role="group" aria-label="Quick actions">
          <button
            type="button"
            className="ask-walnut-drawer-action"
            data-testid="ask-walnut-task"
            onClick={act(onOpenTaskComposer)}
            title="Create a task without starting a session"
          >
            <span className="ask-walnut-drawer-ic" aria-hidden="true">+</span> Task
          </button>
          <button
            type="button"
            className="ask-walnut-drawer-action"
            data-testid="ask-walnut-session-draft"
            onClick={act(onOpenDraftColumn)}
            title="Open a new coding session draft"
          >
            <span className="ask-walnut-drawer-ic" aria-hidden="true">+</span> Session
          </button>
          {onOpenSessionFinder && (
            <button
              type="button"
              className="ask-walnut-drawer-action"
              data-testid="ask-walnut-sessions"
              onClick={act(onOpenSessionFinder)}
              title="Find a session by title, folder or content"
            >
              <span className="ask-walnut-drawer-ic" aria-hidden="true">{'⌕'}</span> Find sessions
            </button>
          )}
          {onFixWalnut && (
            <button
              type="button"
              className="ask-walnut-drawer-action"
              data-testid="ask-walnut-fix"
              onClick={act(onFixWalnut)}
              title="Describe what's broken — opens a session in Walnut's own checkout"
            >
              <span className="ask-walnut-drawer-ic" aria-hidden="true">{'\u{1F527}'}</span> Fix Walnut
            </button>
          )}
          <button
            type="button"
            className={`ask-walnut-drawer-action${inspectorOpen ? ' is-active' : ''}`}
            data-testid="ask-walnut-inspector"
            aria-pressed={inspectorOpen}
            onClick={act(onToggleInspector)}
            title={inspectorOpen ? 'Hide the launch context' : "Show the selected session's launch context"}
          >
            <span className="ask-walnut-drawer-ic" aria-hidden="true">{'◎'}</span> Context
          </button>
          <button
            type="button"
            className="ask-walnut-drawer-action"
            data-testid="ask-walnut-hide"
            onClick={act(onCloseChat)}
            title="Hide Ask Walnut"
          >
            <span className="ask-walnut-drawer-ic" aria-hidden="true">{'←'}</span> Hide Ask Walnut
          </button>
        </div>

        <div className="ask-walnut-drawer-section">Recents</div>
        <div className="ask-walnut-drawer-list" role="group" aria-label="Recent Ask Walnut sessions" data-testid="ask-walnut-drawer-list">
          {rows.length === 0 && (
            <p className="ask-walnut-drawer-empty">No Ask Walnut sessions yet.</p>
          )}
          {rows.map((row) => (
            <DrawerItem
              key={row.id}
              row={row}
              selected={row.id === selectedTaskId}
              onPick={() => { onClose(); onPick(row.id); }}
            />
          ))}
        </div>

        <div className="ask-walnut-drawer-foot">
          <button
            type="button"
            className="ask-walnut-drawer-new"
            data-testid="ask-walnut-new"
            onClick={act(onNew)}
            title="Start a new Ask Walnut session"
          >
            <span aria-hidden="true">+</span> New chat
          </button>
        </div>
      </div>
    </div>
  );
}

function DrawerItem({ row, selected, onPick }: { row: DrawerRow; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`ask-walnut-drawer-item${selected ? ' is-selected' : ''}`}
      data-testid="ask-walnut-drawer-item"
      data-task-id={row.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onPick}
      title={row.title}
    >
      {row.task ? <TaskDot task={row.task} /> : <span className="ask-walnut-drawer-dot task-circle-session" aria-hidden="true" />}
      <span className="ask-walnut-drawer-item-title">{row.title}</span>
    </button>
  );
}

/** The same live circle class the board rows use (running / attached / done), as
 *  a dot. Its own component because the class is a store subscription. */
function TaskDot({ task }: { task: Task }) {
  const cls = useTaskCircle(task);
  return <span className={`ask-walnut-drawer-dot ${cls}`} aria-hidden="true" />;
}

/**
 * The "+ Task" popover — portalled to <body> and placed by useMenuPlacement,
 * anchored to the ≡ button (its trigger row lives in the drawer, which closes on
 * pick, so the row cannot be the anchor).
 *
 * It used to be a hand-placed `position: absolute; top: 100%` box inside a
 * header that lived in an `overflow: hidden` slot: a form taller than the room
 * below was CLIPPED, with its Create/Cancel buttons unreachable and no
 * scrollbar to reach them (the menus-and-overlays rules in web/src/AGENTS.md).
 * The hook measures the real height, flips up when there is more room above,
 * clamps to the viewport and hands back a `maxHeight` that the wrapper's
 * `overflow-y: auto` turns into an internal scroll.
 *
 * Portals escape clipping, not bubbling — hence the pointerdown stop, so the form
 * can never reach a drag sensor above it in the React tree.
 */
export function AskWalnutTaskPopover(
  { open, anchorRef, onAnchorLost, children }: {
    open: boolean;
    anchorRef: RefObject<HTMLButtonElement | null>;
    /** The ≡ left the DOM while the form was open (the panel went fullscreen,
     *  which hides its leading slot): close the form rather than leave it
     *  floating over the overlay anchored to nothing. */
    onAnchorLost: () => void;
    children: ReactNode;
  },
) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 'left': the anchor is the top-left ≡ button, so the popover opens RIGHTWARD
  // from it — right-aligning would push it off the slot's left edge.
  const placement = useMenuPlacement(open, anchorRef, menuRef, { align: 'left', onAnchorLost });
  // The hook only reports an anchor that is still referenced but detached or
  // zero-sized; an UNMOUNTED anchor nulls the ref and the hook goes quiet. A
  // light poll while open covers that case.
  const onAnchorLostRef = useRef(onAnchorLost);
  onAnchorLostRef.current = onAnchorLost;
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      if (!anchorRef.current?.isConnected) onAnchorLostRef.current();
    }, 250);
    return () => clearInterval(id);
  }, [open, anchorRef]);
  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="ask-walnut-task-popover"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
