/**
 * Recent-task ledger — an always-injected, recency-sorted digest of recent
 * tasks so the butler answers "which task did X?" by scanning THIS list
 * instead of gambling on semantic search (where pure-title junk tasks used to
 * outrank real work — see task-junk.ts).
 *
 * One line per task: id | one-liner | project | phase | last activity.
 * The one-liner is `ledger_desc` (a cheap-model "what this task is about"
 * label, generated once at creation by task-ledger-desc.ts), falling back to
 * the title. Junk/test tasks are filtered (isLedgerJunk).
 *
 * Freshness: derived on demand from the task store and cached; any TASK_*
 * bus event invalidates the cache (subscribed in server startup). The render
 * lives in the DYNAMIC prompt segment (buildMemoryContext) — it changes per
 * turn, so it must never sit inside the cacheable stable prefix.
 */
import { listTasks } from './task-manager.js';
import { isLedgerJunk } from './task-junk.js';
import { log } from '../logging/index.js';
import type { Task } from './types.js';

/** Max tasks in the ledger. ~40 lines ≈ 1.2-1.5K tokens — scannable, not a dump. */
export const LEDGER_MAX_ENTRIES = 40;

/** Done tasks older than this drop out — the ledger is "recent work", not history. */
const DONE_MAX_AGE_DAYS = 30;

let cachedRender: string | null = null;

/** Invalidate the cached render. Wire to TASK_* bus events at server startup. */
export function invalidateTaskLedger(): void {
  cachedRender = null;
}

/** Most-recent activity timestamp for ledger ordering. */
function lastActivity(task: Task): string {
  return task.last_session_update ?? task.updated_at ?? task.created_at ?? '';
}

/** Compact "3d ago" style age label. */
function ageLabel(iso: string): string {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) {
    const hours = Math.floor(ms / 3_600_000);
    return hours <= 0 ? 'now' : `${hours}h`;
  }
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** One-liner for a task: ledger_desc if generated, else the (trimmed) title. */
function oneLiner(task: Task): string {
  const desc = (task.ledger_desc ?? '').trim();
  const text = desc || task.title.trim();
  // Single line, bounded — a runaway description must not eat the budget.
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

function formatEntry(task: Task): string {
  const project = task.project || 'Inbox';
  const status = task.status === 'done' ? 'done' : task.phase;
  return `- \`${task.id}\` ${oneLiner(task)} — ${project} · ${status} · ${ageLabel(lastActivity(task))}`;
}

/**
 * Build the ledger markdown (no heading — the caller owns the section title).
 * Returns '' when there is nothing to show.
 */
export async function buildTaskLedger(): Promise<string> {
  if (cachedRender !== null) return cachedRender;
  try {
    const tasks = await listTasks();
    const doneCutoff = Date.now() - DONE_MAX_AGE_DAYS * 86_400_000;

    const entries = tasks
      .filter((t) => !t.title.startsWith('.metadata'))
      .filter((t) => !t.parent_task_id) // children ride their parent's line of work
      .filter((t) => !isLedgerJunk(t))
      .filter((t) => {
        if (t.status !== 'done') return true;
        const ts = new Date(lastActivity(t)).getTime();
        return Number.isFinite(ts) && ts >= doneCutoff;
      })
      .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
      .slice(0, LEDGER_MAX_ENTRIES);

    cachedRender = entries.length === 0 ? '' : entries.map(formatEntry).join('\n');
  } catch (err) {
    // Never let ledger derivation break prompt assembly.
    log.agent.warn('task-ledger: build failed', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
  return cachedRender;
}
