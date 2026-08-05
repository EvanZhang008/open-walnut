/**
 * Custom focus tiers — registry CRUD, tier membership, and self-healing.
 *
 * Custom tiers are user-defined pin tiers alongside the built-ins
 * (focus/satellite/backlog/wait). Registry rows live in the custom_tiers table
 * (store.custom_tiers); membership lives on tasks.focus_tier as the tier's
 * ct_* id. Tasks whose focus_tier references a deleted/unknown tier self-heal
 * to satellite (the tier-less default).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  getTask,
  togglePin,
  setFocusTier,
  getCustomTiers,
  createCustomTier,
  renameCustomTier,
  deleteCustomTier,
  updateTaskRaw,
  reorderPins,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

/** rm with retries — WAL checkpoint files can reappear mid-delete (ENOTEMPTY). */
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
  // closeDb BEFORE rm: the db is a module-level singleton — deleting the file
  // under a live handle leaves it on an unlinked inode (state leaks across tests).
  closeDb();
  resetTaskManager();
  await rmWalnutHome();
});

afterEach(async () => {
  bus.clear();
  closeDb();
  await rmWalnutHome();
});

async function makePinnedTask(title: string): Promise<string> {
  const { task } = await addTask({ title, project: 'Local' });
  await togglePin(task.id);
  return task.id;
}

describe('custom tier registry CRUD', () => {
  it('starts empty', async () => {
    expect(await getCustomTiers()).toEqual([]);
  });

  it('creates a tier with a ct_* id and persists it in order', async () => {
    const { tier, tiers } = await createCustomTier('Icebox');
    expect(tier.id).toMatch(/^ct_[a-z0-9]{8}$/);
    expect(tier.label).toBe('Icebox');
    expect(tiers).toEqual([tier]);

    const { tier: second } = await createCustomTier('Someday');
    const listed = await getCustomTiers();
    expect(listed.map((t) => t.label)).toEqual(['Icebox', 'Someday']);
    expect(second.id).not.toBe(tier.id);
  });

  it('trims the label on create', async () => {
    const { tier } = await createCustomTier('  Icebox  ');
    expect(tier.label).toBe('Icebox');
  });

  it('rejects an empty label', async () => {
    await expect(createCustomTier('')).rejects.toThrow('Tier label cannot be empty');
    await expect(createCustomTier('   ')).rejects.toThrow('Tier label cannot be empty');
  });

  it('rejects a label longer than 40 chars', async () => {
    await expect(createCustomTier('x'.repeat(41))).rejects.toThrow('too long');
    await expect(createCustomTier('x'.repeat(40))).resolves.toBeTruthy();
  });

  it('rejects duplicate labels case-insensitively', async () => {
    await createCustomTier('Icebox');
    await expect(createCustomTier('icebox')).rejects.toThrow('already exists');
    await expect(createCustomTier('  ICEBOX ')).rejects.toThrow('already exists');
  });

  it('rejects labels that collide with built-in tiers', async () => {
    for (const label of ['focus', 'Satellite', 'Backlog', 'WAIT']) {
      await expect(createCustomTier(label)).rejects.toThrow('conflicts with a built-in tier');
    }
  });

  it('rejects reserved section names and ct_-prefixed labels', async () => {
    // Section tabs share the strip with tier tabs — "Recent" would render twice.
    for (const label of ['Recent', 'ALL', 'tasks', 'Pinned', 'notes']) {
      await expect(createCustomTier(label)).rejects.toThrow('reserved section name');
    }
    // A ct_*-shaped label would collide with the id space in id-or-label resolution.
    await expect(createCustomTier('ct_abc12345')).rejects.toThrow('reserved prefix');
    await expect(createCustomTier('CT_whatever')).rejects.toThrow('reserved prefix');
  });

  it('collapses internal whitespace (incl. newlines) in labels', async () => {
    // Labels are interpolated line-by-line into the quick-parse system prompt —
    // embedded newlines would break its rule structure.
    const { tier } = await createCustomTier('Deep\n  Work\tQueue');
    expect(tier.label).toBe('Deep Work Queue');
  });

  it('caps the registry at 20 tiers', async () => {
    for (let i = 0; i < 20; i++) await createCustomTier(`Tier ${i}`);
    await expect(createCustomTier('One more')).rejects.toThrow('Too many custom tiers');
  });

  it('emits config:changed{focus_tiers} on create', async () => {
    const events: string[] = [];
    bus.subscribe('tier-probe', (event) => {
      if (event.name !== EventNames.CONFIG_CHANGED) return;
      events.push((event.data as { key?: string }).key ?? '');
    }, { global: true });
    await createCustomTier('Icebox');
    expect(events).toContain('focus_tiers');
  });

  it('renames a tier with the same validation, excluding self', async () => {
    const { tier } = await createCustomTier('Icebox');
    await createCustomTier('Someday');

    // Re-saving its own label (case change) is allowed — self is excluded.
    const { tier: renamed } = await renameCustomTier(tier.id, 'ICEBOX');
    expect(renamed).toEqual({ id: tier.id, label: 'ICEBOX' });

    await expect(renameCustomTier(tier.id, 'someday')).rejects.toThrow('already exists');
    await expect(renameCustomTier(tier.id, 'wait')).rejects.toThrow('built-in');
    await expect(renameCustomTier(tier.id, 'Backlog')).rejects.toThrow('built-in');
    await expect(renameCustomTier(tier.id, '')).rejects.toThrow('empty');
  });

  it('rename of an unknown id throws Tier not found', async () => {
    await expect(renameCustomTier('ct_missing1', 'Anything')).rejects.toThrow('Tier not found: ct_missing1');
  });

  it('delete of an unknown id throws Tier not found', async () => {
    await expect(deleteCustomTier('ct_missing1')).rejects.toThrow('Tier not found: ct_missing1');
  });
});

describe('deleteCustomTier task migration', () => {
  it('moves member tasks back to satellite and reports the count', async () => {
    const { tier } = await createCustomTier('Icebox');
    const a = await makePinnedTask('In custom A');
    const b = await makePinnedTask('In custom B');
    const c = await makePinnedTask('Stays in focus');
    await setFocusTier(a, tier.id);
    await setFocusTier(b, tier.id);
    await setFocusTier(c, 'focus');

    const updatedEvents: string[] = [];
    const configKeys: string[] = [];
    bus.subscribe('delete-probe', (event) => {
      if (event.name === EventNames.TASK_UPDATED) {
        updatedEvents.push((event.data as { task: { id: string } }).task.id);
      }
      if (event.name === EventNames.CONFIG_CHANGED) {
        configKeys.push((event.data as { key?: string }).key ?? '');
      }
    }, { global: true });

    const result = await deleteCustomTier(tier.id);
    expect(result.moved).toBe(2);
    expect(result.tiers).toEqual([]);

    // Members healed to satellite (field cleared); the focus task untouched.
    expect((await getTask(a)).focus_tier).toBeUndefined();
    expect((await getTask(b)).focus_tier).toBeUndefined();
    expect((await getTask(c)).focus_tier).toBe('focus');

    // One TASK_UPDATED per moved task + both config keys.
    expect(updatedEvents.sort()).toEqual([a, b].sort());
    expect(configKeys).toContain('focus_tiers');
    expect(configKeys).toContain('focus_bar');
  });

  it('reports moved=0 when the tier is empty', async () => {
    const { tier } = await createCustomTier('Icebox');
    const result = await deleteCustomTier(tier.id);
    expect(result.moved).toBe(0);
  });
});

describe('splitTiers custom buckets (via reorderPins TierResult)', () => {
  it('buckets tasks under their registered custom tier, in pin order', async () => {
    const { tier } = await createCustomTier('Icebox');
    const a = await makePinnedTask('Custom A');
    const b = await makePinnedTask('Custom B');
    const sat = await makePinnedTask('Satellite task');
    await setFocusTier(a, tier.id);
    await setFocusTier(b, tier.id);

    const result = await reorderPins([a, b, sat]);
    expect(result.custom_tier_tasks).toEqual({ [tier.id]: [a, b] });
    expect(result.satellite_tasks).toEqual([sat]);
    expect(result.pinned_tasks).toEqual([a, b, sat]);
  });

  it('buckets backlog as a built-in tier, not satellite or custom', async () => {
    const bl = await makePinnedTask('Backlog task');
    const sat = await makePinnedTask('Satellite task');
    await setFocusTier(bl, 'backlog');

    const result = await reorderPins([bl, sat]);
    expect(result.backlog_tasks).toEqual([bl]);
    expect(result.satellite_tasks).toEqual([sat]);
    expect(result.custom_tier_tasks).toEqual({});
  });

  it('a stale (unregistered) focus_tier id falls into satellite', async () => {
    const id = await makePinnedTask('Stale tier task');
    // Write the stale id directly — mirrors data left behind by an old registry
    // (updateTaskRaw bypasses setFocusTier's validation like sync paths do).
    await updateTaskRaw(id, { focus_tier: 'ct_deleted1' });

    const result = await reorderPins([id]);
    expect(result.satellite_tasks).toContain(id);
    expect(result.custom_tier_tasks).toEqual({});
    expect(result.focus_tasks).not.toContain(id);
    expect(result.backlog_tasks).not.toContain(id);
    expect(result.wait_tasks).not.toContain(id);
  });
});

describe('setFocusTier with custom tiers', () => {
  it('accepts a registered custom tier id', async () => {
    const { tier } = await createCustomTier('Icebox');
    const id = await makePinnedTask('Goes custom');
    const result = await setFocusTier(id, tier.id);
    expect((await getTask(id)).focus_tier).toBe(tier.id);
    expect(result.custom_tier_tasks[tier.id]).toContain(id);
    expect(result.satellite_tasks).not.toContain(id);
  });

  it('self-heals an unknown tier id to satellite without throwing', async () => {
    const id = await makePinnedTask('Stale send');
    await setFocusTier(id, 'focus');
    // Stale id (e.g. a fork copying a deleted tier) must not throw — it lands
    // in satellite (field cleared).
    const result = await setFocusTier(id, 'ct_gonegone');
    expect((await getTask(id)).focus_tier).toBeUndefined();
    expect(result.satellite_tasks).toContain(id);
  });

  it('still validates task existence and pinnedness', async () => {
    await expect(setFocusTier('no-such-task', 'focus')).rejects.toThrow('Task not found');
    const { task } = await addTask({ title: 'Unpinned', project: 'Local' });
    await expect(setFocusTier(task.id, 'focus')).rejects.toThrow('not pinned');
  });
});
