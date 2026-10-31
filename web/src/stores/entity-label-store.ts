/**
 * Entity label store — the client-side id→title source of truth for
 * `<task-ref/>` / `<session-ref/>` pills. The markdown renderer resolves the
 * CURRENT task title from here; the AI-provided `label` attribute is only a
 * fallback for ids this store can't resolve (deleted task, unsynced replica).
 *
 * ⚠️ Zero runtime imports, by design: web/src/utils/markdown.ts imports this
 * module, and the markdown test tier runs in a bare node env where anything
 * beyond `marked`/`dompurify` fails at collection. Keep it dependency-free.
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

type TaskLike = { id: string; title?: string; project?: string; org_role?: string; org_name?: string };

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

/** Refs the render path could not resolve yet: a task that loads later under a
 *  matching id bumps the version, so its row gets the name. */
const unresolvedRefs = new Set<string>();
/** Each ref's answer until the task list changes (a fold line reads it per frame). */
const refCache = new Map<string, string | null>();

/**
 * A task by its id or a unique id prefix (6+ characters), as a send's answer
 * prints it ("Message delivered on this host to 2536be97-277f-53"). Observing,
 * like `lookupTaskLabel`; an ambiguous prefix names nothing.
 */
export function lookupTaskByRef(ref: string): { id: string; label: TaskLabel } | undefined {
  let id = refCache.get(ref);
  if (id === undefined) {
    id = null;
    if (taskLabels.has(ref)) id = ref;
    else if (ref.length >= 6) {
      for (const key of taskLabels.keys()) {
        if (!key.startsWith(ref)) continue;
        if (id) { id = null; break; }
        id = key;
      }
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
      if (existing.label.title === title && existing.label.project === (task.project || undefined)) {
        existing.src = task;
        continue;
      }
      // Mutate in place? No — reuse discipline is for UNCHANGED labels only.
      // A changed label gets a fresh object so useSyncExternalStore snapshots
      // see a new identity exactly when the content changed.
      taskLabels.set(task.id, { label: { title, project: task.project || undefined }, src: task });
      if (observed.has(task.id)) dirty = true;
    } else {
      taskLabels.set(task.id, { label: { title, project: task.project || undefined }, src: task });
      // A prefix that named one task may now name two: its rows read again.
      for (const [ref, id] of refCache) if (id && task.id.startsWith(ref)) dirty = true;
      refCache.clear();
      if (observed.has(task.id)) dirty = true;
      else if (unresolvedRefs.size > 0) {
        for (const ref of unresolvedRefs) {
          if (!task.id.startsWith(ref)) continue;
          unresolvedRefs.delete(ref);
          dirty = true;
        }
      }
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
        refCache.clear();
        if (observed.has(id)) dirty = true;
      }
    }
  }
  if (dirty) emit();
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
  sessionTitles.clear();
  observed.clear();
  unresolvedRefs.clear();
  refCache.clear();
  emit();
}
