/**
 * The Board's default view: Walnut's own Overview of the team under the
 * board's owner, beside (never inside) the Custom page the leader writes.
 *
 * Top: the owner as the Leader row (its own live state), then a rollup
 * ("12 open · 30 done") with a thin progress bar (none for an empty team,
 * whose body says "No workers yet."). Below: the team in attention
 * order, Needs you, Running, Open, Done (collapsed to its count), each row one
 * line: phase circle, title, the grey "now" line (what it does, waits on, or
 * why it needs you), its live badge and how long ago it last changed. The
 * grouping rules live in board-overview-model.ts.
 *
 * A row opens its task the way a chip on the page does (the session panel's
 * peek). Up / Down walk the rows and group heads; Enter or Space opens one.
 * The pane narrower than about 420px moves the "now" line into the row's
 * tooltip (a container query in board-overview.css), so the title keeps its room.
 */
import { memo, useCallback, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { binaryPhaseIcon } from '@/components/common/Icons';
import { RECENT_COMPLETED_DAYS } from '@/api/tasks';
import { log } from '@/utils/log';
import { timeAgo } from '@/utils/time';
import {
  compactAgo, donePercent, rollupText, rowTooltip,
  type OverviewGroup, type OverviewGroupId, type OverviewRow, type PlacedRow, type TeamOverview,
} from './board-overview-model';
import { useAskForBoard } from './useAskForBoard';
import '@/styles/subtask-pill.css';
import '@/styles/board-overview.css';

export interface BoardOverviewProps {
  overview: TeamOverview;
  /** The owner's title from the board payload: the header still names an owner the store has no row for. */
  ownerTitle: string;
  hasPage: boolean;
  /** The task store has not answered yet. */
  loading: boolean;
  completedHidden: number;
  onLoadArchive: () => void;
  onOpenTask: (taskId: string) => void;
  /** This session's composer, when the board's owner is this session's task ("Ask for a board" goes through it). */
  onSendToSession?: (text: string) => Promise<unknown> | void;
}

const ROW_SELECTOR = '[data-bo-nav]';

/** Up / Down / Home / End between the rows and group heads, as in a list. */
function onListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  if (all.length === 0) return;
  const at = all.indexOf(document.activeElement as HTMLElement);
  if (at < 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return; // focus is elsewhere (a link): leave the keys alone
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? all.length - 1
      : Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  e.preventDefault();
  all[next].focus();
}

export function BoardOverview({
  overview, ownerTitle, hasPage, loading, completedHidden, onLoadArchive, onOpenTask, onSendToSession,
}: BoardOverviewProps) {
  // Done starts folded: finished work is history, the count is enough until asked.
  const [folded, setFolded] = useState<Partial<Record<OverviewGroupId, boolean>>>({ done: true });
  const toggle = useCallback((id: OverviewGroupId) => {
    setFolded((cur) => ({ ...cur, [id]: !cur[id] }));
  }, []);
  const open = useCallback((taskId: string, from: string) => {
    log.info('board', 'overview row opened', { taskId: overview.ownerId, targetTaskId: taskId, from });
    onOpenTask(taskId);
  }, [onOpenTask, overview.ownerId]);

  const { leader } = overview;
  const empty = overview.members === 0;
  const pct = donePercent(overview);
  return (
    <div className="board-overview" data-testid="board-overview" data-owner-id={overview.ownerId} onKeyDown={onListKeyDown}>
      <div className="bo-head">
        <div className="bo-kicker">Leader</div>
        {leader
          ? <OverviewRowButton row={leader} leader onOpen={open} />
          : <div className="bo-row bo-row-leader bo-row-unknown" data-testid="board-overview-leader"><span className="bo-title">{ownerTitle || overview.ownerId}</span></div>}
        {/* No rollup for an empty team: the body says "No workers yet." once. */}
        {!empty && (
          <div className="bo-rollup" data-testid="board-overview-rollup">
            <span
              className="bo-rollup-text"
              title={completedHidden > 0 ? `Done counts the last ${RECENT_COMPLETED_DAYS} days: older finished tasks are not loaded` : undefined}
            >{rollupText(overview)}</span>
            <span
              className="bo-meter"
              role="img"
              aria-label={`${overview.done} of ${overview.members} done`}
              title={`${overview.done} of ${overview.members} done (${pct}%)`}
            >
              <span className="bo-meter-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="bo-meter-pct">{pct}%</span>
          </div>
        )}
      </div>

      {loading && empty ? (
        <div className="bo-empty" data-testid="board-overview-loading">Loading the team…</div>
      ) : empty ? (
        <div className="bo-empty" data-testid="board-overview-empty">
          <div className="bo-empty-title">No workers yet.</div>
          <div className="bo-empty-text">Subtasks the leader files show up here, with their live status.</div>
        </div>
      ) : (
        overview.groups.map((g) => (
          <OverviewGroupSection
            key={g.id}
            group={g}
            folded={!!folded[g.id]}
            onToggle={toggle}
            onOpen={open}
            archive={g.id === 'done' && completedHidden > 0 ? onLoadArchive : undefined}
          />
        ))
      )}

      {!hasPage && <AskForPageLine taskId={overview.ownerId} onSendToSession={onSendToSession} />}
    </div>
  );
}

function OverviewGroupSection({ group, folded, onToggle, onOpen, archive }: {
  group: OverviewGroup;
  folded: boolean;
  onToggle: (id: OverviewGroupId) => void;
  onOpen: (taskId: string, from: string) => void;
  /** Done only, when older finished tasks are not loaded: loads them. */
  archive?: () => void;
}) {
  const n = group.rows.length;
  return (
    <section className="bo-group" data-group={group.id} data-testid={`board-overview-group-${group.id}`}>
      <button
        type="button"
        className="bo-group-head"
        data-bo-nav=""
        aria-expanded={!folded}
        title={folded ? `Show ${group.label.toLowerCase()}` : `Hide ${group.label.toLowerCase()}`}
        onClick={() => onToggle(group.id)}
      >
        <span className={`bo-chevron${folded ? '' : ' is-open'}`} aria-hidden="true" />
        <span className="bo-group-label">{group.label}</span>
        <span className="bo-group-count" data-testid="board-overview-count">{n}</span>
      </button>
      {!folded && (
        <ul className="bo-list">
          {group.rows.map((r) => (
            <li key={r.id}><OverviewRowButton row={r} onOpen={onOpen} /></li>
          ))}
        </ul>
      )}
      {!folded && archive && (
        <div className="bo-archive">
          Tasks finished more than {RECENT_COMPLETED_DAYS} days ago are not loaded.{' '}
          <button type="button" className="bo-link" data-testid="board-overview-load-archive" onClick={archive}>Load all</button>
        </div>
      )}
    </section>
  );
}

const OverviewRowButton = memo(function OverviewRowButton({ row, leader, onOpen }: {
  row: OverviewRow | PlacedRow;
  leader?: boolean;
  onOpen: (taskId: string, from: string) => void;
}) {
  const placed = 'indent' in row ? row : null;
  const ago = row.at ? timeAgo(row.at) : '';
  const when = row.at ? new Date(row.at).toLocaleString() : '';
  const done = row.group === 'done';
  return (
    <button
      type="button"
      className={`bo-row${leader ? ' bo-row-leader' : ''}`}
      data-bo-nav=""
      data-testid={leader ? 'board-overview-leader' : 'board-overview-row'}
      data-task-id={row.id}
      data-group={row.group}
      data-reason={row.reason ?? undefined}
      data-depth={row.depth}
      data-indent={placed?.indent ?? 0}
      style={placed?.indent ? { ['--bo-indent' as string]: placed.indent } : undefined}
      title={rowTooltip(row, { when })}
      onClick={() => onOpen(row.id, leader ? 'leader' : row.group)}
    >
      <span className="bo-gutter" aria-hidden={!row.task.unread || done}>
        {row.task.unread && !done && <span className="task-unread-dot" role="img" aria-label="Unread" />}
      </span>
      <span className={`task-phase-icon-btn bo-circle ${row.circle}`} aria-hidden="true">
        {binaryPhaseIcon(done, row.task.phase)}
      </span>
      <span className="bo-main">
        <span className="bo-title" data-testid="board-overview-title">{row.task.title}</span>
        {(row.now || placed?.under) && (
          <span className="bo-now" data-testid="board-overview-now">
            {row.now}
            {/* The state first (it is why the row is here), whom it is under after: a long parent title is what gets cut. */}
            {placed?.under && <span className="bo-under">{row.now ? ' · ' : ''}under {placed.under}</span>}
          </span>
        )}
      </span>
      <span className="bo-tail">
        {row.place && <span className="bo-place">{row.place}</span>}
        {row.openSubtasks > 0 && (
          <span className="task-team-pill todo-item-leader-pill bo-leader-pill" data-testid="board-overview-leader-pill">
            Leader · {row.openSubtasks}
          </span>
        )}
        <span className="bo-badge" data-tone={row.badge.tone} data-testid="board-overview-badge">{row.badge.label}</span>
        <span className="bo-time" data-testid="board-overview-time">{compactAgo(ago)}</span>
      </span>
    </button>
  );
});

/** No page yet: one quiet line, the ask a link, not the old full-pane card. */
function AskForPageLine({ taskId, onSendToSession }: { taskId: string; onSendToSession?: (text: string) => Promise<unknown> | void }) {
  const { state, askError, ask } = useAskForBoard(taskId, onSendToSession);
  return (
    <div className="bo-foot" data-testid="board-overview-no-page">
      <span>No custom page yet.</span>{' '}
      <button
        type="button"
        className="bo-link"
        data-testid="board-ask-button"
        disabled={state === 'sending'}
        title="Ask the leader to write a page for this team (the walnut-board skill)"
        onClick={() => void ask()}
      >{state === 'asked' ? 'Asked.' : 'Ask for a board'}</button>
      {askError && <div className="bo-foot-error" role="alert">Couldn't ask: {askError}</div>}
    </div>
  );
}
