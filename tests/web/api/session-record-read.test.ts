/**
 * The one shared read of a session's record (web/src/api/session-record-read.ts): the panel and
 * the stream read `GET /api/sessions/:id` through it, one request per session at a time.
 *
 *  - two callers at once make one request; a `fresh` caller joins only a read not sent yet;
 *  - the read is interactive while any caller's claim is, and a caller that leaves takes its claim
 *    with it (a panel that moved on never holds the kept connection);
 *  - the request is cancelled only once every caller has left, after the commit (an effect that
 *    re-runs takes it back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchLane } from '@/api/client';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), fetchLaneRaised: vi.fn() }));

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiGet: mocks.apiGet, fetchLaneRaised: mocks.fetchLaneRaised };
});

import { readSessionRecord } from '@/api/session-record-read';

interface Call { resolve: (v: unknown) => void; signal: AbortSignal; lane: FetchLane; dispatch: () => void }

function deferApiGet(): Call[] {
  const calls: Call[] = [];
  mocks.apiGet.mockImplementation((_path: string, _params: unknown, opts: { signal: AbortSignal; lane: FetchLane; onDispatch: () => void }) => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      opts.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
    calls.push({ resolve, signal: opts.signal, lane: opts.lane, dispatch: opts.onDispatch });
    return promise;
  });
  return calls;
}

const ANSWER = { session: { claudeSessionId: 's' }, pendingPermissions: [] };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.apiGet.mockReset();
  mocks.fetchLaneRaised.mockReset();
});

describe('readSessionRecord', () => {
  it('serves two callers at once with one request', async () => {
    const calls = deferApiGet();
    const a = readSessionRecord('one');
    const b = readSessionRecord('one');
    expect(calls).toHaveLength(1);
    calls[0].resolve(ANSWER);
    expect(await a).toEqual(ANSWER);
    expect(await b).toEqual(ANSWER);
  });

  it('a fresh caller joins a read still waiting, never one already sent', async () => {
    const calls = deferApiGet();
    void readSessionRecord('fresh');
    void readSessionRecord('fresh', { fresh: true });
    expect(calls, 'joined the read that has not gone out').toHaveLength(1);
    calls[0].dispatch();
    void readSessionRecord('fresh', { fresh: true });
    expect(calls, 'the sent read answers from before this call: a new one').toHaveLength(2);
    void readSessionRecord('fresh');
    expect(calls, 'a caller without fresh joins the newest').toHaveLength(2);
    calls.forEach((c) => c.resolve(ANSWER));
  });

  it('is interactive while any caller claims it, and a leaving caller takes its claim along', async () => {
    const calls = deferApiGet();
    const leave = new AbortController();
    void readSessionRecord('lane', { lane: { interactive: false } });
    expect(calls[0].lane.interactive).toBe(false);
    const left = readSessionRecord('lane', { lane: { interactive: true }, signal: leave.signal });
    expect(calls[0].lane.interactive).toBe(true);
    expect(mocks.fetchLaneRaised, 'the waiting read looks for the kept slot again').toHaveBeenCalled();
    leave.abort();
    await expect(left).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0].lane.interactive, 'the stale claim is gone').toBe(false);
    await flush();
    expect(calls[0].signal.aborted, 'another caller still waits').toBe(false);
    calls[0].resolve(ANSWER);
  });

  it('a claim raised while the read waits counts at once', () => {
    const calls = deferApiGet();
    const lane: FetchLane = { interactive: false };
    void readSessionRecord('raised', { lane });
    lane.interactive = true;
    expect(calls[0].lane.interactive).toBe(true);
    calls[0].resolve(ANSWER);
  });

  it('cancels the request once every caller left, but not when one takes it back in the same commit', async () => {
    const calls = deferApiGet();
    const first = new AbortController();
    void readSessionRecord('gone', { signal: first.signal }).catch(() => {});
    first.abort();
    const again = new AbortController();
    void readSessionRecord('gone', { signal: again.signal }).catch(() => {});
    await flush();
    expect(calls, 'the re-run took the same read back').toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);
    again.abort();
    await flush();
    expect(calls[0].signal.aborted, 'nobody waits any more').toBe(true);
    void readSessionRecord('gone').catch(() => {});
    expect(calls, 'a later read starts anew').toHaveLength(2);
    calls[1].resolve(ANSWER);
  });
});
