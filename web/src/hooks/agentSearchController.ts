/**
 * Agent search controller — framework-free state machine behind the AI panel.
 * Kept out of React so the root vitest tier (node env, no jsdom) can test the
 * debounce/nonce/abort/latch behavior directly with fake timers.
 */

import type { AgentSearchPayload } from '@/api/agentSearch';
import { AGENT_SEARCH_DEBOUNCE_MS, isAgentSearchEligible } from '@/hooks/agentSearchTrigger';

export type AgentPanelState = 'hidden' | 'loading' | 'done' | 'error';

export interface AgentSearchSnapshot {
  state: AgentPanelState;
  data?: AgentSearchPayload;
  /** Progress-stream id of the in-flight fetch — the panel filters
   *  'search-agent:progress' WS events by it while loading. */
  sid?: string;
}

interface ControllerDeps {
  fetcher: (q: string, opts: { signal?: AbortSignal; sid?: string }) => Promise<AgentSearchPayload>;
  peek: (q: string) => AgentSearchPayload | undefined;
  onState: (snapshot: AgentSearchSnapshot) => void;
  isEnabled: () => boolean;
}

function newSid(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `sid-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

// Module-level latch: 503 ai_disabled means the whole deployment can't serve
// this feature (no CLI / AI off) — stop asking for the rest of the page life.
// Re-enabling the toggle clears it (the user may have fixed the environment).
let permanentlyDisabled = false;

export function _resetAgentSearchLatchForTesting(): void {
  permanentlyDisabled = false;
}

export function clearAgentSearchLatch(): void {
  permanentlyDisabled = false;
}

export function createAgentSearchController(deps: ControllerDeps): {
  setQuery: (q: string) => void;
  retry: () => void;
  dispose: () => void;
} {
  let generation = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let lastQuery = '';

  const cancelInflight = () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abort) { abort.abort(); abort = null; }
  };

  const run = (q: string) => {
    const gen = ++generation;
    cancelInflight();
    const sid = newSid();
    deps.onState({ state: 'loading', sid });
    const controller = new AbortController();
    abort = controller;
    deps.fetcher(q, { signal: controller.signal, sid })
      .then((data) => {
        if (gen !== generation || controller.signal.aborted) return;
        deps.onState({ state: 'done', data });
      })
      .catch((err: unknown) => {
        if (gen !== generation || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const status = (err as { status?: number }).status;
        const code = ((err as { body?: { code?: string } }).body)?.code;
        if (status === 503 || code === 'ai_disabled') {
          permanentlyDisabled = true;
          deps.onState({ state: 'hidden' });
          return;
        }
        if (status === 400) { deps.onState({ state: 'hidden' }); return; }
        deps.onState({ state: 'error' });
      })
      .finally(() => {
        if (abort === controller) abort = null;
      });
  };

  const setQuery = (q: string) => {
    lastQuery = q;
    generation++; // any in-flight response is now stale
    cancelInflight();
    if (permanentlyDisabled || !deps.isEnabled() || !isAgentSearchEligible(q)) {
      deps.onState({ state: 'hidden' });
      return;
    }
    const cachedPayload = deps.peek(q);
    if (cachedPayload) {
      deps.onState({ state: 'done', data: cachedPayload });
      return;
    }
    deps.onState({ state: 'loading' });
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(q);
    }, AGENT_SEARCH_DEBOUNCE_MS);
  };

  return {
    setQuery,
    retry: () => {
      if (permanentlyDisabled || !deps.isEnabled() || !isAgentSearchEligible(lastQuery)) return;
      run(lastQuery);
    },
    dispose: () => {
      generation++;
      cancelInflight();
    },
  };
}
