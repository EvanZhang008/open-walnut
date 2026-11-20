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
import type { BoardFile } from './board-store.js';
import { choiceOutcome, choiceThreadId, holdsChoice, openChoiceThread, settleChoiceThread, type ChoiceOutcome } from '../org/choice-thread-model.js';
import { heldAside } from '../org/held-thread-model.js';
import { briefOffOn, briefOffFlag } from '../org/brief-off.js';
import { forgetHeld, heldHolders, heldSeen, noteHeld, noteHolder, oneAtATime, startHeldThreads, writeHeldThread } from '../org/held-threads.js';

/** The ids of choices' threads found or opened here: a change of one of them may change which choices count. */
const choiceThreads = new Set<string>();
/** The Boards those threads belong to: with the experiment off, only these have anything to settle. */
const choiceBoards = new Set<string>();
const seenThread = (board: string, threadId: string): void => { choiceThreads.add(threadId); choiceBoards.add(board); };
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

/**
 * The Board as it is, or null when it is known gone; undefined when Walnut cannot tell (a read
 * that failed, a file it cannot parse): then nothing is settled or opened from it.
 */
async function readBoardNow(owner: string): Promise<BoardFile | null | undefined> {
  const { getBoard, hasBoard } = await import('./board-store.js');
  try {
    const board = await getBoard(owner);
    if (board) return board;
    return (await hasBoard(owner)) ? undefined : null;
  } catch (err) {
    log.task.warn('choice threads: a Board not read, its choice threads left as they are', { taskId: owner, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

async function syncNow(owner: string, given?: readonly Task[]): Promise<ChoiceSyncResult> {
  const out = NONE();
  const on = await briefOffOn();
  const store = await import('../org/threads-store.js');
  const board = await readBoardNow(owner);
  if (board === undefined) return out;
  const { choiceSpecs } = await import('./board-html.js');
  const specs = board?.html ? choiceSpecs(board.html) : {};
  const tasks = given ?? await (await import('../task-manager.js')).listTasks();
  const task = tasks.find((t) => t.id === owner);
  const { keepsThreads } = await import('../org/keeps-threads.js');
  const keeps = on && openTask(task) && keepsThreads(task);
  const at = new Date().toISOString();
  const settle = async (node: string, threadId: string, outcome: ChoiceOutcome): Promise<void> => {
    const done = await writeHeldThread(node, threadId, (cur) => {
      const r = settleChoiceThread(cur, threadId, outcome, at);
      return r && { file: r.file, changed: 'settled' as const };
    });
    if (!done) return;
    out.settled++;
    log.task.info('choice threads: a choice\'s thread settled with it', { taskId: node, board: owner, threadId, outcome: outcome.kind });
  };
  // The choices the owner's file names that its Board no longer asks (removed, the Board deleted):
  // nothing left to answer.
  for (const t of (await store.readThreads(owner)).threads) {
    if (t.choice?.board !== owner) continue;
    seenThread(owner, t.id);
    if (Object.hasOwn(specs, t.choice.id)) continue;
    const where = t.movedTo ? await store.threadHolder(owner, t.id).catch(() => null) : { node: owner, thread: t };
    if (where && holdsChoice(where.thread)) await settle(where.node, t.id, { kind: 'moot', words: 'It is no longer on the Board: nothing to decide here.' });
  }
  const { resolveChoiceRef } = await import('./open-choice.js');
  const allIds = tasks.map((t) => t.id);
  const ended: string[] = [];
  for (const [id, spec] of Object.entries(specs)) {
    const threadId = choiceThreadId(owner, id);
    const holder = await store.threadHolder(owner, threadId).catch(() => null);
    if (holder) seenThread(owner, threadId);
    const answer = board?.choices?.[id];
    if (answer) ended.push(threadId);
    // A thread that holds it, closed or not: never a second one after it is deleted.
    else if (holder) await noteHolder(holder.thread);
    if (answer || !keeps) {
      if (!holder || !holdsChoice(holder.thread)) continue;
      // Answered on the Board or on the card (either one is the Board's record), or the experiment went off.
      const outcome: ChoiceOutcome = answer ? choiceOutcome(answer) : { kind: 'off' };
      await settle(holder.node, threadId, outcome);
      if (outcome.kind === 'off') await noteHeld(threadId, 'choice', `${owner}/${id}`, 'off');
      continue;
    }
    if (holder && !heldAside(holder.thread, 'choice')) continue;
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
    // Known before the write, so the status pass hears the thread's change event as a choice's.
    seenThread(owner, threadId);
    const changed = await writeHeldThread(node, threadId, (cur) => openChoiceThread(cur, input));
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
 * that is gone (boot, on or off, and every switch). Off, only the Boards whose choices have a
 * thread. Idempotent.
 */
export async function syncAllChoiceThreads(): Promise<ChoiceSyncResult> {
  const out = NONE();
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return out;
  const on = await briefOffOn();
  const store = await import('../org/threads-store.js');
  // Every Board a thread names, by any state of it: off, these are the only ones to settle.
  const named = new Set<string>();
  for (const node of await store.threadTaskIds()) {
    for (const t of (await store.readThreads(node)).threads) {
      if (t.choice && !t.movedTo) { named.add(t.choice.board); seenThread(t.choice.board, t.id); }
    }
  }
  const { listBoardTaskIds } = await import('./board-store.js');
  const owners = on ? new Set([...await listBoardTaskIds(), ...named]) : named;
  if (!owners.size) return out;
  const tasks = await (await import('../task-manager.js')).listTasks();
  for (const owner of owners) {
    const r = await syncBoardChoiceThreads(owner, tasks);
    out.opened += r.opened; out.settled += r.settled;
  }
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
  if (!choices.length || !(await briefOffOn())) return new Set();
  try {
    const items = choices.map((c) => ({ key: `${c.board}/${c.id}`, node: c.board, threadId: choiceThreadId(c.board, c.id) }));
    const { holders, counted } = await heldHolders(items, holdsChoice);
    for (const [key] of holders) { const at = key.indexOf('/'); seenThread(key.slice(0, at), choiceThreadId(key.slice(0, at), key.slice(at + 1))); }
    return counted;
  } catch { return new Set(); }
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
      // Off, only a Board with a choice's thread has something to settle.
      if (!on && !choiceBoards.has(d.taskId)) return;
      void syncBoardChoiceThreads(d.taskId);
    },
  });
}
