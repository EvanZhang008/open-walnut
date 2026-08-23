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
  /** Denominator behind contextPercent — the CLI's effective window
   *  (min(model window, auto-compact clamp)), for the "99K / 400K" tooltip. */
  contextWindow?: number;
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
      inputTokens?: number; contextWindow?: number;
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    setUsage({
      model: d.model,
      contextPercent: d.contextPercent,
      inputTokens: d.inputTokens,
      contextWindow: d.contextWindow,
    });
  }, [sessionId]);

  useEvent('session:usage-update', handler);

  return usage;
}

/**
 * Normalize a Claude model ID to a readable display name with version.
 * "claude-opus-4-6" → "Opus 4.6"
 * "global.anthropic.claude-opus-4-6-v1[1m]" → "Opus 4.6 1M"
 */
export function formatModelName(model: string | undefined): string {
  if (!model) return '';
  const lower = model.toLowerCase();
  // Extract family name
  let family = '';
  if (lower.includes('opus')) family = 'Opus';
  else if (lower.includes('sonnet')) family = 'Sonnet';
  else if (lower.includes('haiku')) family = 'Haiku';
  else if (lower.includes('fable')) family = 'Fable';
  // Custom / proxy models (ANTHROPIC_CUSTOM_MODEL_OPTION) keep their own id —
  // just tidy the casing of a leading "gpt-" so the badge reads "GPT-5.6 Sol".
  else if (lower.startsWith('gpt-')) {
    return model
      .split('-')
      .map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-')
      .replace(/-(?=[A-Z][a-z])/g, ' ');
  }
  else return model;
  // Detect 1M extended context from init model string
  const is1M = lower.includes('[1m]');
  const suffix = is1M ? ' 1M' : '';
  // Extract version: match "family-X-Y" pattern → "X.Y"
  const versionMatch = lower.match(/(?:opus|sonnet|haiku|fable)-(\d+)-(\d+)/);
  if (versionMatch) return `${family} ${versionMatch[1]}.${versionMatch[2]}${suffix}`;
  // Fallback: match "family-X" → "X"
  const majorMatch = lower.match(/(?:opus|sonnet|haiku|fable)-(\d+)/);
  if (majorMatch) return `${family} ${majorMatch[1]}${suffix}`;
  return `${family}${suffix}`;
}

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
 * Tooltip for the context badge. Always names the denominator: the badge divides
 * by the CLI's EFFECTIVE window (min(model window, CLAUDE_CODE_AUTO_COMPACT_WINDOW)),
 * which is the same number the model picker's context panel shows and the one
 * that decides when the session compacts.
 */
export function contextBadgeTitle(usage: SessionUsage, percent: number): string {
  const parts = [`Context: ${percent}%`];
  if (usage.inputTokens != null && usage.contextWindow != null) {
    parts.push(`${fmtTokens(usage.inputTokens)} / ${fmtTokens(usage.contextWindow)} (window the session compacts at)`);
  } else if (usage.inputTokens != null) {
    parts.push(`${fmtTokens(usage.inputTokens)} in context`);
  }
  return parts.join(' — ');
}
