/**
 * The Overview of a board whose leader defined projects: a project board, one
 * card per project (BoardProjectCard.tsx), in the page's order.
 *
 * On top, the status strip: how many projects need the user, are in progress,
 * wait on others, are done, and All; a click shows only that status (again: All),
 * and the pane keeps the pick for that board while the app is open. Under it,
 * "Show:" toggles the parts of every card (overview, latest, next step, tasks,
 * questions), kept in this browser for every board. Cards for tasks no project
 * names close the list under All.
 */
import { useCallback, useMemo, useState } from 'react';
import { log } from '@/utils/log';
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES } from './board-overview-model';
import {
  CARD_PARTS, CARD_PARTS_KEY, CARD_PART_LABELS, FILTER_ORDER, cardsFor, foldedByDefault, parseCardParts, statusCounts,
  type CardFilter, type CardPart, type CardParts, type ProjectCard,
} from './board-cards-model';
import { BoardProjectCard, type BoardCardActions } from './BoardProjectCard';
import type { CardContext } from './BoardCardThread';
import '@/styles/board-cards.css';

/** The strip's pick per board, for as long as the app is open. */
const filters = new Map<string, CardFilter>();
/** Cards the reader folded or opened, per board, against their default. */
const folds = new Map<string, Record<string, boolean>>();

function readParts(): CardParts {
  try { return parseCardParts(window.localStorage.getItem(CARD_PARTS_KEY)); } catch { return parseCardParts(null); }
}

function filterLabel(f: Exclude<CardFilter, ''>): string {
  return f === 'none' ? 'No status' : PROJECT_STATUS_LABELS[f];
}

export function BoardProjectBoard({ ownerId, cards, ctx, actions }: {
  ownerId: string;
  cards: readonly ProjectCard[];
  ctx: CardContext;
  actions?: BoardCardActions;
}) {
  const [filter, setFilterState] = useState<CardFilter>(() => filters.get(ownerId) ?? '');
  const [parts, setParts] = useState<CardParts>(readParts);
  const [folded, setFolded] = useState<Record<string, boolean>>(() => folds.get(ownerId) ?? {});
  const counts = useMemo(() => statusCounts(cards), [cards]);
  const shown = useMemo(() => cardsFor(cards, filter), [cards, filter]);

  const setFilter = useCallback((f: CardFilter) => {
    setFilterState((cur) => {
      const next = f === cur ? '' : f;
      filters.set(ownerId, next);
      log.info('board', 'overview status filter', { taskId: ownerId, filter: next || 'all' });
      return next;
    });
  }, [ownerId]);
  const togglePart = useCallback((p: CardPart) => {
    setParts((cur) => {
      const next = { ...cur, [p]: !cur[p] };
      try { window.localStorage.setItem(CARD_PARTS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  const toggleCard = useCallback((id: string, byDefault: boolean) => {
    setFolded((cur) => {
      const next = { ...cur, [id]: !(cur[id] ?? byDefault) };
      folds.set(ownerId, next);
      return next;
    });
  }, [ownerId]);

  const tiles = FILTER_ORDER.filter((f) => f !== 'none' || counts.none > 0 || filter === 'none');
  return (
    <div className="bpb" data-testid="board-project-board" data-filter={filter || 'all'}>
      <div className="bpb-strip" role="group" aria-label="Show projects by status" data-testid="board-strip">
        {tiles.map((f) => (
          <button
            key={f}
            type="button"
            className="bpb-tile"
            data-tone={f === 'none' ? 'grey' : PROJECT_STATUS_TONES[f]}
            data-zero={counts[f] === 0 ? 'true' : undefined}
            aria-pressed={filter === f}
            data-testid={`board-strip-${f}`}
            onClick={() => setFilter(f)}
          >
            <b className="bpb-n">{counts[f]}</b>
            <span className="bpb-label">{filterLabel(f)}</span>
          </button>
        ))}
        <button
          type="button"
          className="bpb-tile"
          aria-pressed={filter === ''}
          data-testid="board-strip-all"
          onClick={() => setFilter('')}
        >
          <b className="bpb-n">{counts.all}</b>
          <span className="bpb-label">All</span>
        </button>
      </div>
      <div className="bpb-parts" role="group" aria-label="Parts shown on every card" data-testid="board-parts">
        <span className="bpb-parts-label">Show</span>
        {CARD_PARTS.map((p) => (
          <button
            key={p}
            type="button"
            className="bpb-part"
            aria-pressed={parts[p]}
            data-testid={`board-part-${p}`}
            onClick={() => togglePart(p)}
          >{CARD_PART_LABELS[p]}</button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="bpb-empty" data-testid="board-strip-empty">
          No project is {filter === 'none' ? 'without a status' : `in ${filterLabel(filter as Exclude<CardFilter, ''>)}`}.{' '}
          <button type="button" className="bo-link" onClick={() => setFilter('')}>Show all</button>
        </div>
      ) : (
        <div className="bpb-cards">
          {shown.map((c) => (
            <BoardProjectCard
              key={c.id}
              card={c}
              parts={parts}
              folded={folded[c.id] ?? foldedByDefault(c)}
              onToggle={toggleCard}
              ctx={ctx}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
