/**
 * Corrections held for a later send (2026-11-24 audit: 33 of 90 real corrections a day were held,
 * one a pass per task or past a lead chat's two a day, and never reached anyone). A correction that
 * waits is kept on the node's state; at the end of each pass every task with some gets them in ONE
 * message, when the task may get one (not already sent one this pass; a Main or lead chat at most
 * one an hour, state.ts takeChatSend). One kept longer than HELD_MAX_AGE_MS is dropped and said in
 * the day's record: the session has moved on.
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import type { Finding } from './judge.js';
import { appendDayNote, markSentLater, nearlySame } from './records.js';
import { sessionNowOf } from './candidates.js';
import { localDate, takeChatSend, updateReflectionState, type HeldCorrection, type ReflectionState } from './state.js';

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

/** Keep one correction for a later send; the same point said again for the task is kept once. */
export async function holdCorrection(nodeId: string, h: HeldCorrection, nowMs: number): Promise<void> {
  await updateReflectionState(nodeId, (s) => {
    const all = s.held ?? [];
    if (all.some((x) => x.taskId === h.taskId && nearlySame(x.text, h.text))) return;
    const mine = all.filter((x) => x.taskId === h.taskId);
    const over = mine.length + 1 - HELD_PER_TASK_MAX;
    const drop = new Set(over > 0 ? mine.slice(0, over) : []);
    s.held = [...all.filter((x) => !drop.has(x)), h];
  }, nowMs);
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

/**
 * Send what this node holds, one message per task that may get one now. `sentThisPass` holds the
 * tasks that already got a correction this pass (they wait for the next). Answers how many went.
 */
export async function sendHeld(
  node: Task, nodeName: string, tasks: readonly Task[], sentThisPass: Set<string>, deps: HeldDeps, nowMs: number,
): Promise<number> {
  // Taken out under the lock: what is too old goes, the rest waits by task.
  const { held, old } = await updateReflectionState(node.id, (s: ReflectionState) => {
    const all = s.held ?? [];
    const old = all.filter((h) => nowMs - Date.parse(h.at) > HELD_MAX_AGE_MS);
    s.held = all.filter((h) => !old.includes(h));
    return { held: s.held.slice(), old };
  }, nowMs);
  for (const date of new Set(old.map((h) => h.date))) {
    const n = old.filter((h) => h.date === date).length;
    await appendDayNote(node.id, nodeName, date, `Held corrections dropped: ${n} waited over ${HELD_MAX_AGE_MS / 3600_000} hours for a send and were not sent (the session has moved on).`, nowMs).catch(() => {});
  }
  let sent = 0;
  for (const taskId of new Set(held.map((h) => h.taskId))) {
    if (sentThisPass.has(taskId)) continue;
    const items = held.filter((h) => h.taskId === taskId);
    const task = taskId === node.id ? node : tasks.find((t) => t.id === taskId);
    const check = task ? await deps.confirmSend(node, task, await sessionNowOf(task, deps).catch(() => '')).catch(() => false) : 'gone';
    const ok = check === true || check === 'ok' || check === 'session_changed';
    // No session now: kept for a later pass. Done, gone or not the node's any more: dropped.
    if (!ok) { if (check !== 'no_session') await forget(node.id, items, nowMs); continue; }
    if (isChat(task!) && !(await takeChatSend(task!.id, nowMs))) continue;
    const went = await deps.send(task!, heldText(node.id, nodeName, items), `${nodeName}'s reflection: ${items.length} held correction${items.length === 1 ? '' : 's'}`).catch(() => false);
    if (!went) continue;
    sent++;
    sentThisPass.add(taskId);
    await forget(node.id, items, nowMs);
    for (const date of new Set(items.map((h) => h.date))) {
      const of = items.filter((h) => h.date === date);
      await markSentLater(node.id, nodeName, date, taskId, of.map((h) => h.entryAt), nowMs).catch(() => {});
      await appendDayNote(node.id, nodeName, date, `Sent later: ${of.length} held correction${of.length === 1 ? '' : 's'} to ${task!.title} (${taskId}) at ${new Date(nowMs).toISOString().slice(11, 16)} UTC, in one message.`, nowMs).catch(() => {});
    }
    log.task.info('reflection: held corrections sent', { nodeId: node.id, taskId, count: items.length, day: localDate(nowMs) });
  }
  return sent;
}

async function forget(nodeId: string, items: readonly HeldCorrection[], nowMs: number): Promise<void> {
  const gone = new Set(items.map((h) => `${h.taskId}|${h.entryAt}|${h.text}`));
  await updateReflectionState(nodeId, (s) => { s.held = (s.held ?? []).filter((h) => !gone.has(`${h.taskId}|${h.entryAt}|${h.text}`)); }, nowMs);
}
