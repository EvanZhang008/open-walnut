/**
 * The Board bar's view switch: Overview (Walnut's own view of the team) | Custom
 * (the page the leader wrote). A segmented control, never a dropdown: two
 * choices, both always in sight.
 *
 * Custom with no page is disabled by `aria-disabled`, not `disabled`, so its
 * tooltip still shows on hover (a disabled button gets no pointer events in
 * Chromium) and it stays in the tab order, saying why. While the user reads the
 * Custom page, Overview carries a red count of what needs them, so a page the
 * leader stopped updating can never hide a blocked worker.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BoardView } from './board-view-pref';

export interface BoardViewToggleProps {
  view: BoardView;
  hasPage: boolean;
  /** Rows that need the user (the Overview's "Needs you" plus the leader). */
  attention: number;
  onPick: (view: BoardView) => void;
}

export const NO_PAGE_TITLE = 'No custom page yet: the leader has not written one';

export function BoardViewToggle({ view, hasPage, attention, onPick }: BoardViewToggleProps) {
  const showCount = view === 'custom' && attention > 0;
  const choose = (next: BoardView) => {
    if (next === 'custom' && !hasPage) return;
    if (next !== view) onPick(next);
  };
  // Left / Right move between the two, as in any segmented control.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.key === 'ArrowLeft' ? 'overview' : 'custom';
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${target}"]`);
    if (!btn) return;
    e.preventDefault();
    btn.focus();
  };
  return (
    <div className="board-view-toggle" role="group" aria-label="Board view" data-testid="board-view-toggle" onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`board-view-seg${view === 'overview' ? ' is-active' : ''}`}
        data-view="overview"
        data-testid="board-view-overview"
        aria-pressed={view === 'overview'}
        title={showCount
          ? `The team's tasks and their status: ${attention} ${attention === 1 ? 'needs' : 'need'} you`
          : "The team's tasks and their status"}
        onClick={() => choose('overview')}
      >
        <span>Overview</span>
        {showCount && (
          <span className="board-view-count" data-testid="board-view-attention" aria-label={`${attention} need you`}>
            {attention > 99 ? '99+' : attention}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`board-view-seg${view === 'custom' ? ' is-active' : ''}`}
        data-view="custom"
        data-testid="board-view-custom"
        aria-pressed={view === 'custom'}
        aria-disabled={!hasPage || undefined}
        title={hasPage ? 'The page the leader wrote for this team' : NO_PAGE_TITLE}
        onClick={() => choose('custom')}
      >
        <span>Custom</span>
      </button>
    </div>
  );
}
