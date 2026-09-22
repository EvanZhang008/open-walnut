import { describe, expect, it } from 'vitest';
import { moveNavigationId, orderedNavigationIds } from '../../web/src/components/tasks/navigation-order';

describe('navigation ordering', () => {
  const tiers = ['focus', 'satellite', 'backlog', 'wait'];
  it('keeps all builtin tiers when storage is missing or malformed', () => {
    for (const saved of [null, {}, 'focus', 42]) expect(orderedNavigationIds(saved, tiers)).toEqual(tiers);
  });
  it('keeps a saved order, removes duplicates and deleted tiers, and appends new tiers', () => {
    expect(orderedNavigationIds(['wait', 'ct_removed', 'wait', 4, 'focus'], [...tiers, 'ct_new']))
      .toEqual(['wait', 'focus', 'satellite', 'backlog', 'ct_new']);
  });
  it('moves one identifier without mutating the original order', () => {
    expect(moveNavigationId(tiers, 'wait', 'focus')).toEqual(['wait', 'focus', 'satellite', 'backlog']);
    expect(moveNavigationId(tiers, 'focus', 'wait')).toEqual(['satellite', 'backlog', 'wait', 'focus']);
    expect(tiers).toEqual(['focus', 'satellite', 'backlog', 'wait']);
  });
  it('does not invent entries when an item disappears before the drop', () => {
    expect(moveNavigationId(tiers, 'ct_removed', 'focus')).toEqual(tiers);
    expect(moveNavigationId(tiers, 'focus', 'ct_removed')).toEqual(tiers);
    expect(moveNavigationId(tiers, 'focus', 'focus')).toEqual(tiers);
  });
});
