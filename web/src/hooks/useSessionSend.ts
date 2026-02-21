import { useState, useCallback, useEffect } from 'react';
import { wsClient } from '@/api/ws';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { ImageAttachment } from '@/api/chat';

interface UseSessionSendReturn {
  optimisticMsgs: OptimisticMessage[];
  sendError: string | null;
  send: (sessionId: string, message: string, images?: ImageAttachment[]) => void;
  interruptSend: (sessionId: string, message: string, images?: ImageAttachment[]) => void;
  handleMessagesDelivered: (count: number) => void;
  handleBatchCompleted: (count: number) => void;
  handleEditQueued: (sessionId: string, queueId: string, newText: string) => void;
  handleDeleteQueued: (sessionId: string, queueId: string) => void;
  addExternalQueued: (msg: { queueId: string; text: string }) => void;
  clearOptimistic: () => void;
  clearCommitted: () => void;
}

/**
 * Shared hook for sending messages to Claude Code sessions with optimistic UI.
 * Used by both SessionsPage and TaskDetailPage.
 *
 * ## State machine: optimisticMsgs[]
 *
 *   pending → received → delivered → committed → (removed by dedup or handleBatchCompleted)
 *
 *   - send()                   → appends as 'pending', then RPC resolves → 'received'
 *   - handleMessagesDelivered  → first N pending/received → 'delivered'
 *   - handleBatchCompleted     → (1) removes old committed, (2) first N remaining → 'committed'
 *   - clearCommitted           → removes all committed (called externally if needed)
 *
 * ## handleBatchCompleted — why it removes old committed first
 *
 * In a multi-turn conversation, the user may send messages across multiple turns.
 * When batch N+1 completes, the committed messages from batch N are already in
 * persisted JSONL history. If we kept them and promoted new messages, the array
 * would accumulate stale committed entries. The dedup in SessionChatHistory
 * uses prevMsgLen-based scanning — once prevMsgLen advances past the persisted
 * entry for an old committed message, that committed message can't be deduped
 * anymore and would appear as a duplicate. So we clean them here.
 *
 * See SessionChatHistory.tsx top-of-file doc block for the full lifecycle.
 */
export function useSessionSend(activeSessionId: string | null): UseSessionSendReturn {
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  // Clear optimistic messages on session switch
  useEffect(() => {
    setOptimisticMsgs([]);
    setSendError(null);
  }, [activeSessionId]);

  const send = useCallback((sessionId: string, message: string, images?: ImageAttachment[]) => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    const rpcPayload: Record<string, unknown> = { sessionId, message };
    if (images && images.length > 0) {
      rpcPayload.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
    }
    wsClient.sendRpc<{ messageId: string }>('session:send', rpcPayload)
      .then((res) => {
        if (res?.messageId) {
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === tempId ? { ...m, queueId: res.messageId, status: 'received' as const } : m
          ));
        }
      })
      .catch((e: Error) => {
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
      });
  }, []);

  const interruptSend = useCallback((sessionId: string, message: string, images?: ImageAttachment[]) => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    const rpcPayload: Record<string, unknown> = { sessionId, message, interrupt: true };
    if (images && images.length > 0) {
      rpcPayload.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
    }
    wsClient.sendRpc<{ messageId: string }>('session:send', rpcPayload)
      .then((res) => {
        if (res?.messageId) {
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === tempId ? { ...m, queueId: res.messageId, status: 'received' as const } : m
          ));
        }
      })
      .catch((e: Error) => {
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
      });
  }, []);

  const handleMessagesDelivered = useCallback((count: number) => {
    setOptimisticMsgs((prev) => {
      let remaining = count;
      return prev.map((m) => {
        if (remaining > 0 && (m.status === 'pending' || m.status === 'received')) {
          remaining--;
          return { ...m, status: 'delivered' as const };
        }
        return m;
      });
    });
  }, []);

  const handleBatchCompleted = useCallback((count: number) => {
    setOptimisticMsgs((prev) => {
      // 1. Remove previously committed messages — they're from an earlier batch
      //    and are now in the persisted history. Keeping them causes duplicates
      //    because the dedup scan (prevMsgLen-based) has already advanced past
      //    their corresponding persisted entries.
      const withoutOldCommitted = prev.filter(m => m.status !== 'committed');
      // 2. Promote the first `count` messages to 'committed'.
      //    Committed messages render as normal user messages and persist in the UI
      //    until the JSONL history refresh deduplicates them away.
      const updated = [...withoutOldCommitted];
      let remaining = count;
      for (let i = 0; i < updated.length && remaining > 0; i++) {
        updated[i] = { ...updated[i], status: 'committed' as const };
        remaining--;
      }
      return updated;
    });
  }, []);

  const handleEditQueued = useCallback((sessionId: string, queueId: string, newText: string) => {
    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, text: newText } : m
    ));
    wsClient.sendRpc('session:edit-queued', {
      sessionId, messageId: queueId, text: newText,
    }).catch(() => { /* best-effort */ });
  }, []);

  const handleDeleteQueued = useCallback((sessionId: string, queueId: string) => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
    wsClient.sendRpc('session:delete-queued', {
      sessionId, messageId: queueId,
    }).catch(() => { /* best-effort */ });
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

  const clearCommitted = useCallback(() => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.status !== 'committed'));
  }, []);

  return {
    optimisticMsgs,
    sendError,
    send,
    interruptSend,
    handleMessagesDelivered,
    handleBatchCompleted,
    handleEditQueued,
    handleDeleteQueued,
    addExternalQueued,
    clearOptimistic,
    clearCommitted,
  };
}
