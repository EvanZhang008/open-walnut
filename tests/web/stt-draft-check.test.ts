/** The log check that compares the live draft with the whole recording's text. */
import { describe, it, expect } from 'vitest';
import { draftMismatch } from '../../web/src/utils/stt-draft-check.js';

describe('draftMismatch', () => {
  it('the user\'s garbled take (2026-11-08) is a mismatch', () => {
    // "德莱和波文。" vs what the recording says.
    const m = draftMismatch('德莱和波文。', '这个和它 overlap 和不 overlap 是没有关系。');
    expect(m.mismatch).toBe(true);
    expect(m.wrongPct).toBeGreaterThan(50);
  });

  it('the same words with other punctuation and spacing agree', () => {
    const m = draftMismatch('we keep, the cache warm', 'We keep the cache warm.');
    expect(m).toEqual({ wrongPct: 0, missingPct: 0, mismatch: false });
  });

  it('a lost last sentence is missing: the text heard the recording to its end', () => {
    const m = draftMismatch('we keep the cache', 'we keep the cache warm and the rest of the take');
    expect(m.missingPct).toBeGreaterThan(20);
    expect(m.mismatch).toBe(true);
  });

  it('words dropped from the middle are missing', () => {
    const m = draftMismatch('we keep warm and the rest', 'we keep the cache warm and the rest');
    expect(m.missingPct).toBeGreaterThan(20);
    expect(m.mismatch).toBe(true);
  });
});
