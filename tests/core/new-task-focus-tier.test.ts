/**
 * Pin TIER at create time (2026-08-27).
 *
 * Before this, `AddTaskInput` carried only a boolean `pinned`, so every surface
 * that wanted a non-Satellite tier had to create the task and then call
 * setFocusTier — two writes, and a failed second one silently dropped the task
 * out of the tier the user picked. `focus_tier` closes that: the tier rides the
 * create.
 *
 * The contract this locks in:
 *   - `focus_tier` IMPLIES pinned (a tier on an unpinned row is invisible), so
 *     a tier with no `pinned` still lands pinned.
 *   - `pinned: false` + a tier is a CONTRADICTION → InvalidFocusTierError, not
 *     a silently-honored half.
 *   - 'satellite' normalizes AWAY: stored as pinned with NO focus_tier, which
 *     is what splitTiers/focusTierMatches read as Satellite.
 *   - An unknown tier (including a ct_* that isn't registered) THROWS. A
 *     confident wrong answer (quietly filing it in Satellite) is worse.
 *   - Placement is unchanged: bottom of the pinned set, like togglePin.
 *   - Omitting the field is byte-for-byte the old behavior — the no-regression
 *     guarantee for bulk importers and provider sync, which must never flood
 *     the board.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask, getTask, getPinnedTasks, getTierSplit, createCustomTier,
  resolveNewTaskTier, InvalidFocusTierError,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeEach(async () => {
  closeDb();
  resetTaskManager();
  await rmWalnutHome();
});

afterEach(async () => {
  bus.clear();
  closeDb();
  await rmWalnutHome();
});

// ── The pure resolver (no store, no lock) ──────────────────────────────────
// Exported so the HTTP edges validate with the same rules that write; these
// cases are the whole contract in one table.

describe('resolveNewTaskTier', () => {
  it('passes an omitted tier straight through to the plain pinned decision', () => {
    expect(resolveNewTaskTier({}, [])).toEqual({ pinned: false });
    expect(resolveNewTaskTier({ pinned: true }, [])).toEqual({ pinned: true });
    expect(resolveNewTaskTier({ pinned: false }, [])).toEqual({ pinned: false });
    // '' / whitespace is the shape a client sends when its picker was never
    // touched — it must read as "not specified", not as a tier.
    expect(resolveNewTaskTier({ pinned: true, focus_tier: '' }, [])).toEqual({ pinned: true });
    expect(resolveNewTaskTier({ focus_tier: '   ' }, [])).toEqual({ pinned: false });
  });

  it('stores each non-default built-in verbatim', () => {
    for (const tier of ['focus', 'backlog', 'wait']) {
      expect(resolveNewTaskTier({ pinned: true, focus_tier: tier }, []))
        .toEqual({ pinned: true, focus_tier: tier });
    }
  });

  it('normalizes satellite to pinned-with-no-stored-tier', () => {
    expect(resolveNewTaskTier({ pinned: true, focus_tier: 'satellite' }, []))
      .toEqual({ pinned: true });
    // Same answer with `pinned` omitted — the tier implies it.
    expect(resolveNewTaskTier({ focus_tier: 'satellite' }, [])).toEqual({ pinned: true });
  });

  it('infers pinned from the tier alone', () => {
    expect(resolveNewTaskTier({ focus_tier: 'focus' }, []))
      .toEqual({ pinned: true, focus_tier: 'focus' });
  });

  it('accepts a REGISTERED ct_* and rejects an unregistered one', () => {
    expect(resolveNewTaskTier({ focus_tier: 'ct_abc12345' }, ['ct_abc12345']))
      .toEqual({ pinned: true, focus_tier: 'ct_abc12345' });
    expect(() => resolveNewTaskTier({ focus_tier: 'ct_ghost999' }, ['ct_abc12345']))
      .toThrow(InvalidFocusTierError);
  });

  it('rejects an unknown tier rather than guessing Satellite', () => {
    // 'next' is a RETIRED tier value that legacy rows still carry — readers fold
    // it into Satellite, but accepting it on a fresh create would mint new junk.
    for (const tier of ['next', 'Focus', 'FOCUS', 'urgent', 'ct_', 'todo']) {
      expect(() => resolveNewTaskTier({ focus_tier: tier }, []), tier)
        .toThrow(InvalidFocusTierError);
    }
  });

  it('rejects the pinned:false + tier contradiction outright', () => {
    expect(() => resolveNewTaskTier({ pinned: false, focus_tier: 'focus' }, []))
      .toThrow(/contradicts pinned: false/);
    // Even 'satellite', which stores nothing, is still a board statement.
    expect(() => resolveNewTaskTier({ pinned: false, focus_tier: 'satellite' }, []))
      .toThrow(InvalidFocusTierError);
  });

  it('carries the offending value on the error for the routes to echo', () => {
    try {
      resolveNewTaskTier({ focus_tier: 'nonsense' }, []);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFocusTierError);
      expect((err as InvalidFocusTierError).tier).toBe('nonsense');
      // The valid list is in the message so a caller can fix it in one round trip.
      expect((err as InvalidFocusTierError).message).toContain('focus');
      expect((err as InvalidFocusTierError).message).toContain('wait');
    }
  });
});

// ── addTask: the tier actually lands, in ONE write ─────────────────────────

describe('addTask({ focus_tier })', () => {
  it('lands the task in the named built-in tier on create', async () => {
    const { task } = await addTask({ title: 'Work on this now', pinned: true, focus_tier: 'focus' });

    // The returned object is what the create surfaces echo back, so it must
    // already carry the final state — no re-read required.
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBe('focus');

    const stored = await getTask(task.id);
    expect(stored.pinned).toBe(true);
    expect(stored.focus_tier).toBe('focus');

    const split = await getTierSplit();
    expect(split.focus_tasks).toEqual([task.id]);
    expect(split.satellite_tasks).toEqual([]);
  });

  it('serves every non-default built-in', async () => {
    const focus = await addTask({ title: 'F', pinned: true, focus_tier: 'focus' });
    const backlog = await addTask({ title: 'B', pinned: true, focus_tier: 'backlog' });
    const wait = await addTask({ title: 'W', pinned: true, focus_tier: 'wait' });

    const split = await getTierSplit();
    expect(split.focus_tasks).toEqual([focus.task.id]);
    expect(split.backlog_tasks).toEqual([backlog.task.id]);
    expect(split.wait_tasks).toEqual([wait.task.id]);
    expect(split.satellite_tasks).toEqual([]);
  });

  it('stores satellite as pinned with NO focus_tier (the reader convention)', async () => {
    const { task } = await addTask({ title: 'Soon', pinned: true, focus_tier: 'satellite' });

    const stored = await getTask(task.id);
    expect(stored.pinned).toBe(true);
    // The literal string must never reach the row — splitTiers keys Satellite
    // off the ABSENCE of a value.
    expect(stored.focus_tier).toBeUndefined();

    const split = await getTierSplit();
    expect(split.satellite_tasks).toEqual([task.id]);
  });

  it('pins the task from the tier alone (no explicit pinned needed)', async () => {
    const { task } = await addTask({ title: 'Tier implies pin', focus_tier: 'wait' });

    const stored = await getTask(task.id);
    expect(stored.pinned).toBe(true);
    expect(stored.focus_tier).toBe('wait');
    expect(typeof stored.pin_order).toBe('number');
    expect((await getTierSplit()).wait_tasks).toEqual([task.id]);
  });

  it('accepts a registered custom tier and rejects a bogus ct_*', async () => {
    const { tier } = await createCustomTier('Errands');

    const { task } = await addTask({ title: 'In a custom tier', focus_tier: tier.id });
    const stored = await getTask(task.id);
    expect(stored.focus_tier).toBe(tier.id);
    expect((await getTierSplit()).custom_tier_tasks[tier.id]).toEqual([task.id]);
    // A custom-tier row is NOT Satellite.
    expect((await getTierSplit()).satellite_tasks).toEqual([]);

    await expect(addTask({ title: 'Ghost tier', focus_tier: 'ct_notreal1' }))
      .rejects.toThrow(InvalidFocusTierError);
  });

  it('writes NOTHING when the tier is unknown — the whole create fails', async () => {
    await expect(addTask({ title: 'Should not exist', focus_tier: 'urgent' }))
      .rejects.toThrow(/unknown focus_tier "urgent"/);

    // Not a half-created task, not an orphan project row: the throw happens
    // before the store write.
    const split = await getTierSplit();
    expect(split.pinned_tasks).toEqual([]);
    const { listTasks } = await import('../../src/core/task-manager.js');
    expect(await listTasks()).toEqual([]);
  });

  it('refuses the pinned:false + tier contradiction at the core boundary', async () => {
    await expect(addTask({ title: 'Contradiction', pinned: false, focus_tier: 'focus' }))
      .rejects.toThrow(InvalidFocusTierError);
  });

  it('appends each new tiered pin to the BOTTOM of the pinned set', async () => {
    // Placement must not depend on the tier — pin_order is ONE board-wide
    // sequence (that is what makes hand-arranged order survive a new arrival).
    const a = await addTask({ title: 'First', pinned: true });
    const b = await addTask({ title: 'Second', focus_tier: 'focus' });
    const c = await addTask({ title: 'Third', focus_tier: 'wait' });

    const pinned = await getPinnedTasks();
    expect(pinned.map((t) => t.id)).toEqual([a.task.id, b.task.id, c.task.id]);
    expect(pinned.map((t) => t.pin_order)).toEqual([0, 1, 2]);
  });

  it('keeps today\'s behavior byte-for-byte when the field is omitted', async () => {
    // The bulk-importer / provider-sync contract: silence means UNPINNED, no
    // tier, no pin_order. This is the no-regression guard — a create with no
    // opinion must not gain a board slot because create-time tiers exist now.
    const { task } = await addTask({ title: 'Imported holder' });

    const stored = await getTask(task.id);
    expect(stored.pinned).toBeFalsy();
    expect(stored.pin_order).toBeUndefined();
    expect(stored.focus_tier).toBeUndefined();
    expect((await getTierSplit()).pinned_tasks).toEqual([]);

    // …and pinned:true with no tier is still Satellite, exactly as before.
    const { task: pinnedOnly } = await addTask({ title: 'Board default', pinned: true });
    const storedPin = await getTask(pinnedOnly.id);
    expect(storedPin.pinned).toBe(true);
    expect(storedPin.focus_tier).toBeUndefined();
    expect((await getTierSplit()).satellite_tasks).toEqual([pinnedOnly.id]);
  });

  it('is ONE store write: the create alone leaves the task fully tiered', async () => {
    // The whole point of the field. If this ever needed a follow-up write, a
    // failure of that write would silently drop the task out of the picked
    // tier — the bug this replaced. Proven by reading the tier split with no
    // intervening call of any kind.
    const { task } = await addTask({ title: 'One write', focus_tier: 'backlog' });
    expect((await getTierSplit()).backlog_tasks).toEqual([task.id]);
  });
});
