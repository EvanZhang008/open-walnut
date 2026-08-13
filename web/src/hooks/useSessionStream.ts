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
import { useSessionStatus } from './useSessionStatus';
import { seedSessionStatus } from '@/stores/session-status-store';

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

/** Streaming-text UI flush interval. Each flush re-renders the accumulated
 *  turn text through a full markdown parse, so per-frame (16ms) flushing was
 *  the app's dominant main-thread load during multi-column streaming. 150ms
 *  keeps prose visibly "live" while cutting that work ~10×. Semantic
 *  boundaries (tool-use, result, message switch) still flush synchronously. */
const TEXT_FLUSH_INTERVAL_MS = 150;

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
  const sessionStatus = useSessionStatus(sessionId);
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
      .then((data: {
        session?: unknown;
        pendingPermissions?: Array<{
          requestId: string;
          toolName?: string;
          input?: Record<string, unknown>;
          reason?: string;
          acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
        }>;
      } | null) => {
        if (activeSessionId.current !== sessionId) return;
        if (data?.session) seedSessionStatus(data.session, 'rest:session');
        const perms = data?.pendingPermissions ?? [];
        // Zombie sweep is only safe when NO turn is running: mid-turn, a fresh
        // permission may ride the WS ahead of this REST response and would be
        // wrongly retired. When the session is settled, permissions can't be
        // in flight — an unknown pending card is authoritatively dead (worker
        // died / auto-cancelled while we were away; its permission-resolved
        // event never reached us, so it would stay clickable forever and 404).
        const settled = (data?.session as { process_status?: string } | undefined)?.process_status !== 'running';
        setBlocks(prev => {
          const serverIds = new Set(perms.map(p => p.requestId));
          const existingIds = new Set(prev.filter(b => b.type === 'permission').map(b => (b as StreamingPermissionBlock).requestId));
          const isZombie = (b: typeof prev[number]): b is StreamingPermissionBlock =>
            b.type === 'permission' && (b.status === undefined || b.status === 'pending') && !serverIds.has(b.requestId);
          const hasZombie = settled && prev.some(isZombie);
          const next: typeof prev = hasZombie
            ? prev.map(b => (isZombie(b) ? { ...b, status: 'denied' as const } : b))
            : prev;
          const newBlocks = perms
            .filter(p => !existingIds.has(p.requestId))
            .map(p => ({ type: 'permission' as const, requestId: p.requestId, toolName: p.toolName ?? 'unknown', input: p.input, reason: p.reason, acpOptions: p.acpOptions }));
          if (newBlocks.length === 0) return hasZombie ? next : prev;
          for (const b of newBlocks) seenPermissionIds.current.add(b.requestId);
          return [...next, ...newBlocks];
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

  // Handle text deltas — coalesced on a timer (see TEXT_FLUSH_INTERVAL_MS below).
  // Historic name kept (textDeltaRaf) — it used to be a rAF handle; now a timeout id.
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
      clearTimeout(textDeltaRaf.current);
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

  // Status events are reduced before React listeners run. This effect consumes
  // the accepted store value, so stale REST and equal-revision conflicts cannot
  // stop a live stream.
  useEffect(() => {
    const processStatus = sessionStatus?.process_status;
    if (!sessionId || !processStatus) return;

    if (processStatus !== 'running') {
      flushPendingTextRaf();
      setIsStreaming((previous) => {
        if (previous) {
          log.info('stream', `status-store ps=${processStatus} → isStreaming true→false`, {
            sessionId,
            revision: sessionStatus.statusRevision,
          });
        }
        return false;
      });
      setBlocks((previous) => {
        completedLen.current = Math.max(completedLen.current, previous.length);
        return previous;
      });
      return;
    }

    doResubscribe(sessionId);
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      if (activeSessionId.current !== sessionId) return;
      setIsStreaming((current) => {
        if (!current) {
          resubscribePending.current = false;
          doResubscribe(sessionId);
        }
        return current;
      });
    }, 3000);
  }, [sessionId, sessionStatus?.process_status, doResubscribe, flushPendingTextRaf]);

  // Cancel pending flush on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => {
      if (textDeltaRaf.current !== null) {
        clearTimeout(textDeltaRaf.current);
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
      // Coalesce to ~6 updates/sec, not 60. Every flush re-parses the WHOLE
      // accumulated turn text as markdown (StreamingTextBlock), so at rAF rate
      // a long answer costs a full marked() parse of tens of KB per frame —
      // measured as the dominant main-thread load with 2-3 session columns
      // streaming (the 2026-08-03 "everything times out at exactly 15s" jam:
      // fetch callbacks starved behind render work). 150ms is imperceptible
      // for reading prose; flushPendingTextRaf still forces synchronous
      // catch-up at every semantic boundary (tool-use, result, msg switch).
      textDeltaRaf.current = window.setTimeout(() => {
        textDeltaRaf.current = null;
        const accumulated = streamBuffer.current;
        const accMsgId = currentTextMsgId.current;
        setBlocks((prev) => writeMainText(prev, accumulated, accMsgId, completedLen.current));
      }, TEXT_FLUSH_INTERVAL_MS);
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
    const { sessionId: sid, requestId, toolName, input, reason, acpOptions } = data as {
      sessionId: string; requestId: string; toolName: string;
      input?: Record<string, unknown>; reason?: string;
      acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
    };
    if (!sessionId || sid !== sessionId) return;
    if (seenPermissionIds.current.has(requestId)) return; // dedup
    seenPermissionIds.current.add(requestId);

    flushPendingTextRaf();
    streamBuffer.current = '';
    setBlocks(prev => [...prev, { type: 'permission', requestId, toolName, input, reason, acpOptions }]);
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
