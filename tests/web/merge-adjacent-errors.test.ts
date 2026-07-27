import { describe, it, expect } from 'vitest';
import {
  mergeAdjacentErrors,
  isErrorMessage,
  type MergeableMessage,
} from '../../web/src/hooks/mergeAdjacentErrors';

const err = (content: string, timestamp?: string): MergeableMessage =>
  ({ content, role: 'assistant', source: 'agent-error', ...(timestamp ? { timestamp } : {}) });
const sessErr = (content: string): MergeableMessage =>
  ({ content, role: 'assistant', source: 'session-error' });
const normal = (content: string): MergeableMessage =>
  ({ content, role: 'assistant', source: undefined });
/** A message the USER typed — must not break an error run. */
const mine = (content: string): MergeableMessage =>
  ({ content, role: 'user', source: undefined });

const AUTH = '[Error: 403 The security token included in the request is invalid]';

describe('isErrorMessage', () => {
  it('matches both synthetic error sources and nothing else', () => {
    expect(isErrorMessage({ source: 'agent-error' })).toBe(true);
    expect(isErrorMessage({ source: 'session-error' })).toBe(true);
    expect(isErrorMessage({ source: 'cron' })).toBe(false);
    expect(isErrorMessage({ source: undefined })).toBe(false);
  });
});

describe('mergeAdjacentErrors', () => {
  it('leaves a message list with no errors untouched', () => {
    const input = [normal('hi'), normal('there')];
    const out = mergeAdjacentErrors(input);
    expect(out).toHaveLength(2);
    expect(out[0].errorCount).toBeUndefined();
  });

  it('collapses the 2026-07-26 shape: 6 identical 403s become ONE row reading 6', () => {
    const out = mergeAdjacentErrors(Array.from({ length: 6 }, () => err(AUTH)));
    expect(out).toHaveLength(1);
    expect(out[0].errorCount).toBe(6);
    // Identical text must NOT be repeated 6x in the body.
    expect(out[0].content).toBe(AUTH);
  });

  it('keeps DISTINCT error texts as separate lines inside the merged row', () => {
    const out = mergeAdjacentErrors([err('boom A'), err('boom B')]);
    expect(out).toHaveLength(1);
    expect(out[0].errorCount).toBe(2);
    expect(out[0].content).toBe('boom A\nboom B');
  });

  it('does NOT merge across an ASSISTANT message — the agent recovered, so a later failure is new', () => {
    const out = mergeAdjacentErrors([err(AUTH), err(AUTH), normal('hello'), err(AUTH)]);
    expect(out).toHaveLength(3);
    expect(out[0].errorCount).toBe(2);
    expect(out[1].content).toBe('hello');
    expect(out[2].errorCount).toBeUndefined();   // a lone error stays a lone error
  });

  // Regression: while auth is down, every prompt the user types fails. If the
  // user's own turns split the run, the timeline becomes the every-other-row
  // stack this merge exists to prevent (observed in the 2026-07-26 E2E run).
  it('merges ACROSS the user\'s own messages, keeping their turns in place', () => {
    const out = mergeAdjacentErrors([
      err(AUTH), mine('probe 1'), err(AUTH), mine('probe 2'), err(AUTH),
    ]);
    // 1 merged error row + the 2 user turns.
    expect(out.filter(m => m.source === 'agent-error')).toHaveLength(1);
    expect(out.find(m => m.source === 'agent-error')?.errorCount).toBe(3);
    expect(out.filter(m => m.role === 'user').map(m => m.content)).toEqual(['probe 1', 'probe 2']);
    // The error row must stay at its original position, ahead of the user turns.
    expect(out[0].source).toBe('agent-error');
  });

  it('writes the merged row back to the ERROR index, not the array tail', () => {
    const out = mergeAdjacentErrors([err('first', '2026-07-26T18:00:00Z'), mine('typed'), err('first', '2026-07-26T18:05:00Z')]);
    expect(out).toHaveLength(2);
    expect(out[0].errorCount).toBe(2);
    expect(out[0].timestamp).toBe('2026-07-26T18:05:00Z');
    // The user's message must NOT have been clobbered by the merge.
    expect(out[1].content).toBe('typed');
    expect(out[1].errorCount).toBeUndefined();
  });

  it('merges agent-error and session-error together (both are "a turn failed")', () => {
    const out = mergeAdjacentErrors([err('a'), sessErr('b')]);
    expect(out).toHaveLength(1);
    expect(out[0].errorCount).toBe(2);
  });

  it('carries the LATEST timestamp so the row reads as still-happening', () => {
    const out = mergeAdjacentErrors([
      err(AUTH, '2026-07-26T18:38:00Z'),
      err(AUTH, '2026-07-26T18:41:00Z'),
    ]);
    expect(out[0].timestamp).toBe('2026-07-26T18:41:00Z');
  });

  it('does not mutate the input array or its objects', () => {
    const first = err(AUTH, '2026-07-26T18:38:00Z');
    const input = [first, err(AUTH, '2026-07-26T18:41:00Z')];
    mergeAdjacentErrors(input);
    expect(input).toHaveLength(2);
    expect(first.timestamp).toBe('2026-07-26T18:38:00Z');
    expect((first as { errorCount?: number }).errorCount).toBeUndefined();
  });

  it('handles an empty list', () => {
    expect(mergeAdjacentErrors([])).toEqual([]);
  });

  it('a single error gets no count (renders "Error", not "1 errors")', () => {
    const out = mergeAdjacentErrors([err(AUTH)]);
    expect(out[0].errorCount).toBeUndefined();
  });
});
