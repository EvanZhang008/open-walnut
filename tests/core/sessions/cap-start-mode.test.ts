import { describe, expect, it, vi } from 'vitest';

// The caller is the only input capStartMode reads: a fake session tracker stands in for it.
const records: Record<string, { mode?: string; taskId: string }> = {
  'sid-default': { mode: 'default', taskId: 't1' },
  'sid-auto': { mode: 'auto', taskId: 't2' },
  'sid-bypass': { mode: 'bypass', taskId: 't3' },
  'sid-legacy': { taskId: 't4' },
};
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({
  resolveCaller: async (sid?: string) => {
    if (!sid) return { kind: 'human' };
    if (sid === 'plugin:demo') return { kind: 'external', app: 'demo' };
    const record = records[sid];
    return record ? { kind: 'session', record } : { kind: 'external' };
  },
}));

const { capStartMode } = await import('../../../src/core/sessions/delegated-mode.js');
const { QuickStartError } = await import('../../../src/core/sessions/quick-start.js');

describe('capStartMode: a session starts work at most as loose as itself', () => {
  it('the person and an installed plugin are not capped', async () => {
    expect(await capStartMode(undefined, 'bypass')).toBe('bypass');
    expect(await capStartMode('plugin:demo', 'bypass')).toBe('bypass');
  });
  it('a looser mode a session asks for is refused with a 403', async () => {
    const err = await capStartMode('sid-default', 'bypass').catch(e => e);
    expect(err).toBeInstanceOf(QuickStartError);
    expect(err.statusCode).toBe(403);
    await expect(capStartMode('sid-auto', 'bypass')).rejects.toThrow('cannot start a task');
    await expect(capStartMode('sid-legacy', 'auto')).rejects.toThrow('cannot start a task');
  });
  it('an unknown sid reads as Default', async () => {
    await expect(capStartMode('sid-gone', 'auto')).rejects.toThrow('cannot start a task');
    expect(await capStartMode('sid-gone')).toBe('default');
  });
  it('no mode asked inherits the caller\'s; a stricter one is kept', async () => {
    expect(await capStartMode('sid-auto')).toBe('auto');
    expect(await capStartMode('sid-auto', 'plan')).toBe('plan');
    expect(await capStartMode('sid-bypass', 'auto')).toBe('auto');
  });
  it('an implied looser mode (a project default) comes down to the caller\'s', async () => {
    expect(await capStartMode('sid-default', 'bypass', { implied: true })).toBe('default');
    expect(await capStartMode('sid-auto', 'plan', { implied: true })).toBe('plan');
    expect(await capStartMode('sid-bypass', 'bypass', { implied: true })).toBe('bypass');
  });
});

// A session sid its host's daemon could not prove (src/lib/caller-unproven.ts): an outside caller.
const { modeChangeRefusal, startCallerOf, UNPROVEN_NOTE } = await import('../../../src/core/sessions/delegated-mode.js');
describe('capStartMode: an unproven caller is capped as an outside caller', () => {
  it('a bypass session\'s sid, unproven, gets the default ceiling', async () => {
    expect(await startCallerOf('sid-bypass', { unproven: true })).toEqual({ kind: 'external' });
    const err = await capStartMode('sid-bypass', 'bypass', { unproven: true }).catch(e => e);
    expect(err).toBeInstanceOf(QuickStartError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain('cannot start a task in bypass mode');
    expect(err.message).toContain(UNPROVEN_NOTE);
    await expect(capStartMode('sid-bypass', 'auto', { unproven: true })).rejects.toThrow('cannot start a task');
  });
  it('no mode asked takes default, not the claimed session\'s; an implied looser one comes down', async () => {
    expect(await capStartMode('sid-bypass', undefined, { unproven: true })).toBe('default');
    expect(await capStartMode('sid-bypass', 'bypass', { implied: true, unproven: true })).toBe('default');
    expect(await capStartMode('sid-bypass', 'plan', { unproven: true })).toBe('plan');
  });
  it('the mark wins over every other word: no sid, a plugin\'s sid, a vouched job', async () => {
    await expect(capStartMode(undefined, 'bypass', { unproven: true })).rejects.toThrow('cannot start a task');
    await expect(capStartMode('plugin:demo', 'bypass', { unproven: true })).rejects.toThrow('cannot start a task');
    const job = { plugin: 'p', job: 'j', host: 'h' };
    expect(await capStartMode('external', 'bypass', { job })).toBe('bypass');
    await expect(capStartMode('external', 'bypass', { job, unproven: true })).rejects.toThrow('cannot start a task');
  });
  it('without the mark nothing changes', async () => {
    expect(await capStartMode('sid-bypass', 'bypass', { unproven: false })).toBe('bypass');
    // A bypass caller naming no mode leaves it unnamed (the start's own default stands).
    expect(await capStartMode('sid-bypass')).toBeUndefined();
  });
  it('a live mode change by an unproven caller is capped the same', async () => {
    expect(await modeChangeRefusal('sid-bypass', 'bypass')).toBeNull();
    const refused = await modeChangeRefusal('sid-bypass', 'bypass', { unproven: true });
    expect(refused).toContain('cannot set a session to bypass mode');
    expect(await modeChangeRefusal('sid-bypass', 'default', { unproven: true })).toBeNull();
    expect(await modeChangeRefusal(undefined, 'bypass', { unproven: true })).toContain('cannot set a session to');
  });
});
