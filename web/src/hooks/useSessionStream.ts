import { useState, useCallback, useRef, useEffect } from 'react';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import { isToolResultError } from '@/api/chat';

/** A streaming block — text, tool call, or tool result */
export interface StreamingTextBlock {
  type: 'text';
  content: string;
}

export interface StreamingToolCallBlock {
  type: 'tool_call';
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
  planContent?: string;
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string;
}

export interface StreamingSystemBlock {
  type: 'system';
  variant: 'compact' | 'error' | 'info';
  message: string;
  detail?: string;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock;

interface StreamSnapshot {
  blocks: StreamingBlock[];
  isStreaming: boolean;
}

interface UseSessionStreamReturn {
  /** Blocks accumulated during the current streaming session */
  blocks: StreamingBlock[];
  /** Whether there's an active stream running */
  isStreaming: boolean;
  /** Clear accumulated blocks (e.g., when batch completes) */
  clear: () => void;
}

/**
 * Subscribe to session streaming events for a specific session.
 *
 * On mount / sessionId change:
 *  1. Sends `session:stream-subscribe` RPC to the server
 *  2. Server registers this client for targeted streaming events
 *  3. Returns a snapshot of the current buffer (catch-up)
 *  4. Incremental events arrive only for the subscribed session
 */
export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [blocks, setBlocks] = useState<StreamingBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamBuffer = useRef('');
  const activeSessionId = useRef<string | null>(null);
  const resubscribePending = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track WS connection state to re-subscribe on reconnect
  const [wsConnected, setWsConnected] = useState(wsClient.state === 'connected');
  useEffect(() => {
    const onStateChange = (state: ConnectionState) => setWsConnected(state === 'connected');
    wsClient.onConnectionChange(onStateChange);
    return () => { wsClient.offConnectionChange(onStateChange); };
  }, []);

  // Subscribe to backend stream buffer when sessionId changes OR WS reconnects
  useEffect(() => {
    activeSessionId.current = sessionId;

    if (!sessionId || !wsConnected) {
      if (!sessionId) {
        setBlocks([]);
        setIsStreaming(false);
        streamBuffer.current = '';
      }
      return;
    }

    // Subscribe and get snapshot from backend buffer.
    // On fresh sessionId change we reset blocks for a clean slate.
    // On WS reconnect (same sessionId) we keep existing blocks and merge the snapshot.
    const isFreshSession = blocks.length === 0;
    if (isFreshSession) {
      setBlocks([]);
      setIsStreaming(false);
      streamBuffer.current = '';
    }

    wsClient.sendRpc<StreamSnapshot>('session:stream-subscribe', { sessionId })
      .then((snapshot) => {
        // Guard: session may have changed during the async RPC
        if (activeSessionId.current !== sessionId) return;
        if (snapshot) {
          setBlocks(snapshot.blocks);
          setIsStreaming(snapshot.isStreaming);
          // Reconstruct text buffer from the last text block
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
          streamBuffer.current = lastText ? lastText.content : '';
        }
      })
      .catch(() => {
        // Subscription failed — stay with current state
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, wsConnected]);

  // ── Re-subscribe on session:status-changed → in_progress ──
  // This catches cases where the server-side subscription became stale
  // (e.g., brief WS reconnect, timing edge case). The broadcast event
  // `session:status-changed` always arrives reliably — use it to
  // re-establish the targeted stream subscription.

  const doResubscribe = useCallback((sid: string) => {
    if (resubscribePending.current) return; // avoid duplicate RPCs
    resubscribePending.current = true;

    wsClient.sendRpc<StreamSnapshot>('session:stream-subscribe', { sessionId: sid })
      .then((snapshot) => {
        resubscribePending.current = false;
        if (activeSessionId.current !== sid) return;
        if (snapshot) {
          // Only apply snapshot if we don't already have streaming data
          // (avoid clobbering blocks from incremental events that arrived in between)
          setBlocks((prev) => prev.length > 0 ? prev : snapshot.blocks);
          if (snapshot.isStreaming) setIsStreaming(true);
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
          if (lastText) streamBuffer.current = lastText.content;
        }
      })
      .catch(() => {
        resubscribePending.current = false;
      });
  }, []);

  useEvent('session:status-changed', (data) => {
    const { sessionId: sid, work_status } = data as {
      sessionId: string; work_status: string;
    };
    if (!sessionId || sid !== sessionId) return;
    if (work_status !== 'in_progress') return;

    // Session just transitioned to in_progress — re-subscribe to ensure
    // the server-side subscription mapping is fresh and get any buffered data.
    doResubscribe(sid);

    // Safety-net: if isStreaming is still false after 3s, force one more re-subscribe.
    // Clear any existing timer first.
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      if (activeSessionId.current !== sid) return;
      // Check latest isStreaming via functional setState trick (read without extra ref)
      setIsStreaming((current) => {
        if (!current) {
          // Still not streaming — force one more re-subscribe
          resubscribePending.current = false; // reset so doResubscribe proceeds
          doResubscribe(sid);
        }
        return current;
      });
    }, 3000);
  });

  // Cancel safety timer when isStreaming becomes true or sessionId changes
  useEffect(() => {
    if (isStreaming && safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    return () => {
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
  }, [sessionId]);

  // ── Incremental updates (only received for the subscribed session via server-side filtering) ──

  // Handle text deltas — batch via rAF to coalesce rapid tokens into ~60 renders/sec
  const textDeltaRaf = useRef<number | null>(null);

  /** Flush any pending rAF text update synchronously, then cancel the frame.
   *  Called before streamBuffer is cleared (tool-use, result, error, session switch)
   *  to prevent data loss from the race: delta→rAF queued→buffer cleared→rAF fires with empty. */
  const flushPendingTextRaf = useCallback(() => {
    if (textDeltaRaf.current !== null) {
      cancelAnimationFrame(textDeltaRaf.current);
      textDeltaRaf.current = null;

      // Apply buffered text synchronously
      const accumulated = streamBuffer.current;
      if (accumulated) {
        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'text') {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated }];
          }
          return [...prev, { type: 'text', content: accumulated }];
        });
      }
    }
  }, []);

  // Cancel pending rAF on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => {
      if (textDeltaRaf.current !== null) {
        cancelAnimationFrame(textDeltaRaf.current);
        textDeltaRaf.current = null;
      }
    };
  }, []);

  useEvent('session:text-delta', (data) => {
    const { sessionId: sid, delta } = data as { sessionId: string; delta: string; taskId: string };
    if (!sessionId || sid !== sessionId) return; // defensive client-side check

    setIsStreaming(true);
    streamBuffer.current += delta;

    if (textDeltaRaf.current === null) {
      textDeltaRaf.current = requestAnimationFrame(() => {
        textDeltaRaf.current = null;
        const accumulated = streamBuffer.current;

        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'text') {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated }];
          }
          return [...prev, { type: 'text', content: accumulated }];
        });
      });
    }
  });

  // Handle tool use events
  useEvent('session:tool-use', (data) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId } = data as {
      sessionId: string; toolName: string; toolUseId: string;
      input?: Record<string, unknown>; taskId: string; planContent?: string; parentToolUseId?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);
    // Flush any pending text before resetting the buffer
    flushPendingTextRaf();
    streamBuffer.current = '';

    setBlocks((prev) => [
      ...prev,
      { type: 'tool_call', toolUseId, name: toolName, input, status: 'calling', ...(planContent ? { planContent } : {}), ...(parentToolUseId ? { parentToolUseId } : {}) },
    ]);
  });

  // Handle tool result events
  useEvent('session:tool-result', (data) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string; toolUseId: string; result: string; taskId: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setBlocks((prev) => {
      const updated = [...prev];
      // Find the matching tool_call block and mark it done
      for (let i = updated.length - 1; i >= 0; i--) {
        const b = updated[i];
        if (b.type === 'tool_call' && b.toolUseId === toolUseId && b.status === 'calling') {
          updated[i] = { ...b, status: isToolResultError(result) ? 'error' : 'done', result };
          break;
        }
      }
      return updated;
    });
  });

  // Handle system events (compact, error, info notifications)
  useEvent('session:system-event', (data) => {
    const { sessionId: sid, variant, message, detail } = data as {
      sessionId: string; variant: 'compact' | 'error' | 'info'; message: string; detail?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    // Don't set isStreaming — system events are notifications, not active text streaming.
    flushPendingTextRaf();
    streamBuffer.current = '';  // system event breaks text accumulation

    setBlocks((prev) => [...prev, { type: 'system', variant, message, detail } as StreamingSystemBlock]);
  });

  // Handle session result (streaming done)
  useEvent('session:result', (data) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sessionId || sid !== sessionId) return;

    // Flush any pending text before clearing — prevents last-frame data loss
    flushPendingTextRaf();
    setIsStreaming(false);
    streamBuffer.current = '';
  });

  // Handle session error (streaming done with error)
  useEvent('session:error', (data) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sessionId || sid !== sessionId) return;

    flushPendingTextRaf();
    setIsStreaming(false);
    streamBuffer.current = '';
  });

  const clear = useCallback(() => {
    flushPendingTextRaf();
    setBlocks([]);
    setIsStreaming(false);
    streamBuffer.current = '';
  }, [flushPendingTextRaf]);

  return { blocks, isStreaming, clear };
}
