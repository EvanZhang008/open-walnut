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
 * The drawer's title is the AGENT SWITCHER. Each console agent (Walnut, Mentor,
 * Note Assistant, config-defined ones) keeps its own list of asks; the title
 * names the one on show and opens the list of the others, with their
 * descriptions. Picking an agent re-filters the list and re-targets New chat,
 * and leaves the drawer open — it is a filter, not a destination. With a single
 * agent the title is plain text.
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
import {
  askActivityAt, askState, holdOrder, matchesAskQuery, nextHeldOrder, printedStamp,
  type AskState, type HeldList, type HeldOrder,
} from '@open-walnut/ask-list';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import { ICON_SLIDERS } from '@/components/common/Icons';
import type { AskAgent } from './ask-walnut-slot-model';

/** A row in the drawer's list. The just-launched task is not in the store yet,
 *  so a row is `{ id, title }` plus the Task when the store has it. */
export interface DrawerRow {
  id: string;
  title: string;
  task?: Task;
}

const ICON_CHEVRON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="4,6 8,10 12,6" />
  </svg>
);

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
  /** The agent on show ("Ask Walnut", "Ask Mentor"), for the accessible name. */
  label: string;
}

/** The ≡ button. A forwardRef so the drawer can hand focus back to it on close. */
export const AskWalnutMenuButton = forwardRef<HTMLButtonElement, MenuButtonProps>(
  function AskWalnutMenuButton({ open, onToggle, label }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={`task-action-btn ask-walnut-menu-btn${open ? ' is-open' : ''}`}
        data-testid="ask-walnut-menu"
        aria-label={`${label} sessions`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Switch between your ${label} sessions, or switch agent`}
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
  /** Every console agent, Walnut first. One entry = no switcher. */
  agents: readonly AskAgent[];
  /** The agent whose asks `rows` are. */
  agent: AskAgent;
  onPickAgent: (agentId: string) => void;
  rows: DrawerRow[];
  /** True while the task list is still loading: the list says so instead of
   *  "no sessions yet", and the rows are not held until they have arrived. */
  loading?: boolean;
  /** null while the slot shows the composer or a pending launch. */
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
  onNew: () => void;
  /** Absent hides the link (no Walnut checkout on this machine). */
  onFixWalnut?: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function AskWalnutDrawer({
  open, onClose, returnFocusRef, agents, agent, onPickAgent, rows, loading = false, selectedTaskId, onPick, onNew,
  onFixWalnut, inspectorOpen, onToggleInspector,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  /** The agent list under the title. A gesture, reset on every open. */
  const [agentsOpen, setAgentsOpen] = useState(false);

  // Every open starts with an empty query and the agent list folded. Keyed on
  // `open` ALONE: the effect below re-runs whenever its callbacks change
  // identity, and a reset living there would wipe a query mid-typing the first
  // time a caller passes a per-render closure.
  useEffect(() => { if (open) { setQuery(''); setAgentsOpen(false); } }, [open]);

  // Switching agents is a new list: the query that filtered the old one would
  // otherwise hide the new one behind "No asks match".
  useEffect(() => { setQuery(''); }, [agent.id]);

  // Escape closes; focus moves into the search box on open so the keyboard is in
  // the drawer (typing filters at once) and the composer under the scrim stops
  // receiving keystrokes — and goes BACK on close, to whatever had it (the
  // composer) or, if that is gone, the ≡. preventDefault before stopPropagation:
  // the repo's Escape ownership convention (escape-beep-guard reads
  // defaultPrevented to know who consumed it). Escape peels one layer at a time:
  // an open agent list folds, then a non-empty query clears, then the drawer
  // closes. Both are read through refs so the listener does not have to be
  // re-bound on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;
  const agentsOpenRef = useRef(agentsOpen);
  agentsOpenRef.current = agentsOpen;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (agentsOpenRef.current) {
        setAgentsOpen(false);
        return;
      }
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

  // Rows hold the places they had when the list first appeared in this open
  // (shared `holdOrder`): a background ask that gets a message while the list is
  // on screen must not climb over the row the user is aiming at. They print the
  // stamp they had then too (`printedStamp`; a newcomer reads "New"), or a held
  // row continued since would read "just now" under "5mo ago". Advanced during
  // render, not in an effect, so the frame that first shows the rows already
  // holds them; `nextHeldOrder` waits for a loaded, non-empty list (a snapshot of
  // the empty list the drawer can open on made every row "new") and keeps one
  // snapshot per agent until the drawer closes. The next open shows the true
  // order with the real times.
  const openedWithRef = useRef<HeldOrder | null>(null);
  openedWithRef.current = nextHeldOrder(openedWithRef.current, {
    open, agentId: agent.id, rows: rows.map(heldRowView), loading,
  });
  const held = openedWithRef.current?.byAgent.get(agent.id);
  const ordered = useMemo(
    () => (held ? holdOrder(rows, held.ids) : rows),
    [rows, held],
  );

  const visible = useMemo(
    () => (query.trim() ? ordered.filter((r) => matchesAskQuery(r.title, query)) : ordered),
    [ordered, query],
  );

  if (!open) return null;

  const act = (fn: () => void) => () => { onClose(); fn(); };
  const canSwitch = agents.length > 1;

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
        aria-label={`${agent.project} sessions`}
        tabIndex={-1}
      >
        <div className="ask-walnut-drawer-head">
          {canSwitch ? (
            <button
              type="button"
              className={`ask-walnut-drawer-title ask-walnut-agent-switch${agentsOpen ? ' is-open' : ''}`}
              data-testid="ask-walnut-agent-switch"
              aria-haspopup="true"
              aria-expanded={agentsOpen}
              title="Switch agent"
              onClick={() => setAgentsOpen((v) => !v)}
            >
              {agent.project}
              <span className={`ask-walnut-agent-caret${agentsOpen ? ' is-open' : ''}`} aria-hidden="true">{ICON_CHEVRON}</span>
            </button>
          ) : (
            <span className="ask-walnut-drawer-title">{agent.project}</span>
          )}
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

        {/* The other agents, inline under the title (an accordion, not a
            portal: the drawer is already the overlay). Each row is the agent's
            name and what it is for; the one on show is pressed. Plain buttons in
            a group rather than a listbox: Tab reaches every row, and a listbox
            role would promise arrow-key handling this list does not have. A pick
            puts the keyboard back in the search box, on the new list. */}
        {canSwitch && agentsOpen && (
          <div
            className="ask-walnut-agent-list"
            role="group"
            aria-label="Agents"
            data-testid="ask-walnut-agent-list"
          >
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={a.id === agent.id}
                className={`ask-walnut-agent-item${a.id === agent.id ? ' is-selected' : ''}`}
                data-testid="ask-walnut-agent-item"
                data-agent-id={a.id}
                onClick={() => {
                  setAgentsOpen(false);
                  if (a.id !== agent.id) onPickAgent(a.id);
                  searchRef.current?.focus({ preventScroll: true });
                }}
              >
                <span className="ask-walnut-agent-name">{a.name}</span>
                {a.description && <span className="ask-walnut-agent-desc">{a.description}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="ask-walnut-drawer-search">
          <span className="ask-walnut-drawer-search-ic" aria-hidden="true">{'⌕'}</span>
          <input
            ref={searchRef}
            type="search"
            className="ask-walnut-drawer-search-input"
            data-testid="ask-walnut-search"
            placeholder="Search your asks"
            aria-label={`Search ${agent.project} sessions`}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="ask-walnut-drawer-list" role="group" aria-label="Your asks" data-testid="ask-walnut-drawer-list">
          {rows.length === 0 && !loading && (
            <p className="ask-walnut-drawer-empty">No {agent.project} sessions yet.</p>
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
              held={held}
              selected={row.id === selectedTaskId}
              onPick={() => { onClose(); onPick(row.id); }}
            />
          ))}
          {/* Until the board has loaded, an empty or short list is not the
              answer: say it is still coming rather than "no sessions yet". */}
          {loading && (
            <p className="ask-walnut-drawer-empty ask-walnut-drawer-loading" role="status" data-testid="ask-walnut-drawer-loading">
              <span className="spinner ask-walnut-pending-spinner" aria-hidden="true" />
              Loading your asks…
            </p>
          )}
        </div>

        <div className="ask-walnut-drawer-foot">
          <button
            type="button"
            className="ask-walnut-drawer-new"
            data-testid="ask-walnut-new"
            onClick={act(onNew)}
            title={`Start a new ${agent.project} session`}
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
                title="Open a session in Walnut's own source code to change or fix Walnut"
              >
                <span className="ask-walnut-drawer-link-ic" aria-hidden="true">{ICON_SLIDERS}</span> Customize Walnut
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A row as the shared snapshot reads it: the stamp the list SORTS by (the
 *  shared `askActivityAt`: the last message sent into the ask). */
function heldRowView(row: DrawerRow): { id: string; activityAt?: string } {
  const at = row.task ? askActivityAt(row.task) : undefined;
  return at ? { id: row.id, activityAt: at } : { id: row.id };
}

function DrawerItem({ row, held, selected, onPick }: {
  row: DrawerRow; held: HeldList | undefined; selected: boolean; onPick: () => void;
}) {
  // The stamp the row sorts by, so the times read in order down the list (it
  // used to print `updated_at` over a birth-ordered list, which put a "1d ago"
  // among the "1w ago" rows); while the order is held, the stamp it had then.
  const stamp = printedStamp(held, heldRowView(row));
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
      {stamp.kind === 'time' && <span className="ask-walnut-drawer-item-time">{timeAgo(stamp.at)}</span>}
      {stamp.kind === 'new' && (
        <span className="ask-walnut-drawer-item-time is-new" data-testid="ask-walnut-drawer-item-new">New</span>
      )}
    </button>
  );
}

/** The shared ask state as the board's circle classes (same colours): blue =
 *  a conversation that is not running, pulsing blue = running a turn, green =
 *  done, grey = no session yet. */
const STATE_CLASS: Record<AskState, string> = {
  idle: 'task-circle-session',
  running: 'task-circle-running',
  done: 'task-circle-done',
  todo: 'task-circle-todo',
};

/** The row's state as a dot: the shared `askState` fed the live session status
 *  (the phone gets the same rule from GET /api/v1/asks). Its own component
 *  because the live status is a store subscription. */
function TaskDot({ task }: { task: Task }) {
  const live = useSessionStatus(resolveTaskSessionId(task));
  const state = askState(task, live);
  return <span className={`ask-walnut-drawer-dot ${STATE_CLASS[state]}`} data-ask-state={state} aria-hidden="true" />;
}
