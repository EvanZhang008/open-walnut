/**
 * Where the user's unanswered messages to a task live (user-asks-model.ts says why and how they
 * close): one JSON file per task at `WALNUT_HOME/user-asks/<taskId>.json`, written under the file
 * lock. Only the leader keeps them; a companion files and reads none.
 *
 * Main and the VPs are left out: their Threads (org/threads-model.ts) already file every message
 * of his. So is a plugin's own task.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import type { Task } from '../types.js';
import {
  addAsk, applyOwed, asksToJudge, closeAll, MAX_ASK_STOP_NUDGES, normalizeUserAsks, openAsks, OWED_WAKE_MS, owedQuestionBlock,
  owedReadback, owedStopReason, owedWakeBody, prune, readOwedLine, recentWordsReadback, staleOwed, type UserAsk, type UserAsksFile,
} from './user-asks-model.js';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const dir = () => path.join(WALNUT_HOME, 'user-asks');

function fileOf(taskId: string): string | null {
  return TASK_ID_RE.test(taskId) ? path.join(dir(), `${taskId}.json`) : null;
}

async function companion(): Promise<boolean> {
  const { isCompanion } = await import('../server-role.js');
  return isCompanion();
}

export async function readUserAsks(taskId: string): Promise<UserAsksFile> {
  const file = fileOf(taskId);
  if (!file || await companion()) return normalizeUserAsks(null, taskId);
  return normalizeUserAsks(await readJsonFile<unknown>(file, null), taskId);
}

async function mutate(taskId: string, fn: (cur: UserAsksFile) => UserAsksFile): Promise<UserAsksFile | null> {
  const file = fileOf(taskId);
  if (!file || await companion()) return null;
  let out: UserAsksFile | null = null;
  await updateJsonFile<unknown>(file, null, (raw) => {
    out = fn(normalizeUserAsks(raw, taskId));
    return out;
  });
  return out;
}

/** A task whose chat Walnut files the user's messages for. */
export function filesUserAsks(task: Pick<Task, 'org_role' | 'plugin_only'> | null | undefined): boolean {
  return !!task && task.org_role !== 'main' && task.org_role !== 'lead' && !task.plugin_only;
}

export interface UserAskCapture {
  /** File it. Call after the text is safely queued. Never throws. */
  commit(): Promise<void>;
}

/** Plan filing the user's words in this message to `task`'s chat; null when there are none to file. */
export async function prepareUserAskCapture(input: {
  task: Pick<Task, 'id' | 'org_role' | 'plugin_only' | 'phase'> | null | undefined;
  message: string;
  inChat: boolean;
  sid?: string;
  key?: string;
  now?: number;
}): Promise<UserAskCapture | null> {
  const task = input.task;
  if (!task || !filesUserAsks(task)) return null;
  const { userWordsOf } = await import('../org/thread-capture.js');
  const words = userWordsOf(input.message, { inChat: input.inChat });
  if (!words || (!words.text && !words.images.length)) return null;
  const at = new Date(input.now ?? Date.now()).toISOString();
  return {
    async commit() {
      try {
        await mutate(task.id, (cur) => addAsk(cur, {
          id: `ua-${randomBytes(4).toString('hex')}`, at, text: words.text, via: words.via === 'letter' ? 'letter' : 'chat',
          ...(words.images.length ? { images: words.images } : {}),
          ...(words.about ? { about: words.about } : {}),
          ...(input.sid ? { sid: input.sid } : {}),
          ...(input.key ? { key: input.key } : {}),
        }).file);
      } catch (err) {
        log.session.warn('user asks: message not filed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/**
 * What the turn-end status question adds for `taskId`, with the ids it lists. `seenBy`: only asks
 * filed by then (the turn's end): one he sent while the question waited is for the next turn, and
 * a session that never saw it would call it answered. Never throws.
 */
export async function owedQuestionFor(taskId: string, nowMs = Date.now(), seenBy = nowMs): Promise<{ block: string; listed: string[] }> {
  try {
    const asks = asksToJudge(await readUserAsks(taskId)).filter((a) => Date.parse(a.at) <= seenBy);
    return { block: owedQuestionBlock(asks, nowMs), listed: asks.map((a) => a.id) };
  } catch {
    return { block: '', listed: [] };
  }
}

/** Record the status answer's FOR_USER_OWED verdict on the asks it was shown. Never throws. */
export async function applyOwedAnswer(taskId: string, listed: readonly string[], answer: string, at = new Date().toISOString()): Promise<string[]> {
  if (!listed.length) return [];
  const owed = readOwedLine(answer);
  if (!owed) return [];
  let closed: string[] = [];
  try {
    await mutate(taskId, (cur) => {
      const r = applyOwed(cur, listed, owed, at);
      closed = r.closed;
      return r.file;
    });
    if (closed.length) log.session.info('user asks: answered', { taskId, closed });
  } catch (err) {
    log.session.warn('user asks: verdict not recorded', { taskId, error: err instanceof Error ? err.message : String(err) });
  }
  return closed;
}

/** The task completed: nothing of its chat is owed any more. */
export async function closeUserAsks(taskId: string): Promise<void> {
  const cur = await readUserAsks(taskId).catch(() => null);
  if (!cur || !openAsks(cur).length) return;
  await mutate(taskId, (f) => prune(closeAll(f, 'complete', new Date().toISOString()), Date.now())).catch(() => null);
}

/** The readback after a compaction (open-items.ts). '' when nothing is owed. Never throws. */
export async function owedReadbackFor(task: Pick<Task, 'id' | 'org_role' | 'plugin_only' | 'phase'>, nowMs = Date.now()): Promise<string> {
  if (!filesUserAsks(task) || task.phase === 'COMPLETE') return '';
  try {
    return owedReadback(openAsks(await readUserAsks(task.id)), nowMs);
  } catch {
    return '';
  }
}

/** The readback after a compaction of his recent words, answered ones too (user-asks-model.ts). '' when none. Never throws. */
export async function recentWordsReadbackFor(task: Pick<Task, 'id' | 'org_role' | 'plugin_only' | 'phase'>, nowMs = Date.now()): Promise<string> {
  if (!filesUserAsks(task) || task.phase === 'COMPLETE') return '';
  try {
    return recentWordsReadback(await readUserAsks(task.id), nowMs);
  } catch {
    return '';
  }
}

/** Stale owed asks of these tasks, for a lead's team note. Never throws. */
export async function staleOwedOf(tasks: readonly Pick<Task, 'id' | 'org_role' | 'plugin_only' | 'phase'>[], nowMs = Date.now()): Promise<Map<string, UserAsk[]>> {
  const out = new Map<string, UserAsk[]>();
  let names: Set<string>;
  try {
    names = new Set(await fs.readdir(dir()));
  } catch {
    return out;
  }
  for (const t of tasks) {
    if (!filesUserAsks(t) || t.phase === 'COMPLETE' || !names.has(`${t.id}.json`)) continue;
    const stale = staleOwed(await readUserAsks(t.id).catch(() => normalizeUserAsks(null, t.id)), nowMs);
    if (stale.length) out.set(t.id, stale);
  }
  return out;
}

/** The task waits on the user's answer to its own question: an ask of his it owes is his move now. */
function waitsOnUser(task: Pick<Task, 'user_status'>): boolean {
  return task.user_status?.state === 'needs' && !!task.user_status.ask;
}

/** Owed this long, the Stop hook names it even with no compaction since. */
const STOP_NAMES_OLD_MS = 2 * 3600_000;

/**
 * The Stop hook's words for asks this session's task has owed a while, or null. Only an ask the
 * session may have lost (a compaction since he wrote, or owed for hours): a turn that is just now
 * giving the answer is not held for it. Each ask is named at most MAX_ASK_STOP_NUDGES times;
 * never while its own work runs on, it parked, or it waits on his answer to its own question.
 * Never throws.
 */
export async function owedAtStop(callerSid: string | undefined, nowMs = Date.now()): Promise<{ reason: string; asks: string[] } | null> {
  const sid = (callerSid ?? '').trim();
  if (!sid || await companion().catch(() => true)) return null;
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sid).catch(() => null);
    const taskId = record?.taskId;
    if (!taskId) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([taskId]).catch(() => []))[0];
    if (!task || !filesUserAsks(task) || task.phase === 'COMPLETE' || waitsOnUser(task)) return null;
    const compactedAt = Date.parse(record?.lastCompactAt ?? '');
    const named = staleOwed(await readUserAsks(taskId), nowMs)
      .filter((a) => (a.nudges ?? 0) < MAX_ASK_STOP_NUDGES)
      .filter((a) => compactedAt > Date.parse(a.at) || nowMs - Date.parse(a.at) >= STOP_NAMES_OLD_MS)
      .slice(-5);
    if (!named.length) return null;
    const { progressReason } = await import('./request-progress.js');
    if (await progressReason({ sessionId: sid, taskId, phase: task.phase })) return null;
    const ids = new Set(named.map((a) => a.id));
    await mutate(taskId, (cur) => ({ ...cur, asks: cur.asks.map((a) => (ids.has(a.id) ? { ...a, nudges: (a.nudges ?? 0) + 1 } : a)) }));
    return { reason: owedStopReason(named, nowMs), asks: [...ids] };
  } catch {
    return null;
  }
}

/**
 * One pass: a session with no turn running whose task still owes the user an answer for
 * OWED_WAKE_MS is woken once about it, a stopped one too (the user waits; a reaped session is how
 * the 2026-11-03 question went unanswered for seven hours). Not a task that parked itself, a
 * snoozed one, one waiting on his answer to its own question, or a session in error. Returns the
 * woken task ids.
 */
export async function wakeIdleOwed(nowMs = Date.now()): Promise<string[]> {
  const woken: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(dir())).filter((n) => n.endsWith('.json'));
  } catch {
    return woken;
  }
  const { listTasksByIds } = await import('../task-manager.js');
  const tasks = await listTasksByIds(names.map((n) => n.slice(0, -5))).catch(() => [] as Task[]);
  for (const task of tasks) {
    try {
      if (!filesUserAsks(task) || task.phase === 'COMPLETE' || task.phase === 'WAITING' || task.user_status?.snoozed || waitsOnUser(task)) continue;
      const due = openAsks(await readUserAsks(task.id)).filter((a) => a.owedAt && !a.wokenAt && nowMs - Date.parse(a.owedAt) >= OWED_WAKE_MS);
      if (!due.length) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
      if (!target || target.process_status === 'running' || target.process_status === 'error') continue;
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      if (sessionRunner.isTurnRunning(target.claudeSessionId)) continue;
      const at = new Date(nowMs).toISOString();
      const ids = new Set(due.map((a) => a.id));
      // Recorded first: a failed wake never repeats every pass.
      await mutate(task.id, (cur) => ({ ...cur, asks: cur.asks.map((a) => (ids.has(a.id) ? { ...a, wokenAt: at } : a)) }));
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('../session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
      await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
        kind: 'trigger',
        attrs: { from: 'Walnut: unanswered', note: 'the user still waits for your answer' },
        body: owedWakeBody(due, nowMs),
      }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id });
      woken.push(task.id);
      log.session.info('user asks: idle session woken', { taskId: task.id, sessionId: target.claudeSessionId, asks: [...ids] });
    } catch (err) {
      log.session.warn('user asks: wake failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return woken;
}

const WAKE_INTERVAL_MS = 5 * 60_000;
let live = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** On the primary: a completion closes the task's asks, and idle owed asks wake their session once. */
export async function startUserAsks(opts: { ephemeral?: boolean } = {}): Promise<{ stop(): void }> {
  if (live || process.env.WALNUT_USER_ASKS === '0') return { stop: () => {} };
  live = true;
  const { bus, EventNames } = await import('../event-bus.js');
  bus.subscribe('user-asks', (event) => {
    const data = event.data as { task?: Task; newPhase?: string } | undefined;
    if (data?.newPhase === 'COMPLETE' && data.task?.id) void closeUserAsks(data.task.id);
  }, { global: true, interest: [EventNames.TASK_PHASE_CHANGED] });
  // An ephemeral server's copied asks are someone else's: it wakes nobody about them.
  if (!opts.ephemeral || process.env.WALNUT_USER_ASKS === '1') {
    timer = setInterval(() => { void wakeIdleOwed().catch(() => {}); }, WAKE_INTERVAL_MS);
    timer.unref?.();
  }
  return {
    stop: () => {
      live = false;
      if (timer) clearInterval(timer);
      timer = null;
      bus.unsubscribe('user-asks');
    },
  };
}
