/**
 * Task projection — the v2 (category-removed) envelope contract.
 *
 * The projection is the ONLY data plane between the primary box and the cloud
 * companion (tasks.sqlite is gitignored), so `version` is a hard gate: a v1 file
 * whose rows were keyed by `category` must never be handed to a v2 reader. That
 * gate is what this file locks down — the plan named it as a risk with zero
 * coverage, because a silently mis-parsed projection is invisible data loss on
 * the replica, whereas an empty list is a visibly degraded state someone reports.
 *
 * Real files, real fs — only `constants` is redirected to a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-v2'));

import {
  PROJECTION_FILE,
  PROJECTION_VERSION,
  exportTaskProjection,
  readTaskProjection,
  projectTask,
} from '../../src/core/task-projection.js';
import { _resetForTesting, addTask, addTaskFull } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { Task } from '../../src/core/types.js';

/** Write a raw projection payload, bypassing the exporter (to forge old shapes). */
async function writeRawProjection(payload: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(PROJECTION_FILE), { recursive: true });
  await fsp.writeFile(PROJECTION_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(PROJECTION_FILE, 'utf-8')) as Record<string, unknown>;
}

async function wipe(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}

beforeEach(wipe);
afterEach(wipe);

describe('projection envelope (write side)', () => {
  it('stamps version 2 and an ISO exportedAt', async () => {
    await addTask({ title: 'Exported', project: 'Marina' });
    const count = await exportTaskProjection();
    expect(count).toBe(1);

    const raw = await readRaw();
    expect(raw.version).toBe(2);
    expect(PROJECTION_VERSION).toBe(2);
    expect(typeof raw.exportedAt).toBe('string');
    expect(Number.isFinite(Date.parse(raw.exportedAt as string))).toBe(true);
  });

  it('never emits a category key — project is the only grouping layer', async () => {
    await addTask({ title: 'In a project', project: 'Marina' });
    await addTask({ title: 'In Inbox' });
    await exportTaskProjection();

    const raw = await readRaw();
    const tasks = raw.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t).not.toHaveProperty('category');
      expect(typeof t.project).toBe('string');
    }
    // Inbox rides as '' — present-but-empty, not absent (readers group on it).
    expect(tasks.map((t) => t.project).sort()).toEqual(['', 'Marina']);

    // Nothing anywhere in the serialized file mentions category.
    expect(JSON.stringify(raw)).not.toContain('category');
  });

  it('projectTask keeps Inbox as "" and drops category from an over-supplied task', () => {
    const legacy = {
      id: 't1',
      title: 'Legacy row',
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      project: '',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      // A stale in-memory row could still carry this; the projector must not
      // forward it into the v2 wire shape.
      category: 'Work',
    } as unknown as Task;

    const projected = projectTask(legacy);
    expect(projected.project).toBe('');
    expect(projected).not.toHaveProperty('category');
  });
});

describe('done-retention scope', () => {
  /** A task completed years ago, optionally still on the pinned board. */
  async function seedAncientDone(title: string, pin?: { pin_order: number }): Promise<void> {
    const longAgo = '2020-01-02T00:00:00.000Z';
    await addTaskFull({
      title, project: 'Marina',
      status: 'done', phase: 'COMPLETE', priority: 'none', source: 'local',
      session_ids: [], description: '', summary: '', note: '',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: longAgo,
      completed_at: longAgo,
      ...(pin ? { pinned: true, pin_order: pin.pin_order } : {}),
    } as unknown as Parameters<typeof addTaskFull>[0]);
  }

  it('ages out done tasks past the 14-day cutoff — pinned rows included', async () => {
    // DELIBERATE: with completion no longer unpinning (2026-08-26), the
    // done-pin population only grows, so exempting pins from retention would
    // make the git-synced/bridge-pushed projection converge on "every task
    // ever". The phone board shows open pins + the last 14 days of finished
    // ones; older history stays on the full store surfaces.
    await seedAncientDone('Ancient pinned chore', { pin_order: 0 });
    await seedAncientDone('Ancient loose chore');

    await exportTaskProjection();
    const projection = await readTaskProjection();
    expect(projection).not.toBeNull();
    const titles = projection!.tasks.map((t) => t.title);
    expect(titles).not.toContain('Ancient pinned chore');
    expect(titles).not.toContain('Ancient loose chore');
  });
});

describe('readTaskProjection fail-closed gate', () => {
  it('round-trips a freshly exported v2 file', async () => {
    await addTask({ title: 'Round trip', project: 'Marina' });
    await exportTaskProjection();

    const parsed = await readTaskProjection();
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(2);
    expect(parsed!.tasks.map((t) => t.title)).toEqual(['Round trip']);
  });

  it('returns null for a version 1 payload (rows keyed by category)', async () => {
    await writeRawProjection({
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      tasks: [
        { id: 't1', title: 'v1 row', status: 'todo', phase: 'TODO', priority: 'none', category: 'Work', project: 'Marina', created_at: 'x', updated_at: 'x' },
      ],
    });
    expect(await readTaskProjection()).toBeNull();
  });

  it('returns null when version is missing entirely', async () => {
    await writeRawProjection({
      exportedAt: '2026-01-01T00:00:00.000Z',
      tasks: [{ id: 't1', title: 'no version', status: 'todo', phase: 'TODO', priority: 'none', project: '', created_at: 'x', updated_at: 'x' }],
    });
    expect(await readTaskProjection()).toBeNull();
  });

  it('returns null for a future version, a stringified version, and a non-array tasks field', async () => {
    const base = { exportedAt: '2026-01-01T00:00:00.000Z', tasks: [] };
    // Forward-incompatible: a v3 writer may have renamed fields again.
    await writeRawProjection({ ...base, version: 3 });
    expect(await readTaskProjection()).toBeNull();
    // Strict equality, so "2" is not 2 — a loose check would let a text-mangled
    // file through and mis-type every row.
    await writeRawProjection({ ...base, version: '2' });
    expect(await readTaskProjection()).toBeNull();
    await writeRawProjection({ version: 2, exportedAt: 'x', tasks: { nope: true } });
    expect(await readTaskProjection()).toBeNull();
  });

  it('returns null for a missing file and for corrupt JSON', async () => {
    expect(await readTaskProjection()).toBeNull();

    await fsp.mkdir(path.dirname(PROJECTION_FILE), { recursive: true });
    await fsp.writeFile(PROJECTION_FILE, '{ not json', 'utf-8');
    expect(await readTaskProjection()).toBeNull();
  });

  it('re-exporting over a rejected v1 file heals the reader', async () => {
    await writeRawProjection({ version: 1, exportedAt: 'x', tasks: [{ id: 'old' }] });
    expect(await readTaskProjection()).toBeNull();

    await addTask({ title: 'After upgrade', project: 'Marina' });
    await exportTaskProjection();

    const parsed = await readTaskProjection();
    expect(parsed!.version).toBe(2);
    expect(parsed!.tasks.map((t) => t.title)).toEqual(['After upgrade']);
  });
});
