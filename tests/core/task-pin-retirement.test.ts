/**
 * Pin retirement — completed pins expire off the board after N days.
 *
 * The bug this closes: `task_create` pins by default and completion deliberately
 * does NOT unpin, so nothing ever retired a finished pin. On the live box the
 * pinned set had grown to 1230 rows of which only 94 were open work, and the
 * phone's board reported "Focus 90" for 16 real tasks.
 *
 * The invariants that matter, in order of blast radius if broken:
 *  1. An OPEN task is never touched, no matter how old.
 *  2. A pin completed INSIDE the window is never touched.
 *  3. Nothing is ever deleted, and no field other than pinned/pin_order/
 *     focus_tier changes — updated_at explicitly included, because bumping it
 *     would push 1100+ rows of old junk to the top of every recency surface.
 *  4. The replica never sweeps (the primary owns task writes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const constantsMock = vi.hoisted(() => ({ cloudMode: false }));
const configMock = vi.hoisted(() => ({ value: {} as unknown }));

vi.mock('../../src/constants.js', () => ({
  ...createMockConstants(),
  get CLOUD_MODE() { return constantsMock.cloudMode; },
}));
// Only getConfig is replaced — task-manager's own config reads (project seeding,
// updateConfig) keep the real implementation.
vi.mock('../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => configMock.value,
}));

import {
  addTasksBulk,
  getTask,
  getPinnedTasks,
  listTasks,
  togglePin,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { buildTaskProjection } from '../../src/core/task-projection.js';
import { closeDb } from '../../src/core/task-db.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { Task, TaskPhase, TaskStatus } from '../../src/core/types.js';
import {
  DEFAULT_PIN_RETIREMENT_DAYS,
  PIN_RETIREMENT_CHUNK_SIZE,
  completionTimeMs,
  isRetirablePin,
  resolvePinRetirementDays,
  sweepPinRetirement,
} from '../../src/core/task-pin-retirement.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface Fixture {
  title: string;
  pinned?: boolean;
  pin_order?: number;
  focus_tier?: string;
  phase?: TaskPhase;
  status?: TaskStatus;
  /** Absent = no completed_at column at all (exercises the updated_at fallback). */
  completed_at?: string;
  updated_at?: string;
  note?: string;
  group_id?: string;
}

/**
 * Insert fixtures through the bulk create path so every field (including a
 * back-dated completed_at that the normal create chain would overwrite) is
 * exactly what the test asked for.
 */
async function seed(fixtures: Fixture[]): Promise<Task[]> {
  const rows = fixtures.map((f, i) => {
    const phase: TaskPhase = f.phase ?? 'TODO';
    const status: TaskStatus = f.status ?? (phase === 'COMPLETE' ? 'done' : 'todo');
    const row: Record<string, unknown> = {
      // Explicit ids on purpose. generateId() is `Date.now().toString(36)` plus
      // 2 random bytes, and addTasksBulk inserts with INSERT OR REPLACE — at
      // 1200 rows inside one millisecond the birthday collisions silently drop
      // ~3 fixtures and the count assertions go flaky.
      id: `pinret-${i.toString().padStart(5, '0')}`,
      title: f.title,
      project: 'Marina',
      status,
      phase,
      priority: 'none',
      source: 'local',
      session_ids: [],
      description: `desc for ${f.title}`,
      summary: '',
      note: f.note ?? '',
      created_at: iso(NOW - 30 * DAY),
      updated_at: f.updated_at ?? iso(NOW - 30 * DAY),
      ...(f.completed_at ? { completed_at: f.completed_at } : {}),
      ...(f.pinned === false ? {} : { pinned: true }),
      ...(f.pin_order !== undefined ? { pin_order: f.pin_order } : {}),
      ...(f.focus_tier ? { focus_tier: f.focus_tier } : {}),
      ...(f.group_id ? { group_id: f.group_id } : {}),
    };
    return row as unknown as Omit<Task, 'id'>;
  });
  return addTasksBulk(rows);
}

/** A completed pin whose work finished `ageMs` before NOW. */
function donePin(title: string, ageMs: number, extra: Partial<Fixture> = {}): Fixture {
  return {
    title,
    phase: 'COMPLETE',
    status: 'done',
    completed_at: iso(NOW - ageMs),
    updated_at: iso(NOW - ageMs),
    ...extra,
  };
}

async function titlesStillPinned(): Promise<string[]> {
  return (await getPinnedTasks()).map((t) => t.title).sort();
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  constantsMock.cloudMode = false;
  configMock.value = {};
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(async () => {
  closeDb();
  bus.unsubscribe('pin-retirement-test');
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── Pure predicates ────────────────────────────────────────────────────────

describe('resolvePinRetirementDays', () => {
  it('defaults to 3 days when the knob is absent', () => {
    expect(resolvePinRetirementDays({})).toBe(DEFAULT_PIN_RETIREMENT_DAYS);
    expect(resolvePinRetirementDays({ tasks: {} })).toBe(3);
    expect(resolvePinRetirementDays(undefined)).toBe(3);
    expect(resolvePinRetirementDays(null)).toBe(3);
  });

  it('reads an explicit value, including the disabling 0 and negatives', () => {
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: 7 } })).toBe(7);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: 0 } })).toBe(0);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: -1 } })).toBe(-1);
  });

  it('falls back to the default on garbage rather than disabling itself', () => {
    // A typo must not silently turn retirement off — that is the failure mode
    // this whole feature exists to fix.
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: 'soon' as never } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: NaN } })).toBe(3);
  });

  it('accepts a quoted number (YAML strings are reachable)', () => {
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: '7' } })).toBe(7);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: ' 0 ' } })).toBe(0);
  });

  it('refuses to coerce a non-number to a window', () => {
    // `pin_retirement_days: yes` parses as the boolean true, and Number(true) is
    // 1 — a 1-day window nobody asked for. Same trap with an empty list (0, i.e.
    // retirement silently OFF) and a single-element list (its element).
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: true } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: false } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: [] } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: [7] } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: {} } })).toBe(3);
    expect(resolvePinRetirementDays({ tasks: { pin_retirement_days: null } })).toBe(3);
  });
});

describe('completionTimeMs', () => {
  it('prefers completed_at', () => {
    expect(completionTimeMs({ completed_at: iso(NOW - DAY), updated_at: iso(NOW) }))
      .toBe(NOW - DAY);
  });

  it('falls back to updated_at when completed_at is absent or blank', () => {
    expect(completionTimeMs({ updated_at: iso(NOW - 2 * DAY) })).toBe(NOW - 2 * DAY);
    expect(completionTimeMs({ completed_at: '   ', updated_at: iso(NOW - 2 * DAY) }))
      .toBe(NOW - 2 * DAY);
  });

  it('returns null when neither timestamp parses (unknown age is never "old")', () => {
    expect(completionTimeMs({ completed_at: 'whenever', updated_at: 'also not a date' })).toBeNull();
    expect(completionTimeMs({ updated_at: '' as never })).toBeNull();
  });
});

describe('isRetirablePin', () => {
  const cutoff = NOW - 3 * DAY;

  it('retires a pinned COMPLETE task past the cutoff', () => {
    expect(isRetirablePin(
      { pinned: true, phase: 'COMPLETE', status: 'done', completed_at: iso(cutoff - MINUTE) },
      cutoff,
    )).toBe(true);
  });

  it('keeps anything unpinned, open, or exactly at the cutoff', () => {
    const old = iso(cutoff - DAY);
    expect(isRetirablePin({ pinned: false, phase: 'COMPLETE', status: 'done', completed_at: old }, cutoff)).toBe(false);
    expect(isRetirablePin({ pinned: true, phase: 'AGENT_COMPLETE', status: 'in_progress', updated_at: old }, cutoff)).toBe(false);
    expect(isRetirablePin({ pinned: true, phase: 'COMPLETE', status: 'done', completed_at: iso(cutoff) }, cutoff)).toBe(false);
  });

  it('treats either half of the phase/status pair as completed (legacy rows)', () => {
    const old = iso(cutoff - DAY);
    // status-only: a row written before phase existed.
    expect(isRetirablePin({ pinned: true, phase: 'TODO', status: 'done', completed_at: old }, cutoff)).toBe(true);
    // phase-only: status never derived.
    expect(isRetirablePin({ pinned: true, phase: 'COMPLETE', status: 'todo', completed_at: old }, cutoff)).toBe(true);
  });
});

// ── The sweep ──────────────────────────────────────────────────────────────

describe('sweepPinRetirement — window boundary', () => {
  it('keeps 3d-1min and retires 3d+1min', async () => {
    await seed([
      donePin('just inside the window', 3 * DAY - MINUTE),
      donePin('just outside the window', 3 * DAY + MINUTE),
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.days).toBe(3);
    expect(report.candidates).toBe(1);
    expect(report.retired).toBe(1);
    expect(await titlesStillPinned()).toEqual(['just inside the window']);
    // oldestKept proves the sweep stopped exactly at the boundary.
    expect(report.oldestKept).toBe(iso(NOW - 3 * DAY + MINUTE));
  });

  it('honours a custom window from the config knob', async () => {
    configMock.value = { tasks: { pin_retirement_days: 10 } };
    await seed([
      donePin('5 days done', 5 * DAY),
      donePin('12 days done', 12 * DAY),
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.days).toBe(10);
    expect(report.retired).toBe(1);
    expect(await titlesStillPinned()).toEqual(['5 days done']);
  });
});

describe('sweepPinRetirement — the disabling knob', () => {
  it('is a total no-op at 0 and at a negative value', async () => {
    await seed([donePin('ancient', 90 * DAY)]);

    for (const days of [0, -1]) {
      configMock.value = { tasks: { pin_retirement_days: days } };
      const report = await sweepPinRetirement({ nowMs: NOW });
      expect(report.disabled).toBe(true);
      expect(report.retired).toBe(0);
      // Disabled means it does not even scan — no store read, no cutoff.
      expect(report.scanned).toBe(0);
      expect(report.cutoff).toBeNull();
      expect(await titlesStillPinned()).toEqual(['ancient']);
    }
  });
});

describe('sweepPinRetirement — safety', () => {
  it('never touches an open pinned task, however old', async () => {
    await seed([
      { title: 'ancient todo', phase: 'TODO', updated_at: iso(NOW - 400 * DAY), focus_tier: 'focus', pin_order: 0 },
      { title: 'ancient in progress', phase: 'IN_PROGRESS', status: 'in_progress', updated_at: iso(NOW - 400 * DAY), pin_order: 1 },
      { title: 'ancient agent complete', phase: 'AGENT_COMPLETE', status: 'in_progress', updated_at: iso(NOW - 400 * DAY), pin_order: 2 },
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.scanned).toBe(3);
    expect(report.candidates).toBe(0);
    expect(report.retired).toBe(0);
    // No completed pins at all ⇒ nothing to report as the oldest survivor.
    expect(report.oldestKept).toBeNull();
    expect(await titlesStillPinned()).toEqual([
      'ancient agent complete', 'ancient in progress', 'ancient todo',
    ]);
    expect((await getTask((await getPinnedTasks())[0].id)).focus_tier).toBe('focus');
  });

  it('keeps recently finished pins — the "pin survives completion" behaviour', async () => {
    await seed([
      donePin('done an hour ago', 60 * MINUTE),
      donePin('done yesterday', DAY),
      donePin('done 2 days ago', 2 * DAY),
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.retired).toBe(0);
    expect(await titlesStillPinned()).toHaveLength(3);
    expect(report.oldestKept).toBe(iso(NOW - 2 * DAY));
  });

  it('deletes nothing and changes only the pin trio', async () => {
    await seed([
      donePin('retire me', 9 * DAY, {
        pin_order: 4, focus_tier: 'focus', note: 'a note worth keeping', group_id: 'grp_keep',
      }),
    ]);
    const before = (await listTasks())[0];

    await sweepPinRetirement({ nowMs: NOW });

    const all = await listTasks();
    expect(all).toHaveLength(1); // never deleted
    const after = all[0];
    expect(after.pinned).toBeFalsy();
    expect(after.pin_order).toBeUndefined();
    expect(after.focus_tier).toBeUndefined();
    // Everything else byte-identical, updated_at very much included: bumping it
    // would flood every recency surface with the junk we just retired.
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.completed_at).toBe(before.completed_at);
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
    expect(after.title).toBe(before.title);
    expect(after.note).toBe('a note worth keeping');
    expect(after.description).toBe(before.description);
    expect(after.group_id).toBe('grp_keep'); // payload siblings survive the pin_order clear
    expect(after.created_at).toBe(before.created_at);
  });

  it('leaves the row in exactly the state a hand unpin leaves it', async () => {
    const [task] = await seed([donePin('retire me', 9 * DAY, { focus_tier: 'focus' })]);
    await sweepPinRetirement({ nowMs: NOW });

    // togglePin refuses a NEW pin on a completed task, so the row is genuinely
    // off the board — the same end state as the user unpinning it by hand.
    await expect(togglePin(task.id)).rejects.toThrow(/Cannot pin a completed task/);
    // And the tier is gone, not parked "for history": togglePin's PIN branch
    // never writes focus_tier, so a leftover 'focus' would silently teleport the
    // row back into the Focus tier the next time anything re-pinned it.
    expect((await getTask(task.id)).focus_tier).toBeUndefined();
  });
});

describe('sweepPinRetirement — timestamps', () => {
  it('falls back to updated_at when completed_at was never written', async () => {
    await seed([
      { title: 'legacy old done', phase: 'COMPLETE', status: 'done', updated_at: iso(NOW - 8 * DAY) },
      { title: 'legacy fresh done', phase: 'COMPLETE', status: 'done', updated_at: iso(NOW - DAY) },
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.retired).toBe(1);
    expect(await titlesStillPinned()).toEqual(['legacy fresh done']);
  });

  it('keeps a completed pin whose timestamps are unparseable', async () => {
    await seed([
      { title: 'unknown age', phase: 'COMPLETE', status: 'done', completed_at: 'not a date', updated_at: 'nope' },
    ]);

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.candidates).toBe(0);
    expect(report.retired).toBe(0);
    expect(await titlesStillPinned()).toEqual(['unknown age']);
  });
});

describe('sweepPinRetirement — idempotence', () => {
  it('second run finds nothing and writes nothing', async () => {
    await seed([donePin('a', 9 * DAY), donePin('b', 9 * DAY), donePin('c', DAY)]);

    const first = await sweepPinRetirement({ nowMs: NOW });
    expect(first.retired).toBe(2);

    const events: unknown[] = [];
    bus.subscribe('pin-retirement-test', (e) => { events.push(e); }, { global: true, interest: ['task:'] });
    const second = await sweepPinRetirement({ nowMs: NOW });

    expect(second.candidates).toBe(0);
    expect(second.retired).toBe(0);
    expect(events).toHaveLength(0); // no event for a no-op sweep
    expect(await titlesStillPinned()).toEqual(['c']);
  });
});

describe('sweepPinRetirement — events and projection', () => {
  it('emits one bulk task:updated per chunk carrying the retired ids', async () => {
    const seeded = await seed([donePin('x', 9 * DAY), donePin('y', 9 * DAY), donePin('z', DAY)]);
    const retiredIds = seeded.filter((t) => t.title !== 'z').map((t) => t.id).sort();

    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    bus.subscribe('pin-retirement-test', (e) => {
      events.push({ name: e.name, data: (e.data ?? {}) as Record<string, unknown> });
    }, { global: true, interest: ['task:'] });

    await sweepPinRetirement({ nowMs: NOW });

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('task:updated');
    // The established bulk shape: no single `task`, an id list, and the exact
    // field set the mutation touched (scopes the replica-side patch).
    expect(events[0].data.task).toBeNull();
    expect((events[0].data.taskIds as string[]).slice().sort()).toEqual(retiredIds);
    expect(events[0].data.fields).toEqual(['pinned', 'pin_order', 'focus_tier']);
  });

  it('the task projection (phone + replica view) sees the unpin', async () => {
    // 5 days old: past the 3-day pin window, still inside the projection's own
    // 14-day done-retention, so the row is present and can be asserted on.
    await seed([donePin('retired pin', 5 * DAY, { focus_tier: 'focus', pin_order: 3 })]);

    const beforeRow = (await buildTaskProjection()).tasks.find((t) => t.title === 'retired pin');
    expect(beforeRow?.pinned).toBe(true);
    expect(beforeRow?.focus_tier).toBe('focus');

    await sweepPinRetirement({ nowMs: NOW });

    const afterRow = (await buildTaskProjection()).tasks.find((t) => t.title === 'retired pin');
    expect(afterRow).toBeDefined();          // still projected — never deleted
    expect(afterRow?.pinned).toBeUndefined(); // projectTask omits a falsy pin
    expect(afterRow?.pin_order).toBeUndefined();
    expect(afterRow?.focus_tier).toBeUndefined();
  });
});

describe('sweepPinRetirement — cloud replica', () => {
  it('is a no-op on a replica (primary owns task writes)', async () => {
    await seed([donePin('ancient', 90 * DAY)]);
    constantsMock.cloudMode = true;

    const report = await sweepPinRetirement({ nowMs: NOW });

    // `disabled: false` is what distinguishes the replica bail-out from the
    // knob-off bail-out — the knob is on, the box just isn't the writer.
    expect(report.disabled).toBe(false);
    expect(report.retired).toBe(0);
    expect(report.scanned).toBe(0);
    expect(await titlesStillPinned()).toEqual(['ancient']);
  });

  it('sweeps again once the same process is back on the primary', async () => {
    await seed([donePin('ancient', 90 * DAY)]);
    constantsMock.cloudMode = true;
    expect((await sweepPinRetirement({ nowMs: NOW })).retired).toBe(0);

    constantsMock.cloudMode = false;
    expect((await sweepPinRetirement({ nowMs: NOW })).retired).toBe(1);
    expect(await titlesStillPinned()).toEqual([]);
  });
});

describe('sweepPinRetirement — chunked backlog', () => {
  it('retires ~1200 pins in bounded chunks, yielding between writes', async () => {
    const OLD = 1180;
    const FRESH = 40;
    const fixtures: Fixture[] = [];
    for (let i = 0; i < OLD; i++) {
      fixtures.push(donePin(`old ${i}`, 8 * DAY, { pin_order: i, focus_tier: i % 3 === 0 ? 'focus' : undefined }));
    }
    for (let i = 0; i < FRESH; i++) {
      fixtures.push(donePin(`fresh ${i}`, 2 * DAY, { pin_order: OLD + i }));
    }
    // A handful of open pins to prove the batch loop never sweeps them up.
    for (let i = 0; i < 16; i++) {
      fixtures.push({ title: `open ${i}`, phase: 'TODO', pin_order: OLD + FRESH + i, updated_at: iso(NOW - 200 * DAY) });
    }
    await seed(fixtures);

    const events: number[] = [];
    bus.subscribe('pin-retirement-test', (e) => {
      events.push(((e.data as { taskIds?: string[] }).taskIds ?? []).length);
    }, { global: true, interest: ['task:'] });

    const report = await sweepPinRetirement({ nowMs: NOW });

    expect(report.scanned).toBe(OLD + FRESH + 16);
    expect(report.candidates).toBe(OLD);
    expect(report.retired).toBe(OLD);
    expect(report.stoppedEarly).toBe(false);
    // One bulk event per chunk, none larger than the chunk size.
    expect(events).toHaveLength(Math.ceil(OLD / PIN_RETIREMENT_CHUNK_SIZE));
    expect(Math.max(...events)).toBeLessThanOrEqual(PIN_RETIREMENT_CHUNK_SIZE);
    expect(events.reduce((a, b) => a + b, 0)).toBe(OLD);

    const stillPinned = await getPinnedTasks();
    expect(stillPinned).toHaveLength(FRESH + 16);
    expect(stillPinned.every((t) => t.title.startsWith('fresh ') || t.title.startsWith('open '))).toBe(true);
    // Nothing was deleted.
    expect(await listTasks()).toHaveLength(OLD + FRESH + 16);
  }, 60_000);

  it('stops on the tick budget and resumes on the next run', async () => {
    const TOTAL = 120;
    await seed(Array.from({ length: TOTAL }, (_, i) => donePin(`old ${i}`, 8 * DAY, { pin_order: i })));

    let chunks = 0;
    const first = await sweepPinRetirement({
      nowMs: NOW,
      chunkSize: 10,
      // Budget expires after two chunks — the periodic tick's overBudget().
      shouldStop: () => chunks++ >= 2,
    });

    expect(first.stoppedEarly).toBe(true);
    expect(first.retired).toBe(20);
    expect(await getPinnedTasks()).toHaveLength(TOTAL - 20);

    const second = await sweepPinRetirement({ nowMs: NOW });
    expect(second.stoppedEarly).toBe(false);
    expect(second.retired).toBe(TOTAL - 20);
    expect(await getPinnedTasks()).toHaveLength(0);
  }, 30_000);
});
