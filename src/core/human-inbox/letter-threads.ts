/**
 * A decision letter waits on the user as a thread of the task that sent it (experiment
 * `letters_as_threads`; 2026-11-20, the user, on a decision letter he saw in his inbox and atop his
 * VP's chat but not in its Threads: "why it exist in both place? is it the same thing ... inbox?").
 *
 * Every decision letter still waiting on him (awaitsUserDecision) from a task that keeps Threads
 * (keepsThreads, the same rule routine updates follow: letter-to-thread.ts filesUpdatesAsThreads)
 * has one needs thread on that task, keyed by the letter (letter-thread-model.ts letterThreadId):
 * its question, its options and a link to the letter. That thread is the one place it shows: the
 * Action needed items and the counts leave the letter out while the thread holds it
 * (heldLetterIds, read by user-status-sync.ts), and its card answers through the letter's own
 * answer route, so the asker hears exactly what a letter answer tells it today.
 *
 * One function (syncLetterThread) makes a letter's thread match the letter, run on every letter
 * event (sent, answered, read, archived, settled), at boot and when the experiment is switched (the
 * migration of letters already sent: syncAllLetterThreads). It only opens or settles threads,
 * never touches a letter, and never makes two: the thread id is the letter's. When the letter no
 * longer waits on him its thread says how it ended (answered by him: closed as known; answered for
 * him: answered, news; settled or archived: dropped). The experiment going off closes the open ones
 * (marked `off`); coming back on opens them again. Leader only: a replica keeps no Threads.
 */
import { log } from '../../logging/index.js';
import { experimentalEnabled } from '../experimental.js';
import type { Task } from '../types.js';
import { holdsLetter, letterThreadId, openLetterThread, settleLetterThread, type LetterOutcome } from '../org/letter-thread-model.js';
import { awaitsUserDecision, userAnsweredInThread } from './open-decision.js';
import { LETTER_TYPE_ROUTES, filesUpdatesAsThreads } from './letter-to-thread.js';
import type { LetterRecord, LetterType } from './types.js';

let on = false;
/** The ids of letters' threads seen here: a change of one of them may change which letters count. */
const letterThreads = new Set<string>();
/** Whether a thread change may move which letters count (an unknown thread id: no). */
export function isLetterThread(threadId: string): boolean { return letterThreads.has(threadId); }
/** The tasks whose threads held a letter at the last count: a change of one (its Threads turned off, completed) may show the letter again. */
let holderTasks = new Set<string>();
export function holdsLettersNow(taskId: string): boolean { return holderTasks.has(taskId); }
/** The experiment as last read. */
export function lettersAsThreadsNow(): boolean { return on; }
/** The experiment, read from the config now (a status pass right after Settings changed it agrees). */
export async function lettersAsThreadsOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    on = experimentalEnabled((await getConfig()).experimental, 'letters_as_threads');
  } catch { /* the last value read stands */ }
  return on;
}

/** Why this letter never waits on a thread, whoever sent it; null when it may. Pure. */
export function letterThreadSkip(l: Pick<LetterRecord, 'type' | 'sender' | 'items' | 'credentialAsk' | 'actions'>): string | null {
  if (LETTER_TYPE_ROUTES[l.type as LetterType]?.lettersAsThreads.to !== 'needs_thread') return 'type';
  if (!l.sender?.taskId) return 'no_task';
  // A plugin's approval of a step outside Walnut, a sign-in ask, mail items: only their own pick settles them.
  if (l.sender.pluginId || l.sender.sessionId === 'external') return 'plugin';
  if (l.items?.length) return 'items';
  if (l.credentialAsk) return 'credential';
  if (!l.actions?.length) return 'no_options';
  return null;
}

const clip = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`; };

/** How the letter ended, as its thread says it; null while it still waits on him. Pure. */
export function letterOutcome(l: LetterRecord, withdrawnId: string): LetterOutcome | null {
  const a = l.answered;
  if (a) {
    if (a.actionId === withdrawnId) return { kind: 'moot', words: 'Withdrawn by the task that asked: nothing to decide.' };
    const said = `${a.label}${a.freeText?.trim() ? ` (${clip(a.freeText, 300)})` : ''}`;
    return a.by?.sessionId
      ? { kind: 'for_him', words: `Answered for you by ${a.by.name || 'another task'}: ${said}` }
      : { kind: 'his', words: `You answered: ${said}` };
  }
  if (userAnsweredInThread(l)) {
    const last = [...l.thread].reverse().find((t) => t.from === 'human');
    const words = `“${clip(last?.text || 'a picture', 300)}”`;
    return last?.by?.sessionId
      ? { kind: 'for_him', words: `Answered for you by ${last.by.name || 'another task'}: ${words}` }
      : { kind: 'his', words: `You wrote back: ${words}` };
  }
  if (l.settled) return { kind: 'moot', words: `Settled: ${clip(l.settled.reason, 300)}` };
  if (l.archived) return { kind: 'moot', words: 'Archived in the inbox: nothing to decide here.', byHim: !l.archivedReason };
  return null;
}

/**
 * The task whose Threads this decision letter waits on, or null when it stays a letter only: a
 * letter that never does (letterThreadSkip), or a sender that keeps no Threads, files no updates
 * there or completed. `tasks`: the task list when the caller read it already.
 */
export async function letterThreadTask(l: LetterRecord, tasks?: readonly Task[]): Promise<Task | null> {
  const taskId = l.sender?.taskId;
  if (!taskId || letterThreadSkip(l)) return null;
  const task = tasks ? tasks.find((t) => t.id === taskId) : (await (await import('../task-manager.js')).listTasksByIds([taskId]).catch(() => []))[0];
  const { keepsThreads } = await import('../org/keeps-threads.js');
  const { isTriageLetterSender } = await import('./letter-origin.js');
  if (!task || task.phase === 'COMPLETE' || !filesUpdatesAsThreads(task, isTriageLetterSender(l.sender), keepsThreads)) return null;
  return task;
}

/**
 * This letter, as it is now, waits on him as a thread (the experiment on, the leader, a decision
 * still waiting on him, a task whose Threads take it): that task and the thread's id. The phone
 * buzzes for the thread instead of the letter (push/needs-push.ts). Null otherwise.
 */
export async function letterWaitsOnThread(l: LetterRecord): Promise<{ task: Task; threadId: string } | null> {
  if (l.type !== 'action_required' || !(await lettersAsThreadsOn())) return null;
  const { isFollower } = await import('../server-role.js');
  if (isFollower() || !awaitsUserDecision(l)) return null;
  const task = await letterThreadTask(l);
  return task ? { task, threadId: letterThreadId(l.id) } : null;
}

type Done = 'opened' | 'reopened' | 'settled' | 'off' | null;

/**
 * Make the letter's thread match the letter (see the header). `tasks`: the task list when the
 * caller read it already (the migration reads it once). Never throws for one letter's failure.
 */
export async function syncLetterThread(l: LetterRecord, tasks?: readonly Task[]): Promise<Done> {
  const taskId = l.sender?.taskId;
  if (!taskId || l.type !== 'action_required') return null;
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return null;
  const { oneSendPerNode } = await import('./away-thread.js');
  // One write at a time per task, shared with the updates it files (letter-to-thread.ts).
  return oneSendPerNode(taskId, () => syncNow(l, taskId, tasks)).catch((err: unknown) => {
    log.notif.warn('letter threads: a letter\'s thread not synced', { letterId: l.id, taskId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
}

async function syncNow(seen: LetterRecord, taskId: string, tasks?: readonly Task[]): Promise<Done> {
  const store = await import('../org/threads-store.js');
  const id = letterThreadId(seen.id);
  letterThreads.add(id);
  const holder = await store.threadHolder(taskId, id).catch(() => null);
  // The letter as it is now, read in this task's turn: a snapshot taken before an answer that
  // landed meanwhile must not open a thread for a letter already answered.
  const l = await (await import('./store.js')).getLetter(seen.id, { deferBodies: true }).catch(() => seen);
  if (!l) return holder && holdsLetter(holder.thread) && (await settleGone(holder.node, id)) ? 'settled' : null;
  const waits = awaitsUserDecision(l);
  const at = new Date().toISOString();
  const aside = !!holder?.thread.letter?.off && !holder.thread.letter.done && (!!holder.thread.closed || holder.thread.state === 'needs');
  if (waits && on && (!holder || aside)) {
    if (!(await letterThreadTask(l, tasks))) return null;
    const { letterItem } = await import('../action-needed-facts.js');
    const item = letterItem(l);
    const input = {
      letter: {
        id: l.id, task: taskId, subject: item.summary, ...(item.detail ? { detail: item.detail } : {}), preview: item.detail ?? l.textPreview, createdAt: l.createdAt,
        options: (l.actions ?? []).map((a) => ({ id: a.id, label: a.label, ...(a.description ? { description: a.description } : {}), ...(a.recommended ? { recommended: true as const } : {}) })),
      },
      by: `task:${taskId}` as const, at,
    };
    const node = holder?.node ?? taskId;
    const changed = await store.writeThreadsFor(node, (cur) => {
      const r = openLetterThread(cur, input);
      return { file: r.file, out: r.changed, ...(r.changed ? { changed: { kind: r.changed === 'opened' ? 'opened' as const : 'updated' as const, threadId: id } } : {}) };
    });
    if (changed) log.notif.info('letter threads: a decision letter waits on its thread', { letterId: l.id, taskId: node, threadId: id, how: changed });
    return changed;
  }
  if (!holder || !holdsLetter(holder.thread)) return null;
  const { WITHDRAWN_ACTION_ID } = await import('./store.js');
  const outcome: LetterOutcome | null = waits ? (on ? null : { kind: 'off' }) : letterOutcome(l, WITHDRAWN_ACTION_ID);
  if (!outcome) return null;
  const done = await store.writeThreadsFor(holder.node, (cur) => {
    const r = settleLetterThread(cur, id, outcome, at);
    return r ? { file: r.file, out: true, changed: { kind: 'updated' as const, threadId: id } } : { file: cur, out: false };
  });
  if (!done) return null;
  log.notif.info('letter threads: a letter\'s thread settled with it', { letterId: l.id, taskId: holder.node, threadId: id, outcome: outcome.kind });
  return outcome.kind === 'off' ? 'off' : 'settled';
}

/**
 * Every letter's thread made to match (the migration; run at boot with the experiment on and on
 * every switch of it): each decision letter in the inbox, then each open thread still holding a
 * letter that left the inbox since. Idempotent: run twice, the second run changes nothing.
 */
export async function syncAllLetterThreads(): Promise<{ opened: number; settled: number }> {
  const out = { opened: 0, settled: 0 };
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return out;
  await lettersAsThreadsOn();
  const inbox = await import('./store.js');
  const tasks = await (await import('../task-manager.js')).listTasks();
  const count = (d: Done) => { if (d === 'opened' || d === 'reopened') out.opened++; else if (d) out.settled++; };
  const open = (await inbox.listLetters({ archived: false })).letters.filter((l) => l.type === 'action_required' && l.sender?.taskId);
  for (const l of open) count(await syncLetterThread(l, tasks));
  const seen = new Set(open.map((l) => l.id));
  const store = await import('../org/threads-store.js');
  for (const node of await store.threadTaskIds()) {
    for (const t of (await store.readThreads(node)).threads) {
      if (!holdsLetter(t) || seen.has(t.letter!.id)) continue;
      seen.add(t.letter!.id);
      const l = await inbox.getLetter(t.letter!.id, { deferBodies: true }).catch(() => null);
      if (l) count(await syncLetterThread(l, tasks));
      else if (await settleGone(node, t.id)) out.settled++;
    }
  }
  if (out.opened || out.settled) log.notif.info('letter threads: synced', out);
  return out;
}

/** The letter is gone from the store (deleted by hand): its thread has nothing left to answer. */
async function settleGone(node: string, threadId: string): Promise<boolean> {
  const store = await import('../org/threads-store.js');
  return store.writeThreadsFor(node, (cur) => {
    const r = settleLetterThread(cur, threadId, { kind: 'moot', words: 'Its letter is no longer in the inbox: nothing to decide here.' }, new Date().toISOString());
    return r ? { file: r.file, out: true, changed: { kind: 'updated' as const, threadId } } : { file: cur, out: false };
  });
}

/**
 * The letters among `letters` a thread holds now (open, in needs, on a task still open, since a
 * completed task's threads are not counted): the status pass leaves them out of the Action needed
 * items and the Needs you it derives, since the thread counts them. Empty while the experiment is
 * off. A store Walnut cannot read holds none: a miss shows a letter twice, never hides one.
 */
export async function heldLetterIds(letters: readonly Pick<LetterRecord, 'id' | 'sender'>[]): Promise<Set<string>> {
  const held = new Set<string>();
  if (!letters.length || !(await lettersAsThreadsOn())) return held;
  try {
    const store = await import('../org/threads-store.js');
    const files = new Map<string, Awaited<ReturnType<typeof store.readThreads>>>();
    /** Letter id -> the node its thread waits on him from. */
    const holders = new Map<string, string>();
    for (const l of letters) {
      const taskId = l.sender?.taskId;
      if (!taskId) continue;
      if (!files.has(taskId)) files.set(taskId, await store.readThreads(taskId));
      const id = letterThreadId(l.id);
      const here = files.get(taskId)!.threads.find((x) => x.id === id);
      if (!here) continue;
      // It moved on with its work: where it lives now.
      const where = here.movedTo ? await store.threadHolder(taskId, id).catch(() => null) : { node: taskId, thread: here };
      if (where && holdsLetter(where.thread) && where.thread.letter!.id === l.id) { holders.set(l.id, where.node); letterThreads.add(id); }
    }
    holderTasks = new Set(holders.values());
    if (!holders.size) return held;
    const { listTasksByIds } = await import('../task-manager.js');
    const { keepsThreads } = await import('../org/keeps-threads.js');
    // Counted only where its node's threads are counted (user-status-sync.ts readNodeThreads):
    // a task that stopped keeping Threads, or completed, shows the letter again.
    const open = new Set((await listTasksByIds([...new Set(holders.values())]))
      .filter((t) => keepsThreads(t) && t.phase !== 'COMPLETE' && t.status !== 'done').map((t) => t.id));
    for (const [letterId, node] of holders) if (open.has(node)) held.add(letterId);
  } catch { held.clear(); }
  return held;
}

const LETTER_EVENTS = ['human-inbox:letter', 'human-inbox:answered', 'human-inbox:state'];

/** Follow the letters and the experiment switch (server boot, leader only). */
export function startLetterThreads(opts: { firstMs?: number } = {}): { stop: () => void } {
  let stopped = false;
  let first: ReturnType<typeof setTimeout> | null = null;
  void (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    let seen = await lettersAsThreadsOn();
    bus.subscribe('letter-threads', (event) => {
      if (event.name === EventNames.CONFIG_CHANGED) {
        void lettersAsThreadsOn().then((now) => {
          if (now === seen) return;
          seen = now;
          log.notif.info('letter threads: experiment switched', { on: now });
          return syncAllLetterThreads().then(() => undefined);
        }).catch((err: unknown) => log.notif.warn('letter threads: switch not synced', { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      if (!on) return;
      const letterId = (event.data as { letterId?: unknown } | undefined)?.letterId;
      if (typeof letterId !== 'string') return;
      void import('./store.js').then(({ getLetter }) => getLetter(letterId, { deferBodies: true }))
        .then((l) => (l ? syncLetterThread(l) : null))
        .catch(() => {});
    }, { global: true, interest: [...LETTER_EVENTS, EventNames.CONFIG_CHANGED] });
    // At boot with the experiment on: the letters sent before (or while this server was down).
    if (seen && !stopped) {
      first = setTimeout(() => { void syncAllLetterThreads().catch(() => {}); }, opts.firstMs ?? 5_000);
      first.unref?.();
    }
  })();
  return {
    stop: () => {
      stopped = true;
      if (first) clearTimeout(first);
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe('letter-threads')).catch(() => {});
    },
  };
}
