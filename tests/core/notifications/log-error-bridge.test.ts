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

const {
  installLogErrorNotifications, uninstallLogErrorNotifications, recoveryKeyOf,
  dedupFingerprintForTest,
} = await import('../../../src/core/notifications/log-error-bridge.js');
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
    // Sentence-cased by the humanizer's fallback — the raw log message is a
    // developer's words, and the card gets a title a person can read.
    expect(feed[0].title).toBe('Push totally failed');
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

  it('releaseAbsorbedKeys lets a RE-failure notify fresh inside the TTL window', async () => {
    // A route that 500s → recovers → 500s again seconds later is the common flap,
    // and it happens well inside the bridge's 60s storm absorber. With the
    // absorber still armed, the second failure never reaches the store, so the
    // card sits stamped 'recovered' (green chip, severity info) while the endpoint
    // is broken again. Recovery is exactly the moment suppression stops being
    // correct — for the bridge's own map, not only the server's.
    const { releaseAbsorbedKeys } = await import('../../../src/core/notifications/log-error-bridge.js');
    const events: string[] = [];
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications((name) => { events.push(name); });

    const logger = createSubsystemLogger('bridge-test');
    const meta = { recoveryKey: 'route:GET /api/flappy', error: 'boom' };
    logger.error('GET /api/flappy → 500', meta);
    await feedAfterFlush();
    expect(events).toEqual(['notification:new']);

    // Still absorbed while armed…
    logger.error('GET /api/flappy → 500', meta);
    await new Promise(r => setTimeout(r, 150));
    expect(events).toEqual(['notification:new']);

    // …released by the recovery, so the next failure folds and re-broadcasts.
    releaseAbsorbedKeys(['route:GET /api/flappy']);
    logger.error('GET /api/flappy → 500', meta);
    await new Promise(r => setTimeout(r, 200));
    expect(events).toEqual(['notification:new', 'notification:updated']);
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].count).toBe(2);
  });

  it('releaseAbsorbedKeys only releases the keys it was given', async () => {
    const { releaseAbsorbedKeys } = await import('../../../src/core/notifications/log-error-bridge.js');
    const events: string[] = [];
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications((name) => { events.push(name); });

    const logger = createSubsystemLogger('bridge-test');
    logger.error('other condition failed', { recoveryKey: 'backup', error: 'x' });
    await feedAfterFlush();

    releaseAbsorbedKeys(['route:GET /api/unrelated']);
    logger.error('other condition failed', { recoveryKey: 'backup', error: 'x' });
    await new Promise(r => setTimeout(r, 150));
    // Still absorbed: an unrelated recovery must not un-throttle every error.
    expect(events).toEqual(['notification:new']);
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
    // NB 'session'/'obs' are excluded here — they DO get a key when the log names
    // a session or task (see the session-scope block below); with no ids they
    // fall back to this same no-lifecycle behavior, asserted there.
    for (const core of ['web', 'task', 'bus', 'ws', 'git', 'memory', 'agent',
      'cron', 'daemon', 'notif', 'audio', 'heartbeat', 'subagent',
      'plugin-loader', 'plugin-sources']) {
      expect(recoveryKeyOf({ subsystem: core, message: 'x' })).toBeUndefined();
      // A sub-logger of a core subsystem is still core.
      expect(recoveryKeyOf({ subsystem: `${core}/inner`, message: 'x' })).toBeUndefined();
    }
    // 'plugin' alone (no id) is not attributable to any one plugin.
    expect(recoveryKeyOf({ subsystem: 'plugin', message: 'x' })).toBeUndefined();
  });

  // ── Session-scoped derivation (round 2) ──
  //
  // The live feed's session cards (runtime error, delivery failed, transport
  // start failed, stream-convergence VIOLATION, self-report UNPARSEABLE) all had
  // no key, so none of them could ever retire — even after the very session they
  // were about ran a hundred clean turns, or died. Scoping them to the session
  // gives the whole family both ends of a lifecycle at once: a clean result
  // recovers them, death expires them.

  it('scopes a session-subsystem error to session:<sid>', () => {
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'CLI exited', meta: { sessionId: 'sess-1' },
    })).toBe('session:sess-1');
    // Sub-loggers ride along.
    expect(recoveryKeyOf({
      subsystem: 'session/stream', message: 'x', meta: { sessionId: 'sess-1' },
    })).toBe('session:sess-1');
  });

  it("scopes an 'obs' session diagnostic the same way (stream-convergence VIOLATION)", () => {
    expect(recoveryKeyOf({
      subsystem: 'obs',
      message: 'stream-convergence VIOLATION: streamed message(s) missing from persisted history',
      meta: { sessionId: 'sess-2', missing: ['a'], checked: 3 },
    })).toBe('session:sess-2');
  });

  it('falls back to task:<id> when the log has a taskId but no sessionId', () => {
    // The real shape of 'transport start failed': the session it was trying to
    // start never existed, so there is no session id to key on — only the task.
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'transport start failed',
      meta: { taskId: 'task-9', host: 'clouddev', error: 'ssh: publickey' },
    })).toBe('task:task-9');
  });

  it('prefers the session over the task when the log carries both', () => {
    // A session id is the narrower, more accurate condition: the task may own
    // several sessions, and only THIS one failed.
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'x', meta: { sessionId: 'sess-3', taskId: 'task-3' },
    })).toBe('session:sess-3');
  });

  it('gives a session-family log with NEITHER id no key (nothing to recover against)', () => {
    expect(recoveryKeyOf({ subsystem: 'session', message: 'generic failure' })).toBeUndefined();
    expect(recoveryKeyOf({ subsystem: 'obs', message: 'x', meta: { host: 'mac' } })).toBeUndefined();
    // Blank ids are not ids.
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'x', meta: { sessionId: '  ', taskId: '' },
    })).toBeUndefined();
  });

  it('PRECEDENCE: explicit recoveryKey > pluginId > session scope', () => {
    // A producer that knows best always wins — this is what lets the route
    // middleware and the bus hand the bridge their own condition ids.
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'x',
      meta: { recoveryKey: 'route:GET /api/x', sessionId: 'sess-1', pluginId: 'plugin-a' },
    })).toBe('route:GET /api/x');
    // pluginId beats the session scope: a plugin failing while touching a session
    // is the PLUGIN's condition, and retires when the plugin's sync succeeds.
    expect(recoveryKeyOf({
      subsystem: 'session', message: 'x', meta: { pluginId: 'plugin-a', sessionId: 'sess-1' },
    })).toBe('plugin:plugin-a');
  });

  it('does not give a NON-session subsystem a session scope', () => {
    // 'web' logs sessionId constantly (every session route). Those are route/web
    // conditions, not session conditions — a session's clean turn says nothing
    // about them, so scoping them here would retire cards on the wrong signal
    // (the exact round-1 compaction bug, one layer up).
    expect(recoveryKeyOf({
      subsystem: 'web', message: 'x', meta: { sessionId: 'sess-1' },
    })).toBeUndefined();
    expect(recoveryKeyOf({
      subsystem: 'daemon', message: 'x', meta: { sessionId: 'sess-1' },
    })).toBeUndefined();
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

/**
 * Human copy — the bridge runs every log error through humanize.ts on the way in,
 * so a card carries a readable title, one sentence, and a CATEGORY, while the raw
 * `[subsystem] {json}` line moves to `detail`.
 *
 * The load-bearing invariant in here is the LAST test: card identity (the dedup
 * fingerprint) hashes the RAW message, so rewording copy can never split one
 * failure into two cards or merge two into one.
 */
describe('humanized copy on the way into the feed', () => {
  beforeEach(async () => {
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications();
  });

  afterEach(() => {
    uninstallLogErrorNotifications();
  });

  it('rewrites a known family and keeps the raw line as `detail`', async () => {
    const logger = createSubsystemLogger('session');
    logger.error('transport start failed', {
      taskId: 'mq8c-97e0', host: 'local', cwd: '/data/notes/Gone',
      error: 'ENOENT: no such file or directory',
    });

    const feed = await feedAfterFlush();
    expect(feed[0].title).toBe("Couldn't start a session");
    expect(feed[0].body).toBe('The working folder no longer exists: /data/notes/Gone');
    expect(feed[0].category).toBe('Sessions');
    // The old body — every byte a developer used to read off the card — survives
    // behind the Details toggle instead of being the primary message.
    expect(feed[0].detail).toContain('[session]');
    expect(feed[0].detail).toContain('"cwd":"/data/notes/Gone"');
    // …and the body is no longer a JSON dump.
    expect(feed[0].body).not.toContain('{');
  });

  it('gives an unruled error a readable title and NO json body', async () => {
    const logger = createSubsystemLogger('bridge-test');
    logger.error('weird thing exploded', { holders: [{ pid: 22198 }], dbFile: '/data/x' });

    const feed = await feedAfterFlush();
    expect(feed[0].title).toBe('Weird thing exploded');
    // No prose anywhere to make a sentence from → title-only card, never a dump.
    expect(feed[0].body).toBeUndefined();
    expect(feed[0].detail).toContain('"pid":22198');
  });

  it('derives the category from the recoveryKey the same log call produced', async () => {
    const logger = createSubsystemLogger('web');
    logger.error('GET /api/ui-prefs → 500', {
      reqId: 'a1', recoveryKey: 'route:GET /api/ui-prefs',
    });

    const feed = await feedAfterFlush();
    expect(feed[0].category).toBe('API');
    expect(feed[0].title).toBe('GET /api/ui-prefs → 500');
    expect(feed[0].body).toBe('This API endpoint is failing (HTTP 500).');
  });

  it("groups a plugin's whole family under the plugin's own name", async () => {
    // The user-visible complaint: three failures of one plugin read as three
    // unrelated cards. They now share a category, whatever the log wording.
    const client = createSubsystemLogger('plugin-a/client');
    const sync = createSubsystemLogger('plugin-a/sync');
    client.error('Plugin A API error', { statusCode: 302, operationName: 'TaskCollections' });
    sync.error('failed to push task to the tracker', { error: 'API error (HTTP 400)' });

    const feed = await feedAfterCount(2);
    expect(feed).toHaveLength(2);
    expect(new Set(feed.map(n => n.category))).toEqual(new Set(['Plugin A']));
    // Neither body is the JSON wrapper.
    for (const n of feed) expect(n.body ?? '').not.toContain('{');
  });

  it('redacts a secret before any rule can compose it into the sentence', async () => {
    // The humanizer reads RAW log meta, which can carry a credential inside an
    // error string, and its output is truncated on the way out — so redacting the
    // finished sentence would miss a secret whose recognizable prefix got cut
    // off. The hook is applied to the INPUTS instead; this pins that.
    const secret = 'ThisIsALongLivedDeviceToken1234567890';
    const logger = createSubsystemLogger('web');
    logger.error('config migration failed', {
      error: `remote rejected: Authorization: Bearer ${secret}`,
    });

    const feed = await feedAfterFlush();
    expect(feed[0].body ?? '').not.toContain(secret);
    expect(feed[0].body ?? '').toContain('[REDACTED]');
    expect(feed[0].detail ?? '').not.toContain(secret);
  });

  it('redacts a secret in the TITLE too, not only the meta', async () => {
    const secret = 'AnotherVeryLongSecretValue0987654321';
    const logger = createSubsystemLogger('bridge-test');
    logger.error(`push refused for Bearer ${secret}`);

    const feed = await feedAfterFlush();
    expect(feed[0].title).not.toContain(secret);
    expect(feed[0].title).toContain('[REDACTED]');
  });

  it('DEDUP IS UNCHANGED for the refusal rule too (raw message, never the new copy)', () => {
    // A humanize rule may only reword; the moment a rule's output reached the
    // fingerprint, adding copy would silently re-partition every existing card.
    const raw = "API Error: Some Model 5 can't help with this. Start a new session to "
      + 'continue.\n\nLearn more: https://www.anthropic.com/legal/aup';
    const fp = dedupFingerprintForTest({
      subsystem: 'session', message: 'Session Error', meta: { sessionId: 's-1', error: raw },
    });
    expect(fp).toContain('Session Error');
    expect(fp).not.toContain('Model refused the request');
  });

  it('DEDUP IS UNCHANGED: the fingerprint hashes the RAW message, not the copy', async () => {
    // Two log calls whose humanized TITLE is identical ("Couldn't start a
    // session") but whose raw cause differs must stay two cards; and the
    // fingerprint must contain the raw message, never the rewritten one.
    const fp = dedupFingerprintForTest({
      subsystem: 'session',
      message: 'transport start failed',
      meta: { error: 'ENOENT', cwd: '/a' },
    });
    expect(fp).toContain('transport start failed');
    expect(fp).not.toContain("Couldn't start a session");

    const logger = createSubsystemLogger('session');
    logger.error('transport start failed', { cwd: '/a', error: 'ENOENT' });
    logger.error('transport start failed', { cwd: '/b', error: 'permission denied' });

    const feed = await feedAfterCount(2);
    // Same humanized title on both, still TWO distinct cards — identity did not
    // move to the copy.
    expect(feed).toHaveLength(2);
    expect(feed.every(n => n.title === "Couldn't start a session")).toBe(true);
    expect(new Set(feed.map(n => n.dedupKey)).size).toBe(2);
  });
});

/**
 * causeKey on the way into the feed — the ROOT CAUSE a card shares with
 * otherwise unrelated conditions.
 *
 * A host whose SSH/daemon link is down produces a session-start failure keyed
 * `task:<id>`, route 5xx cards keyed `route:…` and delivery failures keyed
 * `session:<sid>`. Each of those waits for its own success signal that may never
 * arrive, so the wall of red outlived the outage. The bridge derives the cause
 * from the message plus the error-ish meta strings (the route card's host is only
 * ever named inside meta, never structured), and `meta.host` is the hint that
 * wins when present.
 */
describe('causeKey derivation through the sink', () => {
  beforeEach(async () => {
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications();
  });

  afterEach(() => {
    uninstallLogErrorNotifications();
  });

  it('carries BOTH the condition key and the cause key on a session-start failure', async () => {
    // The real shape: the session never existed, so the only condition id is the
    // task — but the CAUSE is the host, and that is what a reconnect signals.
    const logger = createSubsystemLogger('session');
    logger.error('transport start failed', {
      host: 'devbox', taskId: 't1',
      error: 'Failed to deploy daemon source to devbox: Command failed: ssh -o BatchMode=yes devbox true',
    });

    const feed = await feedAfterFlush();
    expect(feed).toHaveLength(1);
    expect(feed[0].recoveryKey).toBe('task:t1');
    expect(feed[0].causeKey).toBe('host:devbox');
  });

  it('finds the host inside meta.message on a route-style card', async () => {
    // The route middleware's card is keyed by ROUTE and knows no host field; the
    // connectivity text arrives only as prose in the meta.
    const logger = createSubsystemLogger('web');
    logger.error('GET /api/x → 500', {
      recoveryKey: 'route:GET /api/x',
      message: 'Failed to deploy daemon source to devbox: Command failed: ssh',
    });

    const feed = await feedAfterFlush();
    expect(feed[0].recoveryKey).toBe('route:GET /api/x');
    expect(feed[0].causeKey).toBe('host:devbox');
  });

  it('leaves causeKey ABSENT when nothing names a connectivity failure', async () => {
    // A confident wrong grouping is worse than none: this card must not be
    // retired by some unrelated host reconnecting.
    const logger = createSubsystemLogger('session');
    logger.error('transport start failed', {
      host: 'devbox', taskId: 't2', cwd: '/data/gone',
      error: 'ENOENT: no such file or directory',
    });

    const feed = await feedAfterFlush();
    expect(feed[0].recoveryKey).toBe('task:t2');
    expect(feed[0].causeKey).toBeUndefined();
    expect('causeKey' in feed[0]).toBe(false);
  });

  it('releaseAbsorbedKeys accepts a CAUSE key, so a re-failure notifies inside the TTL', async () => {
    // Same flap argument as the recoveryKey release: the host recovers, the card
    // is stamped 'recovered', then the link drops again seconds later — well
    // inside the 60s absorber. If the absorber stays armed the re-failure never
    // reaches the store and the card sits green while the host is down again.
    const { releaseAbsorbedKeys } = await import('../../../src/core/notifications/log-error-bridge.js');
    const events: string[] = [];
    uninstallLogErrorNotifications();
    await dismissNotifications();
    installLogErrorNotifications((name) => { events.push(name); });

    const logger = createSubsystemLogger('session');
    const meta = {
      host: 'devbox', taskId: 't3',
      error: 'DaemonConnection not connected to devbox',
    };
    logger.error('transport start failed', meta);
    await feedAfterFlush();
    expect(events).toEqual(['notification:new']);

    // An unrelated host's recovery must not un-throttle this one.
    releaseAbsorbedKeys(['host:unrelated']);
    logger.error('transport start failed', meta);
    await new Promise(r => setTimeout(r, 150));
    expect(events).toEqual(['notification:new']);

    // The right cause key releases it, so the next failure folds and re-broadcasts.
    releaseAbsorbedKeys(['host:devbox']);
    logger.error('transport start failed', meta);
    await new Promise(r => setTimeout(r, 200));
    expect(events).toEqual(['notification:new', 'notification:updated']);
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].count).toBe(2);
    expect(feed[0].causeKey).toBe('host:devbox');
  });
});
