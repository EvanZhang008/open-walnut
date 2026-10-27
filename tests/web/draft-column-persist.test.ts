/**
 * A new-session draft column comes back after a reload while its composer holds
 * words (web/src/components/sessions/draft-column-persist.ts); one without words
 * is forgotten, and a drawer's draft (keyed by its object) is never swept.
 */
import { describe, it, expect } from 'vitest';
import {
  draftColumnKey, parseDraftColumn, restoreDraftColumns, saveDraftColumns, serializeDraftColumn,
} from '../../web/src/components/sessions/draft-column-persist';
import { draftComposerKey, type DraftColumn } from '../../web/src/components/sessions/draft-column';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const META = { unread: false, priority: 'none', pinTier: 'focus', model: undefined, engine: undefined } as unknown as DraftColumn['meta'];
const col = (id: string, extra: Partial<DraftColumn> = {}): DraftColumn => ({ id, cwd: '/w/repo', host: null, meta: META, ...extra });
const fresh = (id: string): DraftColumn => ({ id, cwd: '', host: null, meta: META });

describe('draft column rows', () => {
  it('round-trips a row, the AI-field set included, without the picker nonce', () => {
    const d = col('draft:1-0', { project: 'Walnut', aiFields: new Set(['project']) as DraftColumn['aiFields'], openPickerNonce: 3 });
    const back = parseDraftColumn('draft:1-0', serializeDraftColumn(d))!;
    expect(back.project).toBe('Walnut');
    expect([...(back.aiFields ?? [])]).toEqual(['project']);
    expect(back.openPickerNonce).toBeUndefined();
    expect(parseDraftColumn('draft:other', serializeDraftColumn(d))).toBeNull();
    expect(parseDraftColumn('draft:1-0', '{bad')).toBeNull();
  });

  it('restores the columns that hold words, oldest first, and sweeps the rest', () => {
    const s = memStore({
      [draftComposerKey('draft:20-0')]: 'second',
      [draftColumnKey('draft:20-0')]: serializeDraftColumn(col('draft:20-0', { project: 'B' })),
      [draftComposerKey('draft:3-0')]: 'first, row never kept',
      [draftColumnKey('draft:9-0')]: serializeDraftColumn(col('draft:9-0')),
      [draftComposerKey('draft:9-0')]: '   ',
      [draftComposerKey('ask-object:walnut:mail:42')]: 'a drawer draft',
    });
    const out = restoreDraftColumns(fresh, s, 2 * 86_400_000);
    expect(out.map((d) => d.id)).toEqual(['draft:3-0', 'draft:20-0']);
    expect(out[0].cwd).toBe('');
    expect(out[1].project).toBe('B');
    expect(s.m.has(draftColumnKey('draft:9-0'))).toBe(false);
    expect(s.m.has(draftComposerKey('draft:9-0'))).toBe(false);
    expect(s.m.get(draftComposerKey('ask-object:walnut:mail:42'))).toBe('a drawer draft');
  });

  it('leaves a young row without words alone: it may be another window\'s column', () => {
    const now = 10 * 86_400_000;
    const young = `draft:${now - 60_000}-0`;
    const s = memStore({ [draftColumnKey(young)]: serializeDraftColumn(col(young)) });
    expect(restoreDraftColumns(fresh, s, now)).toEqual([]);
    expect(s.m.has(draftColumnKey(young))).toBe(true);
  });

  it('keeps live rows and forgets the rows of closed or started drafts', () => {
    const s = memStore();
    const kept = new Set<string>();
    saveDraftColumns([col('draft:1-0'), col('draft:2-0')], kept, s);
    expect([...kept].sort()).toEqual(['draft:1-0', 'draft:2-0']);
    saveDraftColumns([col('draft:2-0', { project: 'P' })], kept, s);
    expect(s.m.has(draftColumnKey('draft:1-0'))).toBe(false);
    expect(JSON.parse(s.m.get(draftColumnKey('draft:2-0'))!).project).toBe('P');
  });
});
