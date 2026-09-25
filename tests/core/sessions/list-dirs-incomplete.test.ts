/**
 * The folder picker's remote listing when some entries did not answer (fs.ls
 * `partial`: a link into a hung mount). The answer says so in one line, and it
 * is never cached: the entries that timed out may be directories, and the next
 * ask may find the mount awake again.
 *
 * The daemon connection and the config are stubbed; no host is dialled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const replies: Array<Record<string, unknown>> = [];
const asked: string[] = [];
const fakeConn = {
  send: async (_cmd: string, params: Record<string, unknown>) => {
    asked.push(String(params.path));
    return replies.shift() ?? { ok: true, entries: [] };
  },
};

vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.test', label: 'Dev box' } } }),
}));
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDaemonConnection: async () => fakeConn,
  getDaemonConnectState: () => ({ host: 'devbox', connected: true, phase: 'connected', phaseElapsedMs: 0, connectElapsedMs: 0 }),
}));

const { listSessionDirs } = await import('../../../src/core/sessions/session-extras.js');

beforeEach(() => { replies.length = 0; asked.length = 0; });

describe('listSessionDirs: a partial remote listing', () => {
  it('says how many entries did not answer, and is re-asked next time instead of served from cache', async () => {
    const partial = { ok: true, resolvedPath: '/home/me', partial: true, timedOut: 1, entries: [
      { name: 'nas', type: 'unknown', symlink: true, timedOut: true },
      { name: 'src', type: 'dir' },
    ] };
    replies.push(partial);
    const first = await listSessionDirs('/home/me/', 'devbox', 1);
    expect(first.dirs).toEqual(['/home/me/src']);
    expect(first.incomplete).toEqual({ unanswered: 1, message: 'listing incomplete: 1 entry did not answer' });

    replies.push({ ...partial, timedOut: 2 });
    const second = await listSessionDirs('/home/me/', 'devbox', 1);
    expect(second.cached).toBeUndefined();
    expect(second.incomplete?.message).toBe('listing incomplete: 2 entries did not answer');
    expect(asked).toEqual(['/home/me/', '/home/me/']);
  });

  it('a complete listing is cached as before', async () => {
    replies.push({ ok: true, resolvedPath: '/srv', entries: [{ name: 'app', type: 'dir' }] });
    const first = await listSessionDirs('/srv/', 'devbox', 1);
    expect(first.incomplete).toBeUndefined();
    const again = await listSessionDirs('/srv/', 'devbox', 1);
    expect(again.cached).toBe(true);
    expect(asked).toEqual(['/srv/']);
  });
});
