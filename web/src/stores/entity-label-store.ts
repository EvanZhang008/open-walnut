/**
 * Entity label store — the client-side id→title source of truth for
 * `<task-ref/>` / `<session-ref/>` pills. The markdown renderer resolves the
 * CURRENT task title from here; the AI-provided `label` attribute is only a
 * fallback for ids this store can't resolve (deleted task, unsynced replica).
 *
 * ⚠️ Zero runtime imports beyond the dependency-free task-id-shape.ts, by
 * design: web/src/utils/markdown.ts imports this module, and the markdown test
 * tier runs in a bare node env where anything beyond `marked`/`dompurify` fails
 * at collection.
 *
 * Ids the client task list does not hold (a task outside the loaded list, an
 * id's first segment the list cannot settle) are looked up through a fetcher
 * the TasksProvider registers: batched, once per id per page, never from the
 * render path itself (a timer flushes the queue).
 *
 * Concurrency contract:
 * - `lookupTaskLabel`/`lookupSessionTitle` are RENDER-PATH reads. They record
 *   the id into `observed` (a plain Set mutation) and MUST NEVER notify —
 *   an emit from the render path is a render-phase update loop.
 * - Version bumps are gated on `observed`: a task change only invalidates
 *   caches/re-renders when that id was actually rendered somewhere. Without
 *   the gate every task:created WS echo would flush the markdown LRU and
 *   re-render every visible message.
 */

export interface TaskLabel {
  title: string;
  project?: string;
}

interface TaskLabelEntry {
  label: TaskLabel;
  /** Source Task reference for the identity early-out: when the tasks array
   *  is re-synced but this row object is unchanged (mergeFetchedTasks
   *  preserves identity), skip field comparison entirely. */
  src: unknown;
}

import { isTaskLookupToken, isTaskPrefixToken } from '../utils/task-id-shape';

type TaskLike = { id: string; title?: string; project?: string; org_role?: string; org_name?: string; session_id?: string; session_ids?: readonly string[] };

/** A written token resolved to its task: `id` is the full id (a prefix token
 *  names a longer one). */
export interface TaskTokenResolution {
  id: string;
  label: TaskLabel;
}

/** One answer of the lookup fetcher: the token asked, and its task when the
 *  server knows exactly one (a prefix's `id` is the full id). */
export interface TaskLookupAnswer {
  token: string;
  task?: { id: string; title: string; project?: string; org_role?: string };
}
export type TaskLookupFetcher = (tokens: string[]) => Promise<TaskLookupAnswer[]>;

/** Main reads as the CEO, a project's lead ("Walnut lead") as its VP: display only. The same rule
 *  as orgDisplayTitle (src/core/org/org-tree.ts), written here because this module imports
 *  nothing; tests/web/entity-label-store.test.ts pins the two equal. */
export function shownTaskTitle(task: { title: string; org_role?: string; org_name?: string }): string {
  if (task.org_role === 'main') return 'CEO';
  if (task.org_role === 'lead' && task.org_name?.trim()) return `${task.org_name.trim()} VP`;
  if (task.org_role === 'lead') return task.title.replace(/ lead$/i, ' VP');
  return task.title;
}

const taskLabels = new Map<string, TaskLabelEntry>();
const sessionTitles = new Map<string, string>();
/** Ids the render path has tried to resolve — the version-bump gate.
 *  Grows with distinct ids ever rendered (~20B each); unbounded on purpose. */
const observed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/** Every id of the synced list, sorted: the prefix index. Rebuilt lazily when
 *  the id set changed. */
let sortedIds: string[] = [];
let sortedDirty = true;
/** Tokens the server resolved (keyed by the token as written). */
const fetched = new Map<string, TaskTokenResolution>();
/** Tokens the server answered with no task, and when: retried after MISSING_TTL_MS. */
const missing = new Map<string, number>();
const MISSING_TTL_MS = 10 * 60_000;
/** Tokens waiting for the next lookup batch, and the ones in flight. */
const queued = new Set<string>();
const inFlight = new Set<string>();
let fetcher: TaskLookupFetcher | null = null;
let listLoaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let firstQueuedAt = 0;
/** Prefixes the list settled, as the server confirmed them: true = the same task. */
const prefixChecked = new Map<string, boolean>();
/** Tokens a `<task-ref/>` rendered as an undecided pill. */
const undecidedRefs = new Set<string>();
/** A token whose lookup failed: not asked again before this time. */
const retryAt = new Map<string, number>();
const RETRY_MS = 30_000;
const LOOKUP_BATCH = 50;
const LOOKUP_DELAY_MS = 40;
/** A page whose task list never loads (a surface outside TasksProvider) still looks up after this. */
const LIST_WAIT_MS = 3_000;

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Render-path task lookup. Records the id as observed; never notifies. */
export function lookupTaskLabel(id: string): TaskLabel | undefined {
  observed.add(id);
  return taskLabels.get(id)?.label;
}

/** Render-path session lookup. Records the id as observed; never notifies. */
export function lookupSessionTitle(id: string): string | undefined {
  observed.add(id);
  return sessionTitles.get(id);
}

/** A rendered prefix token (`mvkghc5v` of `mvkghc5v-278c`) that this id's arrival
 *  or removal settles or unsettles. */
function namesObservedPrefix(id: string): boolean {
  for (let at = id.indexOf('-'); at > 0; at = id.indexOf('-', at + 1)) {
    if (observed.has(id.slice(0, at))) return true;
  }
  return false;
}

/** The one id of the synced list that `token` is the leading segment(s) of, if exactly one. */
function uniquePrefixId(token: string): string | undefined {
  if (sortedDirty) {
    sortedIds = [...taskLabels.keys()].sort();
    sortedDirty = false;
  }
  const head = `${token}-`;
  let lo = 0;
  let hi = sortedIds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedIds[mid]! < head) lo = mid + 1; else hi = mid;
  }
  const hit = sortedIds[lo];
  if (!hit?.startsWith(head)) return undefined;
  return sortedIds[lo + 1]?.startsWith(head) ? undefined : hit;
}

/**
 * Render-path resolution of a WRITTEN token: a full id, or an id's first
 * segment(s) (`mvkghc5v`, `2ac88910`) that exactly one task id starts with.
 * Records the token as observed and, when the list cannot settle it, queues a
 * lookup (flushed later by a timer, never synchronously); never notifies.
 *
 * The list is partial (completed tasks older than a week are not in it), so a
 * prefix it settles is also confirmed with the server once: a second task with
 * the same first segment outside the list unlinks it, never a wrong pill.
 * A word of letters alone that names nothing in the list is not recorded: no
 * lookup will ever settle it, and `observed` would grow with the vocabulary.
 */
export function resolveTaskToken(token: string): TaskTokenResolution | undefined {
  if (!token) return undefined;
  const own = taskLabels.get(token);
  if (own) { observed.add(token); return { id: token, label: own.label }; }
  if (isTaskPrefixToken(token)) {
    const id = uniquePrefixId(token);
    if (id && prefixChecked.get(token) !== false) {
      observed.add(token);
      if (!prefixChecked.has(token) && isTaskLookupToken(token)) queueLookup(token);
      return { id, label: taskLabels.get(id)!.label };
    }
  }
  const got = fetched.get(token);
  if (got) { observed.add(token); return got; }
  if (isTaskLookupToken(token)) { observed.add(token); queueLookup(token); }
  return undefined;
}

/** The server was asked and knows no task by this token (a deleted task, a
 *  hash that only looks like an id). Until then a token is undecided. */
export function isTaskTokenMissing(token: string): boolean {
  const at = missing.get(token);
  return at !== undefined && Date.now() - at < MISSING_TTL_MS;
}

/** A `<task-ref/>` rendered as a pill while its id is undecided: the lookup's
 *  "no task" answer re-renders it as text. Render path: never notifies. */
export function noteUndecidedTaskRef(token: string): void {
  undecidedRefs.add(token);
}

function queueLookup(token: string): void {
  if (!fetcher || queued.has(token) || inFlight.has(token) || isTaskTokenMissing(token)) return;
  if ((retryAt.get(token) ?? 0) > Date.now()) return;
  if (queued.size === 0) firstQueuedAt = Date.now();
  queued.add(token);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer || queued.size === 0) return;
  const wait = listLoaded ? LOOKUP_DELAY_MS : Math.max(LOOKUP_DELAY_MS, firstQueuedAt + LIST_WAIT_MS - Date.now());
  flushTimer = setTimeout(runLookups, wait);
}

/** The id the list settles a prefix token to (a token that is itself an id is not one). */
function listPrefixId(token: string): string | undefined {
  return !taskLabels.has(token) && isTaskPrefixToken(token) ? uniquePrefixId(token) : undefined;
}

function runLookups(): void {
  flushTimer = null;
  const fetch = fetcher;
  if (!fetch) { queued.clear(); return; }
  // The list may have settled a token since it was queued (a prefix it settles still needs its check).
  const tokens: string[] = [];
  for (const token of queued) {
    queued.delete(token);
    if (taskLabels.has(token) || fetched.has(token) || prefixChecked.has(token)) continue;
    tokens.push(token);
    if (tokens.length === LOOKUP_BATCH) break;
  }
  if (queued.size > 0) scheduleFlush();
  if (tokens.length === 0) return;
  for (const t of tokens) inFlight.add(t);
  void fetch(tokens).then((answers) => {
    let dirty = false;
    const answered = new Set<string>();
    for (const a of answers) {
      if (!a || typeof a.token !== 'string') continue;
      answered.add(a.token);
      const task = a.task;
      // A prefix names its task only at a segment boundary (the server matches any prefix).
      const fits = !!task && typeof task.title === 'string' && !!task.title
        && (task.id === a.token || (isTaskPrefixToken(a.token) && task.id.startsWith(`${a.token}-`)));
      const listId = listPrefixId(a.token);
      if (listId) {
        // The check of a prefix the list settled: the same task, or no pill.
        const same = fits && task!.id === listId;
        prefixChecked.set(a.token, same);
        if (!same && observed.has(a.token)) dirty = true;
      } else if (fits) {
        fetched.set(a.token, {
          id: task!.id,
          label: { title: shownTaskTitle({ title: task!.title, org_role: task!.org_role }), project: task!.project || undefined },
        });
        missing.delete(a.token);
        if (observed.has(a.token)) dirty = true;
      } else {
        missing.set(a.token, Date.now());
        // Text stays text; only a task-ref pill that waited on this answer changes.
        if (undecidedRefs.delete(a.token)) dirty = true;
      }
    }
    for (const t of tokens) {
      if (answered.has(t)) continue;
      if (listPrefixId(t)) prefixChecked.set(t, true);
      else { missing.set(t, Date.now()); if (undecidedRefs.delete(t)) dirty = true; }
    }
    if (dirty) emit();
  }, () => {
    // Offline or an older server: the tokens stay undecided (a prefix keeps the list's
    // answer) and are asked again only after a pause, never on every render.
    const at = Date.now() + RETRY_MS;
    for (const t of tokens) retryAt.set(t, at);
  }).finally(() => { for (const t of tokens) inFlight.delete(t); });
}

/** The lookup for ids the list does not hold (TasksProvider registers it; null removes it). */
export function setTaskLabelFetcher(fn: TaskLookupFetcher | null): void {
  fetcher = fn;
  if (fn) scheduleFlush();
}

/** Refs the render path could not resolve yet: a task that loads later under a
 *  matching id bumps the version, so its row gets the name. */
const unresolvedRefs = new Set<string>();
/** Each ref's answer until the task list changes (a fold line reads it per frame). */
const refCache = new Map<string, string | null>();
/** Each session id to its task: a delivery the target's host made answers with
 *  the session alone (`targetSessionId`). */
const sessionOwner = new Map<string, string>();

/** Note the task's sessions; true when one is new (an unresolved ref may name it). */
function indexSessions(task: TaskLike): boolean {
  let added = false;
  for (const sid of [task.session_id, ...(task.session_ids ?? [])]) {
    if (!sid || sessionOwner.get(sid) === task.id) continue;
    sessionOwner.set(sid, task.id);
    added = true;
  }
  return added;
}

/** The one task a prefix names among `keys` (mapped through `owner`), or null. */
function uniqueByPrefix(ref: string, keys: Iterable<string>, owner: (k: string) => string | undefined): string | null {
  let id: string | null = null;
  for (const key of keys) {
    if (!key.startsWith(ref)) continue;
    const t = owner(key);
    if (!t || !taskLabels.has(t)) continue;
    if (id && id !== t) return null;
    id = t;
  }
  return id;
}

/**
 * A task by its id or a unique id prefix (6+ characters), as a send's answer
 * prints it ("Message delivered on this host to 2536be97-277f-53"). Observing,
 * like `lookupTaskLabel`; an ambiguous prefix names nothing.
 */
export function lookupTaskByRef(ref: string): { id: string; label: TaskLabel } | undefined {
  let id = refCache.get(ref);
  if (id === undefined) {
    id = null;
    const owner = sessionOwner.get(ref);
    if (taskLabels.has(ref)) id = ref;
    else if (owner && taskLabels.has(owner)) id = owner;
    else if (ref.length >= 6) {
      id = uniqueByPrefix(ref, taskLabels.keys(), (k) => k)
        ?? uniqueByPrefix(ref, sessionOwner.keys(), (k) => sessionOwner.get(k));
    }
    refCache.set(ref, id);
  }
  if (!id) { unresolvedRefs.add(ref); return undefined; }
  observed.add(id);
  return { id, label: taskLabels.get(id)!.label };
}

/** Non-observing read for React components (pair with useTaskLabel). */
export function peekTaskLabel(id: string): TaskLabel | undefined {
  return taskLabels.get(id)?.label;
}

/**
 * Full-replace sync from the client task list. Callers must not pass the
 * empty loading-state list (TasksProvider guards on `loading`), or a boot
 * race would wipe the registry. Emits only when an OBSERVED id changed.
 */
export function syncTasks(tasks: readonly TaskLike[]): void {
  let dirty = false;
  let validCount = 0;
  for (const task of tasks) {
    if (!task?.id || typeof task.title !== 'string' || !task.title) continue;
    validCount++;
    const title = shownTaskTitle({ title: task.title, org_role: task.org_role, org_name: task.org_name });
    const existing = taskLabels.get(task.id);
    if (existing) {
      if (existing.src === task) continue; // identity early-out (steady state)
      if (indexSessions(task)) dirty = refreshRefs(task) || dirty;
      if (existing.label.title === title && existing.label.project === (task.project || undefined)) {
        existing.src = task;
        continue;
      }
      // Mutate in place? No — reuse discipline is for UNCHANGED labels only.
      // A changed label gets a fresh object so useSyncExternalStore snapshots
      // see a new identity exactly when the content changed.
      taskLabels.set(task.id, { label: { title, project: task.project || undefined }, src: task });
      if (observed.has(task.id) || namesObservedPrefix(task.id)) dirty = true;
    } else {
      taskLabels.set(task.id, { label: { title, project: task.project || undefined }, src: task });
      indexSessions(task);
      if (refreshRefs(task)) dirty = true;
      sortedDirty = true;
      // A new task can settle a token looked up before it existed.
      missing.delete(task.id);
      if (observed.has(task.id) || namesObservedPrefix(task.id)) dirty = true;
    }
  }
  // Deletion sweep only when the map holds more ids than the incoming list —
  // the normal path allocates nothing.
  if (taskLabels.size > validCount) {
    const incoming = new Set<string>();
    for (const task of tasks) if (task?.id) incoming.add(task.id);
    for (const id of taskLabels.keys()) {
      if (!incoming.has(id)) {
        taskLabels.delete(id);
        for (const [sid, owner] of sessionOwner) if (owner === id) sessionOwner.delete(sid);
        refCache.clear();
        sortedDirty = true;
        if (observed.has(id) || namesObservedPrefix(id)) dirty = true;
      }
    }
  }
  if (!listLoaded) {
    listLoaded = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    scheduleFlush();
  }
  if (dirty) emit();
}

/** A task arrived or gained a session: every ref answer may change. True when a
 *  row reading one must render again (a prefix that named one task may now name
 *  two; a ref nothing named may now name this task). */
function refreshRefs(task: TaskLike): boolean {
  const ids = [task.id, task.session_id, ...(task.session_ids ?? [])].filter((x): x is string => !!x);
  let dirty = false;
  for (const [ref, id] of refCache) if (id && ids.some((x) => x.startsWith(ref))) dirty = true;
  refCache.clear();
  for (const ref of unresolvedRefs) {
    if (!ids.some((x) => x.startsWith(ref))) continue;
    unresolvedRefs.delete(ref);
    dirty = true;
  }
  return dirty;
}

/** Opportunistic session title seeding from any fetched session record. */
export function registerSessionTitle(id: string, title: string | null | undefined): void {
  if (!id || typeof title !== 'string' || !title) return;
  if (sessionTitles.get(id) === title) return;
  sessionTitles.set(id, title);
  if (observed.has(id)) emit();
}

export function subscribeEntityLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEntityLabelsVersion(): number {
  return version;
}

export function resetEntityLabelsForTesting(): void {
  taskLabels.clear();
  sortedIds = [];
  sortedDirty = true;
  fetched.clear();
  missing.clear();
  prefixChecked.clear();
  undecidedRefs.clear();
  retryAt.clear();
  queued.clear();
  inFlight.clear();
  fetcher = null;
  listLoaded = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  sessionTitles.clear();
  observed.clear();
  unresolvedRefs.clear();
  refCache.clear();
  sessionOwner.clear();
  emit();
}
