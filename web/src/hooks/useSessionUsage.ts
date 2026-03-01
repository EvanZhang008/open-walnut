import { useState, useCallback, useEffect } from 'react';
import { useEvent } from './useWebSocket';

export interface SessionUsage {
  model?: string;
  /** Context window usage percentage (0–100, may exceed 100 near compaction). */
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

  // Reset when navigating between sessions to avoid showing stale data
  useEffect(() => { setUsage({}); }, [sessionId]);

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

/**
 * Normalize a Claude model ID to a readable display name with version.
 * "claude-opus-4-6" → "Opus 4.6", "claude-sonnet-4-5-20251001" → "Sonnet 4.5"
 */
export function formatModelName(model: string | undefined): string {
  if (!model) return '';
  const lower = model.toLowerCase();
  // Extract family name
  let family = '';
  if (lower.includes('opus')) family = 'Opus';
  else if (lower.includes('sonnet')) family = 'Sonnet';
  else if (lower.includes('haiku')) family = 'Haiku';
  else return model;
  // Extract version: match "family-X-Y" pattern → "X.Y"
  const versionMatch = lower.match(/(?:opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (versionMatch) return `${family} ${versionMatch[1]}.${versionMatch[2]}`;
  // Fallback: match "family-X" → "X"
  const majorMatch = lower.match(/(?:opus|sonnet|haiku)-(\d+)/);
  if (majorMatch) return `${family} ${majorMatch[1]}`;
  return family;
}
