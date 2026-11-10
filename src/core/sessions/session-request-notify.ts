/**
 * Fallback notification for expect_reply requests — the "Walnut speaks when
 * the target didn't" half of the reply loop.
 *
 * Two triggers share this one function (and the atomic settle inside it):
 *   - the session-request-watch builtin hook, on the target task's phase edge
 *     (turn end / error / awaiting-human all land NEED_ACTION; a task the
 *     target closed lands COMPLETE) and on the turn end of a closed task;
 *   - the deadline sweeper (sweepSessionRequests), for targets whose edges
 *     never fired at all (edges here are HINTS: phases are flaky by design —
 *     stale-result gating, reconciler flips — the sweeper is the guarantee).
 *
 * settleNotified runs FIRST: the status transition must never wait on
 * delivery embellishment (title lookups, session reads) — and whoever loses
 * the settle race stays silent, so the asker hears exactly one voice.
 *
 * The notice quotes the target's last message (the turn result when the caller
 * has it, else the session's transcript, with the tool calls made after that
 * message), so a child that finished without replying still hands its result
 * over and the asker needs no task_history call.
 */

import { log } from '../../logging/index.js';
import { cutEnd } from '../text-cut.js';
import { isContextFullText } from './context-full.js';
import { buildWalnutMessage, escapeBody, parseWalnutMessage } from '../peers/walnut-message-tag.js';
import type { EnvelopeHandedOn } from '../peers/envelope-kit.js';
import {
  stillReached,
  buildRequestNotification,
  buildUndeliveredNotification,
  buildOverdueReminder,
  claimReminder,
  clipNoticeMessage,
  overdueOpenRequests,
  overdueRequests,
  reminderDueAt,
  requestWaitMs,
  settleNotified,
  waitWhileActive,
  withdrawRequest,
  type NoticeLastMessage,
  type SessionRequest,
  type SessionRequestOutcome,
} from '../session-requests.js';

/**
 * How long a notice waits on a transcript read before it goes without the quote.
 * Generous on purpose: nothing waits on the notice but the asker, whose other
 * option is the 1h/6h deadline, and a live read measured 5.4s on a loaded Mac
 * (2026-09-28), where a 3s budget sent the notice with no quote at all.
 */
export const LAST_MESSAGE_READ_MS = 10_000;
/** At most this many tool calls are listed after the last message (the newest ones). */
const NOTICE_MAX_ACTIONS = 8;
/** The CLI's own marker after an interrupt: a user row, but not a new turn. */
const INTERRUPT_MARKER = /^\[Request interrupted/;

type TranscriptRow = { role: string; text: string; kind?: string; detail?: string };

/** One tool call as a notice lists it; the row's own one-line summary, bounded. */
const ACTION_LINE_MAX = 200;

/** Who started a turn, read from the user row that opened it (subtask notices name it). */
export type TurnStarter = 'the user' | 'your message' | 'another task' | 'a trigger' | 'a Walnut notice';

/**
 * Who started the turn that `userRow` opened. A Walnut envelope names its
 * speaker (another task's note, a trigger, a Walnut notice); plain text is the
 * human's own words. `parentTaskId` tells the parent's own note apart from any
 * other task's.
 */
export function turnStarterOf(userRow: TranscriptRow | undefined, parentTaskId?: string): TurnStarter {
  if (!userRow) return 'the user';
  const envelope = parseWalnutMessage(userRow.text);
  if (!envelope) return 'the user';
  if (envelope.kind === 'trigger') return 'a trigger';
  if (envelope.kind === 'notification') return 'a Walnut notice';
  // Walnut's own frame around a line no task wrote (send-frame.ts): hooks, nudges, wake clocks.
  if (envelope.kind === 'peer-note' && /^Walnut \(/.test(envelope.attrs.from ?? '')) return 'a Walnut notice';
  if (envelope.kind === 'peer-note' || envelope.kind === 'reply') {
    return parentTaskId && envelope.attrs['from-task'] === parentTaskId ? 'your message' : 'another task';
  }
  return 'the user';
}

/**
 * What the target last said and did, from its transcript rows. Its last turn
 * (the rows after the last real user message) speaks first: that turn's last
 * text, plus the tool calls it made AFTER that text, because a turn that opens
 * with "let me look at the folder" and then writes the files has its result in
 * the calls, not the words. The common silent ending is a child that writes its
 * files, closes its own task and ends the turn without a word. A turn with
 * neither falls back to the last text of an earlier turn.
 */
export function lastWordsOf(messages: ReadonlyArray<TranscriptRow> | undefined): NoticeLastMessage | undefined {
  return lastTurnOf(messages)?.words;
}

/** The last turn of a transcript: what it said and did ({@link lastWordsOf}), and the user row that opened it. */
export function lastTurnOf(
  messages: ReadonlyArray<TranscriptRow> | undefined,
): { words: NoticeLastMessage | undefined; openedBy: TranscriptRow | undefined } | undefined {
  if (!messages?.length) return undefined;
  const said = (m: TranscriptRow) => m.role === 'assistant' && !m.kind && m.text.trim();
  let start = messages.length;
  while (start > 0) {
    const m = messages[start - 1];
    if (m.role === 'user' && !INTERRUPT_MARKER.test(m.text.trim())) break;
    start--;
  }
  const openedBy = start > 0 ? messages[start - 1] : undefined;
  const words = lastWordsOfTurn(messages, start, said);
  return { words, openedBy };
}

function lastWordsOfTurn(
  messages: ReadonlyArray<TranscriptRow>,
  start: number,
  said: (m: TranscriptRow) => string | false,
): NoticeLastMessage | undefined {
  const turn = messages.slice(start);
  let lastSaid = turn.length - 1;
  while (lastSaid >= 0 && !said(turn[lastSaid])) lastSaid--;
  const actions = turn.slice(lastSaid + 1).filter((m) => m.kind === 'tool' && m.text.trim()).slice(-NOTICE_MAX_ACTIONS)
    .map((m) => {
      const line = m.detail?.trim() ? `${m.text.trim()}: ${m.detail.trim()}` : m.text.trim();
      return line.length > ACTION_LINE_MAX ? `${line.slice(0, cutEnd(line, ACTION_LINE_MAX - 1))}…` : line;
    });
  if (lastSaid >= 0) {
    // '' when its last message was only the no-action line.
    const words = noticeWordsOf(turn[lastSaid].text) ?? { text: '' };
    return actions.length ? { ...words, actions } : words;
  }
  if (actions.length) return { text: '', actions };
  const earlier = messages.slice(0, start).reverse().find(said);
  return earlier ? clipNoticeMessage(noticeText(earlier.text)) : undefined;
}

/**
 * What a notice says for a turn that ended on "Prompt is too long": Claude Code's refusal is no
 * answer, and quoting it read as one (2026-11-06: an asker took a quoted "Prompt is too long" as the
 * reply). Guard: tests/core/sessions/context-full-turn-end-guard.test.ts.
 */
export const CONTEXT_FULL_NOTICE_WORDS = '[It answered nothing: its turn ended on "Prompt is too long" (its conversation no longer fits '
  + 'the model\'s context window). Walnut compacts it and hands it the message again; if that fails, the session waits for a person.]';

/** The turn-end line a session writes when nothing needs saying (web/src/utils/turn-end-marker.ts). */
const ACK_LINE = /<walnut-turn status="(?:agent-ack|no-action)"\/>/;

/**
 * A final message as a notice holds it: its clipped words, or `{ text: '', ack: true }` when it
 * was only the agent-ack line, so a notice can tell an acknowledgement from a turn that wrote nothing.
 */
export function noticeWordsOf(text: string): NoticeLastMessage | undefined {
  const words = clipNoticeMessage(noticeText(text));
  if (words) return words;
  return ACK_LINE.test(text) ? { text: '', ack: true } : undefined;
}

/** A last message as a notice quotes it. */
export function noticeText(text: string): string {
  return isContextFullText(text) ? CONTEXT_FULL_NOTICE_WORDS : text;
}

export interface FallbackContext {
  /** The target task's phase at the edge ('COMPLETE' changes the wording). */
  phase?: string;
  /** The target's final text for the turn that just ended, when the caller has it. */
  lastMessage?: string;
  /** The target's last words, already read by the caller (one transcript read serves every notice of an edge). */
  lastWords?: NoticeLastMessage;
  /** The tasks the target handed this request on to, and where each answer stands. */
  handedOn?: EnvelopeHandedOn[];
  /** The message never reached the target, for this reason (its row was parked): said instead of any quote. */
  notDelivered?: string;
  /** Collects the notices instead of sending each (the deadline sweep: one message per asker, NoticeBatch). */
  batch?: NoticeBatch;
}

/** One notice the sweep collected: where it goes, its text, and whether it rides the asker's next message. */
interface BatchedNotice {
  origin: import('../types.js').SessionRecord;
  text: string;
  hold: boolean;
  requestIds: string[];
}

/**
 * The notices of one sweep, sent per asker as ONE message (2026-11-04: a VP read a separate
 * "has not replied by your deadline" notice per task, several due in the same minute).
 */
export class NoticeBatch {
  private readonly items: BatchedNotice[] = [];
  add(item: BatchedNotice): void { this.items.push(item); }

  /** Send what was collected: one message per asker session. Returns how many went out. */
  async flush(): Promise<number> {
    const bySession = new Map<string, BatchedNotice[]>();
    for (const i of this.items) bySession.set(i.origin.claudeSessionId, [...(bySession.get(i.origin.claudeSessionId) ?? []), i]);
    this.items.length = 0;
    let sent = 0;
    for (const [sid, group] of bySession) {
      const ids = group.flatMap((g) => g.requestIds);
      const text = group.map((g) => g.text).join('\n\n');
      try {
        if (group.every((g) => g.hold)) {
          // Past its deadline nothing came back: background, riding the asker's next message (held-notices.ts).
          const { holdNotice } = await import('./held-notices.js');
          holdNotice(sid, `request-timeout:${ids.join(',')}`, text, {
            validIf: async () => (await Promise.all(ids.map(requestStillOpen))).some(Boolean),
          });
        } else {
          const { deliverToSession } = await import('./session-send-core.js');
          await deliverToSession(group[0].origin, {
            busText: text, enqueueText: text, source: 'walnut-notify', taskId: group[0].origin.taskId, endsWait: true,
          });
        }
        sent++;
        log.session.info('request deadline notices sent as one message', {
          toSessionId: sid, requestIds: ids, notices: group.length, held: group.every((g) => g.hold),
        });
      } catch (err) {
        log.session.error('request deadline notices failed after settle', {
          toSessionId: sid, requestIds: ids, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return sent;
  }
}

/** Why a target counts as at work on an overdue request ({@link targetAtWork}). */
export type TargetAtWork = 'a turn running' | 'an answer just sent' | 'a status report of working' | 'its host says it is at work';

/**
 * Whether the target of an overdue request is plainly at work, within its last wait (2026-11-04:
 * a VP read about ten "has not replied by your deadline, check its progress" notices overnight
 * about tasks in the middle of their work, and acked each). A turn running now, an answer it sent
 * any asker, or a status report of working since then. A task that is COMPLETE, or a turn stopped
 * on a permission prompt, is not at work. Never throws: unknown is not at work, so the asker hears.
 */
export async function targetAtWork(
  r: SessionRequest, rows: readonly SessionRequest[], now = Date.now(),
): Promise<TargetAtWork | null> {
  try {
    const since = Math.max(Date.parse(r.createdAt) || 0, now - requestWaitMs(r));
    let task: { phase?: string; session_id?: string | null; status_report?: { state?: string; at?: string } } | undefined;
    if (r.toTaskId) {
      const { listTasksByIds } = await import('../task-manager.js');
      task = (await listTasksByIds([r.toTaskId]).catch(() => []))[0];
      if (task?.phase === 'COMPLETE') return null;
    }
    const sid = r.toSessionId ?? task?.session_id ?? undefined;
    let rec: import('../types.js').SessionRecord | null = null;
    if (sid) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      rec = await getSessionByClaudeId(sid).catch(() => null);
      // Stopped on a permission prompt: it waits on a person, whatever it did before.
      if (rec?.pendingPermission) return null;
      if (rec?.process_status === 'running') return 'a turn running';
    }
    const answered = rows.some((x) => x.id !== r.id && x.status === 'replied' && !!x.settledAt && Date.parse(x.settledAt) >= since
      && ((!!r.toTaskId && x.toTaskId === r.toTaskId) || (!!r.toSessionId && x.toSessionId === r.toSessionId)));
    if (answered) return 'an answer just sent';
    const report = task?.status_report;
    if (report?.state === 'working' && !!report.at && Date.parse(report.at) >= since) return 'a status report of working';
    // The record can be stale (a restart, a dropped daemon link wrote a live CLI stopped): its host decides.
    if (rec && (await probeHost(rec, now))?.working) return 'its host says it is at work';
    return null;
  } catch {
    return null;
  }
}

/**
 * The target's last words (lastWordsOf), read from its transcript. A live build
 * first (the turn that just ended is already in the JSONL), bounded, because a
 * remote host can be slow or gone; then the cached projection. Never throws.
 */
export async function readLastWords(sessionId: string | undefined): Promise<NoticeLastMessage | undefined> {
  return (await readLastTurn(sessionId))?.words;
}

/** {@link readLastWords} plus who opened that last turn ({@link turnStarterOf} reads the row). */
export async function readLastTurn(
  sessionId: string | undefined,
): Promise<LastTurnRead | undefined> {
  if (!sessionId) return undefined;
  const projection = await import('../session-projection.js');
  // A live read that runs out of time is tried once more: the first read keeps running and
  // whichever answers first wins (2026-11-09: a loaded host left notices with no quote).
  let unread: NoticeWordsUnread | undefined;
  try {
    const first = projection.buildSessionTranscript(sessionId);
    first.catch(() => undefined);
    let live = await withinReadBudget(first);
    if (live === TIMED_OUT) {
      const second = projection.buildSessionTranscript(sessionId);
      second.catch(() => undefined);
      // The first one failing late does not end the second.
      live = await withinReadBudget(Promise.race([first.catch(() => second), second]));
    }
    if (live === TIMED_OUT) unread = 'timed_out';
    else {
      const found = lastTurnOf(live?.messages);
      if (found?.words) return found;
    }
  } catch { unread = 'failed'; }
  try {
    const cached = lastTurnOf((await projection.readSessionTranscript(sessionId))?.messages);
    // The cache may predate the turn that just ended: words from it beat none, but a cache with
    // none, or with only an earlier turn's agent-ack, says nothing about that turn when the live
    // read never answered (an old ack must not silence a new stop: ackOnlyStop).
    if (!unread) return cached;
    const w = cached?.words;
    return w && (w.text.trim() || w.actions?.length) ? cached : { words: undefined, openedBy: cached?.openedBy, unread };
  } catch {
    return unread ? { words: undefined, openedBy: undefined, unread } : undefined;
  }
}

/** Why a read found no words although the turn was read for them ({@link readLastTurn}). */
export type NoticeWordsUnread = 'timed_out' | 'failed';

/** What {@link readLastTurn} found; `unread` says the read itself failed, never that the turn wrote nothing. */
export interface LastTurnRead {
  words: NoticeLastMessage | undefined;
  openedBy: TranscriptRow | undefined;
  unread?: NoticeWordsUnread;
}

const TIMED_OUT = Symbol('timed-out');

async function withinReadBudget<T>(read: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read,
    new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), LAST_MESSAGE_READ_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Whether the asking session's task is COMPLETE. Unknown counts as not. */
/** A request still unanswered (pending, or past its deadline and open): a held notice of it still holds. */
async function requestStillOpen(id: string): Promise<boolean> {
  const { getSessionRequest } = await import('../session-requests.js');
  const row = await getSessionRequest(id).catch(() => null);
  return !!row && (row.status === 'pending' || row.status === 'expired');
}

/**
 * Whether the target's words may be quoted to the asker: both tasks in the same incoming-item
 * area, or neither in one (router/context-sharing.ts). The tasks are read from where each
 * actually sits now, never from the request alone; anything unknown or failing withholds.
 */
async function mayQuoteTarget(request: SessionRequest): Promise<boolean> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const { mayShareTaskContext } = await import('../router/context-sharing.js');
    const asker = await getSessionByClaudeId(request.fromSessionId).catch(() => undefined);
    const target = request.toSessionId ? await getSessionByClaudeId(request.toSessionId).catch(() => undefined) : undefined;
    if (asker?.profile?.areaId || target?.profile?.areaId) {
      if (asker?.profile?.areaId !== target?.profile?.areaId) return false;
    }
    const targetTaskId = request.toTaskId ?? target?.taskId;
    if (target?.taskId && request.toTaskId && target.taskId !== request.toTaskId
      && !await mayShareTaskContext(target.taskId, asker?.taskId)) return false;
    if (!targetTaskId) return asker?.taskId ? mayShareTaskContext(asker.taskId, undefined) : true;
    return await mayShareTaskContext(targetTaskId, asker?.taskId);
  } catch {
    return false;
  }
}

async function askerTaskIsComplete(fromSessionId: string): Promise<boolean> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const taskId = (await getSessionByClaudeId(fromSessionId))?.taskId;
    if (!taskId) return false;
    const { listTasksByIds } = await import('../task-manager.js');
    return (await listTasksByIds([taskId])).find((t) => t.id === taskId)?.phase === 'COMPLETE';
  } catch {
    return false;
  }
}

export async function notifyRequesterFallback(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
  context: FallbackContext = {},
): Promise<boolean> {
  return notifyRequesterGroup([request], outcome, context);
}

/** What stands between a request and its notice at this edge: nothing, or the reason its message never ran. */
async function gateRequest(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
  context: FallbackContext,
): Promise<'skip' | { undelivered?: { why: string; stillQueued: boolean }; withheld?: boolean }> {
  // The asker's message itself may not have reached the target yet. A turn end or
  // error then belongs to an earlier turn and says nothing of this request: the
  // message is still on its way, and its own turn (or a park, or the deadline)
  // speaks. A parked row means it never will: say that, not "its turn ended".
  let undelivered: { why: string; stillQueued: boolean } | undefined = context.notDelivered
    ? { why: context.notDelivered, stillQueued: false } : undefined;
  if (!undelivered) {
    const { undeliveredRowFor, parkMeansNeverRan, parkByStop, requestDelivering } = await import('./undelivered-requests.js');
    const row = await undeliveredRowFor(request.toSessionId, request.id).catch(() => undefined);
    if (!row && requestDelivering(request.id)) {
      // Asked, and its message not queued yet: the same as a row still waiting.
      if (context.phase !== 'COMPLETE' && outcome !== 'timeout') {
        log.session.info('request fallback: the message is still being queued, edge ignored', {
          requestId: request.id, toSessionId: request.toSessionId, outcome,
        });
        return 'skip';
      }
    } else if (row?.status === 'parked') {
      // A park that cannot say whether the line ran (the CLI never acknowledged it) is no proof.
      if (parkMeansNeverRan(row.parkedReason) || parkByStop(row.parkedReason)) {
        undelivered = { why: row.parkedReason || 'the message could not be delivered', stillQueued: false };
      }
    } else if (row) {
      // Its task was completed with the message still queued: no turn will run on it
      // (the completion stops its sessions), so say that now, not at the deadline.
      if (context.phase === 'COMPLETE' && row.status === 'pending') {
        undelivered = { why: 'its task was completed before its session read this message', stillQueued: false };
      } else if (outcome === 'completed' || outcome === 'error') {
        log.session.info('request fallback: the message has not reached its target yet, edge ignored', {
          requestId: request.id, toSessionId: request.toSessionId, outcome, rowStatus: row.status, messageId: row.id,
        });
        return 'skip';
      }
      if (!undelivered && outcome === 'timeout' && row.status === 'pending') {
        undelivered = { why: `it was queued at ${row.enqueuedAt} and has not been delivered since`, stillQueued: true };
      }
    }
  }
  // A turn end is not a stop while the task carries on. Read the live status here,
  // before the atomic settle, so every turn-end caller shares this gate.
  if (!undelivered && outcome === 'completed' && context.phase !== 'COMPLETE') {
    const { requestTargetContinues } = await import('./request-progress.js');
    if (await requestTargetContinues(request)) return 'skip';
  }
  // A Walnut notice never goes into a COMPLETE task's session: nothing there
  // waits for it, and delivering would run a turn on finished work. Withdrawn,
  // not notified (nobody was told), so reopening the task restores it.
  if (await askerTaskIsComplete(request.fromSessionId)) {
    if (await withdrawRequest(request.id)) {
      log.session.info('request fallback: asker task is complete, request withdrawn, nobody told', {
        requestId: request.id, fromSessionId: request.fromSessionId, outcome,
      });
    }
    return 'skip';
  }
  // Across an incoming-item area the notice still settles the request, but carries none of
  // the target's last words, tool calls or hand-off quotes.
  const withheld = !await mayQuoteTarget(request);
  if (withheld) {
    log.session.info('request fallback: target and asker are in different areas, quote withheld', {
      requestId: request.id, fromSessionId: request.fromSessionId, toTaskId: request.toTaskId, outcome,
    });
  }
  return { ...(undelivered ? { undelivered } : {}), ...(withheld ? { withheld } : {}) };
}

/**
 * Settle the requests that one edge ends and tell each ASKER once (2026-11-02, the org reflection:
 * a worker's turn end settled the six requests its lead had open and the lead read six notices, one
 * per request). Requests of one asker share one message: the first is the notice, the others are
 * named in it, each settled with the same outcome; a request whose message never ran is told apart
 * from the ones that did (the two cannot share one sentence). The atomic settle still decides who
 * speaks: a request someone else settled first is left out.
 */
export async function notifyRequesterGroup(
  requests: readonly SessionRequest[],
  outcome: SessionRequestOutcome,
  context: FallbackContext = {},
): Promise<boolean> {
  if (requests.length === 0) return false;
  // A host that answered while this server was away may be handing over a reply
  // to this very request right now (offline-handover.ts): let it land first, or
  // the asker hears "no reply" after it already got one.
  const { waitForOfflineHandovers } = await import('../offline-handover.js');
  await waitForOfflineHandovers();

  const byAsker = new Map<string, SessionRequest[]>();
  for (const r of requests) byAsker.set(r.fromSessionId, [...(byAsker.get(r.fromSessionId) ?? []), r]);
  let delivered = false;
  for (const [, rows] of byAsker) {
    const heard: { request: SessionRequest; undelivered?: { why: string; stillQueued: boolean }; withheld?: boolean }[] = [];
    for (const request of rows) {
      const gate = await gateRequest(request, outcome, context);
      if (gate === 'skip') continue;
      // A message that never arrived is an error for the asker, whatever edge noticed it.
      const settled = await settleNotified(request.id, gate.undelivered && !gate.undelivered.stillQueued ? 'error' : outcome);
      if (!settled) continue; // replied / already notified — someone else spoke
      heard.push({ request: settled, ...(gate.undelivered ? { undelivered: gate.undelivered } : {}), ...(gate.withheld ? { withheld: true } : {}) });
    }
    if (heard.length === 0) continue;
    // A withheld notice never shares one message with a quoted one.
    const ran = heard.filter((h) => !h.undelivered && !h.withheld);
    const ranWithheld = heard.filter((h) => !h.undelivered && h.withheld);
    const notRan = heard.filter((h) => h.undelivered);
    for (const part of [ran, ranWithheld, notRan]) {
      if (part.length === 0) continue;
      const [first, ...rest] = part;
      const withheld = part.some((h) => h.withheld);
      if (await deliverSettled(first.request, rest.map((h) => h.request), first.undelivered, outcome, context, withheld)) delivered = true;
    }
  }
  return delivered;
}

/** The notice of requests already settled: `request` is its subject, `also` the others of the same asker and edge. */
async function deliverSettled(
  request: SessionRequest,
  also: readonly SessionRequest[],
  undelivered: { why: string; stillQueued: boolean } | undefined,
  outcome: SessionRequestOutcome,
  context: FallbackContext,
  withheld = false,
): Promise<boolean> {
  const settled = request;
  const alsoUnanswered = also.map((r) => ({ id: r.id, preview: r.preview }));
  try {
    // Same address resolution the real reply uses (reply-routing.ts): a notice
    // filed in a session the human stopped reading is as lost as a reply. An
    // asker that is still live resolves to itself — unchanged.
    const { resolveReplyDestination, logReplyReroute } = await import('./reply-routing.js');
    const destination = await resolveReplyDestination(request.fromSessionId);
    if (!destination) {
      log.session.info('request fallback: asker session gone — notification skipped', {
        requestId: request.id, fromSessionId: request.fromSessionId, outcome,
      });
      return false;
    }
    logReplyReroute(request.id, request.fromSessionId, destination);
    const origin = destination.session;
    // A reroute may land in another session than the asker's: the area check holds there too.
    if (!withheld && (origin.claudeSessionId !== request.fromSessionId)) {
      const { mayShareTaskContext } = await import('../router/context-sharing.js');
      withheld = !!origin.profile?.areaId || (!!request.toTaskId && !await mayShareTaskContext(request.toTaskId, origin.taskId).catch(() => false));
    }

    // Target naming is embellishment — a failed lookup must not lose the notice.
    // Withheld: not even its title crosses the area.
    let targetTitle: string | undefined;
    let currentState: string | undefined;
    let targetPhase = context.phase;
    let targetSessionId = request.toSessionId;
    if (request.toTaskId && !withheld) {
      try {
        const { listTasksByIds } = await import('../task-manager.js');
        const task = (await listTasksByIds([request.toTaskId]))[0];
        targetTitle = task?.title;
        targetPhase ??= task?.phase;
        if (task) {
          const { fallbackUserState, stateWord } = await import('../user-status.js');
          const live = task.user_status;
          currentState = stateWord(task.phase === 'COMPLETE' ? 'done' : live?.state ?? fallbackUserState(task.phase, task.status), !!live?.snoozed);
          if (live?.ask) currentState += `: ${live.ask.replace(/\s+/g, ' ').slice(0, 200)}`;
          else if (live?.waitingOn) currentState += `: ${live.waitingOn.replace(/\s+/g, ' ').slice(0, 200)}`;
        }
        targetSessionId ??= task?.session_id ?? undefined;
      } catch { /* title stays generic */ }
    }
    if (undelivered) {
      const text = buildUndeliveredNotification(settled, {
        title: targetTitle, sessionId: request.toSessionId, taskId: request.toTaskId,
      }, undelivered.why, undelivered.stillQueued, alsoUnanswered);
      if (context.batch) {
        context.batch.add({ origin, text, hold: false, requestIds: [request.id, ...also.map((r) => r.id)] });
        return true;
      }
      const { deliverToSession } = await import('./session-send-core.js');
      const { delivery } = await deliverToSession(origin, {
        busText: text, enqueueText: text, source: 'walnut-notify', taskId: origin.taskId, endsWait: true,
      });
      log.session.info('request fallback notification delivered (message not delivered)', {
        requestId: request.id, alsoRequestIds: also.map((r) => r.id), fromSessionId: request.fromSessionId, toSessionId: origin.claudeSessionId,
        outcome, delivery, stillQueued: undelivered.stillQueued, why: undelivered.why.slice(0, 200),
      });
      return true;
    }
    // Where the work went, when the target handed it on (request-handoff.ts).
    // An overdue one quotes that task's latest message and state, not the target's.
    const handedOn = withheld ? undefined : (outcome === 'timeout' ? undefined : context.handedOn)
      ?? await (await import('./request-handoff.js')).handedOnFor(settled, { words: outcome === 'timeout' });
    // The quote: the turn's own result when the edge carried it, else the transcript.
    // Not read for an overdue request handed on: its notice quotes the task it went to.
    const lastMessage = withheld || (outcome === 'timeout' && handedOn?.length) ? undefined
      : (context.lastMessage ? clipNoticeMessage(context.lastMessage) : undefined)
        ?? context.lastWords
        ?? await readLastWords(targetSessionId);
    const notification = buildRequestNotification(settled, outcome, {
      title: targetTitle,
      sessionId: request.toSessionId,
      taskId: request.toTaskId,
      phase: targetPhase,
      lastMessage,
      ...(handedOn?.length ? { handedOn } : {}),
      ...(alsoUnanswered.length ? { alsoUnanswered } : {}),
    });

    const text = currentState ? notification.replace('\n\nNext:\n', () => `\n\nCurrent state: ${escapeBody(currentState)}.\n\nNext:\n`) : notification;

    // Past its deadline the request stays open and nothing came back: background, riding the
    // asker's next message, never a turn of its own nor a line into a running one (held-notices.ts),
    // unless the asker parked on it (WAITING): the deadline is its cue.
    // Every other outcome is the answer the asker waits for.
    const askerParked = outcome === 'timeout' && !!origin.taskId
      && (await (await import('../task-manager.js')).getTask(origin.taskId).catch(() => null))?.phase === 'WAITING';
    if (context.batch) {
      context.batch.add({ origin, text, hold: outcome === 'timeout' && !askerParked, requestIds: [request.id, ...also.map((r) => r.id)] });
      return true;
    }
    if (outcome === 'timeout' && !askerParked) {
      const { holdNotice } = await import('./held-notices.js');
      holdNotice(origin.claudeSessionId, `request-timeout:${request.id}`, text, { validIf: () => requestStillOpen(request.id) });
      log.session.info('request fallback notification held for the next message (deadline passed)', {
        requestId: request.id, fromSessionId: request.fromSessionId, toSessionId: origin.claudeSessionId,
      });
      return true;
    }
    const { deliverToSession } = await import('./session-send-core.js');
    const { delivery } = await deliverToSession(origin, {
      busText: text, enqueueText: text, source: 'walnut-notify', taskId: origin.taskId, endsWait: true,
    });
    log.session.info('request fallback notification delivered', {
      requestId: request.id, alsoRequestIds: also.map((r) => r.id), fromSessionId: request.fromSessionId,
      toSessionId: origin.claudeSessionId, outcome, delivery,
      phase: targetPhase, quoted: lastMessage ? lastMessage.text.length : 0, clipped: lastMessage?.clipped ?? false,
      handedOn: handedOn?.map((h) => `${h.taskId ?? '?'}:${h.state}`),
      actions: lastMessage?.actions?.length ?? 0,
    });
    return true;
  } catch (err) {
    // The rows are already settled — a delivery failure must not un-settle them
    // (that would re-arm every edge); log loudly instead.
    log.session.error('request fallback notification failed after settle', {
      requestId: request.id, alsoRequestIds: also.map((r) => r.id), outcome, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** One sweeper tick: notify every pending request past its deadline. */
let sweeping: Promise<number> | undefined;
let clock: Promise<void> = Promise.resolve();

/**
 * One sweep at a time: each overdue notice may wait up to LAST_MESSAGE_READ_MS on
 * a transcript, so a backlog can outlast the 60s interval. A tick that lands
 * during a sweep joins it instead of scanning the same rows again.
 */
export function sweepSessionRequests(): Promise<number> {
  // Every tick, a sweep running or not, keeps the clock: time Walnut was away (stopped, the Mac
  // asleep) never counts against a deadline, and a long sweep is never taken for it.
  const tick = Date.now();
  clock = clock.then(async () => {
    const { creditDowntime } = await import('../session-requests.js');
    await creditDowntime(tick);
  }).catch((err) => log.session.warn('request downtime credit failed', { error: err instanceof Error ? err.message : String(err) }));
  sweeping ??= (async () => {
    try {
      await clock;
      const now = Date.now();
      const overdue = await overdueRequests(now);
      const { listAllSessionRequests } = await import('../session-requests.js');
      const rows = overdue.length ? await listAllSessionRequests().catch(() => overdue) : overdue;
      // A target plainly at work waits one more of its waits instead of being chased.
      const due: SessionRequest[] = [];
      for (const request of overdue) {
        const why = await targetAtWork(request, rows, now);
        const moved = why ? await waitWhileActive(request.id, why, now) : null;
        if (moved) {
          log.session.info('request past its deadline, target at work: waits longer, asker not told', {
            requestId: request.id, toTaskId: request.toTaskId, why, until: new Date(moved.deadlineAt).toISOString(), times: moved.activeWaits,
          });
          continue;
        }
        due.push(request);
      }
      // One message per asker: its requests grouped by target (one notice each), sent together.
      let notified = 0;
      const batch = new NoticeBatch();
      const groups = new Map<string, SessionRequest[]>();
      for (const r of due) {
        const key = `${r.fromSessionId}\u0000${r.toTaskId ?? r.toSessionId ?? r.id}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      for (const group of groups.values()) {
        if (await notifyRequesterGroup(group, 'timeout', { batch })) notified += group.length;
      }
      await batch.flush();
      await remindOverdue().catch((err) => log.session.warn('overdue reminders failed', {
        error: err instanceof Error ? err.message : String(err),
      }));
      await remindSilent().catch((err) => log.session.warn('silent-target notices failed', {
        error: err instanceof Error ? err.message : String(err),
      }));
      return notified;
    } finally {
      sweeping = undefined;
    }
  })();
  return sweeping;
}

/** A task asked to start or sent work that shows nothing this long tells its asker. */
export const SILENT_AFTER_MS = 10 * 60_000;

/**
 * Every sign that a target took up the work since it was asked; the silent-target notice
 * (remindSilent) goes only when none shows. 2026-11-07: a task whose turn began before the ask,
 * read it mid-turn and ended 45 minutes later with a status report naming the ask was read as
 * "has not taken up the work", and so was one that had messaged its asker an hour before: only a
 * turn running now or one begun since the ask counted. Later that night two more: one idle between
 * turns with background jobs and a review running, one idle with a review round it had sent out.
 */
export const TARGET_SIGNS = [
  'the ask reached its session',
  'it has an earlier ask of the same asker',
  'its host says it is at work',
  'a turn running now',
  'work of it running after its turn',
  'a turn begun since the ask',
  'a turn ended since the ask',
  'its status report since the ask',
  'an answer it sent since the ask',
  'a message it sent since the ask',
] as const;
export type TargetSign = typeof TARGET_SIGNS[number];

/** What the request watch knows of a target, for targetSignSince. */
export interface TargetFacts {
  /** The ask's time (epoch ms). */
  since: number;
  /** Its runner says a turn runs (true) or not (false); null when this server holds no runner for it. */
  inTurn: boolean | null;
  /** Its session's process status (running, idle, stopped, error), when it has one. */
  processStatus?: string;
  /**
   * Its own work that runs on after its turn (runner.outlivingWorkOf: background commands and
   * subagents, a team, an armed wakeup); a /loop between its fires runs nothing.
   */
  outliving?: readonly import('./outliving-work.js').OutlivingSource[];
  /** When its last turn began (epoch ms; lastTurnSpeed.startedAt), absent when unseen. */
  turnStartedAt?: number;
  /**
   * Its report of its last turn (task.status_report). Only its own counts: a line a person or
   * another task set (`by` other than self) is dated when they set it, and a report with no `by`
   * may be Walnut's own status ask of an idle session (`at` only, never `turn_ended_at`).
   */
  report?: { at?: string; turn_ended_at?: string; by?: string };
  /** Its task id and session ids: rows it answered or sent are matched on them. */
  taskId?: string;
  sessionIds: readonly string[];
  /** The request ledger. */
  rows: readonly SessionRequest[];
  /** This request (never its own sign). */
  requestId: string;
  /**
   * Its host daemon's word (host-work.ts), asked only when nothing else shows: the one fact a
   * server restart or a dropped daemon link cannot leave stale. Undefined when not asked.
   */
  host?: import('./host-work.js').HostWork | null;
  /** Queue rows of the target waiting to go out again (request-reached.ts takenBackIds): their stamps prove nothing. */
  takenBack?: ReadonlySet<string>;
}

/** Below this many characters a contained preview proves nothing ("ok", "status?"). */
const RESEND_MIN_CHARS = 24;

/**
 * The ask is a resend of the earlier one: the same words (their previews, clipped at 160), or one
 * holding the other whole ("Resending: <the first ask>").
 */
export function isResendOf(preview: string | undefined, earlier: string | undefined): boolean {
  const norm = (t: string | undefined) => (t ?? '').replace(/\u2026$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(preview);
  const b = norm(earlier);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= RESEND_MIN_CHARS && long.includes(short);
}

/** The first sign that the target took up the work since the ask (TARGET_SIGNS), or null. */
export function targetSignSince(f: TargetFacts): TargetSign | null {
  const after = (iso: string | undefined): boolean => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) && t >= f.since; };
  const self = f.rows.find((x) => x.id === f.requestId);
  // Durable facts first: a restarted server's runner and a session record a dropped daemon link
  // rewrote can both be wrong (2026-11-08, the two notices about a task mid-turn on the ask).
  if (self && stillReached(self, f.takenBack)) return 'the ask reached its session';
  // A resend of an ask its target already has: the earlier one's own edges speak for both
  // (2026-11-08: the resend was told "not taken" while the target was answering the first).
  // Only a real resend (the same words): an independent new ask of the same asker still gets its
  // own check of the host.
  if (self && f.rows.some((x) => x.id !== self.id && x.fromSessionId === self.fromSessionId && stillReached(x, f.takenBack)
    && x.status === 'pending' && Date.parse(x.createdAt) <= Date.parse(self.createdAt)
    && ((!!f.taskId && x.toTaskId === f.taskId) || (!!x.toSessionId && x.toSessionId === self.toSessionId))
    && isResendOf(self.preview, x.preview))) return 'it has an earlier ask of the same asker';
  if (f.host?.working) return 'its host says it is at work';
  if (f.processStatus === 'running' && f.inTurn !== false) return 'a turn running now';
  if ((f.outliving ?? []).some((s) => s !== 'loop')) return 'work of it running after its turn';
  if ((f.turnStartedAt ?? 0) > f.since) return 'a turn begun since the ask';
  const ownReport = !f.report?.by || f.report.by === 'self';
  if (ownReport && after(f.report?.turn_ended_at)) return 'a turn ended since the ask';
  if (f.report?.by === 'self' && after(f.report.at)) return 'its status report since the ask';
  const own = new Set(f.sessionIds.filter(Boolean));
  const others = f.rows.filter((x) => x.id !== f.requestId);
  if (others.some((x) => x.status === 'replied' && after(x.settledAt)
    && ((!!f.taskId && x.toTaskId === f.taskId) || (!!x.toSessionId && own.has(x.toSessionId))))) return 'an answer it sent since the ask';
  if (others.some((x) => own.has(x.fromSessionId) && after(x.createdAt))) return 'a message it sent since the ask';
  return null;
}

/**
 * The safety net under a start or a send (2026-11-06, the user: "if a task has not updated for a
 * while, the VP gets a notification and checks it; best is that it never happens"): a pending
 * request whose target task shows nothing for SILENT_AFTER_MS since the ask (no session of it,
 * or one that is not in a turn and has not been active since) tells its asker once, waking it.
 * A target that runs, or ran since, is working; its own end of turn answers for it.
 */
export async function remindSilent(now = Date.now()): Promise<number> {
  const { IS_EPHEMERAL } = await import('../../constants.js');
  const { listPendingRequests, listAllSessionRequests, claimSilentNotice, releaseSilentNotice } = await import('../session-requests.js');
  const { takenBackIds } = await import('./request-reached.js');
  const runner = await import('../../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null);
  // Time Walnut was not running (pausedMs, creditDowntime) is no silence: the target could not work either.
  const due = (await listPendingRequests()).filter((r) => !r.silentToldAt && r.toTaskId && now - Date.parse(r.createdAt) - (r.pausedMs ?? 0) >= SILENT_AFTER_MS
    && (!IS_EPHEMERAL || Date.parse(r.createdAt) >= PROCESS_STARTED_AT));
  if (!due.length) return 0;
  const { listTasksByIds } = await import('../task-manager.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const tasks = new Map((await listTasksByIds([...new Set(due.map((r) => r.toTaskId!))]).catch(() => [])).map((t) => [t.id, t] as const));
  let told = 0;
  let ledger: SessionRequest[] | null | undefined;
  for (const r of due) {
    const task = tasks.get(r.toTaskId!);
    if (!task || task.phase === 'COMPLETE') continue;
    if (await askerTaskIsComplete(r.fromSessionId)) continue;
    const sid = r.toSessionId ?? task.session_id ?? task.exec_session_id ?? undefined;
    const session = sid ? await getSessionByClaudeId(sid).catch(() => null) : null;
    const asked = Date.parse(r.createdAt);
    // Working: any sign since the ask (TARGET_SIGNS). Not lastActiveAt: a status write moves it
    // (review round 6, Sol: a spawn timeout's error write read as work).
    const facts: TargetFacts = {
      since: asked,
      inTurn: session?.process_status === 'running' ? runner?.isInTurn(session.claudeSessionId) ?? null : false,
      ...(session?.process_status ? { processStatus: session.process_status } : {}),
      outliving: session ? runner?.outlivingWorkOf(session.claudeSessionId) ?? [] : [],
      ...(session?.lastTurnSpeed?.startedAt ? { turnStartedAt: session.lastTurnSpeed.startedAt } : {}),
      ...(task.status_report ? { report: task.status_report } : {}),
      taskId: task.id,
      sessionIds: [sid, task.session_id, task.exec_session_id, ...(task.session_ids ?? [])].filter((x): x is string => !!x),
      rows: (ledger ??= await listAllSessionRequests().catch(() => null)) ?? [],
      requestId: r.id,
      takenBack: await takenBackIds([sid, task.session_id, task.exec_session_id].filter((x): x is string => !!x)),
    };
    if (targetSignSince(facts)) continue;
    // The ledger could not be read: an answer or a message of it is unknown, so not told this pass.
    if (!ledger) { ledger = undefined; continue; }
    // Nothing the server holds shows work: its host has the last word, since the server's own view
    // of a session can be stale after a restart or a dropped daemon link (host-work.ts).
    const host = session ? await probeHost(session, now) : undefined;
    if (host && targetSignSince({ ...facts, host })) {
      log.session.info('silent target: its host says it is at work, asker not told', { requestId: r.id, taskId: task.id, sessionId: session?.claudeSessionId });
      continue;
    }
    // A host that does not answer is no proof of silence: wait for it, a while.
    if (session && host === null && now - asked - (r.pausedMs ?? 0) < SILENT_AFTER_MS * HOST_UNKNOWN_WAITS) continue;
    const state = host ? (host.alive ? 'running' : 'stopped') : session?.process_status;
    const why = !session ? 'no session of it ever started'
      : !host?.alive && session.process_status === 'error' ? `its session stopped with an error${session.errorMessage ? `: ${session.errorMessage.length > 200 ? `${session.errorMessage.slice(0, cutEnd(session.errorMessage, 199))}…` : session.errorMessage}` : ''}`
      : host === null ? 'its session has not taken up the work, as far as Walnut can tell: its host does not answer'
      : `its session has not taken up the work (${state === 'running' ? 'it waits after its last turn' : `it is ${state || 'not running'}`})`;
    const { resolveReplyDestination, isLive } = await import('./reply-routing.js');
    const destination = await resolveReplyDestination(r.fromSessionId).catch(() => null);
    if (!destination || !isLive(destination.session)) continue;
    // Judged on the stamp it saw (taken back, or none): a delivery during the host probe refuses the claim.
    const claimed = await claimSilentNotice(r.id, now, { reachedAt: facts.rows.find((x) => x.id === r.id)?.reachedAt ?? r.reachedAt });
    if (!claimed) continue;
    const minutes = Math.round((now - asked - (r.pausedMs ?? 0)) / 60_000);
    const text = buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut', about: task.title, 'about-task': task.id, request: r.id, asked: r.preview, outcome: 'error', note: 'automated Walnut status notice' },
      body: [
        `"${task.title}" (${task.id}) has shown nothing for ${minutes} minutes since you asked (${r.id}): ${why}.`,
        'Read task_get for it, then start it again with task_start, send the work again with task_send, or tell the user. This is the only notice for this request.',
      ].join('\n'),
    });
    try {
      const { deliverToSession } = await import('./session-send-core.js');
      await deliverToSession(destination.session, { busText: text, enqueueText: text, source: 'walnut-notify', ...(destination.session.taskId ? { taskId: destination.session.taskId } : {}) });
      told++;
      log.session.info('silent target: its asker told', { requestId: r.id, taskId: task.id, minutes, why });
    } catch (err) {
      // Not delivered: the claim goes, so the next sweep tries again (its one notice is not spent).
      await releaseSilentNotice(r.id).catch(() => {});
      log.session.warn('silent target notice not delivered', { requestId: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return told;
}

/** How many silent windows a target whose host does not answer gets before its asker is told anyway. */
export const HOST_UNKNOWN_WAITS = 3;

/** The host's word on a session (host-work.ts); a test replaces it. */
let probeHost: (session: import('../types.js').SessionRecord, now: number) => Promise<import('./host-work.js').HostWork | null> =
  async (session, now) => (await import('./host-work.js')).hostWorkOf(session, now);

/** Tests only: answer for the host. */
export function setHostProbeForTests(fn: typeof probeHost | null): void {
  probeHost = fn ?? (async (session, now) => (await import('./host-work.js')).hostWorkOf(session, now));
}

/** An ephemeral server's copy of the ledger came with the process: only rows it made overdue are its own. */
const PROCESS_STARTED_AT = Date.now();

/**
 * The one reminder of an OVERDUE request (status 'expired', still open), at twice its
 * deadline, to its asker: one message per asker for all of its requests due at once. Only rows
 * this Walnut made overdue (`overdueAt`), so an upgrade never reminds the old ones. None when
 * the request is closed in another way: the asker's task completed (nothing there waits) or the
 * target's did (its completion spoke for it).
 */
export async function remindOverdue(now = Date.now()): Promise<number> {
  // An ephemeral server's copy of the ledger is the real Walnut's: it reminds only what it made overdue itself.
  const { IS_EPHEMERAL } = await import('../../constants.js');
  const due = (await overdueOpenRequests(now)).filter((r) => r.overdueAt && !r.remindedAt && reminderDueAt(r) <= now
    && (!IS_EPHEMERAL || Date.parse(r.overdueAt) >= PROCESS_STARTED_AT));
  const byAsker = new Map<string, SessionRequest[]>();
  for (const r of due) byAsker.set(r.fromSessionId, [...(byAsker.get(r.fromSessionId) ?? []), r]);
  const { listAllSessionRequests } = await import('../session-requests.js');
  const allRows = due.length ? await listAllSessionRequests().catch(() => due) : due;
  let sent = 0;
  for (const [askerSid, rows] of byAsker) {
    if (await askerTaskIsComplete(askerSid)) continue;
    // Where it would land, before anything is claimed: a stopped asker is never woken for a
    // reminder, and its rows stay unclaimed until it runs again (or the 7-day retention ends them).
    const { resolveReplyDestination, isLive } = await import('./reply-routing.js');
    const destination = await resolveReplyDestination(askerSid).catch(() => null);
    if (!destination || !isLive(destination.session)) continue;
    const items: Parameters<typeof buildOverdueReminder>[0][number][] = [];
    for (const request of rows) {
      let target: { title?: string; phase?: string; session_id?: string | null } | undefined;
      if (request.toTaskId) {
        try {
          const { listTasksByIds } = await import('../task-manager.js');
          target = (await listTasksByIds([request.toTaskId]))[0];
        } catch { /* named generically */ }
      }
      if (target?.phase === 'COMPLETE') continue;
      // Its target is at work: the reminder waits for a quiet sweep (or the retention ends it).
      if (await targetAtWork(request, allRows, now)) continue;
      const claimed = await claimReminder(request.id, now);
      if (!claimed) continue;
      items.push({ request: claimed, target: {
        title: target?.title, sessionId: request.toSessionId ?? target?.session_id ?? undefined,
        taskId: request.toTaskId, phase: target?.phase,
      } });
    }
    if (items.length === 0) continue;
    try {
      const text = buildOverdueReminder(items, now);
      // A reminder asks nothing new: it rides the asker's next message (held-notices.ts).
      const { holdNotice } = await import('./held-notices.js');
      const ids = items.map((i) => i.request.id);
      holdNotice(destination.session.claudeSessionId, `overdue:${ids.join(',')}`, text, {
        validIf: async () => (await Promise.all(ids.map(requestStillOpen))).some(Boolean),
      });
      const delivery = 'held';
      sent++;
      log.session.info('overdue request reminder delivered', {
        fromSessionId: askerSid, requestIds: items.map((i) => i.request.id), delivery,
      });
    } catch (err) {
      // Not delivered: the claim goes, so the next sweep tries again.
      const { releaseReminder } = await import('../session-requests.js');
      for (const i of items) await releaseReminder(i.request.id).catch(() => {});
      log.session.warn('overdue request reminder failed after claim', {
        fromSessionId: askerSid, requestIds: items.map((i) => i.request.id), error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return sent;
}
