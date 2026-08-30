/**
 * useLaneSession — resolve the coding-agent session backing a main-AI
 * conversation (the "lane"), for the thin-layer chat surface. Any registered
 * engine can back a lane; the server reports which one on every resolve.
 *
 * When `config.agent.provider === 'claude-code'` the chat panel doesn't run the
 * in-process loop at all: it mounts the SAME session timeline every coding
 * session uses (SessionChatHistory) directly on the conversation's lane session,
 * and sends ride the ordinary session queue. This hook owns the id resolution:
 * POST /api/agents/:agentId/conversations/:cid/lane-session returns (or mints)
 * the lane session. Resolution is eager — the CLI takes seconds to spawn, so
 * resolving on mount means it is warm by the time the user's first message
 * lands (the same perceived-instant-start reasoning as the notes chat shell).
 *
 * `ensure()` returns the resolved id (or the in-flight resolve) so a send fired
 * before the eager resolve lands still reaches the right session instead of
 * being dropped. `resetNonce` forces a re-resolve after "clear conversation"
 * (the clear archives the lane, so the next resolve mints a fresh session).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { SESSION_ENGINE_IDS } from '@open-walnut/core';
import type { SessionEngine } from '@/types/session';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';

export interface UseLaneSessionReturn {
  sessionId: string | null;
  cwd?: string;
  /** Coding-agent engine backing the lane ('claude' until resolved). */
  engine: SessionEngine;
  error: string | null;
  ensure: () => Promise<string>;
  /**
   * Switch the provider backing this conversation. Only legal while the
   * conversation is EMPTY — the server archives the lane session and mints a
   * fresh one on the requested engine (409 once messages exist).
   * Resolves to the new sessionId; rejects with the server's reason otherwise.
   */
  swapEngine: (engine: SessionEngine) => Promise<string>;
}

interface Resolved { sessionId: string; cwd?: string; engine: SessionEngine }

const DEFAULT_ENGINE = 'claude' as SessionEngine;

/** Any engine this build knows survives the round-trip; anything else (a newer
 *  server's engine, a malformed body) reads as the default engine. */
function coerceEngine(value: unknown): SessionEngine {
  return typeof value === 'string' && (SESSION_ENGINE_IDS as readonly string[]).includes(value)
    ? value as SessionEngine
    : DEFAULT_ENGINE;
}

/**
 * Resolved lanes, keyed `${agentId}:${conversationId}:${resetNonce}` — a lane
 * binding is stable (clear bumps the nonce, which is part of the key), so a
 * revisited conversation renders its timeline IMMEDIATELY from cache instead
 * of unmounting everything behind a "Connecting…" spinner while the resolve
 * round-trips. The background resolve still runs and corrects the cache if
 * the server re-minted (e.g. the old lane was archived server-side).
 */
const resolvedCache = new Map<string, Resolved>();

export function useLaneSession(
  enabled: boolean,
  agentId: string,
  conversationId: string | null,
  resetNonce: number,
): UseLaneSessionReturn {
  const [state, setState] = useState<{ sessionId: string | null; cwd?: string; engine?: SessionEngine; error: string | null }>(
    { sessionId: null, error: null },
  );

  // The in-flight resolve, keyed by the (agent, conversation, nonce) it was
  // started for — a stale promise from a previous conversation must never be
  // handed to ensure().
  const inFlightRef = useRef<{ key: string; promise: Promise<Resolved> } | null>(null);
  // Bumped by swapEngine: a resolve that STARTED before a swap must not land its
  // (pre-swap, now-archived) session over the swapped binding.
  const swapEpochRef = useRef(0);
  const key = `${agentId}:${conversationId ?? ''}:${resetNonce}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const paramsRef = useRef({ agentId, conversationId });
  paramsRef.current = { agentId, conversationId };

  const resolve = useCallback((): Promise<Resolved> => {
    const { agentId: aid, conversationId: cid } = paramsRef.current;
    if (!enabledRef.current || !cid) {
      return Promise.reject(new Error('lane engine not active'));
    }
    const k = keyRef.current;
    if (inFlightRef.current?.key === k) return inFlightRef.current.promise;
    const epoch = swapEpochRef.current;
    const promise = apiPost<{ sessionId: string; cwd?: string; created?: boolean; engine?: string }>(
      `/api/agents/${aid}/conversations/${cid}/lane-session`,
      {},
    ).then((r) => {
      const engine = coerceEngine(r.engine);
      // A swap happened while this resolve was in flight: its session was just
      // archived server-side — the swap's binding wins, drop this one.
      if (swapEpochRef.current !== epoch) return { sessionId: r.sessionId, cwd: r.cwd, engine };
      resolvedCache.set(k, { sessionId: r.sessionId, cwd: r.cwd, engine });
      if (keyRef.current === k) setState({ sessionId: r.sessionId, cwd: r.cwd, engine, error: null });
      log.info('frontend', 'useLaneSession: resolved', {
        agentId: aid, conversationId: cid, sessionId: r.sessionId, created: r.created ?? false, engine,
      });
      return { sessionId: r.sessionId, cwd: r.cwd, engine };
    }).catch((err: unknown) => {
      if (inFlightRef.current?.key === k) inFlightRef.current = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (keyRef.current === k) setState({ sessionId: null, error: msg });
      log.warn('frontend', 'useLaneSession: resolve failed', {
        agentId: aid, conversationId: cid, error: msg,
      });
      throw err;
    });
    inFlightRef.current = { key: k, promise };
    return promise;
  }, []);

  useEffect(() => {
    // Cache hit → render the timeline instantly (no spinner unmount); the
    // resolve below still refreshes the binding in the background.
    const cached = resolvedCache.get(key);
    setState(cached ? { sessionId: cached.sessionId, cwd: cached.cwd, engine: cached.engine, error: null } : { sessionId: null, error: null });
    if (!enabled || !conversationId) return;
    resolve().catch(() => { /* state carries the error; sends retry via ensure() */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from these deps
  }, [enabled, agentId, conversationId, resetNonce, resolve]);

  const ensure = useCallback((): Promise<string> => resolve().then((r) => r.sessionId), [resolve]);

  const swapEngine = useCallback(async (engine: SessionEngine): Promise<string> => {
    const { agentId: aid, conversationId: cid } = paramsRef.current;
    if (!enabledRef.current || !cid) throw new Error('lane engine not active');
    const k = keyRef.current;
    const r = await apiPost<{ sessionId: string; cwd?: string; engine?: string }>(
      `/api/agents/${aid}/conversations/${cid}/lane-engine`,
      { engine },
    );
    const resolvedEngine = coerceEngine(r.engine);
    // Invalidate any in-flight resolve — its (pre-swap) session was just
    // archived server-side and must not overwrite the swapped binding.
    swapEpochRef.current++;
    if (inFlightRef.current?.key === k) inFlightRef.current = null;
    resolvedCache.set(k, { sessionId: r.sessionId, cwd: r.cwd, engine: resolvedEngine });
    if (keyRef.current === k) setState({ sessionId: r.sessionId, cwd: r.cwd, engine: resolvedEngine, error: null });
    log.info('frontend', 'useLaneSession: engine swapped', {
      agentId: aid, conversationId: cid, sessionId: r.sessionId, engine: resolvedEngine,
    });
    return r.sessionId;
  }, []);

  return { sessionId: state.sessionId, cwd: state.cwd, engine: state.engine ?? DEFAULT_ENGINE, error: state.error, ensure, swapEngine };
}
