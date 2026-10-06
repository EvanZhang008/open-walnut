/**
 * The kanban's one filter (spec 7.2): a single chip (or the rollup's "task
 * still open"), and a search that intersects with it. G13: a chip's members
 * freeze when it turns on; a card that later matches joins, a card that stops
 * matching STAYS (50%, `Handled`) until the chip changes, so a card the user
 * just answered never vanishes from under the pointer. The rules are pure
 * (`filterMembers`, `filterView`), unit-pinned in tests/web/kanban-filter-state.test.ts.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { log } from '@/utils/log';
import { NO_PROJECTS, type ProjectOf } from '../board-view-projects';
import type { KanbanFilterApi, KanbanFilterKey, UseKanbanFilter } from './kanban-contract';
import type { KanbanBoardVM } from './kanban-model';
import { emptyTextFor, handledIds, matchesChip, matchesSearch, nextMembers } from './kanban-filter-model';

export interface FilterMembers {
  chip: KanbanFilterKey | null;
  members: Set<string> | null;
}

/** The cards matching `chip` now. */
export function matchingIds(board: Pick<KanbanBoardVM, 'cards'>, chip: KanbanFilterKey | null): Set<string> {
  const out = new Set<string>();
  if (!chip) return out;
  for (const c of Object.values(board.cards)) if (matchesChip(c, chip)) out.add(c.taskId);
  return out;
}

/** G13: a new chip starts from what matches now; the same chip only ever adds. */
export function filterMembers(prev: FilterMembers | null, chip: KanbanFilterKey | null, matching: ReadonlySet<string>): FilterMembers {
  if (!chip) return { chip: null, members: null };
  if (!prev || prev.chip !== chip || !prev.members) return { chip, members: new Set(matching) };
  return { chip, members: nextMembers(prev.members, matching) };
}

/** The chip's live number: its count, or the rollup's `still open` count. */
export function liveCount(board: Pick<KanbanBoardVM, 'chips' | 'rollup'>, chip: KanbanFilterKey): number {
  return chip === 'still-open' ? board.rollup.stillOpen : board.chips[chip];
}

export interface FilterView {
  visible: Set<string>;
  handled: Set<string>;
  emptyText: string;
}

/**
 * Which cards show (chip members, intersected with the search and the project),
 * which are handled, and the centre line.
 */
export function filterView(
  board: Pick<KanbanBoardVM, 'cards' | 'chips' | 'rollup'>, state: FilterMembers, matching: ReadonlySet<string>, query: string,
  project: string | null = null, projectOf: ProjectOf = NO_PROJECTS,
): FilterView {
  const visible = new Set<string>();
  for (const c of Object.values(board.cards)) {
    if (state.chip && !(state.members?.has(c.taskId) || matching.has(c.taskId))) continue;
    if (!matchesSearch(c, query)) continue;
    if (project && projectOf.get(c.taskId)?.id !== project) continue;
    visible.add(c.taskId);
  }
  const handled = state.chip && state.members ? handledIds(state.members, matching) : new Set<string>();
  const emptyText = state.chip && liveCount(board, state.chip) === 0 ? emptyTextFor(state.chip) : '';
  return { visible, handled, emptyText };
}

export const useKanbanFilter: UseKanbanFilter = (board, projectOf = NO_PROJECTS) => {
  const [chip, setChipState] = useState<KanbanFilterKey | null>(null);
  const [query, setQueryState] = useState('');
  const [pickedProject, setProjectState] = useState<string | null>(null);
  // A project the board no longer has (renamed id, removed) filters nothing.
  const picked = pickedProject ? [...projectOf.values()].find((p) => p.id === pickedProject) : undefined;
  const project = picked ? picked.id : null;
  const projectTitle = picked ? picked.title || picked.id : '';
  const membersRef = useRef<FilterMembers | null>(null);
  const ownerId = board.ownerId;

  const view = useMemo(() => {
    const matching = matchingIds(board, chip);
    // A union of what matched: re-running it (StrictMode) gives the same set.
    const members = filterMembers(membersRef.current, chip, matching);
    membersRef.current = members;
    return filterView(board, members, matching, query, project, projectOf);
  }, [board, chip, query, project, projectOf]);

  const setChip = useCallback((next: KanbanFilterKey | null) => {
    membersRef.current = null;
    setChipState(next);
    log.info('board', 'kanban filter', { taskId: ownerId, chip: next ?? '' });
  }, [ownerId]);
  const toggleChip = useCallback((next: KanbanFilterKey) => {
    setChipState((cur) => {
      membersRef.current = null;
      const out = cur === next ? null : next;
      log.info('board', 'kanban filter', { taskId: ownerId, chip: out ?? '' });
      return out;
    });
  }, [ownerId]);
  const setQuery = useCallback((q: string) => setQueryState(q), []);
  const setProject = useCallback((next: string | null) => {
    setProjectState(next);
    log.info('board', 'kanban project filter', { taskId: ownerId, projectId: next ?? '' });
  }, [ownerId]);
  const showStillOpen = useCallback(() => setChip('still-open'), [setChip]);

  return useMemo<KanbanFilterApi>(() => ({
    chip, query, active: chip !== null || query.trim() !== '' || project !== null,
    toggleChip, setChip, setQuery,
    isVisible: (id: string) => view.visible.has(id),
    isHandled: (id: string) => view.handled.has(id),
    emptyText: view.emptyText,
    showStillOpen,
    project, projectTitle, setProject,
  }), [chip, query, toggleChip, setChip, setQuery, view, showStillOpen, project, projectTitle, setProject]);
};
