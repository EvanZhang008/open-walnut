/**
 * The project REGISTRY — ONE store per browser, shared by every surface.
 *
 * Registry, as opposed to "the projects the loaded tasks happen to mention":
 * callers that only need chip labels can keep deriving from tasks, but anything
 * answering "does this project exist?" must use this, because an existing but
 * EMPTY project is invisible in the task list and a task-derived list wrongly
 * reports it as new (the false "new" badge in quick-task capture).
 *
 * ONE STORE, not one copy per consumer. This used to be a plain useState hook, so
 * every mounting component issued its own `GET /api/projects` (the /tasks table
 * calls it inside a per-ROW project cell — 50 visible rows meant 50 fetches
 * through the browser's 6-slot gate), and a rename or a Working Dir edit reached
 * no other copy until a reload. Now a write goes through the local mutators below
 * (`renameProjectLocal` / `removeProjectLocal` / `patchProjectLocal`), every
 * surface reads the same module snapshot through `useSyncExternalStore`, and the
 * REST round-trip plus its WS echo only CONFIRM. Same rule, same reasoning as the
 * task store (see web/src/AGENTS.md, "One browser, one task store").
 *
 * Optimistic writes survive a concurrent GET: an in-flight mutation is kept as a
 * pending op and re-applied on top of whatever the server answers, and is dropped
 * only once a request that STARTED after the route answered has landed. Without
 * that, an unrelated `project:created` refresh mid-rename would answer with
 * pre-rename rows and snap the old name back on screen.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';
import { fetchWithRetry } from '@/utils/fetch-retry';
import { runWhenVisible } from '@/utils/page-visibility';
import { fetchProjects, type ProjectSummary } from '@/api/projects';

/** One registry row, flattened to what the UI actually reads. */
export interface ProjectRegistryRow {
  name: string;
  source: string;
  favorite: boolean;
  defaultCwd?: string;
  defaultHost?: string;
}

export interface UseProjectRegistryReturn {
  /**
   * Canonical project names from the `task_projects` registry, sorted for
   * display. Includes projects with ZERO tasks — the whole point of not deriving
   * this from the loaded task list.
   */
  projectNames: string[];
  /** Case-insensitive membership test (project identity is NOCASE server-side). */
  isKnownProject: (name: string) => boolean;
  /** lowercased name → provider source ('local' | 'ms-todo' | 'jira' | …). Drives the one-letter badges. */
  sourceByName: Map<string, string>;
  /** lowercased names of favorited projects (server folds config.favorites.projects in). */
  favoriteByName: Set<string>;
  /**
   * A project's `default_cwd` → its canonical name. Answers "which project is
   * this folder?", which is what lets a folder pick set the project in the same
   * click (the draft column's quick-access chips).
   *
   * PATHS ARE CASE-SENSITIVE (unlike project identity), so this is keyed
   * verbatim — only trailing slashes are normalised away. First writer wins when
   * two projects declare the same folder: the list arrives name-sorted, so the
   * mapping is at least stable rather than render-order dependent.
   */
  projectByCwd: Map<string, string>;
  /**
   * The INVERSE of `projectByCwd`: lowercased project name → the folder it
   * declares (`default_cwd` + `default_host`). Answers "where does this project
   * run?" WITHOUT a fetch, which is what lets a draft column follow an
   * AI-suggested project to its folder while the user is still typing (the
   * detail-fetch path stays for the "+" seed, where one round-trip is fine).
   *
   * Keyed lowercase because project identity is case-insensitive server-side,
   * while the VALUE keeps the path verbatim (paths are case-sensitive).
   */
  projectDefaults: Map<string, { cwd: string; host: string | null }>;
  /** True once the first fetch has resolved — consumers that reconcile against the
   *  registry (e.g. pruning stale session-local names) must wait for this. */
  loaded: boolean;
  /** Re-fetch the registry now (e.g. right after createProject). */
  refresh: () => void;
}

/**
 * A local mutation other stores need to hear, because `favorites.projects` and
 * `ordering.projects` are keyed by project NAME and the server rewrites them
 * silently on a rename or delete.
 *
 * `resync` is the honest ending for a write that FAILED: the optimistic rewrite
 * those listeners already applied has to come back, and no `config:changed` will
 * ever arrive to tell them so (the server never wrote anything).
 */
export type ProjectRegistryMutation =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'delete'; name: string }
  | { kind: 'resync' };

interface Snapshot {
  rows: readonly ProjectRegistryRow[];
  loaded: boolean;
  projectNames: string[];
  lowerSet: Set<string>;
  sourceByName: Map<string, string>;
  favoriteByName: Set<string>;
  projectByCwd: Map<string, string>;
  projectDefaults: Map<string, { cwd: string; host: string | null }>;
}

/** An optimistic write, applied on top of the server rows until confirmed. */
interface PendingOp {
  apply: (rows: readonly ProjectRegistryRow[]) => ProjectRegistryRow[];
  /** 0 while the request is in flight; else the ms the route answered. */
  confirmedAt: number;
}

/** A newly mounted consumer reuses a list this fresh instead of re-fetching. */
const STALE_MS = 15_000;
/** Coalesce a burst of registry events (a rename fans out several) into one GET. */
const REFRESH_DEBOUNCE_MS = 250;

let serverRows: readonly ProjectRegistryRow[] = [];
let pendingOps: PendingOp[] = [];
let loadedOnce = false;
let lastLoadedAt = 0;
let inflight: Promise<void> | null = null;
let loadSeq = 0;
/** Cancels the wait of a load that a newer `fresh` load has superseded. */
let loadAbort: AbortController | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const mutationListeners = new Set<(m: ProjectRegistryMutation) => void>();
/**
 * lowercased OLD name → the name it was renamed to. A surface that captured a
 * project name before the rename (the open detail pane, a menu's `project` prop)
 * resolves forward through this instead of showing a name that no longer exists.
 */
const aliases = new Map<string, string>();

function sortRows(rows: ProjectRegistryRow[]): ProjectRegistryRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function toRows(projects: ProjectSummary[]): ProjectRegistryRow[] {
  return sortRows(projects.map((p) => ({
    name: p.name,
    source: p.source,
    favorite: p.favorite,
    ...(p.metadata?.default_cwd ? { defaultCwd: p.metadata.default_cwd } : {}),
    ...(p.metadata?.default_host ? { defaultHost: p.metadata.default_host } : {}),
  })));
}

function rowsEqual(a: readonly ProjectRegistryRow[], b: readonly ProjectRegistryRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.source !== y.source || x.favorite !== y.favorite
      || x.defaultCwd !== y.defaultCwd || x.defaultHost !== y.defaultHost) return false;
  }
  return true;
}

function derive(rows: readonly ProjectRegistryRow[], loaded: boolean): Snapshot {
  const projectNames: string[] = [];
  const lowerSet = new Set<string>();
  const sourceByName = new Map<string, string>();
  const favoriteByName = new Set<string>();
  const projectByCwd = new Map<string, string>();
  const projectDefaults = new Map<string, { cwd: string; host: string | null }>();
  for (const r of rows) {
    const lower = r.name.toLowerCase();
    projectNames.push(r.name);
    lowerSet.add(lower);
    sourceByName.set(lower, r.source);
    if (r.favorite) favoriteByName.add(lower);
    const cwd = r.defaultCwd?.replace(/\/+$/, '');
    if (!cwd) continue;
    if (!projectByCwd.has(cwd)) projectByCwd.set(cwd, r.name);
    projectDefaults.set(lower, { cwd, host: r.defaultHost ?? null });
  }
  return { rows, loaded, projectNames, lowerSet, sourceByName, favoriteByName, projectByCwd, projectDefaults };
}

let snapshot: Snapshot = derive([], false);

function rebuild(): void {
  const next = pendingOps.reduce<readonly ProjectRegistryRow[]>((rows, op) => op.apply(rows), serverRows);
  if (loadedOnce === snapshot.loaded && rowsEqual(next, snapshot.rows)) return;
  snapshot = derive(next, loadedOnce);
  // Copy the set: a subscriber that unsubscribes while notifying must not mutate
  // the set being walked.
  for (const l of [...listeners]) l();
}

function runLoad(): Promise<void> {
  const startedAt = Date.now();
  const seq = ++loadSeq;
  // A newer load supersedes an older one still waiting between retries; the
  // older one's request, if already in flight, lands and is ignored below.
  loadAbort?.abort();
  const abort = new AbortController();
  loadAbort = abort;
  const p = (async () => {
    try {
      // Retried: a boot-time answer lost to a stalled server left every surface
      // on task-derived names (no source badges, every project "new") until a
      // consumer happened to remount (2026-09-17).
      const data = await fetchWithRetry(() => fetchProjects(), {
        subsystem: 'tasks', label: 'project registry', signal: abort.signal,
      });
      // Only the newest load may write: an older answer arriving after a
      // fresh load started would put pre-write rows back on screen.
      if (loadSeq !== seq) return;
      serverRows = toRows(data.projects ?? []);
      // Drop the optimistic ops this response already reflects. A request that
      // started BEFORE the route answered cannot carry the write, so its op stays.
      pendingOps = pendingOps.filter((op) => op.confirmedAt === 0 || op.confirmedAt > startedAt);
      loadedOnce = true;
      lastLoadedAt = Date.now();
      rebuild();
    } catch {
      // Logged by fetchWithRetry (an abort is not a failure). Non-critical:
      // callers fall back to task-derived names, and the next mount or WS
      // reconnect asks again.
    } finally {
      // Only the NEWEST load owns the slot — a fresh load has already replaced
      // it by the time a superseded one settles.
      if (loadSeq === seq) inflight = null;
    }
  })();
  inflight = p;
  return p;
}

/**
 * Fetch the registry. Concurrent callers share one request; `fresh` forces a
 * request that starts AFTER this call, which is what a just-confirmed write
 * needs (reusing an older in-flight GET would answer with pre-write rows). A
 * fresh load starts NOW and supersedes the in-flight one rather than queueing
 * behind it: that one may be a boot-time load still retrying for up to ~30s,
 * and a confirmed write must not wait that long to be reconciled.
 */
function load(fresh = false): Promise<void> {
  if (!inflight) return runLoad();
  if (!fresh) return inflight;
  return runLoad();
}

function scheduleRefresh(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; void load(); }, REFRESH_DEBOUNCE_MS);
}

/** Re-fetch now (e.g. right after createProject). */
export function refreshProjectRegistry(): void {
  void load(true);
}

/**
 * Subscribing IS the load trigger (same shape as useModelCatalog), so every entry
 * point gets the data — including `useProjectEntry`, which the detail pane uses on
 * its own. A fresh-enough list is reused outright and concurrent mounts share one
 * request, which is what makes a per-row consumer cost nothing.
 */
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!loadedOnce || Date.now() - lastLoadedAt > STALE_MS) void load();
  return () => { listeners.delete(cb); };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/**
 * Rewrite one project NAME inside a config name list, NOCASE-deduped — the same
 * thing the server does to `ordering.projects` / `favorites.projects` on a rename
 * or delete (`migrateProjectInConfigLists`). `to === null` drops the entry.
 * Returns the SAME array when nothing mentioned the old name, so React bails.
 */
export function migrateProjectNameList(list: string[], from: string, to: string | null): string[] {
  const fromLower = from.trim().toLowerCase();
  if (!fromLower || !list.some((n) => (n ?? '').trim().toLowerCase() === fromLower)) return list;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const name = (raw ?? '').trim();
    if (!name) continue;
    const replaced = name.toLowerCase() === fromLower ? to : name;
    if (!replaced) continue;
    const key = replaced.toLowerCase();
    if (seen.has(key)) continue; // rename collapsed onto an existing entry
    seen.add(key);
    next.push(replaced);
  }
  return next;
}

/** Hear local renames/deletes — for stores keyed by project NAME (favorites, ordering). */
export function subscribeProjectMutations(fn: (m: ProjectRegistryMutation) => void): () => void {
  mutationListeners.add(fn);
  return () => { mutationListeners.delete(fn); };
}

function emitMutation(m: ProjectRegistryMutation): void {
  for (const l of [...mutationListeners]) l(m);
}

/**
 * Register an optimistic op. Call the returned settle with the route's verdict:
 * `true` keeps the op until a fresh GET confirms it, `false` drops it right away
 * (a lie must never outlive the request that failed).
 */
function pushOp(apply: PendingOp['apply']): (ok: boolean) => void {
  const op: PendingOp = { apply, confirmedAt: 0 };
  pendingOps.push(op);
  rebuild();
  return (ok: boolean) => {
    if (!ok) {
      pendingOps = pendingOps.filter((o) => o !== op);
      rebuild();
      void load(true);
      return;
    }
    op.confirmedAt = Date.now();
    void load(true);
  };
}

/**
 * Optimistic rename. Mirrors the server's MERGE-ON-COLLISION semantics so the
 * frame the user sees matches what the route will do.
 */
export function renameProjectLocal(from: string, to: string): (ok: boolean) => void {
  const fromLower = from.trim().toLowerCase();
  const target = to.trim();
  const targetLower = target.toLowerCase();
  aliases.set(fromLower, target);
  const settle = pushOp((rows) => {
    const row = rows.find((r) => r.name.toLowerCase() === fromLower);
    // Already renamed server-side (or never registered) — nothing to re-apply.
    if (!row) return [...rows];
    const existing = rows.find((r) => r.name.toLowerCase() === targetLower && r !== row);
    // On a merge the TARGET's own settings win, exactly like renameProject.
    const merged: ProjectRegistryRow = existing
      ? { ...row, ...existing, favorite: existing.favorite || row.favorite }
      : { ...row, name: target };
    return sortRows([
      ...rows.filter((r) => r !== row && r.name.toLowerCase() !== targetLower),
      merged,
    ]);
  });
  emitMutation({ kind: 'rename', from: from.trim(), to: target });
  return (ok: boolean) => {
    if (!ok) {
      aliases.delete(fromLower);
      // Rewrite the name lists back, then let them re-read: a collapsed duplicate
      // entry cannot be reconstructed from the rename alone.
      emitMutation({ kind: 'rename', from: target, to: from.trim() });
      emitMutation({ kind: 'resync' });
    }
    settle(ok);
  };
}

/** Optimistic delete — the row goes now, the route only confirms. */
export function removeProjectLocal(name: string): (ok: boolean) => void {
  const lower = name.trim().toLowerCase();
  const settle = pushOp((rows) => rows.filter((r) => r.name.toLowerCase() !== lower));
  emitMutation({ kind: 'delete', name: name.trim() });
  return (ok: boolean) => {
    // A dropped list entry can't be put back where it was, so a failed delete
    // re-reads instead of guessing (the server never wrote, so no event is coming).
    if (!ok) emitMutation({ kind: 'resync' });
    settle(ok);
  };
}

/** Registry-row fields a surface can patch. `null` clears the field. */
export interface ProjectRowPatch {
  defaultCwd?: string | null;
  defaultHost?: string | null;
  source?: string;
  favorite?: boolean;
}

/** Optimistic metadata patch (Working Dir / Host / claim / favorite). */
export function patchProjectLocal(name: string, patch: ProjectRowPatch): (ok: boolean) => void {
  const lower = name.trim().toLowerCase();
  return pushOp((rows) => rows.map((r) => {
    if (r.name.toLowerCase() !== lower) return r;
    const next: ProjectRegistryRow = { ...r };
    if (patch.defaultCwd !== undefined) {
      if (patch.defaultCwd) next.defaultCwd = patch.defaultCwd;
      else delete next.defaultCwd;
    }
    if (patch.defaultHost !== undefined) {
      if (patch.defaultHost) next.defaultHost = patch.defaultHost;
      else delete next.defaultHost;
    }
    if (patch.source !== undefined) next.source = patch.source;
    if (patch.favorite !== undefined) next.favorite = patch.favorite;
    return next;
  }));
}

/**
 * The project's CURRENT canonical name: a live row wins, otherwise a rename this
 * tab knows about is followed. Never follows an alias past a live row — a project
 * re-created under the old name resolves to itself.
 */
export function resolveProjectName(name: string): string {
  let current = (name ?? '').trim();
  if (!current) return '';
  const seen = new Set<string>();
  for (;;) {
    const lower = current.toLowerCase();
    const live = snapshot.rows.find((r) => r.name.toLowerCase() === lower);
    if (live) return live.name;
    const next = aliases.get(lower);
    if (!next || seen.has(lower)) return current;
    seen.add(lower);
    current = next;
  }
}

/** Tests only: forget everything the store learned. */
export function resetProjectRegistryForTests(): void {
  serverRows = [];
  pendingOps = [];
  loadedOnce = false;
  lastLoadedAt = 0;
  loadAbort?.abort();
  loadAbort = null;
  inflight = null;
  loadSeq = 0;
  aliases.clear();
  if (debounce) { clearTimeout(debounce); debounce = null; }
  snapshot = derive([], false);
  for (const l of [...listeners]) l();
}

// Registry events keep the store fresh. Subscribed ONCE at module scope (same
// pattern as useModelCatalog): with the /tasks table mounting one consumer per
// row, per-consumer useEvent would register hundreds of listeners for what is
// one debounced GET.
for (const name of ['project:created', 'project:renamed', 'project:deleted', 'project:updated']) {
  wsClient.onEvent(name, (data: unknown) => {
    // Learn the alias from the event too: another tab (or the CLI) can rename a
    // project this tab has open in its detail pane.
    if (name === 'project:renamed') {
      const d = (data ?? {}) as { from?: string; to?: string };
      if (d.from && d.to) aliases.set(d.from.trim().toLowerCase(), d.to.trim());
    }
    scheduleRefresh();
  });
}

// A WS gap loses every event in it and this list is not polled, so a project
// created/renamed while the socket was down would stay wrong until a reload.
wsClient.onEvent('_ws:reconnected', () => {
  runWhenVisible('project-registry:reconnect', () => { void load(true); });
});

export function useProjectRegistry(): UseProjectRegistryReturn {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isKnownProject = useCallback(
    (name: string) => snap.lowerSet.has(name.trim().toLowerCase()),
    [snap],
  );

  return useMemo(() => ({
    projectNames: snap.projectNames,
    isKnownProject,
    sourceByName: snap.sourceByName,
    favoriteByName: snap.favoriteByName,
    projectByCwd: snap.projectByCwd,
    projectDefaults: snap.projectDefaults,
    loaded: snap.loaded,
    refresh: refreshProjectRegistry,
  }), [snap, isKnownProject]);
}

/**
 * The store's row for `project`, resolved through any rename that happened while
 * the caller was holding the old name (an open detail pane, a menu prop).
 */
export function useProjectEntry(project: string): { name: string; row: ProjectRegistryRow | null } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const name = resolveProjectName(project);
    const lower = name.toLowerCase();
    return { name, row: snap.rows.find((r) => r.name.toLowerCase() === lower) ?? null };
  }, [snap, project]);
}
