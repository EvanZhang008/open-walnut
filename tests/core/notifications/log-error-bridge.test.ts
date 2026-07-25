/**
 * log-error-bridge — every log.error()/fatal() lands in the notification feed,
 * deduped by stable error identity and storm-throttled by a 60s TTL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-logerr-bridge-'));
process.env.OPEN_WALNUT_HOME = testHome;

const { installLogErrorNotifications, uninstallLogErrorNotifications } =
  await import('../../../src/core/notifications/log-error-bridge.js');
const { listNotifications, dismissNotifications } =
  await import('../../../src/core/notifications/store.js');
const { createSubsystemLogger } = await import('../../../src/logging/index.js');

/** The bridge persists async (fire-and-forget) — poll until the feed has at
 *  least `count` entries (or give up and return whatever settled). */
async function feedAfterCount(
  count = 1,
): Promise<Awaited<ReturnType<typeof listNotifications>>['feed']> {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 25));
    const { feed } = await listNotifications();
    if (feed.length >= count) return feed;
  }
  return (await listNotifications()).feed;
}
const feedAfterFlush = () => feedAfterCount(1);

describe('log-error → notification bridge', () => {
  beforeEach(async () => {
    await dismissNotifications(); // clear feed
    installLogErrorNotifications();
  });

  afterEach(() => {
    uninstallLogErrorNotifications();
    vi.useRealTimers();
  });

  it('a log.error lands in the feed as an operation-error', async () => {
    const logger = createSubsystemLogger('bridge-test');
    logger.error('push totally failed', { taskId: 't-123' });

    const feed = await feedAfterFlush();
    expect(feed).toHaveLength(1);
    expect(feed[0].kind).toBe('operation-error');
    expect(feed[0].severity).toBe('error');
    expect(feed[0].title).toBe('push totally failed');
    expect(feed[0].taskId).toBe('t-123');
    expect(feed[0].dedupKey).toMatch(/^logerr:bridge-test:/);
  });

  it('repeats of the same error collapse into one feed entry', async () => {
    const logger = createSubsystemLogger('bridge-test');
    for (let i = 0; i < 25; i++) logger.error('same error every tick', { attempt: i });

    const feed = await feedAfterFlush();
    expect(feed).toHaveLength(1);
  });

  it('keeps different underlying errors separate when the log title is reused', async () => {
    const logger = createSubsystemLogger('bridge-test');
    logger.error('chat turn error', { agentId: 'general', error: 'provider unavailable' });
    logger.error('chat turn error', { agentId: 'general', error: 'request rate limited' });

    const feed = await feedAfterCount(2);
    expect(feed).toHaveLength(2);
    expect(new Set(feed.map((entry) => entry.dedupKey))).toHaveProperty('size', 2);
  });

  it('warn/info never reach the feed', async () => {
    const logger = createSubsystemLogger('bridge-test');
    logger.warn('just a warning');
    logger.info('just info');

    await new Promise(r => setTimeout(r, 150));
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('skipNotify meta opts a log.error out of the bridge', async () => {
    const logger = createSubsystemLogger('bridge-test');
    logger.error('hand-published elsewhere', { skipNotify: true });

    await new Promise(r => setTimeout(r, 150));
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('notif-subsystem errors are excluded (no self-loop)', async () => {
    const logger = createSubsystemLogger('notif');
    logger.error('store write failed');

    await new Promise(r => setTimeout(r, 150));
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('uninstall stops forwarding', async () => {
    uninstallLogErrorNotifications();
    const logger = createSubsystemLogger('bridge-test');
    logger.error('after uninstall');

    await new Promise(r => setTimeout(r, 150));
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('sink exceptions never break the logger', async () => {
    const { setErrorNotificationSink } = await import('../../../src/logging/subsystem.js');
    setErrorNotificationSink(() => { throw new Error('sink exploded'); });
    const logger = createSubsystemLogger('bridge-test');
    expect(() => logger.error('boom')).not.toThrow();
  });
});
