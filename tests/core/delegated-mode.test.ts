import { describe, expect, it } from 'vitest';
import { applyStartModeCeiling, delegatedMode, startModeCeiling, type StartCaller } from '../../src/core/sessions/delegated-mode.js';
import { SESSION_MODE_IDS } from '../../src/core/types.js';
describe('preapproved task creation preserves caller permissions', () => {
  it.each(SESSION_MODE_IDS)('an implicit child inherits %s', mode => {
    expect(delegatedMode(mode)).toBe(mode === 'bypass' ? undefined : mode);
  });
  it.each(['plan', 'default', 'dontAsk', 'accept', 'auto'] as const)('%s cannot create a bypass child', mode => {
    expect(() => delegatedMode(mode, 'bypass')).toThrow('cannot start a task');
  });
  it('a legacy caller with no recorded mode cannot grant bypass', () => {
    expect(() => delegatedMode(undefined as never, 'bypass')).toThrow('cannot start a task');
  });
  it('Auto can delegate Auto and stricter work; Bypass retains current behavior', () => {
    expect(delegatedMode('auto', 'auto')).toBe('auto');
    expect(delegatedMode('auto', 'plan')).toBe('plan');
    expect(delegatedMode('bypass', 'auto')).toBe('auto');
  });
});

describe('the start-mode ceiling, as a pure function of who asks', () => {
  const job = { kind: 'plugin-job', plugin: 'ticket-investigator', job: 'poll', host: 'devbox' } as const;
  it.each([
    [{ kind: 'person' }, null],
    [{ kind: 'plugin' }, null],
    [job, null],
    [{ kind: 'session', mode: 'plan' }, 'plan'],
    [{ kind: 'session', mode: 'auto' }, 'auto'],
    [{ kind: 'session', mode: 'bypass' }, 'bypass'],
    [{ kind: 'session', mode: undefined }, 'default'],
    [{ kind: 'session', mode: 'retired-mode' as never }, 'default'],
    [{ kind: 'external' }, 'default'],
  ] as Array<[StartCaller, string | null]>)('%j has ceiling %s', (caller, ceiling) => {
    expect(startModeCeiling(caller)).toBe(ceiling);
  });

  it.each([
    // [caller, requested, implied, result | 'throws']
    [{ kind: 'external' }, 'bypass', false, 'throws'],
    [{ kind: 'external' }, 'bypass', true, 'default'],
    [{ kind: 'external' }, 'plan', false, 'plan'],
    [{ kind: 'external' }, undefined, false, 'default'],
    [{ kind: 'external' }, undefined, true, undefined],
    [job, 'bypass', false, 'bypass'],
    [job, 'bypass', true, 'bypass'],
    [job, undefined, false, undefined],
    [{ kind: 'plugin' }, 'bypass', false, 'bypass'],
    [{ kind: 'person' }, 'bypass', false, 'bypass'],
    [{ kind: 'session', mode: 'auto' }, 'bypass', false, 'throws'],
    [{ kind: 'session', mode: 'auto' }, 'bypass', true, 'auto'],
    [{ kind: 'session', mode: 'auto' }, 'plan', false, 'plan'],
    [{ kind: 'session', mode: 'auto' }, undefined, false, 'auto'],
    [{ kind: 'session', mode: 'bypass' }, 'bypass', false, 'bypass'],
    [{ kind: 'session', mode: 'bypass' }, undefined, false, undefined],
  ] as Array<[StartCaller, string | undefined, boolean, string | undefined]>)('%j asking %s (implied %s) gets %s', (caller, requested, implied, want) => {
    if (want === 'throws') {
      expect(() => applyStartModeCeiling(caller, requested, { implied })).toThrow(`cannot start a task in ${requested} mode`);
    } else {
      expect(applyStartModeCeiling(caller, requested, { implied })).toBe(want);
    }
  });

  it('the anonymous caller\'s refusal keeps its exact words', () => {
    expect(() => applyStartModeCeiling({ kind: 'external' }, 'bypass'))
      .toThrow('A default session cannot start a task in bypass mode. Change the caller\'s mode first.');
  });
});
