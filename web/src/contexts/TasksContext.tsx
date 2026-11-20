import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTasks, type CreateHooks, type FolderMeta } from '@/hooks/useTasks';
import type { Task } from '@open-walnut/core';
import type { BatchTaskOutcome, CreateTaskInput, PluginFieldRef, UpdateTaskInput } from '@/api/tasks';
import { setTaskLabelFetcher, syncTasks as syncEntityLabels } from '@/stores/entity-label-store';
import { fetchTasksBulk } from '@/api/tasks';
import { userStateOf } from '@open-walnut/org-tree';
import type { UserState } from '@open-walnut/user-status';
import { startTaskPillStatus } from '@/utils/task-pill-status';

/** The shape exposed by TasksContext — mirrors useTasks() return. */
export interface TasksContextValue {
  tasks: Task[];
  loading: boolean;
  refreshing: boolean;
  /** Completed tasks older than the recent window not loaded yet; see useTasks. */
  completedHidden: number;
  ensureAllTasks: () => void;
  error: string | null;
  operationError: string | null;
  clearOperationError: () => void;
  showOperationError: (msg: string) => void;
  refetch: () => void;
  create: (input: CreateTaskInput, hooks?: CreateHooks) => Promise<Task>;
  /** Each resolves whether the server took the write (it is optimistic either way). */
  update: (id: string, updates: UpdateTaskInput) => Promise<boolean>;
  toggleComplete: (id: string) => Promise<boolean>;
  /** `onError`: the caller words a refusal itself (the Board's toast); the store reports nothing. */
  complete: (id: string, opts?: { onError?: (err: Error) => void }) => Promise<boolean>;
  /** Resolves true once the server took the write, false when it refused (already reported). */
  /** `row`: the caller's copy of a row the list does not hold yet; its first answer keeps the new phase. */
  setPhase: (id: string, phase: string, opts?: { undoOf?: string; unread?: boolean; row?: Task; onError?: (err: Error) => void }) => Promise<boolean>;
  /** Reorder within ONE project group. `project: ''` = Inbox. */
  reorder: (project: string, taskIds: string[]) => void;
  /** Move a task to another project ('' = Inbox), optionally next to a sibling. */
  moveTask: (taskId: string, project: string, insertNearTaskId?: string) => void;
  reparentTask: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  /** Optimistic remove + DELETE (`force` gets past the active-session guard).
   *  Resolves TRUE when the server accepted it; never rejects. */
  deleteTask: (id: string, opts?: { force?: boolean }) => Promise<boolean>;
  /** Hide rows while their delete can still be undone (no server write). */
  hideTasks: (ids: string[]) => void;
  unhideTasks: (ids: string[]) => void;
  /** Write a plugin-declared task field optimistically. `donor` = the caller's
   *  richest copy of the row (the list payload carries no `ext`). */
  setPluginField: (
    id: string,
    field: PluginFieldRef,
    value: string | null,
    donor?: { sprint?: string; ext?: Record<string, unknown> },
  ) => void;
  /** One plugin field on many tasks in one request; resolves with what did not apply. */
  batchSetPluginField: (ids: string[], field: PluginFieldRef, value: string | null) => Promise<BatchTaskOutcome[]>;
  /** Multi-select batch ops — one round-trip; resolve with the per-task `failed` list. */
  batchSetPhase: (ids: string[], phase: string) => Promise<BatchTaskOutcome[]>;
  batchDelete: (ids: string[], opts?: { force?: boolean }) => Promise<BatchTaskOutcome[]>;
  bakeOrder: (orderedIds: string[]) => void;
  /** Local-only batch patch (no API call) — for optimistic flows (Focus Bar pin/tier).
   *  `pending` holds it over list reads until the returned settle runs (a write still out). */
  patchTasksLocal: (patches: Record<string, Partial<Task>>, opts?: { pending?: boolean }) => () => void;
  /** Show the status a change will derive to on every surface now, until the server's own
   *  arrives (hooks/status-prediction.ts). Returns the undo for a write the server refused. */
  predictStatus: (id: string, make: (row: Task) => import('@open-walnut/user-status').UserStatus | undefined, opts?: import('@/hooks/status-prediction').PredictOptions) => () => void;
  /** Suppress the next WS echo for a key (e.g. `update:<id>`) — pair with own API call. */
  guardEcho: (key: string) => void;
  taskGroups: Record<string, string>;
  hiddenGroups: Set<string>;
  folderMeta: Record<string, FolderMeta>;
  groupTasks: (taskIds: string[], label?: string, opts?: { moveInto?: string }) => void;
  addToGroup: (groupId: string, taskIds: string[], opts?: { moveInto?: string }) => void;
  ungroupTasks: (taskIds: string[]) => void;
  renameGroup: (groupId: string, label: string) => void;
  setGroupHidden: (groupId: string, hidden: boolean) => void;
  createFolder: (label: string, project: string, parentId?: string) => void;
  deleteFolder: (groupId: string) => void;
  setFolderParent: (groupId: string, parentId: string | null) => void;
  /** Move a folder to another project ('' = Inbox): subfolders + members come
   *  along. Resolves true only when the server accepted the move. */
  moveFolderToProject: (groupId: string, project: string) => Promise<boolean>;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/**
 * The same list, read one row at a time. TasksContext changes with every task update, so a
 * component that reads it re-renders for every task anywhere: each open chat column drew its
 * whole panel and history again for every agent's status write (about 13 a minute on the
 * user's Mac, 2026-11-16, task 9bceb9f2). A surface that shows ONE task reads it here
 * (useStoreTask) and re-renders only when that row changes. The object is the provider's for
 * its whole life; `latest` is the list its newest render held (set during that render, so a
 * row read in the same render agrees with the context), and the subscribers hear of a new
 * list once that render is on screen (a layout effect, before the frame paints).
 */
interface TaskRows {
  latest: readonly Task[];
  /** The list's own state beside it (useTaskListSelect), set with `latest`. */
  loading: boolean;
  error: string | null;
  indexed: readonly Task[] | null;
  byId: Map<string, Task>;
  listeners: Set<() => void>;
  /** The provider's newest value: for event handlers (update, has), never read during render. */
  store: TasksContextValue | null;
  /** Made once with the rows, so a hook hands React the same function every render. */
  subscribe: (listener: () => void) => () => void;
  actions: TaskStoreActions;
}

/**
 * The store's writes without its rows: a hook or a panel that only WRITES (a thread acted on, a
 * Board card's phase) reads these, never the whole context, so a task write elsewhere does not
 * draw it again (2026-11-20: an open chat's panel drew once per agent status write because its
 * Threads hook read the full context for predictStatus; app-responsiveness-budget.spec.ts).
 */
export interface TaskStoreActions {
  has: (taskId: string) => boolean;
  update: TasksContextValue['update'];
  setPhase: TasksContextValue['setPhase'];
  complete: TasksContextValue['complete'];
  predictStatus: TasksContextValue['predictStatus'];
}

/** Module level on purpose: its closures hold the rows, never a render (useLeanCallback.ts). */
function makeTaskRows(tasks: readonly Task[], loading: boolean, error: string | null): TaskRows {
  const rows: TaskRows = {
    latest: tasks, loading, error, indexed: null, byId: new Map(), listeners: new Set(), store: null,
    subscribe: (listener) => { rows.listeners.add(listener); return () => { rows.listeners.delete(listener); }; },
    actions: {
      has: (taskId) => rowOf(rows, taskId) !== null,
      update: (id, updates) => (rows.store ? rows.store.update(id, updates) : Promise.resolve(false)),
      setPhase: (id, phase, opts) => (rows.store ? rows.store.setPhase(id, phase, opts) : Promise.resolve(false)),
      complete: (id, opts) => (rows.store ? rows.store.complete(id, opts) : Promise.resolve(false)),
      predictStatus: (id, make, opts) => (rows.store ? rows.store.predictStatus(id, make, opts) : () => {}),
    },
  };
  return rows;
}

const TaskRowsContext = createContext<TaskRows | null>(null);

function rowOf(rows: TaskRows, id: string): Task | null {
  if (rows.indexed !== rows.latest) {
    rows.byId = new Map(rows.latest.map((t) => [t.id, t] as const));
    rows.indexed = rows.latest;
  }
  return rows.byId.get(id) ?? null;
}

/** Provider that wraps useTasks() into a shared context — one fetch for all consumers. */
const taskStates = new WeakMap<Task, UserState>();
function stateOfTask(task: Task): UserState {
  let state = taskStates.get(task);
  if (state === undefined) { state = userStateOf(task); taskStates.set(task, state); }
  return state;
}

export function TasksProvider({ children }: { children: ReactNode }) {
  const t = useTasks();

  // Feed the entity-label store (task-ref pill titles). Every mutation path
  // (REST refetch, WS events, optimistic edits) funnels into t.tasks, so this
  // one effect covers them all. The loading guard matters: the pre-fetch []
  // would otherwise wipe the registry on boot.
  useEffect(() => {
    if (!t.loading) syncEntityLabels(t.tasks);
  }, [t.tasks, t.loading]);

  // A task a message names that the list does not hold is looked up (one
  // batched call, entity-label-store.ts), and every pill on the page shows its
  // task's live status (task-pill-status.ts).
  const statesRef = useRef<{ list: ReadonlyMap<string, UserState>; fetched: Map<string, UserState> }>({ list: new Map(), fetched: new Map() });
  const pillStatus = useRef<{ refresh(): void } | null>(null);
  useEffect(() => {
    setTaskLabelFetcher(async (tokens) => {
      const rows = await fetchTasksBulk(tokens, ['title', 'project', 'org_role', 'phase', 'user_status'], { timeoutMs: 8_000 });
      return tokens.map((token, i) => {
        const row = rows[i];
        if (!row || row.error || typeof row.title !== 'string') return { token };
        statesRef.current.fetched.set(row.id, userStateOf(row as Pick<Task, 'phase' | 'user_status'>));
        return { token, task: { id: row.id, title: row.title, project: row.project, org_role: row.org_role } };
      });
    });
    const status = startTaskPillStatus(document.body, (id) => statesRef.current.list.get(id) ?? statesRef.current.fetched.get(id));
    pillStatus.current = status;
    return () => { setTaskLabelFetcher(null); status.stop(); pillStatus.current = null; };
  }, []);
  useEffect(() => {
    if (t.loading) return;
    // A task object never changes: its state is worked out once (stateOfTask), not for every task on every update.
    statesRef.current.list = new Map(t.tasks.map((task) => [task.id, stateOfTask(task)] as const));
    pillStatus.current?.refresh();
  }, [t.tasks, t.loading]);

  // Stabilize context value: useMemo prevents new object identity on every render.
  // useTasks callbacks are already stable (useCallback), so only data fields trigger
  // updates. EVERY data field must be listed — folderMeta was missing, so a folder's
  // project/parent change (create, re-parent, move to another project) reached the
  // context only when some OTHER field happened to change in the same render.
  const value = useMemo<TasksContextValue>(() => t,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t's callbacks are stable via useCallback
    [t.tasks, t.taskGroups, t.hiddenGroups, t.folderMeta, t.loading, t.refreshing, t.error, t.operationError]);

  const rows = useState<TaskRows>(() => makeTaskRows(t.tasks, t.loading, t.error))[0];
  rows.latest = t.tasks;
  rows.loading = t.loading;
  rows.error = t.error;
  useLayoutEffect(() => {
    rows.store = value;
  }, [rows, value]);
  useLayoutEffect(() => {
    for (const listener of [...rows.listeners]) listener();
  }, [rows, t.tasks, t.loading, t.error]);

  return (
    <TaskRowsContext.Provider value={rows}>
      <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
    </TaskRowsContext.Provider>
  );
}

/**
 * Consume shared tasks from TasksContext.
 * Must be used within a TasksProvider (AppShell wraps the entire app).
 */
export function useTasksContext(): TasksContextValue {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error('useTasksContext must be used within a TasksProvider');
  return ctx;
}

/**
 * Same store, but null outside a TasksProvider (pop-out windows mount none).
 *
 * The rule this enables: inside one browser the task store is the ONLY truth
 * for a task row. A surface that shows a task reads it from here and writes
 * through the store's optimistic mutators, so every other surface (board row,
 * session header, detail pane) changes in the same frame. The REST round-trip
 * and its WS echo only confirm. A component may keep a private REST copy only
 * as the fallback for when this returns null or the row is not in the list.
 */
export function useTasksContextSafe(): TasksContextValue | null {
  return useContext(TasksContext);
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * The store's row for `taskId`, or null when there is no store or no row. Re-renders only
 * when that row changes (TaskRows): a task object is replaced on every change and kept
 * otherwise, so its identity is the change.
 */
export function useStoreTask(taskId: string | null | undefined): Task | null {
  const rows = useContext(TaskRowsContext);
  const read = () => (rows && taskId ? rowOf(rows, taskId) : null);
  return useSyncExternalStore(rows ? rows.subscribe : NO_SUBSCRIPTION, read, read);
}

/**
 * One value worked out from the whole list (a count, a flag), re-rendering only when it
 * changes: the select must return a primitive or an object it keeps. Null outside a provider.
 */
export function useTaskListSelect<T>(select: (list: { tasks: readonly Task[]; loading: boolean; error: string | null }) => T): T | null {
  const rows = useContext(TaskRowsContext);
  const read = () => (rows ? select({ tasks: rows.latest, loading: rows.loading, error: rows.error }) : null);
  return useSyncExternalStore(rows ? rows.subscribe : NO_SUBSCRIPTION, read, read);
}

/**
 * The store's writers and a row lookup for event handlers, without subscribing to the list
 * (useTasksContextSafe re-renders on every task update). Null outside a TasksProvider.
 */
export function useTaskStoreActions(): TaskStoreActions | null {
  return useContext(TaskRowsContext)?.actions ?? null;
}
