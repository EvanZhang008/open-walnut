import { useState, useCallback, useEffect, useRef } from 'react';
import { wsClient } from '@/api/ws';
import { buildImageRefsPayload } from '@/api/image-upload';
import { spillOversizedText } from '@/api/paste-spill';
import { log } from '@/utils/log';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { ImageAttachment } from '@/api/chat';
import { removeBatchMessages, markDeliveredMessages, statusOnAdopt, unmatchedDeliveredIds } from '@/components/sessions/optimistic-dedup';
import { launchSeedFor } from '@/components/sessions/launch-prompt-seed';

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
}

interface UseSessionSendReturn {
  optimisticMsgs: OptimisticMessage[];
  sendError: string | null;
  /** Resolves true once the message is persisted server-side (RPC ok), false if the RPC rejected. */
  send: (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions) => Promise<boolean>;
  interruptSend: (sessionId: string, message: string, images?: ImageAttachment[], opts?: SessionSendOptions) => Promise<boolean>;
  /** Bare turn-stop (no message). Resolves true when the server accepted the interrupt. */
  stopTurn: (sessionId: string) => Promise<boolean>;
  retryFailed: (queueId: string, sessionId: string) => void;
  dismissFailed: (queueId: string) => void;
  handleMessagesDelivered: (count: number, messageIds?: string[]) => void;
  handleBatchCompleted: (count: number, messageIds?: string[]) => void;
  handleBatchFailed: (messageIds: string[], error: string) => void;
  handleEditQueued: (sessionId: string, queueId: string, newText: string) => void;
  handleDeleteQueued: (sessionId: string, queueId: string) => void;
  addExternalQueued: (msg: { queueId: string; text: string }) => void;
  clearOptimistic: () => void;
}

/**
 * Shared hook for sending messages to Claude Code sessions with optimistic UI.
 * Used by SessionPanel and TaskDetailPage.
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
 * Undo the server's image-ref augmentation for DISPLAY purposes.
 *
 * `session:send` prepends `[Images attached — use the Read tool to view them]\n`
 * + one `- <path>` line per saved image + a blank line, then the user's text
 * (src/web/routes/session-chat.ts). The disk queue therefore stores the augmented
 * form, so a bubble rehydrated from the queue would otherwise show the machine
 * preamble instead of what the user wrote. Keep this in sync with that emitter;
 * a format drift just means the prefix stays visible (no dedup breakage, since
 * the untouched string is then used as both display and dedup key).
 */
function stripImageRefPrefix(message: string): string {
  if (!message.startsWith('[Images attached')) return message;
  const sep = message.indexOf('\n\n');
  return sep === -1 ? message : message.slice(sep + 2);
}

/**
 * Same deal for the output-mode wrapper: `session:send` prefixes a one-time
 * `[Rich output mode: ON|OFF] …` line on a mode change and, while rich holds,
 * appends a `[Rich output mode is still on …]` reminder line after the user's
 * text (src/core/sessions/output-mode.ts).
 *
 * MIRROR of stripOutputModeWrappers() there, which the server also applies to the
 * history projection — so this is only needed for a row rehydrated from the disk
 * QUEUE (not yet delivered, hence not yet echoed into history). Line-anchored: a
 * sentence that merely mentions the mode does not START with the marker, and a
 * merged batch carrying two reminders loses both.
 */
const OUTPUT_MODE_INSTRUCTION_MARKER = '[Rich output mode: ';
const OUTPUT_MODE_REMINDER_MARKER = '[Rich output mode is still on';
/** The phone's voice-reply line (src/core/sessions/voice-reply.ts), stripped the same way. */
const VOICE_REPLY_MARKER = '[Voice reply: ';

function isOutputModeLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith(OUTPUT_MODE_INSTRUCTION_MARKER)) return true;
  if (t.startsWith(VOICE_REPLY_MARKER) && t.endsWith(']')) return true;
  return t.startsWith(OUTPUT_MODE_REMINDER_MARKER) && t.endsWith(']');
}

/** The form HISTORY will show: the output-mode wrapper gone, the image preamble
 *  kept (the server strips exactly this much). This is therefore the dedup basis
 *  for a rehydrated row — see OptimisticMessage.dedupText. */
export function stripOutputModeWrappers(message: string): string {
  if (
    !message.includes(OUTPUT_MODE_INSTRUCTION_MARKER)
    && !message.includes(OUTPUT_MODE_REMINDER_MARKER)
    && !message.includes(VOICE_REPLY_MARKER)
  ) {
    return message;
  }
  const lines = message.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOutputModeLine(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  // Never strip a message down to nothing — an "all wrapper" message is someone
  // quoting the literal text, and their words must stay visible.
  return stripped === '' ? message : stripped;
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

/** The form HISTORY will show for a delivered user line: both machine wrappers
 *  gone, the image preamble kept — the server's toDisplayedUserText. */
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
  const [sendError, setSendError] = useState<string | null>(null);

  // Ref for accessing current optimistic messages in callbacks without stale closures
  const msgsRef = useRef(optimisticMsgs);
  msgsRef.current = optimisticMsgs;
  // Ids a delivery named before their send RPC answered: the bubble that learns
  // one starts 'delivered' (a delivery never marks some other bubble by count).
  const deliveredEarlyRef = useRef<Set<string>>(new Set());

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
      wsClient.sendRpc<{
        messages: Array<{ id: string; message: string; status: string; enqueuedAt?: string; parkedReason?: string; userUuid?: string; heldReason?: string }>;
        launchPrompt?: { id: string; text: string; at: string };
      }>(
        'session:get-queue',
        { sessionId: activeSessionId }
      ).then((res) => {
        if (stale) return;
        const launch = res?.launchPrompt ? launchBubbleOf(res.launchPrompt) : null;
        if (res?.messages?.length || launch) {
          setOptimisticMsgs(prev => {
            const existing = new Set(prev.map(m => m.queueId));
            const newMsgs = (res.messages ?? [])
              .filter(m => !existing.has(m.id))
              .map(m => {
                // The queue stores the ENQUEUED text, which for an attachment send
                // carries the server's `[Images attached …]` + paths prefix (and in
                // rich output mode the `[Rich output mode: …]` instruction and/or
                // the trailing "still on" reminder, and for entity pills the
                // reference-card block). Render the user-facing part, but dedup
                // against what HISTORY will show once this row is delivered and
                // echoed: the server strips both machine wrappers from its
                // projection and keeps the image preamble, so that (not the raw
                // row) is the matching basis — see OptimisticMessage.dedupText
                // and session-chat.ts's dedupText.
                const historyBasis = toDisplayedUserText(m.message);
                const display = stripImageRefPrefix(historyBasis);
                // 'parked' = the server stopped auto-retrying this row (permanent
                // failure, e.g. the session's working folder was deleted). Reuse the
                // 'failed' presentation so it keeps Retry + Discard instead of looking
                // like an ordinary "Queued" message that is still on its way.
                const parked = m.status === 'parked';
                // A row held behind a line still being confirmed was never written:
                // it shows as waiting, with the reason, not as delivered.
                const held = m.status === 'processing' && !!m.heldReason;
                return {
                  role: 'user' as const,
                  text: display,
                  timestamp: m.enqueuedAt ?? new Date().toISOString(),
                  queueId: m.id,
                  status: (held ? 'received' : m.status === 'processing' ? 'delivered' : parked ? 'failed' : 'received') as 'received' | 'delivered' | 'failed',
                  ...(parked ? { parked: true, failedError: m.parkedReason } : {}),
                  ...(held ? { heldReason: m.heldReason } : {}),
                  ...(display !== historyBasis ? { dedupText: historyBasis } : {}),
                  // The pre-assigned CLI uuid: a question's follow-up keeps its
                  // place in the question tree across a reload (its own page,
                  // and a parked one marks the question failed).
                  ...(m.userUuid ? { userUuid: m.userUuid } : {}),
                };
              });
            // The launch prompt opens the first turn, so it goes before anything
            // the user managed to send while this RPC was in flight.
            const head = launch && !existing.has(launch.queueId) ? [launch] : [];
            return [...head, ...prev, ...newMsgs];
          });
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
      // its thread NOW rather than after the next history fetch. Dedup never
      // reads it (it keys on queueId / walnutMessageId / text).
      ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
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
      };
      const res = await wsClient.sendRpc<{ messageId: string; dedupText?: string; enqueuedAt?: string }>('session:send', rpcPayload);
      if (res?.messageId) {
        // Adopt dedupText when the server augmented the text (image refs) — the
        // bubble keeps rendering the user's original, but dedups against what was
        // actually enqueued. See OptimisticMessage.dedupText.
        const adopted = statusOnAdopt(res.messageId, deliveredEarlyRef.current);
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === tempId
            ? { ...m, queueId: res.messageId, status: m.status === 'delivered' ? m.status : adopted, ...(res.dedupText ? { dedupText: res.dedupText } : {}), ...(res.enqueuedAt ? { timestamp: res.enqueuedAt } : {}) }
            : m
        ));
      }
      return true;
    } catch (e) {
      const err = e as Error;
      log.error('send', 'RPC failed', { sessionId, error: err.message });
      setSendError(err.message);
      setOptimisticMsgs((prev) => prev.map((m) =>
        m.queueId === tempId ? { ...m, status: 'failed' as const, failedError: err.message } : m
      ));
      return false;
    }
  }, []);

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
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    try {
      const rpcPayload: Record<string, unknown> = {
        sessionId,
        message,
        interrupt: true,
        ...(await buildImageRefsPayload(images)),
        ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
      };
      const res = await wsClient.sendRpc<{ messageId: string; dedupText?: string; enqueuedAt?: string }>('session:send', rpcPayload);
      if (res?.messageId) {
        const adopted = statusOnAdopt(res.messageId, deliveredEarlyRef.current);
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === tempId
            ? { ...m, queueId: res.messageId, status: m.status === 'delivered' ? m.status : adopted, ...(res.dedupText ? { dedupText: res.dedupText } : {}), ...(res.enqueuedAt ? { timestamp: res.enqueuedAt } : {}) }
            : m
        ));
      }
      return true;
    } catch (e) {
      const err = e as Error;
      log.error('send', 'RPC failed (interrupt)', { sessionId, error: err.message });
      setSendError(err.message);
      setOptimisticMsgs((prev) => prev.map((m) =>
        m.queueId === tempId ? { ...m, status: 'failed' as const, failedError: err.message } : m
      ));
      return false;
    }
  }, []);

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
    const failedMsg = msgsRef.current.find(m => m.queueId === queueId && m.status === 'failed');
    if (!failedMsg) return;

    setSendError(null);
    log.info('send', 'retrying', { sessionId, queueId });

    // Clear `parked` too: the server un-parks the row on this explicit retry, so
    // a second failure must render as an ordinary "Send failed", not a stale park.
    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, status: 'pending' as const, failedError: undefined, parked: undefined } : m
    ));

    // The pre-assigned user-line uuid rides the retry too: the thread anchor recorded
    // at send time is keyed by it, so a retry that minted (or omitted) a uuid would
    // land the message at the top level while the chip still promised a thread.
    // Harmless when the server re-drains the original row (it already carries it).
    buildImageRefsPayload(failedMsg.images)
      .then((imagePayload) => wsClient.sendRpc<{ messageId: string; dedupText?: string; enqueuedAt?: string }>(
        'session:send',
        {
          sessionId, message: failedMsg.text, retryOf: queueId, ...imagePayload,
          ...(failedMsg.userUuid ? { userUuid: failedMsg.userUuid } : {}),
        },
      ))
      .then((res) => {
        if (res?.messageId) {
          const adopted = statusOnAdopt(res.messageId, deliveredEarlyRef.current);
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === queueId
              ? { ...m, queueId: res.messageId, status: m.status === 'delivered' ? m.status : adopted, ...(res.dedupText ? { dedupText: res.dedupText } : {}), ...(res.enqueuedAt ? { timestamp: res.enqueuedAt } : {}) }
              : m
          ));
        }
      })
      .catch((e: Error) => {
        log.error('send', 'Retry failed', { sessionId, error: e.message });
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === queueId ? { ...m, status: 'failed' as const, failedError: e.message } : m
        ));
      });
  }, []);

  /** Remove a failed message from the optimistic list. */
  const dismissFailed = useCallback((queueId: string) => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
  }, []);

  const handleMessagesDelivered = useCallback((count: number, messageIds?: string[]) => {
    log.info('send', 'delivered', { count, messageIds });
    // Exactly the bubbles the ids name (a failed one too: it ran after all); the
    // count only for an id-less event. Rules live in optimistic-dedup.ts (unit-tested).
    const early = deliveredEarlyRef.current;
    for (const id of unmatchedDeliveredIds(msgsRef.current, messageIds)) early.add(id);
    while (early.size > 64) early.delete(early.values().next().value!);
    const ids = new Set(messageIds ?? []);
    const revived = msgsRef.current.some((m) => m.status === 'failed' && ids.has(m.queueId));
    const stillFailed = msgsRef.current.some((m) => m.status === 'failed' && !ids.has(m.queueId));
    setOptimisticMsgs((prev) => markDeliveredMessages(prev, count, messageIds) as OptimisticMessage[]);
    // The red error was about a message that did reach the CLI: nothing failed now.
    if (revived && !stillFailed) setSendError(null);
  }, []);

  const handleBatchCompleted = useCallback((count: number, messageIds?: string[]) => {
    log.info('send', 'batch completed', { count, messageIds });
    // Id-first removal (exactly the batch's bubbles — a stale/raced event can
    // never take out an unrelated newer message), count fallback with the
    // delivered-only NO-LOSS guard — rules live in optimistic-dedup.ts.
    setOptimisticMsgs((prev) => removeBatchMessages(prev, count, messageIds));
  }, []);

  // Backend processNext failed to deliver the batch (e.g. SSH/daemon down). Mark the
  // matching optimistic messages 'failed' (keep text + show Retry) instead of removing
  // them. The messages stay in the server-side pending queue, so Retry can re-send.
  const handleBatchFailed = useCallback((messageIds: string[], error: string) => {
    log.warn('send', 'batch failed', { count: messageIds.length, error });
    setSendError(error);
    const idSet = new Set(messageIds);
    setOptimisticMsgs((prev) => prev.map((m) =>
      idSet.has(m.queueId) ? { ...m, status: 'failed' as const, failedError: error } : m
    ));
  }, []);

  const handleEditQueued = useCallback((sessionId: string, queueId: string, newText: string) => {
    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, text: newText } : m
    ));
    wsClient.sendRpc('session:edit-queued', {
      sessionId, messageId: queueId, text: newText,
    }).catch((e: Error) => { log.warn('send', 'edit-queued failed', { sessionId, queueId, error: e.message }); });
  }, []);

  const handleDeleteQueued = useCallback((sessionId: string, queueId: string) => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
    wsClient.sendRpc('session:delete-queued', {
      sessionId, messageId: queueId,
    }).catch((e: Error) => { log.warn('send', 'delete-queued failed', { sessionId, queueId, error: e.message }); });
  }, []);

  // Handle messages queued externally (e.g. by the agent via send_to_session)
  // These arrive via bus event after the server has already enqueued the message,
  // so we go straight to 'received' (shows "Queued" badge immediately).
  const addExternalQueued = useCallback((msg: { queueId: string; text: string; enqueuedAt?: string }) => {
    setOptimisticMsgs(prev => {
      // Dedup: skip if this queueId already exists (guard against double-delivery)
      if (prev.some(m => m.queueId === msg.queueId)) return prev;
      return [...prev, {
        queueId: msg.queueId,
        text: msg.text,
        role: 'user' as const,
        timestamp: msg.enqueuedAt ?? new Date().toISOString(),
        status: 'received' as const,
      }];
    });
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
    sendError,
    send,
    interruptSend,
    stopTurn,
    retryFailed,
    dismissFailed,
    handleMessagesDelivered,
    handleBatchCompleted,
    handleBatchFailed,
    handleEditQueued,
    handleDeleteQueued,
    addExternalQueued,
    clearOptimistic,
  };
}
