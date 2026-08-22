/**
 * humanize — the translation layer between a log line and a card a person reads.
 *
 * Two properties matter here and the suite is organized around them:
 *   1. every production error family gets a human title + ONE sentence, and the
 *      raw technical detail never becomes the message;
 *   2. every error gets a CATEGORY, by the documented precedence (rule →
 *      recoveryKey shape → subsystem → 'Other').
 *
 * Plugin ids in fixtures are invented neutral names ('plugin-a', 'acme') — a real
 * plugin id only ever exists as runtime data from the user's own install.
 */
import { describe, it, expect } from 'vitest';
import {
  humanizeErrorNotification, categoryFromRecoveryKey, categoryFromSubsystem,
  fallbackTitle, firstSentence, isRawMetaBody, titleizeId, HUMANIZE_RULE_IDS,
} from '../../../src/core/notifications/humanize.js';

describe('category precedence', () => {
  it('a recoveryKey beats the subsystem (the producer named the condition)', () => {
    // The 'web' subsystem would say API; the key says this is one plugin's problem.
    const out = humanizeErrorNotification({
      title: 'plugin-a sync failing repeatedly',
      subsystem: 'web',
      recoveryKey: 'plugin:plugin-a',
      meta: { pluginId: 'plugin-a', consecutiveFailures: 6 },
    });
    expect(out.category).toBe('Plugin A');
  });

  it('falls back to the subsystem root when there is no key', () => {
    expect(humanizeErrorNotification({ title: 'something odd', subsystem: 'git' }).category)
      .toBe('Data & Sync');
    expect(humanizeErrorNotification({ title: 'something odd', subsystem: 'obs' }).category)
      .toBe('Sessions');
    expect(humanizeErrorNotification({ title: 'something odd', subsystem: 'bus/inner' }).category)
      .toBe('Internal');
  });

  it("falls back to 'Other' with neither key nor subsystem", () => {
    expect(humanizeErrorNotification({ title: 'mystery failure' }).category).toBe('Other');
  });

  it('a NON-core subsystem root is a plugin id, capitalized', () => {
    // `<id>/http` is how a plugin's own logger names itself.
    expect(categoryFromSubsystem('acme/http')).toBe('Acme');
    expect(categoryFromSubsystem('plugin/plugin-a')).toBe('Plugin A');
  });

  it('maps every documented recoveryKey shape', () => {
    expect(categoryFromRecoveryKey('plugin:acme')).toBe('Acme');
    expect(categoryFromRecoveryKey('session:abc-123')).toBe('Sessions');
    expect(categoryFromRecoveryKey('task:mt1-0001')).toBe('Sessions');
    expect(categoryFromRecoveryKey('route:GET /api/x')).toBe('API');
    expect(categoryFromRecoveryKey('bus:main-ai:task:updated')).toBe('Internal');
    expect(categoryFromRecoveryKey('git')).toBe('Data & Sync');
    expect(categoryFromRecoveryKey('git:compaction')).toBe('Data & Sync');
    expect(categoryFromRecoveryKey('backup')).toBe('Data & Sync');
    expect(categoryFromRecoveryKey('disk')).toBe('Data & Sync');
    expect(categoryFromRecoveryKey('server-lifecycle')).toBe('Server');
    expect(categoryFromRecoveryKey('task-db-writers')).toBe('Internal');
    expect(categoryFromRecoveryKey('send-path')).toBe('Cloud');
  });

  it('an unknown key shape yields no category rather than a wrong one', () => {
    expect(categoryFromRecoveryKey('something-new')).toBeUndefined();
    expect(categoryFromRecoveryKey(undefined)).toBeUndefined();
  });
});

describe('session families', () => {
  it('transport start failed → names the missing working folder', () => {
    const out = humanizeErrorNotification({
      title: 'transport start failed',
      subsystem: 'session',
      recoveryKey: 'task:mq8c-97e0',
      meta: {
        taskId: 'mq8c-97e0', host: 'local', cwd: '/data/notes/Projects/Gone',
        error: 'spawn failed: ENOENT: no such file or directory',
      },
    });
    expect(out).toEqual({
      category: 'Sessions',
      title: "Couldn't start a session",
      message: 'The working folder no longer exists: /data/notes/Projects/Gone',
    });
  });

  it('transport start failed with an unrelated error keeps the error sentence', () => {
    const out = humanizeErrorNotification({
      title: 'transport start failed',
      subsystem: 'session',
      meta: { cwd: '/repo', error: 'ssh: connect to host box port 22: Connection refused. Retrying.' },
    });
    expect(out.title).toBe("Couldn't start a session");
    expect(out.message).toBe('ssh: connect to host box port 22: Connection refused.');
  });

  it('Session Delivery Failed PRESERVES the existing reassurance body (no double copy)', () => {
    const body = 'Working directory no longer exists: /data/x\n\nYour message was not lost. '
      + 'It stays queued and will be re-sent when you press Retry.';
    const out = humanizeErrorNotification({
      title: 'Session Delivery Failed', body, recoveryKey: 'session:s-1',
    });
    expect(out.title).toBe("Message couldn't be delivered");
    // Verbatim: the producer already wrote human copy, so it is not re-summarized.
    expect(out.message).toBe(body);
    expect(out.category).toBe('Sessions');
  });

  it('Session Error → one sentence of the failure', () => {
    const out = humanizeErrorNotification({
      title: 'Session Error',
      body: 'API Error: model overloaded. Retry in 30s. Trace abc.',
      recoveryKey: 'session:s-2',
    });
    expect(out.title).toBe('A session hit an error');
    expect(out.message).toBe('API Error: model overloaded.');
  });

  it('Subagent Error gets its own title', () => {
    const out = humanizeErrorNotification({
      title: 'Subagent Error', body: 'researcher: tool call timed out', recoveryKey: 'task:t-9',
    });
    expect(out.title).toBe('A subagent run failed');
    expect(out.message).toBe('researcher: tool call timed out.');
  });

  it('stream-convergence VIOLATION → plain words with the counts', () => {
    const out = humanizeErrorNotification({
      title: 'stream-convergence VIOLATION: streamed message(s) missing from persisted history',
      subsystem: 'obs',
      recoveryKey: 'session:d3b4',
      meta: { sessionId: 'd3b4', missing: ['a1', 'a2'], checked: 5, persistedCount: 3 },
    });
    expect(out.category).toBe('Sessions');
    expect(out.title).toBe('Some session output may not have been saved');
    expect(out.message).toBe("2 of 5 streamed messages never made it into this session's saved history.");
    // The one thing that must never happen: an id list in the message.
    expect(out.message).not.toContain('a1');
  });

  it('stream-convergence with no counts still reads as a sentence', () => {
    const out = humanizeErrorNotification({
      title: 'stream-convergence VIOLATION: streamed message(s) missing from persisted history',
      subsystem: 'obs',
    });
    expect(out.message).toBe("Some streamed output never made it into this session's saved history.");
  });

  it('self-report UNPARSEABLE → says what it means for the note', () => {
    const out = humanizeErrorNotification({
      title: 'turn-complete-summary: self-report UNPARSEABLE — no note section labels found; prompt/format regression?',
      subsystem: 'session',
      recoveryKey: 'session:20a0',
      meta: { sessionId: '20a0', taskId: 'mt1u', reportHead: 'EXEC_SUMMARY blah blah' },
    });
    expect(out.title).toBe("A session's summary couldn't be parsed");
    expect(out.message).toMatch(/unexpected format/);
    // The raw report head is developer detail, not the message.
    expect(out.message).not.toContain('EXEC_SUMMARY');
  });
});

describe('internal families', () => {
  it('SECOND WRITER → plain warning plus the pid', () => {
    const out = humanizeErrorNotification({
      title: 'SECOND WRITER on the task database — tasks WILL silently disappear. Kill the listed process now.',
      subsystem: 'web',
      recoveryKey: 'task-db-writers',
      meta: { holders: [{ pid: 62468, command: 'node' }], dbFile: '/data/tasks/tasks.sqlite' },
    });
    expect(out).toEqual({
      category: 'Internal',
      title: 'Another process is writing the task database',
      message: 'Tasks can silently disappear while this lasts (pid 62468).',
    });
  });

  it('SECOND WRITER with no holder list drops the pid clause', () => {
    const out = humanizeErrorNotification({
      title: 'SECOND WRITER on the task database', recoveryKey: 'task-db-writers',
    });
    expect(out.message).toBe('Tasks can silently disappear while this lasts.');
  });

  it('a throwing bus subscriber names the handler and the event', () => {
    const out = humanizeErrorNotification({
      title: 'subscriber "main-ai" threw on event "subagent:result" (async)',
      subsystem: 'bus',
      recoveryKey: 'bus:main-ai:subagent:result',
      meta: { eventName: 'subagent:result', error: 'Failed to parse /data/config/share/ui.json' },
    });
    expect(out.category).toBe('Internal');
    expect(out.title).toBe('An internal event handler failed');
    expect(out.message).toBe('The "main-ai" handler failed while handling "subagent:result".');
  });
});

describe('server lifecycle', () => {
  it('SIGTERM reads as an ordinary stop, not a crash', () => {
    const out = humanizeErrorNotification({
      title: 'SERVER EXIT: SIGTERM (killed by another process)',
      subsystem: 'web',
      recoveryKey: 'server-lifecycle',
      meta: { pid: 76655, uptime: 151.4 },
    });
    expect(out.category).toBe('Server');
    expect(out.title).toBe('Walnut was stopped (killed by another process)');
    expect(out.message).toMatch(/normal during a deploy/);
  });

  it('any other exit reason is an unexpected stop', () => {
    const out = humanizeErrorNotification({
      title: 'SERVER EXIT: uncaughtException',
      subsystem: 'web',
      recoveryKey: 'server-lifecycle',
      meta: { detail: 'Cannot read properties of undefined' },
    });
    expect(out.title).toBe('Walnut stopped unexpectedly');
    expect(out.message).toBe('Cannot read properties of undefined.');
  });
});

describe('route errors', () => {
  it('keeps the terse endpoint title but drops the per-occurrence latency', () => {
    const out = humanizeErrorNotification({
      title: 'PUT /api/ui-prefs → 500 (139ms)',
      subsystem: 'web',
      recoveryKey: 'route:PUT /api/ui-prefs',
      meta: { reqId: 'a5b8', bodyBytes: 190 },
    });
    expect(out).toEqual({
      category: 'API',
      title: 'PUT /api/ui-prefs → 500',
      message: 'This API endpoint is failing (HTTP 500).',
    });
  });

  it('reads the status from the meta when the title has none', () => {
    const out = humanizeErrorNotification({
      title: 'GET /api/v1/search', subsystem: 'web', meta: { status: 501 },
    });
    expect(out.message).toBe('This API endpoint is failing (HTTP 501).');
  });

  it('every HTTP method is recognized', () => {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH']) {
      const out = humanizeErrorNotification({ title: `${method} /api/x → 503 (2ms)`, subsystem: 'web' });
      expect(out.title).toBe(`${method} /api/x → 503`);
      expect(out.category).toBe('API');
    }
  });
});

describe('titles that are already human', () => {
  it('passes a producer-written title + body through, adding only a category', () => {
    const body = 'Git history compaction failed: push of compacted history failed. The data repo will grow.';
    const out = humanizeErrorNotification({
      title: 'Data Repo Compaction Failing', body, recoveryKey: 'git:compaction',
    });
    expect(out).toEqual({ category: 'Data & Sync', title: 'Data Repo Compaction Failing', message: body });
  });

  it('categorizes the disk / backup / cloud monitors by their condition', () => {
    expect(humanizeErrorNotification({ title: 'Data Disk Critically Full', body: 'x', recoveryKey: 'disk' }).category)
      .toBe('Data & Sync');
    expect(humanizeErrorNotification({ title: 'S3 Backup Failing', body: 'x', recoveryKey: 'backup' }).category)
      .toBe('Data & Sync');
    expect(humanizeErrorNotification({ title: 'Phone sends are FAILING (disk full)', body: 'x', recoveryKey: 'send-path' }).category)
      .toBe('Cloud');
  });

  it('a keyless one-shot monitor still gets a category from its title', () => {
    // Keep-Awake publishes no recoveryKey (lifecycle: one-shot).
    const out = humanizeErrorNotification({
      title: 'Keep-Awake Released', body: 'The Mac is being allowed to sleep: low battery.',
    });
    expect(out.category).toBe('Server');
    expect(out.title).toBe('Keep-Awake Released');
  });
});

describe('plugin sync families', () => {
  const meta = { pluginId: 'plugin-a', taskId: 'mt1u-be35' };

  it('a failed task push says what happens to the change', () => {
    const out = humanizeErrorNotification({
      title: 'failed to push task to the remote tracker',
      subsystem: 'plugin-a/sync',
      recoveryKey: 'plugin:plugin-a',
      meta: { ...meta, error: 'API error (HTTP 400) during UpdateTask' },
    });
    expect(out.category).toBe('Plugin A');
    expect(out.title).toBe("Plugin A couldn't save a task change");
    expect(out.message).toBe('API error (HTTP 400) during UpdateTask.');
  });

  it('repeated sync failure counts the attempts when there is no error string', () => {
    const out = humanizeErrorNotification({
      title: 'plugin-a sync failing repeatedly',
      subsystem: 'web',
      recoveryKey: 'plugin:plugin-a',
      meta: { pluginId: 'plugin-a', consecutiveFailures: 7 },
    });
    expect(out.title).toBe('Plugin A sync keeps failing');
    expect(out.message).toBe('7 sync attempts in a row have failed.');
  });

  it('a full reconcile failure is its own title', () => {
    const out = humanizeErrorNotification({
      title: 'sync-reconciler: full reconcile failed',
      subsystem: 'web',
      recoveryKey: 'plugin:acme',
      meta: { pluginId: 'acme', error: 'socket hang up' },
    });
    expect(out.category).toBe('Acme');
    expect(out.title).toBe('Acme full sync failed');
    expect(out.message).toBe('socket hang up.');
  });

  it('an API error carries the inner error WITHOUT the JSON wrapper', () => {
    const out = humanizeErrorNotification({
      title: 'Acme API error',
      subsystem: 'acme/client',
      recoveryKey: 'plugin:acme',
      meta: { statusCode: 302, operationName: 'TaskCollections', body: 'Found. Redirecting to https://sso.example' },
    });
    expect(out.category).toBe('Acme');
    expect(out.title).toBe('Acme API request failed');
    expect(out.message).toBe('The request came back HTTP 302 (TaskCollections).');
    // The wrapper (and the redirect body) belong in Details, never in the message.
    expect(out.message).not.toContain('{');
    expect(out.message).not.toContain('Redirecting');
  });

  it("anything else from a plugin's logger still gets the plugin's category", () => {
    // This is the three-cards-are-one-problem case: an unruled plugin error must
    // land in the SAME group as its ruled siblings.
    const out = humanizeErrorNotification({
      title: 'sprint fetch failed', subsystem: 'acme/client', meta: { statusCode: 307 },
    });
    expect(out.category).toBe('Acme');
    expect(out.title).toBe('Sprint fetch failed');
    expect(out.message).toBe('The request came back HTTP 307.');
  });
});

describe('fallback for an unmatched error', () => {
  it('never emits a JSON dump as the message', () => {
    const out = humanizeErrorNotification({
      title: 'weird internal failure',
      body: '[web] {"holders":[{"pid":22198}],"dbFile":"/data/x"}',
      subsystem: 'web',
    });
    expect(out.title).toBe('Weird internal failure');
    expect(out.message).toBe('');
    expect(out.category).toBe('API');
  });

  it('uses a prose body as the message when the producer wrote one', () => {
    const out = humanizeErrorNotification({
      title: 'config migration failed', body: 'The old config could not be read. Check permissions.',
      subsystem: 'web',
    });
    expect(out.message).toBe('The old config could not be read.');
  });

  it("uses meta.error when there's no body at all", () => {
    const out = humanizeErrorNotification({
      title: 'failed to load integration plugins',
      subsystem: 'plugin-loader',
      meta: { error: 'Unexpected token } in JSON at position 4' },
    });
    expect(out.category).toBe('Internal');
    expect(out.title).toBe('Failed to load integration plugins');
    expect(out.message).toBe('Unexpected token } in JSON at position 4.');
  });

  it('strips an inline JSON blob out of the TITLE', () => {
    expect(fallbackTitle('daemon reattach failed {"host":"box","pid":3}'))
      .toBe('Daemon reattach failed');
  });

  it('never returns an empty title', () => {
    expect(fallbackTitle('{"only":"json"}')).toBe('Something went wrong');
    expect(humanizeErrorNotification({ title: '' }).title).toBe('Something went wrong');
  });

  it('truncates a very long title instead of letting it fill the card', () => {
    const out = fallbackTitle('x'.repeat(400));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('helpers', () => {
  it('firstSentence does not split a filename or a path', () => {
    expect(firstSentence('Failed to parse /data/config/ui.json: bad token'))
      .toBe('Failed to parse /data/config/ui.json: bad token.');
  });

  it('firstSentence collapses newlines and stops at the first sentence', () => {
    expect(firstSentence('Boom happened. Then more.\n  at foo (bar.js:1)')).toBe('Boom happened.');
  });

  it('firstSentence is empty for empty input (card shows the title only)', () => {
    expect(firstSentence(undefined)).toBe('');
    expect(firstSentence('   ')).toBe('');
  });

  it('isRawMetaBody recognizes the old body shape and not prose', () => {
    expect(isRawMetaBody('[web] {"reqId":"a"}')).toBe(true);
    expect(isRawMetaBody('[acme/client] {"statusCode":302}')).toBe(true);
    expect(isRawMetaBody('[web]')).toBe(false);
    expect(isRawMetaBody('Git auto-commit has failed 3+ times.')).toBe(false);
    expect(isRawMetaBody(undefined)).toBe(false);
  });

  it('titleizeId makes a display name out of an id', () => {
    expect(titleizeId('acme')).toBe('Acme');
    expect(titleizeId('plugin-a')).toBe('Plugin A');
    expect(titleizeId('some_other.thing')).toBe('Some Other Thing');
  });

  it('a malformed meta can never throw away the notification', () => {
    const hostile = {
      title: 'SECOND WRITER on the task database',
      recoveryKey: 'task-db-writers',
      meta: { holders: 'not-an-array' as unknown },
    };
    const out = humanizeErrorNotification(hostile);
    expect(out.title).toBe('Another process is writing the task database');
    expect(out.category).toBe('Internal');
  });
});

describe('rule precedence list', () => {
  it('specific families precede the catch-all plugin rule', () => {
    // The plugin catch-all matching first would swallow every ruled family that
    // happens to come from a plugin's logger.
    const ids = [...HUMANIZE_RULE_IDS];
    expect(ids[ids.length - 1]).toBe('plugin-generic');
    expect(ids.indexOf('plugin-api-error')).toBeLessThan(ids.indexOf('plugin-generic'));
    expect(ids.indexOf('transport-start-failed')).toBeLessThan(ids.indexOf('plugin-generic'));
    // Delivery-failed must precede the generic session-error prefix rule.
    expect(ids.indexOf('session-delivery-failed')).toBeLessThan(ids.indexOf('session-error'));
  });
});

describe('the sanitize hook', () => {
  const upper = (t: string) => t.replace(/secret-\w+/g, '[REDACTED]');

  it('is applied to the title, the body and string meta BEFORE any rule runs', () => {
    const out = humanizeErrorNotification({
      title: 'Session Error',
      body: 'failed with secret-abc123 attached',
      meta: { error: 'secret-def456 rejected' },
    }, { sanitize: upper });
    expect(out.message).toBe('failed with [REDACTED] attached.');
    expect(out.message).not.toContain('secret-abc');
  });

  it('reaches one level into an array-valued meta field', () => {
    // `holders: [{...}]` is the deepest shape any rule reads.
    const out = humanizeErrorNotification({
      title: 'weird', meta: { notes: ['secret-xyz789'] },
    }, { sanitize: upper });
    expect(JSON.stringify(out)).not.toContain('secret-xyz');
  });

  it('is optional — omitting it leaves the input untouched', () => {
    const out = humanizeErrorNotification({
      title: 'Session Error', body: 'plain secret-abc123',
    });
    expect(out.message).toContain('secret-abc123');
  });
});
