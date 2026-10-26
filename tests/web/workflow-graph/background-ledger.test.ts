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
import { fmtElapsed, fmtTokens, rowActivity, rowElapsedMs, buildAgentMeta, agentResultText, backgroundAgentsOnly, backgroundRunning, backgroundRunningLabel } from '@/components/sessions/background-ledger';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';

function task(p: Partial<BackgroundTask>): BackgroundTask {
  return { taskId: 'a6ec1bb7e', status: 'running', ...p };
}

describe('backgroundAgentsOnly', () => {
  const agent = task({ taskType: 'local_agent', isBackgrounded: true });

  it('keeps one or many running agents and ignores terminal jobs', () => {
    expect(backgroundAgentsOnly([agent])).toEqual([agent]);
    const second = { ...agent, taskId: 'second' };
    expect(backgroundAgentsOnly([agent, second, task({ status: 'failed', taskType: 'local_bash' })])).toEqual([agent, second]);
  });

  it('does not label commands, unknown jobs, or paused agents as working subagents', () => {
    for (const taskType of ['local_bash', 'local_shell', 'unknown']) {
      expect(backgroundAgentsOnly([agent, task({ taskType })])).toEqual([]);
    }
    for (const status of ['paused', 'pending', 'completed', 'failed', 'stopped', 'killed', 'cancelled']) {
      expect(backgroundAgentsOnly([{ ...agent, status }])).toEqual([]);
    }
    expect(backgroundAgentsOnly([agent, task({ taskType: 'local_bash', ownedBySubagent: true })])).toEqual([agent]);
    expect(backgroundAgentsOnly([agent, task({ taskType: 'local_bash', endedPerLevel: true })])).toEqual([agent]);
    expect(backgroundAgentsOnly([{ ...agent, endedPerLevel: true }])).toEqual([]);
    expect(backgroundAgentsOnly([])).toEqual([]);
  });

  it('recognizes remote agents, teammates, and typed recovery rows', () => {
    for (const taskType of ['remote_agent', 'in_process_teammate']) {
      expect(backgroundAgentsOnly([{ ...agent, taskType }])).toHaveLength(1);
    }
    expect(backgroundAgentsOnly([{ ...agent, taskType: undefined, subagentType: 'Explore' }])).toHaveLength(1);
    expect(backgroundAgentsOnly([{ ...agent, taskType: undefined }])).toEqual([]);
  });
});

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

describe('fmtTokens', () => {
  it('compacts thousands and drops a zero/absent count', () => {
    expect(fmtTokens(undefined)).toBe('');
    expect(fmtTokens(0)).toBe('');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_200)).toBe('1k');
    expect(fmtTokens(64_500)).toBe('65k');
    expect(fmtTokens(999_499)).toBe('999k');
  });

  it('switches to millions instead of printing thousands of k', () => {
    expect(fmtTokens(999_500)).toBe('1.0M');
    expect(fmtTokens(8_649_000)).toBe('8.6M');
    expect(fmtTokens(9_949_999)).toBe('9.9M');
    expect(fmtTokens(9_950_000)).toBe('10M');
    expect(fmtTokens(123_400_000)).toBe('123M');
  });
});

describe('agentResultText', () => {
  // The three launch notes the CLI's Agent tool writes (AgentTool mapToolResultToToolResultBlockParam).
  const ASYNC_NOTE = 'Async agent launched successfully.\nagentId: a6f8ed691cfeb0395 (internal ID - do not mention to user.)\noutput_file: /tmp/x/tasks/a6f8ed691cfeb0395.output';
  const REMOTE_NOTE = 'Remote agent launched in CCR.\ntaskId: t1\nsession_url: https://example.test/s\noutput_file: /tmp/x/t1.output';
  const TEAMMATE_NOTE = 'Spawned successfully.\nagent_id: researcher@team\nname: researcher\nteam_name: team';

  it('drops each launch note: it is not the agent\'s result', () => {
    expect(agentResultText(ASYNC_NOTE)).toBeUndefined();
    expect(agentResultText(REMOTE_NOTE)).toBeUndefined();
    expect(agentResultText(TEAMMATE_NOTE)).toBeUndefined();
  });

  it('keeps an answer, including an older CLI\'s sync answer with no background flag', () => {
    expect(agentResultText('Explorer 0 report.')).toBe('Explorer 0 report.');
    expect(agentResultText('The fleet is healthy.\nagentId: a1b2c3 (for resuming)')).toBe('The fleet is healthy.\nagentId: a1b2c3 (for resuming)');
  });

  it('keeps the error of a launch that failed', () => {
    expect(agentResultText('Agent type not found: nope')).toBe('Agent type not found: nope');
  });

  it('keeps text that only mentions a launch later on', () => {
    expect(agentResultText('Summary: the job was Spawned successfully. elsewhere')).toBe('Summary: the job was Spawned successfully. elsewhere');
  });

  it('is undefined with no result at all', () => {
    expect(agentResultText(undefined)).toBeUndefined();
    expect(agentResultText('')).toBeUndefined();
  });
});

describe('backgroundRunning / backgroundRunningLabel (the working line and the session menu)', () => {
  const agent = (id: string, status = 'running') => task({ taskId: id, status, taskType: 'local_agent' });
  const command = (id: string, status = 'running') => task({ taskId: id, status, taskType: 'local_bash' });

  it('counts only what is still going, as the panel lists it', () => {
    const r = backgroundRunning([
      command('c1'), command('c2', 'completed'), agent('a1'), agent('a2', 'failed'),
      task({ taskId: 'nested', status: 'running', taskType: 'local_bash', ownedBySubagent: true }),
      task({ taskId: 'ended', status: 'running', taskType: 'local_bash', endedPerLevel: true }),
    ]);
    expect(r).toEqual({ agents: 1, commands: 1, other: 0, total: 2 });
    expect(backgroundRunningLabel(r)).toBe('1 agent, 1 command');
  });

  it('names one kind alone, plural when more, and says nothing when all is done', () => {
    expect(backgroundRunningLabel(backgroundRunning([command('c1')]))).toBe('1 command');
    expect(backgroundRunningLabel(backgroundRunning([command('c1'), command('c2'), command('c3', 'pending')]))).toBe('3 commands');
    expect(backgroundRunningLabel(backgroundRunning([agent('a1'), agent('a2')]))).toBe('2 agents');
    expect(backgroundRunningLabel(backgroundRunning([command('c1', 'completed'), agent('a1', 'stopped')]))).toBe('');
    expect(backgroundRunningLabel(backgroundRunning([]))).toBe('');
  });

  it('falls back to "tasks" when anything is neither a command nor an agent', () => {
    expect(backgroundRunningLabel(backgroundRunning([command('c1'), task({ taskId: 'w', status: 'running', taskType: 'remote_thing' })]))).toBe('2 tasks');
  });
});
