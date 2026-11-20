/**
 * Every thread that needs him, across all nodes, the most urgent first (experiment
 * `inbox_needs_threads`; the rules are needs-model.ts). The inbox lists them above his letters, the
 * bell counts them once, and his phone buzzes for them (push/needs-push.ts).
 *
 * The nodes are every open task that keeps Threads (Main, the VPs and leads, a task with Threads
 * on), the same set the status counts read (user-status-sync.ts readNodeThreads). Each node's file
 * is read once and kept until `org-threads:changed` names it (every write of a threads file emits
 * it), and again at most every REREAD_MS, so the bell asking after every change reads only what
 * changed (asks arriving together share one read); reading all of them is the heaviest read a status pass makes (about 240 nodes). Each
 * answer joins the rows with the tasks as they are now (withTaskAsks) and judges them with the
 * time now, so a snooze that ran out shows without a re-read. Leader only: a replica keeps no
 * Threads.
 */
import { log } from '../../logging/index.js';
import { experimentalEnabled } from '../experimental.js';
import type { Task } from '../types.js';
import type { OrgThread } from '../org/threads-model.js';
import { byUrgency, heldLetterOf, inboxNeedsCount, needsThreadsOf, needsUrgency, type NeedsUrgency } from './needs-model.js';

let on = false;
/** The experiment as last read. */
export function inboxNeedsThreadsNow(): boolean { return on; }
/** The experiment, read from the config now. */
export async function inboxNeedsThreadsOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    on = experimentalEnabled((await getConfig()).experimental, 'inbox_needs_threads');
  } catch { /* the last value read stands */ }
  return on;
}

type Rows = Awaited<ReturnType<typeof import('../org/threads-store.js').readThreads>>['threads'];
const REREAD_MS = 10 * 60_000;
const kept = new Map<string, Rows>();
let keptAt = 0;
/** Per node, bumped by each write of its threads; `all` by a change no event named. */
const gens = new Map<string, number>();
let all = 0;
const genOf = (taskId: string) => `${all}:${gens.get(taskId) ?? 0}`;
let watching: Promise<void> | null = null;
/** Every threads write seen. */
let writes = 0;

function forget(taskId?: string): void {
  writes++;
  if (taskId) { kept.delete(taskId); gens.set(taskId, (gens.get(taskId) ?? 0) + 1); } else { kept.clear(); all++; }
}

/** Follow every threads write, so a kept file is never older than its last change. */
function watch(): Promise<void> {
  watching ??= import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe('inbox-needs-threads', (event) => {
      const id = (event.data as { taskId?: unknown } | undefined)?.taskId;
      forget(typeof id === 'string' ? id : undefined);
    }, { global: true, interest: [EventNames.ORG_THREADS_CHANGED] });
  });
  return watching;
}

export interface NeedsThreadRow {
  thread: OrgThread;
  /** The node that holds it: its answer goes to that node (its chat, or the letter it holds). */
  node: { task_id: string; title: string; org_role?: string };
  urgency: NeedsUrgency;
}

async function rowsOf(taskId: string): Promise<Rows> {
  const hit = kept.get(taskId);
  if (hit) return hit;
  const mine = genOf(taskId);
  const rows = (await (await import('../org/threads-store.js')).readThreads(taskId)).threads;
  // A write of this node that landed while the read was out is not kept over (the next ask reads it again).
  if (mine === genOf(taskId)) kept.set(taskId, rows);
  return rows;
}

/**
 * Every thread that needs him, the most urgent first. Empty on a replica. `pinnedLetters`: the
 * letters he pinned (a thread holding one is urgent as a pinned thread); read here when not given.
 */
export async function listNeedsThreads(opts: { now?: number; tasks?: readonly Task[]; pinnedLetters?: ReadonlySet<string> } = {}): Promise<NeedsThreadRow[]> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return [];
  await watch();
  const now = opts.now ?? Date.now();
  if (now - keptAt >= REREAD_MS) { forget(); keptAt = now; }
  const store = await import('../org/threads-store.js');
  const [{ keepsThreads }, { orgDisplayTitle }, { openTask }] = await Promise.all([
    import('../org/keeps-threads.js'), import('../org/org-tree.js'), import('../org/thread-popup.js'),
  ]);
  const tasks = opts.tasks ?? await (await import('../task-manager.js')).listTasks();
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const out: NeedsThreadRow[] = [];
  for (const id of await store.threadTaskIds()) {
    const node = byId.get(id);
    if (!node || !keepsThreads(node) || !openTask(node)) continue;
    const rows = await rowsOf(id).catch((err: unknown) => {
      log.notif.warn('inbox needs: a node\'s threads not read', { taskId: id, error: err instanceof Error ? err.message : String(err) });
      return [] as Rows;
    });
    // Only a thread stored in needs can need him (a task's own ask placed on one is counted by that task).
    if (!rows.some((t) => !t.closed && t.state === 'needs')) continue;
    const read = await store.withTaskAsks(id, rows, tasks);
    for (const t of needsThreadsOf(read, now)) {
      out.push({ thread: t, node: { task_id: node.id, title: orgDisplayTitle(node), ...(node.org_role ? { org_role: node.org_role } : {}) }, urgency: needsUrgency(t, { node, tasks, now }) });
    }
  }
  // He pinned the decision letter a thread holds: urgent as a pinned thread.
  if (out.some((r) => heldLetterOf(r.thread))) {
    const pinned = opts.pinnedLetters ?? new Set((await (await import('./store.js')).listLetters({ archived: false })
      .catch(() => ({ letters: [] as { id: string; pinned: boolean }[] }))).letters.filter((l) => l.pinned).map((l) => l.id));
    for (const r of out) {
      const letter = heldLetterOf(r.thread);
      if (letter && pinned.has(letter)) r.urgency = needsUrgency(r.thread, { node: byId.get(r.node.task_id), tasks, letterPinned: true, now });
    }
  }
  return out.sort((a, b) => byUrgency({ id: a.thread.id, urgency: a.urgency }, { id: b.thread.id, urgency: b.urgency }));
}

export interface InboxNeeds {
  enabled: boolean;
  threads: NeedsThreadRow[];
  /** The letters those threads hold: the inbox lists each once, as its thread. */
  heldLetterIds: string[];
  counts: { threads: number; letters: number; total: number };
}

/**
 * What the inbox shows and counts. Off: no threads, and the counts are today's (unread letters).
 * The letters come from the store's own list, so a letter counted here is one the inbox lists.
 */
export function inboxNeeds(): Promise<InboxNeeds> {
  // Asks that arrive together (every open window hears the same change) share one read, unless a
  // threads write landed since it began: that one would answer from before the write.
  if (reading && reading.writes === writes) return reading.p;
  const mine = { writes, p: readInboxNeeds() };
  reading = mine;
  void mine.p.finally(() => { if (reading === mine) reading = null; }).catch(() => {});
  return mine.p;
}
let reading: { writes: number; p: Promise<InboxNeeds> } | null = null;

async function readInboxNeeds(): Promise<InboxNeeds> {
  const enabled = await inboxNeedsThreadsOn();
  const { listLetters } = await import('./store.js');
  const letters = (await listLetters({ archived: false })).letters;
  const threads = enabled ? await listNeedsThreads({ pinnedLetters: new Set(letters.filter((l) => l.pinned).map((l) => l.id)) }) : [];
  const counts = inboxNeedsCount(threads.map((r) => r.thread), letters);
  return { enabled, threads, heldLetterIds: threads.map((r) => heldLetterOf(r.thread)).filter((id): id is string => !!id), counts };
}
