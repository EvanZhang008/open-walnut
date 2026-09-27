/**
 * Pure rules added by the slice 1 fixer round: the root page windows over its
 * own rows (N9), a search hit in a hidden field shows its snippet (N23), the
 * optimistic meta never claims `Naming…` (C23), and the keyboard focus marks
 * WebKit needs (N5, N34).
 */
import { describe, expect, it } from 'vitest';
import { pageRowsBefore, pageWindowLimit } from '@/utils/thread-page-window';
import { hitSnippet } from '@/utils/thread-tree-rows';
import { withoutPendingName } from '@/hooks/useSessionThreadMeta';
import { isModifierOnly } from '@/utils/keyboard-focus';

describe('root page window (N9)', () => {
  // 40 rows: every 8th belongs to root, the rest to questions.
  const keys = Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? '' : 'Q'));
  const keyAt = (i: number) => keys[i];

  it('holds the wanted number of page rows, or everything when there are fewer', () => {
    expect(pageWindowLimit(40, keyAt, '', 2)).toBe(40 - 24);
    expect(pageWindowLimit(40, keyAt, '', 30)).toBe(40);
    expect(pageWindowLimit(40, keyAt, '', 0)).toBe(0);
  });

  it('counts only the page rows that are hidden, never the questions above', () => {
    expect(pageRowsBefore(24, keyAt, '')).toBe(3);
    expect(pageRowsBefore(24, keyAt, 'Q')).toBe(21);
    expect(pageRowsBefore(0, keyAt, '')).toBe(0);
  });
});

describe('drawer search snippet (N23)', () => {
  it('shows the words around the hit, cut on spaces', () => {
    const quote = 'Point 15: the beacon pass reads the jigsaw table before it trusts the cached copy of the entry.';
    const s = hitSnippet(quote, 'jigsaw')!;
    expect(s).toContain('jigsaw');
    expect(s.length).toBeLessThanOrEqual(64 + 14);
    expect(s.startsWith('…') || s.startsWith('Point')).toBe(true);
    expect(hitSnippet(quote, 'absent')).toBeUndefined();
    expect(hitSnippet('short text', 'text')).toBe('short text');
  });
});

describe('optimistic meta never says Naming (C23)', () => {
  it('drops a pending titleState from the optimistic copy only', () => {
    expect(withoutPendingName({ headId: 'h', status: 'open', titleState: 'pending', question: 'q' }))
      .toEqual({ headId: 'h', status: 'open', question: 'q' });
    const done = { headId: 'h', titleState: 'done' as const, title: 'T' };
    expect(withoutPendingName(done)).toBe(done);
  });
});

describe('keyboard focus marks (N5, N34)', () => {
  it('a bare modifier is not navigation', () => {
    expect(isModifierOnly('Meta')).toBe(true);
    expect(isModifierOnly('Shift')).toBe(true);
    expect(isModifierOnly('ArrowDown')).toBe(false);
    expect(isModifierOnly('Escape')).toBe(false);
  });
});
