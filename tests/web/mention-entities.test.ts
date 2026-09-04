/**
 * Unit tests for the "@" palette's entity ranking (mention-entities.ts): the
 * instant local fuzzy layer, how the hybrid-search hits fold into it, and the
 * shared row budget that keeps every non-empty group visible at once.
 */
import { describe, it, expect } from 'vitest';
import {
  rankEntities,
  mergeServerHits,
  groupRowBudget,
  type MentionEntity,
} from '../../web/src/components/chat/mention-entities';

const task = (over: Partial<MentionEntity>): MentionEntity => ({
  kind: 'task',
  id: 'mt000000-0000',
  title: 'Untitled',
  meta: 'TODO · Inbox',
  active: true,
  recencyKey: '2026-08-01T00:00:00Z',
  ...over,
});

describe('rankEntities', () => {
  it('empty query: pinned first, then active, then most recent', () => {
    const items = [
      task({ id: 'a', title: 'Old done', active: false, recencyKey: '2026-08-20T00:00:00Z' }),
      task({ id: 'b', title: 'Recent active', recencyKey: '2026-08-28T00:00:00Z' }),
      task({ id: 'c', title: 'Pinned but older', pinned: true, recencyKey: '2026-08-10T00:00:00Z' }),
      task({ id: 'd', title: 'Older active', recencyKey: '2026-08-15T00:00:00Z' }),
    ];
    expect(rankEntities('', items).map((r) => r.entity.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(rankEntities('', items)[0]).toMatchObject({ matchField: null, positions: [], source: 'local' });
  });

  it('fuzzy-matches the title with highlight positions and drops non-matches', () => {
    const items = [
      task({ id: 'a', title: 'Fix OAuth callback 401' }),
      task({ id: 'b', title: 'Board refresh storm' }),
    ];
    const ranked = rankEntities('oauth', items);
    expect(ranked.map((r) => r.entity.id)).toEqual(['a']);
    expect(ranked[0].matchField).toBe('title');
    expect(ranked[0].positions).toEqual([4, 5, 6, 7, 8]);
  });

  it('matches the id too (a session by its 8-char prefix, a task by its id)', () => {
    const items: MentionEntity[] = [
      { kind: 'session', id: '9af9e0b9-1111-2222-3333-444444444444', title: 'Auth middleware', meta: '' },
      task({ id: 'mtcki5d9-e29d', title: 'Something else' }),
    ];
    expect(rankEntities('9af9e', items)[0]).toMatchObject({ matchField: 'id', entity: { kind: 'session' } });
    expect(rankEntities('mtcki', items)[0]).toMatchObject({ matchField: 'id', entity: { id: 'mtcki5d9-e29d' } });
  });

  it('respects the limit', () => {
    const items = Array.from({ length: 20 }, (_, i) => task({ id: `t${i}`, title: `auth task ${i}` }));
    expect(rankEntities('auth', items, { limit: 3 })).toHaveLength(3);
    expect(rankEntities('', items, { limit: 5 })).toHaveLength(5);
  });
});

describe('mergeServerHits', () => {
  const local = rankEntities('login', [
    task({ id: 'kw', title: 'Login page flicker' }),
    task({ id: 'kw2', title: 'Login button copy' }),
  ]);

  it('bands: agreed rows first (local order), then server-only, then local-only', () => {
    const server: MentionEntity[] = [
      task({ id: 'sem', title: 'Fix OAuth callback 401', summary: 'callback returns 401 after code exchange' }),
      task({ id: 'kw', title: 'Login page flicker' }),
    ];
    const merged = mergeServerHits('login', local, server);
    expect(merged.map((r) => r.entity.id)).toEqual(['kw', 'sem', 'kw2']);
    // Present on both sides: keeps the local positions, marked 'both'.
    expect(merged[0].source).toBe('both');
    expect(merged[0].positions).toEqual(local[0].positions);
    // Purely semantic hit: nothing to highlight, summary explains it.
    expect(merged[1]).toMatchObject({ source: 'server', positions: [], matchField: null });
    expect(merged[1].entity.summary).toContain('401');
    expect(merged[2].source).toBe('local');
  });

  it('a server re-rank never pushes the exact local match out of a 2-row budget', () => {
    const exact = rankEntities('walnut oauth', [task({ id: 'x', title: 'Walnut OAuth callback 401' })]);
    const server: MentionEntity[] = [
      task({ id: 's1', title: 'Walnut calendar view' }),
      task({ id: 's2', title: 'Walnut commit split' }),
      task({ id: 'x', title: 'Walnut OAuth callback 401' }),
    ];
    expect(mergeServerHits('walnut oauth', exact, server).slice(0, 2).map((r) => r.entity.id)).toEqual(['x', 's1']);
  });

  it('a keyword-style server hit still gets highlight positions from its title', () => {
    const merged = mergeServerHits('login', [], [task({ id: 'x', title: 'Social login providers' })]);
    expect(merged[0].matchField).toBe('title');
    expect(merged[0].positions).toEqual([7, 8, 9, 10, 11]);
  });

  it('no server hits → local list untouched; duplicate server rows collapse', () => {
    expect(mergeServerHits('login', local, [])).toBe(local);
    const dup = task({ id: 'd', title: 'Login dup' });
    expect(mergeServerHits('login', [], [dup, dup])).toHaveLength(1);
  });
});

describe('groupRowBudget', () => {
  it('one group takes the whole panel; more groups share it so all stay visible', () => {
    expect(groupRowBudget(0)).toEqual({ entity: 12, files: 12 });
    expect(groupRowBudget(1)).toEqual({ entity: 12, files: 12 });
    expect(groupRowBudget(2)).toEqual({ entity: 5, files: 5 });
    expect(groupRowBudget(3)).toEqual({ entity: 3, files: 4 });
    expect(groupRowBudget(4)).toEqual({ entity: 2, files: 3 });
  });
});
