/**
 * useHomeFilters: the home task panel's filter state, moved out of TodoPanel.
 *
 * It owns the two internal models (spec D5): the legacy fields (`dateFilter`,
 * `phaseFilter`, `activeProject`, `showCompleted`, `showWaiting`) and the
 * canonical `TaskQueryFilterState`. The user sees one set of chips, a projection
 * over both (filter-bar-model). Every write goes through `apply`, which writes
 * both models, the tab bookmark, the persisted record (4.8) and Recent (4.7).
 *
 * The state is read synchronously in the useState initialisers, so the first
 * render is already narrowed (no flash of every task before the chips land).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { log } from '@/utils/log';
import { hasOpenOverlayLayer } from '@/hooks/useOverlayLayer';
import { useNotifications } from '@/contexts/notifications';
import { useShowPriority } from '@/hooks/useShowPriority';
import { useTagDisplay } from '@/stores/tag-display-store';
import { DEFAULT_TASK_QUERY_FILTER_STATE, type TaskQueryFilterState } from './view-filter-model';
import { logTaskQueryChange } from './ViewDropdown';
import { deriveSourceOptions, deriveSprintOptions, deriveTagOptions } from './task-query-state';
import { sourceDisplayName } from './task-move-project';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { LS_TAB_KEY } from './task-tabs';
import {
  type FilterLists,
  type FilterOrigin,
  type FilterState,
  type LegacyFilterFields,
} from './filter-bar-types';
import { buildFilterChips, clearedState, isDimDefault, migrateLegacy, readFilterState, writeFilterState } from './filter-bar-model';
import { FILTER_DIMS, type FilterDim } from './filter-bar-types';
import { buildFilterEvalContext, hiddenByText, showValueFor, type FilterEvalContext, type HiddenReason } from './filter-predicate';
import { projectLabel } from './filter-bar-model';
import { computeFacetCounts } from './filter-facets';
import { RECENT_STORE_LIMIT, createdToastId, pushRecent, readPersistedFilters, readRecent, writePersistedFilters } from './filter-bar-persist';
import { recentEntriesFor, validRecent } from './filter-recent';

const DEFAULT_LEGACY: LegacyFilterFields = {
  dateFilter: 'now', phaseFilter: '', activeProject: '', showCompleted: false, showWaiting: false,
};

/** Origins that record Recent entries (4.7): the user picked a value on purpose. */
const RECENT_ORIGINS: ReadonlySet<FilterOrigin> = new Set<FilterOrigin>(['menu', 'chip-menu', 'search', 'recent']);

/** Toast lifetime for `Filters cleared` + Undo (6.4). */
export const CLEAR_UNDO_MS = 8000;

interface ModelPair { legacy: LegacyFilterFields; query: TaskQueryFilterState }

/** First-render state: the persisted chips, else the defaults, plus a URL project. */
export function initialFilterModels(urlProject: string | undefined): ModelPair {
  const persisted = readPersistedFilters();
  const base: ModelPair = persisted
    ? (({ legacy, query }) => ({ legacy, query }))(writeFilterState(persisted, DEFAULT_TASK_QUERY_FILTER_STATE))
    : { legacy: { ...DEFAULT_LEGACY }, query: { ...DEFAULT_TASK_QUERY_FILTER_STATE } };
  if (!urlProject) return base;
  return migrateLegacy({ ...base.legacy, activeProject: urlProject }, base.query);
}

/** Board order for the Project values: Inbox first, then `projectOrder`, then by name. */
export function orderFilterProjects(tasks: readonly Pick<Task, 'project'>[], projectOrder: readonly string[] | undefined): string[] {
  const byLower = new Map<string, string>();
  let inbox = false;
  for (const t of tasks) {
    const p = t.project || '';
    if (!p) { inbox = true; continue; }
    if (!byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
  }
  const rank = new Map((projectOrder ?? []).map((name, i) => [name.toLowerCase(), i]));
  const names = [...byLower.values()].sort((a, b) => {
    const ra = rank.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  return inbox ? ['', ...names] : names;
}

/** The pill text a tag has on the board (`label:urgent` reads `urgent`). */
export function tagPillText(tag: string, valueOnly: (tag: string) => boolean): string {
  const at = tag.indexOf(':');
  return at > 0 && at < tag.length - 1 && valueOnly(tag) ? tag.slice(at + 1) : tag;
}

export interface HomeFiltersOptions {
  tasks: Task[];
  loading: boolean;
  projectOrder?: string[];
  externalProject?: string;
  onProjectChange?: (project: string) => void;
  clearFocusOverride: () => void;
  /** Re-arms relative time windows (the panel's 60s tick, 0 when no window is set). */
  timeTick?: number;
}

/** Focus is in something the user types into. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** A menu or dialog outside the overlay-layer stack is open. */
function otherOverlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([hidden]), [role="menu"]:not([hidden]), [role="alertdialog"]');
}

function persistTab(tab: string): void {
  try { localStorage.setItem(LS_TAB_KEY, tab); } catch { /* quota: ignore, like the date key */ }
}

/** A dimension went from its default to a set value: the user added a chip. */
export function addsChip(prev: FilterState, next: FilterState): boolean {
  return FILTER_DIMS.some((d) => isDimDefault(prev, d) && !isDimDefault(next, d));
}

export function useHomeFilters(opts: HomeFiltersOptions) {
  const { tasks, loading, projectOrder, externalProject, onProjectChange, clearFocusOverride, timeTick = 0 } = opts;
  const [models, setModels] = useState<ModelPair>(() => initialFilterModels(externalProject));
  const { legacy, query: taskQueryState } = models;
  const state = useMemo(() => readFilterState(legacy, taskQueryState), [legacy, taskQueryState]);
  // Event handlers read the latest models; apply() also advances the ref itself
  // so two writes in one handler (Clear, then Undo) compose.
  const modelsRef = useRef(models);
  const stateRef = useRef(state);
  useEffect(() => { modelsRef.current = models; stateRef.current = state; }, [models, state]);

  const [recentRaw, setRecentRaw] = useState(readRecent);
  const [menuOpen, setMenuOpen] = useState(false);
  // A row chip's menu lists the same counts as the popover (F20).
  const [chipMenuOpen, setChipMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLElement | null>(null);
  const { notify, dismissToast, pinToast } = useNotifications();
  const clearToastRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const dropClearToast = useCallback(() => {
    const t = clearToastRef.current;
    if (!t) return;
    clearTimeout(t.timer);
    clearToastRef.current = null;
    dismissToast(t.id);
  }, [dismissToast]);
  useEffect(() => () => { if (clearToastRef.current) clearTimeout(clearToastRef.current.timer); }, []);

  const apply = useCallback((next: FilterState, origin: FilterOrigin) => {
    const prev = stateRef.current;
    const w = writeFilterState(next, modelsRef.current.query);
    const pair = { legacy: w.legacy, query: w.query };
    modelsRef.current = pair;
    stateRef.current = next;
    setModels(pair);
    logTaskQueryChange('todo-panel', w.query);
    persistTab(w.bookmark);
    onProjectChange?.(w.bookmark);
    writePersistedFilters(next);
    if (RECENT_ORIGINS.has(origin)) setRecentRaw(pushRecent(recentEntriesFor(prev, next)));
    if (origin !== 'undo' && addsChip(prev, next)) dropClearToast();
    log.info('filter-bar', 'filters applied', { origin });
    clearFocusOverride();
  }, [onProjectChange, clearFocusOverride, dropClearToast]);

  const clearAll = useCallback(() => {
    const snapshot = stateRef.current;
    apply(clearedState(), 'board');
    dropClearToast();
    const id = `filters-cleared-${Date.now()}`;
    notify({
      id, kind: 'sort', severity: 'info', title: 'Filters cleared', persistent: false, dedupKey: id,
      action: { label: 'Undo', kind: 'callback' },
      onAction: () => { clearToastRef.current = null; apply(snapshot, 'undo'); },
    });
    // The 'sort' kind dismisses after 3s; Undo needs its full 8s window.
    pinToast(id);
    const timer = setTimeout(() => {
      if (clearToastRef.current?.id === id) clearToastRef.current = null;
      dismissToast(id);
    }, CLEAR_UNDO_MS);
    clearToastRef.current = { id, timer };
  }, [apply, notify, pinToast, dismissToast, dropClearToast]);

  /** Widen just enough to let `task` in (5.11 / 5.12 Show). */
  const showTask = useCallback((task: Task, dims: readonly FilterDim[], origin: FilterOrigin) => {
    let next = stateRef.current;
    for (const dim of dims) next = showValueFor(next, task, dim);
    apply(next, origin);
  }, [apply]);

  // 6.8: F opens Filter (focus lands in Search filters), like `/` opens search:
  // never while typing, with a modifier, or over another menu or dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat) return;
      if (isTypingTarget(document.activeElement) || hasOpenOverlayLayer() || otherOverlayOpen()) return;
      const button = buttonRef.current;
      if (!button || !button.isConnected || button.closest('[inert]') || button.offsetParent === null) return;
      e.preventDefault();
      setMenuOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // URL restore (MainPage passes the URL's project): fold it into the Project set.
  const prevExternalRef = useRef(externalProject);
  useEffect(() => {
    if (externalProject === prevExternalRef.current) return;
    prevExternalRef.current = externalProject;
    if (!externalProject) return;
    const m = migrateLegacy({ ...modelsRef.current.legacy, activeProject: externalProject }, modelsRef.current.query);
    if (m.query.projects.length === modelsRef.current.query.projects.length) return;
    apply(readFilterState(m.legacy, m.query), 'board');
  }, [externalProject, apply]);

  const showPriority = useShowPriority();
  const tagDisplay = useTagDisplay().compiled;
  const integrations = useIntegrations();
  const lists = useMemo<FilterLists>(() => ({
    loading,
    projects: orderFilterProjects(tasks, projectOrder),
    sources: deriveSourceOptions(tasks).map((id) => ({
      id,
      label: id === 'local' ? 'Local' : (getIntegrationMeta(integrations, id)?.name ?? sourceDisplayName(id)),
    })),
    tags: deriveTagOptions(tasks, tagDisplay.shown),
    sprints: deriveSprintOptions(tasks),
    showPriority,
    tagLabel: (tag: string) => tagPillText(tag, tagDisplay.valueOnly),
  }), [loading, tasks, projectOrder, integrations, tagDisplay, showPriority]);

  const chips = useMemo(() => buildFilterChips(state, lists), [state, lists]);
  // One `now` per state change; timeTick re-arms a relative time window.
  // Only a relative time window needs the tick; Date reads the clock per call.
  const windowTick = state.time.preset === null ? 0 : timeTick;
  const evalCtx = useMemo<FilterEvalContext>(
    () => buildFilterEvalContext(tasks, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- windowTick re-arms relative windows
    [tasks, state, windowTick],
  );
  // Facet counts only while the popover is open (4.1: one pass, keyed on the chips).
  const facets = useMemo(
    () => (menuOpen || chipMenuOpen ? computeFacetCounts(tasks, evalCtx) : {}),
    [menuOpen, chipMenuOpen, tasks, evalCtx],
  );
  // Every stored pick that still exists: the menu ranks them by use and caps the rows itself.
  const recent = useMemo(() => validRecent(recentRaw, lists, RECENT_STORE_LIMIT), [recentRaw, lists]);

  return useMemo(() => ({
    /** Legacy fields (D5), written only through apply. */
    showCompleted: legacy.showCompleted,
    showWaiting: legacy.showWaiting,
    taskQueryState,
    state, lists, chips, evalCtx, facets, recent,
    apply, clearAll, showTask,
    menuOpen, setMenuOpen, setChipMenuOpen,
    buttonRef, rowRef, listScrollRef,
  }), [legacy, taskQueryState, state, lists, chips, evalCtx, facets, recent, apply, clearAll, showTask, menuOpen]);
}

export type HomeFilters = ReturnType<typeof useHomeFilters>;


export const ARCHIVE_FAILED_TEXT = 'Could not load older completed tasks. Showing the ones already loaded.';

interface ArchiveStore {
  ensureAllTasks: () => void;
  refetch: () => void;
  refreshing: boolean;
  error: string | null;
  completedHidden: number;
}

/**
 * The completed archive behind a Status that shows Complete (5.8). Loads once
 * through the store's ensureAllTasks; while it is in flight the count slot says
 * `Loading completed`; a failed load keeps the chip and the loaded rows and
 * says so once in a toast; the next time Complete is turned on it tries again.
 * Returns true while the archive is loading.
 */
export function useArchiveFetch(want: boolean, store: ArchiveStore | null | undefined): boolean {
  const { notify } = useNotifications();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed'>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const ensureAllTasks = store?.ensureAllTasks;
  const refetch = store?.refetch;
  const hidden = store?.completedHidden ?? 0;
  useEffect(() => {
    if (!want || !ensureAllTasks) return;
    if (phaseRef.current === 'failed') refetch?.(); else ensureAllTasks();
    setPhase('loading');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per turn-on
  }, [want, ensureAllTasks]);
  const refreshing = !!store?.refreshing;
  const error = store?.error ?? null;
  useEffect(() => {
    if (phase !== 'loading' || refreshing) return;
    if (error) {
      setPhase('failed');
      log.warn('filter-bar', 'completed archive failed to load', { error, hidden });
      notify({ kind: 'operation-error', severity: 'error', title: ARCHIVE_FAILED_TEXT, persistent: false, dedupKey: 'filter-archive-failed' });
    } else {
      setPhase('idle');
    }
  }, [phase, refreshing, error, hidden, notify]);
  return want && phase === 'loading';
}

/**
 * 5.11: a task created moments ago that the chips hide stays on screen through
 * the focus override; say once where it went and offer to widen the chips.
 */
export function useCreatedOutsideToast(
  info: { task: Task; reasons: readonly HiddenReason[] } | undefined,
  showTask: (task: Task, dims: readonly FilterDim[], origin: FilterOrigin) => void,
): void {
  const { notify, pinToast, dismissToast } = useNotifications();
  const toasted = useRef(new Set<string>());
  useEffect(() => {
    if (!info || toasted.current.has(info.task.id)) return;
    toasted.current.add(info.task.id);
    const { task, reasons } = info;
    // One message per create (F33): this one replaces "Task created", and it
    // stays for the same 8s as Undo, so Show can actually be reached (F07).
    dismissToast(createdToastId(task.id));
    const id = `filter-outside-${task.id}`;
    notify({
      id, kind: 'sort', severity: 'info', persistent: false, dedupKey: id,
      title: `Saved to ${projectLabel(task.project || '')}. ${hiddenByText(reasons)}`,
      action: { label: 'Show', kind: 'callback' },
      onAction: () => showTask(task, reasons.map((r) => r.dim), 'toast'),
    });
    pinToast(id);
    setTimeout(() => dismissToast(id), CLEAR_UNDO_MS);
  }, [info, notify, pinToast, dismissToast, showTask]);
}
