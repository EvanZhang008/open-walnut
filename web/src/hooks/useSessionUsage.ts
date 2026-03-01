import { useState, useCallback } from 'react';
import { useEvent } from './useWebSocket';

export interface SessionUsage {
  model?: string;
  /** Context window usage percentage (0–100). */
  contextPercent?: number;
  /** Total input tokens for the latest API call (incl. cache). */
  inputTokens?: number;
}

/**
 * Subscribe to real-time context window usage for a specific session.
 * Listens to `session:usage-update` WebSocket events (sent only to
 * clients subscribed to that session's stream).
 */
export function useSessionUsage(sessionId: string | null): SessionUsage {
  const [usage, setUsage] = useState<SessionUsage>({});

  const handler = useCallback((data: unknown) => {
    const d = data as { sessionId?: string; model?: string; contextPercent?: number; inputTokens?: number };
    if (!sessionId || d.sessionId !== sessionId) return;
    setUsage({
      model: d.model,
      contextPercent: d.contextPercent,
      inputTokens: d.inputTokens,
    });
  }, [sessionId]);

  useEvent('session:usage-update', handler);

  return usage;
}

/** Normalize a Claude model ID to a short display name. */
export function formatModelName(model: string | undefined): string {
  if (!model) return '';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return model;
}
