import { useState, useCallback, useEffect, useRef } from 'react';
import { wsClient } from '@/api/ws';
import { buildImageRefsPayload } from '@/api/image-upload';
import { log } from '@/utils/log';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { ImageAttachment } from '@/api/chat';
import { removeBatchMessages, markDeliveredMessages } from '@/components/sessions/optimistic-dedup';

interface UseSessionSendReturn {
  optimisticMsgs: OptimisticMessage[];
  sendError: string | null;
  /** Resolves true once the message is persisted server-side (RPC ok), false if the RPC rejected. */
  send: (sessionId: string, message: string, images?: ImageAttachment[]) => Promise<boolean>;
  interruptSend: (sessionId: string, message: string, images?: ImageAttachment[]) => Promise<boolean>;
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

export function useSessionSend(activeSessionId: string | null): UseSessionSendReturn {
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  // Ref for accessing current optimistic messages in callbacks without stale closures
  const msgsRef = useRef(optimisticMsgs);
  msgsRef.current = optimisticMsgs;

  // Clear optimistic messages on session switch + rehydrate from server disk queue.
  // The queue only contains messages NOT yet delivered to Claude (pending/processing).
  // Once delivered, removeProcessed() clears them eagerly — so no overlap with JSONL.
  useEffect(() => {
    setOptimisticMsgs([]);
    setSendError(null);

    if (activeSessionId) {
      wsClient.sendRpc<{ messages: Array<{ id: string; message: string; status: string; enqueuedAt?: string }> }>(
        'session:get-queue',
        { sessionId: activeSessionId }
      ).then((res) => {
        if (res?.messages?.length) {
          setOptimisticMsgs(prev => {
            const existing = new Set(prev.map(m => m.queueId));
            const newMsgs = res.messages
              .filter(m => !existing.has(m.id))
              .map(m => {
                // The queue stores the ENQUEUED text, which for an attachment send
                // carries the server's `[Images attached …]` + paths prefix. Render
                // the user-facing part, but dedup against the full enqueued form
                // (that is what history echoes) — see OptimisticMessage.dedupText.
                const display = stripImageRefPrefix(m.message);
                return {
                  role: 'user' as const,
                  text: display,
                  timestamp: m.enqueuedAt ?? new Date().toISOString(),
                  queueId: m.id,
                  status: (m.status === 'processing' ? 'delivered' : 'received') as 'received' | 'delivered',
                  ...(display !== m.message ? { dedupText: m.message } : {}),
                };
              });
            return [...prev, ...newMsgs];
          });
          log.info('send', 'rehydrated from queue', {
            sessionId: activeSessionId,
            count: res.messages.length,
          });
        }
      }).catch((e: Error) => {
        log.warn('send', 'queue rehydrate failed', { error: e.message });
      });
    }
  }, [activeSessionId]);

  const send = useCallback(async (sessionId: string, message: string, images?: ImageAttachment[]): Promise<boolean> => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
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
      };
      const res = await wsClient.sendRpc<{ messageId: string; dedupText?: string }>('session:send', rpcPayload);
      if (res?.messageId) {
        // Adopt dedupText when the server augmented the text (image refs) — the
        // bubble keeps rendering the user's original, but dedups against what was
        // actually enqueued. See OptimisticMessage.dedupText.
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === tempId
            ? { ...m, queueId: res.messageId, status: 'received' as const, ...(res.dedupText ? { dedupText: res.dedupText } : {}) }
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

  const interruptSend = useCallback(async (sessionId: string, message: string, images?: ImageAttachment[]): Promise<boolean> => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching (interrupt)', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    try {
      const rpcPayload: Record<string, unknown> = {
        sessionId,
        message,
        interrupt: true,
        ...(await buildImageRefsPayload(images)),
      };
      const res = await wsClient.sendRpc<{ messageId: string; dedupText?: string }>('session:send', rpcPayload);
      if (res?.messageId) {
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === tempId
            ? { ...m, queueId: res.messageId, status: 'received' as const, ...(res.dedupText ? { dedupText: res.dedupText } : {}) }
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

  /** Retry a failed message — resets to pending and re-sends via RPC. */
  const retryFailed = useCallback((queueId: string, sessionId: string) => {
    const failedMsg = msgsRef.current.find(m => m.queueId === queueId && m.status === 'failed');
    if (!failedMsg) return;

    setSendError(null);
    const newTempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'retrying', { sessionId, oldQueueId: queueId, newQueueId: newTempId });

    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, queueId: newTempId, status: 'pending' as const, failedError: undefined } : m
    ));

    buildImageRefsPayload(failedMsg.images)
      .then((imagePayload) => wsClient.sendRpc<{ messageId: string; dedupText?: string }>(
        'session:send',
        { sessionId, message: failedMsg.text, ...imagePayload },
      ))
      .then((res) => {
        if (res?.messageId) {
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === newTempId
              ? { ...m, queueId: res.messageId, status: 'received' as const, ...(res.dedupText ? { dedupText: res.dedupText } : {}) }
              : m
          ));
        }
      })
      .catch((e: Error) => {
        log.error('send', 'Retry failed', { sessionId, error: e.message });
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.map((m) =>
          m.queueId === newTempId ? { ...m, status: 'failed' as const, failedError: e.message } : m
        ));
      });
  }, []);

  /** Remove a failed message from the optimistic list. */
  const dismissFailed = useCallback((queueId: string) => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
  }, []);

  const handleMessagesDelivered = useCallback((count: number, messageIds?: string[]) => {
    log.info('send', 'delivered', { count, messageIds });
    // Id-first (exactly the batch's bubbles), count fallback for tempId races /
    // id-less events — rules live in optimistic-dedup.ts (unit-tested).
    setOptimisticMsgs((prev) => markDeliveredMessages(prev, count, messageIds) as OptimisticMessage[]);
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
  const addExternalQueued = useCallback((msg: { queueId: string; text: string }) => {
    setOptimisticMsgs(prev => {
      // Dedup: skip if this queueId already exists (guard against double-delivery)
      if (prev.some(m => m.queueId === msg.queueId)) return prev;
      return [...prev, {
        queueId: msg.queueId,
        text: msg.text,
        role: 'user' as const,
        timestamp: new Date().toISOString(),
        status: 'received' as const,
      }];
    });
  }, []);

  const clearOptimistic = useCallback(() => {
    setOptimisticMsgs([]);
    setSendError(null);
  }, []);

  return {
    optimisticMsgs,
    sendError,
    send,
    interruptSend,
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
