/**
 * The Board bar's view switch: Status (every task by the one user status) | Cards
 * (the team's kanban) | Page (the page the leader wrote). A segmented control,
 * never a dropdown: every choice stays in sight.
 *
 * Page with no page is a disabled segment (`aria-disabled`), so its tooltip
 * still shows on hover and the arrow keys still reach it, saying why. While the user reads the
 * Page or the Cards, the Status segment carries a red count of what needs them, so
 * a page the leader stopped updating can never hide a blocked worker. The count is
 * the Status view's own Needs you number.
 */
import { DEFAULT_BOARD_VIEW, type BoardView } from './board-view-pref';
import { stateCountLabel } from '@open-walnut/user-status';
import { SegmentedControl } from '@/components/controls';
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
const VIEWS: readonly BoardView[] = ['status', 'cards', 'custom'];

export function BoardViewToggle({ view, hasPage, attention, onPick }: BoardViewToggleProps) {
  const countOn = view !== DEFAULT_BOARD_VIEW && attention > 0 ? DEFAULT_BOARD_VIEW : null;
  const titleOf = (v: BoardView) => {
    if (v === 'custom') return hasPage ? PAGE_TITLE : NO_PAGE_TITLE;
    const base = v === 'status' ? STATUS_TITLE : CARDS_TITLE;
    return countOn === v ? `${base}: ${stateCountLabel('needs', attention)}` : base;
  };
  return (
    <SegmentedControl
      className="board-view-toggle"
      aria-label="Board view"
      data-testid="board-view-toggle"
      value={view}
      onChange={(next) => { if (next === 'custom' && !hasPage) return; if (next !== view) onPick(next); }}
      options={VIEWS.map((v) => ({
        value: v,
        testId: `board-view-${v}`,
        data: { 'data-view': v },
        // Page with no page stays in sight and in reach, saying why (aria-disabled, so its title shows).
        disabled: v === 'custom' && !hasPage,
        title: titleOf(v),
        label: (
          <>
            {LABELS[v]}
            {countOn === v && (
              <span className="badge badge-count badge-alert board-view-count" data-testid="board-view-attention" aria-label={stateCountLabel('needs', attention)}>
                {attention > 99 ? '99+' : attention}
              </span>
            )}
          </>
        ),
      }))}
    />
  );
}
