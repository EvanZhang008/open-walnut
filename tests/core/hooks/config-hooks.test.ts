/**
 * Unit tests for config-declared hooks (core/hooks/config-hooks.ts).
 */

import { describe, it, expect } from 'vitest';
import { loadConfigHooks, mergedOverrides } from '../../../src/core/hooks/config-hooks.js';
import type { Config } from '../../../src/core/types.js';

function cfg(hooks: Config['hooks'], session_hooks?: Config['session_hooks']): Config {
  return { hooks, session_hooks } as Config;
}

describe('loadConfigHooks', () => {
  it('parses a valid def', () => {
    const result = loadConfigHooks(cfg({
      defs: [{
        id: 'notify-on-complete',
        name: 'Notify on complete',
        on: ['onTaskCompleted'],
        action: { type: 'notify', message: '{{task.title}} done' },
        priority: 50,
      }],
    }));

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('notify-on-complete');
    expect(result[0].hooks).toEqual(['onTaskCompleted']);
    expect(result[0].source).toBe('config');
    expect(result[0].priority).toBe(50);
  });

  it('drops malformed defs but keeps valid ones', () => {
    const result = loadConfigHooks(cfg({
      defs: [
        { id: 'no-action', on: ['onTaskCompleted'] } as never,
        { id: 'bad-point', on: ['onWarpDrive'], action: { type: 'log' } },
        { id: 'bad-action-type', on: ['onTaskCompleted'], action: { type: 'shell_command', command: 'rm -rf /' } },
        { id: 'msg-missing', on: ['onTaskCompleted'], action: { type: 'notify' } },
        { id: 'agent-missing', on: ['onTaskCompleted'], action: { type: 'run_agent' } },
        { id: 'good', on: ['onTaskCompleted'], action: { type: 'log' } },
      ],
    }));

    expect(result.map(h => h.id)).toEqual(['good']);
  });

  it('never surfaces a predicate from config (filter passes declarative fields only)', () => {
    const result = loadConfigHooks(cfg({
      defs: [{
        id: 'sneaky',
        on: ['onTaskPhaseChanged'],
        action: { type: 'log' },
        filter: { phases: ['COMPLETE'], predicate: 'return true' } as never,
      }],
    }));

    expect(result).toHaveLength(1);
    expect(result[0].filter?.phases).toEqual(['COMPLETE']);
    expect(result[0].filter?.predicate).toBeUndefined();
  });

  it('empty / absent defs → empty list', () => {
    expect(loadConfigHooks(cfg(undefined))).toEqual([]);
    expect(loadConfigHooks(cfg({ defs: [] }))).toEqual([]);
  });
});

describe('mergedOverrides', () => {
  it('legacy session_hooks.overrides merges under hooks.overrides (new wins)', () => {
    const merged = mergedOverrides(cfg(
      { overrides: { 'turn-complete-triage': { enabled: true } } },
      { overrides: { 'turn-complete-triage': { enabled: false }, 'session-auto-title': { priority: 10 } } },
    ));

    expect(merged['turn-complete-triage']).toEqual({ enabled: true });
    expect(merged['session-auto-title']).toEqual({ priority: 10 });
  });

  it('legacy session_hooks.hooks array stays inert (not returned anywhere)', () => {
    const merged = mergedOverrides(cfg(
      undefined,
      { hooks: [{ id: 'forgotten-subagent', name: 'x', hooks: ['onTurnComplete'], agentId: 'a' }] },
    ));
    expect(Object.keys(merged)).toEqual([]);
  });
});
