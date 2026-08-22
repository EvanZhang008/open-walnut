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

const { installLogErrorNotifications, uninstallLogErrorNotifications, recoveryKeyOf } =
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

  it('a repeat INSIDE the TTL window never reaches the store, so nothing is broadcast', async () => {
    const events: string[] = [];
    uninstallLogErrorNotifications();
    installLogErrorNotifications((name) => { events.push(name); });

    const logger = createSubsystemLogger('bridge-test');
    logger.error('storming error', { error: 'same cause' });
    await feedAfterFlush();
    for (let i = 0; i < 10; i++) logger.error('storming error', { error: 'same cause' });
    await new Promise(r => setTimeout(r, 200));

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].count).toBeUndefined(); // suppressed repeats are not counted
    expect(events).toEqual(['notification:new']);
  });

  it('a repeat AFTER the TTL expires refreshes the record and broadcasts notification:updated', async () => {
    const events: Array<{ name: string; count?: number; body?: string }> = [];
    uninstallLogErrorNotifications();
    installLogErrorNotifications((name, data) => {
      const record = data as { count?: number; body?: string };
      events.push({ name, count: record.count, body: record.body });
    });

    const logger = createSubsystemLogger('bridge-test');
    logger.error('flaky sync failed', { error: 'timeout' });
    await feedAfterFlush();

    // The TTL map is a broadcast-storm guard only; past the window the same
    // error must fold into the existing record instead of creating a new card.
    // Shift the clock (not the timers — the awaits below need real ones).
    const realNow = Date.now;
    const shift = 61_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    try {
      logger.error('flaky sync failed', { error: 'timeout' });
      await new Promise(r => setTimeout(r, 200));
    } finally {
      nowSpy.mockRestore();
    }

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].count).toBe(2);
    expect(events.map(e => e.name)).toEqual(['notification:new', 'notification:updated']);
    expect(events[1].count).toBe(2);
  });

  it('sink exceptions never break the logger', async () => {
    const { setErrorNotificationSink } = await import('../../../src/logging/subsystem.js');
    setErrorNotificationSink(() => { throw new Error('sink exploded'); });
    const logger = createSubsystemLogger('bridge-test');
    expect(() => logger.error('boom')).not.toThrow();
  });
});

/**
 * recoveryKey derivation — what lets a wall of red retire when the thing it
 * described starts working again. Tested through the pure helper (the sink path
 * is covered end-to-end in tests/e2e/notifications.test.ts).
 */
describe('recoveryKeyOf', () => {
  it('prefers an explicit meta.recoveryKey over everything else', () => {
    expect(recoveryKeyOf({
      subsystem: 'web', message: 'x', meta: { recoveryKey: 'backup', pluginId: 'plugin-a' },
    })).toBe('backup');
    // Blank/non-string is not an override — fall through to the next rule.
    expect(recoveryKeyOf({ subsystem: 'web', message: 'x', meta: { recoveryKey: '  ' } })).toBeUndefined();
    expect(recoveryKeyOf({ subsystem: 'web', message: 'x', meta: { recoveryKey: 7 } })).toBeUndefined();
  });

  it('maps meta.pluginId to plugin:<id>, even from a core subsystem', () => {
    // This is the case that matters most: the sync poll loop logs under 'web'
    // (core), so pluginId is the ONLY thing that gives those records a lifecycle.
    expect(recoveryKeyOf({
      subsystem: 'web', message: 'sync failing repeatedly', meta: { pluginId: 'plugin-a' },
    })).toBe('plugin:plugin-a');
  });

  it('treats a non-core subsystem ROOT as a plugin', () => {
    // A plugin's own logger and its sub-loggers all collapse onto one key, so
    // the whole wall retires together on the next successful sync.
    expect(recoveryKeyOf({ subsystem: 'plugin-a', message: 'x' })).toBe('plugin:plugin-a');
    expect(recoveryKeyOf({ subsystem: 'plugin-a/http', message: 'x' })).toBe('plugin:plugin-a');
    expect(recoveryKeyOf({ subsystem: 'plugin-a/http/retry', message: 'x' })).toBe('plugin:plugin-a');
    // integration-loader's per-plugin logger names the id one segment deeper.
    expect(recoveryKeyOf({ subsystem: 'plugin/plugin-a', message: 'x' })).toBe('plugin:plugin-a');
  });

  it('gives CORE subsystems no recoveryKey (this iteration)', () => {
    // A core failure has no single success point that proves it recovered, so
    // these records keep today's behavior: they stay until dismissed.
    for (const core of ['web', 'session', 'task', 'bus', 'ws', 'git', 'memory', 'agent',
      'cron', 'daemon', 'notif', 'obs', 'audio', 'heartbeat', 'subagent',
      'plugin-loader', 'plugin-sources']) {
      expect(recoveryKeyOf({ subsystem: core, message: 'x' })).toBeUndefined();
      // A sub-logger of a core subsystem is still core.
      expect(recoveryKeyOf({ subsystem: `${core}/inner`, message: 'x' })).toBeUndefined();
    }
    // 'plugin' alone (no id) is not attributable to any one plugin.
    expect(recoveryKeyOf({ subsystem: 'plugin', message: 'x' })).toBeUndefined();
  });

  it('does not pollute the dedup hash — tagging a record cannot split its card', async () => {
    // recoveryKey rides in log meta, and meta feeds the dedup fingerprint. If it
    // leaked in, the SAME failure logged with and without a key would land as two
    // near-identical cards.
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications();
    const logger = createSubsystemLogger('bridge-hash-test');
    logger.error('identical failure', { error: 'same cause' });
    const first = await feedAfterFlush();
    const keyWithout = first[0].dedupKey;

    // Same body, now tagged. Shift the clock past the storm absorber so the
    // second call actually reaches the store.
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
    try {
      logger.error('identical failure', { error: 'same cause', recoveryKey: 'plugin:plugin-a' });
      await new Promise(r => setTimeout(r, 200));
    } finally {
      nowSpy.mockRestore();
    }

    const { feed } = await listNotifications();
    // ONE card that folded, not two.
    expect(feed).toHaveLength(1);
    expect(feed[0].dedupKey).toBe(keyWithout);
    expect(feed[0].count).toBe(2);
    // The tag landed on the record…
    expect(feed[0].recoveryKey).toBe('plugin:plugin-a');
    // …but never into the human-facing body (it is plumbing, not context).
    expect(feed[0].body ?? '').not.toContain('recoveryKey');
  });
});
