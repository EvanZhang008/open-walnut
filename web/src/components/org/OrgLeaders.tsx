/**
 * The leaders under a VP (org-leaders.ts), drawn the same way under a row of the Org list and in a
 * VP card of the Org chart: one quiet line, "▸ 6 leaders", folded until it is clicked (2026-11-20,
 * the user: "by default it should be collapsed ... super customer friendly"). Opened, each of the
 * VP's projects that has leaders gives its name, then its leaders: a state dot, the title (a click
 * opens the task beside the page), the eye when he watches it, and "leads N". A leader with leaders
 * under it has its own ▸, folded too. Each fold is kept (usePageViewOf), per surface. A watched task
 * stays where it hangs today as well (OrgChannelList KeptChildren): it shows in both places.
 *
 * A search that finds a leader shows the folds above it open while it does, without touching the
 * kept folds; a click on a fold the search opened closes it for that search only.
 *
 * In the list everything here is an option of the list's listbox (all it may hold), so a fold's state
 * is in its words and Right and Left work it; in the chart the toggles are plain disclosure buttons.
 */
import { useState, type KeyboardEvent } from 'react';
import { ICON_EYE } from '@/components/common/Icons';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { useOpenTask } from '@/hooks/useOpenTask';
import { domId } from './OrgChartVp';
import { TAB_DOT } from './org-task-tabs';
import { leaderTotal, leadersLabel, leadersMatch, subsMatch, type LeaderGroup, type LeaderNode } from './org-leaders';
import '@/styles/org-leaders.css';

type Surface = 'list' | 'chart';

/** A fold kept per key, shown open while a search finds something under it. A click on a fold the
 *  search opened closes it for that search only; the kept fold changes only when nothing forces it. */
function useFold(surface: Surface, name: string, key: string, found: boolean, query: string): [boolean, (open: boolean) => void] {
  const [kept, setKept] = usePageViewOf('org', `${surface}.${name}`, key, false, isBoolean);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const forced = found && closedFor !== query;
  const open = kept || forced;
  const set = (next: boolean) => {
    if (next === open) return;
    if (next) { setClosedFor(null); if (!forced) setKept(true); return; }
    if (kept) setKept(false);
    if (found) setClosedFor(query);
  };
  return [open, set];
}

/** Right opens, Left folds: the keys a tree's row takes. */
function foldKeys(open: boolean, set: (v: boolean) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && !open) { e.preventDefault(); e.stopPropagation(); set(true); }
    else if (e.key === 'ArrowLeft' && open) { e.preventDefault(); e.stopPropagation(); set(false); }
  };
}

/** The list's option props (its listbox holds options only); none in the chart. */
const asOption = (inList: boolean, foldable: boolean) => (inList
  ? { role: 'option', 'aria-selected': false, ...(foldable ? { 'aria-keyshortcuts': 'ArrowRight ArrowLeft' } : {}) }
  : {});

interface RowProps {
  leader: LeaderNode;
  depth: number;
  surface: Surface;
  query: string;
  openTaskIds?: ReadonlySet<string> | undefined;
  onOpen: (taskId: string) => void;
}

function LeaderRow({ leader: l, depth, surface, query, openTaskIds, onOpen }: RowProps) {
  const hasSubs = l.subs.length > 0;
  const [open, setOpen] = useFold(surface, 'leaders.sub', l.id, hasSubs && subsMatch(l, query), query);
  const subsId = domId(`org-leaders-${surface}-subs`, l.id);
  const inList = surface === 'list';
  const state = USER_STATE_LABELS[l.state];
  const foldWords = hasSubs ? `, ${open ? 'leaders under it shown' : 'leaders under it folded'}` : '';
  return (
    <>
      <div
        className="org-leader"
        role="presentation"
        data-testid="org-leader"
        data-task-id={l.id}
        data-state={l.state}
        data-depth={depth}
        data-open={openTaskIds?.has(l.id) || undefined}
        style={depth ? { paddingLeft: `min(${14 * depth}px, 40%)` } : undefined}
      >
        {hasSubs ? (
          <button
            type="button"
            className="org-leader-fold"
            data-testid="org-leader-fold"
            // In the list the option carries the fold (Right, Left); in the chart this is its button.
            {...(inList ? { 'aria-hidden': true, tabIndex: -1 } : { 'aria-expanded': open, ...(open ? { 'aria-controls': subsId } : {}), 'aria-label': `Leaders under ${l.title}` })}
            title={open ? 'Hide the leaders under it' : 'Show the leaders under it'}
            onClick={() => setOpen(!open)}
          >{open ? '▾' : '▸'}</button>
        ) : <span className="org-leader-fold is-none" aria-hidden="true" />}
        <button
          type="button"
          className="org-leader-open"
          data-testid="org-leader-open"
          {...asOption(inList, hasSubs)}
          aria-current={openTaskIds?.has(l.id) || undefined}
          aria-label={`${l.title}: ${state}, leads ${l.leads}${l.watched ? ', watched' : ''}${foldWords}`}
          title={`${l.title}: ${state}`}
          onClick={() => onOpen(l.id)}
          onKeyDown={hasSubs ? foldKeys(open, setOpen) : undefined}
        >
          <i style={{ background: TAB_DOT[l.state] }} aria-hidden="true" />
          <span className="org-leader-title">{l.title}</span>
          {l.watched && <span className="org-leader-eye" data-testid="org-leader-eye" title="Watched" aria-hidden="true">{ICON_EYE}</span>}
          <span className="org-leader-leads" data-testid="org-leader-leads">leads {l.leads}</span>
        </button>
      </div>
      {hasSubs && open && (
        <div id={subsId} role={inList ? 'group' : undefined} className="org-leader-subs">
          {l.subs.map((s) => <LeaderRow key={s.id} leader={s} depth={depth + 1} surface={surface} query={query} openTaskIds={openTaskIds} onOpen={onOpen} />)}
        </div>
      )}
    </>
  );
}

interface Props {
  groups: readonly LeaderGroup[];
  surface: Surface;
  /** The VP's row or card key: its fold is kept under it. */
  vpKey: string;
  vpName: string;
  /** The list's search: a leader it finds is shown, the folds above it open while it does. */
  query?: string;
  openTaskIds?: ReadonlySet<string>;
  /** Before a task opens (the chart closes itself: the task opens beside the page). */
  onLeave?: () => void;
}

export function OrgLeaders({ groups, surface, vpKey, vpName, query = '', openTaskIds, onLeave }: Props) {
  const openTask = useOpenTask();
  const [open, setOpen] = useFold(surface, 'leaders', vpKey, leadersMatch(groups, query), query);
  const total = leaderTotal(groups);
  if (!total) return null;
  const listId = domId(`org-leaders-${surface}`, vpKey);
  const inList = surface === 'list';
  const onOpen = (taskId: string) => { onLeave?.(); openTask(taskId); };
  return (
    <div
      className={`org-leaders is-${surface}`}
      role={inList ? 'group' : undefined}
      aria-label={inList ? `Leaders under ${vpName}` : undefined}
      data-testid="org-leaders"
      data-key={vpKey}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="org-leaders-toggle"
        data-testid="org-leaders-toggle"
        data-open={open}
        {...asOption(inList, true)}
        {...(inList
          ? { 'aria-label': `${leadersLabel(total)} under ${vpName}, ${open ? 'shown' : 'folded'}` }
          : { 'aria-expanded': open, ...(open ? { 'aria-controls': listId } : {}) })}
        title={`Tasks under ${vpName} that lead their own team`}
        onClick={() => setOpen(!open)}
        onKeyDown={foldKeys(open, setOpen)}
      >
        <span className="org-leaders-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {leadersLabel(total)}
      </button>
      {open && (
        <div id={listId} className="org-leaders-list" data-testid="org-leaders-list">
          {groups.map((g) => (
            <div key={g.key} className="org-leaders-group" role={inList ? 'group' : undefined} aria-label={inList ? g.name : undefined} data-testid="org-leaders-group" data-project={g.project}>
              <div className="org-leaders-project" data-testid="org-leaders-project" aria-hidden={inList || undefined}>{g.name}</div>
              {g.leaders.map((l) => <LeaderRow key={l.id} leader={l} depth={0} surface={surface} query={query} openTaskIds={openTaskIds} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
