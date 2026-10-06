/**
 * The question chips and the search (spec 7.2): `Needs you` (first, red when
 * not 0), `Sev 1` only when the open cards carry more than one sev value,
 * `Stale`, `Changed`, `Running`, each with its live number. One chip at a time;
 * a chip at 0 is grey and still focusable, its click does nothing, but an
 * active grey chip always clears (G13). While Changed is on, `Mark all seen`
 * and `What changed` sit beside it. The search filters as the user types,
 * Escape empties it and keeps the focus, `/` focuses it while the user works
 * in the board and the focus is not in a text field.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ICON_CLOSE, ICON_SEARCH } from '@/components/common/Icons';
import { KANBAN_CHIP_ORDER, type KanbanChipId, type KanbanFilterApi, type KanbanMode, type KanbanSeenApi } from './kanban-contract';
import { chipLabel, chipTooltip } from './kanban-filter-model';
import type { KanbanBoardVM } from './kanban-model';
import { KanbanChanges } from './KanbanChanges';
import { KANBAN_PANE_SELECTOR } from './kanban-toasts';

export interface KanbanFiltersProps {
  board: KanbanBoardVM;
  filter: KanbanFilterApi;
  seen: KanbanSeenApi;
  mode: KanbanMode;
  searchRef?: RefObject<HTMLInputElement | null>;
  onRevealCard(taskId: string): void;
}

const CHIP_TEST_ID: Record<KanbanChipId, string> = {
  needs: 'kanban-chip-needs', sev1: 'kanban-chip-sev', stale: 'kanban-chip-stale', changed: 'kanban-chip-changed', running: 'kanban-chip-running',
};

/** Is the keyboard focus in a place that types text? */
export function typingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * `/` focuses this board's search when the user is working in the board's
 * column: the focus is anywhere in that column (the Board chip that opened it
 * included), or the last pointer press was inside it and the focus fell back to
 * the page. A full screen column covers everything else, so there any `/` that
 * is not typed into a field is the board's (N9: it used to reach the home task
 * list's hidden search). Capture phase lets the board answer first; once the
 * search holds the focus the task list sees a text field and stays out.
 */
function useSlashFocus(inputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    let pointedInside = false;
    const columnOf = (): Element | null => {
      const input = inputRef.current;
      return input?.closest('.session-panel') ?? input?.closest(KANBAN_PANE_SELECTOR) ?? input?.closest('[data-testid="board-kanban"]') ?? null;
    };
    const onPointer = (e: PointerEvent) => {
      const column = columnOf();
      pointedInside = !!column && e.target instanceof Node && column.contains(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (typingTarget(active)) return;
      const input = inputRef.current;
      const column = columnOf();
      if (!input || !column || input.offsetParent === null) return;
      const inside = !!active && active !== document.body && column.contains(active);
      const fellBack = !active || active === document.body || active.contains(column);
      const fullscreen = column.classList.contains('open-walnut-fullscreen');
      if (!inside && !fullscreen && !(pointedInside && fellBack)) return;
      e.preventDefault();
      e.stopPropagation();
      input.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [inputRef]);
}

export function KanbanFilters({ board, filter, seen, mode, searchRef, onRevealCard }: KanbanFiltersProps) {
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? ownRef;
  const changesBtn = useRef<HTMLButtonElement>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const closeChanges = useCallback(() => setChangesOpen(false), []);
  // An active chip stays until cleared, even once its rule would hide it (G13).
  const chips = KANBAN_CHIP_ORDER.filter((c) => c !== 'sev1' || board.sevChipShown || filter.chip === 'sev1');

  useSlashFocus(inputRef);

  useEffect(() => { if (filter.chip !== 'changed') setChangesOpen(false); }, [filter.chip]);

  const clickChip = (chip: KanbanChipId, n: number) => {
    const active = filter.chip === chip;
    if (!active && n === 0) return;
    filter.toggleChip(chip);
  };

  return (
    <div className={`kanban-filters is-${mode}`} data-testid="kanban-filters">
      <div className="kanban-chips" role="group" aria-label="Filter cards">
        {chips.map((chip) => {
          // R3-03: no count while the board loads (cards not known yet): a number that later goes away is a lie.
          const loading = board.loading;
          const n = loading ? 0 : board.chips[chip];
          const active = filter.chip === chip;
          const zero = n === 0;
          const label = chipLabel(chip);
          return (
            <button
              key={chip}
              type="button"
              className={`kanban-chip${active ? ' is-active' : ''}${zero ? ' is-zero' : ''}${chip === 'needs' && !zero ? ' is-alert' : ''}`}
              data-testid={CHIP_TEST_ID[chip]}
              data-chip={chip}
              data-count={loading ? undefined : n}
              aria-busy={loading || undefined}
              aria-pressed={active}
              aria-disabled={zero && !active ? true : undefined}
              title={chipTooltip(chip, n, seen.baselineAt)}
              onClick={() => clickChip(chip, n)}
            >
              <span className="kanban-chip-label">{label}</span>{' '}
              {/* N14: every chip's count is the same badge, so `Sev 1` + `2` reads as a count. */}
              {!loading && <span className="kanban-chip-count" data-testid="kanban-chip-count">{n}</span>}
            </button>
          );
        })}
      </div>
      {filter.project && (
        <button
          type="button"
          className="kanban-chip kanban-project-filter is-active"
          data-testid="kanban-project-filter"
          data-project-id={filter.project}
          aria-pressed="true"
          title={`Only the cards of ${filter.projectTitle}. Click to show every project's cards`}
          onClick={() => filter.setProject(null)}
        >
          <span className="kanban-chip-label">Project: {filter.projectTitle}</span>
          <span className="kanban-project-filter-x" aria-hidden>{ICON_CLOSE}</span>
        </button>
      )}
      <div className="kanban-search-box">
        <span className="kanban-search-icon" aria-hidden>{ICON_SEARCH}</span>
        <input
          ref={inputRef}
          type="text"
          className="kanban-search"
          data-testid="kanban-search"
          placeholder="Search cards"
          aria-label="Search cards"
          value={filter.query}
          onChange={(e) => filter.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !filter.query) return;
            e.preventDefault();
            e.stopPropagation();
            filter.setQuery('');
          }}
        />
        {filter.query && (
          <button
            type="button"
            className="kanban-search-clear"
            data-testid="kanban-search-clear"
            aria-label="Clear search"
            title="Clear"
            onClick={() => { filter.setQuery(''); inputRef.current?.focus(); }}
          >{ICON_CLOSE}</button>
        )}
      </div>
      {/* N18: after the search, so turning Changed on never moves it. */}
      {filter.chip === 'changed' && (
        <div className="kanban-changed-actions">
          <button
            type="button"
            className="kanban-text-btn"
            data-testid="kanban-mark-seen"
            title="Count nothing as changed from now on"
            onClick={() => { seen.markAllSeen(); filter.setChip(null); }}
          >Mark all seen</button>
          <button
            ref={changesBtn}
            type="button"
            className="kanban-text-btn"
            data-testid="kanban-changes-open"
            aria-haspopup="menu"
            aria-expanded={changesOpen}
            onClick={() => setChangesOpen((v) => !v)}
          >What changed</button>
          <KanbanChanges open={changesOpen} anchorRef={changesBtn} changes={board.changes} onPick={onRevealCard} onClose={closeChanges} />
        </div>
      )}
    </div>
  );
}
