/**
 * The Ask Walnut slot's session switcher: a ≡ button at the start of the panel
 * header's title row, and the drawer it opens.
 *
 * The slot renders the ORDINARY session panel — same header, same chips, same
 * window controls (×, popout, fullscreen) as a session column. The one thing it
 * adds is this button, which slides a drawer in from the left over the panel,
 * the way the Claude app's sidebar does: a search box, the asks below it, "New
 * chat" pinned to the bottom. Picking an ask closes the drawer.
 *
 * Deliberately NOT a launcher for anything else (user, 2026-09-07): there is one
 * concept, a task that may have a session, and one place to create one, the
 * draft column. So no "+ Task" / "+ Session" rows, no separate finder overlay
 * (the search box filters THIS list), and no "hide" row (the panel's own × does
 * that, as in every column).
 *
 * The drawer is an overlay INSIDE the slot (absolute, inset 0), never a portal:
 * the slot has a definite height and clips itself, so the drawer can neither
 * overflow the viewport nor collide with the page. Its list scrolls internally.
 * Nothing here owns slot state; every choice is a callback.
 */

import { forwardRef, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Task } from '@open-walnut/core';
import { useTaskCircle } from '@/hooks/useSessionStatus';
import { timeAgo } from '@/utils/time';

/** A row in the drawer's list. The just-launched task is not in the store yet,
 *  so a row is `{ id, title }` plus the Task when the store has it. */
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

/** The ≡ button. A forwardRef so the drawer can hand focus back to it on close. */
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
  /** Absent hides the link (no Walnut checkout on this machine). */
  onFixWalnut?: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

/** Case- and whitespace-insensitive "every word of the query appears in the
 *  title", so `deploy ios` finds "iOS build 73 deploy". */
function matches(title: string, query: string): boolean {
  const hay = title.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function AskWalnutDrawer({
  open, onClose, returnFocusRef, rows, selectedTaskId, onPick, onNew,
  onFixWalnut, inspectorOpen, onToggleInspector,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  // Every open starts with an empty query. Keyed on `open` ALONE: the effect
  // below re-runs whenever its callbacks change identity, and a reset living
  // there would wipe a query mid-typing the first time a caller passes a
  // per-render closure.
  useEffect(() => { if (open) setQuery(''); }, [open]);

  // Escape closes; focus moves into the search box on open so the keyboard is in
  // the drawer (typing filters at once) and the composer under the scrim stops
  // receiving keystrokes — and goes BACK on close, to whatever had it (the
  // composer) or, if that is gone, the ≡. preventDefault before stopPropagation:
  // the repo's Escape ownership convention (escape-beep-guard reads
  // defaultPrevented to know who consumed it). A non-empty query is cleared by
  // the first Escape; the second one closes. The query is read through a ref so
  // the listener does not have to be re-bound on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (queryRef.current) {
        setQuery('');
        return;
      }
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

  const visible = useMemo(
    () => (query.trim() ? rows.filter((r) => matches(r.title, query)) : rows),
    [rows, query],
  );

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

        <div className="ask-walnut-drawer-search">
          <span className="ask-walnut-drawer-search-ic" aria-hidden="true">{'⌕'}</span>
          <input
            ref={searchRef}
            type="search"
            className="ask-walnut-drawer-search-input"
            data-testid="ask-walnut-search"
            placeholder="Search your asks"
            aria-label="Search Ask Walnut sessions"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="ask-walnut-drawer-list" role="group" aria-label="Your asks" data-testid="ask-walnut-drawer-list">
          {rows.length === 0 && (
            <p className="ask-walnut-drawer-empty">No Ask Walnut sessions yet.</p>
          )}
          {/* role=status: a screen reader typing in the search box hears when the
              list filtered down to nothing. */}
          {rows.length > 0 && visible.length === 0 && (
            <p className="ask-walnut-drawer-empty" role="status" data-testid="ask-walnut-search-empty">No asks match &ldquo;{query.trim()}&rdquo;.</p>
          )}
          {visible.map((row) => (
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
          {/* Two links about THIS surface, not launchers: what Walnut sends the
              session (Context) and a shortcut into Walnut's own checkout (Fix). */}
          <div className="ask-walnut-drawer-links">
            <button
              type="button"
              className={`ask-walnut-drawer-link${inspectorOpen ? ' is-active' : ''}`}
              data-testid="ask-walnut-inspector"
              aria-pressed={inspectorOpen}
              onClick={act(onToggleInspector)}
              title={inspectorOpen ? 'Hide the launch context' : "Show the selected session's launch context"}
            >
              <span aria-hidden="true">{'◎'}</span> Context
            </button>
            {onFixWalnut && (
              <button
                type="button"
                className="ask-walnut-drawer-link"
                data-testid="ask-walnut-fix"
                onClick={act(onFixWalnut)}
                title="Describe what's broken — opens a session in Walnut's own checkout"
              >
                <span aria-hidden="true">{'\u{1F527}'}</span> Fix Walnut
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DrawerItem({ row, selected, onPick }: { row: DrawerRow; selected: boolean; onPick: () => void }) {
  // Last activity, not birth: the list is in birth order (stable under the
  // cursor), and the stamp on the right is the "when did I last touch this"
  // hint the Claude sidebar gives.
  const when = row.task?.updated_at || row.task?.created_at;
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
      {when && <span className="ask-walnut-drawer-item-time">{timeAgo(when)}</span>}
    </button>
  );
}

/** The same live circle class the board rows use (running / attached / done), as
 *  a dot. Its own component because the class is a store subscription. */
function TaskDot({ task }: { task: Task }) {
  const cls = useTaskCircle(task);
  return <span className={`ask-walnut-drawer-dot ${cls}`} aria-hidden="true" />;
}
