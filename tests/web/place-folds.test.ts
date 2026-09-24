/**
 * Per-place fold records (web/src/components/tasks/place-folds.ts): a row shown in
 * several places folds only where it was clicked, and an old shared record converts
 * without opening anything that was folded.
 */
import { describe, it, expect } from 'vitest';
import {
  foldKey, foldedId, isFoldedAt, pruneFolds, readFolds, saveFolds, toggleFold, unfold,
} from '../../web/src/components/tasks/place-folds';

const TIERS = ['focus', 'satellite', 'wait'];

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    map,
  };
}

describe('place folds', () => {
  it('folds one place and leaves the same row elsewhere open', () => {
    const folds = toggleFold(new Set(), 'satellite', 'Orchard', TIERS);
    expect(isFoldedAt(folds, 'satellite', 'Orchard')).toBe(true);
    expect(isFoldedAt(folds, 'focus', 'Orchard')).toBe(false);
    expect(isFoldedAt(toggleFold(folds, 'satellite', 'Orchard', TIERS), 'satellite', 'Orchard')).toBe(false);
  });

  it('reads an old shared record as folded everywhere, then splits it on the first click', () => {
    const storage = memoryStorage({ legacy: JSON.stringify(['Meadowlark', '']) });
    const folds = readFolds('current', 'legacy', storage);
    for (const tier of TIERS) expect(isFoldedAt(folds, tier, 'Meadowlark')).toBe(true);
    // Inbox is the empty project name, and survives the conversion.
    expect(isFoldedAt(folds, 'wait', '')).toBe(true);
    const opened = toggleFold(folds, 'satellite', 'Meadowlark', TIERS);
    expect(isFoldedAt(opened, 'satellite', 'Meadowlark')).toBe(false);
    expect(isFoldedAt(opened, 'focus', 'Meadowlark')).toBe(true);
    expect(isFoldedAt(opened, 'wait', 'Meadowlark')).toBe(true);
    // The other converted row is untouched.
    expect(isFoldedAt(opened, 'focus', '')).toBe(true);
  });

  it('prefers the current record once it exists, even an empty one, and never writes the old key', () => {
    const storage = memoryStorage({ legacy: JSON.stringify(['Meadowlark']), current: '[]' });
    expect([...readFolds('current', 'legacy', storage)]).toEqual([]);
    saveFolds('current', new Set([foldKey('focus', 'Orchard')]), storage);
    expect(storage.map.get('legacy')).toBe(JSON.stringify(['Meadowlark']));
    expect([...readFolds('current', 'legacy', storage)]).toEqual([foldKey('focus', 'Orchard')]);
  });

  it('treats unreadable storage as nothing folded', () => {
    expect([...readFolds('current', 'legacy', memoryStorage({ current: '{not json' }))]).toEqual([]);
    expect([...readFolds('current', 'legacy', { getItem: () => { throw new Error('denied'); } })]).toEqual([]);
  });

  it('unfolds one place only, including out of an every-place fold', () => {
    let folds: ReadonlySet<string> = new Set([foldKey('focus', 'Orchard'), foldKey('satellite', 'Orchard'), foldKey('*', 'Juniper')]);
    folds = unfold(folds, 'Orchard', 'focus', TIERS);
    expect(isFoldedAt(folds, 'focus', 'Orchard')).toBe(false);
    expect(isFoldedAt(folds, 'satellite', 'Orchard')).toBe(true);
    folds = unfold(folds, 'Juniper', 'wait', TIERS);
    expect(isFoldedAt(folds, 'wait', 'Juniper')).toBe(false);
    expect(isFoldedAt(folds, 'focus', 'Juniper')).toBe(true);
    // Nothing to open hands back the same set, so a state setter can bail out.
    expect(unfold(folds, 'Orchard', 'wait', TIERS)).toBe(folds);
  });

  it('prunes by the id each key names, including every-place folds', () => {
    const folds = new Set([foldKey('focus', 'Orchard'), foldKey('*', 'Gone'), foldKey('wait', 'Gone')]);
    const live = new Set(['Orchard']);
    const pruned = pruneFolds(folds, (key) => live.has(foldedId(key)));
    expect([...pruned]).toEqual([foldKey('focus', 'Orchard')]);
    expect(pruneFolds(pruned, (key) => live.has(foldedId(key)))).toBe(pruned);
  });

  it('keeps project names with punctuation and non-Latin text intact', () => {
    // An em dash and two CJK characters, escaped.
    const name = 'Ops: Q3 / infra \u2014 \u6e2c\u8a66';
    const folds = toggleFold(new Set(), 'ct_later', name, [...TIERS, 'ct_later']);
    expect(isFoldedAt(folds, 'ct_later', name)).toBe(true);
    expect(foldedId([...folds][0])).toBe(name);
  });
});
