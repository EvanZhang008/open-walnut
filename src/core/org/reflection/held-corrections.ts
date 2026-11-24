/**
 * Corrections held for a later send (2026-11-24 audit: 33 of 90 real corrections a day were held,
 * one a pass per task or past a lead chat's two a day, and never reached anyone). A correction that
 * waits is kept on the node's state; at the end of each pass every task with some gets them in ONE
 * message, when the task may get one (not already sent one this pass; a Main or lead chat at most
 * one an hour, state.ts takeChatSend). One kept longer than HELD_MAX_AGE_MS, or past
 * HELD_PER_TASK_MAX for its task, is dropped; the day's record says which went and which were dropped.
 *
 * At most once: a task's held ones are taken out of the state before their send and put back only
 * when the send fails, so a restart between the send and the write never sends them twice. A restart
 * between taking them out and the send loses them, unmarked in the record: one correction too few
 * is the lesser harm than the same one twice in a lead's chat.
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import type { Finding } from './judge.js';
import { appendDayNote, markHeld, nearlySame } from './records.js';
import { sessionNowOf } from './candidates.js';
import { giveBackChatSend, localDate, readReflectionState, takeChatSend, updateReflectionState, type HeldCorrection } from './state.js';

export const HELD_MAX_AGE_MS = 24 * 3600_000;
/** Held per task: past it the oldest go (said in the day's record). */
export const HELD_PER_TASK_MAX = 6;
const POINT_MAX = 900;

export interface HeldDeps {
  send: (task: Task, text: string, title: string) => Promise<boolean>;
  confirmSend: (node: Task, task: Task, sessionId: string) => Promise<boolean | string>;
  currentSession?: (task: Task) => Promise<string>;
}

/** The point a held correction makes, short: the correction, the right way, his words. Pure. */
export function heldPoint(f: Pick<Finding, 'correction' | 'correct_action' | 'user_quote'>): string {
  const text = [f.correction.trim(), f.correct_action ? `The right way: ${f.correct_action.trim()}` : '', f.user_quote ? `The user said: "${f.user_quote.trim()}"` : '']
    .filter(Boolean).join(' ');
  return text.length > POINT_MAX ? `${text.slice(0, POINT_MAX)} [...]` : text;
}

/** Every day entry one held item stands for: its own and the same points held again. */
const entriesOf = (h: HeldCorrection) => [{ date: h.date, entryAt: h.entryAt }, ...(h.merged ?? [])];

/** Mark the entries of these items in their days' JSON and say it in each day's Markdown. */
async function settle(node: Task, nodeName: string, taskId: string, items: readonly HeldCorrection[], how: 'sentLater' | 'heldDropped', line: (n: number) => string, nowMs: number): Promise<void> {
  const all = items.flatMap(entriesOf);
  for (const date of new Set(all.map((e) => e.date))) {
    const ats = all.filter((e) => e.date === date).map((e) => e.entryAt);
    await markHeld(node.id, nodeName, date, taskId, ats, how, nowMs).catch(() => {});
    await appendDayNote(node.id, nodeName, date, line(ats.length), nowMs).catch(() => {});
  }
}

/** Keep one correction for a later send. The same point held again for the task rides the one already held. */
export async function holdCorrection(node: Task, nodeName: string, taskTitle: string, h: HeldCorrection, nowMs: number): Promise<void> {
  const dropped = await updateReflectionState(node.id, (s) => {
    const all = s.held ?? [];
    const twin = all.find((x) => x.taskId === h.taskId && nearlySame(x.text, h.text));
    if (twin) { twin.merged = [...(twin.merged ?? []), { date: h.date, entryAt: h.entryAt }]; return []; }
    const mine = all.filter((x) => x.taskId === h.taskId);
    const over = mine.length + 1 - HELD_PER_TASK_MAX;
    const drop = over > 0 ? mine.slice(0, over) : [];
    s.held = [...all.filter((x) => !drop.includes(x)), h];
    return drop;
  }, nowMs);
  if (dropped.length) {
    await settle(node, nodeName, h.taskId, dropped, 'heldDropped', (n) => `Held corrections dropped: ${n} for ${taskTitle} (${h.taskId}), past the ${HELD_PER_TASK_MAX} a task may wait with (the oldest go).`, nowMs);
  }
}

/** The one message that carries a task's held corrections. Pure. */
export function heldText(nodeId: string, nodeName: string, items: readonly HeldCorrection[]): string {
  return [
    `${nodeName}'s reflection held ${items.length} correction${items.length === 1 ? '' : 's'} for this task (one message a pass, a lead's chat at most one an hour). Each is from a turn judged at the time it names; one you already took up since needs nothing more.`,
    '',
    ...items.map((h, i) => `${i + 1}. [${h.entryAt.slice(0, 16).replace('T', ' ')} UTC] ${h.text}`),
    '',
    `Act on them in this task. No reply to ${nodeName} is needed (task ${nodeId}).`,
  ].join('\n');
}

const isChat = (t: Task) => t.org_role === 'main' || t.org_role === 'lead';

/** Take a task's held items out of the state (all of them, or those too old). */
async function takeOut(nodeId: string, pick: (h: HeldCorrection) => boolean, nowMs: number): Promise<HeldCorrection[]> {
  return updateReflectionState(nodeId, (s) => {
    const out = (s.held ?? []).filter(pick);
    s.held = (s.held ?? []).filter((h) => !out.includes(h));
    return out;
  }, nowMs);
}

/** Put items back after a send that did not go, ahead of any held since. */
async function putBack(nodeId: string, items: readonly HeldCorrection[], nowMs: number): Promise<void> {
  await updateReflectionState(nodeId, (s) => { s.held = [...items, ...(s.held ?? [])]; }, nowMs);
}

/**
 * Send what this node holds, one message per task that may get one now. `sentThisPass` holds the
 * tasks that already got a correction this pass (they wait for the next). Answers how many went.
 */
export async function sendHeld(
  node: Task, nodeName: string, tasks: readonly Task[], sentThisPass: Set<string>, deps: HeldDeps, nowMs: number,
): Promise<number> {
  const titleOf = (id: string) => (id === node.id ? node : tasks.find((t) => t.id === id))?.title ?? id;
  const old = await takeOut(node.id, (h) => nowMs - Date.parse(h.at) > HELD_MAX_AGE_MS, nowMs);
  for (const id of new Set(old.map((h) => h.taskId))) {
    await settle(node, nodeName, id, old.filter((h) => h.taskId === id), 'heldDropped', (n) => `Held corrections dropped: ${n} for ${titleOf(id)} (${id}) waited over ${HELD_MAX_AGE_MS / 3600_000} hours for a send and were not sent (the session has moved on).`, nowMs);
  }
  const waiting = ((await readReflectionState(node.id, nowMs)).held ?? []).map((h) => h.taskId);
  let sent = 0;
  for (const taskId of new Set(waiting)) {
    if (sentThisPass.has(taskId)) continue;
    const task = taskId === node.id ? node : tasks.find((t) => t.id === taskId);
    const check = task ? await deps.confirmSend(node, task, await sessionNowOf(task, deps).catch(() => '')).catch(() => false) : 'gone';
    const ok = check === true || check === 'ok' || check === 'session_changed';
    // No session now, or a check that could not tell: kept for a later pass. Done, gone or no longer the node's: dropped.
    if (!ok) {
      if (check === 'no_session' || check === false) continue;
      const gone = await takeOut(node.id, (h) => h.taskId === taskId, nowMs);
      await settle(node, nodeName, taskId, gone, 'heldDropped', (n) => `Held corrections dropped: ${n} for ${titleOf(taskId)} (${taskId}), not sent (${String(check)}).`, nowMs);
      continue;
    }
    if (isChat(task!) && !(await takeChatSend(task!.id, nowMs))) continue;
    const items = await takeOut(node.id, (h) => h.taskId === taskId, nowMs);
    if (!items.length) continue;
    const went = await deps.send(task!, heldText(node.id, nodeName, items), `${nodeName}'s reflection: ${items.length} held correction${items.length === 1 ? '' : 's'}`).catch(() => false);
    if (!went) {
      await putBack(node.id, items, nowMs);
      if (isChat(task!)) await giveBackChatSend(task!.id, nowMs);
      continue;
    }
    sent++;
    sentThisPass.add(taskId);
    await settle(node, nodeName, taskId, items, 'sentLater', (n) => `Sent later: ${n} held correction${n === 1 ? '' : 's'} to ${task!.title} (${taskId}) at ${new Date(nowMs).toISOString().slice(11, 16)} UTC, in one message.`, nowMs);
    log.task.info('reflection: held corrections sent', { nodeId: node.id, taskId, count: items.length, day: localDate(nowMs) });
  }
  return sent;
}
