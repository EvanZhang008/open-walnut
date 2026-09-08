/**
 * background-ledger — pure derivation/formatting for the Background panel's per-agent
 * ledger rows. No React, no DOM (same convention as workflow-layout.ts) so the row's
 * arithmetic is unit-testable as a plain data transform.
 *
 * The row mirrors Claude Code's "Background tasks" panel:
 *
 *   Investigate repo structure and main files          general-purpose
 *   Agent · 58s · 64k tokens · 16 tool uses · Running Bash        View transcript
 *
 * Everything here is DISPLAY-ONLY — the numbers come from task_progress.usage and our
 * own start/end clocks, and none of them feed turn-completion.
 */

import type { BackgroundTask } from '@/hooks/useBackgroundTasks';

/** Compact token count ("1200" → "1k"). Shared with WorkflowGraph's agent meta. */
export function fmtTokens(n?: number): string {
  if (!n) return '';
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Elapsed span in Claude Code's shape: `58s`, `4m 12s`, `1h 03m`. Empty for an unknown
 *  span so callers can just drop the segment. Minutes/seconds are zero-padded so the
 *  number doesn't jump width as it ticks. */
export function fmtElapsed(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** How long the row should say the agent has been working.
 *
 *  Running → wall clock from OUR startedAt (the caller re-renders once a second), with
 *  the CLI's last reported duration as the fallback for a task recovered from disk that
 *  has no startedAt. Terminal → the CLI's duration when it sent one, else our own
 *  start→end span. undefined means neither clock is known: show nothing rather than 0s. */
export function rowElapsedMs(task: BackgroundTask, now: number): number | undefined {
  if (task.status === 'running') {
    return task.startedAt != null ? Math.max(0, now - task.startedAt) : task.durationMs;
  }
  if (task.durationMs != null) return task.durationMs;
  if (task.startedAt != null && task.endedAt != null) return Math.max(0, task.endedAt - task.startedAt);
  return undefined;
}

/** Longest activity string a row will show before ellipsis (a summary can be a paragraph). */
const MAX_ACTIVITY = 80;

/** What the agent is doing right now, Claude-Code style ("Running Bash"). Only meaningful
 *  while it runs — a finished row's last tool is noise, so terminal rows get nothing. */
export function rowActivity(task: BackgroundTask): string | undefined {
  if (task.status !== 'running') return undefined;
  const text = task.lastTool ? `Running ${task.lastTool}` : task.summary;
  return text ? text.slice(0, MAX_ACTIVITY) : undefined;
}

/** The muted meta segments under an agent row, in render order. Returned as a list (not a
 *  joined string) so the row renders each as its own span and CSS owns the separators. */
export function buildAgentMeta(task: BackgroundTask, now: number): string[] {
  const out: string[] = ['Agent'];
  const elapsed = fmtElapsed(rowElapsedMs(task, now));
  if (elapsed) out.push(elapsed);
  const tokens = fmtTokens(task.tokens);
  if (tokens) out.push(`${tokens} tokens`);
  // 0 is meaningful here ("started, no tool call yet") — only an ABSENT count is dropped.
  if (task.toolUses != null) out.push(`${task.toolUses} tool ${task.toolUses === 1 ? 'use' : 'uses'}`);
  const activity = rowActivity(task);
  if (activity) out.push(activity);
  return out;
}
