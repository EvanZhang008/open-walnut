/**
 * Is the user in an org node's chat, or away from it?
 *
 * 2026-10-31, the user before going to sleep: when "I am not chatting with you here", an important
 * update goes to the inbox, not into a chat nobody reads. Main and every lead are told so with the
 * `user-away` message hint (hints/hint-registry.ts), and their letters of one absence share one
 * thread (human-inbox/away-thread.ts).
 *
 * The user was last in a node's chat at the latest of:
 *  - a message a person typed into its chat (`SessionRecord.chatInputAt`, persisted; an answer from
 *    the inbox is not one: he can tap a decision at 3am and still be away);
 *  - an attention heartbeat of the web console or the phone naming the task or one of its sessions
 *    (`time:banked`, kept here in memory: the chat was open and in use);
 * and is in it now while the phone streams one of its sessions (an open session screen).
 * Away = not in it now and not there for AWAY_AFTER_MS. Never seen = away, with no `since`.
 */
import { bus, eventData, EventNames, type BusEvent } from '../event-bus.js';
import type { TimeBankedEvent } from '../event-types.js';
import type { SessionRecord, Task } from '../types.js';
import { keepsThreads } from './keeps-threads.js';

/** How long without the user before a node counts him away. `WALNUT_AWAY_AFTER_MINUTES` overrides. */
export const AWAY_AFTER_MS = 30 * 60_000;

export function awayAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.WALNUT_AWAY_AFTER_MINUTES);
  return Number.isFinite(m) && m > 0 ? m * 60_000 : AWAY_AFTER_MS;
}

export interface AwayState {
  away: boolean;
  /** When the user was last in this chat (epoch ms); null = never seen here. */
  lastSeenAt: number | null;
}

/** Last attention heartbeat per task id and per session id, and of any screen (ANY). */
const seen = new Map<string, number>();
const SUBSCRIBER = 'org-user-away';
/**
 * Any human heartbeat, with or without a task: the phone app open on its Inbox or Home tab, the
 * console's inbox or chat. Only "seen anywhere" (userActivityAnywhere) reads it, never a node's own
 * away state (2026-11-25: a held approval waited for him while the phone app was open on Inbox).
 */
const ANY = 'any';

export function noteSeen(key: string, at: number): void {
  if (!key || !Number.isFinite(at)) return;
  if ((seen.get(key) ?? 0) < at) seen.set(key, at);
}

function onBanked(event: BusEvent): void {
  const data = eventData<typeof EventNames.TIME_BANKED>(event) as TimeBankedEvent | undefined;
  for (const r of data?.records ?? []) {
    const end = Date.parse(r.ts) + (Number.isFinite(r.durationMs) ? r.durationMs : 0);
    if (!Number.isFinite(end)) continue;
    noteSeen(ANY, end);
    if (r.taskId) noteSeen(`task:${r.taskId}`, end);
    if (r.sessionId) noteSeen(`session:${r.sessionId}`, end);
  }
}

export function startUserAway(): void {
  bus.subscribe(SUBSCRIBER, onBanked, { global: true, interest: [EventNames.TIME_BANKED] });
}

export function stopUserAway(): void {
  bus.unsubscribe(SUBSCRIBER);
  seen.clear();
}

/** Pure: the state from what is known. `streaming` = a session screen of it is open on the phone now. */
export function awayStateOf(input: {
  taskId: string;
  sessions: readonly Pick<SessionRecord, 'claudeSessionId' | 'chatInputAt'>[];
  heartbeats: ReadonlyMap<string, number>;
  streaming: boolean;
  now: number;
  afterMs: number;
}): AwayState {
  let last = input.heartbeats.get(`task:${input.taskId}`) ?? 0;
  for (const s of input.sessions) {
    const typed = s.chatInputAt ? Date.parse(s.chatInputAt) : NaN;
    if (Number.isFinite(typed) && typed > last) last = typed;
    const hb = input.heartbeats.get(`session:${s.claudeSessionId}`) ?? 0;
    if (hb > last) last = hb;
  }
  const lastSeenAt = last > 0 ? Math.min(last, input.now) : null;
  if (input.streaming) return { away: false, lastSeenAt: input.now };
  return { away: lastSeenAt === null || input.now - lastSeenAt >= input.afterMs, lastSeenAt };
}

/** The node's state now; null for a task that keeps no Threads (keeps-threads.ts), or on any failure. */
export async function userAwayFrom(task: (Pick<Task, 'id' | 'org_role'> & { threads_on?: boolean }) | null | undefined, now = Date.now()): Promise<AwayState | null> {
  if (!task || !keepsThreads(task)) return null;
  try {
    // The org is off (org-enabled.ts): no away hint, no away thread, no away report for Main or a
    // lead. A task the user turned Threads on for is no part of the org: its own switch rules it.
    if (task.org_role) {
      const { isOrgEnabled } = await import('./org-enabled.js');
      if (!(await isOrgEnabled())) return null;
    }
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sessions = await getSessionsForTask(task.id);
    let streaming = false;
    try {
      const { sseConnCount } = await import('../../web/sse-channels.js');
      streaming = sessions.some((s) => sseConnCount(`session:${s.claudeSessionId}`) > 0);
    } catch { /* no web server in this process */ }
    return awayStateOf({ taskId: task.id, sessions, heartbeats: seen, streaming, now, afterMs: awayAfterMs() });
  } catch {
    return null;
  }
}

/**
 * Whether a person is in this task's chat now or was within `withinMs`, for ANY task, org node or
 * not (sessions/live-sessions.ts keeps such a session's process alive). The same signals as
 * userAwayFrom: what he typed there, the attention heartbeats, a phone streaming one of its sessions.
 */
export async function userInTaskChat(
  taskId: string | undefined, sessions: readonly Pick<SessionRecord, 'claudeSessionId' | 'chatInputAt'>[],
  withinMs: number, now = Date.now(),
): Promise<boolean> {
  let streaming = false;
  try {
    const { sseConnCount } = await import('../../web/sse-channels.js');
    streaming = sessions.some((s) => sseConnCount(`session:${s.claudeSessionId}`) > 0);
  } catch { /* no web server in this process */ }
  return !awayStateOf({ taskId: taskId ?? '', sessions, heartbeats: seen, streaming, now, afterMs: withinMs }).away;
}

/**
 * The person's latest activity anywhere in Walnut, from the same signals: what he typed in any chat
 * (`chatInputAt` of `sessions`) and any attention heartbeat; `streaming` = a phone streams one of
 * `sessions` now (he is looking, though not doing anything new).
 */
export async function userActivityAnywhere(
  sessions: readonly Pick<SessionRecord, 'claudeSessionId' | 'chatInputAt'>[], now = Date.now(),
): Promise<{ lastSeenAt: number | null; streaming: boolean }> {
  // Imported first, so `sessions` (a store view) is read in one synchronous pass, never across an await.
  let count: ((key: string) => number) | null = null;
  try { count = (await import('../../web/sse-channels.js')).sseConnCount; } catch { /* no web server in this process */ }
  let last = 0;
  for (const at of seen.values()) if (at > last) last = at;
  let streaming = false;
  for (const s of sessions) {
    const typed = s.chatInputAt ? Date.parse(s.chatInputAt) : NaN;
    if (Number.isFinite(typed) && typed > last) last = typed;
    if (!streaming && count && count(`session:${s.claudeSessionId}`) > 0) streaming = true;
  }
  return { lastSeenAt: last > 0 ? Math.min(last, now) : null, streaming };
}

/** Test seam. */
export function _resetUserAwayForTest(): void {
  seen.clear();
}
