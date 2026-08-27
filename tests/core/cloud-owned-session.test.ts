/**
 * Cloud-owned session lookup — "does THIS companion own this session?"
 *
 * The ordering rule is the point: own-registry BEFORE projection. Getting it
 * wrong in either direction is a real bug (see src/core/cloud-owned-session.ts),
 * and the default relay-only box must pay nothing for the check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const trackerMock = vi.hoisted(() => ({ getSessionByClaudeId: vi.fn() }));
const configMock = vi.hoisted(() => ({ getConfig: vi.fn() }));
const constantsMock = vi.hoisted(() => ({ cloudMode: true }));

vi.mock('../../src/core/session-tracker.js', () => trackerMock);
vi.mock('../../src/core/config-manager.js', () => configMock);
vi.mock('../../src/constants.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  get CLOUD_MODE() { return constantsMock.cloudMode; },
}));

const EXEC_ON = { cloud: { exec: { enabled: true, cwd_roots: ['/srv/work'] } } };

async function load() {
  vi.resetModules();
  const mod = await import('../../src/core/cloud-owned-session.js');
  mod.resetCloudExecCache();
  return mod;
}

beforeEach(() => {
  constantsMock.cloudMode = true;
  configMock.getConfig.mockResolvedValue(EXEC_ON);
  trackerMock.getSessionByClaudeId.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('cloudExecActive gate', () => {
  it('is false on the primary box and never reads config there', async () => {
    constantsMock.cloudMode = false;
    const { cloudExecActive } = await load();
    expect(await cloudExecActive()).toBe(false);
    // Cheap gate: a primary box must not pay a config read per session request.
    expect(configMock.getConfig).not.toHaveBeenCalled();
  });

  it('is false on a relay-only companion (default config)', async () => {
    configMock.getConfig.mockResolvedValue({});
    const { cloudExecActive } = await load();
    expect(await cloudExecActive()).toBe(false);
  });

  it('is true when cloud.exec is configured', async () => {
    const { cloudExecActive } = await load();
    expect(await cloudExecActive()).toBe(true);
  });

  it('fails CLOSED when config is unreadable — never claims to own the Mac\'s sessions', async () => {
    configMock.getConfig.mockRejectedValue(new Error('boom'));
    const { cloudExecActive } = await load();
    expect(await cloudExecActive()).toBe(false);
  });

  it('caches the answer — the gate is on every session request', async () => {
    const { cloudExecActive } = await load();
    await cloudExecActive();
    await cloudExecActive();
    await cloudExecActive();
    expect(configMock.getConfig).toHaveBeenCalledTimes(1);
  });
});

describe('cloudOwnedSession', () => {
  it('returns null without touching the registry when exec is off', async () => {
    configMock.getConfig.mockResolvedValue({});
    const { cloudOwnedSession } = await load();
    expect(await cloudOwnedSession('sid-1')).toBeNull();
    expect(trackerMock.getSessionByClaudeId).not.toHaveBeenCalled();
  });

  it('returns the record for a host-less (locally spawned) session', async () => {
    trackerMock.getSessionByClaudeId.mockResolvedValue({
      claudeSessionId: 'sid-1', cwd: '/srv/work/p', model: 'opus', process_status: 'running',
    });
    const { cloudOwnedSession } = await load();
    expect(await cloudOwnedSession('sid-1')).toEqual({
      sessionId: 'sid-1', cwd: '/srv/work/p', model: 'opus', processStatus: 'running',
    });
  });

  it('returns null for an unknown session — it belongs to the projection/relay path', async () => {
    trackerMock.getSessionByClaudeId.mockResolvedValue(null);
    const { cloudOwnedSession } = await load();
    expect(await cloudOwnedSession('sid-mac')).toBeNull();
  });

  it('returns null for a record carrying a HOST — that CLI is not on this box', async () => {
    trackerMock.getSessionByClaudeId.mockResolvedValue({
      claudeSessionId: 'sid-2', host: 'devbox', process_status: 'running',
    });
    const { cloudOwnedSession } = await load();
    expect(await cloudOwnedSession('sid-2')).toBeNull();
  });

  it('degrades to the relay path on a lookup failure instead of throwing', async () => {
    // A read-only endpoint the phone polls must not 500 because a DB read blipped.
    trackerMock.getSessionByClaudeId.mockRejectedValue(new Error('db locked'));
    const { cloudOwnedSession } = await load();
    expect(await cloudOwnedSession('sid-3')).toBeNull();
  });

  it('reports the cloud host alias, not the record\'s stored empty host', async () => {
    const { cloudOwnedHostAlias } = await load();
    const { CLOUD_HOST_ALIAS } = await import('../../src/core/cloud-exec.js');
    expect(cloudOwnedHostAlias).toBe(CLOUD_HOST_ALIAS);
    expect(cloudOwnedHostAlias).not.toBe('');
    expect(cloudOwnedHostAlias).not.toBe('__local__');
  });
});
