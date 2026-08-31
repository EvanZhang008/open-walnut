import { useState, useCallback, useEffect } from 'react';
import { useEvent } from './useWebSocket';

export interface SessionUsage {
  model?: string;
  /** Context window usage percentage (0–100, may exceed 100 near compaction).
   *  Absent while the server has no trustworthy denominator (see
   *  src/providers/context-window.ts) — render tokens, not a guess. */
  contextPercent?: number;
  /** Total input tokens for the latest API call (incl. cache). */
  inputTokens?: number;
  /** Denominator behind contextPercent — the MODEL'S ABSOLUTE max window, for
   *  the "99K / 1M" tooltip. */
  contextWindow?: number;
  /** Where this session auto-compacts, when below contextWindow. Shown as a
   *  separate line: it explains why a session compacts "early" without
   *  redefining what the percentage measures. */
  autoCompactAt?: number;
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
    const d = data as {
      sessionId?: string; model?: string; contextPercent?: number;
      inputTokens?: number; contextWindow?: number; autoCompactAt?: number;
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    setUsage({
      model: d.model,
      contextPercent: d.contextPercent,
      inputTokens: d.inputTokens,
      contextWindow: d.contextWindow,
      autoCompactAt: d.autoCompactAt,
    });
  }, [sessionId]);

  useEvent('session:usage-update', handler);

  return usage;
}

// formatModelName moved to '@/utils/model-name' (pure module, unit-testable
// without this hook's react/websocket import chain); re-exported for importers.
export { formatModelName } from '@/utils/model-name';

/**
 * Client-side fallback window, used ONLY when the server sent no
 * `contextWindow` (history-derived usage on a session with no live events).
 * Returns null for any model whose window the string can't reveal — a custom
 * proxy model (GPT-5.6 Sol via the local Bedrock proxy) carries no `[1m]`
 * marker, and guessing 200K for it put a 5x-wrong percentage on the badge
 * (2026-08-23). The server's authoritative value replaces this on the first
 * live turn; until then, showing nothing beats showing a wrong number.
 */
export function getContextWindowSize(model: string | undefined, totalInput?: number): number | null {
  const lower = model?.toLowerCase();
  if (!lower) return null;
  if (lower.includes('[1m]')) return 1_000_000;
  // NB: no natively-1M special case here (e.g. Opus 5) — the Claude CLI generates
  // separate plain (200K auto-compact) and "[1m]" rows for opus-5, so a plain
  // opus-5 session string really does mean a 200K effective window.
  if (!/claude/.test(lower) && !/\b(opus|sonnet|haiku|fable)\b/.test(lower)) return null;
  // Claude CLI resumes sometimes drop the [1m] suffix — if tokens exceed 200K,
  // the session must be using 1M context (you can't exceed the window).
  if (totalInput != null && totalInput > 200_000) return 1_000_000;
  return 200_000;
}

/** Compact token count for badges/tooltips: 99366 → "99K", 1000000 → "1M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Tooltip for the context badge. Names the denominator (the MODEL'S max window)
 * and, separately, where this session will auto-compact when a setting puts that
 * below the model's limit. Two facts, two lines: folding the compaction window
 * into the percentage is what made the same 99K read as 25% here and 10% in the
 * picker (2026-08-23).
 */
export function contextBadgeTitle(usage: SessionUsage, percent: number): string {
  const parts = [`Context: ${percent}%`];
  if (usage.inputTokens != null && usage.contextWindow != null) {
    parts.push(`${fmtTokens(usage.inputTokens)} / ${fmtTokens(usage.contextWindow)} (model max)`);
  } else if (usage.inputTokens != null) {
    parts.push(`${fmtTokens(usage.inputTokens)} in context`);
  }
  if (usage.autoCompactAt != null) {
    parts.push(`auto-compacts at ${fmtTokens(usage.autoCompactAt)}`);
  }
  return parts.join(' — ');
}
