/**
 * useLaneSession — resolve the Claude Code session backing a main-AI
 * conversation (the "lane"), for the thin-layer chat surface.
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
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';

export interface UseLaneSessionReturn {
  sessionId: string | null;
  cwd?: string;
  error: string | null;
  ensure: () => Promise<string>;
}

interface Resolved { sessionId: string; cwd?: string }

export function useLaneSession(
  enabled: boolean,
  agentId: string,
  conversationId: string | null,
  resetNonce: number,
): UseLaneSessionReturn {
  const [state, setState] = useState<{ sessionId: string | null; cwd?: string; error: string | null }>(
    { sessionId: null, error: null },
  );

  // The in-flight resolve, keyed by the (agent, conversation, nonce) it was
  // started for — a stale promise from a previous conversation must never be
  // handed to ensure().
  const inFlightRef = useRef<{ key: string; promise: Promise<Resolved> } | null>(null);
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
    const promise = apiPost<{ sessionId: string; cwd?: string; created?: boolean }>(
      `/api/agents/${aid}/conversations/${cid}/lane-session`,
      {},
    ).then((r) => {
      if (keyRef.current === k) setState({ sessionId: r.sessionId, cwd: r.cwd, error: null });
      log.info('frontend', 'useLaneSession: resolved', {
        agentId: aid, conversationId: cid, sessionId: r.sessionId, created: r.created ?? false,
      });
      return { sessionId: r.sessionId, cwd: r.cwd };
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
    setState({ sessionId: null, error: null });
    if (!enabled || !conversationId) return;
    resolve().catch(() => { /* state carries the error; sends retry via ensure() */ });
  }, [enabled, agentId, conversationId, resetNonce, resolve]);

  const ensure = useCallback((): Promise<string> => resolve().then((r) => r.sessionId), [resolve]);

  return { sessionId: state.sessionId, cwd: state.cwd, error: state.error, ensure };
}
