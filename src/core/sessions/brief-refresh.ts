/**
 * One refresh turn for Main or a lead whose Brief is stale, when the user opens it (2026-10-31,
 * the user on a VP whose chat and Brief were 3.5 hours old while its team moved: "我们还是没有一个
 * 方法能够去让这个 VP 能够有 latest status").
 *
 * A status move is pushed to a node only while its turn runs (status-push.ts), so an idle or parked
 * node keeps the words of its last turn. Waking every node on every move would cost a turn per
 * move; the user reads a node only when he opens it. So the opening is the clock: the web console
 * (the Mac app too) asks when a node's Task or Brief view on the Org page has been shown a few
 * seconds, the phone when it opens the node's session stream or reports attention on it (a web
 * heartbeat is not a look: the console's chat columns send them too, and a refresh would cut into
 * a chat the user is reading). Walnut sends ONE note into the node's session when:
 *  - its Brief is stale (brief-fresh.ts: a line moved, or a new ask it does not name);
 *  - no refresh went in for BRIEF_REFRESH_GAP_MS (recorded on the task first, so a failed send or a
 *    restart never repeats it sooner);
 *  - no turn of it runs now (that turn hears the moves as they happen), it is not complete, its
 *    team is not stopped and it is not snoozed;
 *  - the request is not a test run on the real Walnut (the route answers those itself).
 * Its turn updates the Brief itself (brief_write) and tells the user in the chat only the Needs you
 * items that changed since the last refresh told it (new, asking something else, gone; `told` on
 * the record; an ask in other words is no change); with none, it ends with the agent-ack line, so his chat does not repeat an unchanged list. The
 * page says "Updating" until the new letter lands (briefUpdating), never after a failed send. A
 * parked node comes back to its wait at that turn's end, clock included (task-wait-resume.ts).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { agoWords, needsLineText, storedUserState } from '../user-status.js';
import { briefFreshness, type BriefFreshness, type BriefRefreshRecord } from './brief-fresh.js';
import { briefNeedsAsks } from './brief.js';
import { sameAskReworded } from '../same-ask.js';

/** At most one refresh turn per node in this long. */
export const BRIEF_REFRESH_GAP_MS = 15 * 60_000;
/** The send source of a refresh note: an interruption of a wait, never the thing it waits on. */
export const BRIEF_REFRESH_SOURCE = 'brief-refresh';

export type BriefRefreshSkip =
  | 'not_org_node' | 'complete' | 'no_brief' | 'fresh' | 'recent' | 'running'
  | 'no_session' | 'team_stopped' | 'snoozed' | 'in_flight' | 'not_delivered' | 'not_found' | 'org_off';

export interface BriefRefreshResult {
  sent: boolean;
  why?: BriefRefreshSkip;
  sessionId?: string;
  /** Lines moved plus new asks, when judged. */
  moved?: number;
}

/** Whether a node is due a refresh turn now, from its task and the live tasks. Pure. */
export function briefRefreshDue(owner: Task, tasks: readonly Task[], opts: { now: number; running: boolean; quieted?: boolean }):
  { due: true; fresh: BriefFreshness } | { due: false; why: BriefRefreshSkip } {
  if (owner.org_role !== 'main' && owner.org_role !== 'lead') return { due: false, why: 'not_org_node' };
  if (owner.phase === 'COMPLETE' || owner.status === 'done') return { due: false, why: 'complete' };
  if (opts.quieted) return { due: false, why: 'team_stopped' };
  if (owner.user_status?.snoozed) return { due: false, why: 'snoozed' };
  if (!owner.brief?.text) return { due: false, why: 'no_brief' };
  const last = Date.parse(owner.brief_refresh?.at ?? '');
  if (Number.isFinite(last) && opts.now - last < BRIEF_REFRESH_GAP_MS) return { due: false, why: 'recent' };
  if (opts.running) return { due: false, why: 'running' };
  const fresh = briefFreshness(owner, tasks);
  if (!fresh?.stale) return { due: false, why: 'fresh' };
  return { due: true, fresh };
}

/** The note the refresh brings into the node's session. */
export function refreshBody(owner: Task, fresh: BriefFreshness, tasks: readonly Task[], now: number,
  changes: readonly NeedsChange[] = needsChanges(briefNeedsAsks(owner, tasks), owner.brief_refresh?.told)): string {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const name = (id: string) => `"${(byId.get(id)?.title ?? id).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 80)}" (${id})`;
  const at = Date.parse(fresh.writtenAt);
  const lines = [
    `The user is looking at you now (the Org page or the phone). Your Brief was written ${Number.isFinite(at) ? agoWords(now - at) : 'a while ago'}, and since then (Walnut's live record):`,
    ...fresh.moved.slice(0, 12).map((m) => `- ${name(m.id)}: now ${m.state === 'done' ? 'Completed' : m.state === 'needs' || m.state === 'read' ? 'Needs you' : m.state === 'working' ? 'Working' : 'Waiting'}: ${m.words}`),
    ...(fresh.moved.length > 12 ? [`- and ${fresh.moved.length - 12} more lines moved`] : []),
    ...fresh.finished.slice(0, 8).map((id) => `- ${name(id)}: completed`),
    ...(fresh.finished.length > 8 ? [`- and ${fresh.finished.length - 8} more completed`] : []),
    ...fresh.newAsks.slice(0, 8).map((id) => {
      const s = byId.get(id)?.user_status;
      // A result or an answer for the user is no ask of them (it reads under Needs you all the same).
      if (s && storedUserState(s) === 'read') return `- ${name(id)} now has something for the user to look at: "${needsLineText(s).slice(0, 200)}" (not in your Brief)`;
      return `- ${name(id)} now asks the user: "${(s?.ask ?? '').replace(/\s+/g, ' ').slice(0, 200)}" (not in your Brief)`;
    }),
    ...(fresh.newAsks.length > 8 ? [`- and ${fresh.newAsks.length - 8} more new asks`] : []),
    ...needsLines(changes, name),
    changes.length
      ? 'Bring what the user reads up to date: check what you must (task_get on a task above), then update your Brief with brief_write, tell him in your chat in a few short lines only the Needs you changes above (new, now asking something else, no longer needed), never again an ask he was already told and that did not change, and end the turn. This is a refresh: act on something only when it is yours to act on now.'
      : 'Nothing that needs the user changed since you last told him: do not repeat his Needs you list. Check what you must (task_get on a task above), update your Brief with brief_write, and end the turn with only the agent-ack line, <walnut-turn status="agent-ack"/>, so nothing new shows in his chat. This is a refresh: act on something only when it is yours to act on now.',
    // 2026-11-04: three VPs each told the user "nothing changed, only reworded" at a refresh.
    'When your Brief has no real change for the user (an ask in other words is no change), the agent-ack line is your whole answer: never tell him "no change" or "only reworded".',
  ];
  return lines.join('\n');
}

export interface NeedsChange { id: string; kind: 'new' | 'changed' | 'gone'; ask: string }

/**
 * What needs the user changed since the last refresh told the node (2026-11-02 org review: a lead
 * repeated the same three asks at three refreshes with nothing changed). With no earlier note,
 * every ask is new. The same ask in other words is no change (sameAskReworded; 2026-11-04: three
 * VPs each told the user "nothing changed, only reworded"). Pure.
 */
export function needsChanges(now: Record<string, string>, told: Record<string, string> | undefined): NeedsChange[] {
  const out: NeedsChange[] = [];
  for (const [id, ask] of Object.entries(now)) {
    if (!told || !(id in told)) out.push({ id, kind: 'new', ask });
    else if (told[id] !== ask && !sameAskReworded(told[id], ask)) out.push({ id, kind: 'changed', ask });
  }
  for (const [id, ask] of Object.entries(told ?? {})) if (!(id in now)) out.push({ id, kind: 'gone', ask });
  return out;
}

function needsLines(changes: readonly NeedsChange[], name: (id: string) => string): string[] {
  if (!changes.length) return [];
  const word = { new: 'new', changed: 'now asks something else', gone: 'no longer needs him' } as const;
  return [
    'Needs you, changed since you last told him:',
    ...changes.slice(0, 12).map((c) => `- ${name(c.id)}: ${word[c.kind]}${c.kind === 'gone' ? '' : `: "${c.ask}"`}`),
    ...(changes.length > 12 ? [`- and ${changes.length - 12} more`] : []),
  ];
}

const inFlight = new Set<string>();

/** Ask one refresh turn of a node the user is looking at, when it is due. Never throws. */
export async function requestBriefRefresh(taskId: string, by: BriefRefreshRecord['by'], now = Date.now()): Promise<BriefRefreshResult> {
  if (inFlight.has(taskId)) return { sent: false, why: 'in_flight' };
  // The org is off (org/org-enabled.ts): no node is asked for a refresh turn.
  const { isOrgEnabled } = await import('../org/org-enabled.js');
  if (!(await isOrgEnabled())) return { sent: false, why: 'org_off' };
  inFlight.add(taskId);
  try {
    const { getTask, listTasks, updateTaskRaw } = await import('../task-manager.js');
    const owner = await getTask(taskId).catch(() => null);
    if (!owner) return { sent: false, why: 'not_found' };
    // Cheap answers first: a phone stream opens any session, most of them no org node's.
    if (owner.org_role !== 'main' && owner.org_role !== 'lead') return { sent: false, why: 'not_org_node' };
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sessions = await getSessionsForTask(taskId).catch(() => []);
    const running = sessions.some((s) => !s.archived && s.process_status === 'running');
    const tasks = await listTasks();
    const quieted = tasks.some((t) => t.team_stop?.members?.some((m) => m.id === taskId));
    const decision = briefRefreshDue(owner, tasks, { now, running, quieted });
    if (!decision.due) return { sent: false, why: decision.why };
    const { pickDeliverySession } = await import('../routines/session-target.js');
    const target = pickDeliverySession(sessions);
    if (!target) return { sent: false, why: 'no_session' };
    const moved = decision.fresh.moved.length + decision.fresh.finished.length + decision.fresh.newAsks.length;
    const needs = briefNeedsAsks(owner, tasks);
    const changes = needsChanges(needs, owner.brief_refresh?.told);
    // What this note hands the node is what it has told him once the turn ends; a failed send keeps
    // the earlier list, so the next note still names these changes.
    const record: BriefRefreshRecord = { at: new Date(now).toISOString(), by, moved, told: needs };
    // Recorded first, under the row lock: two windows asking at once send one note, and a failed
    // send never repeats sooner than the gap.
    let claimed = false;
    await updateTaskRaw(taskId, { brief_refresh: record }, {
      emitEvent: true, source: 'brief-refresh',
      shouldUpdate: (current) => {
        const last = Date.parse(current.brief_refresh?.at ?? '');
        claimed = !(Number.isFinite(last) && now - last < BRIEF_REFRESH_GAP_MS);
        return claimed;
      },
    });
    if (!claimed) return { sent: false, why: 'recent' };
    const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
    const { sendMessageToSession } = await import('../session-message-queue.js');
    try {
      await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
        kind: 'trigger',
        attrs: { from: 'Walnut: Brief refresh', note: 'the user is looking at you now' },
        body: refreshBody(owner, decision.fresh, tasks, now, changes),
      }), { source: BRIEF_REFRESH_SOURCE, taskId });
    } catch (err) {
      log.task.warn('brief refresh not delivered', { taskId, sessionId: target.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
      // Kept, so the gap still holds; marked, so the page does not say it is updating.
      await updateTaskRaw(taskId, (current) => (current.brief_refresh?.at === record.at
        ? { brief_refresh: { ...record, failed: true, ...(owner.brief_refresh?.told ? { told: owner.brief_refresh.told } : { told: undefined }) } } : null), { source: 'brief-refresh' }).catch(() => null);
      return { sent: false, why: 'not_delivered', sessionId: target.claudeSessionId, moved };
    }
    log.task.info('brief refresh sent', { taskId, sessionId: target.claudeSessionId, by, moved });
    return { sent: true, sessionId: target.claudeSessionId, moved };
  } catch (err) {
    log.task.warn('brief refresh failed', { taskId, error: err instanceof Error ? err.message : String(err) });
    return { sent: false, why: 'not_delivered' };
  } finally {
    inFlight.delete(taskId);
  }
}

// ── The phone's and the console's attention heartbeats (time:banked) as "he is looking" ──

/** A heartbeat about a time this long ago or more is not "looking now". */
const LOOKING_MS = 3 * 60_000;
/** One look per task or session key is judged at most this often (heartbeats come in bursts). */
const LOOK_CHECK_MS = 60_000;
const SUBSCRIBER = 'brief-refresh-looks';
const lastLook = new Map<string, number>();

async function onLook(record: { ts: string; durationMs: number; source?: string; taskId?: string; sessionId?: string }, now: number): Promise<void> {
  if (record.source !== 'ios') return;
  const end = Date.parse(record.ts) + (Number.isFinite(record.durationMs) ? record.durationMs : 0);
  if (!Number.isFinite(end) || now - end > LOOKING_MS) return;
  const key = record.taskId ? `task:${record.taskId}` : record.sessionId ? `session:${record.sessionId}` : '';
  if (!key || now - (lastLook.get(key) ?? 0) < LOOK_CHECK_MS) return;
  lastLook.set(key, now);
  if (lastLook.size > 500) for (const [k, at] of lastLook) if (now - at > LOOK_CHECK_MS) lastLook.delete(k);
  let taskId = record.taskId;
  if (!taskId && record.sessionId) {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    taskId = (await getSessionByClaudeId(record.sessionId).catch(() => null))?.taskId;
  }
  if (taskId) await requestBriefRefresh(taskId, 'phone', now);
}

/** Primary only: the phone's attention on a node is a look. */
export async function startBriefRefreshLooks(): Promise<void> {
  const { bus, eventData, EventNames } = await import('../event-bus.js');
  bus.subscribe(SUBSCRIBER, (event) => {
    const data = eventData<typeof EventNames.TIME_BANKED>(event) as { records?: Parameters<typeof onLook>[0][] } | undefined;
    const now = Date.now();
    for (const r of data?.records ?? []) void onLook(r, now).catch(() => {});
  }, { global: true, interest: [EventNames.TIME_BANKED] });
}

export async function stopBriefRefreshLooks(): Promise<void> {
  const { bus } = await import('../event-bus.js');
  bus.unsubscribe(SUBSCRIBER);
  lastLook.clear();
}
