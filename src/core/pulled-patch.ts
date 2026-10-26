/**
 * A patch a sync plugin pulled, made safe before it is written over the local task.
 *
 * Text: a pull never empties a local description, summary or note. The remote stores them in one
 * body, and a body that does not carry a field (a new task's first round trip, an older composer,
 * a field the remote cannot hold) is no word on it; 2026-10-26, three new tasks lost their whole
 * description, which is the request a task starts its work from. A field cleared in the remote's
 * own app does not come back here; local clears still go out on the next push.
 *
 * Links: task links a sync plugin carries as id PREFIXES, resolved back to full ids. The Microsoft To Do
 * body stores `Parent: <first 8 chars>` and `DependsOn: <8-char prefixes>`, and the pull wrote
 * those prefixes over the local full ids (2026-10-26: a dozen tasks, one lead's whole team, whose
 * `parent_task_id` was "mvm0n3bu" instead of "mvm0n3bu-6910"). Every reader compares ids exactly
 * (the Board's team, the open worker counts, the Org tree, subtask notices), so those tasks
 * dropped out of their teams and their statuses lost their lead.
 *
 * Rules, the same for a pull and for the repair of rows already written:
 *   - a value that is a task id stays;
 *   - a prefix of the link the task already holds keeps what it holds;
 *   - a prefix of exactly one task id becomes that id;
 *   - anything else (no match yet, more than one) never replaces a link the task holds; with
 *     none held it is kept as written, so a parent pulled later in the same tick is found by
 *     the next tick's repair.
 * The remote keeps its prefixes, so an older Walnut reading it is unaffected.
 */
import { log } from '../logging/index.js';
import type { Task } from './types.js';

type Ids = { has(id: string): boolean; ids: readonly string[] };

export function idIndex(tasks: readonly Pick<Task, 'id'>[]): Ids {
  const ids = tasks.map((t) => t.id);
  const set = new Set(ids);
  return { has: (id) => set.has(id), ids };
}

/** One link: the full id it means, or undefined when it cannot be told. */
export function resolveLink(value: string, held: string | undefined, index: Ids): string | undefined {
  if (!value || index.has(value)) return value;
  if (held && held.startsWith(value) && index.has(held)) return held;
  let found: string | undefined;
  for (const id of index.ids) {
    if (!id.startsWith(value)) continue;
    if (found) return undefined;
    found = id;
  }
  return found;
}

/**
 * A pulled patch with its links resolved against the local tasks. A link that cannot be told
 * is dropped from the patch, so the task keeps what it holds.
 */
export function resolvePulledLinks<T extends Partial<Pick<Task, 'parent_task_id' | 'depends_on'>>>(
  updates: T, existing: Pick<Task, 'id' | 'parent_task_id' | 'depends_on'> | undefined, index: Ids,
): T {
  let out = updates;
  const parent = updates.parent_task_id;
  if (typeof parent === 'string' && parent && !index.has(parent)) {
    const full = resolveLink(parent, existing?.parent_task_id, index);
    out = { ...out };
    if (full && full !== existing?.id) out.parent_task_id = full;
    else if ((full !== undefined && full === existing?.id) || existing?.parent_task_id) {
      delete out.parent_task_id;
      log.task.info('sync pull: kept the parent link the task holds', { taskId: existing?.id, parent });
    }
  }
  const deps = updates.depends_on;
  if (Array.isArray(deps) && deps.some((d) => !index.has(d))) {
    const held = existing?.depends_on ?? [];
    // Each link on its own: one that cannot be told yet is kept as written (an exact held id, or
    // the prefix itself), so a new remote dependency next to an old one still lands.
    const resolved = deps.map((d) => resolveLink(d, held.find((h) => h.startsWith(d) && h.length > d.length), index) ?? held.find((h) => h === d) ?? d);
    out = { ...out, depends_on: resolved };
  }
  return out;
}

const TEXT_FIELDS = ['description', 'summary', 'note'] as const;

/** The patch without the text fields it would empty. */
export function keepLocalText<T extends Partial<Pick<Task, 'description' | 'summary' | 'note'>>>(
  updates: T, existing: Partial<Pick<Task, 'id' | 'description' | 'summary' | 'note'>> | undefined,
): T {
  let out = updates;
  // Undo the older misread: a description read as the note, the local description emptied. The
  // body now gives the description back; the note holding exactly that text is the same copy.
  const back = typeof updates.description === 'string' ? updates.description.trim() : '';
  const misread = !!back && !(existing?.description ?? '').trim() && (existing?.note ?? '').trim() === back && !(updates.note ?? '').trim();
  if (misread) out = { ...updates, note: '' };
  for (const f of TEXT_FIELDS) {
    if (misread && f === 'note') continue;
    const incoming = updates[f];
    if (typeof incoming !== 'string' || incoming.trim() || !(existing?.[f] ?? '').trim()) continue;
    if (out === updates) out = { ...updates };
    delete out[f];
    log.task.info('sync pull: kept the local text the remote body did not carry', { taskId: existing?.id, field: f });
  }
  return out;
}

/** The fixes for rows already written with prefixes: task id -> its patch. */
export function prefixLinkRepairs(tasks: readonly Pick<Task, 'id' | 'parent_task_id' | 'depends_on'>[]): Map<string, Partial<Task>> {
  const index = idIndex(tasks);
  const out = new Map<string, Partial<Task>>();
  for (const t of tasks) {
    const patch: Partial<Task> = {};
    if (t.parent_task_id && !index.has(t.parent_task_id)) {
      const full = resolveLink(t.parent_task_id, undefined, index);
      if (full && full !== t.id) patch.parent_task_id = full;
    }
    if (t.depends_on?.some((d) => !index.has(d))) {
      const resolved = t.depends_on.map((d) => resolveLink(d, undefined, index) ?? d);
      if (resolved.some((d, i) => d !== t.depends_on![i])) patch.depends_on = resolved;
    }
    if (Object.keys(patch).length) out.set(t.id, patch);
  }
  return out;
}
