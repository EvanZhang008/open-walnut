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
