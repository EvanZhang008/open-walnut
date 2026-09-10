/**
 * The brief a repair session opens with (src/core/self-repair/fix-briefing.ts).
 *
 * Two things must hold or the session does the wrong thing:
 *   - the error is described completely enough to find its producer (title,
 *     body, raw detail, category, occurrence count, condition key, context),
 *   - the session is told WHICH tree it is in. A separate clone must be warned
 *     off `npm run dev:prod` (the repo's own CLAUDE.md tells it to deploy that
 *     way, and the running Walnut was never served from that tree).
 *
 * Pure functions, no fs and no constants: fix-briefing.ts imports types only.
 */

import { describe, it, expect } from 'vitest';
import type { NotificationRecord } from '../../../src/core/notifications/store.js';
import type { WalnutSource } from '../../../src/core/self-repair/walnut-source.js';
import {
  fixTaskTitle,
  buildNotificationFixMessage,
  type FixBriefingContext,
} from '../../../src/core/self-repair/fix-briefing.js';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'notif-1',
    kind: 'operation-error',
    severity: 'error',
    title: 'Data Repo Growing Too Large',
    body: 'The data repo is 3.4 GB; sync will get slow.',
    detail: '[git] {"sizeGb":3.4}',
    category: 'Data & Sync',
    recoveryKey: 'git',
    dedupKey: 'error:git:repo-size',
    timestamp: T0,
    read: false,
    ...over,
  };
}

function ctx(source: WalnutSource, over: Partial<FixBriefingContext> = {}): FixBriefingContext {
  return {
    source,
    version: '9.9.9',
    packageRoot: '/opt/acme/lib/node_modules/open-walnut',
    dataDir: '/home/acme/.open-walnut',
    logDir: '/tmp/open-walnut',
    repoUrl: 'https://example.invalid/open-walnut.git',
    cloned: false,
    ...over,
  };
}

describe('fixTaskTitle', () => {
  it('prefixes the notification title', () => {
    expect(fixTaskTitle({ title: 'Backup failed' })).toBe('Fix: Backup failed');
  });

  it('flattens newlines and runs of whitespace', () => {
    expect(fixTaskTitle({ title: '  Data Repo\n  Growing   Too Large ' })).toBe('Fix: Data Repo Growing Too Large');
  });

  it('caps at 80 chars with an ellipsis', () => {
    const title = fixTaskTitle({ title: 'x'.repeat(200) });
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('Fix: xxx')).toBe(true);
  });

  it('leaves an exactly-80-char title alone', () => {
    // 'Fix: ' is 5 chars, so 75 x's lands exactly on the cap.
    const title = fixTaskTitle({ title: 'x'.repeat(75) });
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(false);
  });

  it('falls back when the title is empty or whitespace', () => {
    expect(fixTaskTitle({ title: '' })).toBe('Fix: error notification');
    expect(fixTaskTitle({ title: '   \n ' })).toBe('Fix: error notification');
  });
});

describe('buildNotificationFixMessage — the error section', () => {
  const source: WalnutSource = { dir: '/home/acme/walnut', kind: 'running' };

  it('carries everything needed to find the producer', () => {
    const message = buildNotificationFixMessage(
      record({ count: 3, lastTimestamp: T0 + 60_000 }),
      ctx(source),
    );
    expect(message).toContain('Ask AI to fix');
    expect(message).toContain('Title: Data Repo Growing Too Large');
    expect(message).toContain('Category: Data & Sync');
    expect(message).toContain('Severity: error');
    expect(message).toContain('Message: The data repo is 3.4 GB; sync will get slow.');
    expect(message).toContain('Details: [git] {"sizeGb":3.4}');
    expect(message).toContain('Occurrences: 3');
    expect(message).toContain('2026-09-01T10:00:00.000Z');
    expect(message).toContain('2026-09-01T10:01:00.000Z');
    expect(message).toContain('Condition key: git');
  });

  it('says "Occurred" for a one-off, not "Occurrences"', () => {
    const message = buildNotificationFixMessage(record(), ctx(source));
    expect(message).toContain('Occurred: 2026-09-01T10:00:00.000Z');
    expect(message).not.toContain('Occurrences:');
  });

  it('lists the session / task / host / project context when present', () => {
    const message = buildNotificationFixMessage(
      record({
        sessionId: 's-1', sessionTitle: 'Acme deploy', taskId: 't-1',
        host: 'acme-dev', project: 'Acme',
      }),
      ctx(source),
    );
    expect(message).toContain('Context: session s-1 ("Acme deploy"), task t-1, host acme-dev, project Acme');
  });

  it('omits the context line entirely when there is none', () => {
    expect(buildNotificationFixMessage(record(), ctx(source))).not.toContain('Context:');
  });

  it('flags a condition that keeps coming back after recovering', () => {
    const message = buildNotificationFixMessage(
      record({ resolved: 'recovered', resolvedAt: T0 + 5_000, causeKey: 'host:acme-dev' }),
      ctx(source),
    );
    expect(message).toContain('Status: recovered at 2026-09-01T10:00:05.000Z');
    expect(message).toContain('keeps coming back');
    expect(message).toContain('Cause key: host:acme-dev');
  });

  it('always ends with the same root-cause instructions', () => {
    const message = buildNotificationFixMessage(record(), ctx(source));
    expect(message).toContain('## What to do');
    expect(message).toContain('Fix causes, not the message');
  });
});

describe('buildNotificationFixMessage — kind "running" (the tree the server runs from)', () => {
  const source: WalnutSource = { dir: '/home/acme/walnut', kind: 'running' };

  it('says a fix here is a fix to the app that raised the error', () => {
    const message = buildNotificationFixMessage(record(), ctx(source));
    expect(message).toContain("Walnut's source checkout at /home/acme/walnut");
    expect(message).toContain('was built from this checkout');
    expect(message).toContain('/home/acme/.open-walnut');
    expect(message).toContain('/tmp/open-walnut/open-walnut-<date>.log');
    expect(message).toContain('scripts/walnut-logs.sh');
  });

  it('does NOT tell it to reinstall globally — this tree IS the install', () => {
    const message = buildNotificationFixMessage(record(), ctx(source));
    expect(message).not.toContain('npm install -g');
    expect(message).not.toContain('NOT this tree');
  });
});

describe('buildNotificationFixMessage — a separate checkout', () => {
  it('warns a fresh clone off restarting the running server', () => {
    const source: WalnutSource = { dir: '/home/acme/open-walnut', kind: 'clone' };
    const message = buildNotificationFixMessage(record(), ctx(source, { cloned: true }));
    expect(message).toContain('NOT this tree');
    expect(message).toContain('open-walnut@9.9.9');
    expect(message).toContain('/opt/acme/lib/node_modules/open-walnut');
    expect(message).toContain('cloned just now');
    expect(message).toContain('https://example.invalid/open-walnut.git');
    // The repo's own CLAUDE.md would send it to dev:prod; that would restart a
    // server this tree never built.
    expect(message).toContain('Do NOT run it');
    expect(message).toContain('npm install -g .');
    expect(message).toContain('npm run web:build');
  });

  it('describes a clone it is reusing rather than one it just made', () => {
    const source: WalnutSource = { dir: '/home/acme/open-walnut', kind: 'clone' };
    const message = buildNotificationFixMessage(record(), ctx(source, { cloned: false }));
    expect(message).toContain('the local clone Walnut keeps');
    expect(message).not.toContain('cloned just now');
  });

  it('credits the user for a checkout they configured', () => {
    const source: WalnutSource = { dir: '/work/acme/walnut-src', kind: 'configured' };
    const message = buildNotificationFixMessage(record(), ctx(source, { cloned: false }));
    expect(message).toContain('pointed Walnut at');
    expect(message).toContain('/work/acme/walnut-src');
    expect(message).toContain('NOT this tree');
  });

  it('drops the package-root clause when the running package has no root', () => {
    const source: WalnutSource = { dir: '/home/acme/open-walnut', kind: 'clone' };
    const message = buildNotificationFixMessage(record(), ctx(source, { packageRoot: null }));
    expect(message).toContain('the installed package open-walnut@9.9.9 (compiled dist only');
  });
});
