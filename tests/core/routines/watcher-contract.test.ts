/**
 * Watcher contract: the prompt carries what the run needs, and the run summary
 * reports what the TOOLS did rather than what the model said it did.
 */
import { describe, it, expect } from 'vitest';
import {
  WATCHER_SYSTEM_PROMPT, buildWatcherUserMessage, summarizeWatcherRun,
} from '../../../src/core/routines/watcher-contract.js';
import { READ_ONLY_TOOL_NAMES } from '../../../src/core/tools/read-only.js';

const base = {
  instructions: 'Check unread mail. Task anything needing my reply. Ignore newsletters.',
  notes: '',
  budget: { outcomesPerRun: 3, sessionsPerDay: 2, sessionsUsedToday: 0 },
  dataTools: ['mail_list', 'mail_read'],
  nowIso: '2026-09-10T19:00:00.000Z',
};

describe('WATCHER_SYSTEM_PROMPT', () => {
  it('makes "nothing happened" an explicitly correct outcome', () => {
    expect(WATCHER_SYSTEM_PROMPT).toMatch(/Doing nothing is the normal, correct outcome/);
  });

  it('tells the model the key must come from the source item, not a timestamp', () => {
    expect(WATCHER_SYSTEM_PROMPT).toMatch(/stable "key" derived from the SOURCE item/);
    expect(WATCHER_SYSTEM_PROMPT).toMatch(/Never a timestamp/);
  });

  it('says a refusal is the system working, so it does not retry around it', () => {
    expect(WATCHER_SYSTEM_PROMPT).toMatch(/do not retry with a different key/);
  });
});

describe('the Walnut-side tool pool a watcher may name', () => {
  it('is the fail-closed read-only allowlist, and contains no write tool', () => {
    // A watcher names its tools out of this set, so anything mutating in here
    // would be an unattended write path that skips the outcome budget.
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(name).not.toMatch(/_(create|update|delete|write|send|start|set)\b/);
    }
    expect(READ_ONLY_TOOL_NAMES.has('task_create')).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has('task_list')).toBe(true);
  });
});

describe('buildWatcherUserMessage', () => {
  it('carries the brief, the tools and the budget', () => {
    const msg = buildWatcherUserMessage(base);
    expect(msg).toContain('Ignore newsletters');
    expect(msg).toContain('mail_list, mail_read');
    expect(msg).toContain('3 outcomes this run');
    expect(msg).toContain('2 new sessions left today');
  });

  it('subtracts sessions already started today', () => {
    const msg = buildWatcherUserMessage({
      ...base, budget: { outcomesPerRun: 1, sessionsPerDay: 2, sessionsUsedToday: 2 },
    });
    expect(msg).toContain('1 outcome this run');
    expect(msg).toContain('0 new sessions left today');
  });

  it('includes the previous run note, and says so when there is no previous run', () => {
    expect(buildWatcherUserMessage(base)).toContain('Previous run: none');
    const withNote = buildWatcherUserMessage({
      ...base, notes: 'still waiting on the invoice thread', lastRunIso: '2026-09-10T18:50:00.000Z',
    });
    expect(withNote).toContain('still waiting on the invoice thread');
    expect(withNote).toContain('Previous run: 2026-09-10T18:50:00.000Z');
  });

  it('says plainly when it has no data tools, instead of leaving a blank', () => {
    const msg = buildWatcherUserMessage({ ...base, dataTools: [] });
    expect(msg).toMatch(/Data tools available: \(none/);
  });
});

describe('summarizeWatcherRun', () => {
  it('counts real outcomes per tool', () => {
    const summary = summarizeWatcherRun([
      { tool: 'trigger_task', key: 'm1' },
      { tool: 'trigger_task', key: 'm2' },
      { tool: 'trigger_notify', key: 'm3' },
    ], '3 handled');
    expect(summary).toContain('2× task');
    expect(summary).toContain('1× notify');
    expect(summary).toContain('3 handled');
  });

  it('reports no outcomes even when the model claims it created a task', () => {
    // The whole point: a summary built from the model's sentence would lie here.
    const summary = summarizeWatcherRun([], 'Created a task for the invoice email.');
    expect(summary).toMatch(/^no outcomes/);
  });

  it('flags a timeout so a truncated run is not read as a clean one', () => {
    expect(summarizeWatcherRun([], 'looking…', { aborted: true })).toContain('(timed out)');
  });

  it('survives an empty model response', () => {
    expect(summarizeWatcherRun([{ tool: 'trigger_notify', key: 'k' }], '')).toBe('1× notify');
  });

  it('keeps the last line of a chatty answer and caps its length', () => {
    const long = `thinking out loud\n${'y'.repeat(400)}`;
    const summary = summarizeWatcherRun([], long);
    expect(summary.length).toBeLessThan(260);
    expect(summary).not.toContain('thinking out loud');
  });
});
