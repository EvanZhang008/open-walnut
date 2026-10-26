/**
 * The Board bar's view switch: Status (every task by the one user status) | Cards
 * (the team's kanban) | Page (the page the leader wrote). A segmented control,
 * never a dropdown: every choice stays in sight.
 *
 * Page with no page is disabled by `aria-disabled`, not `disabled`, so its
 * tooltip still shows on hover (a disabled button gets no pointer events in
 * Chromium) and it stays in the tab order, saying why. While the user reads the
 * Page or the Cards, the Status segment carries a red count of what needs them, so
 * a page the leader stopped updating can never hide a blocked worker. The count is
 * the Status view's own Needs you number.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DEFAULT_BOARD_VIEW, type BoardView } from './board-view-pref';
import '@/styles/board-overview.css';

export interface BoardViewToggleProps {
  view: BoardView;
  hasPage: boolean;
  /** What needs the user: the Status view's Needs you count. */
  attention: number;
  onPick: (view: BoardView) => void;
}

export const NO_PAGE_TITLE = 'No page yet: the leader has not written one';
export const PAGE_TITLE = 'The page the leader wrote for this team';
export const CARDS_TITLE = "The team's cards by lane";
export const STATUS_TITLE = 'Every task of the team: what needs you, what is working, what waits';

const LABELS: Record<BoardView, string> = { status: 'Status', cards: 'Cards', custom: 'Page' };

export function BoardViewToggle({ view, hasPage, attention, onPick }: BoardViewToggleProps) {
  const views: BoardView[] = ['status', 'cards', 'custom'];
  const countOn = view !== DEFAULT_BOARD_VIEW && attention > 0 ? DEFAULT_BOARD_VIEW : null;
  const choose = (next: BoardView) => {
    if (next === 'custom' && !hasPage) return;
    if (next !== view) onPick(next);
  };
  // Left / Right move between the segments, as in any segmented control.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-view]'));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at < 0 ? 0 : at) + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const titleOf = (v: BoardView) => {
    if (v === 'custom') return hasPage ? PAGE_TITLE : NO_PAGE_TITLE;
    const base = v === 'status' ? STATUS_TITLE : CARDS_TITLE;
    return countOn === v ? `${base}: ${attention} ${attention === 1 ? 'needs' : 'need'} you` : base;
  };
  return (
    <div className="board-view-toggle" role="group" aria-label="Board view" data-testid="board-view-toggle" onKeyDown={onKeyDown}>
      {views.map((v) => (
        <button
          key={v}
          type="button"
          className={`board-view-seg${view === v ? ' is-active' : ''}`}
          data-view={v}
          data-testid={`board-view-${v}`}
          aria-pressed={view === v}
          aria-disabled={(v === 'custom' && !hasPage) || undefined}
          title={titleOf(v)}
          onClick={() => choose(v)}
        >
          <span>{LABELS[v]}</span>
          {countOn === v && (
            <span className="board-view-count" data-testid="board-view-attention" aria-label={`${attention} need you`}>
              {attention > 99 ? '99+' : attention}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
