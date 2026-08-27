import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEntityLabelsVersion,
  lookupSessionTitle,
  lookupTaskLabel,
  peekTaskLabel,
  registerSessionTitle,
  resetEntityLabelsForTesting,
  subscribeEntityLabels,
  syncTasks,
} from '@/stores/entity-label-store';

/**
 * Contract tests for the entity-label store — the id→title source of truth
 * behind <task-ref/> pill rendering. The load-bearing invariants:
 *
 * 1. Version bumps are gated on OBSERVED ids: task churn that never rendered
 *    a pill must not invalidate the markdown LRU (render-storm protection).
 * 2. Render-path lookups never notify (an emit during render is a loop).
 * 3. Unchanged labels keep object identity across syncs, or useTaskLabel's
 *    useSyncExternalStore snapshot would thrash.
 */

describe('entity-label-store', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
  });

  it('rename of an UNOBSERVED id does not bump the version', () => {
    syncTasks([{ id: 't-1', title: 'Old' }]);
    const v = getEntityLabelsVersion();
    syncTasks([{ id: 't-1', title: 'New' }]);
    expect(getEntityLabelsVersion()).toBe(v);
    // The data still updated — only the notification was suppressed.
    expect(peekTaskLabel('t-1')?.title).toBe('New');
  });

  it('rename of an OBSERVED id bumps the version and notifies', () => {
    syncTasks([{ id: 't-1', title: 'Old' }]);
    expect(lookupTaskLabel('t-1')?.title).toBe('Old');
    const v = getEntityLabelsVersion();
    let notified = 0;
    const unsub = subscribeEntityLabels(() => notified++);
    syncTasks([{ id: 't-1', title: 'New' }]);
    unsub();
    expect(getEntityLabelsVersion()).toBe(v + 1);
    expect(notified).toBe(1);
  });

  it('boot race: an observed-but-missing id arriving later bumps the version', () => {
    expect(lookupTaskLabel('t-late')).toBeUndefined(); // pill rendered before task fetch
    const v = getEntityLabelsVersion();
    syncTasks([{ id: 't-late', title: 'Arrived' }]);
    expect(getEntityLabelsVersion()).toBe(v + 1);
    expect(lookupTaskLabel('t-late')?.title).toBe('Arrived');
  });

  it('lookup misses never notify (render-path safety)', () => {
    let notified = 0;
    const unsub = subscribeEntityLabels(() => notified++);
    lookupTaskLabel('t-miss');
    lookupSessionTitle('s-miss');
    unsub();
    expect(notified).toBe(0);
  });

  it('no-op sync keeps version AND label object identity', () => {
    syncTasks([{ id: 't-1', title: 'Same', project: 'P' }]);
    lookupTaskLabel('t-1');
    const v = getEntityLabelsVersion();
    const before = peekTaskLabel('t-1');
    // Fresh array + fresh task objects, identical content (the WS echo shape).
    syncTasks([{ id: 't-1', title: 'Same', project: 'P' }]);
    expect(getEntityLabelsVersion()).toBe(v);
    expect(peekTaskLabel('t-1')).toBe(before);
  });

  it('deletion sweep drops ids missing from the incoming list (+bump when observed)', () => {
    syncTasks([{ id: 't-1', title: 'A' }, { id: 't-2', title: 'B' }]);
    lookupTaskLabel('t-2');
    const v = getEntityLabelsVersion();
    syncTasks([{ id: 't-1', title: 'A' }]);
    expect(getEntityLabelsVersion()).toBe(v + 1);
    expect(peekTaskLabel('t-2')).toBeUndefined();
  });

  it('deletion sweep still runs when skipped (titleless) rows pad the list length', () => {
    syncTasks([{ id: 't-1', title: 'A' }, { id: 't-2', title: 'B' }]);
    lookupTaskLabel('t-2');
    // t-2 deleted; two titleless rows keep tasks.length above the map size.
    syncTasks([{ id: 't-1', title: 'A' }, { id: 't-x', title: '' }, { id: 't-y', title: '' }]);
    expect(peekTaskLabel('t-2')).toBeUndefined();
  });

  it('tasks without id or title are ignored', () => {
    syncTasks([{ id: '', title: 'No id' }, { id: 't-ok', title: 'OK' }, { id: 't-no-title', title: '' }]);
    expect(peekTaskLabel('t-ok')?.title).toBe('OK');
    expect(peekTaskLabel('t-no-title')).toBeUndefined();
  });

  it('registerSessionTitle: same title is a no-op, observed change bumps', () => {
    registerSessionTitle('s-1', 'Title');
    expect(lookupSessionTitle('s-1')).toBe('Title');
    const v = getEntityLabelsVersion();
    registerSessionTitle('s-1', 'Title');
    expect(getEntityLabelsVersion()).toBe(v);
    registerSessionTitle('s-1', 'Renamed');
    expect(getEntityLabelsVersion()).toBe(v + 1);
    expect(lookupSessionTitle('s-1')).toBe('Renamed');
  });

  it('registerSessionTitle ignores empty/missing titles', () => {
    registerSessionTitle('s-1', '');
    registerSessionTitle('s-2', undefined);
    expect(lookupSessionTitle('s-1')).toBeUndefined();
    expect(lookupSessionTitle('s-2')).toBeUndefined();
  });

  it('resetEntityLabelsForTesting clears everything and bumps', () => {
    syncTasks([{ id: 't-1', title: 'A' }]);
    registerSessionTitle('s-1', 'S');
    const v = getEntityLabelsVersion();
    resetEntityLabelsForTesting();
    expect(getEntityLabelsVersion()).toBe(v + 1);
    expect(peekTaskLabel('t-1')).toBeUndefined();
    expect(lookupSessionTitle('s-1')).toBeUndefined();
  });
});
