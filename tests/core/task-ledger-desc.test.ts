import { describe, expect, it } from 'vitest';
import { normalizeLedgerDesc, titleNeedsDesc } from '../../src/core/task-ledger-desc.js';

describe('normalizeLedgerDesc', () => {
  it('strips quotes, collapses whitespace, bounds length', () => {
    expect(normalizeLedgerDesc('  "Fix the   login\nredirect loop"  ')).toBe('Fix the login redirect loop');
    expect(normalizeLedgerDesc('')).toBe('');
    expect(normalizeLedgerDesc('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });

  it('keeps CJK intact', () => {
    expect(normalizeLedgerDesc('研究 agent sdk 的用法')).toBe('研究 agent sdk 的用法');
  });
});

describe('titleNeedsDesc', () => {
  it('short/cryptic titles need a generated one-liner', () => {
    expect(titleNeedsDesc('H1b')).toBe(true);
    expect(titleNeedsDesc('看一看agent sdk')).toBe(true);
    expect(titleNeedsDesc('Nr4')).toBe(true);
  });

  it('long self-explanatory titles do not (saves the Haiku call)', () => {
    expect(titleNeedsDesc('Fix the session panel scroll jump when a new streaming block arrives mid-turn')).toBe(false);
    // CJK chars count as words: a long Chinese sentence is self-explanatory.
    expect(titleNeedsDesc('以后的AI不再需要人工确认每条消息的通知级别')).toBe(false);
  });

  it('empty title never triggers generation', () => {
    expect(titleNeedsDesc('')).toBe(false);
    expect(titleNeedsDesc('   ')).toBe(false);
  });
});
