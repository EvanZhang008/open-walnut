/**
 * Regression: `GET /history?since=N` must never slice a shifted index space.
 *
 * inc-1785993576822 — a 55.8 MB transcript exceeded DaemonFileReader's 32 MiB
 * ceiling, so every read degraded to a 4 MiB SLIDING TAIL. The route treated that
 * window's LENGTH as a monotonic cursor: as the head was evicted while the turn
 * appended at the tail, `total` grew by less than the turn produced, `since <= total`
 * still passed, and `messages.slice(since)` silently omitted the NEWEST messages —
 * including the user's own echo, which is the absorption evidence their optimistic
 * bubble needs. Result: the bubble stayed pinned at the bottom of the timeline
 * forever, no matter how many times history was refetched.
 *
 * These tests pin the invariant that replaced the count: identity decides the split
 * point, and every unresolvable case rebuilds (lossless) instead of slicing (lossy).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDeltaStart, deltaCursor, isUnsettledRow, collectRequestedRevisions,
} from '../../src/core/history-delta.js';

const m = (msgId?: string) => ({ msgId });

describe('resolveDeltaStart — identity anchor', () => {
  it('slices right after the anchor message', () => {
    const messages = [m('a'), m('b'), m('c'), m('d')];
    const r = resolveDeltaStart(messages, { since: 2, anchorMsgId: 'b', anchorTail: 0 });
    expect(r).toEqual({ kind: 'delta', start: 2 });
  });

  it('counts the id-less rows the client holds after its anchor', () => {
    // Client holds [a, b, <no id>], anchored on b with one trailing row.
    const messages = [m('a'), m('b'), m(undefined), m('c')];
    const r = resolveDeltaStart(messages, { since: 3, anchorMsgId: 'b', anchorTail: 1 });
    expect(r).toEqual({ kind: 'delta', start: 3 });
  });

  it('rebuilds when the anchor is gone (history rewritten under us)', () => {
    // /compact replaced the transcript; the anchored message no longer exists.
    const r = resolveDeltaStart([m('x'), m('y')], { since: 40, anchorMsgId: 'b' });
    expect(r).toEqual({ kind: 'rebuild', reason: 'anchor-missing' });
  });

  it('rebuilds when the anchor id tags more than one parsed row', () => {
    // A tool row inherits its parent message's id — slicing after the wrong
    // occurrence would DROP messages, the one forbidden direction.
    const r = resolveDeltaStart([m('a'), m('b'), m('b'), m('c')], { since: 2, anchorMsgId: 'b' });
    expect(r).toEqual({ kind: 'rebuild', reason: 'anchor-ambiguous' });
  });

  it('rebuilds when the client claims more trailing rows than exist', () => {
    const r = resolveDeltaStart([m('a'), m('b')], { since: 5, anchorMsgId: 'b', anchorTail: 3 });
    expect(r).toEqual({ kind: 'rebuild', reason: 'anchor-client-ahead' });
  });
});

describe('resolveDeltaStart — the sliding-window bug this fixes', () => {
  it('THE BUG: a shrinking window can no longer drop the newest messages', () => {
    // Reproduces the measured production sequence. The client synced at 1773; the
    // window then slid so the same conversation now parses to 1770 rows, with the
    // newest two being this turn's user echo + reply. The OLD rule (since <= total)
    // sliced at 1773 of 1770 → nothing, or worse, at an offset past the echo.
    const messages = Array.from({ length: 1770 }, (_, i) => m(`msg-${i}`));
    // Anchor = the newest message the client actually holds, which survived the slide.
    const anchorMsgId = 'msg-1767';
    const r = resolveDeltaStart(messages, { since: 1773, anchorMsgId, anchorTail: 0 }, { windowed: true });
    expect(r).toEqual({ kind: 'delta', start: 1768 });
    // The slice therefore CONTAINS the two newest rows — the echo is delivered.
    expect(messages.slice((r as { start: number }).start)).toHaveLength(2);
  });

  it('a windowed read with no anchor must rebuild, never slice by count', () => {
    // An older cached SPA bundle sends no anchor. Under the old code this is exactly
    // the lossy path; now it degrades to a full (lossless) rebuild.
    const messages = Array.from({ length: 1770 }, (_, i) => m(`msg-${i}`));
    const r = resolveDeltaStart(messages, { since: 1773 }, { windowed: true });
    expect(r).toEqual({ kind: 'rebuild', reason: 'windowed-no-anchor' });
  });

  it('an anchorless count that LOOKS valid is still refused on a windowed read', () => {
    // The insidious case: since <= total, so the old guard passed happily while the
    // index space had shifted underneath. Nothing about the numbers reveals it.
    const messages = Array.from({ length: 1770 }, (_, i) => m(`msg-${i}`));
    const r = resolveDeltaStart(messages, { since: 1700 }, { windowed: true });
    expect(r).toEqual({ kind: 'rebuild', reason: 'windowed-no-anchor' });
  });

  it('anchorless counts still work on a normal full read (back-compat)', () => {
    const messages = [m('a'), m('b'), m('c')];
    expect(resolveDeltaStart(messages, { since: 2 })).toEqual({ kind: 'delta', start: 2 });
    expect(resolveDeltaStart(messages, { since: 3 })).toEqual({ kind: 'delta', start: 3 });
  });

  it('rebuilds when an anchorless client is ahead of the server', () => {
    expect(resolveDeltaStart([m('a')], { since: 9 })).toEqual({ kind: 'rebuild', reason: 'since-ahead' });
  });

  it('rebuilds on a malformed since', () => {
    expect(resolveDeltaStart([m('a')], { since: NaN })).toEqual({ kind: 'rebuild', reason: 'since-invalid' });
    expect(resolveDeltaStart([m('a')], { since: -1 })).toEqual({ kind: 'rebuild', reason: 'since-invalid' });
  });
});

describe('unsettled rows — the mutable-prefix bug (inc-1785965937858)', () => {
  const laneTool = (over: object = {}) => ({ toolUseId: 'toolu_1', name: 'Agent', result: 'launched', ...over });

  it('a lane-minting agent is unsettled until bgTaskFinished lands', () => {
    // The tool_result for a background Agent is LAUNCH metadata, written while the
    // agent still runs — so result-presence proves nothing. Only the later
    // task-notification does, and it can arrive a minute after the row was served.
    expect(isUnsettledRow({ msgId: 'a', tools: [laneTool()] })).toBe(true);
    expect(isUnsettledRow({ msgId: 'a', tools: [laneTool({ bgTaskFinished: true })] })).toBe(false);
  });

  it('a plain tool is unsettled only until its result lands', () => {
    expect(isUnsettledRow({ msgId: 'a', tools: [{ toolUseId: 't', name: 'Bash' }] })).toBe(true);
    expect(isUnsettledRow({ msgId: 'a', tools: [{ toolUseId: 't', name: 'Bash', result: 'ok' }] })).toBe(false);
  });

  it('a row with no tools is always settled', () => {
    expect(isUnsettledRow({ msgId: 'a' })).toBe(false);
    expect(isUnsettledRow({ msgId: 'a', tools: [] })).toBe(false);
  });

  it('THE FIX: the client re-asks by id and gets the now-settled row back', () => {
    // The client synced 'm1' while the agent was running, so its copy has no
    // bgTaskFinished. The server's copy now does. This is the ONLY path by which the
    // client's frozen row is ever corrected — and note the server could not have
    // inferred it, because by now its own row is settled.
    const current = [
      { msgId: 'm0', tools: [laneTool({ toolUseId: 't0', bgTaskFinished: true })] },
      { msgId: 'm1', tools: [laneTool({ toolUseId: 't1', bgTaskFinished: true })] },
      { msgId: 'm2' },
    ];
    const { revised, ambiguous } = collectRequestedRevisions(current, ['m1']);
    expect(ambiguous).toBe(false);
    expect(revised).toHaveLength(1);
    expect(revised[0].tools?.[0].bgTaskFinished).toBe(true);
  });

  it('asking for nothing costs nothing', () => {
    expect(collectRequestedRevisions([{ msgId: 'a' }], [])).toEqual({ revised: [], ambiguous: false });
  });

  it('an unanswerable request rebuilds — so the client cannot ask forever', () => {
    // Missing id (history was rewritten): a delta that silently omitted the revision
    // would leave the row stale AND leave the client re-asking every turn.
    expect(collectRequestedRevisions([{ msgId: 'a' }], ['gone']).ambiguous).toBe(true);
    // Duplicated id: no unambiguous replacement exists.
    expect(collectRequestedRevisions([{ msgId: 'd' }, { msgId: 'd' }], ['d']).ambiguous).toBe(true);
  });

  it('a pathological number of requests rebuilds instead of truncating', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const rows = ids.map(id => ({ msgId: id }));
    expect(collectRequestedRevisions(rows, ids)).toEqual({ revised: [], ambiguous: true });
  });
});

describe('deltaCursor', () => {
  it('anchored deltas report a CLIENT-anchored cursor', () => {
    // So the client's own length guard is meaningful: after appending it will
    // measure exactly this. Echoing the server's `total` (the old behaviour) made
    // the guard tautological — which is why the sliding window produced zero
    // mismatch logs across a two-day outage.
    expect(deltaCursor({ since: 1773, anchorMsgId: 'x' }, 2, 1770)).toBe(1775);
  });

  it('anchorless deltas keep the legacy server-total cursor', () => {
    expect(deltaCursor({ since: 5 }, 3, 8)).toBe(8);
  });
});
