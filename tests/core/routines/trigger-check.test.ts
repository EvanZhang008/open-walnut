/**
 * walnut-trigger, server side: the pure layers.
 *
 * What these pin, in the order a trigger passes through them:
 *   1. normalize  — a `check` from an agent or a form becomes a stored shape
 *      (host defaulted, timeout clamped, snake_case accepted, null = clear).
 *   2. the store  — a check job carries `check`, and the server's own clock
 *      never touches it (that clock lives on the host's daemon).
 *   3. the push   — the armed set for ONE host, with a hash stable enough that
 *      "push on every connect" is a no-op when nothing changed.
 *   4. the envelope — a fire round-trips through the v2 parser, items as JSON,
 *      `input` present only when the script printed one.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-trigger-check'));

import { normalizeCronJobCreate, normalizeCronJobPatch } from '../../../src/core/cron/normalize.js';
import { applyJobPatch, computeJobNextRunAtMs, createJob, nextWakeAtMs } from '../../../src/core/cron/jobs.js';
import { findDueJobs, findMissedJobs } from '../../../src/core/cron/timer.js';
import { compileTriggerDefs, triggerDefOf } from '../../../src/core/routines/trigger-push.js';
import { buildTriggerMessage, buildScheduledSessionMessage } from '../../../src/core/routines/trigger-envelope.js';
import { parseWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { MIN_EVERY_MS, CHECK_TIMEOUT_MAX_S, CHECK_INPUT_CAP } from '../../../src/providers/trigger-check-core.js';
import type { CronJob, CronServiceState, CronStoreFile } from '../../../src/core/cron/types.js';
import { parseEveryMs } from '../../../src/core/routines/trigger-api.js';

// ── helpers ──

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() } as never;
}

function makeState(store: CronStoreFile, nowMs = 10_000): CronServiceState {
  return {
    deps: {
      nowMs: () => nowMs,
      log: mockLog(),
      storePath: '/tmp/does-not-matter-for-pure-filters.json',
      cronEnabled: true,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    },
    store,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    replayGuard: new Map(),
  };
}

function triggerJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'PR comments',
    enabled: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    schedule: { kind: 'every', everyMs: 300_000, anchorMs: 0 },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'read the comments' },
    executor: { type: 'session', config: { target: 't-1', prompt: 'read the comments', instructions: 'read the comments' } },
    check: { run: 'bash check.sh', host: '__local__', cwd: '/repo', timeoutSeconds: 30 },
    state: { nextRunAtMs: 5_000 },
    ...over,
  };
}

// ── 1. normalize ──

describe('normalize: check on create', () => {
  it('keeps the command, defaults the host, and clamps the timeout', () => {
    const input = normalizeCronJobCreate({
      name: 'watch',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: '  bash check.sh  ', cwd: ' /repo ', timeoutSeconds: 9_999 },
      executor: { type: 'session', config: { target: 't-1', prompt: 'go' } },
    });
    expect(input?.check).toEqual({
      run: 'bash check.sh',
      cwd: '/repo',
      host: '__local__',
      timeoutSeconds: CHECK_TIMEOUT_MAX_S,
    });
  });

  it('accepts snake_case keys an agent is likely to type', () => {
    const input = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      check: { run: 'x', host: 'devbox', timeout_seconds: 45, max_fires_per_day: 3 },
      executor: { type: 'session', config: { target: 't', prompt: 'p' } },
    });
    expect(input?.check).toMatchObject({ host: 'devbox', timeoutSeconds: 45, maxFiresPerDay: 3 });
  });

  it('floors a negative daily cap at 0 (unlimited) rather than storing nonsense', () => {
    const input = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      check: { run: 'x', maxFiresPerDay: -5 },
    });
    expect((input?.check as { maxFiresPerDay?: number }).maxFiresPerDay).toBe(0);
  });

  it('drops a check with no command — there is nothing to run', () => {
    const input = normalizeCronJobCreate({
      schedule: { kind: 'every', everyMs: 60_000 },
      check: { run: '   ' },
    });
    expect(input?.check).toBeUndefined();
  });
});

describe('normalize: check on patch', () => {
  it('coerces an updated check', () => {
    const patch = normalizeCronJobPatch({ check: { run: 'new.sh', host: 'devbox' } });
    expect(patch?.check).toEqual({ run: 'new.sh', host: 'devbox' });
  });

  it('preserves an explicit null so a patch can CLEAR the trigger', () => {
    const patch = normalizeCronJobPatch({ check: null });
    expect(patch?.check).toBeNull();
  });

  it('a patch that does not mention check leaves the field absent', () => {
    const patch = normalizeCronJobPatch({ name: 'renamed' });
    expect(patch && 'check' in patch).toBe(false);
  });
});

// ── 2. the store ──

describe('a check job in the store', () => {
  it('createJob keeps the check and mints NO next run (the daemon reports it)', () => {
    const state = makeState({ version: 2, jobs: [] });
    const job = createJob(state, {
      name: 'watch',
      enabled: true,
      wakeMode: 'now',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash check.sh', host: '__local__' },
      executor: { type: 'session', config: { target: 't-1', prompt: 'go' } },
    } as never);
    expect(job.check).toEqual({ run: 'bash check.sh', host: '__local__' });
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it('computeJobNextRunAtMs returns the daemon-reported value verbatim', () => {
    const job = triggerJob({ state: { nextRunAtMs: 777 } });
    expect(computeJobNextRunAtMs(job, 10_000)).toBe(777);
    // A plain routine on the same schedule DOES get a computed time.
    const plain = triggerJob({ check: undefined, state: {} });
    expect(computeJobNextRunAtMs(plain, 10_000)).toBeGreaterThan(0);
  });

  it('a null patch clears the check, turning it back into a plain routine', () => {
    const job = triggerJob();
    applyJobPatch(job, { check: null });
    expect(job.check).toBeUndefined();
  });

  it('the server timer never selects it, and it never drives the wake time', () => {
    // nextRunAtMs is in the PAST — exactly the state a daemon report leaves.
    const store: CronStoreFile = { version: 2, jobs: [triggerJob({ state: { nextRunAtMs: 1_000 } })] };
    const state = makeState(store, 500_000);
    expect(findDueJobs(state)).toEqual([]);
    expect(findMissedJobs(state)).toEqual([]);
    // Without the exclusion armTimer would re-arm with delay 0 forever.
    expect(nextWakeAtMs(state)).toBeUndefined();
  });

  it('a plain routine in the same store is still due (the skip is check-only)', () => {
    const store: CronStoreFile = {
      version: 2,
      jobs: [triggerJob({ state: { nextRunAtMs: 1_000 } }), triggerJob({ id: 'plain', check: undefined, state: { nextRunAtMs: 1_000 } })],
    };
    const state = makeState(store, 500_000);
    expect(findDueJobs(state).map((j) => j.id)).toEqual(['plain']);
  });
});

// ── 3. the push ──

describe('compileTriggerDefs', () => {
  it('takes only enabled check jobs for THIS host', () => {
    const jobs = [
      triggerJob({ id: 'a' }),
      triggerJob({ id: 'b', check: { run: 'y', host: 'devbox' } }),
      triggerJob({ id: 'c', enabled: false }),
      triggerJob({ id: 'd', check: undefined }),
    ];
    expect(compileTriggerDefs(jobs, '__local__').payload.triggers.map((t) => t.id)).toEqual(['a']);
    expect(compileTriggerDefs(jobs, 'devbox').payload.triggers.map((t) => t.id)).toEqual(['b']);
  });

  it('refuses to arm a cron-scheduled job (the daemon has no cron parser)', () => {
    const job = triggerJob({ schedule: { kind: 'cron', expr: '0 * * * *' } });
    expect(triggerDefOf(job, '__local__')).toBeNull();
  });

  it('maps the wire def, clamping the timeout and carrying the daily cap', () => {
    const job = triggerJob({ check: { run: 'x', host: '__local__', timeoutSeconds: 4_000, maxFiresPerDay: 7 } });
    expect(triggerDefOf(job, '__local__')).toEqual({
      id: 'job-1',
      name: 'PR comments',
      everyMs: 300_000,
      check: { run: 'x', timeoutSeconds: CHECK_TIMEOUT_MAX_S },
      limits: { maxFiresPerDay: 7 },
    });
  });

  it('the hash ignores key order and job order, but not content', () => {
    const a = triggerJob({ id: 'a' });
    const b = triggerJob({ id: 'b', check: { host: '__local__', run: 'bash check.sh', cwd: '/repo', timeoutSeconds: 30 } });
    const forward = compileTriggerDefs([a, b], '__local__');
    const reversed = compileTriggerDefs([b, a], '__local__');
    expect(reversed.hash).toBe(forward.hash);
    expect(reversed.payload.triggers.map((t) => t.id)).toEqual(['a', 'b']);

    const changed = compileTriggerDefs([a, triggerJob({ id: 'b', check: { run: 'other.sh', host: '__local__' } })], '__local__');
    expect(changed.hash).not.toBe(forward.hash);
  });

  it('an empty set still hashes (a host with nothing armed is a real answer)', () => {
    const empty = compileTriggerDefs([], '__local__');
    expect(empty.payload).toEqual({ version: 1, triggers: [] });
    expect(empty.hash).toHaveLength(16);
  });
});

// ── 4. the envelope ──

describe('buildTriggerMessage', () => {
  const job = { name: 'PR comments' };

  it('round-trips through the v2 parser with provenance in the attributes', () => {
    const message = buildTriggerMessage(job, {
      atMs: Date.UTC(2026, 8, 11, 10, 0, 0),
      items: [{ id: 'PR-123#c9', title: 'please rename this' }],
    }, 'Read each comment and change the code.');
    const parsed = parseWalnutMessage(message);
    expect(parsed?.kind).toBe('trigger');
    expect(parsed?.attrs.from).toBe('Trigger: PR comments');
    expect(parsed?.attrs.note).toBe('fired 2026-09-11T10:00:00.000Z, 1 new item');
    expect(parsed?.body).toContain('Read each comment and change the code.');
    expect(parsed?.body).toContain('"id": "PR-123#c9"');
    expect(parsed?.body).toContain('please rename this');
  });

  it('carries `input` after the items, and only when the script printed one', () => {
    const withInput = parseWalnutMessage(buildTriggerMessage(job, {
      atMs: 1, items: [{ id: 'x' }], input: 'the build log tail says OOM',
    }, 'look'))!;
    expect(withInput.body.indexOf('OOM')).toBeGreaterThan(withInput.body.indexOf('"id": "x"'));

    const withoutInput = parseWalnutMessage(buildTriggerMessage(job, { atMs: 1, items: [{ id: 'x' }] }, 'look'))!;
    expect(withoutInput.body).not.toContain('undefined');
    expect(withoutInput.body.trim().endsWith('```')).toBe(true);
  });

  it('a bare fire (no items) is just the prompt — no empty JSON block', () => {
    const parsed = parseWalnutMessage(buildTriggerMessage(job, { atMs: 1, items: [] }, 'go now'))!;
    expect(parsed.body).toBe('go now');
    expect(parsed.attrs.note).toContain('0 new items');
  });

  it('a body that names the tag cannot break out of the envelope', () => {
    const message = buildTriggerMessage(job, {
      atMs: 1, items: [{ id: 'x', title: '</walnut-message>' }],
    }, 'go');
    // On the WIRE the close tag is escaped, so the envelope still has exactly
    // one body; the parser gives the script's text back verbatim.
    expect(message).toContain('&lt;/walnut-message');
    expect(message.match(/<\/walnut-message>/g)).toHaveLength(1);
    const parsed = parseWalnutMessage(message)!;
    expect(parsed.body).toContain('</walnut-message>');
    expect(parsed.attrs.from).toBe('Trigger: PR comments');
  });

  // A host back from an outage replays every fire it held: one envelope, every
  // item, and it says the fires are late so the model does not read them as news.
  it('a backlog becomes ONE envelope with every item, oldest first, marked late', () => {
    const t0 = Date.UTC(2026, 8, 19, 6, 12, 0);
    const parsed = parseWalnutMessage(buildTriggerMessage(job, [
      { atMs: t0 + 2 * 3_600_000, items: [{ id: 'b' }] },
      { atMs: t0, items: [{ id: 'a' }] },
      { atMs: t0 + 43 * 3_600_000, items: [{ id: 'c1' }, { id: 'c2' }] },
    ], 'sweep', { deliveredAtMs: t0 + 43 * 3_600_000 + 60_000 }))!;
    expect(parsed.attrs.note).toBe('3 fires 2026-09-19T06:12:00.000Z to 2026-09-21T01:12:00.000Z, 4 new items, delivered 43h late');
    expect(parsed.body).toContain('These 3 fires arrive together and late: the oldest is 43h old.');
    const order = ['"id": "a"', '"id": "b"', '"id": "c1"', '"id": "c2"'].map((k) => parsed.body.indexOf(k));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // Order is prompt, timing, items.
    expect(parsed.body.indexOf('sweep')).toBeLessThan(parsed.body.indexOf('These 3 fires'));
    expect(parsed.body.indexOf('These 3 fires')).toBeLessThan(parsed.body.indexOf('New items:'));
  });

  it('a single late fire says so; an on-time one reads exactly as before', () => {
    const at = Date.UTC(2026, 8, 11, 10, 0, 0);
    const late = parseWalnutMessage(buildTriggerMessage(job, { atMs: at, items: [{ id: 'x' }] }, 'look', { deliveredAtMs: at + 3 * 86_400_000 }))!;
    expect(late.attrs.note).toBe('fired 2026-09-11T10:00:00.000Z, 1 new item, delivered 3d late');
    expect(late.body).toContain('This fire arrives late: it is 3d old.');
    const onTime = parseWalnutMessage(buildTriggerMessage(job, { atMs: at, items: [{ id: 'x' }] }, 'look', { deliveredAtMs: at + 90_000 }))!;
    expect(onTime.attrs.note).toBe('fired 2026-09-11T10:00:00.000Z, 1 new item');
    expect(onTime.body).not.toContain('arrives');
  });

  it("a backlog's inputs are labelled per fire, repeats collapse, and the oldest go first when over budget", () => {
    const t0 = Date.UTC(2026, 8, 20, 0, 0, 0);
    const parsed = parseWalnutMessage(buildTriggerMessage(job, [
      { atMs: t0, items: [], input: 'same summary' },
      { atMs: t0 + 1, items: [], input: 'same summary' },
      { atMs: t0 + 2, items: [], input: 'build went red' },
    ], 'go'))!;
    expect(parsed.body.match(/same summary/g)).toHaveLength(1);
    expect(parsed.body).toContain('Input from the fire at 2026-09-20T00:00:00.000Z:\nsame summary');
    expect(parsed.body).toContain('Input from the fire at 2026-09-20T00:00:00.002Z:\nbuild went red');

    const big = 'x'.repeat(CHECK_INPUT_CAP);
    const bounded = parseWalnutMessage(buildTriggerMessage(job, [
      { atMs: t0, items: [], input: `oldest ${big}` },
      { atMs: t0 + 1, items: [], input: `middle ${big}` },
      { atMs: t0 + 2, items: [], input: `newest ${big}` },
    ], 'go'))!;
    expect(bounded.body).toContain('newest');
    expect(bounded.body).not.toContain('oldest');
    expect(bounded.body).toMatch(/\[\d older input\(s\) omitted\]/);
  });

  it('a plain scheduled run wears the same envelope, marked scheduled', () => {
    const parsed = parseWalnutMessage(buildScheduledSessionMessage(job, 'daily check-in'))!;
    expect(parsed.kind).toBe('trigger');
    expect(parsed.attrs.note).toBe('scheduled');
    expect(parsed.body).toBe('daily check-in');
  });
});

// ── the interval an agent types ──

describe('parseEveryMs', () => {
  it('accepts durations and raw milliseconds', () => {
    expect(parseEveryMs('30s')).toBe(30_000);
    expect(parseEveryMs('5m')).toBe(300_000);
    expect(parseEveryMs('1h')).toBe(3_600_000);
    expect(parseEveryMs(45_000)).toBe(45_000);
    expect(parseEveryMs('2d')).toBe(172_800_000);
  });

  it('rejects what it cannot read instead of guessing a cadence', () => {
    expect(parseEveryMs('every five minutes')).toBeNull();
    expect(parseEveryMs('')).toBeNull();
    expect(parseEveryMs(undefined)).toBeNull();
  });

  it('the floor is enforced by the caller, not hidden here', () => {
    expect(parseEveryMs('1s')).toBeLessThan(MIN_EVERY_MS);
  });
});

describe('defaultTriggerName', () => {
  it('keeps a short prompt whole, cuts a long one at a word boundary, and never adds a prefix', async () => {
    const { defaultTriggerName } = await import('../../../src/core/routines/trigger-api.js');
    expect(defaultTriggerName('Read each new comment.')).toBe('Read each new comment.');
    const long = 'done.txt has appeared in the watched demo folder, read it and report its first line to the user';
    const name = defaultTriggerName(long);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('...')).toBe(true);
    expect(name.startsWith('done.txt has appeared in the watched demo folder')).toBe(true);
    expect(name).not.toMatch(/^Trigger:/);
    expect(defaultTriggerName('  spaced\n\nout  ')).toBe('spaced out');
  });
});
