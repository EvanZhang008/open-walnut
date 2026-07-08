import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import { isToolResultError } from '@/api/chat';
import { log } from '@/utils/log';
import type { SessionHistoryMessage } from '@/types/session';
import {
  trackSession,
  getStreamState,
  clearStreamState,
  clearCompletedTurn,
  initStreamState,
} from '@/cache/session-cache';
import { promoteCompletedBlocks } from '@/cache/promote-blocks';
import { shouldAdoptSnapshot } from '@/cache/snapshot-adoption';

/** A streaming block — text, tool call, or tool result */
export interface StreamingTextBlock {
  type: 'text';
  content: string;
  /** API message id (`msg_…`) this block belongs to — same id as the persisted
   *  history message, enabling id-based promotion instead of content matching.
   *  ACP-dialect rule: a CHANGE in msgId = a new message = a new block.
   *  Optional (absent on legacy events/snapshots). */
  msgId?: string;
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

export interface StreamingPermissionBlock {
  type: 'permission';
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  reason?: string;
  /** Set when resolved (from snapshot or permission-resolved event). Absent = pending. */
  status?: 'pending' | 'allowed' | 'denied';
}

/** Model reasoning ("thinking" mode). Rendered gray/italic, collapsible. */
export interface StreamingThinkingBlock {
  type: 'thinking';
  content: string;
  /** See StreamingTextBlock.msgId. */
  msgId?: string;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock | StreamingPermissionBlock | StreamingThinkingBlock;

interface StreamSnapshot {
  blocks: StreamingBlock[];
  isStreaming: boolean;
  /** Server-authoritative count of leading blocks that belong to finished turns.
   *  MUST be preferred over deriving from isStreaming: a snapshot taken between
   *  the next turn's markStreaming and its first delta carries the PREVIOUS
   *  turn's blocks with isStreaming=true — deriving mislabels them "live" and
   *  evidence-promotion then never removes them (permanent duplicates). */
  completedLen?: number;
  /** Monotonic server-side mutation counter for this session's buffer
   *  (0 = no buffer). Future id-based adoption compares this against the
   *  last-applied seq instead of guessing freshness from block lengths. */
  seq?: number;
}

interface UseSessionStreamReturn {
  /** Blocks accumulated during the current streaming session */
  blocks: StreamingBlock[];
  /** Whether there's an active stream running */
  isStreaming: boolean;
  /** Clear ALL accumulated blocks (session switch / hard reset) */
  clear: () => void;
  /** Turn-aware, EVIDENCE-BASED clear: remove a completed-turn block only if a
   *  twin is present in `delta` (the just-arrived persisted messages). Blocks of a
   *  turn that started streaming after the last session:result — and anything the
   *  archive hasn't caught up on — are preserved. Returns the removed count so
   *  callers can shift position anchors (blockIndexMap). */
  clearCompleted: (delta?: SessionHistoryMessage[]) => number;
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
  // session:result/session:error. Blocks past this index belong to a NEW turn that
  // started streaming while the post-turn history refresh was still in flight —
  // clearCompleted() must never wipe those (they'd vanish mid-generation).
  const completedLen = useRef(0);
  // Server buffer seq recorded at the last adopted snapshot (Phase 1 seq-based
  // adoption). null = never adopted for this session / pre-seq server.
  const lastAdoptedSeq = useRef<number | null>(null);
  // Race guard: clearCompleted() may run before session:result stamps the
  // boundary (batch-completed precedes result by ~20-50ms in prod; a fast 304
  // history refetch could land in between). Removing 0 blocks then would leave
  // the whole turn duplicated against persisted history — instead defer the
  // clear to the session:result handler.
  const pendingClearRef = useRef(false);
  // Ref mirrors so clearCompleted (a stable callback) can read current state
  // synchronously. useLayoutEffect (not useEffect): callers invoke clearCompleted
  // from their own useLayoutEffect, and this hook's effects flush first within
  // the same commit — useEffect would be one paint stale.
  const isStreamingRef = useRef(false);
  useLayoutEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  const blocksLenRef = useRef(0);
  useLayoutEffect(() => { blocksLenRef.current = blocks.length; }, [blocks]);
  // Full current blocks[] mirror — clearCompleted needs the array (not just the
  // length) to run evidence-based promotion synchronously and return the removed
  // count for anchor-shifting. Kept in sync in the same layout phase as the length.
  const blocksRef = useRef<StreamingBlock[]>(blocks);
  useLayoutEffect(() => { blocksRef.current = blocks; }, [blocks]);
  // Delta captured when a clearCompleted() was deferred (batch-completed raced
  // ahead of session:result). Replayed as evidence once the boundary is stamped.
  const pendingDeltaRef = useRef<SessionHistoryMessage[] | null>(null);

  // Apply a deferred turn-clear once the boundary lands (session:result/error/
  // status-backstop). EVIDENCE-BASED: promote against the stashed delta rather
  // than blind-wiping. `prev` is the current blocks[]; returns the kept array.
  // Assumes the boundary = prev.length (the whole present buffer is the finished
  // turn — deferral only happens when nothing newer had streamed yet).
  const applyDeferredClear = useCallback((prev: StreamingBlock[]): StreamingBlock[] => {
    pendingClearRef.current = false;
    const delta = pendingDeltaRef.current ?? [];
    pendingDeltaRef.current = null;
    const { kept, removed } = promoteCompletedBlocks(prev, delta, prev.length);
    log.info('stream', `deferred clear applied: blocks=${prev.length}→${kept.length} (removed ${removed}, evidence)`, { sessionId: activeSessionId.current });
    completedLen.current = kept.length; // whatever survived is still "completed" (unflushed), retried next delta
    blocksLenRef.current = kept.length;
    blocksRef.current = kept;
    if (kept.length === 0 && activeSessionId.current) clearStreamState(activeSessionId.current);
    return kept;
  }, []);

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
      completedLen.current = cached.completedLen ?? (cached.isStreaming ? 0 : cached.blocks.length);
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
    pendingClearRef.current = false;

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
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
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
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
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
        // the boundary here so the next clearCompleted() still drops this turn.
        setBlocks((prev) => {
          completedLen.current = Math.max(completedLen.current, prev.length);
          if (pendingClearRef.current) {
            // Deferred turn clear (batch-completed raced ahead) — apply with evidence.
            return applyDeferredClear(prev);
          }
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

      // Apply buffered text synchronously
      const accumulated = streamBuffer.current;
      const msgId = currentTextMsgId.current;
      if (accumulated) {
        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          // Merge only into a LIVE text block (past the completed-turn boundary)
          // of the SAME message; a completed turn's final text block must never
          // be overwritten by the next turn's deltas, and a different msgId
          // means a new message (new block).
          const sameMessage = last && last.type === 'text' && (!msgId || !last.msgId || last.msgId === msgId);
          if (sameMessage && prev.length > completedLen.current) {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated, ...(msgId ? { msgId } : {}) }];
          }
          return [...prev, { type: 'text', content: accumulated, ...(msgId ? { msgId } : {}) }];
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
    const { sessionId: sid, delta, msgId } = data as { sessionId: string; delta: string; taskId: string; msgId?: string };
    if (!sessionId || sid !== sessionId) return; // defensive client-side check

    setIsStreaming((prev) => {
      if (!prev) log.info('stream', 'text-delta → isStreaming false→true', { sessionId: sid });
      return true;
    });
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

        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          // Merge only into a LIVE text block of the SAME message — see flushPendingTextRaf.
          const sameMessage = last && last.type === 'text' && (!accMsgId || !last.msgId || last.msgId === accMsgId);
          if (sameMessage && prev.length > completedLen.current) {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated, ...(accMsgId ? { msgId: accMsgId } : {}) }];
          }
          return [...prev, { type: 'text', content: accumulated, ...(accMsgId ? { msgId: accMsgId } : {}) }];
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

    setBlocks((prev) => {
      // DUP-DEBUG: detect duplicate tool_use rendering at the closest layer
      // to the UI. If this WARN fires, the same toolUseId already exists in
      // local block state when a new event arrived — that's exactly what the
      // user sees as two identical Bash panels.
      const existing = prev.find((b) => b.type === 'tool_call' && b.toolUseId === toolUseId);
      if (existing) {
        log.warn('frontend', 'session:tool-use DUPLICATE — toolUseId already in blocks', {
          sessionId: sid, toolUseId, toolName,
          existingStatus: existing.type === 'tool_call' ? existing.status : undefined,
          totalBlocks: prev.length,
        });
      }
      return [
        ...prev,
        { type: 'tool_call', toolUseId, name: toolName, input, status: 'calling', ...(planContent ? { planContent } : {}), ...(parentToolUseId ? { parentToolUseId } : {}) },
      ];
    });
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
    const { sessionId: sid, delta, msgId } = data as { sessionId: string; delta: string; msgId?: string };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);
    if (msgId) currentThinkingMsgId.current = msgId;
    pendingThinking.current += delta;

    if (thinkingDeltaRaf.current === null) {
      thinkingDeltaRaf.current = requestAnimationFrame(() => {
        thinkingDeltaRaf.current = null;
        const incoming = pendingThinking.current;
        const accMsgId = currentThinkingMsgId.current;
        pendingThinking.current = '';
        if (!incoming) return;
        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          // Merge only into a LIVE thinking block of the SAME message —
          // a different msgId means a new message (new block).
          const sameMessage = last && last.type === 'thinking' && (!accMsgId || !last.msgId || last.msgId === accMsgId);
          if (sameMessage && prev.length > completedLen.current) {
            return [...prev.slice(0, -1), { type: 'thinking', content: last.content + incoming, ...(accMsgId ? { msgId: accMsgId } : {}) }];
          }
          return [...prev, { type: 'thinking', content: incoming, ...(accMsgId ? { msgId: accMsgId } : {}) }];
        });
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

    setBlocks((prev) => [
      ...prev,
      { type: 'system', variant: 'info', message: `Unknown Claude event: ${scope}:${eventType}`, detail: snippet },
    ]);
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

  // Handle session result (streaming done)
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
      // Turn boundary: everything present now belongs to the completed turn.
      // Deltas arriving after this point are the NEXT turn and must survive
      // the upcoming clearCompleted() from batch-completed/history-refresh.
      completedLen.current = prev.length;
      if (pendingClearRef.current) {
        // A clearCompleted() ran before this boundary was known — apply with evidence.
        return applyDeferredClear(prev);
      }
      log.info('stream', `session:result blocks=${prev.length} (kept, cleared by batch-completed)`, { sessionId: sid });
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
        const next = [...prev, { type: 'system', variant: 'error', message: 'Session error', detail } as StreamingSystemBlock];
        completedLen.current = next.length; // error ends the turn
        return next;
      });
    } else {
      setBlocks((prev) => {
        completedLen.current = prev.length;
        if (pendingClearRef.current) return applyDeferredClear(prev);
        return prev;
      });
    }
  });

  const clear = useCallback(() => {
    flushPendingTextRaf();
    setBlocks((prev) => {
      if (prev.length > 0) log.info('stream', `clear() blocks=${prev.length}→0`, { sessionId: activeSessionId.current });
      return [];
    });
    setIsStreaming((prev) => {
      if (prev) log.info('stream', `clear() isStreaming true→false`, { sessionId: activeSessionId.current });
      return false;
    });
    streamBuffer.current = '';
    completedLen.current = 0;
    pendingClearRef.current = false;
    seenPermissionIds.current.clear();
    // Sync-clear global cache so switching away and back doesn't restore stale blocks
    if (activeSessionId.current) clearStreamState(activeSessionId.current);
  }, [flushPendingTextRaf]);

  // Turn-aware clear (batch-completed / history-refresh path): EVIDENCE-BASED —
  // remove a completed-turn block ONLY if a twin is proven present in the
  // just-arrived persisted `delta`. A block without a twin is kept (worst case:
  // shown twice briefly; never vanishes). Blocks of a NEXT turn already streaming
  // are structurally excluded by completedLen. Fixes the "messages 1-4 vanish
  // while 5 is generating, then flash back" bug — the old full/position clear
  // deleted live/unflushed content on faith; now deletion needs proof.
  //
  // `delta` = the persisted messages that just arrived (the increment since the
  // last cursor). Returns the removed block count so callers shift position
  // anchors (blockIndexMap).
  const clearCompleted = useCallback((delta: SessionHistoryMessage[] = []): number => {
    flushPendingTextRaf();
    if (completedLen.current === 0 && isStreamingRef.current && blocksLenRef.current > 0) {
      // Boundary not stamped yet (batch-completed/refetch raced ahead of
      // session:result) — defer to the result handler, stashing the evidence.
      pendingClearRef.current = true;
      if (delta.length > 0) pendingDeltaRef.current = delta;
      return 0;
    }
    // Compute synchronously from the blocks mirror — the setState updater runs
    // later (at render), too late to produce this function's return value.
    const { kept, removed, unmatched } = promoteCompletedBlocks(
      blocksRef.current, delta, completedLen.current,
    );
    if (unmatched.length > 0) {
      // Content diverged / missing twin: we KEPT these (safe), but surface it —
      // a persistent occurrence means the archive & stream disagree (a real bug).
      log.warn('stream', `clearCompleted: ${unmatched.length} completed block(s) had no delta twin — kept, not deleted`, {
        sessionId: activeSessionId.current, unmatched: unmatched.slice(0, 5),
      });
    }
    if (removed > 0) {
      log.info('stream', `clearCompleted() blocks=${blocksRef.current.length}→${kept.length} (removed ${removed}, evidence)`, { sessionId: activeSessionId.current });
      setBlocks(kept);
      blocksLenRef.current = kept.length;
      blocksRef.current = kept;
      completedLen.current = Math.max(0, completedLen.current - removed);
    }
    // Nothing left and turn ended → full reset; clear permission dedup so a
    // re-emitted request next turn isn't swallowed.
    if (kept.length === 0 && !isStreamingRef.current) {
      seenPermissionIds.current.clear();
    }
    // Mirror into the global cache (same evidence) so switching away/back doesn't
    // restore the already-persisted turn.
    if (activeSessionId.current) clearCompletedTurn(activeSessionId.current, delta);
    return removed;
  }, [flushPendingTextRaf]);

  return { blocks, isStreaming, clear, clearCompleted };
}
