/**
 * The hook on task creation that keeps private tasks out of outside services (2026-11-01, the
 * user: "we define some rule and it is just a hook for the task creation, it will always create
 * local first and do these eval and then if error always warn user and also the CEO").
 *
 * birth.ts decides where a new task starts; a task born `checking` comes here. The small model
 * (privacy-judge.ts) reads it; a task it judges to be work gets its project's source and its
 * first push (releaseSyncHold), a private one stays local, and when the model cannot answer the
 * task stays local too: a push never goes out unjudged. A task kept local (by the model, the
 * user's words, or an edit that added one of them: sync-guard.ts) asks nothing of the user: the
 * safe choice is already made, the task's Sync row sends it, and Main hears of the day's kept
 * tasks in one line (kept-digest.ts). Letters an earlier version sent still take their answer
 * here. A restart judges again every task still `checking`.
 */
import { log } from '../../logging/index.js';
import { backgroundAiDisabled } from '../cheap-model.js';
import type { Config, SyncHold, Task } from '../types.js';
import { privateWordIn, wordsReason } from './birth.js';
import { hasTestPrivacyJudge, judgeTaskPrivacy, privacyModelReady } from './privacy-judge.js';
import { syncRulesFor, type SyncRules } from './provider-rules.js';
import { noteKeptLocal, resumeKeptDigest, settleKeptDigest, type TellKind } from './kept-digest.js';

/** A text that changed while it was judged is judged again, at most this many times. */
const MAX_TRIES = 3;

/** The AI rule runs: the provider's rules check and use it, and this server has a model to ask
 *  (a test server has none unless a test installed a judge; a server with no model provider set
 *  up has none either, and then only the hard rules are checked). */
export function privacyJudgeAvailable(rules: Pick<SyncRules, 'check' | 'ai'>): boolean {
  if (!rules.check || !rules.ai) return false;
  if (hasTestPrivacyJudge()) return true;
  return !backgroundAiDisabled() && privacyModelReady();
}

const inflight = new Map<string, Promise<void>>();

/** Wait for every running judgement (tests, shutdown). */
export async function settleSyncGates(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight.values()]);
  await flushKeptLocalLetters();
}

/** After a create (or a cloud outbox create): judge a `checking` task, tell the user about a
 *  `private` one. Never throws. */
export function startSyncGate(task: Pick<Task, 'id' | 'sync_hold'>): void {
  const hold = task.sync_hold;
  if (!hold) return;
  if (hold.state === 'checking') { runSyncGate(task.id); return; }
  if (hold.state === 'private' && hold.by === 'words' && !inflight.has(task.id)) {
    const work = tellKeptLocal(task.id, 'created').finally(() => inflight.delete(task.id));
    inflight.set(task.id, work);
  }
}

/** Judge one held task (once at a time per task). */
export function runSyncGate(taskId: string): Promise<void> {
  const running = inflight.get(taskId);
  if (running) return running;
  const work = judgeAndApply(taskId)
    .catch((err) => log.task.warn('private tasks: gate failed', { taskId, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => inflight.delete(taskId));
  inflight.set(taskId, work);
  return work;
}

const textKey = (t: Pick<Task, 'title' | 'description' | 'note' | 'summary'>) => JSON.stringify([t.title, t.description ?? '', t.note ?? '', t.summary ?? '']);
const stillChecking = (t: Readonly<Task>) => t.source === 'local' && t.sync_hold?.state === 'checking';

async function judgeAndApply(taskId: string): Promise<void> {
  const tm = await import('../task-manager.js');
  const { getConfig } = await import('../config-manager.js');
  let waitedForParent = false;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const task = await tm.getTask(taskId).catch(() => null);
    if (!task || !stillChecking(task)) return;
    const hold = task.sync_hold!;
    const config = await getConfig();
    const now = () => new Date().toISOString();
    // A subtask follows its parent: it waits while the parent is checked, and a parent kept
    // local keeps it local too (a private task's work is private).
    const parent = task.parent_task_id ? await tm.getTask(task.parent_task_id).catch(() => null) : null;
    if (parent?.source === 'local' && parent.sync_hold && parent.org_role !== 'lead') {
      if (parent.sync_hold.state === 'checking') {
        // Once: a parent still checking after its own gate ran is left for the next start.
        if (waitedForParent) return;
        waitedForParent = true;
        await runSyncGate(parent.id);
        attempt--; // the wait is not a try
        continue;
      }
      await tm.setTaskSyncHold(taskId, { ...hold, state: 'chosen', reason: 'Its parent task is kept local', at: now() }, stillChecking);
      return;
    }
    // A service only the user reads (audience.ts): nothing is checked, the task goes out. The
    // service is the one it would go to now (its project's), which is where a release sends it.
    const goesTo = (await tm.projectSyncSourceOf(task.project)) ?? hold.target;
    const rules = await syncRulesFor(config, goesTo);
    if (!rules.check) {
      await tm.releaseSyncHold(taskId, stillChecking);
      return;
    }
    // The hard rules first: they may have been added (to the task or the list) since its create.
    const entry = privateWordIn(rules.words, task);
    if (entry) {
      const kept = await tm.setTaskSyncHold(taskId, { ...hold, state: 'private', by: 'words', reason: wordsReason(entry), at: now() }, stillChecking);
      if (kept) await tellKeptLocal(taskId, 'created');
      return;
    }
    if (!privacyJudgeAvailable(rules)) {
      // The user turned the AI rule off while it waited: the hard rules passed it.
      await tm.releaseSyncHold(taskId, stillChecking);
      return;
    }
    const judged = textKey(task);
    let verdict: { private: boolean; reason: string } | null = null;
    let failure = '';
    try {
      verdict = await judgeTaskPrivacy({
        title: task.title, description: task.description, note: task.note, summary: task.summary,
        project: task.project, service: await serviceName(goesTo), rule: rules.aiRule,
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const after = await tm.getTask(taskId).catch(() => null);
    if (!after || !stillChecking(after)) return;
    if (textKey(after) !== judged && attempt < MAX_TRIES) continue; // edited meanwhile: judge what it says now
    if (!verdict) {
      log.task.warn('private tasks: the check could not answer, the task stays local', { taskId, error: failure });
      const kept = await tm.setTaskSyncHold(taskId, {
        ...after.sync_hold!, state: 'unjudged', reason: `Walnut could not check whether it is private (${failure.slice(0, 160)})`, at: now(), tries: attempt,
      }, stillChecking);
      if (kept) await tellKeptLocal(taskId, 'unjudged');
      return;
    }
    if (verdict.private) {
      log.task.info('private tasks: judged private, the task stays local', { taskId, reason: verdict.reason });
      const kept = await tm.setTaskSyncHold(taskId, {
        ...after.sync_hold!, state: 'private', by: 'model', reason: `It did not pass the AI rule: ${verdict.reason}`, at: now(), tries: attempt,
      }, stillChecking);
      if (kept) await tellKeptLocal(taskId, 'created');
      return;
    }
    const released = await tm.releaseSyncHold(taskId, stillChecking, 'model', task);
    log.task.info('private tasks: judged work', { taskId, reason: verdict.reason, released: released.released, why: released.reason });
    return;
  }
}

/** Judge again every task a restart left `checking` (the primary, at boot). */
export async function resumeSyncGates(): Promise<number> {
  const { listTasks } = await import('../task-manager.js');
  const all = await listTasks();
  const held = all.filter((t) => t.source === 'local' && t.sync_hold?.state === 'checking');
  for (const t of held) await runSyncGate(t.id);
  if (held.length) log.task.info('private tasks: judged the tasks a restart left waiting', { count: held.length });
  // The day's line a restart left waiting keeps its hour (it is on disk).
  await resumeKeptDigest();
  return held.length;
}

/** The outside service's name as the user reads it. */
export async function serviceName(source: string): Promise<string> {
  const { registry } = await import('../integration-registry.js');
  return registry.get(source)?.name ?? registry.getTombstone(source)?.name ?? source;
}

// ── Telling Main; answering letters an earlier version sent ──

export const LETTER_ACTIONS = {
  sync: 'sync',
  keep: 'keep-local',
  archive: 'archive-outside',
  neutralize: 'neutralize-outside',
} as const;

/**
 * A task kept local (by the model, the hard rules, or an edit a push check stopped) is already
 * safe, so nothing asks the user: it is noted for the day's one line to Main (kept-digest.ts),
 * and the task's own Sync row sends it whenever the user wants. Never throws.
 */
export function tellKeptLocal(taskId: string, kind: TellKind): Promise<void> {
  return noteKeptLocal(taskId, kind);
}

/** Wait until every kept task is noted (settleSyncGates, edit stops, tests). */
export async function flushKeptLocalLetters(): Promise<void> {
  await settleKeptDigest();
}

/** Settle the open letter of a hold a person resolved elsewhere (the task menu, an op). A letter
 *  that still asks about other tasks (a batch) stays open for them: only this task leaves it. */
export async function settleHoldLetter(hold: SyncHold | undefined, reason: string, taskId?: string): Promise<void> {
  if (!hold?.letter_id) return;
  const letterId = hold.letter_id;
  try {
    if (taskId) {
      const tm = await import('../task-manager.js');
      const others = (await tm.listTasks()).filter((t) => t.id !== taskId && t.source === 'local' && t.sync_hold?.letter_id === letterId);
      if (others.length) {
        await tm.setTaskSyncHold(taskId, (t) => t.sync_hold?.letter_id === letterId ? { ...t.sync_hold, letter_id: undefined } : t.sync_hold ?? null);
        return;
      }
    }
    const { getLetter, settleLetter } = await import('../human-inbox/store.js');
    const letter = await getLetter(hold.letter_id).catch(() => null);
    if (!letter || letter.answered || letter.archived) return;
    await settleLetter(hold.letter_id, { reason });
  } catch (err) {
    log.task.warn('private tasks: letter not settled', { letterId: hold.letter_id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The user's answer on a kept-local letter. Sending a task out is the user's own decision: an
 *  answer a task gave in their place keeps it local. */
export async function onKeptLocalAnswer(event: { letterId?: unknown; actionId?: unknown }): Promise<void> {
  if (typeof event.letterId !== 'string' || typeof event.actionId !== 'string') return;
  const letterId = event.letterId;
  const tm = await import('../task-manager.js');
  // One letter may ask about several tasks (a batch): the answer is for each of them.
  const tasks = (await tm.listTasks()).filter((t) => t.sync_hold?.letter_id === letterId);
  if (!tasks.length) return;
  const { getLetter } = await import('../human-inbox/store.js');
  const answered = (await getLetter(letterId).catch(() => null))?.answered;
  const byUser = !!answered && !answered.by;
  const action = event.actionId;
  const at = new Date().toISOString();
  for (const task of tasks) {
    try {
      await answerFor(task);
    } catch (err) {
      log.task.warn('private tasks: answer not applied to a task', { taskId: task.id, letterId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function answerFor(task: Task): Promise<void> {
    if (action === LETTER_ACTIONS.sync) {
      if (!byUser) {
        log.task.warn('private tasks: a task answered "sync" in the user\'s place; kept local', { taskId: task.id, letterId });
        return;
      }
      const r = await tm.releaseSyncHold(task.id, undefined, 'user');
      log.task.info('private tasks: the user sent a kept task out', { taskId: task.id, released: r.released, why: r.reason });
      return;
    }
    if ((action === LETTER_ACTIONS.archive || action === LETTER_ACTIONS.neutralize) && task.sync_hold?.outside?.state === 'kept') {
      await tm.actOnOutsideCopy(task.id, action === LETTER_ACTIONS.archive ? 'archive' : 'neutralize');
    }
    if (action === LETTER_ACTIONS.keep || action === LETTER_ACTIONS.archive || action === LETTER_ACTIONS.neutralize) {
      await tm.setTaskSyncHold(task.id, (t) => t.sync_hold
        ? { ...t.sync_hold, state: 'chosen', by: 'user', reason: 'You chose to keep it local', at, letter_id: undefined }
        : null);
    }
  }
}

let wired = false;
/** Listen for letter answers (the primary, at boot). */
export async function wireSyncGate(): Promise<void> {
  if (wired) return;
  wired = true;
  const { bus } = await import('../event-bus.js');
  bus.subscribe('private-tasks', (event) => {
    if (event.name !== 'human-inbox:answered') return;
    void onKeptLocalAnswer(event.data as Record<string, unknown>).catch((err) =>
      log.task.warn('private tasks: answer not applied', { error: err instanceof Error ? err.message : String(err) }));
  }, { global: true, interest: ['human-inbox:answered'] });
  // Who reads a service may have changed (Settings): give back what no longer needs keeping out.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const { onConfigWritten } = await import('../config-manager.js');
  onConfigWritten(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; void releaseUnshared('setting'); }, 2_000);
    pending.unref?.();
  });
  void releaseUnshared('boot');
}

async function releaseUnshared(why: string): Promise<void> {
  try {
    const { releaseHoldsOfUnsharedServices } = await import('./provider-rules.js');
    await releaseHoldsOfUnsharedServices();
  } catch (err) {
    log.task.warn('private tasks: releasing holds of unchecked providers failed', { why, error: err instanceof Error ? err.message : String(err) });
  }
}
