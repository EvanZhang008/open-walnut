/**
 * The quick bar's modes (web/src/components/quickbar/quickbar-modes.ts): a keyword typed first
 * points at a mode, and only that; a message that only starts like one stays a message.
 */
import { describe, expect, it } from 'vitest';
import { MODES, matchMode } from '../../web/src/components/quickbar/quickbar-modes';

describe('matchMode', () => {
  it('a whole keyword points at its mode and hands on the words after it', () => {
    expect(matchMode('task tile color')).toMatchObject({ mode: { id: 'tasks' }, rest: 'tile color', whole: true });
    expect(matchMode('Notes  standup')).toMatchObject({ mode: { id: 'notes' }, rest: 'standup', whole: true });
    expect(matchMode('ask how long is the trip')).toMatchObject({ mode: { id: 'ask' }, rest: 'how long is the trip' });
    expect(matchMode('?how long')).toMatchObject({ mode: { id: 'ask' }, rest: 'how long', whole: true });
    expect(matchMode('task')).toMatchObject({ mode: { id: 'tasks' }, rest: '', whole: true });
  });

  it('the start of a keyword typed alone is completed; one letter or more words are a message', () => {
    expect(matchMode('no')).toMatchObject({ mode: { id: 'notes' }, whole: false });
    expect(matchMode('ta')).toMatchObject({ mode: { id: 'tasks' }, whole: false });
    expect(matchMode('t')).toBeNull();
    expect(matchMode('no rush on this')).toBeNull();
    expect(matchMode('tasking the VP')).toBeNull();
    expect(matchMode('ship the bar')).toBeNull();
    expect(matchMode('')).toBeNull();
  });

  it('every mode has a keyword, a chip and its words', () => {
    for (const m of MODES) {
      expect(m.keywords.length, m.id).toBeGreaterThan(0);
      expect(m.chip && m.action && m.placeholder, m.id).toBeTruthy();
      for (const k of m.keywords) expect(matchMode(`${k} x`)?.mode.id, k).toBe(m.id);
    }
  });
});
