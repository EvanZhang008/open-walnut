/**
 * The Board bar's view switch: Projects (the board's projects, one card each;
 * only when the leader defined projects) | Cards (the team's kanban) | Page (the
 * page the leader wrote). A segmented control, never a dropdown: every choice
 * stays in sight.
 *
 * Page with no page is disabled by `aria-disabled`, not `disabled`, so its
 * tooltip still shows on hover (a disabled button gets no pointer events in
 * Chromium) and it stays in the tab order, saying why. While the user reads the
 * Page, the default view's segment carries a red count of what needs them, so a
 * page the leader stopped updating can never hide a blocked worker.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { defaultBoardView, type BoardView } from './board-view-pref';

export interface BoardViewToggleProps {
  view: BoardView;
  hasPage: boolean;
  /** The board has projects: the Projects segment shows (and leads). */
  hasProjects: boolean;
  /** What needs the user in the default view (Projects' or the kanban's count). */
  attention: number;
  onPick: (view: BoardView) => void;
}

export const NO_PAGE_TITLE = 'No page yet: the leader has not written one';
export const PAGE_TITLE = 'The page the leader wrote for this team';
export const CARDS_TITLE = "The team's cards by lane";
export const PROJECTS_TITLE = "The board's projects, one card each";

const LABELS: Record<BoardView, string> = { projects: 'Projects', cards: 'Cards', custom: 'Page' };

export function BoardViewToggle({ view, hasPage, hasProjects, attention, onPick }: BoardViewToggleProps) {
  const views: BoardView[] = hasProjects ? ['projects', 'cards', 'custom'] : ['cards', 'custom'];
  const countOn = view === 'custom' && attention > 0 ? defaultBoardView(hasProjects) : null;
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
    const base = v === 'projects' ? PROJECTS_TITLE : CARDS_TITLE;
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
