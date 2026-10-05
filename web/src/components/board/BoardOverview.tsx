/**
 * The Board's default view: Walnut's own Overview of the team under the
 * board's owner, beside (never inside) the Custom page the leader writes.
 *
 * Top: the owner as the Leader row (its own live state), then a rollup
 * ("12 open · 30 done") with a thin progress bar (none for an empty team,
 * whose body says "No workers yet."). Below: the team, each row one line: phase
 * circle, title, the grey "now" line (what it does, waits on, or why it needs
 * you), its live badge and how long ago it last changed. A board whose leader
 * defined projects is a project board instead (BoardProjectBoard.tsx): a status
 * strip that filters, and one card per project with its tasks, the leader's
 * text, its choices and its questions. Without projects the team is in
 * attention order, Needs you, Running, Open, Done (collapsed to its count). The
 * rules live in board-overview-model.ts and board-cards-model.ts.
 *
 * A row opens its task the way a chip on the page does (the session panel's
 * peek). Up / Down walk the rows and group heads; Enter or Space opens one.
 * The pane narrower than about 420px moves the "now" line into the row's
 * tooltip (a container query in board-overview.css), so the title keeps its room.
 */
import { memo, useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { binaryPhaseIcon } from '@/components/common/Icons';
import { RECENT_COMPLETED_DAYS } from '@/api/tasks';
import { log } from '@/utils/log';
import { timeAgo } from '@/utils/time';
import {
  compactAgo, donePercent, rollupText, rowTooltip,
  type OverviewGroup, type OverviewRow, type PlacedRow, type TeamOverview,
} from './board-overview-model';
import type { ProjectCard } from './board-cards-model';
import type { CardContext } from './BoardCardThread';
import { BoardProjectBoard } from './BoardProjectBoard';
import type { BoardCardActions } from './BoardProjectCard';
import { useAskForBoard } from './useAskForBoard';
import '@/styles/subtask-pill.css';
import '@/styles/board-overview.css';

export interface BoardOverviewProps {
  overview: TeamOverview;
  /** The board's projects as cards; null when it defines none (the state groups show instead). */
  cards?: ProjectCard[] | null;
  /** The user's writes from a card (status, choices, questions, read marks). */
  cardActions?: BoardCardActions;
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
  if (at < 0) return; // focus is elsewhere (a link, a card's composer): leave the keys alone
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? all.length - 1
      : Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  e.preventDefault();
  all[next].focus();
}

export function BoardOverview({
  overview, cards, cardActions, ownerTitle, hasPage, loading, completedHidden, onLoadArchive, onOpenTask, onSendToSession,
}: BoardOverviewProps) {
  // Finished work is history, the count is enough until asked: the Done group and a
  // done section start folded. Keyed `g:<group>` / `s:<section>`; unset = the default.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const isFolded = (key: string, byDefault: boolean) => folded[key] ?? byDefault;
  const toggle = useCallback((key: string, byDefault: boolean) => {
    setFolded((cur) => ({ ...cur, [key]: !(cur[key] ?? byDefault) }));
  }, []);
  const open = useCallback((taskId: string, from: string) => {
    log.info('board', 'overview row opened', { taskId: overview.ownerId, targetTaskId: taskId, from });
    onOpenTask(taskId);
  }, [onOpenTask, overview.ownerId]);

  // A message's author by title: the leader and the team, as the store has them.
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    if (overview.leader) m.set(overview.ownerId, overview.leader.task.title);
    for (const g of overview.groups) for (const r of g.rows) m.set(r.id, r.task.title);
    return m;
  }, [overview]);
  const ctx = useMemo<CardContext>(() => ({
    ownerId: overview.ownerId,
    titleOf: (id) => titles.get(id) ?? '',
    onOpenTask: (id) => open(id, 'card-text'),
  }), [overview.ownerId, titles, open]);

  const { leader } = overview;
  const empty = overview.members === 0;
  const board = cards && cards.length > 0 ? cards : null;
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

      {board ? (
        // The projects are the board even before a worker exists: their text, choices and questions.
        <>
          <BoardProjectBoard ownerId={overview.ownerId} cards={board} ctx={ctx} actions={cardActions} />
          {/* Finished work older than the store's window is on no card, so the note closes the board. */}
          {completedHidden > 0 && <ArchiveLine onLoad={onLoadArchive} />}
        </>
      ) : loading && empty ? (
        <div className="bo-empty" data-testid="board-overview-loading">Loading the team…</div>
      ) : empty ? (
        <div className="bo-empty" data-testid="board-overview-empty">
          <div className="bo-empty-title">No workers yet.</div>
          <div className="bo-empty-text">Subtasks the leader files show up here, with their live status.</div>
        </div>
      ) : (
        overview.groups.map((g) => {
          const byDefault = g.id === 'done';
          return (
            <OverviewGroupSection
              key={g.id}
              group={g}
              folded={isFolded(`g:${g.id}`, byDefault)}
              onToggle={() => toggle(`g:${g.id}`, byDefault)}
              onOpen={open}
              archive={g.id === 'done' && completedHidden > 0 ? onLoadArchive : undefined}
            />
          );
        })
      )}

      {!hasPage && <AskForPageLine taskId={overview.ownerId} onSendToSession={onSendToSession} />}
    </div>
  );
}

function OverviewGroupSection({ group, folded, onToggle, onOpen, archive }: {
  group: OverviewGroup;
  folded: boolean;
  onToggle: () => void;
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
        onClick={onToggle}
      >
        <span className={`bo-chevron${folded ? '' : ' is-open'}`} aria-hidden="true" />
        <span className="bo-group-label">{group.label}</span>
        <span className="bo-group-count" data-testid="board-overview-count">{n}</span>
      </button>
      {!folded && <RowList rows={group.rows} onOpen={onOpen} />}
      {!folded && archive && <ArchiveLine onLoad={archive} />}
    </section>
  );
}

function RowList({ rows, onOpen }: { rows: readonly PlacedRow[]; onOpen: (taskId: string, from: string) => void }) {
  return (
    <ul className="bo-list">
      {rows.map((r) => (
        <li key={r.id}><OverviewRowButton row={r} onOpen={onOpen} /></li>
      ))}
    </ul>
  );
}

function ArchiveLine({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="bo-archive">
      Tasks finished more than {RECENT_COMPLETED_DAYS} days ago are not loaded.{' '}
      <button type="button" className="bo-link" data-testid="board-overview-load-archive" onClick={onLoad}>Load all</button>
    </div>
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
