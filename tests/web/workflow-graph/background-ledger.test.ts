/**
 * Unit tests for background-ledger — the pure arithmetic behind the Background panel's
 * per-agent ledger rows (Claude Code "Background tasks" parity).
 *
 * Under test:
 *   1. fmtElapsed()   — 58s / 4m 12s / 1h 03m, and "unknown → empty" (never "0s").
 *   2. rowElapsedMs() — running ticks off startedAt; terminal prefers the CLI's
 *      duration_ms and falls back to our own start→end span.
 *   3. buildAgentMeta() — segment order + which segments are dropped when absent, and
 *      that activity ("Running Bash") only shows while the agent runs.
 */

import { describe, it, expect } from 'vitest';
import { fmtElapsed, fmtTokens, rowActivity, rowElapsedMs, buildAgentMeta } from '@/components/sessions/background-ledger';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';

function task(p: Partial<BackgroundTask>): BackgroundTask {
  return { taskId: 'a6ec1bb7e', status: 'running', ...p };
}

describe('fmtElapsed — Claude Code shape', () => {
  it('seconds under a minute', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(999)).toBe('0s');      // floors, never rounds up to 1s
    expect(fmtElapsed(58_000)).toBe('58s');
    expect(fmtElapsed(59_999)).toBe('59s');
  });

  it('minutes + zero-padded seconds so the width does not jump while ticking', () => {
    expect(fmtElapsed(60_000)).toBe('1m 00s');
    expect(fmtElapsed(252_000)).toBe('4m 12s');
    expect(fmtElapsed(65_000)).toBe('1m 05s');
  });

  it('hours + zero-padded minutes (seconds drop off — pointless at that scale)', () => {
    expect(fmtElapsed(3_600_000)).toBe('1h 00m');
    expect(fmtElapsed(3_780_000)).toBe('1h 03m');
    expect(fmtElapsed(2 * 3_600_000 + 45 * 60_000)).toBe('2h 45m');
  });

  it('unknown / nonsense spans render as nothing, not 0s', () => {
    // A row with no clock at all must omit the segment entirely — "0s" would be a lie.
    expect(fmtElapsed(undefined)).toBe('');
    expect(fmtElapsed(-1)).toBe('');
    expect(fmtElapsed(Number.NaN)).toBe('');
    expect(fmtElapsed(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('rowElapsedMs — which clock a row reads', () => {
  const NOW = 1_000_000;

  it('running: wall clock since startedAt (this is what ticks each second)', () => {
    expect(rowElapsedMs(task({ startedAt: NOW - 58_000 }), NOW)).toBe(58_000);
  });

  it('running with no startedAt (recovered from disk): falls back to the CLI duration', () => {
    expect(rowElapsedMs(task({ durationMs: 6_830 }), NOW)).toBe(6_830);
    expect(rowElapsedMs(task({}), NOW)).toBeUndefined();
  });

  it('running: a startedAt in the future clamps to 0 rather than going negative', () => {
    // Clock skew between the server stamp and the browser must not print "-3s".
    expect(rowElapsedMs(task({ startedAt: NOW + 3_000 }), NOW)).toBe(0);
  });

  it('terminal: the CLI duration wins over our own span (it is the authority)', () => {
    const t = task({ status: 'completed', startedAt: NOW - 90_000, endedAt: NOW - 10_000, durationMs: 6_830 });
    expect(rowElapsedMs(t, NOW)).toBe(6_830);
  });

  it('terminal without a CLI duration: our endedAt - startedAt span', () => {
    const t = task({ status: 'completed', startedAt: NOW - 90_000, endedAt: NOW - 10_000 });
    expect(rowElapsedMs(t, NOW)).toBe(80_000);
  });

  it('terminal: stops moving once ended (a later `now` changes nothing)', () => {
    const t = task({ status: 'completed', startedAt: NOW - 90_000, endedAt: NOW - 10_000 });
    expect(rowElapsedMs(t, NOW + 60_000)).toBe(80_000);
  });

  it('terminal with neither clock → undefined (omit the segment)', () => {
    expect(rowElapsedMs(task({ status: 'failed' }), NOW)).toBeUndefined();
  });
});

describe('rowActivity — only a running agent has an activity', () => {
  it('lastTool renders Claude-Code style; summary is the fallback', () => {
    expect(rowActivity(task({ lastTool: 'Bash' }))).toBe('Running Bash');
    expect(rowActivity(task({ summary: 'reading files' }))).toBe('reading files');
    expect(rowActivity(task({ lastTool: 'Bash', summary: 'reading files' }))).toBe('Running Bash');
  });

  it('a terminal row shows no activity (its last tool is stale noise)', () => {
    expect(rowActivity(task({ status: 'completed', lastTool: 'Bash' }))).toBeUndefined();
    expect(rowActivity(task({ status: 'failed', summary: 'boom' }))).toBeUndefined();
  });

  it('a long summary is truncated so one row cannot swallow the panel', () => {
    const activity = rowActivity(task({ summary: 'x'.repeat(500) }))!;
    expect(activity.length).toBe(80);
  });
});

describe('buildAgentMeta — segment order and omissions', () => {
  const NOW = 1_000_000;

  it('full running row: Agent · elapsed · tokens · tool uses · activity', () => {
    const t = task({ startedAt: NOW - 58_000, tokens: 64_500, toolUses: 16, lastTool: 'Bash' });
    expect(buildAgentMeta(t, NOW)).toEqual(['Agent', '58s', '65k tokens', '16 tool uses', 'Running Bash']);
  });

  it('a bare row is just the "Agent" label (no zeros, no empty segments)', () => {
    expect(buildAgentMeta(task({}), NOW)).toEqual(['Agent']);
  });

  it('zero tokens is dropped, zero tool uses is KEPT (started, no tool call yet)', () => {
    const t = task({ startedAt: NOW - 1_000, tokens: 0, toolUses: 0 });
    expect(buildAgentMeta(t, NOW)).toEqual(['Agent', '1s', '0 tool uses']);
  });

  it('one tool use is singular', () => {
    expect(buildAgentMeta(task({ toolUses: 1 }), NOW)).toEqual(['Agent', '1 tool use']);
  });

  it('a finished row keeps its numbers but drops the activity', () => {
    const t = task({ status: 'completed', durationMs: 252_000, tokens: 3_400, toolUses: 4, lastTool: 'Read' });
    expect(buildAgentMeta(t, NOW)).toEqual(['Agent', '4m 12s', '3k tokens', '4 tool uses']);
  });
});

describe('fmtTokens — unchanged behavior (moved here from WorkflowGraph)', () => {
  it('compacts thousands and drops a zero/absent count', () => {
    expect(fmtTokens(undefined)).toBe('');
    expect(fmtTokens(0)).toBe('');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_200)).toBe('1k');
    expect(fmtTokens(64_500)).toBe('65k');
  });
});
