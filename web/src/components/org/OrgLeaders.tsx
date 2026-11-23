/**
 * The Directors under a VP (org-leaders.ts), in a VP card of the Org chart: one quiet line,
 * "▸ 6 directors", folded until it is clicked (2026-11-20,
 * the user: "by default it should be collapsed ... super customer friendly"). Opened, each of the
 * VP's projects that has leaders gives its name, then its leaders: a state dot, the title (a click
 * opens the task beside the page), the eye when he watches it, and "leads N". A leader with leaders
 * under it has its own ▸, folded too. Each fold is kept (usePageViewOf). The Org list draws no fold
 * under a VP (2026-11-22, the user: "We need to be super simple"): its Directors are here, and with
 * the "sections" layout also in the list's DIRECTORS section (OrgDirectorSection).
 *
 * A right-click on a Director opens its menu (director-actions.ts: open its chat, open it, remove it
 * from the Directors). The opened fold ends with "+ New Director" (OrgNewDirector); a VP's own
 * right-click "New Director…" (on the card, or on its row in the list) opens the fold on it, even for
 * a VP with no Director yet (then only the input shows). With the project names off (Settings → Org)
 * the fold draws no project headings. The toggles are plain disclosure buttons.
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { ICON_EYE } from '@/components/common/Icons';
import { DisclosureButton } from '@/components/controls';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { domId } from './OrgChartVp';
import { TAB_DOT } from './org-task-tabs';
import { directorsLabel, foldGroups, leaderTotal, type LeaderGroup, type LeaderNode } from './org-leaders';
import { directorMenuItems, endNewDirector, useDirectorActions, useNewDirectorAsk, type DirectorProject } from './director-actions';
import { OrgNewDirector } from './OrgNewDirector';
import '@/styles/org-leaders.css';
import { NodeAvatar } from './OrgAvatar';

/** How far each level of Directors steps in: enough for the tree to read, little enough that a deep
 *  level keeps the width its title wraps in (2026-11-21, the UI audit: names cut at every level). */
const LEVEL_INDENT_PX = 10;

/** A fold kept per key (the chart's view key, as before the list stopped drawing one). */
function useFold(name: string, key: string): [boolean, (open: boolean) => void] {
  return usePageViewOf('org', `chart.${name}`, key, false, isBoolean);
}

/** Right opens, Left folds: the keys a tree's row takes. */
function foldKeys(open: boolean, set: (v: boolean) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && !open) { e.preventDefault(); e.stopPropagation(); set(true); }
    else if (e.key === 'ArrowLeft' && open) { e.preventDefault(); e.stopPropagation(); set(false); }
  };
}

interface RowProps {
  leader: LeaderNode;
  depth: number;
  onOpen: (taskId: string) => void;
  onMenu: (e: MouseEvent, leader: LeaderNode) => void;
}

function LeaderRow({ leader: l, depth, onOpen, onMenu }: RowProps) {
  const hasSubs = l.subs.length > 0;
  const [open, setOpen] = useFold('leaders.sub', l.id);
  const subsId = domId('org-leaders-chart-subs', l.id);
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
        style={depth ? { paddingLeft: `min(${LEVEL_INDENT_PX * depth}px, 40%)` } : undefined}
        onContextMenu={(e) => onMenu(e, l)}
      >
        {hasSubs ? (
          <DisclosureButton
            expanded={open}
            className="org-leader-fold"
            data-testid="org-leader-fold"
            {...(open ? { 'aria-controls': subsId } : {})}
            aria-label={`Directors under ${l.title}`}
            title={open ? 'Hide the Directors under it' : 'Show the Directors under it'}
            onClick={() => setOpen(!open)}
          />
        ) : <span className="org-leader-fold is-none" aria-hidden="true" />}
        <button
          type="button"
          className="org-leader-open"
          data-testid="org-leader-open"
          aria-label={`${l.title}: ${state}, leads ${l.leads}${l.watched ? ', watched' : ''}${foldWords}`}
          title={`${l.title}: ${state}`}
          onClick={() => onOpen(l.id)}
          onKeyDown={hasSubs ? foldKeys(open, setOpen) : undefined}
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
      {hasSubs && open && (
        <div id={subsId} className="org-leader-subs">
          {l.subs.map((s) => <LeaderRow key={s.id} leader={s} depth={depth + 1} onOpen={onOpen} onMenu={onMenu} />)}
        </div>
      )}
    </>
  );
}

interface Props {
  groups: readonly LeaderGroup[];
  /** The VP's card key: its fold is kept under it. */
  vpKey: string;
  vpName: string;
  /** The VP's projects, in the chart's order: where a New Director may go. */
  projects: readonly DirectorProject[];
  /** Group the Directors under their project's name (Settings → Org; default on). */
  showProjects?: boolean;
  /** Before a task opens (the chart closes itself: the task opens beside the page). */
  onLeave?: () => void;
}

export function OrgLeaders({ groups, vpKey, vpName, projects, showProjects = true, onLeave }: Props) {
  const actions = useDirectorActions();
  const [open, setOpen] = useFold('leaders', vpKey);
  const menu = useContextMenu<LeaderNode>({ ignorePressSelection: true });
  // A VP's "New Director…": this fold opens on its input (kept open), for a VP with none yet too.
  const asked = useNewDirectorAsk('chart');
  const mine = asked?.vpKey === vpKey ? asked : null;
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (mine) { setOpen(true); setAdding(true); } }, [mine?.n]); // eslint-disable-line react-hooks/exhaustive-deps -- one answer per ask
  const onAdding = (on: boolean) => { setAdding(on); if (!on && mine) endNewDirector(mine.n); };
  const total = leaderTotal(groups);
  const shownGroups = foldGroups(groups, showProjects);
  const listId = domId('org-leaders-chart', vpKey);
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
  const newRow = <OrgNewDirector projects={projects} inList={false} editing={adding} onEditing={onAdding} onLeave={onLeave} />;
  // No Director yet: nothing, unless the VP's "New Director…" asked for the input.
  if (!total) {
    return adding ? (
      <div className="org-leaders is-chart is-empty" data-testid="org-leaders" data-key={vpKey}>
        {newRow}
      </div>
    ) : null;
  }
  return (
    <div
      className="org-leaders is-chart"
      data-testid="org-leaders"
      data-key={vpKey}
      data-open={open || undefined}
    >
      <DisclosureButton
        expanded={open}
        className="org-leaders-toggle"
        data-testid="org-leaders-toggle"
        data-open={open}
        {...(open ? { 'aria-controls': listId } : {})}
        title={`The Directors under ${vpName}: tasks that lead their own team, or that you made one`}
        onClick={() => setOpen(!open)}
        onKeyDown={foldKeys(open, setOpen)}
      >
        {directorsLabel(total)}
      </DisclosureButton>
      {open && (
        <div id={listId} className="org-leaders-list" data-testid="org-leaders-list">
          {shownGroups.map((g) => (
            <div key={g.key} className="org-leaders-group" data-testid="org-leaders-group" data-project={g.project}>
              {g.name && <div className="org-leaders-project wn-title" data-testid="org-leaders-project">{g.name}</div>}
              {g.leaders.map((l) => <LeaderRow key={l.id} leader={l} depth={0} onOpen={onOpen} onMenu={onMenu} />)}
            </div>
          ))}
          {newRow}
        </div>
      )}
      {menuEl}
    </div>
  );
}
