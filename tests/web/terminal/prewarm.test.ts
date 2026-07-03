import { describe, it, expect, vi, beforeEach } from 'vitest';

// prewarmRemoteHost calls remoteDtachPath() to warm the ssh ControlMaster +
// provision dtach. Mock dtach-provision so we assert behavior without real ssh.
const remoteDtachPath = vi.fn(async (host: string) => `/home/u/.local/bin/walnut-dtach[${host}]`);
const localDtachPath = vi.fn(async () => '/local/walnut-dtach');
vi.mock('../../../src/web/terminal/dtach-provision.js', () => ({
  remoteDtachPath: (host: string) => remoteDtachPath(host),
  localDtachPath: () => localDtachPath(),
}));

import { prewarmRemoteHost } from '../../../src/web/terminal/spawn.js';

beforeEach(() => {
  remoteDtachPath.mockClear();
  localDtachPath.mockClear();
});

describe('prewarmRemoteHost', () => {
  it('is a no-op for local sessions (no host → no ssh)', async () => {
    await prewarmRemoteHost(undefined);
    expect(remoteDtachPath).not.toHaveBeenCalled();
    expect(localDtachPath).not.toHaveBeenCalled();
  });

  it('warms the ControlMaster + provisions dtach for a remote host', async () => {
    await prewarmRemoteHost('devbox');
    expect(remoteDtachPath).toHaveBeenCalledWith('devbox');
    expect(remoteDtachPath).toHaveBeenCalledTimes(1);
  });

  it('swallows provisioning errors (best-effort; the real open surfaces them)', async () => {
    remoteDtachPath.mockRejectedValueOnce(new Error('ssh down'));
    // Must NOT throw — prewarm is fire-and-forget.
    await expect(prewarmRemoteHost('devbox')).resolves.toBeUndefined();
  });

  it('is idempotent-friendly: relies on remoteDtachPath memoization (called per invocation)', async () => {
    await prewarmRemoteHost('devbox');
    await prewarmRemoteHost('devbox');
    // prewarm itself does not cache — it delegates to remoteDtachPath, which is
    // memoized in dtach-provision. Two prewarms → two delegations (cheap; the
    // underlying provision is cached).
    expect(remoteDtachPath).toHaveBeenCalledTimes(2);
  });
});
