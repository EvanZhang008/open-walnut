import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hostFix, systemFix } = vi.hoisted(() => ({ hostFix: vi.fn(), systemFix: vi.fn() }));
vi.mock('@/api/notifications', () => ({ startHostFix: hostFix, startSystemFix: systemFix }));
import { __resetHostFixStoreForTests, getHostFixSnapshot, runHostFix, subscribeHostFix } from '../../web/src/utils/host-fix-store';

beforeEach(() => { __resetHostFixStoreForTests(); hostFix.mockReset(); systemFix.mockReset(); });
describe('shared repair actions', () => {
  it('sends all credential-group hosts in one request and deduplicates identical targets across surfaces', async () => {
    let finish!: (value: unknown) => void;
    hostFix.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const listener = vi.fn();
    const stop = subscribeHostFix(listener);
    const pending = runHostFix({ host: ['alpha', 'beta'] });
    expect(getHostFixSnapshot({ host: 'alpha' }).pending).toBe(false);
    expect(getHostFixSnapshot({ host: ['beta', 'alpha'] }).pending).toBe(true);
    await runHostFix({ host: ['beta', 'alpha'] });
    expect(hostFix).toHaveBeenCalledExactlyOnceWith(['alpha', 'beta']);
    systemFix.mockResolvedValue({ taskId: 'backup-task', reused: false });
    await runHostFix({ system: 'backup' });
    finish({ taskId: 'repair-task', sessionId: 'repair-session', reused: true });
    expect(await pending).toMatchObject({ sessionId: 'repair-session', reused: true });
    expect(getHostFixSnapshot({ host: 'beta' })).toEqual({ pending: false, error: null });
    hostFix.mockResolvedValue({ taskId: 'single-host-repair', reused: false });
    await runHostFix({ host: 'beta' });
    expect(hostFix).toHaveBeenLastCalledWith('beta');
    expect(listener).toHaveBeenCalledTimes(6);
    stop();
  });
  it('retains inline failure and permits a real retry without marking the host healthy', async () => {
    hostFix.mockRejectedValueOnce(new Error('This host is already healthy.'));
    await runHostFix({ host: '__local__' });
    expect(getHostFixSnapshot({ host: '__local__' })).toEqual({ pending: false, error: 'This host is already healthy.' });
    hostFix.mockResolvedValueOnce({ taskId: 'local-repair', reused: false });
    await runHostFix({ host: '__local__' });
    expect(getHostFixSnapshot({ host: '__local__' }).error).toBeNull();
    expect(hostFix).toHaveBeenCalledTimes(2);
  });
  it('does not attribute a single-host failure to a different group', async () => {
    hostFix.mockRejectedValueOnce(new Error('Alpha failed.'));
    await runHostFix({ host: 'alpha' });
    expect(getHostFixSnapshot({ host: ['alpha', 'beta'] }).error).toBeNull();
    expect(getHostFixSnapshot({ host: 'beta' }).error).toBeNull();
    expect(getHostFixSnapshot({ host: 'alpha' }).error).toBe('Alpha failed.');
  });
  it.each(['backup', 'search'] as const)('shares %s pending and rejects invalid repair results', async (system) => {
    let finish!: (value: unknown) => void;
    systemFix.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = runHostFix({ system });
    await runHostFix({ system });
    expect(systemFix).toHaveBeenCalledExactlyOnceWith(system);
    finish({ reused: false });
    await pending;
    expect(getHostFixSnapshot({ system })).toMatchObject({ pending: false, error: 'The repair did not return a valid task. Try again.' });
    systemFix.mockResolvedValue({ taskId: 'system-repair', reused: true });
    expect(await runHostFix({ system })).toMatchObject({ taskId: 'system-repair' });
  });
});
