/**
 * A Board choice waits on the user as a thread of the leader that keeps the Board (experiment
 * `brief_off`; the design, translated: "the Board stays only as the overview page the leader draws for
 * itself; the choices it asks of you no longer sit on it, they become threads"). The same conversion
 * decision letters take (human-inbox/letter-threads.ts).
 *
 * Every unanswered `<walnut-choice>` on the Board of a task that keeps Threads (keepsThreads, open)
 * has one needs thread on that task, keyed by the Board and the choice (choiceThreadId): its title,
 * its options and its recommended one. That thread is the one place it shows: the status pass
 * leaves the choice out of the task's Needs you while the thread holds it (heldChoiceKeys, read by
 * user-status-sync.ts readChoices), and the thread's card answers through the Board's own choice
 * route (PUT /api/v1/tasks/:board/board/choices/:id), so the Board's task hears exactly what a
 * Board answer tells it today. An answer on the Board settles the thread the same way.
 *
 * One function (syncBoardChoiceThreads) makes a Board's choice threads match the Board, run on
 * every Board event that moves a choice (a page write, an answer, a delete), at boot and when the
 * experiment is switched (syncAllChoiceThreads, held-threads.ts startHeldThreads). It only opens or
 * settles threads, never touches a Board, and never makes two, even a week after one closed and was
 * deleted (the ledger in held-threads.ts). The experiment going off closes the open ones (marked
 * `off`); coming back on opens them again. Leader only: a replica keeps no Threads.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { choiceOutcome, choiceThreadId, holdsChoice, openChoiceThread, settleChoiceThread, type ChoiceOutcome } from '../org/choice-thread-model.js';
import { briefOffOn, briefOffFlag } from '../org/brief-off.js';
import { forgetHeld, heldSeen, noteHeld, oneAtATime, startHeldThreads } from '../org/held-threads.js';

/** The ids of choices' threads seen here: a change of one of them may change which choices count. */
const choiceThreads = new Set<string>();
export function isChoiceThread(threadId: string): boolean { return choiceThreads.has(threadId); }

const openTask = (t: Task | undefined): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done';
const NONE = (): ChoiceSyncResult => ({ opened: 0, settled: 0 });

export interface ChoiceSyncResult { opened: number; settled: number }

/**
 * Make the Board of `owner`'s choice threads match it (see the header). `tasks`: the task list
 * when the caller read it already. Never throws.
 */
export async function syncBoardChoiceThreads(owner: string, tasks?: readonly Task[]): Promise<ChoiceSyncResult> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return NONE();
  return oneAtATime(`board:${owner}`, () => syncNow(owner, tasks)).catch((err: unknown) => {
    log.task.warn('choice threads: a Board\'s choice threads not synced', { taskId: owner, error: err instanceof Error ? err.message : String(err) });
    return NONE();
  });
}

async function syncNow(owner: string, given?: readonly Task[]): Promise<ChoiceSyncResult> {
  const out = NONE();
  const on = await briefOffOn();
  const store = await import('../org/threads-store.js');
  const { getBoard } = await import('./board-store.js');
  const { choiceSpecs } = await import('./board-html.js');
  const board = await getBoard(owner).catch(() => null);
  const specs = board?.html ? choiceSpecs(board.html) : {};
  const tasks = given ?? await (await import('../task-manager.js')).listTasks();
  const task = tasks.find((t) => t.id === owner);
  const { keepsThreads } = await import('../org/keeps-threads.js');
  const keeps = on && openTask(task) && keepsThreads(task);
  const at = new Date().toISOString();
  const settle = async (node: string, threadId: string, outcome: ChoiceOutcome): Promise<void> => {
    const done = await store.writeThreadsFor(node, (cur) => {
      const r = settleChoiceThread(cur, threadId, outcome, at);
      return r ? { file: r.file, out: true, changed: { kind: 'updated' as const, threadId } } : { file: cur, out: false };
    });
    if (!done) return;
    out.settled++;
    log.task.info('choice threads: a choice\'s thread settled with it', { taskId: node, board: owner, threadId, outcome: outcome.kind });
  };
  // The choices the owner's file names that its Board no longer asks (removed, the Board deleted):
  // nothing left to answer.
  for (const t of (await store.readThreads(owner)).threads) {
    if (t.choice?.board !== owner) continue;
    choiceThreads.add(t.id);
    if (Object.hasOwn(specs, t.choice.id)) continue;
    const where = t.movedTo ? await store.threadHolder(owner, t.id).catch(() => null) : { node: owner, thread: t };
    if (where && holdsChoice(where.thread)) await settle(where.node, t.id, { kind: 'moot', words: 'It is no longer on the Board: nothing to decide here.' });
  }
  const { resolveChoiceRef } = await import('./open-choice.js');
  const allIds = tasks.map((t) => t.id);
  const ended: string[] = [];
  for (const [id, spec] of Object.entries(specs)) {
    const threadId = choiceThreadId(owner, id);
    choiceThreads.add(threadId);
    const holder = await store.threadHolder(owner, threadId).catch(() => null);
    const answer = board?.choices?.[id];
    if (answer) ended.push(threadId);
    if (answer || !keeps) {
      if (!holder || !holdsChoice(holder.thread)) continue;
      // Answered on the Board or on the card (either one is the Board's record), or the experiment went off.
      const outcome: ChoiceOutcome = answer ? choiceOutcome(answer) : { kind: 'off' };
      await settle(holder.node, threadId, outcome);
      if (outcome.kind === 'off') await noteHeld(threadId, 'choice', `${owner}/${id}`, 'off');
      continue;
    }
    const aside = !!holder?.thread.choice?.off && !holder.thread.choice.done && (!!holder.thread.closed || holder.thread.state === 'needs');
    if (holder && !aside) continue;
    // It had a thread here that was deleted a week after it closed (held-threads.ts): never a second one.
    if (!holder && (await heldSeen(threadId)) === 'open') continue;
    const ref = spec.task?.trim();
    const about = ref ? resolveChoiceRef(ref, allIds) : undefined;
    const input = {
      choice: {
        board: owner, id, title: spec.title?.trim() || 'Answer the choice on its Board.', options: spec.options,
        ...(about ? { task: about } : {}), ...(spec.recommended ? { recommended: spec.recommended } : {}),
      },
      by: `task:${owner}` as const, at,
    };
    const node = holder?.node ?? owner;
    const changed = await store.writeThreadsFor(node, (cur) => {
      const r = openChoiceThread(cur, input);
      return { file: r.file, out: r.changed, ...(r.changed ? { changed: { kind: r.changed === 'opened' ? 'opened' as const : 'updated' as const, threadId } } : {}) };
    });
    if (!changed) continue;
    out.opened++;
    await noteHeld(threadId, 'choice', `${owner}/${id}`, 'open');
    log.task.info('choice threads: a Board choice waits on its thread', { taskId: node, board: owner, choice: id, threadId, how: changed });
  }
  // Answered or gone from the Board: no record of its thread is needed any more.
  const live = new Set(Object.keys(specs).map((id) => choiceThreadId(owner, id)));
  const endedSet = new Set(ended);
  await forgetHeld((e) => e.kind === 'choice' && e.key.startsWith(`${owner}/`) && (endedSet.has(e.id) || !live.has(e.id)));
  return out;
}

/**
 * Every Board's choice threads made to match, then every thread still holding a choice of a Board
 * that is gone (boot, on or off, and every switch). Idempotent.
 */
export async function syncAllChoiceThreads(): Promise<ChoiceSyncResult> {
  const out = NONE();
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return out;
  const { listBoardTaskIds } = await import('./board-store.js');
  const tasks = await (await import('../task-manager.js')).listTasks();
  const boards = new Set(await listBoardTaskIds());
  const add = (r: ChoiceSyncResult) => { out.opened += r.opened; out.settled += r.settled; };
  for (const owner of boards) add(await syncBoardChoiceThreads(owner, tasks));
  const store = await import('../org/threads-store.js');
  const gone = new Set<string>();
  for (const node of await store.threadTaskIds()) {
    for (const t of (await store.readThreads(node)).threads) if (holdsChoice(t) && !boards.has(t.choice!.board)) gone.add(t.choice!.board);
  }
  for (const owner of gone) add(await syncBoardChoiceThreads(owner, tasks));
  if (out.opened || out.settled) log.task.info('choice threads: synced', { ...out });
  return out;
}

/**
 * The choices (`<board>/<id>`) a thread holds now (open, in needs, on an open task that keeps
 * Threads): the status pass leaves them out of Needs you and the Action needed items, since the
 * thread counts them. Empty while the experiment is off. A store Walnut cannot read holds none: a
 * miss shows a choice twice, never hides one.
 */
export async function heldChoiceKeys(choices: ReadonlyArray<{ board: string; id: string }>): Promise<Set<string>> {
  const held = new Set<string>();
  if (!choices.length || !(await briefOffOn())) return held;
  try {
    const store = await import('../org/threads-store.js');
    const { keepsThreads } = await import('../org/keeps-threads.js');
    const { listTasksByIds } = await import('../task-manager.js');
    const owners = new Map((await listTasksByIds([...new Set(choices.map((c) => c.board))])).map((t) => [t.id, t] as const));
    const files = new Map<string, Awaited<ReturnType<typeof store.readThreads>>>();
    const holders = new Map<string, string>();
    for (const c of choices) {
      const owner = owners.get(c.board);
      if (!openTask(owner) || !keepsThreads(owner)) continue;
      if (!files.has(c.board)) files.set(c.board, await store.readThreads(c.board));
      const id = choiceThreadId(c.board, c.id);
      const here = files.get(c.board)!.threads.find((t) => t.id === id);
      if (!here) continue;
      choiceThreads.add(id);
      // It moved on with its work: where it lives now, on a node still open that keeps Threads.
      const where = here.movedTo ? await store.threadHolder(c.board, id).catch(() => null) : { node: c.board, thread: here };
      if (where && holdsChoice(where.thread)) holders.set(`${c.board}/${c.id}`, where.node);
    }
    const moved = [...new Set(holders.values())].filter((n) => !owners.has(n));
    const nodes = new Map([...owners, ...(await listTasksByIds(moved)).map((t) => [t.id, t] as const)]);
    for (const [key, node] of holders) {
      const t = nodes.get(node);
      if (openTask(t) && keepsThreads(t)) held.add(key);
    }
  } catch { held.clear(); }
  return held;
}

/** Follow the Boards and the experiment switch (server boot, leader only). */
export function startChoiceThreads(opts: { firstMs?: number } = {}): { stop: () => void } {
  return startHeldThreads({
    name: 'choice-threads', flag: briefOffFlag, events: ['board:changed'], syncAll: syncAllChoiceThreads,
    ...(opts.firstMs !== undefined ? { firstMs: opts.firstMs } : {}),
    onEvent: (event, on) => {
      const d = (event.data ?? {}) as { taskId?: unknown; kind?: unknown };
      // Only a page write, an answer or a delete moves a choice (user-status-sync.ts reads the same kinds).
      if (typeof d.taskId !== 'string' || !['html', 'choice', 'deleted'].includes(String(d.kind))) return;
      // Off, only a Board whose threads Walnut opened has something to settle.
      if (!on && !choiceThreads.size) return;
      void syncBoardChoiceThreads(d.taskId);
    },
  });
}
