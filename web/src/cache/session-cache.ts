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
import type {
  StreamingBlock,
  StreamingTextBlock,
  StreamingToolCallBlock,
  StreamingSystemBlock,
} from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';
import { fetchSessionHistory } from '@/api/sessions';
import { promoteCompletedBlocks } from './promote-blocks';
import { log } from '@/utils/log';

const MAX_CACHED = 20;

// ── History cache (LRU via Map insertion order) ──────────────────────────────

export interface CachedHistory {
  messages: SessionHistoryMessage[];
  forkBoundaryIndex?: number;
  msgCount: number;
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
  blocks: StreamingBlock[];
  textBuffer: string;
  isStreaming: boolean;
  /** blocks[0..completedLen) belong to turns that already ended (session:result/
   *  session:error). Blocks past this index are a live next turn and must survive
   *  the turn-boundary cleanup (batch-completed / history refresh). */
  completedLen: number;
  /** Race guard: batch-completed can arrive ~50ms BEFORE session:result (observed
   *  in prod logs). If the turn-boundary cleanup ran while completedLen was still 0,
   *  this flag defers the clear to the result handler (which knows the boundary). */
  pendingTurnClear?: boolean;
  /** Delta evidence captured when a clear was deferred (batch-completed raced ahead
   *  of session:result). The result handler replays it so the deferred clear stays
   *  evidence-based instead of degrading to a blind position clear. */
  pendingDelta?: SessionHistoryMessage[];
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
  // Reconstruct textBuffer from the last text block so future text-delta events
  // append correctly (textBuffer must equal lastTextBlock.content for continuity).
  const lastText = [...blocks]
    .reverse()
    .find((b): b is StreamingTextBlock => b.type === 'text');
  streamStates.set(sid, {
    blocks: blocks.map((b) => ({ ...b })),
    textBuffer: lastText ? lastText.content : '',
    isStreaming,
    // Prefer the server-authoritative boundary (snapshot.completedLen): a
    // snapshot taken between the next turn's markStreaming and its first delta
    // holds the PREVIOUS turn's blocks with isStreaming=true — deriving from
    // isStreaming would mislabel them "live". Legacy fallback keeps the old rule.
    completedLen: completedLen ?? (isStreaming ? 0 : blocks.length),
  });
}

/**
 * Turn-aware clear: drop the completed turn's blocks, keep any blocks streamed
 * after the last session:result (the next, live turn).
 *
 * Two modes, keyed strictly on whether `delta` was PROVIDED (not on its length):
 *  · `delta` provided (INCLUDING an empty array) → EVIDENCE-BASED: only remove a
 *    block if a twin exists in the just-arrived persisted messages. An empty
 *    delta proves nothing arrived yet (archive lagging / turn not flushed), so
 *    it removes NOTHING — every block is kept and re-attempted on the next
 *    delta. A block without a twin is always kept (worst case: shown twice
 *    briefly; never vanishes). This is the primary path.
 *  · `delta` omitted (`undefined`) → position fallback (bounded by completedLen),
 *    for callers with no delta at hand (e.g. WS reconnect refresh). Still never
 *    touches the live turn.
 *
 * CRITICAL: an empty array must NOT fall through to the position fallback — that
 * would blindly slice off completed blocks with zero proof, the exact "vanish"
 * bug this design eliminates.
 */
export function clearCompletedTurn(sid: string, delta?: SessionHistoryMessage[]): void {
  const state = streamStates.get(sid);
  if (!state) return;
  if (state.completedLen === 0 && state.isStreaming && state.blocks.length > 0) {
    // batch-completed raced ahead of session:result (observed ~50ms in prod):
    // the boundary isn't known yet. Defer — the result handler applies the
    // clear once it stamps completedLen. Wiping now would kill a live turn;
    // keeping forever would duplicate against history on the next cache hit.
    state.pendingTurnClear = true;
    if (delta !== undefined) state.pendingDelta = delta; // stash evidence (even empty) to replay when result lands
    return;
  }

  if (delta !== undefined) {
    // Evidence-based: prove each removed block against the delta. An empty delta
    // promotes nothing (removed=0, kept=all) — never a blind slice.
    const { kept, removed } = promoteCompletedBlocks(state.blocks, delta, state.completedLen);
    if (kept.length === 0 && !state.isStreaming) {
      streamStates.delete(sid);
      return;
    }
    state.blocks = kept;
    // Anything left in the completed window failed to match (kept without twin);
    // reset the boundary so the next delta re-attempts promotion from the front.
    state.completedLen = Math.max(0, state.completedLen - removed);
    // Only resolve the deferred-clear flag once we actually promoted something;
    // an empty/incomplete delta leaves the turn pending so a later non-empty
    // delta (next batch-completed) still fires the promotion.
    if (removed > 0) {
      state.pendingTurnClear = false;
      state.pendingDelta = undefined;
    }
    return;
  }

  // Position fallback (delta === undefined → no evidence available at all).
  const removed = Math.min(state.completedLen, state.blocks.length);
  if (state.blocks.length - removed <= 0 && !state.isStreaming) {
    streamStates.delete(sid);
    return;
  }
  state.blocks = state.blocks.slice(removed);
  state.completedLen = 0;
  state.pendingTurnClear = false;
  state.pendingDelta = undefined;
}

// ── Global WS listeners (registered once at module load) ─────────────────────

/** Flush accumulated text into the last LIVE text block (or create one).
 *  Never merges into a block at/before the completed-turn boundary.
 *  Preserves the block's msgId (the buffer only ever accumulates a single
 *  message's text — the delta handler starts a new block on msgId change). */
function flushText(state: StreamState): void {
  if (!state.textBuffer) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.type === 'text' && state.blocks.length > state.completedLen) {
    state.blocks[state.blocks.length - 1] = {
      type: 'text',
      content: state.textBuffer,
      ...(last.msgId ? { msgId: last.msgId } : {}),
    };
  } else {
    state.blocks.push({ type: 'text', content: state.textBuffer });
  }
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
  // ── text-delta ──
  wsClient.onEvent('session:text-delta', (data: unknown) => {
    const { sessionId: sid, delta, msgId } = data as {
      sessionId: string;
      delta: string;
      msgId?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    // Note: This intentionally duplicates flushText's logic. flushText is for
    // "flush-before-context-switch" (tool-use, result, etc.) where textBuffer is
    // reset afterward. Here we append delta first, then write the accumulated
    // buffer — calling flushText would lose the newly appended delta.
    // Update the last text block in-place (or push a new one). Merge only into a
    // LIVE block (past the completed-turn boundary) of the SAME message — a
    // finished turn's final text must not be overwritten by the next turn's
    // deltas, and a msgId change means a new message (new block).
    const last = state.blocks[state.blocks.length - 1];
    const sameMessage = last && last.type === 'text' && (!msgId || !last.msgId || last.msgId === msgId);
    if (sameMessage && state.blocks.length > state.completedLen) {
      state.textBuffer += delta;
      state.blocks[state.blocks.length - 1] = {
        type: 'text',
        content: state.textBuffer,
        ...(msgId ? { msgId } : {}),
      };
    } else {
      state.textBuffer = delta;
      state.blocks.push({ type: 'text', content: delta, ...(msgId ? { msgId } : {}) });
    }
  });

  // ── tool-use ──
  wsClient.onEvent('session:tool-use', (data: unknown) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId } =
      data as {
        sessionId: string;
        toolName: string;
        toolUseId: string;
        input?: Record<string, unknown>;
        planContent?: string;
        parentToolUseId?: string;
      };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    flushText(state);
    state.textBuffer = '';
    state.blocks.push({
      type: 'tool_call',
      toolUseId,
      name: toolName,
      input,
      status: 'calling',
      ...(planContent ? { planContent } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    } as StreamingToolCallBlock);
  });

  // ── tool-result ──
  wsClient.onEvent('session:tool-result', (data: unknown) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string;
      toolUseId: string;
      result: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (
        b.type === 'tool_call' &&
        b.toolUseId === toolUseId &&
        b.status === 'calling'
      ) {
        state.blocks[i] = {
          ...b,
          status: isToolResultError(result) ? 'error' : 'done',
          result,
        };
        break;
      }
    }
  });

  // ── system-event ──
  wsClient.onEvent('session:system-event', (data: unknown) => {
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
    state.blocks.push({
      type: 'system',
      variant,
      message,
      detail,
    } as StreamingSystemBlock);
  });

  // ── thinking-delta ──
  wsClient.onEvent('session:thinking-delta', (data: unknown) => {
    const { sessionId: sid, delta, msgId } = data as { sessionId: string; delta: string; msgId?: string };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    const last = state.blocks[state.blocks.length - 1];
    // Same ACP message-boundary rule as text-delta above.
    const sameMessage = last && last.type === 'thinking' && (!msgId || !last.msgId || last.msgId === msgId);
    if (sameMessage && state.blocks.length > state.completedLen) {
      state.blocks[state.blocks.length - 1] = {
        type: 'thinking',
        content: last.content + delta,
        ...(msgId ? { msgId } : {}),
      };
    } else {
      state.blocks.push({ type: 'thinking', content: delta, ...(msgId ? { msgId } : {}) });
    }
  });

  // ── unknown-event (surface as info system block so no event is silently lost) ──
  wsClient.onEvent('session:unknown-event', (data: unknown) => {
    const { sessionId: sid, scope, eventType, snippet } = data as {
      sessionId: string; scope: string; eventType: string; snippet: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.blocks.push({
      type: 'system',
      variant: 'info',
      message: `Unknown Claude event: ${scope}:${eventType}`,
      detail: snippet,
    } as StreamingSystemBlock);
  });

  // ── result (streaming done, turn finished successfully) ──
  wsClient.onEvent('session:result', (data: unknown) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    // Mark streaming done but preserve blocks — they stay visible until
    // batch-completed fires (turn written to JSONL) and history replaces them.
    state.isStreaming = false;
    state.textBuffer = '';
    // Turn boundary: everything present now belongs to the completed turn.
    state.completedLen = state.blocks.length;
    // batch-completed raced ahead of us — apply the deferred turn clear now.
    if (state.pendingTurnClear) {
      const replay = state.pendingDelta;
      state.pendingDelta = undefined;
      clearCompletedTurn(sid, replay);
    }
  });

  // ── error (streaming done with error) ──
  wsClient.onEvent('session:error', (data: unknown) => {
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
      state.blocks.push({
        type: 'system',
        variant: 'error',
        message: 'Session error',
        detail,
      } as StreamingSystemBlock);
    }
    state.completedLen = state.blocks.length; // error ends the turn
    if (state.pendingTurnClear) {
      const replay = state.pendingDelta;
      state.pendingDelta = undefined;
      clearCompletedTurn(sid, replay);
    }
  });

  // ── batch-completed (turn wrote to JSONL, streaming blocks are now history) ──
  wsClient.onEvent('session:batch-completed', (data: unknown) => {
    const sid = (data as { sessionId?: string })?.sessionId;
    if (!sid || !trackedSessions.has(sid)) return;

    // Delta fetch: ask only for messages after what we've cached. The response is
    // the promotion evidence — a few KB, not the full 6.4MB payload. If the archive
    // hasn't flushed yet the delta is empty and clearCompletedTurn is a safe no-op
    // (blocks stay, retried on the next batch-completed / when the column opens).
    if (inflightBgFetches.has(sid)) return;
    inflightBgFetches.add(sid);
    const cached = historyCache.get(sid);
    const since = cached?.msgCount ?? 0;
    fetchSessionHistory(sid, { since })
      .then((r) => {
        // Evidence-based turn clear: remove only streaming blocks proven present
        // in this delta (keeps a next turn already streaming; keeps anything the
        // archive hasn't caught up on). Replaces the old blind full-delete.
        clearCompletedTurn(sid, r.messages);

        if (r.delta && cached) {
          // Append the increment to the cached history.
          const merged = [...cached.messages, ...r.messages];
          // Consistency guard (same as useSessionHistory): a correct delta append yields
          // exactly `cursor` messages. A mismatch means the cached prefix diverged from the
          // server's current parse (e.g. compaction rewrote history), so appending would
          // DUPLICATE the overlap. Rebuild the cache from a full fetch instead of appending.
          const expected = r.cursor ?? merged.length;
          if (r.cursor != null && merged.length !== expected) {
            log.warn('session-cache', `bg delta length mismatch for ${sid.substring(0, 8)} — rebuilding (had=${cached.messages.length} +${r.messages.length} → ${merged.length}, cursor=${expected})`);
            fetchSessionHistory(sid)
              .then((full) => historyCacheSet(sid, {
                messages: full.messages,
                forkBoundaryIndex: full.forkBoundaryIndex,
                msgCount: full.cursor ?? full.messages.length,
              }))
              .catch(() => { /* keep current cache; next turn retries */ });
          } else {
            historyCacheSet(sid, {
              messages: merged,
              forkBoundaryIndex: r.forkBoundaryIndex ?? cached.forkBoundaryIndex,
              msgCount: r.cursor ?? merged.length,
            });
            log.info('session-cache', `bg delta for ${sid.substring(0, 8)}: +${r.messages.length} → ${merged.length}`);
          }
        } else {
          // Full payload (no cache yet, or since out of range → rebuild).
          historyCacheSet(sid, {
            messages: r.messages,
            forkBoundaryIndex: r.forkBoundaryIndex,
            msgCount: r.cursor ?? r.messages.length,
          });
          log.info('session-cache', `bg-updated history for ${sid.substring(0, 8)}`, { msgCount: r.messages.length });
        }
      })
      .catch((err) => log.warn('session-cache', 'bg history fetch failed', { sid, error: String(err) }))
      .finally(() => inflightBgFetches.delete(sid));
  });

  // ── WS reconnect — refresh all tracked sessions ──
  wsClient.onEvent('_ws:reconnected', () => {
    log.info(
      'session-cache',
      `ws reconnected, refreshing ${trackedSessions.size} sessions`,
    );
    for (const sid of trackedSessions) {
      // Re-subscribe to get server snapshot for streaming sessions
      wsClient
        .sendRpc('session:stream-subscribe', { sessionId: sid })
        .then((snapshot: unknown) => {
          const snap = snapshot as {
            blocks: StreamingBlock[];
            isStreaming: boolean;
            completedLen?: number;
          } | null;
          if (snap) initStreamState(sid, snap.blocks, snap.isStreaming, snap.completedLen);
        })
        .catch(() => {});

      // Refresh history (may have missed batch-completed during disconnect)
      if (!inflightBgFetches.has(sid)) {
        inflightBgFetches.add(sid);
        fetchSessionHistory(sid)
          .then((r) =>
            historyCacheSet(sid, {
              messages: r.messages,
              forkBoundaryIndex: r.forkBoundaryIndex,
              msgCount: r.messages.length,
            }),
          )
          .catch((err) => log.warn('session-cache', 'bg history fetch failed', { sid, error: String(err) }))
          .finally(() => inflightBgFetches.delete(sid));
      }
    }
  });
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
