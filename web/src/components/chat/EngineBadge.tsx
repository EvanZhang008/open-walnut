/**
 * EngineBadge — small pill in the chat header showing WHICH engine answers the
 * Personal AI's turns: the in-process loop ('walnut-agent') or a lane-bound Claude
 * Code session ('claude-code', via config.agent.provider).
 *
 * Exists because the two engines are otherwise invisible from the outside — the
 * Settings "AI Provider" section only picks the model credentials the in-process
 * loop calls with, so during an engine A/B the user cannot tell which engine a
 * reply came from. Reads live config and refetches on config:changed (the flag
 * is read per turn on the server; no restart involved).
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';

export type Engine = 'walnut-agent' | 'claude-code';

/** Mirror of the server's resolveAgentEngineProvider: anything but the exact
 *  string 'claude-code' (unset, 'walnut-agent', hand-edited junk) degrades to
 *  the in-process loop. */
function resolveEngine(provider: unknown): Engine {
  return provider === 'claude-code' ? 'claude-code' : 'walnut-agent';
}

/** Live engine flag — refetches on config:changed. null until the first fetch
 *  resolves (callers treat null as "in-process" so the flag-off UI is default). */
export function useChatEngine(): Engine | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  const load = useCallback(() => {
    fetchConfig()
      .then((c) => setEngine(resolveEngine(c.agent?.provider)))
      .catch(() => { /* keep the last known value */ });
  }, []);
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
        ? 'Main AI turns run in a Claude Code session (agent.provider: claude-code). The claude CLI brings its own auth — the AI Provider in Settings is not what answers these turns.'
        : 'Main AI turns run in the built-in agent loop, calling the AI Provider configured in Settings.'}
    >
      {isLane ? 'Claude Code' : 'Built-in loop'}
    </span>
  );
}
