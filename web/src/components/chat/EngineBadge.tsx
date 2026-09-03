/**
 * EngineBadge — small pill in the chat header showing WHICH engine answers the
 * Personal AI's turns: the in-process loop ('walnut-agent') or a lane-bound Claude
 * Code session ('claude-code', via config.agent.provider).
 *
 * The engine follows the AI provider (Settings → Ask Walnut Provider): Claude Code → the
 * lane session, any other provider → the in-process loop. An explicit
 * `agent.provider` is an advanced override. Reads live config and refetches on
 * config:changed (the flag is read per turn on the server; no restart involved).
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';
import { useSystemHealth } from '@/hooks/useSystemHealth';

export type Engine = 'walnut-agent' | 'claude-code';

/** Mirror of the server's resolveAgentEngineProvider: an explicit valid engine is
 *  honored; otherwise the engine follows the effective AI provider (the server
 *  reports it as health.mainProvider, defaulting rule included). */
function resolveEngine(provider: unknown, mainProvider: string | undefined): Engine {
  if (provider === 'claude-code' || provider === 'walnut-agent') return provider;
  return mainProvider === 'claude_cli' ? 'claude-code' : 'walnut-agent';
}

/** Live engine flag — refetches on config:changed. null until the first fetch
 *  resolves (callers treat null as "in-process" so the flag-off UI is default). */
export function useChatEngine(): Engine | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  const { health } = useSystemHealth();
  const mainProvider = health.mainProvider;
  const load = useCallback(() => {
    fetchConfig()
      .then((c) => setEngine(resolveEngine(c.agent?.provider, mainProvider)))
      .catch(() => { /* keep the last known value */ });
  }, [mainProvider]);
  useEffect(load, [load]);
  useEvent('config:changed', load);
  return engine;
}

export function EngineBadge() {
  const engine = useChatEngine();

  if (!engine) return null;
  const isLane = engine === 'claude-code';
  return (
    <span
      className={`chat-engine-badge${isLane ? ' lane' : ''}`}
      title={isLane
        ? 'Ask Walnut answers from a Claude Code session, with the claude CLI\'s own login (Settings → Ask Walnut Provider: Claude Code).'
        : 'Ask Walnut answers from the built-in agent loop, calling the provider chosen under Settings → Ask Walnut Provider.'}
    >
      {isLane ? 'Claude Code' : 'Built-in loop'}
    </span>
  );
}
