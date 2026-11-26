/**
 * The Directors under a VP (org-leaders.ts), drawn the same way under a VP's row in the Org list and in
 * its card on the Org chart: one quiet line, "▸ 6 directors", folded until it is clicked (2026-11-20,
 * the user: "by default it should be collapsed ... super customer friendly"). Opened, each of the
 * VP's projects that has Directors gives its name, then its Directors, one level only. In the list each is
 * the list's own row (DirectorListRow: avatar, title, a red dot when it needs him; 2026-11-25, the user on
 * a busier row: "too ugly lol"), and a VP with one project names none; in a chart card a row is a state
 * dot, the avatar, the title, the eye when he watches it, and "leads N". A click opens the task beside the page.
 * Each fold is kept (usePageViewOf), per surface. The list's VP row itself stays the one plain row
 * (2026-11-22, the user: "We need to be super simple"); the fold is its own line under it, since the
 * user wants his Directors there (2026-11-25: "Where is my Director?"). With the "sections" layout they
 * are one DIRECTORS section after the VPs instead (OrgDirectorSection).
 *
 * A search that finds a Director shows its VP's fold open while it does, without touching the kept
 * fold; a click on a fold the search opened closes it for that search only.
 *
 * A right-click on a Director opens its menu (director-actions.ts: open its chat, open it, remove it
 * from the Directors). The opened fold ends with "+ New Director" (OrgNewDirector); a VP's own
 * right-click "New Director…" (on the card, or on its row in the list) opens the fold on it, even for
 * a VP with no Director yet (then only the input shows). With the project names off (Settings → Org)
 * the fold draws no project headings.
 *
 * In the list everything here is an option of the list's listbox (all it may hold), so the fold's state
 * is in its words and Right and Left work it; in the chart the toggle is a plain disclosure button.
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { ICON_EYE } from '@/components/common/Icons';
import { DisclosureButton } from '@/components/controls';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { domId } from './OrgChartVp';
import { TAB_DOT } from './org-task-tabs';
import { directorsLabel, foldGroups, leaderTotal, leadersMatch, type LeaderGroup, type LeaderNode } from './org-leaders';
import { directorMenuItems, endNewDirector, useDirectorActions, useNewDirectorAsk, type DirectorProject } from './director-actions';
import { OrgNewDirector } from './OrgNewDirector';
import { DirectorListRow } from './OrgDirectorSection';
import '@/styles/org-leaders.css';
import { NodeAvatar } from './OrgAvatar';

type Surface = 'list' | 'chart';

/** A fold kept per surface and key, shown open while a search finds something under it. A click on a
 *  fold the search opened closes it for that search only; the kept fold changes only when nothing forces it. */
function useFold(surface: Surface, key: string, found: boolean, query: string): [boolean, (open: boolean) => void] {
  const [kept, setKept] = usePageViewOf('org', `${surface}.leaders`, key, false, isBoolean);
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

/** The list's option props (its listbox holds options only); none in the chart. */
const asOption = (inList: boolean, foldable: boolean) => (inList
  ? { role: 'option', 'aria-selected': false, ...(foldable ? { 'aria-keyshortcuts': 'ArrowRight ArrowLeft' } : {}) }
  : {});

/** Right opens, Left folds: the keys a tree's row takes. */
function foldKeys(open: boolean, set: (v: boolean) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && !open) { e.preventDefault(); e.stopPropagation(); set(true); }
    else if (e.key === 'ArrowLeft' && open) { e.preventDefault(); e.stopPropagation(); set(false); }
  };
}

/** A Director in a chart card (the list draws DirectorListRow). */
interface RowProps {
  leader: LeaderNode;
  onOpen: (taskId: string) => void;
  onMenu: (e: MouseEvent, leader: LeaderNode) => void;
}

/** One Director: one level only, the first leaders under the VP (2026-11-24, the user: "only the first
 *  layer of leaders, the second layer is not needed"; `directorsOf` in src/core/org/org-directors.ts). */
function LeaderRow({ leader: l, onOpen, onMenu }: RowProps) {
  const state = USER_STATE_LABELS[l.state];
  return (
    <div
      className="org-leader"
      role="presentation"
      data-testid="org-leader"
      data-task-id={l.id}
      data-state={l.state}
      onContextMenu={(e) => onMenu(e, l)}
    >
      <button
        type="button"
        className="org-leader-open"
        data-testid="org-leader-open"
        aria-label={`${l.title}: ${state}, leads ${l.leads}${l.watched ? ', watched' : ''}`}
        title={`${l.title}: ${state}`}
        onClick={() => onOpen(l.id)}
      >
        <i style={{ background: TAB_DOT[l.state] }} aria-hidden="true" />
        <NodeAvatar taskId={l.id} name={l.title} size={20} className="org-leader-avatar" />
        {/* The eye and "leads N" end the title's last line, at the row's right edge (or under it when that
            line is full), so they take no column from the words (2026-11-22, the UI audit). */}
        <span className="org-leader-title wn-title">
          {l.title}
          <span className="org-leader-tail wn-fixed">
            {l.watched && <span className="org-leader-eye" data-testid="org-leader-eye" title="Watched" aria-hidden="true">{ICON_EYE}</span>}
            <span className="org-leader-leads" data-testid="org-leader-leads">leads {l.leads}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

interface Props {
  groups: readonly LeaderGroup[];
  /** Under a VP's row in the Org list, or in its card on the Org chart. */
  surface?: Surface;
  /** The VP's row or card key: its fold is kept under it. */
  vpKey: string;
  vpName: string;
  /** The VP's projects, in the chart's order: where a New Director may go. */
  projects: readonly DirectorProject[];
  /** Group the Directors under their project's name (Settings → Org; default on). */
  showProjects?: boolean;
  /** The list's search: a Director it finds is shown, its VP's fold open while it does. */
  query?: string;
  /** The tasks open beside the page: a Director's row among them wears a light tint. */
  openTaskIds?: ReadonlySet<string> | undefined;
  /** Before a task opens (the chart closes itself: the task opens beside the page). */
  onLeave?: () => void;
}

export function OrgLeaders({ groups, surface = 'chart', vpKey, vpName, projects, showProjects = true, query = '', openTaskIds, onLeave }: Props) {
  const actions = useDirectorActions();
  const inList = surface === 'list';
  const [open, setOpen] = useFold(surface, vpKey, leadersMatch(groups, query), query);
  const menu = useContextMenu<LeaderNode>({ ignorePressSelection: true });
  // A VP's "New Director…": this fold opens on its input (kept open), for a VP with none yet too.
  const asked = useNewDirectorAsk(surface);
  const mine = asked?.vpKey === vpKey ? asked : null;
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (mine) { setOpen(true); setAdding(true); } }, [mine?.n]); // eslint-disable-line react-hooks/exhaustive-deps -- one answer per ask
  const onAdding = (on: boolean) => { setAdding(on); if (!on && mine) endNewDirector(mine.n); };
  const total = leaderTotal(groups);
  const shownGroups = foldGroups(groups, showProjects);
  const listId = domId(`org-leaders-${surface}`, vpKey);
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
  const group = (label: string) => (inList ? { role: 'group', 'aria-label': label } : {});
  // No Director yet: nothing, unless the VP's "New Director…" asked for the input.
  if (!total) {
    return adding ? (
      <div className={`org-leaders is-${surface} is-empty`} data-testid="org-leaders" data-key={vpKey} {...group(`New director under ${vpName}`)}>
        {newRow}
      </div>
    ) : null;
  }
  return (
    <div
      className={`org-leaders is-${surface}`}
      data-testid="org-leaders"
      data-key={vpKey}
      data-open={open || undefined}
      {...group(`Directors under ${vpName}`)}
    >
      <DisclosureButton
        expanded={open}
        className="org-leaders-toggle"
        data-testid="org-leaders-toggle"
        data-open={open}
        {...asOption(inList, true)}
        // In the list it is an option (a listbox holds options, which take no aria-expanded).
        {...(inList
          ? { 'aria-label': `${directorsLabel(total)} under ${vpName}, ${open ? 'shown' : 'folded'}`, 'aria-expanded': undefined }
          : (open ? { 'aria-controls': listId } : {}))}
        title={`The Directors under ${vpName}: tasks that lead their own team, or that you made one`}
        onClick={() => setOpen(!open)}
        onKeyDown={foldKeys(open, setOpen)}
      >
        {directorsLabel(total)}
      </DisclosureButton>
      {open && (
        <div id={listId} className="org-leaders-list" data-testid="org-leaders-list">
          {shownGroups.map((g) => (
            <div key={g.key} className="org-leaders-group" data-testid="org-leaders-group" data-project={g.project} {...group(g.name || `Directors under ${vpName}`)}>
              {/* The list names a project only when the VP has Directors in more than one. */}
              {g.name && (!inList || shownGroups.length > 1) && <div className="org-leaders-project wn-title" data-testid="org-leaders-project" aria-hidden={inList || undefined}>{g.name}</div>}
              {g.leaders.map((l) => (inList
                // In the list a Director is the list's own row, as in the DIRECTORS section.
                ? <DirectorListRow key={l.id} director={l} vpName={vpName} avatarName={vpName} isOpen={!!openTaskIds?.has(l.id)} onOpen={onOpen} onMenu={onMenu} />
                : <LeaderRow key={l.id} leader={l} onOpen={onOpen} onMenu={onMenu} />))}
            </div>
          ))}
          {newRow}
        </div>
      )}
      {menuEl}
    </div>
  );
}
