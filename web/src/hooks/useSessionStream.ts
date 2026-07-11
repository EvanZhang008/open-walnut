import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import { isToolResultError } from '@/api/chat';
import { log } from '@/utils/log';
import {
  trackSession,
  getStreamState,
  clearStreamState,
  initStreamState,
  type StreamSnapshot,
} from '@/cache/session-cache';
import { shouldAdoptSnapshot } from '@/cache/snapshot-adoption';
import {
  writeMainText,
  appendMainThinking,
  appendLaneText,
  appendLaneThinking,
  appendToolCall,
  backfillToolResult,
  findToolCall,
  appendSystemBlock,
  lastMainLaneText,
  type StreamingBlock,
  type StreamingPermissionBlock,
} from '@/stream/stream-reducer';

// Block types + accumulation semantics live in stream-reducer — the SINGLE copy
// shared with session-cache (formerly three divergent mirrors). Re-exported so
// existing `import type { … } from '@/hooks/useSessionStream'` sites keep working.
export type {
  StreamingBlock,
  StreamingTextBlock,
  StreamingToolCallBlock,
  StreamingSystemBlock,
  StreamingPermissionBlock,
  StreamingThinkingBlock,
} from '@/stream/stream-reducer';

interface UseSessionStreamReturn {
  /** Blocks accumulated during the current streaming session. APPEND-ONLY:
   *  reconciliation never deletes from this array — the render filter
   *  (stream/render-filter.ts) HIDES blocks proven absorbed by history.
   *  Physical removal happens only via resetIfAbsorbed() / session switch
   *  (all-or-nothing), so block INDICES are stable render identities. */
  blocks: StreamingBlock[];
  /** Whether there's an active stream running */
  isStreaming: boolean;
  /** Memory reclamation: full reset iff EVERY block is hidden (absorbed by
   *  history) and no turn is live. All-or-nothing keeps indices stable — no
   *  partial deletion, no anchor shifting, no ordering sensitivity. The caller
   *  (SessionChatHistory) holds the hidden set; passing hiddenCount here keeps
   *  the evidence check at the layer that computed it. Returns true if reset. */
  resetIfAbsorbed: (hiddenCount: number) => boolean;
}

/**
 * Subscribe to session streaming events for a specific session.
 *
 * On mount / sessionId change:
 *  1. Sends `session:stream-subscribe` RPC to the server
 *  2. Server returns a snapshot of the current buffer (catch-up)
 *  3. Incremental events arrive via broadcast; client filters by sessionId
 */
export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [blocks, setBlocks] = useState<StreamingBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamBuffer = useRef('');
  const activeSessionId = useRef<string | null>(null);
  const seenPermissionIds = useRef(new Set<string>());
  const resubscribePending = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Turn boundary: blocks[0..completedLen) belong to turns that already emitted
  // session:result/session:error. This is a MERGE boundary only — the next
  // turn's deltas must never rewrite a finished turn's final block (see
  // stream-reducer liveness rule). It no longer drives any deletion.
  const completedLen = useRef(0);
  // Server buffer seq recorded at the last adopted snapshot (Phase 1 seq-based
  // adoption). null = never adopted for this session / pre-seq server.
  const lastAdoptedSeq = useRef<number | null>(null);
  // Ref mirrors so resetIfAbsorbed (a stable callback) can read current state
  // synchronously. useLayoutEffect (not useEffect): callers invoke it from
  // their own useLayoutEffect, and this hook's effects flush first within
  // the same commit — useEffect would be one paint stale.
  const isStreamingRef = useRef(false);
  useLayoutEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  const blocksLenRef = useRef(0);
  useLayoutEffect(() => { blocksLenRef.current = blocks.length; }, [blocks]);

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
        currentTextMsgId.current = undefined;
        lastAdoptedSeq.current = null;
      }
      return;
    }

    // Track session so global cache listeners accumulate its events in the background
    trackSession(sessionId);

    // Show cached state instantly (0ms), then correct from server snapshot below.
    // The cache may be stale (missed events during WS disconnect), so the RPC
    // subscribe always runs as authoritative correction.
    const cached = getStreamState(sessionId);
    if (cached) {
      log.info('stream', `cache hit: blocks=${cached.blocks.length} isStreaming=${cached.isStreaming}`, { sessionId });
      setBlocks([...cached.blocks]);
      setIsStreaming(cached.isStreaming);
      streamBuffer.current = cached.textBuffer;
      completedLen.current = cached.completedLen;
    } else {
      setBlocks([]);
      setIsStreaming(false);
      streamBuffer.current = '';
      completedLen.current = 0;
    }
    currentTextMsgId.current = undefined;
    // Session switch OR reconnect: the server buffer may be a new generation —
    // forget the adopted seq so the next snapshot falls back to legacy rules.
    lastAdoptedSeq.current = null;

    // Always subscribe to get server snapshot for correction (background).
    //
    // Non-regressive merge: this useEffect re-runs on WS reconnect too, and the
    // server snapshot may lag behind live events that have already been applied
    // to blocks/isStreaming via the incremental WS handlers. Clobbering them
    // here caused the "1. 2. 3 → restart 1. 2. 3" replay bug: reattachWatcher
    // on reconnect made daemon catch-up push bytes through the delta pipeline
    // into blocks, then this snapshot fired a moment later with older/shorter
    // state and overwrote the in-progress turn.
    //
    // Rules (mirrored from doResubscribe below):
    //   - blocks:      only overwrite if we currently have none (initial load)
    //   - isStreaming: only promote false→true (never regress a live turn)
    wsClient.sendRpc<StreamSnapshot>('session:stream-subscribe', { sessionId })
      .then((snapshot) => {
        // Guard: session may have changed during the async RPC
        if (activeSessionId.current !== sessionId) return;
        if (!snapshot) return;
        log.info('stream', `subscribe snapshot: blocks=${snapshot.blocks.length} isStreaming=${snapshot.isStreaming}`, { sessionId });
        let appliedBlocks = false;
        setBlocks((prev) => {
          // Adoption rules live in shouldAdoptSnapshot (pure, unit-tested) —
          // both failure directions have shipped as production bugs: adopting
          // an EMPTY snapshot wiped evidence-kept blocks ("reply visible while
          // streaming, gone when done", inc-1783357192826); never adopting
          // left stale finished-turn duplicates next to history forever.
          if (!shouldAdoptSnapshot({
            prevLen: prev.length,
            snapshotLen: snapshot.blocks.length,
            snapshotIsStreaming: snapshot.isStreaming,
            localIsStreaming: isStreamingRef.current,
            snapshotSeq: snapshot.seq,
            lastAdoptedSeq: lastAdoptedSeq.current ?? undefined,
          })) return prev;
          appliedBlocks = true;
          if (snapshot.seq != null) lastAdoptedSeq.current = snapshot.seq;
          // Server-authoritative boundary when present (see StreamSnapshot doc);
          // legacy fallback: finished turn → all completed, live turn → none.
          completedLen.current = snapshot.completedLen
            ?? (snapshot.isStreaming ? 0 : snapshot.blocks.length);
          return snapshot.blocks;
        });
        setIsStreaming((prev) => (snapshot.isStreaming && !prev) ? true : prev);
        if (appliedBlocks) {
          const lastText = lastMainLaneText(snapshot.blocks);
          streamBuffer.current = lastText ? lastText.content : '';
          // Seed global cache with server snapshot for correction
          initStreamState(sessionId, snapshot.blocks, snapshot.isStreaming, snapshot.completedLen);
          // Seed seenPermissionIds from snapshot (prevent duplicate blocks on re-emit)
          for (const b of snapshot.blocks) {
            if (b.type === 'permission') seenPermissionIds.current.add(b.requestId);
          }
        }
      })
      .catch(() => {
        // Subscription failed — stay with current state (cache or empty)
      });

    // Fallback: fetch pending permissions from REST (covers cases where buffer was pruned)
    fetch(`/api/sessions/${sessionId}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { pendingPermissions?: Array<{ requestId: string; toolName?: string; input?: Record<string, unknown>; reason?: string }> } | null) => {
        if (activeSessionId.current !== sessionId) return;
        const perms = data?.pendingPermissions;
        if (!perms?.length) return;
        setBlocks(prev => {
          const existingIds = new Set(prev.filter(b => b.type === 'permission').map(b => (b as StreamingPermissionBlock).requestId));
          const newBlocks = perms
            .filter(p => !existingIds.has(p.requestId))
            .map(p => ({ type: 'permission' as const, requestId: p.requestId, toolName: p.toolName ?? 'unknown', input: p.input, reason: p.reason }));
          if (newBlocks.length === 0) return prev;
          for (const b of newBlocks) seenPermissionIds.current.add(b.requestId);
          return [...prev, ...newBlocks];
        });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, wsConnected]);

  // ── Re-fetch snapshot on session:status-changed → in_progress ──
  // When a session transitions to in_progress (e.g., after WS reconnect or
  // timing edge case), re-fetch the snapshot to catch up on any missed events.

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
          setBlocks((prev) => {
            if (prev.length > 0) return prev;
            completedLen.current = snapshot.completedLen
              ?? (snapshot.isStreaming ? 0 : snapshot.blocks.length);
            if (snapshot.seq != null) lastAdoptedSeq.current = snapshot.seq;
            return snapshot.blocks;
          });
          // Non-regressive sync: snapshot only allowed to promote isStreaming false→true.
          // Rationale: a stale server-side buffer (cleared 2s after previous session:result)
          // returns isStreaming=false even while a new turn is live; unconditional sync
          // would flip the active stream to 'done' and trigger the downstream defensive
          // clear, wiping live blocks.  Termination of a turn now relies solely on real
          // events: session:result / session:error / session:status-changed backstop.
          setIsStreaming((prev) => {
            if (snapshot.isStreaming && !prev) {
              log.info('stream', `resubscribe snapshot → isStreaming false→true`, { sessionId: sid });
              return true;
            }
            if (!snapshot.isStreaming && prev) {
              log.info('stream', `resubscribe snapshot stale (prev=true, snap=false) — ignoring`, { sessionId: sid });
            }
            return prev;
          });
          const lastText = lastMainLaneText(snapshot.blocks);
          if (lastText) streamBuffer.current = lastText.content;
        }
      })
      .catch(() => {
        resubscribePending.current = false;
      });
  }, []);

  useEvent('session:status-changed', (data) => {
    const { sessionId: sid, phase, process_status } = data as {
      sessionId: string; phase?: string; process_status?: string;
    };
    if (!sessionId || sid !== sessionId) return;
    // Re-subscribe when session transitions to running (IN_PROGRESS phase or running process)
    const isActive = phase === 'IN_PROGRESS' || process_status === 'running';
    if (!isActive) {
      // Backstop: when the process reaches a non-active state (stopped/error/idle),
      // force-clear isStreaming. This covers cases where session:result was missed
      // (WS disconnect, sessionId mismatch, process crash). session:status-changed
      // is broadcast with ['*'] destinations so it's the most reliable termination signal.
      // 'idle' is terminal for streaming: FIFO sessions stay alive between turns in
      // 'idle', with no deltas until the next user send — so clearing here matches the
      // actual "not streaming" state. A new turn will flip isStreaming back to true via
      // the text-delta / tool-use handlers before any visible lag.
      if (process_status === 'stopped' || process_status === 'error' || process_status === 'idle') {
        // Ordering: flush BEFORE clearing isStreaming. A pending rAF text frame may
        // still be queued from the last delta; if we flipped isStreaming first, the UI
        // could render the "done" state before the final text chunk lands. flushPendingTextRaf
        // drains the buffer synchronously.
        flushPendingTextRaf();
        setIsStreaming((prev) => {
          if (prev) log.info('stream', `status-changed ps=${process_status} → isStreaming true→false`, { sessionId: sid });
          return false;
        });
        // Backstop turn boundary: if session:result was missed (WS drop), stamp
        // the merge boundary so the next turn's deltas open a new block.
        setBlocks((prev) => {
          completedLen.current = Math.max(completedLen.current, prev.length);
          return prev;
        });
      } else {
        log.info('stream', `status-changed → phase=${phase} ps=${process_status} (not active, skipping)`, { sessionId: sid });
      }
      return;
    }

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

  // ── Incremental updates (broadcast to all clients; filtered by sessionId client-side) ──

  // Handle text deltas — batch via rAF to coalesce rapid tokens into ~60 renders/sec
  const textDeltaRaf = useRef<number | null>(null);
  // msgId of the message currently accumulating in streamBuffer. ACP-dialect
  // boundary rule: when an incoming delta carries a DIFFERENT msgId, the
  // previous message is complete — flush it and start a fresh block. Stamped
  // onto the block so promotion can match it against history by id.
  const currentTextMsgId = useRef<string | undefined>(undefined);

  /** Flush any pending rAF text update synchronously, then cancel the frame.
   *  Called before streamBuffer is cleared (tool-use, result, error, session switch)
   *  to prevent data loss from the race: delta→rAF queued→buffer cleared→rAF fires with empty. */
  const flushPendingTextRaf = useCallback(() => {
    if (textDeltaRaf.current !== null) {
      cancelAnimationFrame(textDeltaRaf.current);
      textDeltaRaf.current = null;

      // Apply buffered text synchronously. Merge/new-block/liveness rules live
      // in the reducer (single copy): merge only into a LIVE main-lane text
      // block of the SAME message.
      const accumulated = streamBuffer.current;
      const msgId = currentTextMsgId.current;
      if (accumulated) {
        setBlocks((prev) => writeMainText(prev, accumulated, msgId, completedLen.current));
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
    const { sessionId: sid, delta, msgId, parentToolUseId, subagentType, taskDescription } = data as {
      sessionId: string; delta: string; taskId: string; msgId?: string; parentToolUseId?: string;
      subagentType?: string; taskDescription?: string;
    };
    if (!sessionId || sid !== sessionId) return; // defensive client-side check

    setIsStreaming((prev) => {
      if (!prev) log.info('stream', 'text-delta → isStreaming false→true', { sessionId: sid });
      return true;
    });

    // Subagent lane: the CLI interleaves inline-subagent text into the middle
    // of the main turn's token stream. It must NEVER touch the main rAF
    // accumulator (that's what split main text mid-token) — append/merge
    // directly into this lane's own block. Subagent text arrives as whole
    // message chunks (assistant lines, not token streams), so no rAF coalescing
    // is needed.
    if (parentToolUseId) {
      setBlocks((prev) => appendLaneText(prev, { delta, msgId, parentToolUseId, subagentType, taskDescription }));
      return;
    }

    // Message boundary: a different msgId means the previous message finished —
    // flush its pending rAF content, then restart the accumulator for the new one.
    if (msgId && currentTextMsgId.current && msgId !== currentTextMsgId.current) {
      flushPendingTextRaf();
      streamBuffer.current = '';
    }
    if (msgId) currentTextMsgId.current = msgId;
    streamBuffer.current += delta;

    if (textDeltaRaf.current === null) {
      textDeltaRaf.current = requestAnimationFrame(() => {
        textDeltaRaf.current = null;
        const accumulated = streamBuffer.current;
        const accMsgId = currentTextMsgId.current;
        setBlocks((prev) => writeMainText(prev, accumulated, accMsgId, completedLen.current));
      });
    }
  });

  // Handle tool use events
  useEvent('session:tool-use', (data) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId, subagentType, taskDescription } = data as {
      sessionId: string; toolName: string; toolUseId: string;
      input?: Record<string, unknown>; taskId: string; planContent?: string; parentToolUseId?: string;
      subagentType?: string; taskDescription?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);
    // A MAIN-lane tool call interrupts the main text flow — flush and reset the
    // accumulator. A subagent tool call (parentToolUseId set) lives in its own
    // lane and must NOT cut the main turn's text mid-token.
    if (!parentToolUseId) {
      flushPendingTextRaf();
      streamBuffer.current = '';
    }

    setBlocks((prev) => {
      // DUP-DEBUG: detect duplicate tool_use rendering at the closest layer
      // to the UI. If this WARN fires, the same toolUseId already exists in
      // local block state when a new event arrived — that's exactly what the
      // user sees as two identical Bash panels.
      const existing = findToolCall(prev, toolUseId);
      if (existing) {
        log.warn('frontend', 'session:tool-use DUPLICATE — toolUseId already in blocks', {
          sessionId: sid, toolUseId, toolName,
          existingStatus: existing.status,
          totalBlocks: prev.length,
        });
      }
      return appendToolCall(prev, { toolUseId, toolName, input, planContent, parentToolUseId, subagentType, taskDescription });
    });
  });

  // Handle tool result events
  useEvent('session:tool-result', (data) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string; toolUseId: string; result: string; taskId: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setBlocks((prev) => backfillToolResult(prev, toolUseId, result, isToolResultError(result)));
  });

  // pendingThinking holds only deltas not yet flushed to setBlocks; it is the
  // raf-coalescing buffer, NOT the source of truth for any thinking block. The
  // committed text lives inside the last thinking block in setBlocks. Cleared
  // every flush, so a later thinking segment (after text/tool interrupts) can
  // never carry forward text from an earlier segment.
  const pendingThinking = useRef('');
  const thinkingDeltaRaf = useRef<number | null>(null);
  // msgId of the thinking segment currently accumulating (see currentTextMsgId).
  const currentThinkingMsgId = useRef<string | undefined>(undefined);

  useEvent('session:thinking-delta', (data) => {
    const { sessionId: sid, delta, msgId, parentToolUseId } = data as {
      sessionId: string; delta: string; msgId?: string; parentToolUseId?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);

    // Subagent lane — same isolation rule as text-delta (whole-message chunks,
    // no rAF coalescing needed).
    if (parentToolUseId) {
      setBlocks((prev) => appendLaneThinking(prev, { delta, msgId, parentToolUseId }));
      return;
    }

    if (msgId) currentThinkingMsgId.current = msgId;
    pendingThinking.current += delta;

    if (thinkingDeltaRaf.current === null) {
      thinkingDeltaRaf.current = requestAnimationFrame(() => {
        thinkingDeltaRaf.current = null;
        const incoming = pendingThinking.current;
        const accMsgId = currentThinkingMsgId.current;
        pendingThinking.current = '';
        if (!incoming) return;
        setBlocks((prev) => appendMainThinking(prev, incoming, accMsgId, completedLen.current));
      });
    }
  });

  // ── Unknown-event catch-all: surface as an info system block so new CLI
  //    event types never silently disappear from the UI. ──
  useEvent('session:unknown-event', (data) => {
    const { sessionId: sid, scope, eventType, snippet } = data as {
      sessionId: string; scope: string; eventType: string; snippet: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setBlocks((prev) => appendSystemBlock(prev, {
      variant: 'info', message: `Unknown Claude event: ${scope}:${eventType}`, detail: snippet,
    }));
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

    setBlocks((prev) => appendSystemBlock(prev, { variant, message, detail }));
  });

  // Handle permission request events (control_request from Claude Code)
  useEvent('session:permission-request', (data) => {
    const { sessionId: sid, requestId, toolName, input, reason } = data as {
      sessionId: string; requestId: string; toolName: string;
      input?: Record<string, unknown>; reason?: string;
    };
    if (!sessionId || sid !== sessionId) return;
    if (seenPermissionIds.current.has(requestId)) return; // dedup
    seenPermissionIds.current.add(requestId);

    flushPendingTextRaf();
    streamBuffer.current = '';
    setBlocks(prev => [...prev, { type: 'permission', requestId, toolName, input, reason }]);
  });

  // Handle permission resolved events (update block status from pending → allowed/denied)
  useEvent('session:permission-resolved', (data) => {
    const { sessionId: sid, requestId, allowed } = data as {
      sessionId: string; requestId: string; allowed: boolean;
    };
    if (!sessionId || sid !== sessionId) return;
    setBlocks(prev => prev.map(b =>
      b.type === 'permission' && b.requestId === requestId
        ? { ...b, status: allowed ? 'allowed' as const : 'denied' as const }
        : b,
    ));
  });

  // Handle session result (streaming done). NOTE: session:batch-completed for
  // the same turn reliably arrives BEFORE this event (server bus fans out
  // synchronously in subscription order; the result re-emit awaits task
  // enrichment) — nothing here may assume result-first ordering.
  useEvent('session:result', (data) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sessionId || sid !== sessionId) return;

    // Flush any pending text before clearing — prevents last-frame data loss
    flushPendingTextRaf();
    setIsStreaming((prev) => {
      log.info('stream', `session:result → isStreaming ${prev}→false`, { sessionId: sid });
      return false;
    });
    setBlocks((prev) => {
      // Merge boundary: everything present now belongs to the completed turn.
      // The next turn's deltas must open new blocks, never rewrite these.
      // Nothing is deleted here — the render filter hides blocks once history
      // absorbs them (non-destructive single-timeline model).
      completedLen.current = prev.length;
      log.info('stream', `session:result blocks=${prev.length} (kept; hidden on absorption)`, { sessionId: sid });
      return prev;
    });
    streamBuffer.current = '';
  });

  // Handle session error (streaming done with error)
  useEvent('session:error', (data) => {
    const { sessionId: sid, error } = data as { sessionId: string; error?: string };
    if (!sessionId || sid !== sessionId) return;

    flushPendingTextRaf();
    setIsStreaming(false);
    streamBuffer.current = '';

    // Show the error inline in the session chat timeline
    if (error) {
      const detail = error.length > 500 ? error.slice(0, 500) + '…' : error;
      setBlocks((prev) => {
        const next = appendSystemBlock(prev, { variant: 'error', message: 'Session error', detail });
        completedLen.current = next.length; // error ends the turn
        return next;
      });
    } else {
      setBlocks((prev) => {
        completedLen.current = prev.length;
        return prev;
      });
    }
  });

  // Memory reclamation (single-timeline model): the render filter has proven
  // EVERY block absorbed by history — the array renders nothing, so dropping it
  // has zero visual effect. All-or-nothing by design: partial deletion is what
  // made the old model ordering-sensitive (shifted anchors, stale boundaries).
  // hiddenCount comes from the caller's computeRenderFilter result; comparing
  // against the CURRENT length guards against a block appended after that
  // computation (then count < length → no-op, retried next render).
  const resetIfAbsorbed = useCallback((hiddenCount: number): boolean => {
    if (isStreamingRef.current) return false;
    if (blocksLenRef.current === 0 || hiddenCount < blocksLenRef.current) return false;
    log.info('stream', `resetIfAbsorbed: all ${blocksLenRef.current} blocks absorbed → reset`, { sessionId: activeSessionId.current });
    setBlocks([]);
    blocksLenRef.current = 0;
    completedLen.current = 0;
    streamBuffer.current = '';
    currentTextMsgId.current = undefined;
    // Permission dedup only matters within a turn; a re-emitted request next
    // turn must not be swallowed.
    seenPermissionIds.current.clear();
    if (activeSessionId.current) clearStreamState(activeSessionId.current);
    return true;
  }, []);

  return { blocks, isStreaming, resetIfAbsorbed };
}
