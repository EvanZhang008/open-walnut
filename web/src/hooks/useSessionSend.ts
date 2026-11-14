import { useState, useCallback, useEffect, useRef } from 'react';
import { wsClient } from '@/api/ws';
import { hasPendingHintsSource, takePendingHints, takePendingHintsAsync } from '@/utils/pending-hints';
import { buildImageRefsPayload } from '@/api/image-upload';
import { spillOversizedText } from '@/api/paste-spill';
import { log } from '@/utils/log';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { ImageAttachment } from '@/api/chat';
import { failedFromSameBox, removeBatchMessages, markDeliveredMessages, settleShownByUuid, statusOnAdopt, unmatchedDeliveredIds } from '@/components/sessions/optimistic-dedup';
import { launchSeedFor } from '@/components/sessions/launch-prompt-seed';
import { markBubblesFailed } from '@/components/sessions/parked-bubbles';
import { withoutLeadingRiders } from '@open-walnut/history-walnut-riders';
import { parseHinted } from '@open-walnut/hint-format';
import { splitAttachmentHeaders } from '@open-walnut/attachment-headers';
import { adoptSendAnswer, reconcileWithQueue, rehydrateFromQueue, rowVerdict } from './queue-reconcile';
import { useQueueSync, type QueueSyncState } from './useQueueSync';
import { queuedChangeResult, type QueuedChangeAnswer, type QueuedChangeKind } from '@/components/sessions/queued-change-words';
import { adoptFailedDraft, bindDraftOrigin, forgetFailedDraft, settleRetriedDraft, type DraftOrigin } from '@/utils/drafts';
import { newUserUuid } from '@/utils/thread-tree';
import { onKept, sendSessionMessage, type SendAck } from '@/api/session-send';
import { applyLateKept, shownSendError, type SendErrorState } from '@/components/sessions/send-acceptance';

/** Per-send extras that ride the `session:send` RPC. */
export interface SessionSendOptions {
  /**
   * v4 uuid the CLI must persist this user line under (`session:send` →
   * `QueuedMessage.userUuid` → the stream-json envelope's `uuid`). Pre-assigned by
   * the caller so a thread anchor can name the transcript row BEFORE it exists —
   * the harness's own contract (`createUserMessage`: `uuid: (uuid) ||
   * randomUUID()`), not a Walnut invention. Omit it and the payload is
   * byte-identical to a plain send.
   */
  userUuid?: string;
  /**
   * Message hints this send asks for (`on_request`, src/core/hints/hint-registry.ts):
   * `{ question: { arg: '4' } }` makes the server put the question-number hint ahead
   * of the text. The bubble shows only the text; the hint is the server's to write.
   */
  hints?: Record<string, { arg?: string }>;
  /**
   * The composer picked another engine: this message starts the task's NEW
   * session on it (core/sessions/engine-switch.ts) instead of reaching this one.
   */
  switchEngine?: { engine: string; model?: string; effort?: string };
  /** Sent from this thread's Follow up on an Org node's Threads: the message is filed under it. */
  threadId?: string;
  /** The composer draft the words came from. Kept on the bubble only, never sent: a Retry
   *  accepted after a failed send settles that draft (utils/drafts.ts settleRetriedDraft). */
  draftOrigin?: DraftOrigin;
}

interface UseSessionSendReturn {
  optimisticMsgs: OptimisticMessage[];
  sendError: string | null;
  /** The session a send from this panel actually went to, when an engine switch had replaced this one: the panel follows it. */
  redirectedTo: string | null;
  /** Resolves true once the message is persisted server-side (RPC ok), false if the RPC rejected. */
  send: (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions) => Promise<boolean>;
  interruptSend: (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions) => Promise<boolean>;
  /** Bare turn-stop (no message). Resolves true when the server accepted the interrupt. */
  stopTurn: (sessionId: string) => Promise<boolean>;
  retryFailed: (queueId: string, sessionId: string) => void;
  dismissFailed: (queueId: string) => void;
  handleMessagesDelivered: (count: number, messageIds?: string[]) => void;
  handleBatchCompleted: (count: number, messageIds?: string[]) => void;
  handleBatchFailed: (messageIds: string[], error: string, info?: { parked?: boolean; waitsFor?: string }) => void;
  handleDeliveryWaiting: (messageIds: string[]) => void;
  handleEditQueued: (sessionId: string, queueId: string, newText: string) => void;
  handleDeleteQueued: (sessionId: string, queueId: string) => void;
  addExternalQueued: (msg: { queueId: string; text: string; enqueuedAt?: string; sentBy?: 'person' | 'agent'; queuedText?: string }) => void;
  /** History shows these rows: a bubble whose uuid one carries was delivered (a send whose acknowledgement was lost). */
  settleShownInHistory: (rows: ReadonlyArray<{ role: string; text: string; msgId?: string; sourceUuid?: string }>) => void;
  clearOptimistic: () => void;
  /** The panel's last read of the server's queue (useQueueSync): its time, or why it failed. */
  queueSync: QueueSyncState;
}

/**
 * A queue row's text as the panel shows it (`text`), and what history will show
 * for it once delivered (`dedupText`, when different): the stored row carries
 * the server's image-ref prefix and the notices Walnut put ahead of the words,
 * which history shows as their own card. One rule for a reload and a live row.
 */
function queuedRowText(raw: string): { text: string; dedupText?: string } {
  const historyBasis = toDisplayedUserText(raw);
  const text = stripImageRefPrefix(withoutLeadingRiders(historyBasis));
  return text !== historyBasis ? { text, dedupText: historyBasis } : { text };
}

/**
 * Shared hook for sending messages to Claude Code sessions with optimistic UI.
 * Used by SessionPanel.
 *
 * ## State machine: optimisticMsgs[]
 *
 *   pending → received → delivered → (removed by handleBatchCompleted)
 *
 *   - send()                   → appends as 'pending', then RPC resolves → 'received'
 *   - handleMessagesDelivered  → matching (id-first) pending/received → 'delivered'
 *   - handleBatchCompleted     → removes the batch's messages (id-first, authoritative)
 *
 * ## handleBatchCompleted — id-first removal, count fallback
 *
 * The backend's SESSION_BATCH_COMPLETED carries the batch's `qm-…` messageIds
 * (Phase 1 of the ACP-dialect alignment) — remove EXACTLY those bubbles, so a
 * stale/raced event can never delete an unrelated newer message. Events without
 * ids (older server, interrupt path edge cases) fall back to the historical
 * "remove first N delivered" count semantics. A bubble whose queueId is still
 * the client tempId (send RPC response not yet applied) won't id-match; the
 * count fallback + text-dedup absorb it — worst case a brief duplicate, never
 * a silent loss.
 *
 * See SessionChatHistory.tsx top-of-file doc block for the full lifecycle.
 */
/**
 * Undo the server's attachment augmentation for DISPLAY purposes.
 *
 * A send with pictures or files carries the headers Walnut writes for the CLI
 * (`[Images attached …]` / `[Files attached …]`, one `- <path>` line per file,
 * a blank line) in front of the user's text. The disk queue stores that form,
 * so a bubble rehydrated from the queue would otherwise show the machine
 * preamble instead of what the user wrote. One parser with the server
 * (src/lib/attachment-headers.ts), so the two never drift.
 */
function stripImageRefPrefix(message: string): string {
  return splitAttachmentHeaders(message).text;
}

/** A row of `session:get-queue` (src/web/routes/session-chat.ts, sessions/queue-row-view.ts). */
export interface QueueRowWire {
  id: string;
  message: string;
  status: string;
  enqueuedAt?: string;
  parkedReason?: string;
  /** Parked only until the agent can run on the host (QueuedMessage.waitsFor): it goes out by itself. */
  waitsFor?: string;
  userUuid?: string;
  heldReason?: string;
  /** When the held row is tried again (a host that cannot be reached: its next re-dial). */
  heldRetryAt?: string;
  sentBy?: 'person' | 'agent';
  /** waiting: not written to the CLI; written: in its stdin, read after its current step; taken: the CLI read it. */
  stage?: 'waiting' | 'written' | 'taken';
  /** The CLI read it: the chat already shows it from history. */
  delivered?: boolean;
  images?: Array<{ path: string; url: string }>;
  files?: Array<{ path: string; name: string }>;
  /** The row waits for the running turn to end (sessions/queue-after-turn.ts presentAfterTurn). */
  afterTurn?: boolean;
}

/**
 * The bubble a reloaded panel shows for a queue row, or null for none. A row the
 * CLI already read (`delivered`) has no bubble here: history shows it, and a
 * bubble beside it was the count that kept growing. Its pictures show as
 * thumbnails, never as the header text.
 */
export function queueRowBubble(m: QueueRowWire, draftOrigin?: DraftOrigin): OptimisticMessage | null {
  if (m.delivered === true || m.stage === 'taken') return null;
  // The queue stores the ENQUEUED text, which for an attachment send carries the
  // server's headers + paths (and in rich output mode the hint blocks, and for
  // entity pills the reference-card block). Render the user-facing part, but dedup
  // against what HISTORY will show once this row is delivered and echoed: the
  // server strips the hint wrappers from its projection and keeps the attachment
  // preamble, so that (not the raw row) is the matching basis (OptimisticMessage.dedupText).
  // A queued row also holds any notice Walnut put in front of the words
  // (history-walnut-riders.ts): history shows those as their own card.
  const { text: display, dedupText } = queuedRowText(m.message);
  // 'parked' = the server stopped auto-retrying this row (permanent failure, e.g. the
  // session's working folder was deleted). Reuse the 'failed' presentation so it keeps
  // Retry + Discard instead of looking like an ordinary "Queued" message on its way.
  // One reading of a row for a reload and for every later queue read (queue-reconcile.ts rowVerdict):
  // a row held back or whose stage is `waiting` (a cold resume, a line mid-delivery) was never
  // written and shows Queued, with its reason; a written one shows Delivered.
  const verdict = rowVerdict(m);
  const parked = verdict.kind === 'parked';
  const held = verdict.kind === 'waiting' && !!verdict.heldReason;
  const imageUrls = (m.images ?? []).map((img) => img.url).filter((u) => typeof u === 'string' && u.length > 0);
  return {
    role: 'user' as const,
    text: display,
    timestamp: m.enqueuedAt ?? new Date().toISOString(),
    queueId: m.id,
    status: (verdict.kind === 'sent' ? 'delivered' : parked ? 'failed' : 'received') as 'received' | 'delivered' | 'failed',
    ...(parked ? { parked: true, serverUndelivered: true, failedError: m.parkedReason, ...(m.waitsFor ? { waitsFor: m.waitsFor } : {}) } : {}),
    ...(held ? { heldReason: m.heldReason, ...(m.heldRetryAt ? { heldRetryAt: m.heldRetryAt } : {}) } : {}),
    ...(m.afterTurn && !parked ? { afterTurn: true } : {}),
    ...(dedupText !== undefined ? { dedupText } : {}),
    // No per-stage badge here: a reloaded tab is never told when the CLI reads a row it
    // already counted delivered at its write, so a "written" note would go stale. A
    // processing row reads Delivered as a live one does after its write.
    ...(imageUrls.length ? { imageUrls } : {}),
    // The pre-assigned CLI uuid: a question's follow-up keeps its place in the
    // question tree across a reload (its own page, and a parked one marks the question failed).
    ...(m.userUuid ? { userUuid: m.userUuid } : {}),
    ...(m.sentBy === 'person' || m.sentBy === 'agent' ? { sentBy: m.sentBy } : {}),
    ...(draftOrigin ? { draftOrigin } : {}),
  };
}

/**
 * The message hints (`<system-reminder>` blocks the server composes around the
 * text, src/core/hints/hint-format.ts, the same file through an alias): taken off
 * by structure, never by matching the user's words, and the escape the server put
 * on the user's own `<system-reminder>` undone. The server applies the same parse
 * to the history projection, so this is only needed for a row rehydrated from the
 * disk QUEUE (not yet delivered, hence not yet echoed into history).
 */
export function stripOutputModeWrappers(message: string): string {
  return parseHinted(message).text;
}

/**
 * And the reference-card block: when the user's text carries an entity pill,
 * `session:send` appends a `---walnut-refs---` … `---/walnut-refs---` block
 * describing each referenced task / session / project
 * (src/core/sessions/reference-cards.ts). MIRROR of stripReferenceCards() there;
 * same line-anchored rules, same "never strip to nothing" guard. A block with no
 * close marker strips to the end (only a truncated delivery looks like that).
 */
const REFERENCE_CARDS_OPEN = '---walnut-refs---';
const REFERENCE_CARDS_CLOSE = '---/walnut-refs---';

export function stripReferenceCards(message: string): string {
  if (!message.includes(REFERENCE_CARDS_OPEN) && !message.includes(REFERENCE_CARDS_CLOSE)) {
    return message;
  }
  const lines = message.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== REFERENCE_CARDS_OPEN) {
      out.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== REFERENCE_CARDS_CLOSE) j++;
    i = j;
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  return stripped === '' ? message : stripped;
}

/** The form HISTORY will show for a delivered user line: the hints and the
 *  reference cards gone, the image preamble kept (the server's toDisplayedUserText). */
export function toDisplayedUserText(message: string): string {
  return stripReferenceCards(stripOutputModeWrappers(message));
}

/** Every server-side rewrite `session:send` can wrap around the user's own text,
 *  peeled off in the order it was applied (outermost first). Exported for the
 *  contract test that pins it against the emitter. */
export function stripSendPrefixes(message: string): string {
  return stripImageRefPrefix(toDisplayedUserText(message));
}

/**
 * The bubble for a session's launch prompt (`session:get-queue`'s launchPrompt,
 * src/core/sessions/launch-prompts.ts). Already handed to the CLI at spawn, so it
 * starts 'delivered'. `launch` is what lets history absorb it by position rather
 * than by text: see optimistic-dedup.ts.
 */
export function launchBubbleOf(p: { id: string; text: string; at: string }): OptimisticMessage | null {
  const text = stripSendPrefixes(p.text);
  if (!p.id || !text.trim()) return null;
  return { role: 'user', text, timestamp: p.at, queueId: p.id, status: 'delivered', launch: true };
}

/**
 * A bubble after its words were edited. The server keeps what led the words
 * (attachment headers, Walnut's notices: editMessage), so history will echo that
 * frame with the new words: the dedup text follows, or the bubble would never meet
 * its row and show twice.
 */
export function editedBubble(m: OptimisticMessage, newText: string): OptimisticMessage {
  if (m.dedupText === undefined) return { ...m, text: newText };
  const frame = m.dedupText.endsWith(m.text) ? m.dedupText.slice(0, m.dedupText.length - m.text.length) : undefined;
  if (frame === undefined) {
    const { dedupText: _old, ...rest } = m;
    return { ...rest, text: newText };
  }
  return { ...m, text: newText, dedupText: `${frame}${newText}` };
}

/**
 * Every send names its user line up front: the line is the proof the server kept a send
 * whose answer was lost (api/session-send.ts), and a composer's refusal the server took
 * after all is known across a reload by it. An engine switch's send starts another session.
 */
function withOwnedUuid(sessionId: string, opts: SessionSendOptions | undefined): SessionSendOptions | undefined {
  if (opts?.switchEngine) return opts;
  const userUuid = opts?.userUuid ?? newUserUuid();
  if (!userUuid) return opts;
  if (opts?.draftOrigin) bindDraftOrigin(opts.draftOrigin, sessionId, userUuid);
  return opts?.userUuid ? opts : { ...(opts ?? {}), userUuid };
}

/** What a panel shows before its queue answer: the launch this tab just made. */
function seededBubbles(sessionId: string | null): OptimisticMessage[] {
  const seed = sessionId ? launchSeedFor(sessionId) : undefined;
  const bubble = seed ? launchBubbleOf(seed) : null;
  return bubble ? [bubble] : [];
}

export function useSessionSend(activeSessionId: string | null): UseSessionSendReturn {
  // Seeded in the initializer, not the effect: the first frame of a freshly
  // promoted panel must already hold the message the pending column showed.
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMessage[]>(() => seededBubbles(activeSessionId));
  // The red line, tied to the send it is about (send-acceptance.ts shownSendError).
  const [sendErrorState, setSendErrorState] = useState<SendErrorState | null>(null);
  const setSendError = useCallback((text: string | null, userUuid?: string) => {
    setSendErrorState(text === null ? null : { text, ...(userUuid ? { userUuid } : {}) });
  }, []);
  const [redirectedTo, setRedirectedTo] = useState<string | null>(null);
  useEffect(() => { setRedirectedTo(null); }, [activeSessionId]);
  // The session the panel shows now: a send's late answer never moves a panel that went elsewhere.
  const shownRef = useRef(activeSessionId);
  shownRef.current = activeSessionId;
  // A send the server delivered to the task's current session (this one was replaced): the bubble
  // belongs there, and the panel follows (SessionPanel).
  const followRedirect = useCallback((res: { deliveredTo?: string } | undefined, tempId: string, sentTo: string | null | undefined): boolean => {
    if (!res?.deliveredTo || res.deliveredTo === sentTo) return false;
    log.info('send', 'delivered to the session that replaced this one', { sessionId: sentTo, deliveredTo: res.deliveredTo });
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
    if (shownRef.current === sentTo) setRedirectedTo(res.deliveredTo);
    return true;
  }, []);

  // Ref for accessing current optimistic messages in callbacks without stale closures
  const msgsRef = useRef(optimisticMsgs);
  msgsRef.current = optimisticMsgs;
  // Ids a delivery named before their send RPC answered: the bubble that learns
  // one starts 'delivered' (a delivery never marks some other bubble by count).
  const deliveredEarlyRef = useRef<Set<string>>(new Set());
  // The bubbles follow the server's queue, not only its events (useQueueSync, queue-reconcile.ts).
  const sync = useQueueSync(activeSessionId, optimisticMsgs, msgsRef, setOptimisticMsgs, queueRowBubble);
  const { touch, retire, hold, release, request: requestQueueRead } = sync;

  /** The bubble `clientId` after its accepted answer (a lost answer's stand-in included: api/session-send.ts). */
  const adoptAnswer = useCallback((clientId: string, res: SendAck) => {
    const adopted = statusOnAdopt(res.messageId, deliveredEarlyRef.current);
    touch([res.messageId]);
    setOptimisticMsgs((prev) => adoptSendAnswer(prev, clientId, res, adopted));
  }, [touch]);

  // A refused send the server proves it kept after all (its queued event came late): accepted
  // like any other, so its words leave the composer it was restored to (utils/drafts.ts).
  useEffect(() => onKept((row) => {
    if (row.sessionId !== shownRef.current) return;
    const { settled } = applyLateKept(msgsRef.current, row);
    if (settled.length === 0) return;
    log.info('send', 'the server kept a send whose answer was lost', { sessionId: row.sessionId, messageId: row.messageId });
    for (const m of settled) if (m.draftOrigin) settleRetriedDraft(m.draftOrigin);
    const early = statusOnAdopt(row.messageId, deliveredEarlyRef.current) === 'delivered';
    setOptimisticMsgs((prev) => applyLateKept(prev, row, early).next as OptimisticMessage[]);
  }), []);

  // Clear optimistic messages on session switch + rehydrate from server disk queue.
  // The queue only contains messages NOT yet delivered to Claude (pending/processing).
  // Once delivered, removeProcessed() clears them eagerly — so no overlap with JSONL.
  useEffect(() => {
    setOptimisticMsgs(seededBubbles(activeSessionId));
    setSendError(null);
    // A panel that switches sessions (the Ask slot does) must not take the rows,
    // or the launch prompt, of the session it just left.
    let stale = false;

    if (activeSessionId) {
      const sid = activeSessionId;
      wsClient.sendRpc<{
        messages: QueueRowWire[];
        launchPrompt?: { id: string; text: string; at: string };
      }>(
        'session:get-queue',
        { sessionId: activeSessionId }
      ).then((res) => {
        if (stale) return;
        const launch = res?.launchPrompt ? launchBubbleOf(res.launchPrompt) : null;
        if (res?.messages?.length || launch) {
          // A refused send the server took after all owns its restored draft again (utils/drafts.ts).
          const owned = new Map((res.messages ?? []).flatMap((m) => {
            const origin = m.userUuid ? adoptFailedDraft(sid, m.userUuid) : undefined;
            return origin ? [[m.id, origin] as const] : [];
          }));
          setOptimisticMsgs(prev => rehydrateFromQueue(prev, res.messages ?? [], launch, {
            retired: sync.retiredIds(), now: Date.now(),
            toBubble: (row) => queueRowBubble(row, owned.get(row.id)),
          }));
          log.info('send', 'rehydrated from queue', {
            sessionId: activeSessionId,
            count: res.messages?.length ?? 0,
            ...(launch ? { launchPrompt: launch.queueId } : {}),
          });
        }
      }).catch((e: Error) => {
        log.warn('send', 'queue rehydrate failed', { error: e.message });
      });
    }
    return () => { stale = true; };
  }, [activeSessionId]);

  /** A send from a box replaces that box's refused rows (optimistic-dedup.ts failedFromSameBox). */
  const dropSupersededFailed = useCallback((origin: DraftOrigin | undefined) => {
    const gone = failedFromSameBox(msgsRef.current, origin?.key);
    if (gone.length === 0) return;
    for (const m of gone) if (m.draftOrigin && m.draftOrigin !== origin) forgetFailedDraft(m.draftOrigin);
    const ids = new Set(gone.map((m) => m.queueId));
    setOptimisticMsgs((prev) => prev.filter((m) => !ids.has(m.queueId)));
  }, []);

  const send = useCallback(async (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions): Promise<boolean> => {
    setSendError(null);

    // Oversized paste → spill to disk over HTTP, send a short file-path pointer
    // instead (same WS-frame-cap reasoning as image uploads — see paste-spill.ts).
    // Spill BEFORE the optimistic bubble so display, dedup, and retry all see the
    // same (small) text the server will echo back.
    try {
      message = await spillOversizedText(message);
    } catch (e) {
      const err = e as Error;
      log.error('send', 'paste spill failed', { sessionId, error: err.message });
      setSendError(`Large paste upload failed: ${err.message}`);
      return false;
    }

    // Hints a surface asked for on this session's next send (utils/pending-hints.ts), under the send's own.
    const hinted = hasPendingHintsSource(sessionId) ? await takePendingHintsAsync(sessionId, opts?.hints, message) : takePendingHints(sessionId, opts?.hints);
    if (hinted) opts = { ...(opts ?? {}), hints: hinted };
    opts = withOwnedUuid(sessionId, opts);
    dropSupersededFailed(opts?.draftOrigin);
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
      // The uuid the CLI will persist this line under: it is also the id the
      // thread anchor was just recorded against, so the bubble is a member of
      // its thread NOW rather than after the next history fetch. Dedup reads it
      // too: a history row carrying it proves the bubble delivered, failed or not
      // (optimistic-dedup.ts historyUuidsOf).
      ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
      ...(opts?.hints ? { requestedHints: opts.hints } : {}),
      ...(opts?.draftOrigin ? { draftOrigin: opts.draftOrigin } : {}),
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    try {
      // Images upload over HTTP first; the RPC carries only refs. Base64 on a WS
      // frame trips the server's 4MB cap, which `ws` answers by closing the
      // socket (1009) — see api/image-upload.ts.
      const rpcPayload: Record<string, unknown> = {
        sessionId,
        message,
        ...(await buildImageRefsPayload(images)),
        ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
        ...(opts?.hints ? { hints: opts.hints } : {}),
        ...(opts?.switchEngine ? { switchEngine: opts.switchEngine } : {}),
        ...(opts?.threadId ? { threadId: opts.threadId } : {}),
      };
      const res = await sendSessionMessage(rpcPayload as typeof rpcPayload & { sessionId: string; message: string });
      if (followRedirect(res, tempId, sessionId)) return true;
      if (res?.engineSwitch) {
        // The message starts the task's new session: its bubble shows there, not in this one.
        log.info('send', 'engine switch accepted', { sessionId, state: res.engineSwitch.state });
        setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
        return true;
      }
      // Adopt dedupText when the server augmented the text (image refs) — the
      // bubble keeps rendering the user's original, but dedups against what was
      // actually enqueued. See OptimisticMessage.dedupText.
      if (res?.messageId) adoptAnswer(tempId, res);
      return true;
    } catch (e) {
      const err = e as Error;
      log.error('send', 'RPC failed', { sessionId, error: err.message });
      setSendError(err.message, opts?.userUuid);
      setOptimisticMsgs((prev) => prev.map((m) =>
        m.queueId === tempId ? { ...m, status: 'failed' as const, failedError: err.message } : m
      ));
      return false;
    }
  }, [touch]);

  const interruptSend = useCallback(async (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions): Promise<boolean> => {
    setSendError(null);

    try {
      message = await spillOversizedText(message);
    } catch (e) {
      const err = e as Error;
      log.error('send', 'paste spill failed (interrupt)', { sessionId, error: err.message });
      setSendError(`Large paste upload failed: ${err.message}`);
      return false;
    }

    // Hints a surface asked for on this session's next send (utils/pending-hints.ts), under the send's own.
    const hinted = hasPendingHintsSource(sessionId) ? await takePendingHintsAsync(sessionId, opts?.hints, message) : takePendingHints(sessionId, opts?.hints);
    if (hinted) opts = { ...(opts ?? {}), hints: hinted };
    opts = withOwnedUuid(sessionId, opts);
    dropSupersededFailed(opts?.draftOrigin);
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching (interrupt)', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
      // Same as the plain send path: the pre-assigned uuid puts the bubble in its
      // thread immediately (see the comment there).
      ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
      ...(opts?.hints ? { requestedHints: opts.hints } : {}),
      ...(opts?.draftOrigin ? { draftOrigin: opts.draftOrigin } : {}),
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    try {
      const rpcPayload: Record<string, unknown> = {
        sessionId,
        message,
        interrupt: true,
        ...(await buildImageRefsPayload(images)),
        ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
        ...(opts?.hints ? { hints: opts.hints } : {}),
      };
      const res = await sendSessionMessage(rpcPayload as typeof rpcPayload & { sessionId: string; message: string });
      if (followRedirect(res, tempId, sessionId)) return true;
      if (res?.messageId) adoptAnswer(tempId, res);
      return true;
    } catch (e) {
      const err = e as Error;
      log.error('send', 'RPC failed (interrupt)', { sessionId, error: err.message });
      setSendError(err.message, opts?.userUuid);
      setOptimisticMsgs((prev) => prev.map((m) =>
        m.queueId === tempId ? { ...m, status: 'failed' as const, failedError: err.message } : m
      ));
      return false;
    }
  }, [touch]);

  /** Retry a failed message — resets to pending and re-sends via RPC.
   *
   *  `retryOf` carries the ORIGINAL queueId so the server can re-drain the row
   *  that is still sitting in its pending queue instead of enqueueing a second
   *  copy of the same text (inc-1786774073558: a --resume spawn failure reverts
   *  its batch to 'pending' AND reports the batch failed, so a blind re-send put
   *  the words in the queue twice and the next batch joined both with '\n\n' —
   *  the CLI received the user's message duplicated inside ONE enqueue line).
   *  The queueId is kept STABLE for the same reason: minting a new temp id would
   *  orphan the server row's identity and re-open the duplicate path. When the
   *  row is already gone server-side, the server falls back to a fresh enqueue
   *  and answers with a new messageId, which is adopted below. */
  const retryFailed = useCallback((queueId: string, sessionId: string) => {
    // A waiting row (the host did not take it in time) is sent now the same way:
    // the server re-drains that row; the bubble keeps its Queued state meanwhile.
    const waiting = msgsRef.current.find(m => m.queueId === queueId && (m.status === 'pending' || m.status === 'received'));
    // A bubble the queue lost track of (it left the queue and history never showed it) is sent again like a failed one.
    const failedMsg = waiting ?? msgsRef.current.find(m => m.queueId === queueId && (m.status === 'failed' || (m.status === 'delivered' && m.leftQueueAt !== undefined)));
    if (!failedMsg) return;

    setSendError(null);
    log.info('send', waiting ? 'sending a waiting message now' : 'retrying', { sessionId, queueId });
    // No queue read judges this row while its send is on its way (it may be gone and enqueued anew).
    hold([queueId]);

    // Clear `parked` too: the server un-parks the row on this explicit retry, so
    // a second failure must render as an ordinary "Send failed", not a stale park.
    if (!waiting) setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, status: 'pending' as const, failedError: undefined, parked: undefined, waitsFor: undefined, leftQueueAt: undefined, queueNotice: undefined } : m
    ));

    // The pre-assigned user-line uuid rides the retry too: the thread anchor recorded
    // at send time is keyed by it, so a retry that minted (or omitted) a uuid would
    // land the message at the top level while the chip still promised a thread.
    // Harmless when the server re-drains the original row (it already carries it).
    buildImageRefsPayload(failedMsg.images)
      .then((imagePayload) => sendSessionMessage({
        sessionId, message: failedMsg.text, retryOf: queueId, ...imagePayload,
        ...(failedMsg.userUuid ? { userUuid: failedMsg.userUuid } : {}),
        ...(failedMsg.requestedHints ? { hints: failedMsg.requestedHints } : {}),
      }))
      .then((res) => {
        release([queueId]);
        if (failedMsg.draftOrigin) settleRetriedDraft(failedMsg.draftOrigin);
        if (followRedirect(res, queueId, sessionId)) return;
        // alreadyDelivered: the first send's acknowledgement was lost, not the send: its
        // line already ran (the server sent nothing again). History holds it and its answer.
        if (res?.alreadyDelivered) log.info('send', 'retry: the message was already delivered', { sessionId, queueId });
        if (res?.messageId) adoptAnswer(queueId, res);
      })
      .catch((e: Error) => {
        release([queueId]);
        log.error('send', 'Retry failed', { sessionId, error: e.message });
        setSendError(e.message, failedMsg.userUuid);
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === queueId ? { ...m, status: 'failed' as const, failedError: e.message } : m
        ));
      });
  }, [touch, hold, release]);

  /** Remove a failed message from the optimistic list. */
  const dismissFailed = useCallback((queueId: string) => {
    retire([queueId]);
    const origin = msgsRef.current.find((m) => m.queueId === queueId)?.draftOrigin;
    if (origin) forgetFailedDraft(origin);
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
  }, [retire]);

  const handleMessagesDelivered = useCallback((count: number, messageIds?: string[]) => {
    log.info('send', 'delivered', { count, messageIds });
    // Exactly the bubbles the ids name (a failed one too: it ran after all); the
    // count only for an id-less event. Rules live in optimistic-dedup.ts (unit-tested).
    const early = deliveredEarlyRef.current;
    if (messageIds?.length) touch(messageIds);
    for (const id of unmatchedDeliveredIds(msgsRef.current, messageIds)) early.add(id);
    while (early.size > 64) early.delete(early.values().next().value!);
    const ids = new Set(messageIds ?? []);
    const revived = msgsRef.current.some((m) => m.status === 'failed' && ids.has(m.queueId));
    for (const m of msgsRef.current) if (m.draftOrigin && ids.has(m.queueId)) settleRetriedDraft(m.draftOrigin);
    const stillFailed = msgsRef.current.some((m) => m.status === 'failed' && !ids.has(m.queueId));
    setOptimisticMsgs((prev) => markDeliveredMessages(prev, count, messageIds) as OptimisticMessage[]);
    // The red error was about a message that did reach the CLI: nothing failed now.
    if (revived && !stillFailed) setSendError(null);
  }, [touch]);

  const handleBatchCompleted = useCallback((count: number, messageIds?: string[]) => {
    log.info('send', 'batch completed', { count, messageIds });
    if (messageIds?.length) retire(messageIds);
    // Id-first removal (exactly the batch's bubbles — a stale/raced event can
    // never take out an unrelated newer message), count fallback with the
    // delivered-only NO-LOSS guard — rules live in optimistic-dedup.ts.
    setOptimisticMsgs((prev) => removeBatchMessages(prev, count, messageIds));
  }, [retire]);

  // Backend processNext failed to deliver the batch (e.g. SSH/daemon down). Mark the
  // matching optimistic messages 'failed' (keep text + show Retry) instead of removing
  // them. The messages stay in the server-side pending queue, so Retry can re-send.
  /** The server holds these rows on a clock: a bubble already shown delivered reads waiting again. */
  const handleDeliveryWaiting = useCallback((messageIds: string[]) => {
    const ids = new Set(messageIds);
    touch(messageIds);
    setOptimisticMsgs((prev) => prev.some((m) => ids.has(m.queueId) && m.status === 'delivered')
      ? prev.map((m) => (ids.has(m.queueId) && m.status === 'delivered' ? { ...m, status: 'received' as const } : m))
      : prev);
  }, [touch]);

  const handleBatchFailed = useCallback((messageIds: string[], error: string, info?: { parked?: boolean; waitsFor?: string }) => {
    log.warn('send', 'batch failed', { count: messageIds.length, error, ...(info?.waitsFor ? { waitsFor: info.waitsFor } : {}) });
    // A message waiting for the agent says so on its own bubble, with the fix: no second red line.
    if (!info?.waitsFor) setSendError(error);
    touch(messageIds);
    // A refused launch prompt reads as the message that was not sent (parked-bubbles.ts).
    setOptimisticMsgs((prev) => markBubblesFailed(prev, messageIds, error, info));
  }, [touch]);

  /**
   * The server's answer to an Edit or Delete, shown on the bubble in place
   * (queued-change-words.ts): a row already taken or gone is no error toast.
   * `before` is the bubble as it was, for an edit that did not apply.
   */
  const settleQueuedChange = useCallback((kind: QueuedChangeKind, sessionId: string, queueId: string, before: OptimisticMessage | undefined, answer: QueuedChangeAnswer | undefined, thrown?: string) => {
    release([queueId]);
    const result = queuedChangeResult(kind, answer, thrown);
    if (!result.remove && result.notice) {
      log.info('send', `${kind}-queued not applied`, { sessionId, queueId, outcome: answer?.outcome ?? 'thrown', ...(thrown ? { error: thrown } : {}) });
    }
    if (result.remove) retire([queueId]);
    if (result.delivered) touch([queueId]);
    setOptimisticMsgs((prev) => {
      if (result.remove) return prev.filter((m) => m.queueId !== queueId);
      return prev.map((m) => {
        if (m.queueId !== queueId) return m;
        const { changing: _c, ...rest } = m;
        const text = result.revertText && before ? { text: before.text, ...(before.dedupText !== undefined ? { dedupText: before.dedupText } : {}) } : {};
        return {
          ...rest, ...text,
          ...(result.delivered && (m.status === 'pending' || m.status === 'received') ? { status: 'delivered' as const, heldReason: undefined, afterTurn: undefined } : {}),
          ...(result.notice ? { queueNotice: result.notice } : {}),
        };
      });
    });
    // Whatever the answer, the bubble then shows where the row really is.
    if (result.notice) requestQueueRead(`${kind} answer`);
  }, [retire, touch, release, requestQueueRead]);

  const handleEditQueued = useCallback((sessionId: string, queueId: string, newText: string) => {
    const before = msgsRef.current.find((m) => m.queueId === queueId);
    hold([queueId]);
    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...editedBubble(m, newText), queueNotice: undefined } : m
    ));
    wsClient.sendRpc<QueuedChangeAnswer>('session:edit-queued', {
      sessionId, messageId: queueId, text: newText,
    }).then(
      (res) => settleQueuedChange('edit', sessionId, queueId, before, res),
      (e: Error) => settleQueuedChange('edit', sessionId, queueId, before, undefined, e.message),
    );
  }, [settleQueuedChange, hold]);

  const handleDeleteQueued = useCallback((sessionId: string, queueId: string) => {
    const before = msgsRef.current.find((m) => m.queueId === queueId);
    hold([queueId]);
    // Stays on screen until the server answers: a row it already sent says so here.
    setOptimisticMsgs((prev) => prev.map((m) => (m.queueId === queueId ? { ...m, changing: true, queueNotice: undefined } : m)));
    wsClient.sendRpc<QueuedChangeAnswer>('session:delete-queued', {
      sessionId, messageId: queueId,
    }).then(
      (res) => settleQueuedChange('delete', sessionId, queueId, before, res),
      (e: Error) => settleQueuedChange('delete', sessionId, queueId, before, undefined, e.message),
    );
  }, [settleQueuedChange, hold]);

  // Handle messages queued externally (e.g. by the agent via send_to_session)
  // These arrive via bus event after the server has already enqueued the message,
  // so we go straight to 'received' (shows "Queued" badge immediately).
  const addExternalQueued = useCallback((msg: { queueId: string; text: string; enqueuedAt?: string; sentBy?: 'person' | 'agent'; queuedText?: string }) => {
    // An agent's row as the queue stores it (a peer's note in its envelope):
    // shown as a reload shows it (queuedRowText), so it folds as the card it is.
    const shown = msg.queuedText !== undefined ? queuedRowText(msg.queuedText) : { text: msg.text };
    setOptimisticMsgs(prev => {
      // Dedup: skip if this queueId already exists (guard against double-delivery)
      if (prev.some(m => m.queueId === msg.queueId)) return prev;
      return [...prev, {
        queueId: msg.queueId,
        text: shown.text,
        ...(shown.dedupText !== undefined ? { dedupText: shown.dedupText } : {}),
        role: 'user' as const,
        timestamp: msg.enqueuedAt ?? new Date().toISOString(),
        status: 'received' as const,
        ...(msg.sentBy ? { sentBy: msg.sentBy } : {}),
      }];
    });
  }, []);

  const settleShownInHistory = useCallback((rows: ReadonlyArray<{ role: string; text: string; msgId?: string; sourceUuid?: string }>) => {
    const next = settleShownByUuid(msgsRef.current, rows);
    if (next === msgsRef.current) return;
    const settled = next.filter((m, i) => m !== msgsRef.current[i]);
    log.info('send', 'history shows sends as delivered', { count: settled.length, queueIds: settled.map((m) => m.queueId) });
    for (const m of settled) if (m.draftOrigin) settleRetriedDraft(m.draftOrigin);
    setOptimisticMsgs((prev) => settleShownByUuid(prev, rows) as OptimisticMessage[]);
    if (!next.some((m) => m.status === 'failed')) setSendError(null);
  }, []);

  const clearOptimistic = useCallback(() => {
    setOptimisticMsgs([]);
    setSendError(null);
  }, []);

  const stopTurn = useCallback(async (sessionId: string): Promise<boolean> => {
    log.info('send', 'stop turn requested', { sessionId });
    try {
      await wsClient.sendRpc('session:interrupt', { sessionId });
      return true;
    } catch (e) {
      const err = e as Error;
      log.error('send', 'stop turn failed', { sessionId, error: err.message });
      setSendError(`Stop failed: ${err.message}`);
      return false;
    }
  }, []);

  return {
    optimisticMsgs,
    sendError: shownSendError(sendErrorState, optimisticMsgs),
    redirectedTo,
    send,
    interruptSend,
    stopTurn,
    retryFailed,
    dismissFailed,
    handleMessagesDelivered,
    handleBatchCompleted,
    handleBatchFailed,
    handleDeliveryWaiting,
    handleEditQueued,
    handleDeleteQueued,
    addExternalQueued,
    settleShownInHistory,
    clearOptimistic,
    queueSync: sync.state,
  };
}
