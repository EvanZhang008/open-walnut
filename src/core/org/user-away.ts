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

/** Last attention heartbeat per task id and per session id. */
const seen = new Map<string, number>();
const SUBSCRIBER = 'org-user-away';

export function noteSeen(key: string, at: number): void {
  if (!key || !Number.isFinite(at)) return;
  if ((seen.get(key) ?? 0) < at) seen.set(key, at);
}

function onBanked(event: BusEvent): void {
  const data = eventData<typeof EventNames.TIME_BANKED>(event) as TimeBankedEvent | undefined;
  for (const r of data?.records ?? []) {
    const end = Date.parse(r.ts) + (Number.isFinite(r.durationMs) ? r.durationMs : 0);
    if (!Number.isFinite(end)) continue;
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

/** The node's state now; null for a task that is not Main or a lead, or on any failure. */
export async function userAwayFrom(task: Pick<Task, 'id' | 'org_role'> | null | undefined, now = Date.now()): Promise<AwayState | null> {
  if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) return null;
  try {
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

/** Test seam. */
export function _resetUserAwayForTest(): void {
  seen.clear();
}
