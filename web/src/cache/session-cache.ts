/**
 * Session cache — module-level singleton that tracks history + streaming state
 * for all visited sessions. Global WS listeners accumulate events for tracked
 * sessions in the background so switching back is instant (0ms from cache).
 *
 * Import this module to auto-register the listeners (runs once at import time).
 */

// WHY global listeners? React hooks unmount when user navigates away from a session.
// Without a global accumulator, WS events for background sessions are lost.
// The server already broadcasts ALL session events to all clients — we just
// stop discarding events for non-current sessions and accumulate them here.

import { wsClient } from '@/api/ws';
import { isToolResultError } from '@/api/chat';
import {
  applyMainTextDelta,
  appendMainThinking,
  appendLaneText,
  appendLaneThinking,
  appendToolCall,
  backfillToolResult,
  appendSystemBlock,
  appendPermissionBlock,
  resolvePermissionBlock,
  flushMainTextBuffer,
  lastMainLaneText,
  lastMainLaneIndex,
  type StreamingBlock,
} from '@/stream/stream-reducer';
import type { SessionHistoryMessage } from '@/types/session';
import { fetchSessionHistory, HISTORY_TAIL_LIMIT } from '@/api/sessions';
import { promoteCompletedBlocks, buildIdOnlyEvidence, type DeltaEvidence } from './promote-blocks';
import { getFinishedAgentIds } from './finished-agents-store';
import { computeHistoryAnchor, collectUnsettledIds } from '@/hooks/history-anchor';
import { planDeltaMerge } from '@/hooks/history-merge';
import { recordFlight, trimStreamEvent } from '@/stream/flight-recorder';
import { tracePhase } from '@/utils/main-thread-tracer';
import { runWhenVisible } from '@/utils/page-visibility';
import { log } from '@/utils/log';

const MAX_CACHED = 20;

// ── History cache (LRU via Map insertion order) ──────────────────────────────

export interface CachedHistory {
  messages: SessionHistoryMessage[];
  forkBoundaryIndex?: number;
  msgCount: number;
  /** Messages hidden BEFORE messages[0] (lazy tail load — msgCount counts them).
   *  Undefined/0 = full history. Must ride every cache write or the delta
   *  length-guard sees a mismatched count space and rebuilds forever. */
  baseOffset?: number;
  /** The session's TRUE first user message (server-computed from the full
   *  parse). messages[0] here may be mid-conversation (tail slice) — the pinned
   *  "Initial Prompt" bubble must come from this field, never from the head. */
  initialUserText?: string;
}

const historyCache = new Map<string, CachedHistory>();

function historyCacheSet(sid: string, data: CachedHistory): void {
  // Delete first so re-insert moves it to the end (most-recently-used)
  historyCache.delete(sid);
  historyCache.set(sid, data);
  if (historyCache.size > MAX_CACHED) {
    const oldest = historyCache.keys().next().value;
    if (oldest) historyCache.delete(oldest);
  }
}

export function getHistoryCache(sid: string): CachedHistory | undefined {
  return historyCache.get(sid);
}

export function setHistoryCache(sid: string, data: CachedHistory): void {
  historyCacheSet(sid, data);
}

// ── Streaming state cache ────────────────────────────────────────────────────

export interface StreamState {
  /** APPEND-ONLY — reconciliation never deletes blocks; the render filter
   *  (stream/render-filter.ts) hides absorbed ones at render time. Physical
   *  removal is clearStreamState (all-or-nothing), so indices stay stable. */
  blocks: StreamingBlock[];
  textBuffer: string;
  isStreaming: boolean;
  /** MERGE boundary (not a deletion cursor): blocks[0..completedLen) belong to
   *  finished turns — the next turn's deltas must open new blocks, never
   *  rewrite these (stream-reducer liveness rule). */
  completedLen: number;
}

/** Server snapshot returned by the `session:stream-subscribe` RPC — the single
 *  declaration (useSessionStream imports it; keep in sync with the server's
 *  SessionStreamBuffer.snapshot()). */
export interface StreamSnapshot {
  blocks: StreamingBlock[];
  isStreaming: boolean;
  /** Server-authoritative count of leading blocks that belong to finished turns.
   *  MUST be preferred over deriving from isStreaming: a snapshot taken between
   *  the next turn's markStreaming and its first delta carries the PREVIOUS
   *  turn's blocks with isStreaming=true — deriving mislabels them "live". */
  completedLen?: number;
  /** Monotonic server-side mutation counter for this session's buffer
   *  (0 = no buffer). Seq-based adoption compares this against the
   *  last-applied seq instead of guessing freshness from block lengths. */
  seq?: number;
}

const streamStates = new Map<string, StreamState>();
const trackedSessions = new Set<string>();

/** Start tracking a session — global WS listeners will accumulate its events. */
export function trackSession(sid: string): void {
  trackedSessions.add(sid);
  // LRU eviction: if over limit, drop the oldest tracked session
  if (trackedSessions.size > MAX_CACHED) {
    const oldest = trackedSessions.values().next().value;
    if (oldest) {
      trackedSessions.delete(oldest);
      streamStates.delete(oldest);
      historyCache.delete(oldest);
    }
  }
}

export function getStreamState(sid: string): StreamState | undefined {
  return streamStates.get(sid);
}

export function clearStreamState(sid: string): void {
  streamStates.delete(sid);
}

/** Seed the streaming cache from a server snapshot (stream-subscribe RPC). */
export function initStreamState(
  sid: string,
  blocks: StreamingBlock[],
  isStreaming: boolean,
  completedLen?: number,
): void {
  // Reconstruct textBuffer from the last MAIN-lane text block so future
  // text-delta events append correctly (textBuffer must equal that block's
  // content for continuity). Subagent-lane blocks (parentToolUseId set) never
  // participate in the main accumulator.
  // Live-turn blocks only: a finished turn's final text must never seed the
  // accumulator, or the next turn's first delta appends to the OLD answer
  // (inc-1786678797966 — one block rendering "<previous answer><new answer>").
  const boundary = completedLen ?? (isStreaming ? 0 : blocks.length);
  const lastText = lastMainLaneText(blocks, boundary);
  streamStates.set(sid, {
    blocks: blocks.map((b) => ({ ...b })),
    textBuffer: lastText ? lastText.content : '',
    isStreaming,
    // Prefer the server-authoritative boundary (snapshot.completedLen): a
    // snapshot taken between the next turn's markStreaming and its first delta
    // holds the PREVIOUS turn's blocks with isStreaming=true — deriving from
    // isStreaming would mislabel them "live". Legacy fallback keeps the old rule.
    completedLen: boundary,
  });
}

/**
 * GC absorbed blocks (single-timeline model): the cache is a background
 * accumulator — nothing renders from here directly, so it can safely drop
 * blocks PROVEN absorbed by persisted history (same evidence rules as the
 * render filter; kept blocks re-attempt on the next delta). This bounds memory
 * for background sessions and keeps cache hits small; correctness never
 * depends on it. An empty delta with no fullEvidence proves nothing → no-op.
 */
function gcAbsorbedBlocks(sid: string, delta: SessionHistoryMessage[], fullEvidence?: DeltaEvidence): void {
  const state = streamStates.get(sid);
  if (!state || state.blocks.length === 0) return;
  // Live-tail guard (mirrors render-filter): while streaming, the last
  // main-lane block is still accumulating — a partial-content/known-msgId
  // match against history must not GC it mid-accumulation.
  const liveTail = state.isStreaming ? lastMainLaneIndex(state.blocks) : -1;
  const boundary = liveTail >= 0 ? liveTail : state.blocks.length;
  // Orphan finished-agent ids (nested agents with no history row) — same
  // evidence the render filter uses; fetchSessionHistory already unioned this
  // session's server-reported ids into the store before we got here.
  const { kept, removed } = promoteCompletedBlocks(state.blocks, delta, boundary, fullEvidence, getFinishedAgentIds(sid));
  if (removed === 0) return;
  if (kept.length === 0 && !state.isStreaming) {
    streamStates.delete(sid);
    return;
  }
  state.blocks = kept;
  // Shift the merge boundary down by the removal count. This assumes every
  // GC'd block sat BEFORE completedLen — id evidence can in principle absorb a
  // block past it (full-history msgId hit on a still-live turn's finished
  // message), which would drag the boundary below genuinely finished blocks
  // and re-open them to merging (the TURN LIVENESS hazard). The live-tail
  // guard above keeps the accumulating block itself safe, and a next
  // result/snapshot re-stamps completedLen authoritatively, so the window is
  // narrow — but don't "simplify" this to ignore ordering.
  state.completedLen = Math.max(0, state.completedLen - removed);
}

// ── Global WS listeners (registered once at module load) ─────────────────────

/** Flush accumulated text into the last LIVE main-lane text block (or create
 *  one) — reducer semantics (single copy in stream-reducer.ts). */
function flushText(state: StreamState): void {
  state.blocks = flushMainTextBuffer(state.blocks, state.textBuffer, state.completedLen);
}

function ensureState(sid: string): StreamState {
  let s = streamStates.get(sid);
  if (!s) {
    s = { blocks: [], textBuffer: '', isStreaming: false, completedLen: 0 };
    streamStates.set(sid, s);
  }
  return s;
}

/** Tracks in-flight background fetches to avoid duplicate HTTP requests. */
const inflightBgFetches = new Set<string>();

function registerGlobalListeners(): void {
  // Every session event is flight-recorded BEFORE its handler runs — the ring
  // buffer is the replay input for tests/web/chat-lab/ when the render-filter
  // tripwire fires (see flight-recorder.ts).
  function onSessionEvent(name: string, cb: (data: unknown) => void): void {
    wsClient.onEvent(name, (data: unknown) => {
      const sid = (data as { sessionId?: string })?.sessionId;
      if (sid && trackedSessions.has(sid)) recordFlight(sid, name, trimStreamEvent(data));
      cb(data);
    });
  }

  // ── text-delta ──
  onSessionEvent('session:text-delta', (data: unknown) => {
    const { sessionId: sid, delta, msgId, parentToolUseId, subagentType, taskDescription } = data as {
      sessionId: string;
      delta: string;
      msgId?: string;
      parentToolUseId?: string;
      subagentType?: string;
      taskDescription?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;

    // Subagent lane: merge into this lane's own block; never touches the main
    // textBuffer (interleaved subagent lines must not split main text).
    if (parentToolUseId) {
      state.blocks = appendLaneText(state.blocks, { delta, msgId, parentToolUseId, subagentType, taskDescription });
      return;
    }

    // Main lane: blocks + textBuffer advance in lockstep (reducer semantics —
    // merge grows the buffer, a new block restarts it at this delta).
    const next = applyMainTextDelta(state.blocks, state.textBuffer, delta, msgId, state.completedLen);
    state.blocks = next.blocks;
    state.textBuffer = next.textBuffer;
  });

  // ── tool-use ──
  onSessionEvent('session:tool-use', (data: unknown) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId, subagentType, taskDescription } =
      data as {
        sessionId: string;
        toolName: string;
        toolUseId: string;
        input?: Record<string, unknown>;
        planContent?: string;
        parentToolUseId?: string;
        subagentType?: string;
        taskDescription?: string;
      };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    // Main-lane tool call interrupts main text flow; a subagent tool call
    // (parentToolUseId set) lives in its own lane and must not cut main text.
    if (!parentToolUseId) {
      flushText(state);
      state.textBuffer = '';
    }
    state.blocks = appendToolCall(state.blocks, {
      toolUseId, toolName, input, planContent, parentToolUseId, subagentType, taskDescription,
    });
  });

  // ── tool-result ──
  onSessionEvent('session:tool-result', (data: unknown) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string;
      toolUseId: string;
      result: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.blocks = backfillToolResult(state.blocks, toolUseId, result, isToolResultError(result));
  });

  // ── system-event ──
  onSessionEvent('session:system-event', (data: unknown) => {
    const { sessionId: sid, variant, message, detail } = data as {
      sessionId: string;
      variant: 'compact' | 'error' | 'info';
      message: string;
      detail?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    state.textBuffer = '';
    state.blocks = appendSystemBlock(state.blocks, { variant, message, detail });
  });

  // ── permission request/resolved ──
  onSessionEvent('session:permission-request', (data: unknown) => {
    const { sessionId: sid, requestId, toolName, input, reason, acpOptions } = data as {
      sessionId: string;
      requestId: string;
      toolName: string;
      input?: Record<string, unknown>;
      reason?: string;
      acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
    };
    if (!sid || !requestId || !toolName || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    state.textBuffer = '';
    state.blocks = appendPermissionBlock(state.blocks, {
      requestId, toolName, input, reason, acpOptions,
    });
  });

  onSessionEvent('session:permission-resolved', (data: unknown) => {
    const { sessionId: sid, requestId, allowed } = data as {
      sessionId: string;
      requestId: string;
      allowed: boolean;
    };
    if (!sid || !requestId || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.blocks = resolvePermissionBlock(state.blocks, requestId, allowed);
  });

  // ── thinking-delta ──
  onSessionEvent('session:thinking-delta', (data: unknown) => {
    const { sessionId: sid, delta, msgId, parentToolUseId } = data as {
      sessionId: string; delta: string; msgId?: string; parentToolUseId?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;

    // Subagent lane — same isolation rule as text-delta above.
    if (parentToolUseId) {
      state.blocks = appendLaneThinking(state.blocks, { delta, msgId, parentToolUseId });
      return;
    }

    state.blocks = appendMainThinking(state.blocks, delta, msgId, state.completedLen);
  });

  // ── unknown-event (surface as info system block so no event is silently lost) ──
  onSessionEvent('session:unknown-event', (data: unknown) => {
    const { sessionId: sid, scope, eventType, snippet } = data as {
      sessionId: string; scope: string; eventType: string; snippet: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.blocks = appendSystemBlock(state.blocks, {
      variant: 'info', message: `Unknown Claude event: ${scope}:${eventType}`, detail: snippet,
    });
  });

  // ── result (streaming done, turn finished successfully) ──
  onSessionEvent('session:result', (data: unknown) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    // Mark streaming done but preserve blocks — hidden/GC'd only once history
    // absorbs them (non-destructive single-timeline model).
    state.isStreaming = false;
    state.textBuffer = '';
    // Merge boundary: everything present now belongs to the completed turn.
    state.completedLen = state.blocks.length;
  });

  // ── error (streaming done with error) ──
  onSessionEvent('session:error', (data: unknown) => {
    const { sessionId: sid, error } = data as {
      sessionId: string;
      error?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    state.isStreaming = false;
    state.textBuffer = '';
    if (error) {
      const detail =
        error.length > 500 ? error.slice(0, 500) + '\u2026' : error;
      state.blocks = appendSystemBlock(state.blocks, { variant: 'error', message: 'Session error', detail });
    }
    state.completedLen = state.blocks.length; // error ends the turn
  });

  // Shared delta refresh — used by batch-completed AND the reconnect sweep.
  // Delta fetch: ask only for messages after what we've cached. The response is
  // the absorption evidence — a few KB, not the full 6.4MB payload. If the archive
  // hasn't flushed yet the delta is empty and gcAbsorbedBlocks is a safe no-op
  // (blocks stay, retried on the next batch-completed / when the column opens).
  function deltaRefreshHistory(sid: string): Promise<void> {
    if (inflightBgFetches.has(sid)) return Promise.resolve();
    inflightBgFetches.add(sid);
    const cached = historyCache.get(sid);
    const since = cached?.msgCount ?? 0;
    // Identity anchor + unsettled re-ask — the SAME request shape as
    // useSessionHistory. This path used to send a bare count, which is exactly
    // the lossy contract that dropped the newest messages on whale sessions
    // (inc-1785993576822) and froze mid-flight Agent rows (inc-1785965937858).
    const anchor = computeHistoryAnchor(cached?.messages ?? []);
    const reviseIds = collectUnsettledIds(cached?.messages ?? []);
    return fetchSessionHistory(sid, {
      since,
      anchorMsgId: anchor.anchorMsgId,
      anchorTail: anchor.anchorTail,
      reviseIds,
      // Bounds the declined-delta fall-through (full payload) — see useSessionHistory.
      tail: HISTORY_TAIL_LIMIT,
    })
      .then((r) => tracePhase(`bg-delta-merge:${sid.substring(0, 8)}(+${r.messages.length})`, () => {
        // Fold via the SHARED merge planner (history-merge.ts) — same function
        // as useSessionHistory, so the two mirrors can't drift apart again.
        const plan = r.delta && cached
          ? planDeltaMerge(cached.messages, r, cached.msgCount, { baseOffset: cached.baseOffset ?? 0 })
          : undefined;

        // GC streaming blocks proven present in history (memory bound for
        // background sessions — correctness lives in the render filter).
        // Evidence prefers the MERGED array (revisions folded in) — a late
        // bgTaskFinished revision must free its lane blocks THIS round, not the
        // next. Fallback: cached prefix + delta (rebuild pending / no cache).
        const evBase = plan?.kind === 'merged'
          ? plan.messages
          : [...(cached?.messages ?? []), ...r.messages];
        gcAbsorbedBlocks(sid, r.messages, buildIdOnlyEvidence(evBase));

        if (plan && cached) {
          if (plan.kind === 'rebuild') {
            log.warn('session-cache', `bg delta inconsistent for ${sid.substring(0, 8)} — rebuilding (${plan.reason})`);
            fetchSessionHistory(sid, { tail: HISTORY_TAIL_LIMIT })
              .then((full) => {
                const fullCursor = full.cursor ?? full.messages.length;
                historyCacheSet(sid, {
                  messages: full.messages,
                  forkBoundaryIndex: full.forkBoundaryIndex,
                  msgCount: fullCursor,
                  baseOffset: Math.max(0, fullCursor - full.messages.length),
                  initialUserText: full.initialUserText ?? cached?.initialUserText,
                });
              })
              .catch(() => { /* keep current cache; next turn retries */ });
          } else if (plan.kind === 'merged') {
            historyCacheSet(sid, {
              messages: plan.messages,
              forkBoundaryIndex: r.forkBoundaryIndex ?? cached.forkBoundaryIndex,
              msgCount: plan.cursor,
              baseOffset: cached.baseOffset ?? 0,
              initialUserText: cached.initialUserText,
            });
            log.info('session-cache', `bg delta for ${sid.substring(0, 8)}: +${r.messages.length} → ${plan.messages.length}`);
          } else {
            // unchanged — still record the advanced cursor (empty delta).
            historyCacheSet(sid, { ...cached, msgCount: plan.cursor });
          }
        } else {
          // Full payload (no cache yet, or since out of range → rebuild).
          // May be tail-sliced: cursor counts the messages we did NOT receive.
          const fullCursor = r.cursor ?? r.messages.length;
          historyCacheSet(sid, {
            messages: r.messages,
            forkBoundaryIndex: r.forkBoundaryIndex,
            msgCount: fullCursor,
            baseOffset: Math.max(0, fullCursor - r.messages.length),
            initialUserText: r.initialUserText ?? cached?.initialUserText,
          });
          log.info('session-cache', `bg-updated history for ${sid.substring(0, 8)}`, { msgCount: r.messages.length });
        }
      }))
      .catch((err) => log.warn('session-cache', 'bg history fetch failed', { sid, error: String(err) }))
      .finally(() => inflightBgFetches.delete(sid));
  }

  // ── batch-completed (turn wrote to JSONL, streaming blocks are now history) ──
  // Hidden tabs defer the delta fetch until shown (one catch-up per session):
  // every open tab receives every turn's batch-completed, so N background tabs
  // used to multiply each turn into N delta fetches against the shared
  // 6-connections-per-origin pool.
  onSessionEvent('session:batch-completed', (data: unknown) => {
    const sid = (data as { sessionId?: string })?.sessionId;
    if (!sid || !trackedSessions.has(sid)) return;
    runWhenVisible(`session-cache:delta:${sid}`, () => { void deltaRefreshHistory(sid); });
  });

  // ── WS reconnect — refresh all tracked sessions ──
  // Debounced: WS can flap (disconnect→connect within seconds); refreshing up to
  // 20 sessions per flap starves the main thread. Coalesce rapid reconnects.
  // Hidden tabs defer the whole sweep until shown — a server restart reconnects
  // EVERY tab at once; only the visible one should refresh immediately.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  wsClient.onEvent('_ws:reconnected', () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      runWhenVisible('session-cache:reconnect-sweep', () => { void refreshAllOnReconnect(); });
    }, 1_000);
  });

  async function refreshAllOnReconnect(): Promise<void> {
    log.info(
      'session-cache',
      `ws reconnected, refreshing ${trackedSessions.size} sessions`,
    );
    for (const sid of trackedSessions) {
      // Re-subscribe to get server snapshot for streaming sessions
      wsClient
        .sendRpc('session:stream-subscribe', { sessionId: sid })
        .then((snapshot: unknown) => {
          const snap = snapshot as StreamSnapshot | null;
          if (snap) initStreamState(sid, snap.blocks, snap.isStreaming, snap.completedLen);
        })
        .catch(() => {});
    }
    // History refresh: SEQUENTIAL delta fetches, not a parallel full-fetch burst.
    // The old code fired N full (multi-MB) fetches at once — decoding them
    // back-to-back was a measured 40-60s main-thread freeze (Window A,
    // starvation report 2026-07-15). Delta + one-at-a-time keeps each turn small;
    // the length-mismatch guard inside deltaRefreshHistory still rebuilds any
    // session whose cached prefix diverged during the disconnect.
    for (const sid of trackedSessions) {
      await deltaRefreshHistory(sid).catch(() => {});
    }
  }
}

// Auto-register on import
registerGlobalListeners();

// ── Subagent content cache (lazy-loaded on TaskGroup expand) ───────────────
// No invalidation on batch-completed: subagent content is expected to be complete
// by the time users expand a TaskGroup (active subagents render via StreamingTaskGroup).
// A page reload clears the cache if fresher data is needed.

const MAX_SUBAGENT_CACHED = 50;
const subagentCache = new Map<string, SessionHistoryMessage[]>();

function subagentKey(sid: string, agentId: string): string {
  return `${sid}:${agentId}`;
}

export function getSubagentCache(sid: string, agentId: string): SessionHistoryMessage[] | undefined {
  return subagentCache.get(subagentKey(sid, agentId));
}

export function setSubagentCache(sid: string, agentId: string, msgs: SessionHistoryMessage[]): void {
  const key = subagentKey(sid, agentId);
  subagentCache.delete(key); // re-insert for LRU ordering
  subagentCache.set(key, msgs);
  if (subagentCache.size > MAX_SUBAGENT_CACHED) {
    const oldest = subagentCache.keys().next().value;
    if (oldest) subagentCache.delete(oldest);
  }
}

/** Reset all internal state — for tests only. */
export function __resetForTesting(): void {
  historyCache.clear();
  streamStates.clear();
  trackedSessions.clear();
  inflightBgFetches.clear();
  subagentCache.clear();
}
