/**
 * A completed task's own "please check this" letters leave the inbox.
 *
 * The user's rule (2026-10-27): a task that is closed was verified, mostly by
 * the user closing it, so nothing should still ask them to verify it. Its open
 * letters that only ask the user to look at, install or check that work (type
 * `review` or `completion`) are archived with the reason `task_completed`, never
 * deleted. A letter that needs the user's decision stays: `action_required`, a
 * letter carrying inbox items (mail to triage), an `info` letter (a report or
 * digest the user set up), and a pinned one. A reopen does not bring them back,
 * and a letter someone un-archived is never archived again.
 *
 * One more guard: unless a PERSON completed the task (a route call with no caller
 * session, a board bulk move, a sync of the user's own list), a letter the user has
 * never read stays, because then nobody has seen what it says yet: a session, a
 * triage run, an org handover or a plugin closing its task is not the user's check.
 * A letter whose last turn is the user's (a reply still waiting on the agent) stays.
 * The boot pass covers tasks completed since the last pass (all of them the first
 * time): it cannot tell who completed them, so it takes read letters only, and only
 * ones sent before the completion.
 *
 * A DECISION letter (`action_required`) of the completed task is settled instead, whoever
 * completed it, with a one-line reason (decision-settle.ts, settleOnCompletion): a completed task
 * waits on no answer. The re-check clock catches completions this missed (sessions/letter-recheck.ts).
 */

import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { LetterRecord } from './types.js';
import path from 'node:path';

const SUBSCRIBER = 'human-inbox-complete-archive';

export interface CompletionContext {
  /** Who completed it: a person (the web, the phone, a sync of the user's own list) or a session. */
  byPerson: boolean;
  /** Epoch ms of the completion, when known: letters sent after it are not about the closed work. */
  completedAtMs?: number;
}

/** Whether this letter goes to the archive now that its task `taskId` is complete. */
export function archivesOnCompletion(letter: LetterRecord, taskId: string, ctx: CompletionContext): boolean {
  if (letter.archived || letter.pinned) return false;
  if (letter.sender?.taskId !== taskId || letter.sender.pluginId) return false;
  if (letter.type !== 'review' && letter.type !== 'completion') return false;
  if (letter.items?.length || letter.actions?.length) return false;
  if (letter.thread?.length && letter.thread[letter.thread.length - 1].from === 'human') return false;
  // Someone brought it back from the archive (a person, or the agent's reply): leave it.
  if (letter.archivedAt !== undefined) return false;
  if (ctx.completedAtMs !== undefined && letter.createdAt > ctx.completedAtMs) return false;
  if (!ctx.byPerson && !letter.read) return false;
  return true;
}

/** The phase-event sources a person's completion carries: a route ('api'), a board bulk move, a sync pull. */
const PERSON_SOURCES = new Set(['api', 'bulk', 'sync']);

/** A completion a person made, read from the phase event: a person's source and no caller session. */
export function completedByPerson(event: { source?: string; actorSid?: string }): boolean {
  return !event.actorSid && PERSON_SOURCES.has(event.source ?? '');
}

async function archiveFor(tasks: Array<{ id: string; ctx: CompletionContext }>): Promise<string[]> {
  if (!tasks.length) return [];
  const { listLetters, archiveLettersWhere } = await import('./store.js');
  const byId = new Map(tasks.map((t) => [t.id, t.ctx]));
  const pick = (l: LetterRecord): boolean => {
    const tid = l.sender?.taskId;
    const ctx = tid ? byId.get(tid) : undefined;
    return !!ctx && archivesOnCompletion(l, tid!, ctx);
  };
  // Read first: most completions have no such letter, and those should not rewrite the store.
  const { letters } = await listLetters({ archived: false });
  if (!letters.some(pick)) return [];
  const ids = await archiveLettersWhere(pick, 'task_completed');
  if (ids.length) log.notif.info('human-inbox: archived letters of completed tasks', { taskIds: tasks.map((t) => t.id), letterIds: ids });
  return ids;
}

/** Archive the letters of one task that has just completed. */
export function onTaskCompleted(task: Pick<Task, 'id'>, ctx: CompletionContext): Promise<string[]> {
  return archiveFor([{ id: task.id, ctx }]);
}

/**
 * Settle the open decision letters of a task that has just completed, whoever completed it
 * (decision-settle.ts): a completed task waits on no answer.
 */
export async function settleOnCompletion(task: Pick<Task, 'id' | 'title' | 'completed_at' | 'agent_id'>): Promise<string[]> {
  const { listLetters, settleLettersWhere } = await import('./store.js');
  const { completionSettleReason } = await import('./decision-settle.js');
  const { letters } = await listLetters({ archived: false });
  if (!letters.some((l) => completionSettleReason(l, task))) return [];
  const done = await settleLettersWhere((l) => completionSettleReason(l, task));
  if (done.length) log.notif.info('human-inbox: settled decision letters of a completed task', { taskId: task.id, letters: done });
  return done.map((d) => d.id);
}

/** Where the boot pass keeps when it last ran (beside the letters). */
async function stampFile(): Promise<string> {
  const { humanInboxPaths } = await import('./store.js');
  return path.join(humanInboxPaths.dir, 'complete-archive.json');
}

/** Completions this close before the last pass are looked at again: a write racing that pass. */
const SWEEP_OVERLAP_MS = 5 * 60_000;

/** The boot pass: tasks completed since the last pass, while this was not listening. */
export async function sweepCompletedTasks(nowMs = Date.now()): Promise<string[]> {
  const { listTasks } = await import('../task-manager.js');
  const { readJsonFile, writeJsonFile } = await import('../../utils/fs.js');
  const file = await stampFile();
  const last = (await readJsonFile<{ sweptAt?: number }>(file, {})).sweptAt;
  const since = typeof last === 'number' ? last - SWEEP_OVERLAP_MS : -Infinity;
  const done = (await listTasks()).filter((t) => {
    if (t.phase !== 'COMPLETE') return false;
    const at = t.completed_at ? Date.parse(t.completed_at) : NaN;
    // No completion time on record: only the first pass takes it.
    return Number.isFinite(at) ? at >= since : since === -Infinity;
  });
  const ids = await archiveFor(done.map((t) => {
    const at = t.completed_at ? Date.parse(t.completed_at) : NaN;
    return { id: t.id, ctx: { byPerson: false, ...(Number.isFinite(at) ? { completedAtMs: at } : {}) } };
  }));
  await writeJsonFile(file, { sweptAt: nowMs });
  return ids;
}

function onEvent(event: BusEvent): void {
  if (event.name !== EventNames.TASK_PHASE_CHANGED) return;
  const data = event.data as { task?: Task; newPhase?: string; oldPhase?: string; source?: string; actorSid?: string } | undefined;
  if (!data?.task || data.newPhase !== 'COMPLETE' || data.oldPhase === 'COMPLETE') return;
  void onTaskCompleted(data.task, { byPerson: completedByPerson(data) })
    .catch((err) => log.notif.warn('human-inbox: archiving a completed task\'s letters failed', { taskId: data.task!.id, error: String(err) }));
  void settleOnCompletion(data.task)
    .catch((err) => log.notif.warn('human-inbox: settling a completed task\'s decision letters failed', { taskId: data.task!.id, error: String(err) }));
}

let live = false;

/** Leader only (wired beside the user-status sync). */
export function startCompleteArchive(): void {
  if (live) return;
  live = true;
  bus.subscribe(SUBSCRIBER, onEvent, { global: true, interest: [EventNames.TASK_PHASE_CHANGED] });
  void sweepCompletedTasks().catch((err) => log.notif.warn('human-inbox: boot pass over completed tasks failed', { error: String(err) }));
}

export function stopCompleteArchive(): void {
  if (!live) return;
  live = false;
  bus.unsubscribe(SUBSCRIBER);
}
