/**
 * Property + fuzz coverage for the BROWSER cron metadata intake
 * (web/src/stores/session-status-store.ts → `applyCron` and friends).
 *
 * A model store written from the intake's documented rules — first epoch seen is
 * adopted, a later epoch only after intake reopens on a websocket drop, retired
 * epochs never again, per-session revision monotonicity inside one epoch, an
 * alias-renamed session id cannot be written under its old name — is replayed
 * against random sequences. The model also predicts the SUBSCRIBER count, so a
 * silent state change (or a spurious notification) fails the run.
 *
 * Seeds are printed in every failure message so a red run is replayable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSessionCronJobs } from '../../src/core/types';
import type { SessionCronMetadata } from '../../src/core/types';
import { log } from '../../web/src/utils/log';
import {
  SessionStatusStore,
  type SessionCronApplyResult,
  type SessionStatusSnapshot,
} from '../../web/src/stores/session-status-store';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

const SIDS = ['provider-session-p1', 'provider-session-p2', 'provider-session-p3'];
const RENAMED = new Map(SIDS.map((sid) => [sid, `${sid}-renamed`]));
const ALL_IDS = [...SIDS, ...RENAMED.values()];
const EPOCHS = ['epoch-a', 'epoch-b', 'epoch-c', 'epoch-d'];

function cron(
  revision: number,
  overrides: Partial<SessionCronMetadata> = {},
): SessionCronMetadata {
  return {
    sessionId: SIDS[0]!,
    epoch: EPOCHS[0]!,
    revision,
    presence: 'active',
    source: 'cron',
    known: true,
    stale: false,
    observedAt: 1_757_000_000_000 + revision,
    validUntil: null,
    ...overrides,
  };
}

function status(
  revision: number,
  overrides: Partial<SessionStatusSnapshot> = {},
): SessionStatusSnapshot {
  return {
    sessionId: SIDS[0]!,
    taskId: 'task-cron-prop',
    process_status: 'running',
    activity: null,
    mode: 'default',
    planCompleted: false,
    archived: false,
    errorMessage: null,
    provider: 'cli',
    engine: 'claude',
    pendingPermissionTool: null,
    statusRevision: revision,
    statusUpdatedAt: `2026-09-16T12:00:00.${String(revision).padStart(3, '0')}Z`,
    ...overrides,
  };
}

const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM',
  prompt: 'Daily disk inspection', promptTruncated: false, recurring: true, durable: false,
  createdAt: 1000, nextRunAt: 5000, expiresAt: 9000, ...over,
});

const MALFORMED_JOBS: unknown[] = [
  [job({ id: '' })], [job({ recurring: 'yes' })], [job(), job()], 'jobs', 7,
  [job({ prompt: 'x'.repeat(2001) })],
];

const INVALID_PATCHES: Array<Record<string, unknown>> = [
  { sessionId: '' }, { sessionId: 'draft:column-1' }, { sessionId: 'pending:launch-1' },
  { sessionId: 'x'.repeat(257) }, { epoch: '' }, { epoch: 'e'.repeat(257) }, { epoch: 42 },
  { revision: 0 }, { revision: -3 }, { revision: 1.5 }, { revision: 2 ** 53 },
  { revision: '2' }, { presence: 'armed' }, { presence: undefined }, { source: 'timer' },
  { known: 'yes' }, { stale: null }, { observedAt: Number.NaN }, { observedAt: '1757' },
  { validUntil: 'soon' },
];

// ---------------------------------------------------------------------------
// The oracle. Written from the rules, deliberately not from the code's layout.
// ---------------------------------------------------------------------------

const PRESENCES = new Set(['active', 'inactive', 'unknown']);
const SOURCES = new Set(['cron', 'wakeup']);

/** The store's own session-id gate: no placeholders, no ACP runtime ids. */
function isProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('draft:')
    && !value.startsWith('pending:')
    && !/^acp-[0-9a-f]{16}$/.test(value);
}

function modelNormalize(input: unknown): SessionCronMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (!isProviderId(v.sessionId) || v.sessionId.length > 256) return null;
  if (typeof v.epoch !== 'string' || v.epoch.length === 0 || v.epoch.length > 256) return null;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1) return null;
  if (typeof v.presence !== 'string' || !PRESENCES.has(v.presence)) return null;
  if (v.source !== null && !(typeof v.source === 'string' && SOURCES.has(v.source))) return null;
  if (typeof v.known !== 'boolean' || typeof v.stale !== 'boolean') return null;
  if (typeof v.observedAt !== 'number' || !Number.isFinite(v.observedAt)) return null;
  if (v.validUntil !== null && !(typeof v.validUntil === 'number' && Number.isFinite(v.validUntil))) return null;
  const jobs = normalizeSessionCronJobs(v.jobs);
  return {
    sessionId: v.sessionId, epoch: v.epoch, revision: v.revision as number,
    presence: v.presence as SessionCronMetadata['presence'],
    source: v.source as SessionCronMetadata['source'],
    known: v.known, stale: v.stale,
    observedAt: v.observedAt, validUntil: v.validUntil as number | null,
    ...(jobs ? { jobs } : {}),
  };
}

/** Model of the cron half of SessionStatusStore, including its notifications.
 *  The retired-epoch cap (32) is out of scope: the sequences use 4 epochs. */
function createCronModel() {
  const crons = new Map<string, SessionCronMetadata>();
  const clientStale = new Set<string>();
  const retired = new Set<string>();
  const aliases = new Map<string, string>();
  let epoch: string | null = null;
  let intakeOpen = false;
  let notifications = 0;

  const resolve = (sid: string | null | undefined): string | null => {
    if (!isProviderId(sid)) return null;
    let current = sid;
    const seen = new Set<string>();
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current)!;
    }
    return current;
  };
  const addStale = (id: string): boolean => {
    const base = crons.get(id);
    if (!base || base.stale || clientStale.has(id)) return false;
    clientStale.add(id);
    return true;
  };

  return {
    get notifications() { return notifications; },
    /** The epoch currently in force — the generator needs it to stay realistic. */
    get epoch() { return epoch; },
    applyCron(input: unknown): SessionCronApplyResult {
      const m = modelNormalize(input);
      if (!m) return 'rejected-invalid';
      if (retired.has(m.epoch)) return 'rejected-retired-epoch';
      // A renamed-away id is refused before epoch adoption can have side effects.
      const canonical = resolve(m.sessionId) ?? m.sessionId;
      if (canonical !== m.sessionId) return 'rejected-stale';
      if (epoch === null) {
        epoch = m.epoch;
        intakeOpen = false;
      } else if (m.epoch !== epoch) {
        if (!intakeOpen) return 'rejected-unauthorized-epoch';
        // Adoption retires the old epoch and marks every held session stale; the
        // accepted write that follows is what notifies subscribers.
        retired.add(epoch);
        epoch = m.epoch;
        intakeOpen = false;
        for (const id of crons.keys()) addStale(id);
      }
      const current = crons.get(canonical);
      if (current && current.epoch === m.epoch) {
        if (m.revision < current.revision) return 'rejected-stale';
        if (m.revision === current.revision) {
          if (clientStale.delete(canonical)) notifications++;
          return 'duplicate';
        }
      }
      crons.set(canonical, m);
      clientStale.delete(canonical);
      notifications++;
      return 'accepted';
    },
    markCronStale(): void {
      let changed = false;
      for (const id of crons.keys()) if (addStale(id)) changed = true;
      if (changed) notifications++;
    },
    resetCronEpochIntake(): void {
      intakeOpen = true;
    },
    /** Mirror of the cron half of promoteAlias / moveCronToAliasTarget. */
    rename(previous: string, next: string): void {
      aliases.set(previous, next);
      const previousCron = crons.get(previous);
      crons.delete(previous);
      clientStale.delete(previous);
      if (!previousCron) return;
      if (!crons.has(next)) {
        crons.set(next, { ...previousCron, sessionId: next, presence: 'unknown', stale: true });
        clientStale.delete(next);
      }
      notifications++;
    },
    getCron(sid: string): SessionCronMetadata | null {
      const resolved = resolve(sid);
      if (!resolved) return null;
      const base = crons.get(resolved) ?? null;
      if (!base || base.stale || !clientStale.has(resolved)) return base;
      return { ...base, stale: true };
    },
    sessionIds(): string[] {
      return [...crons.keys()];
    },
  };
}

// The store logs on every decision; silence it (one test re-arms warn to count).
beforeEach(() => {
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(log, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SEEDS = [5, 13, 20260916];

describe('SessionStatusStore cron intake — random sequences', () => {
  it.each(SEEDS)('matches the model store op for op (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    const store = new SessionStatusStore();
    const model = createCronModel();
    let notifications = 0;
    store.subscribeCron(() => { notifications++; });

    const renamed = new Set<string>();
    let statusRevision = 0;
    const outcomes = new Map<SessionCronApplyResult, number>();
    /** The last envelope each session accepted, for verbatim re-delivery. */
    const lastAccepted = new Map<string, unknown>();
    let freshEpochs = 0;

    const envelope = (sid: string, epoch: string): unknown => {
      const held = model.getCron(sid);
      const base = held?.revision ?? 0;
      const revision = pick(rng, [base + 1, base + 1, base + 2, base + 5, base, Math.max(1, base - 1)]);
      const value: Record<string, unknown> = {
        ...cron(revision, {
          sessionId: sid,
          epoch,
          presence: pick(rng, ['active', 'inactive', 'unknown']),
          source: pick(rng, ['cron', 'wakeup', null]),
          known: rng() < 0.7,
          stale: rng() < 0.2,
          validUntil: rng() < 0.5 ? null : 1_757_000_100_000,
        }),
      };
      const jobsRoll = rng();
      if (jobsRoll < 0.2) value.jobs = [job({ id: `${sid}-a` })];
      else if (jobsRoll < 0.3) value.jobs = [];
      else if (jobsRoll < 0.42) value.jobs = pick(rng, MALFORMED_JOBS);
      if (rng() < 0.12) Object.assign(value, pick(rng, INVALID_PATCHES));
      if (rng() < 0.03) return pick(rng, [null, undefined, 'cron', 42, [cron(1)]]);
      return value;
    };

    for (let step = 0; step < 120; step++) {
      const label = `seed ${seed} step ${step}`;
      const before = notifications;
      const roll = rng();
      if (roll < 0.06) {
        // Websocket drop: the real client marks stale, then reopens intake.
        store.markCronStale();
        model.markCronStale();
        store.resetCronEpochIntake();
        model.resetCronEpochIntake();
      } else if (roll < 0.1) {
        // Only rename a session that HOLDS cron metadata: the interesting half
        // of the rename is what happens to the value it was already showing.
        const candidates = SIDS.filter((sid) => !renamed.has(sid) && model.getCron(sid));
        if (candidates.length > 0) {
          const previous = pick(rng, candidates);
          const next = RENAMED.get(previous)!;
          renamed.add(previous);
          expect(
            store.applyVersioned(status(++statusRevision, { sessionId: next }), 'ws', previous),
            `${label} rename`,
          ).toBe('accepted');
          model.rename(previous, next);
        }
      } else {
        const sid = pick(rng, ALL_IDS);
        // Mostly the epoch in force (a server restart is rare, and an epoch the
        // store already retired must stay refused forever).
        const roll2 = rng();
        const epoch = roll2 < 0.82
          ? (model.epoch ?? EPOCHS[0]!)
          : (roll2 < 0.92 ? EPOCHS[Math.min(++freshEpochs, EPOCHS.length - 1)]! : pick(rng, EPOCHS));
        // A verbatim re-delivery is what a REST read racing the socket produces.
        const resend = rng() < 0.18 ? lastAccepted.get(sid) : undefined;
        const input = resend ?? envelope(sid, epoch);
        const actual = store.applyCron(input, pick(rng, ['ws', 'rest:session', 'rest:session-list']));
        expect(actual, `${label} applyCron`).toBe(model.applyCron(input));
        outcomes.set(actual, (outcomes.get(actual) ?? 0) + 1);
        if (actual === 'accepted') lastAccepted.set(sid, input);
        if (actual.startsWith('rejected')) {
          expect(notifications, `${label} ${actual} must stay silent`).toBe(before);
        }
        if (actual === 'accepted') {
          expect(notifications, `${label} accepted must notify`).toBeGreaterThan(before);
        }
      }

      expect(notifications, `${label} notification count`).toBe(model.notifications);
      for (const id of ALL_IDS) {
        expect(store.getCron(id), `${label} getCron(${id})`).toEqual(model.getCron(id));
      }
      expect(store.getCronSessionIds().sort(), `${label} session ids`).toEqual(model.sessionIds().sort());
    }

    // Every documented outcome must be reached, or the sequence proves little.
    const spread = JSON.stringify([...outcomes]);
    for (const required of [
      'accepted', 'duplicate', 'rejected-stale', 'rejected-invalid',
      'rejected-retired-epoch', 'rejected-unauthorized-epoch',
    ] as const) {
      expect(outcomes.get(required) ?? 0, `seed ${seed} never hit ${required}: ${spread}`).toBeGreaterThan(0);
    }
  });
});

describe('SessionStatusStore cron intake — subscriber discipline', () => {
  it('notifies once per accepted change and never for a rejection', () => {
    const store = new SessionStatusStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribeCron(first);
    const off = store.subscribeCron(second);

    expect(store.applyCron(cron(1))).toBe('accepted');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // Re-applying the identical accepted payload is a `duplicate`, not an
    // 'accepted' — and it notifies NOBODY, because nothing observable moved.
    expect(store.applyCron(cron(1), 'rest:session')).toBe('duplicate');
    expect(first).toHaveBeenCalledTimes(1);

    for (const [input, expected] of [
      [cron(0), 'rejected-invalid'],
      [cron(1, { presence: 'armed' as never }), 'rejected-invalid'],
      ['cron', 'rejected-invalid'],
      [cron(1, { epoch: EPOCHS[1] }), 'rejected-unauthorized-epoch'],
    ] as const) {
      expect(store.applyCron(input)).toBe(expected);
    }
    expect(first).toHaveBeenCalledTimes(1);

    off();
    expect(store.applyCron(cron(2))).toBe('accepted');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('lets a duplicate notify only when it clears the client staleness overlay', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);
    expect(store.applyCron(cron(4))).toBe('accepted');
    expect(listener).toHaveBeenCalledTimes(1);

    store.markCronStale();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getCron(SIDS[0]!)).toMatchObject({ revision: 4, stale: true });

    // The SAME revision re-delivered proves the socket is back: still
    // 'duplicate', but it drops the overlay, so it does notify.
    expect(store.applyCron(cron(4), 'rest:session-list')).toBe('duplicate');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getCron(SIDS[0]!)).toMatchObject({ revision: 4, stale: false });

    expect(store.applyCron(cron(4), 'rest:session-list')).toBe('duplicate');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('serves an identity-stable snapshot so a subscriber can compare by reference', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(1))).toBe('accepted');
    const held = store.getCron(SIDS[0]!);
    expect(store.getCron(SIDS[0]!)).toBe(held);
    store.markCronStale();
    const stale = store.getCron(SIDS[0]!);
    expect(stale).not.toBe(held);
    expect(store.getCron(SIDS[0]!)).toBe(stale);
  });
});

describe('SessionStatusStore cron intake — malformed job details', () => {
  it('accepts the envelope, drops the details, and warns exactly once', () => {
    const store = new SessionStatusStore();
    const warn = vi.mocked(log.warn);
    let revision = 0;
    for (const malformed of MALFORMED_JOBS) {
      warn.mockClear();
      expect(store.applyCron(cron(++revision, { jobs: malformed as never }))).toBe('accepted');
      const value = store.getCron(SIDS[0]!)!;
      expect(value).toMatchObject({ revision, presence: 'active' });
      expect('jobs' in value).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('session-cron', 'dropped malformed cron job details', {
        sessionId: SIDS[0], revision,
      });
    }
  });

  it('warns about malformed details even when the envelope is then rejected', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(5))).toBe('accepted');
    const warn = vi.mocked(log.warn);
    warn.mockClear();
    // The job check runs inside normalization, BEFORE the revision gate.
    expect(store.applyCron(cron(4, { jobs: 'jobs' as never }), 'rest:session')).toBe('rejected-stale');
    expect(warn).toHaveBeenCalledWith('session-cron', 'dropped malformed cron job details', {
      sessionId: SIDS[0], revision: 4,
    });
    expect(store.getCron(SIDS[0]!)).toMatchObject({ revision: 5 });
  });

  it('keeps an empty job list distinguishable from absent details', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(1, { jobs: [] }))).toBe('accepted');
    const empty = store.getCron(SIDS[0]!)!;
    expect('jobs' in empty).toBe(true);
    expect(empty.jobs).toEqual([]);

    expect(store.applyCron(cron(2, { jobs: undefined }))).toBe('accepted');
    expect('jobs' in store.getCron(SIDS[0]!)!).toBe(false);

    const input = cron(3) as Record<string, unknown>;
    delete input.jobs;
    expect(store.applyCron(input)).toBe('accepted');
    expect('jobs' in store.getCron(SIDS[0]!)!).toBe(false);

    expect(store.applyCron(cron(4, { jobs: [job()] as never }))).toBe('accepted');
    expect(store.getCron(SIDS[0]!)?.jobs).toEqual([job()]);
  });
});

describe('SessionStatusStore cron intake — envelope fuzz', () => {
  const RESULTS: readonly SessionCronApplyResult[] = [
    'accepted', 'duplicate', 'rejected-invalid', 'rejected-stale',
    'rejected-retired-epoch', 'rejected-unauthorized-epoch',
  ];
  const WILD: unknown[] = [
    undefined, null, Number.NaN, 0, -1, 2 ** 53, 1.5, '', 'x'.repeat(300), true, false,
    {}, [], () => {}, Symbol.iterator.toString(), '\uD83D\uDE80', '\u4efb\u52a1',
  ];

  it.each(SEEDS)('never throws, answers a documented code, and no-ops on rejection (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    const store = new SessionStatusStore();
    // Intake stays CLOSED for the whole fuzz: with no reopen and no rename, a
    // rejection has no legitimate reason to move the store at all.
    expect(store.applyCron(cron(1))).toBe('accepted');
    const snapshot = () => ({
      ids: store.getCronSessionIds().sort(),
      values: store.getCronSessionIds().sort().map((id) => store.getCron(id)),
      generation: store.getCronRequestGeneration(),
    });

    const seen = new Set<SessionCronApplyResult>();
    for (let round = 0; round < 100; round++) {
      const value: Record<string, unknown> = { ...cron(1 + Math.floor(rng() * 4)) };
      const fields = Math.floor(rng() * 4);
      for (let i = 0; i < fields; i++) {
        value[pick(rng, [
          'sessionId', 'epoch', 'revision', 'presence', 'source', 'known', 'stale',
          'observedAt', 'validUntil', 'jobs', 'extra',
        ])] = pick(rng, WILD);
      }
      if (rng() < 0.1) value.sessionId = 's'.repeat(300);
      if (rng() < 0.1) value.epoch = 'e'.repeat(300);
      if (rng() < 0.1) value.sessionId = pick(rng, ['draft:c1', 'pending:p1', 'acp-0123456789abcdef']);
      const input: unknown = rng() < 0.05 ? pick(rng, WILD) : value;
      const label = `seed ${seed} round ${round}: ${safeLabel(input)}`;

      const before = snapshot();
      let result: SessionCronApplyResult | undefined;
      expect(() => { result = store.applyCron(input, 'ws'); }, label).not.toThrow();
      expect(RESULTS, `${label} → ${result}`).toContain(result!);
      seen.add(result!);
      if (result!.startsWith('rejected')) expect(snapshot(), `${label} must no-op`).toEqual(before);
    }
    expect(seen.has('rejected-invalid'), `seed ${seed} saw ${[...seen]}`).toBe(true);
  });

  function safeLabel(value: unknown): string {
    try {
      return JSON.stringify(value)?.slice(0, 200) ?? String(value);
    } catch {
      return '<unserializable>';
    }
  }
});

describe('SessionStatusStore cron intake — epoch lifecycle', () => {
  it('adopts the first epoch, refuses the next one, and retires what it replaces', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(9))).toBe('accepted');
    expect(store.applyCron(cron(1, { epoch: EPOCHS[1] }))).toBe('rejected-unauthorized-epoch');

    store.resetCronEpochIntake();
    expect(store.applyCron(cron(1, { epoch: EPOCHS[1], presence: 'inactive' }))).toBe('accepted');
    // Lower revision, new epoch: revisions are compared only inside one epoch.
    expect(store.getCron(SIDS[0]!)).toMatchObject({ epoch: EPOCHS[1], revision: 1 });
    expect(store.applyCron(cron(99))).toBe('rejected-retired-epoch');

    // A retired epoch stays refused even with intake reopened.
    store.resetCronEpochIntake();
    expect(store.applyCron(cron(99))).toBe('rejected-retired-epoch');
    expect(store.applyCron(cron(1, { epoch: EPOCHS[2] }))).toBe('accepted');
  });

  it('refuses a write under an id that was renamed away', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(4))).toBe('accepted');
    const next = RENAMED.get(SIDS[0]!)!;
    expect(store.applyVersioned(status(1, { sessionId: next }), 'ws', SIDS[0]!)).toBe('accepted');
    expect(store.getCronSessionIds()).toEqual([next]);
    expect(store.getCron(SIDS[0]!)).toBe(store.getCron(next));
    expect(store.getCron(next)).toMatchObject({ presence: 'unknown', stale: true, revision: 4 });

    expect(store.applyCron(cron(99), 'rest:session')).toBe('rejected-stale');
    expect(store.applyCron(cron(5, { sessionId: next }))).toBe('accepted');
    expect(store.getCron(next)).toMatchObject({ presence: 'active', stale: false, revision: 5 });
  });

  // Epoch adoption retires the previous epoch and marks every held session
  // stale, so it must run only for an envelope the store is going to keep. A
  // message for an id that was renamed away is rejected before it can adopt.
  it('a rejected envelope neither retires the epoch nor marks sessions stale', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);
    expect(store.applyCron(cron(1))).toBe('accepted');
    expect(store.applyCron(cron(1, { sessionId: SIDS[1] }))).toBe('accepted');

    // Rename the SECOND session, so the first is left holding a fresh value.
    const next = RENAMED.get(SIDS[1]!)!;
    expect(store.applyVersioned(status(1, { sessionId: next }), 'ws', SIDS[1]!)).toBe('accepted');
    store.resetCronEpochIntake();
    listener.mockClear();

    // A new epoch arriving for the renamed-away id: rejected, and nothing else moves.
    expect(store.applyCron(cron(1, { sessionId: SIDS[1], epoch: EPOCHS[1] }))).toBe('rejected-stale');
    expect(listener).not.toHaveBeenCalled();
    expect(store.getCron(SIDS[0]!)).toMatchObject({ stale: false, epoch: EPOCHS[0] });
    expect(store.applyCron(cron(2))).toBe('accepted');

    // Intake is still open, so the same new epoch under a live id adopts and notifies.
    listener.mockClear();
    expect(store.applyCron(cron(1, { sessionId: next, epoch: EPOCHS[1] }))).toBe('accepted');
    expect(listener).toHaveBeenCalled();
    expect(store.getCron(SIDS[0]!)).toMatchObject({ stale: true });
    expect(store.applyCron(cron(3))).toBe('rejected-retired-epoch');
  });
});

describe('SessionStatusStore cron intake — per-session staleness', () => {
  it('marks one session stale on request, once, and ignores ids it does not hold', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);
    expect(store.applyCron(cron(1))).toBe('accepted');
    expect(store.applyCron(cron(1, { sessionId: SIDS[1] }))).toBe('accepted');
    listener.mockClear();

    store.markCronStale(SIDS[0]!);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getCron(SIDS[0]!)).toMatchObject({ stale: true });
    expect(store.getCron(SIDS[1]!)).toMatchObject({ stale: false });

    // Already stale: nothing to announce. Unknown or malformed ids: nothing at all.
    store.markCronStale(SIDS[0]!);
    store.markCronStale('provider-session-never-seen');
    store.markCronStale('');
    store.markCronStale(null);
    expect(listener).toHaveBeenCalledTimes(1);

    // The matching duplicate from the socket clears exactly that overlay.
    expect(store.applyCron(cron(1))).toBe('duplicate');
    expect(store.getCron(SIDS[0]!)).toMatchObject({ stale: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
