/**
 * Persistent message queue for Claude Code session chat.
 *
 * Messages are persisted to disk so they survive server restarts.
 * Uses atomic writes (temp file + rename) via writeJsonFile.
 *
 * Message lifecycle:
 *   enqueue()        → status: 'pending'     (on disk, editable)
 *   markProcessing() → status: 'processing'  (on disk, locked)
 *   removeProcessed()→ removed from disk      (now in JSONL history)
 *   parkMessages()   → status: 'parked'      (on disk, tried again on a growing clock: sessions/delivery-retry.ts)
 *
 * ## Why 'parked' exists (the dead-letter state)
 *
 * A pending row is retried forever: on every server boot (startup recovery) and
 * on every daemon reconnect. That is right for a transient failure (host asleep,
 * ssh down) and catastrophic for a permanent one. Observed: user messages sat
 * pending for 12 DAYS targeting sessions whose cwd had been deleted, so each
 * boot/reconnect ran the same doomed cycle — redeliver → cwd pre-flight aborts
 * the spawn → revert to pending — and published two error notifications per
 * session per cycle. Every deploy lit up the Errors rail with the same 12-day-old
 * failure.
 *
 * Parking ends that loop AT THE SOURCE: the row stays on disk and visible, and no
 * boot or reconnect picks it up again. A person's Retry (unparkMessage) puts it back
 * in line, or deleteMessage discards it; and since 2026-11-23 (the user: no message
 * is ever lost, an error is retried) sessions/delivery-retry.ts puts back, on a clock
 * that grows to once an hour, every park a retry can fix: not a Stop's, not a hold's,
 * not one only a person can fix (a deleted folder or session record, too large).
 */

import { dictationEventFields, type SentDictation } from './stt/dictation-ids.js';
import { noteRecentHumanMessage } from './recent-task-touch.js';
import { log } from '../logging/index.js';
import { lineUuidFor, noteLineCarries, splitBatchAtUuid } from '../providers/batch-uuid.js';
import {
  fateOf, isPhoneMessageId, noteDelivered, setFate, withdrawIn, STOP_PARKED_REASON,
  type RelayFate, type WithdrawState,
} from './relay-fates.js';
import { parkRow } from './queue-held-spans.js';
import {
  compareEnqueueOrder, generateId, getStore, mutateStore, nextEnqueueSeq, QueueNotStoredError, readQueueFileFresh, resetCache,
  type QueuedMessage, type QueueStore,
} from './session-queue-store.js';
import { FileLockTimeoutError } from '../utils/file-lock.js';
import { noteSettledLine, settledLineUuid } from './session-queue-lines.js';
import { staleTriggerText } from './routines/trigger-stale.js';
import type { PendingInstructionNotice } from './sessions/instruction-notice.js';
import { leadsWithNotice, markNoticeDelivering } from './sessions/instruction-notice-flight.js';
import { AUTOMATED_SEND_SOURCE, PERSON_SEND_SOURCES, isPersonSendSource, queueSentBy, sendSourceOf } from './sessions/send-sent-by.js';
import { frameAsWalnut, frameForSource, frameLooseText } from './sessions/send-frame.js';
import { ambientTestRun } from './test-run.js';
import { dropRepeatedHintBlocks, foldTidyIntoThreads, hintBlocksIn, replaceHintedText } from './hints/hint-format.js';
import { noteUserActivity } from './self-update/idle-gate.js';
import { endQuietTurn, isKeptQuietRowId, isQuietRowId, isRidingQuietRowId, noteQuietTurnDelivery, noteSessionSend as noteQuietTurnSend, quietTurnRow } from './sessions/quiet-turn.js';
import { aiOnlyEnvelopes, hasAiOnly, keepAiOnly, withoutAiOnly } from '../lib/ai-only-envelope.js';
import { forgetBriefsTold } from './sessions/app-brief.js';
import { keepLeadingFrame } from './sessions/queue-edit-frame.js';
import { assertDemoAdmission, demoAdmissionClosed, DemoAdmissionClosedError } from './sessions/demo-admission.js';
import { noteTaskInput } from './sessions/task-input-clock.js';
import { recordQueuedRow } from './sessions/delivery-ledger.js';
import { noteQueueExit, type ExitNote } from './session-queue-exits.js';

// ── Types and store (session-queue-store.ts) ──

export type { MessageStatus, QueuedMessage } from './session-queue-store.js';
export { QueueNotStoredError, resetCache } from './session-queue-store.js';
// The dead-letter API and the identity move (session-queue-park.ts), re-exported: callers know one module.
export {
  MAX_PENDING_AGE_MS, parkIfQueued, parkMessages, parkStalePending, unparkMessage, unparkAgentWaitRows, unparkRowsAhead, sessionsWithAgentWaitRows, type ParkCause,
  START_RECOVERY_HELD_REASON, holdForStartRecovery, startRecoveryHeld, sessionsWithStartRecoveryHeld, settleStartRecoveryHeld, removeStartRecoveryRows,
  migrateSessionQueue, rollbackSessionQueueMigration, type SessionQueueMigration,
} from './session-queue-park.js';
// The lines that went out (session-queue-lines.ts): rows the CLI took, rows put back unconfirmed.
export { removeTaken, requeueUnanswered, revertIfQueued, settledLineUuid, unmarkUnwritten } from './session-queue-lines.js';

// ── Public API ──

/**
 * Load the queue from disk into memory. Call once at startup.
 * Resets any 'processing' messages back to 'pending' (crash recovery), and puts back the rows a
 * host hand left on the way (session-queue-transit.ts). A row
 * keeps its `lineUuid` and `lineTries`, so its next delivery goes out alone
 * under the same uuid and asks the daemon first: a line a live CLI already holds
 * is not written to it again.
 */
export async function loadQueue(): Promise<void> {
  resetCache(); // force re-read from disk
  const changed = await mutateStore((s) => {
    let dirty = false;
    for (const [, msgs] of Object.entries(s.queues)) {
      for (const msg of msgs) {
        if (msg.status === 'processing') {
          msg.status = 'pending';
          // The server died mid-delivery: the line may be in a CLI (QueuedMessage.lineInDoubt).
          if (msg.lineUuid) msg.lineInDoubt = true;
          dirty = true;
        }
      }
    }
    return dirty;
  });
  if (changed) {
    log.session.info('reset processing messages to pending after restart');
  }
  // Lines an earlier server was handing to a host when it died are queued here again (a switch's
  // rows wait for the switch resume, engine-switch-watch.ts): session-queue-transit.ts.
  const { settleStrandedTransits } = await import('./session-queue-transit.js');
  await settleStrandedTransits().catch(() => 0);
  // Rows an enqueue put in the spool when the queue write failed (session-queue-spool.ts).
  const { drainQueueSpool, spoolMayHoldRows, watchQueueSpool } = await import('./session-queue-spool.js');
  if (spoolMayHoldRows()) await drainQueueSpool().catch(() => 0);
  // Another process's spool (the `walnut start` CLI's, whose own clock died with it) is merged too.
  watchQueueSpool();
}

/**
 * Enqueue a message for a session. Persists immediately.
 * Returns the queued message (with generated ID).
 *
 * `opts.id` — caller-supplied stable message id (e.g. the cloud relay's
 * `qm-mobile-*`). IDEMPOTENT: if a row with this id is already queued for the
 * session, that row is returned unchanged instead of enqueuing a duplicate.
 * This is the exactly-once anchor for phone sends: a bridge-relay replay (the
 * daemon died after the primary enqueued but before the ack reached the
 * phone, so the phone retried) collapses onto the original row, and queue
 * redelivery after a daemon respawn delivers it once.
 */
/**
 * Told the session of every row this queue stores anew (session-channel/leader-boot.ts installs it
 * on a leader while any host runs its sessions: a host's fact may name only its own session's rows,
 * handed-sessions.ts linesNotOthers). Null elsewhere: nothing is called.
 */
let rowLedger: ((sessionId: string, id: string) => void) | null = null
export function setQueuedRowLedger(fn: ((sessionId: string, id: string) => void) | null): void {
  rowLedger = fn
}

export async function enqueueMessage(
  sessionId: string,
  message: string,
  opts?: { id?: string; userUuid?: string; stopFence?: string | null; relayTaken?: boolean; lineUuid?: string; closesPrompt?: boolean; sentBy?: 'person' | 'agent'; recentText?: string; heldReason?: string;
    /** A person's send: its dictations (QueuedMessage.dictation). */
    dictation?: SentDictation;
    /** With heldReason: the readiness kind the row waits on (QueuedMessage.waitsFor). */
    waitsFor?: string;
    /** With heldReason: a cold hold's send (QueuedMessage.coldSend). */
    coldSend?: { source: string; endsWait?: true };
    /**
     * With `id`: this queue takes the id once, ever (within the fates' horizon, relay-fates.ts):
     * its 'taken' fate is written with its row, and a later enqueue of the id, after the row ran or
     * went, queues nothing. A host's queue takes its leader's rows so, and a resend is a no-op.
     */
    onceById?: boolean;
    /** Who sent it and its task, for the delivery ledger only (sessions/delivery-ledger.ts recordQueuedRow). */
    source?: string; taskId?: string },
): Promise<QueuedMessage> {
  // A stopping Demo queues nothing more (sessions/demo-admission.ts); checked again inside the write.
  assertDemoAdmission();
  if (opts?.id?.startsWith('qm-inbox-') && !opts.id.startsWith('qm-inbox-ai-')) {
    const { validateInboxMessageBoundary } = await import('./human-inbox/item-execution.js');
    await validateInboxMessageBoundary(sessionId, opts.id);
  }
  const { sessionStops, SessionStopSupersededError } = await import('./sessions/session-stop.js');
  const stopFence = await sessionStops.fence(sessionId);
  if (opts?.stopFence !== undefined && opts.stopFence !== stopFence) {
    throw new SessionStopSupersededError('Message predates the latest stop; send a new message to continue');
  }
  // A resend of a message that already went out (a Retry, the phone's same-id
  // resend) keeps that line's uuid: the CLI then skips it if it already ran it.
  const inherited = opts?.lineUuid ?? (opts?.id ? await settledLineUuid(opts.id) : undefined);
  const msg: QueuedMessage = {
    id: opts?.id ?? generateId(),
    ...(stopFence ? { stopFence } : {}),
    sessionId,
    message,
    status: opts?.heldReason ? 'parked' : 'pending',
    ...(opts?.heldReason ? { parkedAt: new Date().toISOString(), parkedReason: opts.heldReason, ...(opts.waitsFor ? { waitsFor: opts.waitsFor } : {}), ...(opts.coldSend ? { coldSend: opts.coldSend } : {}) } : {}),
    enqueuedAt: new Date().toISOString(),
    seq: nextEnqueueSeq(),
    // Additive: absent ⇒ the key never lands on the row, so an old-shaped row and
    // a new-shaped one are byte-identical on disk.
    ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
    ...(inherited ? { lineUuid: inherited, lineTries: 1 } : {}),
    ...(opts?.closesPrompt ? { closesPrompt: true as const } : {}),
    ...(opts?.sentBy ? { sentBy: opts.sentBy } : {}),
    ...(opts?.dictation?.ids.length ? { dictation: opts.dictation } : {}),
  };
  // Every row is on disk (synced) before its sender hears "queued" (2026-11-23, the user: a
  // message is never lost, a restart or crash included). A row only the cache held, flushed a
  // moment later, was lost by a crash in that moment while its sender had been told it was
  // queued. A failed write is tried again; then the row goes to the spool (session-queue-spool.ts),
  // or, for a row whose fate goes with it (relayed, once-only), its sender is told
  // (QueueNotStoredError) and sends again.
  const write = (s: QueueStore): EnqueueOutcome => {
    if (demoAdmissionClosed()) return { queueDepth: 0, existing: null, refused: true };
    if (!s.queues[sessionId]) {
      s.queues[sessionId] = [];
    }
    // Taken once already, and no longer queued: it ran (or went), never a second time.
    if (opts?.onceById && opts.id && fateOf(s, opts.id) === 'taken' && !s.queues[sessionId].some((m) => m.id === opts.id)) {
      return { queueDepth: s.queues[sessionId].length, existing: null, ranAlready: true };
    }
    // A phone message the companion relayed, a row taken once: its fate is written with its row.
    if ((opts?.relayTaken || opts?.onceById) && opts.id) setFate(s, opts.id, 'taken');
    if (opts?.id) {
      const existing = s.queues[sessionId].find((m) => m.id === opts.id);
      if (existing) return { queueDepth: s.queues[sessionId].length, existing };
    }
    // This row's own earlier try landed (its write threw after the rename): not a second copy.
    if (s.queues[sessionId].some((m) => m.id === msg.id)) return { queueDepth: s.queues[sessionId].length, existing: null };
    s.queues[sessionId].push(msg);
    return { queueDepth: s.queues[sessionId].length, existing: null };
  };
  const spool = await import('./session-queue-spool.js');
  // A resend of an id the spool holds is that row.
  if (opts?.id && spool.spoolMayHoldRows()) {
    const spooled = await spool.spooledRow(opts.id);
    if (spooled?.sessionId === sessionId) return spooled;
  }
  const outcome = await storeRow(sessionId, msg, write, !(opts?.relayTaken || opts?.onceById));
  if (outcome.refused) throw new DemoAdmissionClosedError();
  if (outcome.ranAlready) {
    log.session.info('message enqueue skipped: this queue took the id once already', { sessionId, messageId: msg.id });
    return msg;
  }
  if (outcome.existing) {
    log.session.info('message enqueue deduped by id (already queued)', {
      sessionId, messageId: outcome.existing.id, queueDepth: outcome.queueDepth,
    });
    return outcome.existing;
  }
  if (msg.sentBy === 'person' && !inherited) noteRecentHumanMessage(sessionId, opts?.recentText ?? message, msg.enqueuedAt);
  if (rowLedger) try { rowLedger(sessionId, msg.id) } catch { /* the ledger logs its own failures */ }
  // Every row stored anew is a step of the delivery ledger here, whichever path queued it (a raw
  // enqueue emits no SESSION_MESSAGE_QUEUED: 2026-11-24 audit, a person's words had no row).
  void recordQueuedRow({ id: msg.id, sessionId, ...(opts?.source ? { source: opts.source } : {}), ...(opts?.taskId ? { taskId: opts.taskId } : {}), ...(msg.sentBy ? { sentBy: msg.sentBy } : {}) });
  log.session.info('message enqueued', { sessionId, messageId: msg.id, queueDepth: outcome.queueDepth });
  // A write that works takes what an earlier failed one left in the spool.
  if (!outcome.spooled && spool.spoolMayHoldRows()) void spool.drainQueueSpool().catch(() => 0);
  return msg;
}

type EnqueueOutcome = { queueDepth: number; existing: QueuedMessage | null; refused?: true; ranAlready?: true; spooled?: true };

/** Tries of the queue write before the spool: a lock timeout already waited minutes, so it goes there at once. */
const ENQUEUE_RETRY_MS = [100, 500];

/**
 * Write `msg` with `write` (strict, synced), trying a failed write again. A write that reached
 * the disk and then threw counts as written (the file is read back for the row, so its sender
 * never sends a second copy). Still not written: into the spool when `spoolable`, else
 * QueueNotStoredError.
 */
async function storeRow(sessionId: string, msg: QueuedMessage, write: (s: QueueStore) => EnqueueOutcome, spoolable: boolean): Promise<EnqueueOutcome> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await mutateStore(write, true, true, true);
    } catch (err) {
      last = err;
      // Read back: a row that is there was written. A read that fails says nothing (the next try,
      // which skips a row already there, finds out), never "absent".
      const onDisk = await readQueueFileFresh({ readErrors: 'throw' }).then((s) => s.queues[sessionId]?.some((m) => m.id === msg.id), () => false);
      if (onDisk) return { queueDepth: 0, existing: null };
      if (err instanceof FileLockTimeoutError || attempt >= ENQUEUE_RETRY_MS.length) break;
      await new Promise((r) => setTimeout(r, ENQUEUE_RETRY_MS[attempt]));
    }
  }
  if (spoolable) {
    // The gate the write itself checks: a stopping Demo spools nothing.
    if (demoAdmissionClosed()) throw new DemoAdmissionClosedError();
    try {
      const { spoolRow } = await import('./session-queue-spool.js');
      await spoolRow(msg);
      return { queueDepth: 0, existing: null, spooled: true };
    } catch (err) {
      log.session.error('session message queue: the row could not be spooled either', { sessionId, messageId: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new QueueNotStoredError(last);
}

/**
 * Enqueue `message` until it is stored, however long the disk fails: for a line Walnut itself
 * carries whose start already happened (an ACP session spawned for it), where throwing would
 * lose the line or start the session twice. Each try is enqueueMessage's own (retries, spool).
 */
export async function enqueueUntilStored(sessionId: string, message: string, opts?: Parameters<typeof enqueueMessage>[2]): Promise<QueuedMessage> {
  // One id for every try: a try whose write landed unseen is the same row, never a second one.
  const once = { ...opts, id: opts?.id ?? generateId() };
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      return await enqueueMessage(sessionId, message, once);
    } catch (err) {
      if (!(err instanceof QueueNotStoredError)) throw err;
      log.session.warn('a line Walnut carries could not be stored yet; trying again', { sessionId, waitMs: wait, error: err.message });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Who sent a row (QueuedMessage.sentBy), and the sources a person types into.
export { PERSON_SEND_SOURCES, queueSentBy } from './sessions/send-sent-by.js';

/**
 * Enqueue a message AND notify session-runner + UI in one call.
 * This is the preferred entry point for sending messages to sessions.
 * Callers should use this instead of manually emitting SESSION_SEND + SESSION_MESSAGE_QUEUED.
 *
 * @param opts.source - identifies who sent the message (e.g. 'ui', 'agent', 'phase-hook')
 * @param opts.taskId - optional task ID associated with the session
 * @param opts.mode - optional permission mode override for the session
 * @param opts.interrupt - if true, interrupt the current turn before sending
 * @param opts.enqueueMessage - if provided, enqueue this text (may include image refs);
 *   the original `message` is used for bus events (UI display). Defaults to `message`.
 * @param opts.messageId - caller-supplied stable id (cloud relay `qm-mobile-*`).
 *   Idempotent: a duplicate id collapses onto the already-queued row (see
 *   enqueueMessage) so bridge replays / phone retries can't double-deliver.
 * @param opts.userUuid - pre-assigned v4 uuid for the CLI's user line (see
 *   QueuedMessage.userUuid). Optional; absent changes nothing.
 */
/**
 * With the org off (Settings → Org), Walnut's own background turns never reach Main or a VP
 * (org/org-enabled.ts ORG_OFF_BLOCKED_SOURCES). A backstop: each such path has its own gate.
 * Cheap while the org is on, which is almost always.
 */
async function refuseOrgDeliveryWhileOff(sessionId: string, source: string | undefined, taskId: string | undefined): Promise<void> {
  const { orgEnabledCached, isOrgEnabled, isOrgNode, ORG_OFF_BLOCKED_SOURCES, OrgOffError } = await import('./org/org-enabled.js');
  if (!source || !ORG_OFF_BLOCKED_SOURCES.has(source) || orgEnabledCached() || await isOrgEnabled()) return;
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  const id = taskId ?? (await getSessionByClaudeId(sessionId).catch(() => null))?.taskId;
  if (!id) return;
  const { getTask } = await import('./task-manager.js');
  const task = await getTask(id).catch(() => null);
  if (!isOrgNode(task)) return;
  log.session.info('org off: background turn not sent to an org node', { sessionId, taskId: id, source });
  throw new OrgOffError();
}

export async function sendMessageToSession(
  sessionId: string,
  message: string,
  opts?: {
    source?: string;
    taskId?: string;
    mode?: string;
    interrupt?: boolean;
    enqueueMessage?: string;
    messageId?: string;
    userUuid?: string;
    stopFence?: string | null;
    /** A phone message relayed by the companion (DaemonConnection): its fate goes with its row. */
    relayTaken?: boolean;
    /** A resend of a line that already went out keeps its uuid (see QueuedMessage.lineUuid). */
    lineUuid?: string;
    /** Answers a pending permission prompt although no person typed it (a leader answering its worker's question). */
    closesPrompt?: boolean;
    /** What a waiting task waited for (SessionSendEvent.endsWait). */
    endsWait?: boolean;
    /** The text already went through the hint pipeline (hints/hint-send.ts prepareHintedSend): enqueued as it is. */
    hinted?: boolean;
    /** Asked right before the row is stored: false drops the send (SendNoLongerWantedError). */
    stillWanted?: () => boolean;
    /** A person's send: the recordings dictated into it and the box's text (stt/dictation-ids.ts), kept on its row. */
    dictation?: SentDictation;
    /**
     * Told the moment the row is on disk (or met the same id already queued), before anything else
     * this send waits for: the send is durable from here. A scheduled routine marks its run sent
     * here (cron/sent-run.ts). Every row is stored strictly (enqueueMessage): a disk failure throws
     * instead of leaving the row in the cache for a later flush, which a kill would lose. Never called for
     * a notice that rides the next message (held-notices.ts holds it). Called, never awaited; a throw is only logged.
     */
    onStored?: (msg: QueuedMessage) => void;
    /** Line it up for after the running turn instead of writing it into the live CLI: it can be edited or withdrawn until then (sessions/queue-after-turn.ts). */
    afterTurn?: boolean;
    /**
     * Why this notice must start a turn although its kind asks nothing (sessions/wake-policy.ts):
     * e.g. a lead's team note that names a task waiting on it (org/lead-waits.ts). Without it, a
     * message of notices that ask nothing is held for the session's next message.
     */
    wakeReason?: string;
    /**
     * Store the line as it is, with none of Walnut's notes in front of it and no held row put back in
     * line with it (they wait for the next message): a quiet turn's line (held-notices-sweep.ts), which
     * a rider would turn into a line that is not its row alone.
     */
    bare?: boolean;
  },
): Promise<QueuedMessage> {
  // A stopping Demo takes no send, a timer's wake or retry included, before any side effect (sessions/demo-admission.ts).
  assertDemoAdmission();
  // A person's source from a browser under automation goes on as an agent's (sessions/automated-client.ts).
  if (opts?.source && sendSourceOf(opts.source) !== opts.source) opts = { ...opts, source: sendSourceOf(opts.source) };
  // A person's own words: they are using Walnut, so a live update waits (idle-gate.ts).
  if (queueSentBy(opts?.source) === 'person') noteUserActivity();
  // A send of anything but the quiet turn's own ends that quiet turn now, before any reader of
  // this send's edges asks (sessions/quiet-turn.ts).
  noteQuietTurnSend(sessionId, opts?.source);
  const { bus, EventNames } = await import('./event-bus.js');
  // A session an engine switch replaced never takes a message: it goes to the
  // task's active session (sessions/engine-switch.ts).
  const { activeSessionFor, movingFrom } = await import('./sessions/engine-switch.js');
  sessionId = await activeSessionFor(sessionId, opts?.messageId);
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  const areaRecord = await getSessionByClaudeId(sessionId);
  // Something went into the task's session: a stop after it is news to its lead (sessions/task-input-clock.ts).
  // Taken back, with the lead traffic stamp below, when the send then stores nothing (dropMarks).
  const unnoteInput = noteTaskInput(areaRecord?.taskId ?? opts?.taskId);
  let unnoteTraffic = (): void => {};
  /**
   * A send that stores nothing leaves none of the marks that say it went in. Kept as they are: the
   * person's activity (they did use Walnut) and the end of a quiet turn (sessions/quiet-turn.ts: its
   * unsent row is already taken back; the next idle turn end schedules another).
   */
  const dropMarks = (): void => { unnoteTraffic(); unnoteInput(); };
  // Every throw from here until the row is stored (a refusal below, a note that failed, a gate
  // the deadline shut) takes the marks back; one after it keeps them, the row went in.
  let stored = false;
  try {
    // The router's wake passes only inside router/wake.ts's own grant, into a router session.
    const { assertAreaDelivery } = await import('./router/delivery-scope.js');
    const scopedArea = assertAreaDelivery(areaRecord, sessionId, opts?.source, opts?.messageId);
    await refuseOrgDeliveryWhileOff(sessionId, opts?.source, opts?.taskId);
    // Its task is moving to another host: the row is held here and goes with the task.
    const { MOVE_HELD_REASON } = await import('./sessions/engine-switch-io.js');
    const heldForMove = movingFrom({ sessionId }) ? MOVE_HELD_REASON : undefined;
    // A message lined up for after the running turn waits in the queue, parked, until that turn ends.
    const { AFTER_TURN_REASON, holdsForRunningTurn, noteAfterTurnHold } = await import('./sessions/queue-after-turn.js');
    const heldForTurn = !heldForMove && opts?.afterTurn === true && opts?.interrupt !== true && await holdsForRunningTurn(sessionId)
      ? AFTER_TURN_REASON : undefined;
    // A task that moved since its session was told rides a place note on this
    // message, in the same row, so it never costs a turn (sessions/place-notice.ts).
    const { pendingPlaceNotice } = await import('./sessions/place-notice.js');
    const place = scopedArea ? null : await pendingPlaceNotice(sessionId);
    // A restart that killed the session's process rides the same way, on
    // whichever message reaches it first (sessions/restart-notice.ts).
    const { pendingRestartNotice } = await import('./sessions/restart-notice.js');
    const restart = await pendingRestartNotice(sessionId);
    // A session Walnut moved out of a folder that was gone hears so the same way (sessions/folder-gone.ts).
    const { pendingFolderMovedNotice } = await import('./sessions/folder-gone.js');
    const folderMoved = await pendingFolderMovedNotice(sessionId);
    // An engine switch with no message ran no turn: the context it carried leads this message (sessions/engine-switch-io.ts).
    const { pendingSwitchContext } = await import('./sessions/engine-switch-io.js');
    const switchContext = scopedArea ? null : await pendingSwitchContext(sessionId);
    // One task's message to another is stamped first, so a lead's team note never repeats what this
    // message tells it (org/lead-traffic.ts).
    const { noteQueuedMessage } = await import('./org/lead-traffic.js');
    if (!scopedArea) unnoteTraffic = await noteQueuedMessage(sessionId, opts?.enqueueMessage ?? message);
    // The main agent's org update rides the same way: one folded note, never a turn (org/org-store.ts).
    const { pendingOrgDigest } = await import('./org/org-store.js');
    const digest = scopedArea ? null : await pendingOrgDigest(sessionId);
    // A status change of a task it asked something rides the same way (sessions/status-push.ts).
    const { pendingLiveStatusNote } = await import('./sessions/status-push.js');
    const statusNote = scopedArea ? null : await pendingLiveStatusNote(sessionId);
    // Every message is escaped, and a turn nobody typed still carries the message
    // hints a human send would (hints/hint-send.ts), unless its sender composed them.
    const { prepareQueuedHintedSend } = await import('./hints/hint-send.js');
    const rawBody = opts?.enqueueMessage ?? message;
    // What a plugin App shows (an editor, a test run) rides the same way: what
    // changed since this session last read it, never a turn (sessions/app-state.ts).
    const { pendingAppState } = await import('./sessions/app-state.js');
    const appState = scopedArea ? null : await pendingAppState(sessionId, rawBody);
    // A peer's message into a waiting task says the wait comes back (task-wait-resume.ts).
    const { waitNoteFor } = await import('./task-wait-resume.js');
    const waitNote = await waitNoteFor(sessionId, opts?.source, opts?.endsWait === true);
    // A lead that handed its project over hears so on every message that still reaches it (org/retired-lead.ts).
    const { pendingRetiredLeadNote } = await import('./org/retired-lead.js');
    const retiredNote = scopedArea ? null : await pendingRetiredLeadNote(sessionId, rawBody);
    // A background notice that waited for this message rides in front of it (sessions/held-notices.ts).
    const { pendingHeldNotices } = await import('./sessions/held-notices.js');
    const heldNotes = scopedArea ? null : await pendingHeldNotices(sessionId);
    // An answer given for the user that was taken back, which its task has not heard yet (sessions/ask-withdraw.ts).
    const { pendingWithdrawnNote } = await import('./sessions/ask-withdraw.js');
    const withdrawn = await pendingWithdrawnNote(sessionId);
    // Whatever a person did not type is framed here, so the transcript says who sent it (sessions/send-frame.ts).
    const framedBody = frameForSource(rawBody, opts?.source);
    const outputMode = opts?.hinted ? null : await prepareQueuedHintedSend(sessionId, opts?.source, framedBody);
    const body = outputMode?.enqueueText ?? framedBody;
    // A slash command must start its line or the CLI no longer reads it as one: Walnut's notes wait
    // for the next message (each is told only when the row holds it, below).
    const slashCommand = body.trimStart().startsWith('/');
    // A line that goes as it is, with no note of Walnut's in front of it (a slash command, or a quiet
    // turn's line, opts.bare): those notes, and the held rows a send puts back in line, wait for the next message.
    const bare = slashCommand || opts?.bare === true;
    // App state leads: an App's AI-only brief counts only at the head of a line (lib/ai-only-envelope.ts).
    // Every word of Walnut's notes sits inside an envelope: loose words in front of the body read as the
    // person's (sessions/send-frame.ts frameLooseText). A note with nothing loose is unchanged.
    const rider = (t: string | null | undefined): string | undefined => (t ? frameLooseText(t) : undefined);
    const notes = [appState?.text, place?.text, folderMoved?.text, restart?.text, digest?.text, statusNote?.text, heldNotes?.text, withdrawn?.text, waitNote, retiredNote].map(rider).filter(Boolean).join('\n\n');
    const lead = [notes, rider(switchContext?.text)].filter(Boolean).join('\n\n');
    const enqueueText = lead && !bare ? `${lead}\n\n${body}` : body;
    /** Mark told each note `carrier` (stored as row `rowId`) holds; App state and held notices it does not are put back. */
    const tellCarried = async (carrier: string, rowId?: string): Promise<void> => {
      // Each note as the row holds it (framed where it had loose words).
      const holds = (t: string): boolean => !!t && carrier.includes(rider(t)!);
      if (place?.text && carrier.startsWith(rider(place.text)!)) await place.markTold();
      if (digest && holds(digest.text)) await digest.markTold();
      if (restart && holds(restart.text)) await restart.markTold();
      if (folderMoved && holds(folderMoved.text)) await folderMoved.markTold();
      if (switchContext && holds(switchContext.text)) await switchContext.markTold();
      if (statusNote && holds(statusNote.text)) statusNote.markTold();
      if (withdrawn && holds(withdrawn.text)) await withdrawn.markTold();
      if (appState) {
        if (holds(appState.text)) appState.markTold();
        else appState.release();
      }
      if (heldNotes) {
        // Off the file once the row that carries them is stored (held-notices.ts): never awaited.
        if (carrier && holds(heldNotes.text)) heldNotes.markTold(rowId);
        else heldNotes.release();
      }
    };
    // Nothing but notices that ask nothing: never written to the CLI on its own, not even into a running
    // turn (a line that reaches the CLI as its turn ends starts a turn of its own: 2026-11-16, three
    // waiting / stopped notices into the Walnut VP 1 to 5 s after its last words, each an agent-ack
    // turn). It is held and rides in front of the session's next message (sessions/wake-policy.ts);
    // Walnut's other notes and hints wait, as they are, for that message.
    const { rowRides, holdRidingNotice } = await import('./sessions/wake-policy.js');
    // A person's words, and a browser under automation's (an agent's now, still a message to act on),
    // are never held for later: not as a riding notice, not for a cold session's next wake.
    const personWords = PERSON_SEND_SOURCES.has(opts?.source ?? '') || opts?.source === AUTOMATED_SEND_SOURCE
      || queueSentBy(opts?.source) === 'person';
    if (!opts?.wakeReason && !opts?.interrupt && !heldForMove && !heldForTurn && !personWords && rowRides(framedBody)) {
      await tellCarried('');
      if (opts?.stillWanted && !opts.stillWanted()) throw new SendNoLongerWantedError();
      stored = true;
      // Held in memory now and written to the held-notices file behind it, never awaited.
      void holdRidingNotice(sessionId, framedBody);
      log.session.info('notice rides the next message: it asks nothing', { sessionId, source: opts?.source });
      const now = new Date();
      return { id: opts?.messageId ?? `rides-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, sessionId, message: framedBody, status: 'pending', enqueuedAt: now.toISOString(), seq: 0 };
    }
    // Cache-aware delivery (sessions/cold-hold.ts): a message that can wait, to a session gone cold, is
    // held for its next wake. Any other send first puts the held ones back in line in front of it, so
    // they go out with it in one line.
    const coldHold = await import('./sessions/cold-hold.js');
    const { waitsWhenCold } = await import('./sessions/wake-policy.js');
    const mayWait = !opts?.wakeReason && !opts?.interrupt && !opts?.closesPrompt && !heldForMove && !heldForTurn && !scopedArea
      && !slashCommand && !personWords
      && !opts?.messageId?.startsWith('qm-inbox-') && !opts?.messageId?.startsWith('qm-route-') && waitsWhenCold(framedBody, opts?.source);
    const heldCold = mayWait && await coldHold.sessionIsCold(sessionId) ? coldHold.COLD_HOLD_REASON : undefined;
    // Not in front of a slash command (it must start its line), nor for a move or a running turn's
    // hold: those rows wait for the next line that goes, or the sweep sends them.
    const released = heldCold || heldForMove || heldForTurn || bare ? null : await coldHold.releaseColdHolds(sessionId, 'a message that goes now');
    let msg: QueuedMessage;
    try {
      if (opts?.stillWanted && !opts.stillWanted()) throw new SendNoLongerWantedError();
      msg = await enqueueMessage(sessionId, enqueueText, {
        id: opts?.messageId,
        recentText: message,
        ...(opts?.stopFence !== undefined ? { stopFence: opts.stopFence } : {}),
        ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
        ...(opts?.relayTaken ? { relayTaken: true } : {}),
        ...(opts?.lineUuid ? { lineUuid: opts.lineUuid } : {}),
        ...(opts?.closesPrompt || isPersonSendSource(opts?.source) ? { closesPrompt: true } : {}),
        ...(queueSentBy(opts?.source) ? { sentBy: queueSentBy(opts?.source) } : {}),
        ...(opts?.dictation && queueSentBy(opts?.source) === 'person' ? { dictation: opts.dictation } : {}),
        ...(heldForMove || heldForTurn ? { heldReason: heldForMove ?? heldForTurn } : {}),
        ...(heldCold ? { heldReason: heldCold, coldSend: { source: opts?.source ?? 'unknown', ...(opts?.endsWait ? { endsWait: true as const } : {}) } } : {}),
        ...(opts?.source ? { source: opts.source } : {}), ...(opts?.taskId ? { taskId: opts.taskId } : {}),
      });
    } catch (err) {
      appState?.release();
      heldNotes?.release();
      // Held rows this send put back in line go out on their own.
      if (released?.count) coldHold.sendReleased(sessionId, released);
      throw err;
    }
    stored = true;
    if (opts?.onStored) {
      try { opts.onStored(msg); } catch (err) { log.session.warn('onStored hook threw', { sessionId, messageId: msg.id, error: err instanceof Error ? err.message : String(err) }); }
    }
    const source = opts?.source ?? 'unknown';
    // An ask into a lead's team from outside it (the user, the main agent, another team) is the
    // lead's to know: its next team note lists it (org/team-asks.ts). Fire and forget.
    // A test run's words are never the user's (test-run.ts): read now, while the request is surely open.
    if (!scopedArea && ambientTestRun() === undefined) {
      void import('./org/team-asks.js').then((m) => m.noteTeamAsk(sessionId, message, rawBody, opts?.source, msg.id)).catch(() => {});
    }
    // A repeat collapsed onto the row already queued: only the row that holds the note counts.
    await tellCarried(msg.message, msg.id);
    if (outputMode && msg.message.includes(outputMode.enqueueText)) await outputMode.commit();

    // Ask Walnut drift repair — AWAITED before SESSION_SEND is emitted, because
    // the record profile is consumed exactly when this send triggers a cold
    // --resume (resolveResumeArgs); a fire-and-forget would lose that race and
    // ship the stale persona one more spawn. Cheap by construction: an ordinary
    // session pays one indexed record read and early-returns; only a real
    // Ask-Walnut session rebuilds, at most once per TTL. Never fails a send —
    // the helper catches everything internally.
    try {
      const { refreshWalnutSessionProfile } = await import('./sessions/personal-ai-lane.js');
      await refreshWalnutSessionProfile(sessionId);
    } catch { /* stale persona until next attempt */ }

    // Again at the edge itself: a quiet turn begun while this send was on its way is no longer quiet
    // when any reader of this edge asks.
    noteQuietTurnSend(sessionId, opts?.source);
    // A repeat collapsed onto a row already queued is no hold of this call.
    const holdsRow = heldForTurn !== undefined && msg.status === 'parked' && msg.parkedReason === heldForTurn;
    if (holdsRow) noteAfterTurnHold(sessionId);
    const holdsCold = heldCold !== undefined && coldHold.isColdHold(msg);
    const heldShown = holdsCold ? await coldHold.heldViewOf(sessionId, msg.id) : undefined;
    if (holdsCold) {
      coldHold.noteColdHold(sessionId);
      log.session.info('cold hold: message held for the session\'s next wake', { sessionId, messageId: msg.id, source });
    }
    // A row held here is a step of its own in the delivery ledger (sessions/delivery-ledger.ts), so a wait
    // of up to an hour reads as held, and why, not as queued (2026-11-23 audit).
    if (holdsCold || holdsRow) {
      const why = holdsCold ? `held for the session's next wake (it is cold), at the latest ${heldShown?.heldRetryAt ?? 'within the hour'}` : 'held for the end of the running turn';
      void import('./sessions/delivery-ledger.js').then((l) => l.recordDelivery({ step: 'parked', id: msg.id, sessionId, why, via: 'wait' })).catch(() => {});
    }

    // Tell session-runner to process the queued message (a row held for a move, for the turn's end or
    // for a cold session's next wake waits for it). Held rows that went back in line in front of it and
    // end the task's wait (a watcher's news) end it with this send.
    if (!heldForMove && !holdsRow && !holdsCold && !demoAdmissionClosed()) bus.emit(EventNames.SESSION_SEND, {
    sessionId,
    taskId: opts?.taskId,
    message,
    mode: opts?.mode,
    interrupt: opts?.interrupt || undefined,
    ...(opts?.endsWait || released?.endsWait ? { endsWait: true } : {}),
  }, ['session-runner'], { source });
    // A session its host runs and judges keeps its holds there: the held row goes to the host now,
    // whose own queue-after-turn and cold hold release it (sessions/handed-holds.ts). After the emit:
    // a held row starts no send here, and nothing of this reaches a host before a send that goes.
    if (holdsRow || holdsCold) {
      const { handHeldRowsToHost } = await import('./sessions/handed-holds.js');
      handHeldRowsToHost(sessionId);
    }

    // Tell UI so the message appears immediately in the session panel. A quiet turn's row is Walnut's
    // own upkeep, not a message: the panel shows its note instead, and its history row says what it was.
    // A kept quiet row carries someone's words: shown like any Walnut notice, so a Stop's Retry reaches it.
    if (!isQuietRowId(msg.id) || isKeptQuietRowId(msg.id)) bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
      sessionId,
      messageId: msg.id,
      message,
      source,
      ledgered: true,
      ...(msg.sentBy ? { sentBy: msg.sentBy } : {}),
      // An agent's row as stored: a peer's note is enveloped only here (`message`
      // is its bare text), and the panel shows and folds the card it will become.
      ...(msg.sentBy === 'agent' && msg.message !== message ? { queuedText: msg.message } : {}),
      ...(msg.sentBy !== 'agent' && msg.message !== message ? { rowText: msg.message } : {}),
      // The send's user line: the proof the row is that send's when its answer is lost (web api/session-send.ts).
      ...(msg.userUuid ? { userUuid: msg.userUuid } : {}),
      enqueuedAt: msg.enqueuedAt,
      // Voice Accuracy pairs the box's text with these recordings exactly (stt/learn-from-sends.ts). From
      // the row: a resend that collapses onto it, hours later, names them too.
      ...dictationEventFields(msg.dictation),
      ...(heldShown?.heldReason ? { heldReason: heldShown.heldReason, ...(heldShown.heldRetryAt ? { heldRetryAt: heldShown.heldRetryAt } : {}) } : {}),
    }, ['main-ai'], { source });

    return msg;
  } catch (err) {
    if (!stored) dropMarks();
    throw err;
  }
}

/** A send whose `stillWanted` said no before its row was stored: nothing was queued. */
export class SendNoLongerWantedError extends Error {
  constructor() { super('send no longer wanted'); this.name = 'SendNoLongerWantedError'; }
}

/**
 * The revoked host a session runs on, or null (session-channel/revoked-reach.ts `send`): its queue then
 * hands out only a person's own lines; every other row is parked with why (a peer's, a routine's, a
 * recovery's), so nothing automated reaches a host the person revoked. Read only while a ban stands.
 */
async function revokedHostOfSession(sessionId: string): Promise<string | null> {
  const { anyHostRevoked, revokedAs } = await import('./session-channel/revoked-hosts.js');
  if (!anyHostRevoked()) return null;
  // A session's host is read from its row once a minute at most, not on every hand-out (R2-N4).
  const kept = sessionHostSeen.get(sessionId);
  const fresh = !!kept && Date.now() - kept.at < SESSION_HOST_TTL_MS;
  const host = fresh ? kept!.host : (await import('./session-db.js')).sessionJudgeInStore(sessionId)?.host ?? null;
  if (!fresh) sessionHostSeen.set(sessionId, { host, at: Date.now() });
  if (sessionHostSeen.size > 2_000) sessionHostSeen.clear();
  return host && revokedAs(host) ? host : null;
}
const SESSION_HOST_TTL_MS = 60_000;
const sessionHostSeen = new Map<string, { host: string | null; at: number }>();

/** Park every pending row of `queue` a person did not type, on revoked host `host` (revokedHostOfSession). */
function parkAutomatedOnRevoked(queue: QueuedMessage[], host: string | null): void {
  if (!host) return;
  for (const m of queue) {
    if (m.status === 'pending' && m.sentBy !== 'person') parkRow(m, `Not sent: the host ${host} is revoked; only your own messages reach a session already running there. Allow the host again, then Retry.`);
  }
}

/**
 * Mark the next deliverable run of 'pending' messages for a session as 'processing'.
 * Returns the messages that were marked (the batch to send to Claude).
 * Returns empty array if no pending messages.
 *
 * A row carrying a pre-assigned `userUuid` (a question's head row) is never
 * batched: at the head it goes alone, otherwise the run stops before it
 * (splitBatchAtUuid), so every line carries at most one uuid. A uuid row is
 * still delivered while a turn runs: holding it in Walnut's queue hid the user's
 * message from the CLI until the turn ended (2026-10-23, 8 minutes).
 *
 * The batch is one stdin line. Rows that already went out in a line (they carry
 * its `lineUuid`) go out again alone and together, under that uuid; fresh rows
 * never join them. Fresh rows get their line's uuid here, in the same write
 * that marks them, so a crash right after can never send them under another.
 * `tracked`: the CLI they go to reports its queue (QueuedMessage.lineTracked).
 *
 * A quiet turn's row (sessions/quiet-turn.ts, Walnut's idle compaction) goes out
 * only as the live quiet turn's own row, to a CLI between turns (`midTurn` false),
 * with nothing else waiting. Otherwise it is dropped here, in the same write: a
 * stale `/compact` never runs in front of, beside or inside anyone's turn. A kept quiet row of
 * Walnut's tells only (isRidingQuietRowId) past its quiet turn is never taken alone: it waits for
 * the next row and goes in line with it.
 */
export async function markProcessing(
  sessionId: string,
  stopFence?: string | null,
  opts?: { tracked?: boolean; midTurn?: boolean },
): Promise<QueuedMessage[]> {
  // A stopping Demo hands no row to a live write or a cold --resume: the rows stay pending (sessions/demo-admission.ts).
  if (demoAdmissionClosed()) return [];
  const revokedOn = await revokedHostOfSession(sessionId);
  // A session spawned before its default instructions changed learns the changed
  // lines on the first line frozen for it (sessions/instruction-notice.ts). Read before the lock, and
  // only when a fresh row waits to be frozen.
  const routing = await pendingTaskRouting(sessionId);
  const liveQuietRow = quietTurnRow(sessionId);
  const dropped: string[] = [];
  const pending = await mutateStore((s) => {
    if (demoAdmissionClosed()) return [];
    const queue = s.queues[sessionId];
    if (!queue) return [];
    for (let i = queue.length - 1; i >= 0; i--) {
      const m = queue[i]!;
      // A quiet row that carries someone's words is never dropped: past its quiet turn it is a normal row.
      if (m.status !== 'pending' || !isQuietRowId(m.id) || isKeptQuietRowId(m.id)) continue;
      const others = queue.some((o) => o !== m && (o.status === 'pending' || o.status === 'processing'));
      if (m.id === liveQuietRow && !others && !opts?.midTurn) continue;
      queue.splice(i, 1);
      dropped.push(m.id);
    }
    if (queue.length === 0) { delete s.queues[sessionId]; return []; }
    parkAutomatedOnRevoked(queue, revokedOn);
    if (stopFence !== undefined) {
      for (const message of queue) {
        if (message.status !== 'pending' || (message.stopFence ?? null) === stopFence) continue;
        parkRow(message, STOP_PARKED_REASON);
      }
    }
    const pendingRows = queue.filter((m) => m.status === 'pending');
    // Walnut's tells to the session past their quiet turn (quiet-turn.ts RIDING_QUIET_ROW_PREFIX)
    // never go alone: they wait, kept, and ride the next row (a restart's drain included).
    if (pendingRows.length && pendingRows.every((m) => isRidingQuietRowId(m.id) && m.id !== liveQuietRow && isFreshRow(m))) return [];
    const head = pendingRows[0];
    if (!head) return [];
    const run: QueuedMessage[] = [];
    for (const m of pendingRows) {
      if (m.lineUuid !== head.lineUuid) break;
      run.push(m);
    }
    const batch = head.lineUuid ? run : splitBatchAtUuid(run);
    if (routing && isFreshRow(head)) {
      const freshText = staleTriggerText(head.message, head.enqueuedAt, Date.now()) ?? head.message;
      // The whole line counts: Walnut's notes at its head may lead a person's message.
      head.message = routing.apply(freshText, queue, batch.map((m) => (m === head ? freshText : m.message)));
    }
    // A fresh line holds each hint once, however many rows it merges, the last copy kept (it is
    // the newest state), and one threads note: a cleanup joins the filing note, as in one row
    // (hints/hint-send.ts planHints). A row that must stay byte-exact still counts as carrying its blocks.
    if (!head.lineUuid && batch.length > 1) {
      const folded = foldTidyIntoThreads(batch.map((m) => ({ message: m.message, fresh: isFreshRow(m) })));
      batch.forEach((m, i) => { m.message = folded[i]; });
      const seen = new Set<string>();
      for (const m of [...batch].reverse()) {
        if (isFreshRow(m)) m.message = dropRepeatedHintBlocks(m.message, seen);
        else for (const b of hintBlocksIn(m.message)) seen.add(b);
      }
    }
    const lineUuid = head.lineUuid ?? lineUuidFor(batch);
    const now = Date.now();
    for (const m of batch) {
      m.status = 'processing';
      m.lineUuid = lineUuid;
      m.lineTries = (m.lineTries ?? 0) + 1;
      if (opts?.tracked) m.lineTracked = true;
      m.message = staleTriggerText(m.message, m.enqueuedAt, now) ?? m.message;
    }
    return batch;
  }, stopFence !== undefined || dropped.length > 0);
  if (dropped.length) log.session.info('quiet turn row dropped: something else holds the session', { sessionId, rows: dropped });
  if (dropped.includes(liveQuietRow ?? '')) noteQuietTurnDelivery(sessionId, []);
  if (pending.length === 0) return [];
  // The take marker names these rows whichever way the line goes out.
  noteLineCarries(sessionId, pending[0].lineUuid, pending.map((m) => m.id));
  // The quiet turn's (kept) row going into a turn that runs, or in line with others: that turn is a
  // real one, never kept quiet. Ended first, while the row is processing, so nothing sends it again.
  if (liveQuietRow && pending.some((m) => m.id === liveQuietRow) && (opts?.midTurn || pending.length > 1)) endQuietTurn(sessionId, 'mid-turn');
  // A line that is not the quiet turn's own row alone is a real turn (sessions/quiet-turn.ts).
  noteQuietTurnDelivery(sessionId, pending.map((m) => m.id));
  log.session.info('messages batched for delivery', { sessionId, count: pending.length });
  return pending;
}

/** A row never written to the CLI: its bytes are not frozen yet. */
function isFreshRow(m: QueuedMessage): boolean {
  return !m.lineUuid && !m.lineInDoubt && !m.lineTries;
}

/** The instruction notice for the next frozen line, looked up only when a fresh row waits. */
async function pendingTaskRouting(sessionId: string): Promise<PendingInstructionNotice | null> {
  const queue = (await getStore()).queues[sessionId];
  if (!queue?.some((m) => m.status === 'pending' && isFreshRow(m))) return null;
  const { instructionNoticeForSession } = await import('./sessions/instruction-notice.js');
  return instructionNoticeForSession(sessionId);
}

/**
 * Mark only the oldest pending message for a session as processing.
 *
 * ACP providers accept one prompt per turn, so their runner uses this instead
 * of the native Claude batching contract above. Returning an array keeps the
 * scoped remove/revert APIs identical while guaranteeing a cardinality of 0–1.
 */
export async function markNextProcessing(sessionId: string): Promise<QueuedMessage[]> {
  if (demoAdmissionClosed()) return [];
  const routing = await pendingTaskRouting(sessionId);
  const revokedOn = await revokedHostOfSession(sessionId);
  const picked = await mutateStore((s) => {
    if (demoAdmissionClosed()) return null;
    const queue = s.queues[sessionId];
    if (!queue) return null;
    parkAutomatedOnRevoked(queue, revokedOn);
    if (queue.some((message) => message.status === 'processing')) return null;

    const next = queue.find((message) => message.status === 'pending');
    if (!next) return null;

    next.status = 'processing';
    next.message = staleTriggerText(next.message, next.enqueuedAt, Date.now()) ?? next.message;
    if (routing && isFreshRow(next)) next.message = routing.apply(next.message, queue);
    return { next, queueDepth: queue.length };
  });
  if (!picked) return [];
  noteQuietTurnDelivery(sessionId, [picked.next.id]);
  log.session.info('next message selected for delivery', {
    sessionId,
    messageId: picked.next.id,
    queueDepth: picked.queueDepth,
  });
  return [picked.next];
}

/**
 * Remove 'processing' messages for a session (they are now in JSONL history).
 *
 * @param ids - when provided, remove ONLY these message IDs. Delivery points
 *   (FIFO write / mid-turn inject / confirmed --resume spawn) pass the exact
 *   batch they delivered, so a concurrent in-flight batch for the same session
 *   can never be swept away by a stale SESSION_RESULT cleanup (that race
 *   silently lost messages: cleanup removed the in-flight batch, the write
 *   then failed, and revertToPending mutated orphaned objects).
 *   This scoping is also what makes revertToPending's blind re-insert safe —
 *   reverting to un-scoped removal would make that re-insert resurrect
 *   already-delivered messages as duplicates. (See revertToPending.)
 */
export async function removeProcessed(sessionId: string, ids?: string[]): Promise<void> {
  const found = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return null;

    const idSet = ids ? new Set(ids) : null;
    const gone = (m: QueuedMessage) => m.status === 'processing' && (idSet === null || idSet.has(m.id));
    // A phone message among them ran here: recorded in the same write (relay-fates.ts).
    const removed = queue.filter(gone);
    // Inside the lock: no other line gets a notice until this one is recorded as told.
    if (removed.some((m) => leadsWithNotice(m.message))) markNoticeDelivering(sessionId);
    noteDelivered(s, removed);
    for (const m of removed) noteSettledLine(s, m);
    s.queues[sessionId] = queue.filter((m) => !gone(m));
    // Clean up empty queues
    if (s.queues[sessionId].length === 0) {
      delete s.queues[sessionId];
    }
    return removed.map((m) => m.message);
  });
  if (!found) return;
  log.session.debug('message queue drained', { sessionId, scoped: !!ids });
  // A delivered line led by the instruction notice: the session has now been told its lines.
  if (found.some(leadsWithNotice)) {
    const { noteInstructionNoticeDelivered } = await import('./sessions/instruction-notice.js');
    await noteInstructionNoticeDelivered(sessionId, found);
  }
}

/**
 * An App's AI-only brief on a row that will not reach the model (removed, or edited into a
 * command, which goes raw): the next queued row that will takes it, at its head, as the engine
 * switch's context is handed on. False when no such row: the next send carries it again.
 * The notes keep the order they were made in (a "replaced" or "added to" note after the one it
 * follows), so a target before the row puts its own briefs first. `fromAt` is the row's place
 * in `queue` (where it would be, when it was already taken out).
 */
function handOnBrief(queue: QueuedMessage[], from: QueuedMessage, fromAt: number): boolean {
  const at = queue.findIndex((m) => m !== from && m.status === 'pending' && !m.message.trimStart().startsWith('/'));
  if (at === -1) return false;
  const next = queue[at];
  const moved = aiOnlyEnvelopes(from.message).filter((b) => !next.message.includes(b));
  if (moved.length === 0) return true;
  const own = aiOnlyEnvelopes(next.message);
  const ordered = at < fromAt ? [...own, ...moved] : [...moved, ...own];
  next.message = `${ordered.join('\n\n')}\n\n${withoutAiOnly(next.message)}`;
  return true;
}

/**
 * Frozen rows' words as they go out after a stale instruction notice left them (sessions/stale-notice.ts),
 * so the queue holds what the CLI is given: a delivery records nothing of a notice it never sent, and
 * no other row waits behind one in flight. Only a row that still holds the words it was frozen with.
 */
export async function rewriteFrozenRows(sessionId: string, rows: ReadonlyArray<{ id: string; from: string; to: string }>): Promise<void> {
  if (!rows.length) return;
  await mutateStore((s) => {
    let changed = false;
    for (const r of rows) {
      const msg = s.queues[sessionId]?.find((m) => m.id === r.id);
      if (msg && msg.message === r.from) { msg.message = r.to; changed = true; }
    }
    return changed;
  });
}

/**
 * Edit a pending or parked message's text (a parked one is waiting for its owner to send
 * it, so its words are his to change). Returns true on success.
 * Returns false if message not found or already processing.
 */
export async function editMessage(
  sessionId: string, messageId: string, newText: string, opts?: { onlyUnsent?: boolean },
): Promise<boolean> {
  let stored: string | undefined;
  let repaired: SentDictation | undefined;
  let forget: { dictation: SentDictation; message: string } | undefined;
  let droppedBrief = false;
  // An edit from a browser under automation is an agent's words, whoever's row it edits
  // (sessions/automated-client.ts): framed, and it no longer answers the person's prompt.
  const { ambientAutomatedClient, automatedClientLabel } = await import('./sessions/automated-client.js');
  const automated = ambientAutomatedClient();
  if (automated) newText = frameAsWalnut(newText, AUTOMATED_SEND_SOURCE, automatedClientLabel(automated));
  const ok = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;

    const msg = queue.find((m) => m.id === messageId);
    if (!msg || (msg.status !== 'pending' && msg.status !== 'parked')) return false;
    if (opts?.onlyUnsent && (msg.lineUuid || msg.lineTries || msg.lineInDoubt)) return false;

    // Its hint blocks stay (their state is already recorded); the new words are escaped.
    // A slash command stays byte-exact (the CLI reads a command only at the start).
    // An App's AI-only brief on the row stays as it was: the editor saw its fold (lib/ai-only-envelope.ts).
    // Its pictures, files and Walnut's notices in front stay too: the queue card shows only the words
    // (sessions/queue-edit-frame.ts).
    const priorMessage = msg.message;
    if (newText.startsWith('/') && hasAiOnly(msg.message)) droppedBrief = !handOnBrief(queue, msg, queue.indexOf(msg));
    msg.message = newText.startsWith('/') ? newText : replaceHintedText(msg.message, keepAiOnly(msg.message, keepLeadingFrame(msg.message, newText)));
    if (automated) { msg.sentBy = 'agent'; delete msg.closesPrompt; }
    // Its dictations pair with the words that go now: the person's edit is the box text; an agent's
    // words are no one's dictation, and the person's old pairing goes.
    if (msg.dictation) {
      const before = { dictation: msg.dictation, message: priorMessage };
      if (automated) { forget = before; delete msg.dictation; }
      // The queue card edits the composed text: a reference tag in it is Walnut's, not the person's
      // words, so such an edit pairs from the message (never exported).
      else { msg.dictation = { ids: msg.dictation.ids, ...(REF_TAG.test(newText) ? {} : { text: newText }) }; repaired = msg.dictation; }
    }
    stored = msg.message;
    return true;
  });
  if (ok && forget) forgetPairing(forget);
  if (ok && repaired && stored !== undefined) {
    const d = repaired, message = stored;
    void import('./stt/learn-from-sends.js').then((m) => m.noteSentWithDictations(message, d)).catch(() => {});
  }
  // A command goes to the CLI raw: the brief that rode the row is owed again (sessions/app-brief.ts).
  if (ok && droppedBrief) forgetBriefsTold(sessionId);
  // The "Prompt is too long" recovery resends a row as it reaches the session: the edited words.
  if (ok && stored !== undefined) {
    const text = stored;
    void import('./sessions/context-full-recovery.js').then((m) => m.contextFullRecovery()?.noteEdited(sessionId, messageId, text)).catch(() => {});
  }
  return ok;
}

/** A reference tag Walnut composed into a message (<task-ref/>, <session-ref/>, ...). */
const REF_TAG = /<[a-z]+(?:-[a-z]+)*-ref\b/;

/** Voice Accuracy forgets what it paired with a row's dictations: their words did not go as paired. */
function forgetPairing({ dictation, message }: { dictation: SentDictation; message: string }): void {
  void Promise.all([import('./stt/compare/sent-text.js'), import('./stt/learn-from-sends.js')])
    .then(([m, l]) => m.forgetSentByIds(dictation.ids, dictation.text ?? l.withoutHints(message))).catch(() => {});
}

/**
 * Delete a pending or parked message ("Discard"). Returns true on success.
 * Returns false if the message is missing or already processing (in flight —
 * deleting it would race the delivery points' own scoped removal).
 */
export async function deleteMessage(sessionId: string, messageId: string, opts?: { discarded?: boolean; exit?: ExitNote }): Promise<boolean> {
  const { switchContextIn, keepSwitchContext, dropKeptSwitchContext } = await import('./sessions/engine-switch-io.js');
  // The engine switch's carried context on this row, with no other queued row to take it: kept on
  // the session record BEFORE the row goes, so a send in between still carries it (a copy twice is
  // better than none); taken back if the row stays.
  const before = (await getStore()).queues[sessionId] ?? [];
  const target = before.find((m) => m.id === messageId);
  const early = target && target.status !== 'processing' ? switchContextIn(target.message) : null;
  const keptEarly = early && !before.some((m) => m.id !== messageId && m.status === 'pending' && !m.message.trimStart().startsWith('/'))
    ? await keepSwitchContext(sessionId, early) : false;
  let keep: string | null = null;
  let droppedBrief = false;
  let discarded: { dictation: SentDictation; message: string } | undefined;
  const deleted = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;

    const idx = queue.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    if (queue[idx].status === 'processing') return false;

    const [removed] = queue.splice(idx, 1);
    // The step the delivery ledger records for it, when it is not "left the queue unsent" (session-queue-exits.ts).
    if (opts?.exit) noteQueueExit(removed.id, opts.exit.step, opts.exit);
    if (removed.dictation) discarded = { dictation: removed.dictation, message: removed.message };
    // Spliced out: a row now at `idx` or later stood after it.
    if (hasAiOnly(removed.message)) droppedBrief = !handOnBrief(queue, removed, idx - 0.5);
    // The engine switch's carried context rode this row: the next queued row takes it, else the
    // session record keeps it for the next send (engine-switch-io.ts).
    const carried = switchContextIn(removed.message);
    if (carried) {
      const next = queue.find((m) => m.status === 'pending' && !m.message.trimStart().startsWith('/'));
      if (next && !next.message.includes(carried)) next.message = `${carried}\n\n${next.message}`;
      else if (!next) keep = carried;
    }
    if (queue.length === 0) {
      delete s.queues[sessionId];
    }
    // A relayed phone message a person removed: the companion is told so, never
    // "delivered", and never "not received" either (gate r3, M6: a row an older
    // Mac took carries no fate, and "not received" let the companion run it).
    if (fateOf(s, messageId) || isPhoneMessageId(messageId)) setFate(s, messageId, 'removed');
    return true;
  }, false, true);
  if (deleted && keep && !keptEarly) await keepSwitchContext(sessionId, keep);
  // Discarded by the person, never sent: Voice Accuracy forgets the text it paired with its
  // dictations. Other removals (its words carried into a new start, a notice dropped) leave it.
  if (deleted && discarded && opts?.discarded) forgetPairing(discarded);
  // The brief that rode the removed row never reached the model: the next message carries it again.
  if (deleted && droppedBrief) forgetBriefsTold(sessionId);
  if (keptEarly && (!deleted || !keep)) await dropKeptSwitchContext(sessionId);
  return deleted;
}

/**
 * The companion's question for one phone message it relayed here: answered,
 * and the row removed when it may go another way, in ONE durable write
 * (relay-fates.ts withdrawIn). Throws when the write fails, so the companion
 * hears no answer and keeps waiting rather than acting on one never recorded.
 */
export async function withdrawRelayedMessage(sessionId: string, messageId: string): Promise<WithdrawState> {
  return mutateStore((s) => withdrawIn(s, sessionId, messageId), true, true);
}

/** What became of a relayed phone message here (undefined: never seen, or past the horizon). */
export async function relayFateOf(messageId: string): Promise<RelayFate | undefined> {
  return fateOf(await getStore(), messageId);
}

/**
 * Revert specific messages from 'processing' back to 'pending'.
 * Used when delivery fails after markProcessing().
 *
 * NO-LOSS GUARANTEE: if a message is no longer in the store (e.g. a concurrent
 * un-scoped cleanup removed it while this batch was in flight), it is
 * RE-INSERTED, not just mutated. Mutating an orphaned object and persisting
 * would silently drop the message — that was a real loss path.
 *
 * SAFE ONLY BECAUSE removeProcessed is scoped to batch ids: the blind
 * re-insert below trusts that a missing message means delivery genuinely
 * failed. If removeProcessed were reverted to un-scoped (sweeping ALL
 * 'processing'), this re-insert would resurrect messages the CLI already
 * received — duplicates. The two invariants are paired; keep both. (See
 * removeProcessed's @param ids doc for the other direction.)
 */
export async function revertToPending(messages: QueuedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mutateStore((s) => {
    for (const m of messages) {
      if (m.status === 'processing') m.status = 'pending';
      const queue = s.queues[m.sessionId] ?? (s.queues[m.sessionId] = []);
      const existing = queue.find((q) => q.id === m.id);
      if (existing) {
        // The fresh on-disk row is authoritative for identity; make sure ITS
        // status flips too (the caller's object may be a detached copy).
        if (existing.status === 'processing') existing.status = 'pending';
      } else {
        log.session.warn('revertToPending: message missing from store — re-inserting (loss averted)', {
          sessionId: m.sessionId, messageId: m.id,
        });
        queue.push(m);
        // Keep queue ordered by enqueue time so redelivery preserves user order
        queue.sort(compareEnqueueOrder);
      }
    }
  });
}

/**
 * The lines of a session its host runs and judges that wait in this leader's queue, taken out:
 * they go to the host's queue with the send (session-channel/host-api.ts SendBody.queued), whose
 * runner drains them. Rows ready to go (pending), and rows held for the turn's end or a cold wake,
 * which keep their hold there (sessions/handed-holds.ts); `heldOnly`: those alone. Any other held
 * row (parked, held for a move) stays here.
 * `putBack`: the host did not take them (the same rows, in their place again); `done`: it did.
 * Until one of them, the lines wait in a transit in the queue file (session-queue-transit.ts),
 * never only in this caller's memory: a crash before the host answers puts them back at the next
 * start (the host takes an id once, so a resend of a line it took is a no-op). Throws, with the
 * lines still queued, when the take cannot be written.
 */
export async function takeLinesForHost(sessionId: string, opts?: { heldOnly?: boolean; ids?: readonly string[] }): Promise<{ lines: QueuedMessage[]; putBack(): Promise<void>; done(): Promise<void> }> {
  const { isHandedHold } = await import('./sessions/handed-holds.js');
  const transit = await import('./session-queue-transit.js');
  const only = opts?.ids ? new Set(opts.ids) : null;
  const goes = (m: QueuedMessage) => (only === null || only.has(m.id)) && (isHandedHold(m) || (!opts?.heldOnly && m.status === 'pending'));
  const id = transit.newTransitId('host');
  const lines = await transit.takeIntoTransit(id, 'host', sessionId, goes);
  if (lines.length === 0) transit.forgetTransit(id);
  return {
    lines,
    // A put back that fails leaves them in the transit, and the sweep puts them back.
    putBack: async () => {
      if (lines.length === 0) return;
      await transit.landTransit(id, sessionId, { front: true }).catch((err: unknown) => transit.abandonTransit(id, err));
    },
    done: async () => {
      if (lines.length === 0) return;
      await transit.dropTransit(id);
    },
  };
}

/**
 * The lines takeLinesForHost would take, left in the queue: a hand-over whose answer may be lost
 * sends them and takes them (takeLinesForHost `ids`) only once the host said it has them, so a
 * leader that stops in between still holds them (providers/host-resume.ts).
 */
export async function peekLinesForHost(sessionId: string): Promise<QueuedMessage[]> {
  const { isHandedHold } = await import('./sessions/handed-holds.js');
  const s = await getStore();
  return (s.queues[sessionId] ?? []).filter((m) => isHandedHold(m) || m.status === 'pending');
}

/**
 * Host: take back rows this queue took a moment ago for lines whose hand-over failed part-way
 * (sessions/handed-holds.ts queueLinesOnHost), with the once-only mark each id got, so the leader
 * delivering them itself leaves nothing here to run again. Only rows no delivery holds yet.
 */
export async function withdrawQueuedLines(sessionId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const gone = new Set(ids);
  return mutateStore((s) => {
    const queue = s.queues[sessionId] ?? [];
    const out = queue.filter((m) => gone.has(m.id) && m.status === 'pending');
    if (out.length === 0) return 0;
    // The leader delivers these itself and records their steps: nothing to say of them here.
    for (const m of out) noteQueueExit(m.id, 'silent');
    s.queues[sessionId] = queue.filter((m) => !out.includes(m));
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    for (const m of out) if (fateOf(s, m.id) === 'taken' && s.relay) delete s.relay[m.id];
    return out.length;
  }, true, true);
}

/**
 * The sessions with lines takeLinesForHost would take (a pending row, a handed hold): what waits
 * for a host that runs its sessions to take it (providers/host-judged-send.ts redelivery).
 */
export async function sessionsWithLinesForHost(): Promise<string[]> {
  const { isHandedHold } = await import('./sessions/handed-holds.js');
  const s = await getStore();
  return Object.entries(s.queues)
    .filter(([, q]) => q.some((m) => m.status === 'pending' || isHandedHold(m)))
    .map(([sid]) => sid);
}

/**
 * Get all queued messages for a session.
 */
export async function getQueue(sessionId: string): Promise<QueuedMessage[]> {
  const s = await getStore();
  return s.queues[sessionId] ?? [];
}

/**
 * The row queued under a send's own user line uuid, if any: the same send again (a resend whose
 * first answer was lost) is that row, never a second copy (web/routes/session-chat.ts).
 * An internal look, not a listing: nothing of it is shown.
 */
export async function queuedRowOfUserLine(sessionId: string, userUuid: string): Promise<QueuedMessage | undefined> {
  const s = await getStore();
  return (s.queues[sessionId] ?? []).find((m) => m.userUuid === userUuid);
}

export async function withUndeliveredMessageGuard<T>(
  check: (hasUndelivered: (sessionId: string) => boolean) => Promise<T>,
): Promise<T> {
  // Never under the queue's file lock: `check` runs a task hand-back, whose hooks may queue a
  // message, and a queue write waiting on a lock its own caller holds timed out every time
  // (2026-11-09; tests/core/queue-lock-holders-guard.test.ts). The answer is read live at each
  // call instead: this process's queue (every write of it updates the cache before it resolves)
  // and the file as it was when the guard began (the other writer, the `walnut start` CLI).
  const { readQueueFileFresh, peekStore } = await import('./session-queue-store.js');
  const onDisk = await readQueueFileFresh().catch(() => ({ version: 1, queues: {} } as QueueStore));
  const loaded = await getStore();
  const waits = (q: QueueStore, sessionId: string) => (q.queues[sessionId] ?? []).some((message) => message.status !== 'parked');
  return check((sessionId) => waits(onDisk, sessionId) || waits(peekStore() ?? loaded, sessionId));
}

/**
 * Is this message id STILL IN THE QUEUE for the session (any status)?
 *
 * Retry-after-delivery-failure guard (inc-1786774073558). A failed --resume spawn
 * calls revertToPending(), so the message stays in the queue as 'pending' AND the
 * UI is told the batch failed. The user's Retry then enqueued a SECOND copy of the
 * same text, and the next batch combined both into one payload joined by '\n\n' —
 * the CLI literally received the user's words twice (canonical enqueue line held
 * two identical halves). A retry must re-DRAIN the surviving row, never add one.
 *
 * 'processing' counts as queued too: delivery is in flight and hasn't settled
 * (every delivery point removes the row EAGERLY, so a surviving 'processing' row
 * means no delivery happened yet). Enqueueing beside it would re-open the same
 * doubling window one step later — if that in-flight batch also fails,
 * revertToPending restores the original next to the copy. Only a row that is
 * fully GONE justifies a fresh enqueue.
 */
export async function isMessageQueued(sessionId: string, messageId: string): Promise<boolean> {
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return false;
  return queue.some((m) => m.id === messageId);
}

/**
 * The queued row with this id in any session's queue (a migration moves rows between ids), or on
 * its way to one (a move's or a host hand's transit, the enqueue's spool), or null: a row that is
 * not delivered yet is never answered as delivered.
 */
export async function findQueuedMessage(messageId: string): Promise<QueuedMessage | null> {
  const s = await getStore();
  for (const queue of Object.values(s.queues)) {
    const row = queue.find((m) => m.id === messageId);
    if (row) return row;
  }
  const { rowOnTheWay } = await import('./session-queue-transit.js');
  return rowOnTheWay(messageId);
}

/**
 * Get all session IDs that have pending messages (for startup recovery and
 * daemon-reconnect redelivery). 'parked' rows are deliberately invisible here —
 * this is the single gate both automatic triggers pass through, so excluding
 * them is what makes "never auto-redelivered" true.
 */
export async function getAllSessionsWithPending(): Promise<string[]> {
  const s = await getStore();
  const result: string[] = [];
  for (const [sessionId, msgs] of Object.entries(s.queues)) {
    if (msgs.some((m) => m.status === 'pending')) {
      result.push(sessionId);
    }
  }
  return result;
}
