/**
 * The hook on task creation that keeps private tasks out of outside services (2026-11-01, the
 * user: "we define some rule and it is just a hook for the task creation, it will always create
 * local first and do these eval and then if error always warn user and also the CEO").
 *
 * birth.ts decides where a new task starts; a task born `checking` comes here. The small model
 * (privacy-judge.ts) reads it; a task it judges to be work gets its project's source and its
 * first push (releaseSyncHold), a private one stays local, and when the model cannot answer the
 * task stays local too: a push never goes out unjudged. A task kept local (by the model, the
 * user's words, or an edit that added one of them: sync-guard.ts) tells the user in one decision
 * letter (Sync to the service, or Keep local, plus what to do with an outside copy) and tells
 * Main in one line riding its next message. A restart judges again every task still `checking`.
 */
import { log } from '../../logging/index.js';
import { backgroundAiDisabled } from '../cheap-model.js';
import type { Config, SyncHold, Task } from '../types.js';
import { modelCheckOn, privateWordIn, wordsReason } from './birth.js';
import { hasTestPrivacyJudge, judgeTaskPrivacy, privacyModelReady } from './privacy-judge.js';

/** A text that changed while it was judged is judged again, at most this many times. */
const MAX_TRIES = 3;

/** The model check runs: the user left it on, and this server has a model to ask (a test
 *  server has none unless a test installed a judge; a server with no model provider set up has
 *  none either, and then only the user's words are checked). */
export function privacyJudgeAvailable(config: Pick<Config, 'private_tasks'>): boolean {
  if (!modelCheckOn(config.private_tasks)) return false;
  if (hasTestPrivacyJudge()) return true;
  return !backgroundAiDisabled() && privacyModelReady();
}

const inflight = new Map<string, Promise<void>>();

/** Wait for every running judgement (tests, shutdown). */
export async function settleSyncGates(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight.values()]);
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
    // The words first: they may have been added (to the task or the list) since its create.
    const entry = privateWordIn(config.private_tasks, task);
    if (entry) {
      const kept = await tm.setTaskSyncHold(taskId, { ...hold, state: 'private', by: 'words', reason: wordsReason(entry), at: now() }, stillChecking);
      if (kept) await tellKeptLocal(taskId, 'created');
      return;
    }
    if (!privacyJudgeAvailable(config)) {
      // The user turned the check off while it waited: the words passed it.
      await tm.releaseSyncHold(taskId, stillChecking);
      return;
    }
    const judged = textKey(task);
    let verdict: { private: boolean; reason: string } | null = null;
    let failure = '';
    try {
      verdict = await judgeTaskPrivacy({
        title: task.title, description: task.description, note: task.note, summary: task.summary,
        project: task.project, service: await serviceName(hold.target),
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
        ...after.sync_hold!, state: 'private', by: 'model', reason: `Walnut judged it private: ${verdict.reason}`, at: now(), tries: attempt,
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
  const held = (await listTasks()).filter((t) => t.source === 'local' && t.sync_hold?.state === 'checking');
  for (const t of held) await runSyncGate(t.id);
  if (held.length) log.task.info('private tasks: judged the tasks a restart left waiting', { count: held.length });
  return held.length;
}

/** The outside service's name as the user reads it. */
export async function serviceName(source: string): Promise<string> {
  const { registry } = await import('../integration-registry.js');
  return registry.get(source)?.name ?? registry.getTombstone(source)?.name ?? source;
}

// ── Telling the user and Main ──

export const LETTER_ACTIONS = {
  sync: 'sync',
  keep: 'keep-local',
  archive: 'archive-outside',
  neutralize: 'neutralize-outside',
} as const;

type TellKind = 'created' | 'unjudged' | 'edited' | 'edit-unjudged';

const md = (s: string) => s.replace(/([\\`*_[\]<>])/g, '\\$1');

/**
 * One decision letter for a task kept local, and one line to Main. `edited` = a synced task a
 * push check stopped (its outside copy keeps the text it had before), `edit-unjudged` = one the
 * model could not check. Never throws.
 */
export async function tellKeptLocal(taskId: string, kind: TellKind): Promise<void> {
  try {
    const tm = await import('../task-manager.js');
    const task = await tm.getTask(taskId).catch(() => null);
    const hold = task?.sync_hold;
    if (!task || !hold || task.source !== 'local') return;
    const service = await serviceName(hold.target);
    const title = task.title.replace(/\s+/g, ' ').slice(0, 120);
    const reason = hold.reason ?? 'It looks private';
    const outside = hold.outside?.state === 'kept';
    const where = task.project ? ` in ${md(task.project)}` : '';
    const edit = kind === 'edited' || kind === 'edit-unjudged';
    const lines = kind === 'edit-unjudged'
      ? [
        `Walnut could not check a change to **${md(title)}**${where} before it went to ${md(service)} (${md(reason)}), so it stopped syncing the task and sent nothing. It is a local task now, with all of its content.`,
        '',
        outside ? `Its copy in ${md(service)} still has the text it had before this change.` : '',
      ]
      : kind === 'edited'
      ? [
        `An edit to **${md(title)}**${where} made it private (${md(reason)}), so Walnut stopped syncing it to ${md(service)} before the change went out. It is a local task now, with all of its content.`,
        '',
        outside ? `Its copy in ${md(service)} still has the text it had before this edit.` : '',
      ]
      : [
        `Walnut kept the new task **${md(title)}**${where} out of ${md(service)}: ${md(reason)}. It lives only in Walnut.`,
        '',
        kind === 'unjudged' ? 'Nothing was sent: a task is only sent once it is checked.' : '',
      ];
    lines.push('', `**Sync to ${md(service)}** sends it there now. **Keep local** keeps it out for good.`
      + (outside ? ' **Archive there** closes its copy there; **Neutralize there** also removes its title and text from it.' : ''));
    const { sendLetter } = await import('../human-inbox/store.js');
    const letter = await sendLetter({
      subject: edit ? `"${title}" stopped syncing to ${service}` : `"${title}" kept out of ${service}`,
      type: 'action_required',
      markdown: lines.filter((l, i, all) => l || (all[i - 1] ?? '') !== '').join('\n'),
      actions: [
        { id: LETTER_ACTIONS.keep, label: 'Keep local', description: `It stays in Walnut only, never sent to ${service}` },
        { id: LETTER_ACTIONS.sync, label: `Sync to ${service}`, description: `Send it to ${service} now` },
        ...(outside ? [
          { id: LETTER_ACTIONS.archive, label: 'Archive there', description: `Keep it local and close its copy in ${service}` },
          { id: LETTER_ACTIONS.neutralize, label: 'Neutralize there', description: `Keep it local, replace its copy's title and text in ${service} and close it` },
        ] : []),
      ],
      taskRefs: [task.id],
      sender: { sessionId: 'external', host: 'local' },
    });
    await tm.setTaskSyncHold(taskId, (t) => t.sync_hold ? { ...t.sync_hold, letter_id: letter.id } : null);
    await tellMain(`Walnut kept the task "${title}" (${task.id}) out of ${service}: ${reason}. The user has a letter to decide.`, task.id);
    log.task.info('private tasks: the user was told', { taskId, kind, letterId: letter.id });
  } catch (err) {
    log.task.warn('private tasks: the user was not told', { taskId, kind, error: err instanceof Error ? err.message : String(err) });
  }
}

/** One line riding Main's next message (never a wake). */
async function tellMain(line: string, taskId: string): Promise<void> {
  try {
    const { listTasks } = await import('../task-manager.js');
    const main = (await listTasks()).find((t) => t.org_role === 'main' && t.phase !== 'COMPLETE');
    if (!main || main.id === taskId) return;
    const { followerSession, tellOrRide } = await import('../sessions/status-push.js');
    const rec = await followerSession(main.id);
    if (rec?.claudeSessionId) await tellOrRide(rec.claudeSessionId, `private-task:${taskId}`, line);
  } catch (err) {
    log.task.warn('private tasks: Main was not told', { taskId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Settle the open letter of a hold a person resolved elsewhere (the task menu, an op). */
export async function settleHoldLetter(hold: SyncHold | undefined, reason: string): Promise<void> {
  if (!hold?.letter_id) return;
  try {
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
  const task = (await tm.listTasks()).find((t) => t.sync_hold?.letter_id === letterId);
  if (!task) return;
  const { getLetter } = await import('../human-inbox/store.js');
  const answered = (await getLetter(letterId).catch(() => null))?.answered;
  const byUser = !!answered && !answered.by;
  const action = event.actionId;
  const at = new Date().toISOString();
  if (action === LETTER_ACTIONS.sync) {
    if (!byUser) {
      log.task.warn('private tasks: a task answered "sync" in the user\'s place; kept local', { taskId: task.id, letterId });
      return;
    }
    const r = await tm.releaseSyncHold(task.id, undefined, 'user');
    log.task.info('private tasks: the user sent a kept task out', { taskId: task.id, released: r.released, why: r.reason });
    return;
  }
  if (action === LETTER_ACTIONS.archive || action === LETTER_ACTIONS.neutralize) {
    await tm.actOnOutsideCopy(task.id, action === LETTER_ACTIONS.archive ? 'archive' : 'neutralize');
  }
  if (action === LETTER_ACTIONS.keep || action === LETTER_ACTIONS.archive || action === LETTER_ACTIONS.neutralize) {
    await tm.setTaskSyncHold(task.id, (t) => t.sync_hold
      ? { ...t.sync_hold, state: 'chosen', by: 'user', reason: 'You chose to keep it local', at, letter_id: undefined }
      : null);
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
}
