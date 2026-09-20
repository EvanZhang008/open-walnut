/**
 * The row note RETIRES itself (N2).
 *
 * It is the pane's answer to one right-click, and the triage loop is dozens of them. Inserted into the
 * layout and kept forever it moved every row under the pointer 20px down (36px for a refusal's two
 * lines) and left them there for the rest of the session; it is now floated over the pane AND given a
 * life, because a stack of answers standing over a list is a log rather than an answer. The row's own
 * marks (the task glyph, the refused-flag glyph) are the durable record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetMailStore,
  clearMailRowNote,
  getMailSnapshot,
  setMailRowNote,
} from '../../web/src/apps/mail/mail-store';

beforeEach(() => {
  vi.useFakeTimers();
  __resetMailStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the row note', () => {
  it('stays long enough to read and then goes on its own', () => {
    setMailRowNote('Link copied.', 'a 1');
    expect(getMailSnapshot().rowNote).toEqual({ text: 'Link copied.', pair: 'a 1' });
    // Still there while somebody is reading it.
    vi.advanceTimersByTime(8_000);
    expect(getMailSnapshot().rowNote?.text).toBe('Link copied.');
    vi.advanceTimersByTime(5_000);
    expect(getMailSnapshot().rowNote).toBeNull();
  });

  it('gives the NEWEST sentence the full life, never the old one\'s leftovers', () => {
    setMailRowNote('Link copied.', 'a 1');
    vi.advanceTimersByTime(11_000);
    setMailRowNote('Task made from "Berth swap".', 'a 2');
    // The first note's timer must not take the second one down a second later.
    vi.advanceTimersByTime(2_000);
    expect(getMailSnapshot().rowNote?.text).toBe('Task made from "Berth swap".');
    vi.advanceTimersByTime(11_000);
    expect(getMailSnapshot().rowNote).toBeNull();
  });

  it('is dropped at once by the paths that own the screen, with no timer left behind', () => {
    setMailRowNote('Link copied.', 'a 1');
    clearMailRowNote();
    expect(getMailSnapshot().rowNote).toBeNull();
    // A note written right after a manual clear keeps its own full life.
    setMailRowNote('Fetched.', 'a 1');
    vi.advanceTimersByTime(11_000);
    expect(getMailSnapshot().rowNote?.text).toBe('Fetched.');
  });

  it('does not blank a note the next case wrote: a reset disarms the timer', () => {
    setMailRowNote('Link copied.', 'a 1');
    __resetMailStore();
    setMailRowNote('Fetched.', 'a 1');
    vi.advanceTimersByTime(11_000);
    expect(getMailSnapshot().rowNote?.text).toBe('Fetched.');
  });
});
