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
  /** `contextWindow` is an estimate (the model's name, a stored hint, a floor), not the number
   *  Claude Code or the engine reported: shown as "~1M (estimate)". */
  contextWindowEstimate?: boolean;
  /** Where this session auto-compacts, when below contextWindow. Shown as a
   *  separate line: it explains why a session compacts "early" without
   *  redefining what the percentage measures. */
  autoCompactAt?: number;
  /** Where this session stops when Claude Code's auto-compact is off for it (every request is
   *  refused from here). contextPercent is then measured against it: 100% is the stop. */
  stopsAt?: number;
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
      inputTokens?: number; contextWindow?: number; contextWindowEstimate?: boolean; autoCompactAt?: number; stopsAt?: number;
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    setUsage({
      model: d.model,
      contextPercent: d.contextPercent,
      inputTokens: d.inputTokens,
      contextWindow: d.contextWindow,
      ...(d.contextWindowEstimate ? { contextWindowEstimate: true } : {}),
      autoCompactAt: d.autoCompactAt,
      stopsAt: d.stopsAt,
    });
  }, [sessionId]);

  useEvent('session:usage-update', handler);

  return usage;
}

// formatModelName moved to '@/utils/model-name' (pure module, unit-testable
// without this hook's react/websocket import chain); re-exported for importers.
export { formatModelName } from '@/utils/model-name';
import { isExactWindowSource, modelNameWindowEstimate } from '../../../src/providers/context-window';

/** A window a page shows, and whether it is only an estimate. */
export interface PageContextWindow { window: number; estimate: boolean }

/**
 * The window a page shows for a session with no live reading: the server's stored one, else the
 * name rule, lifted to what the session already holds (its tokens, its auto-compact point). A
 * window is never below either, and an Anthropic model's window is 200K or 1M, so a stored or
 * guessed 200K under a session holding 324K reads 1M (2026-11-06: Opus 5.5 has 1M built in with
 * no `[1m]` in its id, and the badge read 162%). Mirrors resolveContextWindow's floor on the server.
 * Only a stored window the CLI or the engine reported (`storedSource`) and not lifted counts as
 * exact; every other answer is an estimate the badge marks as one (2026-11-07).
 */
export function sessionContextWindow(
  stored: number | null | undefined, model: string | undefined, totalInput: number, autoCompactAt?: number | null,
  storedSource?: string,
): PageContextWindow | null {
  const hasStored = !!stored && stored > 0;
  const base = hasStored ? stored! : (modelNameWindowEstimate(model) ?? null);
  const window = liftedWindow(base, model, Math.max(totalInput, autoCompactAt ?? 0));
  if (window == null) return null;
  return { window, estimate: !(hasStored && window === stored && isExactWindowSource(storedSource)) };
}

const isAnthropicModel = (lower: string): boolean =>
  lower.includes('[1m]') || /claude/.test(lower) || /\b(opus|sonnet|haiku|fable)\b/.test(lower);

function liftedWindow(window: number | null, model: string | undefined, floor: number): number | null {
  if (window == null || window >= floor) return window;
  return isAnthropicModel(model?.toLowerCase() ?? '') ? Math.max(1_000_000, floor) : floor;
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
  if (usage.inputTokens != null && usage.stopsAt != null) {
    // Auto-compact is off: the percentage is of the stop, and the stop is what to know.
    parts.push(`${fmtTokens(usage.inputTokens)} / ${fmtTokens(usage.stopsAt)}, where this session stops: auto-compact is off, so from there every message gets "Prompt is too long" until it is compacted`);
    return parts.join(' — ');
  }
  if (usage.inputTokens != null && usage.contextWindow != null) {
    parts.push(usage.contextWindowEstimate
      ? `${fmtTokens(usage.inputTokens)} / ~${fmtTokens(usage.contextWindow)} (estimate: Claude Code has not reported this model's window yet)`
      : `${fmtTokens(usage.inputTokens)} / ${fmtTokens(usage.contextWindow)} (model max)`);
  } else if (usage.inputTokens != null) {
    parts.push(`${fmtTokens(usage.inputTokens)} in context`);
  }
  if (usage.autoCompactAt != null) {
    parts.push(`auto-compacts at ${fmtTokens(usage.autoCompactAt)}`);
  }
  return parts.join(' — ');
}
