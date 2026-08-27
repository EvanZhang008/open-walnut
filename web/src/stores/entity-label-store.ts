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

type TaskLike = { id: string; title?: string; project?: string };

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
    const existing = taskLabels.get(task.id);
    if (existing) {
      if (existing.src === task) continue; // identity early-out (steady state)
      if (existing.label.title === task.title && existing.label.project === (task.project || undefined)) {
        existing.src = task;
        continue;
      }
      // Mutate in place? No — reuse discipline is for UNCHANGED labels only.
      // A changed label gets a fresh object so useSyncExternalStore snapshots
      // see a new identity exactly when the content changed.
      taskLabels.set(task.id, { label: { title: task.title, project: task.project || undefined }, src: task });
      if (observed.has(task.id)) dirty = true;
    } else {
      taskLabels.set(task.id, { label: { title: task.title, project: task.project || undefined }, src: task });
      if (observed.has(task.id)) dirty = true;
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
  emit();
}
