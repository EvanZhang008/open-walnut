/**
 * The live data behind the Board's Overview (board-overview-model.ts), and the
 * pane's remembered view (board-view-pref.ts).
 *
 * Everything here is already live in the browser, so nothing polls: the team
 * and each task's phase come from the task store, each session's state from the
 * session-status store (one subscription, its epoch), and the page's signals
 * from the board payload `useTaskBoard` keeps current. The only clock is a
 * minute tick, for "a reminder is due" and the rows' "3m" times.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { sessionStatusStore } from '@/stores/session-status-store';
import { formatWaitUntil } from '@/components/tasks/TaskStatusControl';
import { log } from '@/utils/log';
import { resolveTaskSessionId } from '@/utils/session-status';
import type { BoardPayload, BoardSeen } from './board-model';
import {
  NO_BOARD_ELEMENTS, buildTeamOverview, teamChildren, type BoardElement, type BoardElements, type LiveStatus, type TeamOverview,
} from './board-overview-model';
import { buildProjectCards, type ProjectCard } from './board-cards-model';
import { readBoardView, shownBoardView, writeBoardView, type BoardView } from './board-view-pref';

const MINUTE_MS = 60_000;

/** A clock that moves once a minute (the value is the minute). */
function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / MINUTE_MS));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => { setMinute(Math.floor(Date.now() / MINUTE_MS)); arm(); }, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return minute;
}

/** A choice's context on a card is a few lines, not the author's whole block. */
const CONTEXT_MAX = 600;

function elementsOf(doc: Document, selector: string, choice = false): BoardElement[] {
  return Array.from(doc.querySelectorAll(selector)).map((el) => {
    const out: BoardElement = {
      id: el.getAttribute('id') ?? '',
      title: (el.getAttribute('title') ?? '').trim(),
      task: (el.getAttribute('task') ?? '').trim(),
      project: (el.closest('[data-project]')?.getAttribute('data-project') ?? '').trim(),
    };
    if (choice) {
      // The parsed document is inert, so a choice's text is the author's own context alone.
      const context = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      out.options = el.getAttribute('options') ?? '';
      out.recommended = (el.getAttribute('recommended') ?? '').trim();
      out.context = context.length > CONTEXT_MAX ? `${context.slice(0, CONTEXT_MAX - 1)}…` : context;
    }
    return out;
  }).filter((el) => el.id);
}

/** The board projects the page shows, in document order (a section's `data-project`, a pill's id), each once. */
function projectsOf(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('[data-project], walnut-project[id]'))) {
    const id = (el.getAttribute('data-project') ?? el.getAttribute('id') ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The page's choices, threads and projects, read with DOMParser: an inert
 * document (no script runs, nothing loads), parsed once per html version.
 */
export function parseBoardElements(html: string | null | undefined): BoardElements {
  if (!html || typeof DOMParser === 'undefined') return NO_BOARD_ELEMENTS;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { choices: elementsOf(doc, 'walnut-choice[id]', true), threads: elementsOf(doc, 'walnut-thread[id]'), projects: projectsOf(doc) };
  } catch (err) {
    log.warn('board', 'board html not parsed for the overview', { error: err instanceof Error ? err.message : String(err) });
    return NO_BOARD_ELEMENTS;
  }
}

export interface TeamOverviewState {
  overview: TeamOverview | null;
  /** The board's projects as cards (board-cards-model.ts); null when the board defines none. */
  cards: ProjectCard[] | null;
  /** The task store has not answered yet. */
  loading: boolean;
  /** Finished tasks older than the store's recent window are not loaded (see useTasks). */
  completedHidden: number;
  loadArchive: () => void;
}

/** The team under `ownerId`, live. Null overview when there is no task store (a pop-out window). */
export function useTeamOverview(
  ownerId: string,
  payload: BoardPayload | null,
  seen: BoardSeen,
): TeamOverviewState {
  const store = useTasksContextSafe();
  const epoch = useSessionStatusEpoch();
  const minute = useMinute();
  const html = payload?.board?.html ?? null;
  const elements = useMemo(() => parseBoardElements(html), [html]);
  const tasks = store?.tasks;

  const overview = useMemo(() => {
    if (!tasks) return null;
    const owner = tasks.find((t) => t.id === ownerId) ?? null;
    const statusOf = (task: Task): LiveStatus | null => {
      const sid = resolveTaskSessionId(task);
      if (!sid) return null;
      return sessionStatusStore.getStatus(sid) ?? task.session_status ?? null;
    };
    return buildTeamOverview({
      ownerId,
      owner,
      childrenOf: teamChildren(tasks, ownerId),
      statusOf,
      elements,
      board: payload ? { choices: payload.choices, reminders: payload.reminders, threads: payload.threads } : null,
      projects: payload?.projects ?? null,
      seen,
      now: Date.now(),
      formatWaitUntil,
    });
    // `epoch` and `minute` are the triggers: the session store and the clock moved.
  }, [tasks, ownerId, elements, payload, seen, epoch, minute]); // eslint-disable-line react-hooks/exhaustive-deps

  const cards = useMemo(() => {
    if (!overview?.sections) return null;
    return buildProjectCards({
      sections: overview.sections,
      projects: payload?.projects ?? null,
      elements,
      board: payload ? { choices: payload.choices, threads: payload.threads, reminders: payload.reminders } : null,
      seen,
      now: Date.now(),
    });
    // `minute` moves a reminder from pending to due.
  }, [overview, payload, elements, seen, minute]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureAll = store?.ensureAllTasks;
  const loadArchive = useCallback(() => { ensureAll?.(); }, [ensureAll]);
  return {
    overview,
    cards,
    loading: !!store?.loading,
    completedHidden: store?.completedHidden ?? 0,
    loadArchive,
  };
}

/** `window.localStorage`, or null where reading it throws (a sandboxed or private context). */
function viewStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** The view on screen for `ownerId`'s board, and the pick that changes (and remembers) it. */
export function useBoardView(ownerId: string, hasPage: boolean): { view: BoardView; picked: BoardView | null; pick: (v: BoardView) => void } {
  const [state, setState] = useState<{ owner: string; view: BoardView | null }>(() => ({
    owner: ownerId, view: readBoardView(viewStorage(), ownerId),
  }));
  // Another owner's pick is not this one's: read it in the same render the owner changes.
  const picked = state.owner === ownerId ? state.view : readBoardView(viewStorage(), ownerId);
  const pick = useCallback((view: BoardView) => {
    writeBoardView(viewStorage(), ownerId, view);
    setState({ owner: ownerId, view });
    log.info('board', 'board view picked', { taskId: ownerId, view });
  }, [ownerId]);
  return { view: shownBoardView(picked, hasPage), picked, pick };
}
