/**
 * A session's cost is read on its host on the request path (GET /api/sessions/:id/cost), and every
 * session panel warms it when it mounts and after each turn. So it answers within the request-path
 * bound (core/hosts/remote-read-bound.ts) like the panel's other host reads: a companion that went
 * silent answers "Reconnecting to Cloud" in seconds. Before, the read waited out its own 25 s
 * deadline and pinned a browser connection (cloud-host-silent-link.spec.ts caught the warm-up
 * still held 9 s after the link went quiet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cost-bound'));

const link = vi.hoisted(() => ({ alive: true, reply: null as null | (() => Promise<unknown>) }));

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => ({ claudeSessionId: sid, host: '__cloudbox__', engine: 'claude', cwd: '/work/alpha' }),
}));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }));
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    readSessionCost() { return link.reply ? link.reply() : new Promise(() => {}); }
  },
}));
// The pool, connected; `alive` is what a liveness probe hears.
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  daemonConnectWouldWait: () => 'connected',
  probeDaemonLiveness: async () => link.alive,
  daemonHeardBytes: () => 0,
  daemonLinkSilent: () => false,
  daemonRoundTripMs: () => 0,
  waitDaemonHandover: async () => false,
  getDaemonConnectState: () => undefined,
}));

import { readSessionScan } from '../../../src/core/usage/session-cost.js';
import { setHostReadBoundsForTest } from '../../../src/core/hosts/remote-read-bound.js';
import { resetPriceBookForTests } from '../../../src/core/usage/price-book.js';

describe('session cost read on a remote host', () => {
  beforeEach(() => {
    resetPriceBookForTests({ source: 'litellm', url: '', fetchedAt: '2026-10-20T00:00:00.000Z', models: {} });
    setHostReadBoundsForTest({ quietMs: 50, probeMs: 50 });
    link.alive = true;
    link.reply = null;
  });
  afterEach(() => {
    setHostReadBoundsForTest(null);
    resetPriceBookForTests();
  });

  it('a link that went silent answers unavailable in the host\'s name, without waiting out the deadline', async () => {
    // Load the read's lazy imports first, so the clock below times the read alone.
    link.reply = async () => null;
    await readSessionScan('s-warm');
    link.reply = null;
    link.alive = false;
    const t0 = Date.now();
    const read = await readSessionScan('s-silent');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.payload.status).toBe('unavailable');
    expect(read.payload.reason).toMatch(/^(Reconnecting to Cloud|Cloud is not answering)/);
  });

  it('a link that answers keeps the read and returns its scan', async () => {
    const scan = { engine: 'claude', sessionId: 's-ok', source: 'claude-transcript', found: true, files: 1, buckets: [], scanMs: 1 };
    link.reply = () => new Promise((resolve) => setTimeout(() => resolve(scan), 200));
    const read = await readSessionScan('s-ok');
    expect(read).toMatchObject({ ok: true, scan });
  });
});
