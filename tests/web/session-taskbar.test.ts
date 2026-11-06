import { describe, it, expect } from 'vitest';
import { chipsAfterStripChange, moveChip, parseChips, removeChip } from '../../web/src/pages/sessionTaskbar';
import { addSessionColumn, removeSessionColumn, replaceSessionColumn, trimUnlockedToMax, type SessionSlot } from '../../web/src/pages/sessionColumns';

const slot = (id: string, locked = false): SessionSlot => ({ id, locked });
const none = new Set<string>();

describe('sessionTaskbar: a session leaving the strip', () => {
  it('becomes a chip when minimized (removed without a close)', () => {
    const before = [slot('a'), slot('b')];
    const after = removeSessionColumn(before, 'a');
    expect(chipsAfterStripChange([], before, after, none)).toEqual(['a']);
  });

  it('goes to the background when the user closed it', () => {
    const before = [slot('a'), slot('b')];
    const after = removeSessionColumn(before, 'a');
    expect(chipsAfterStripChange(['x'], before, after, new Set(['a']))).toEqual(['x']);
  });

  it('becomes a chip when a sixth open evicts it, never vanishes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].map(id => slot(id));
    const after = addSessionColumn(before, 'f', false, 5);
    const evicted = before.find(s => !after.some(c => c.id === s.id))!;
    expect(chipsAfterStripChange([], before, after, none)).toEqual([evicted.id]);
  });

  it('becomes a chip when a lower panel count trims the strip', () => {
    const before = ['a', 'b', 'c'].map(id => slot(id));
    const after = trimUnlockedToMax(before, 2);
    expect(chipsAfterStripChange([], before, after, none)).toEqual(['c']);
  });

  it('a swap in place (plan -> exec, prefix -> full id) is not a session leaving', () => {
    const before = [slot('plan'), slot('b')];
    const after = replaceSessionColumn(before, 'plan', 'exec');
    expect(chipsAfterStripChange([], before, after, none)).toEqual([]);
  });

  it('a collapse onto an id already open is a swap too', () => {
    const before = [slot('abc'), slot('abcdef')];
    const after = replaceSessionColumn(before, 'abc', 'abcdef');
    expect(chipsAfterStripChange([], before, after, none)).toEqual([]);
  });

  it('an old swap does not hide a later minimize of the id it replaced', () => {
    const swapped = replaceSessionColumn([slot('p')], 'p', 'e1');
    const before = [slot('p'), ...swapped];
    const after = removeSessionColumn(before, 'p');
    expect(chipsAfterStripChange([], before, after, none)).toEqual(['p']);
  });

  it('drafts and launches on their way never become chips', () => {
    const before = [slot('draft:1'), slot('pending:qs'), slot('pending:ws-t1'), slot('a')];
    expect(chipsAfterStripChange([], before, [slot('a')], none)).toEqual([]);
  });
});

describe('sessionTaskbar: the chip list', () => {
  it('a chip opened back onto the strip leaves the taskbar', () => {
    const before = [slot('b')];
    const after = addSessionColumn(before, 'a', false, 5);
    expect(chipsAfterStripChange(['a', 'c'], before, after, none)).toEqual(['c']);
  });

  it('keeps join order and adds new chips at the end, once', () => {
    const before = [slot('a'), slot('b')];
    const after: SessionSlot[] = [];
    expect(chipsAfterStripChange(['z', 'a'], before, after, none)).toEqual(['z', 'a', 'b']);
  });

  it('returns the same array when nothing changed', () => {
    const chips = ['a'];
    const cols = [slot('b')];
    expect(chipsAfterStripChange(chips, cols, cols, none)).toBe(chips);
  });

  it('× removes a chip; a drag moves it', () => {
    expect(removeChip(['a', 'b'], 'a')).toEqual(['b']);
    expect(moveChip(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveChip(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('reads only real session ids back from storage, deduplicated', () => {
    expect(parseChips(['a', 'a', 'draft:1', 'pending:x', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(parseChips('nope')).toEqual([]);
  });
});
