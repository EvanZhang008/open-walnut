/**
 * The Directors under a VP (org-leaders.ts), drawn the same way under a row of the Org list and in a
 * VP card of the Org chart: one quiet line, "▸ 6 directors", folded until it is clicked (2026-11-20,
 * the user: "by default it should be collapsed ... super customer friendly"). Opened, each of the
 * VP's projects that has leaders gives its name, then its leaders: a state dot, the title (a click
 * opens the task beside the page), the eye when he watches it, and "leads N". A leader with leaders
 * under it has its own ▸, folded too. Each fold is kept (usePageViewOf), per surface. A watched task
 * stays where it hangs today as well (OrgChannelList KeptChildren): it shows in both places.
 *
 * A search that finds a leader shows the folds above it open while it does, without touching the
 * kept folds; a click on a fold the search opened closes it for that search only.
 *
 * A right-click on a Director opens its menu (director-actions.ts: open its chat, open it, remove it
 * from the Directors). The opened fold ends with "+ New Director" (OrgNewDirector); a VP's own
 * right-click "New Director…" opens the fold on it, even for a VP with no Director yet (then only the
 * input shows). With the project names off (Settings → Org) the fold draws no project headings.
 *
 * In the list everything here is an option of the list's listbox (all it may hold), so a fold's state
 * is in its words and Right and Left work it; in the chart the toggles are plain disclosure buttons.
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { ICON_EYE } from '@/components/common/Icons';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { domId } from './OrgChartVp';
import { TAB_DOT } from './org-task-tabs';
import { directorsLabel, foldGroups, leaderTotal, leadersMatch, subsMatch, type LeaderGroup, type LeaderNode } from './org-leaders';
import { directorMenuItems, endNewDirector, useDirectorActions, useNewDirectorAsk, type DirectorProject } from './director-actions';
import { OrgNewDirector } from './OrgNewDirector';
import '@/styles/org-leaders.css';
import { NodeAvatar } from './OrgAvatar';

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
  onMenu: (e: MouseEvent, leader: LeaderNode) => void;
}

function LeaderRow({ leader: l, depth, surface, query, openTaskIds, onOpen, onMenu }: RowProps) {
  const hasSubs = l.subs.length > 0;
  const [open, setOpen] = useFold(surface, 'leaders.sub', l.id, hasSubs && subsMatch(l, query), query);
  const subsId = domId(`org-leaders-${surface}-subs`, l.id);
  const inList = surface === 'list';
  const state = USER_STATE_LABELS[l.state];
  const foldWords = hasSubs ? `, ${open ? 'directors under it shown' : 'directors under it folded'}` : '';
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
        onContextMenu={(e) => onMenu(e, l)}
      >
        {hasSubs ? (
          <button
            type="button"
            className="org-leader-fold"
            data-testid="org-leader-fold"
            // In the list the option carries the fold (Right, Left); in the chart this is its button.
            {...(inList ? { 'aria-hidden': true, tabIndex: -1 } : { 'aria-expanded': open, ...(open ? { 'aria-controls': subsId } : {}), 'aria-label': `Directors under ${l.title}` })}
            title={open ? 'Hide the Directors under it' : 'Show the Directors under it'}
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
          <NodeAvatar taskId={l.id} name={l.title} size={20} className="org-leader-avatar" />
          <span className="org-leader-title">{l.title}</span>
          {l.watched && <span className="org-leader-eye" data-testid="org-leader-eye" title="Watched" aria-hidden="true">{ICON_EYE}</span>}
          <span className="org-leader-leads" data-testid="org-leader-leads">leads {l.leads}</span>
        </button>
      </div>
      {hasSubs && open && (
        <div id={subsId} role={inList ? 'group' : undefined} className="org-leader-subs">
          {l.subs.map((s) => <LeaderRow key={s.id} leader={s} depth={depth + 1} surface={surface} query={query} openTaskIds={openTaskIds} onOpen={onOpen} onMenu={onMenu} />)}
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
  /** The VP's projects, in the chart's order: where a New Director may go. */
  projects: readonly DirectorProject[];
  /** Group the Directors under their project's name (Settings → Org; default on). */
  showProjects?: boolean;
  /** The list's search: a leader it finds is shown, the folds above it open while it does. */
  query?: string;
  openTaskIds?: ReadonlySet<string>;
  /** Before a task opens (the chart closes itself: the task opens beside the page). */
  onLeave?: () => void;
}

export function OrgLeaders({ groups, surface, vpKey, vpName, projects, showProjects = true, query = '', openTaskIds, onLeave }: Props) {
  const actions = useDirectorActions();
  const [open, setOpen] = useFold(surface, 'leaders', vpKey, leadersMatch(groups, query), query);
  const menu = useContextMenu<LeaderNode>({ ignorePressSelection: true });
  // A VP's "New Director…": this fold opens on its input (kept open), for a VP with none yet too.
  const asked = useNewDirectorAsk(surface);
  const mine = asked?.vpKey === vpKey ? asked : null;
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (mine) { setOpen(true); setAdding(true); } }, [mine?.n]); // eslint-disable-line react-hooks/exhaustive-deps -- one answer per ask
  const onAdding = (on: boolean) => { setAdding(on); if (!on && mine) endNewDirector(mine.n); };
  const total = leaderTotal(groups);
  const listId = domId(`org-leaders-${surface}`, vpKey);
  const inList = surface === 'list';
  const onOpen = (taskId: string) => { onLeave?.(); actions.openTask(taskId); };
  const onMenu = (e: MouseEvent, l: LeaderNode) => { e.stopPropagation(); menu.open(e, l); };
  const picked = menu.state?.payload;
  const menuEl = menu.state && picked && (
    <ContextMenu
      point={menu.state.point}
      items={directorMenuItems({
        id: picked.id,
        title: picked.title,
        openChat: () => { onLeave?.(); actions.openChat({ id: picked.id, sessionId: picked.sessionId }); },
        openTask: () => onOpen(picked.id),
        remove: () => actions.remove(picked.id, picked.leads),
      })}
      onClose={menu.close}
      returnFocus={menu.state.origin}
      ariaLabel="Director actions"
      testId="org-director-menu"
    />
  );
  const newRow = <OrgNewDirector projects={projects} inList={inList} editing={adding} onEditing={onAdding} onLeave={onLeave} />;
  // No Director yet: nothing, unless the VP's "New Director…" asked for the input.
  if (!total) {
    return adding ? (
      <div className={`org-leaders is-${surface} is-empty`} data-testid="org-leaders" data-key={vpKey} role={inList ? 'group' : undefined} aria-label={inList ? `New Director under ${vpName}` : undefined}>
        {newRow}
      </div>
    ) : null;
  }
  return (
    <div
      className={`org-leaders is-${surface}`}
      role={inList ? 'group' : undefined}
      aria-label={inList ? `Directors under ${vpName}` : undefined}
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
          ? { 'aria-label': `${directorsLabel(total)} under ${vpName}, ${open ? 'shown' : 'folded'}` }
          : { 'aria-expanded': open, ...(open ? { 'aria-controls': listId } : {}) })}
        title={`The Directors under ${vpName}: tasks that lead their own team, or that you made one`}
        onClick={() => setOpen(!open)}
        onKeyDown={foldKeys(open, setOpen)}
      >
        <span className="org-leaders-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {directorsLabel(total)}
      </button>
      {open && (
        <div id={listId} className="org-leaders-list" data-testid="org-leaders-list">
          {foldGroups(groups, showProjects).map((g) => (
            <div key={g.key} className="org-leaders-group" role={inList ? 'group' : undefined} aria-label={inList ? (g.name || `Directors under ${vpName}`) : undefined} data-testid="org-leaders-group" data-project={g.project}>
              {g.name && <div className="org-leaders-project" data-testid="org-leaders-project" aria-hidden={inList || undefined}>{g.name}</div>}
              {g.leaders.map((l) => <LeaderRow key={l.id} leader={l} depth={0} surface={surface} query={query} openTaskIds={openTaskIds} onOpen={onOpen} onMenu={onMenu} />)}
            </div>
          ))}
          {newRow}
        </div>
      )}
      {menuEl}
    </div>
  );
}
