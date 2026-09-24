/**
 * src/core/transcript-chain.ts — two functions with two different jobs, and the
 * whole point of the round-2 rework is that only ONE of them touches display.
 *
 *   computeCliLoadedChain(lines)      what `claude --resume <sid>` would load.
 *                                     VALIDATION ONLY (a rewind point off this
 *                                     chain makes the CLI exit 1 at respawn).
 *   computeRewindDeadSet(lines, cuts)  the display filter: replays RECORDED
 *                                     rewind events against the file as read
 *                                     right now. No cuts = no filtering, ever.
 *
 * The chain rules each cite the CLI source that is their contract:
 *   last-prompt + file order           leaf CANDIDATES: the recorded last-prompt
 *                                     line and the LAST tree line written. A
 *                                     plain "newest timestamp" leaf is NOT the
 *                                     contract and disagrees with the real CLI.
 *   findLatestMessage                  sessionStorage.ts:2046  (tie-break only,
 *                                     over the candidate set)
 *   buildConversationChain             sessionStorage.ts:2069  (walk + cycle)
 *   recoverOrphanedParallelToolResults sessionStorage.ts:2118  (the real DAG)
 *   dangling parent = normal end       sessionStorage.ts:2088, :3414
 *   legacy progress bridge             sessionStorage.ts:3629
 *
 * The cases at the bottom of the chain block are the reason the chain is NOT the
 * display filter: two ordinary shapes from real never-rewound transcripts where
 * the official chain excludes the entire conversation the human read.
 *
 * The in-place-rewind acceptance cases live in tests/core/session-rewind.test.ts;
 * the end-to-end read is tests/core/session-history-chain-walk.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeCliLoadedChain,
  computeRewindDeadSet,
  queueEnqueueKey,
} from '../../src/core/transcript-chain.js';
import {
  transcript, survivingUuids, cutHere,
  apiErrorEofForkFixture, midTurnCommandForkFixture,
} from '../helpers/transcript-fixtures.js';

const T = (sec: number) => new Date(Date.UTC(2026, 7, 30, 0, 0, sec)).toISOString();
/** Same clock as T, to the millisecond — the parent-bridge window is 5000ms. */
const TMS = (ms: number) => new Date(Date.UTC(2026, 7, 30, 0, 0, 0) + ms).toISOString();

/** The chain the CLI would load, as uuids root → leaf. */
const chainOf = (t: ReturnType<typeof transcript>) => computeCliLoadedChain(t.lines).chain;

afterEach(() => { vi.restoreAllMocks(); });

describe('computeCliLoadedChain — leaf selection', () => {
  it('selects the last branch rather than a newer timestamp on another branch', () => {
    const olderLast = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      // written FIRST, but carries the later stamps
      .from('u2').user('u2b', 'second take', { at: T(9) }).assistant('a2b', 'new two', { at: T(10) })
      // written LAST, but older
      .from('u2').assistant('a2', 'other two', { at: T(4) }).user('u3', 'other third', { at: T(5) });
    expect(computeCliLoadedChain(olderLast.lines).leafUuid).toBe('u3');
    expect(chainOf(olderLast)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);

    const newerLast = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      .from('u2').assistant('a2', 'other two', { at: T(4) }).user('u3', 'other third', { at: T(5) })
      .from('u2').user('u2b', 'second take', { at: T(9) }).assistant('a2b', 'new two', { at: T(10) });
    expect(chainOf(newerLast)).toEqual(['u1', 'a1', 'u2', 'u2b', 'a2b']);
  });

  it('selects the last branch when branch timestamps tie', () => {
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      .from('u2').assistant('aFirst', 'written first', { at: T(7) })
      .from('u2').assistant('aSecond', 'written second', { at: T(7) });
    expect(chainOf(t)).toEqual(['u1', 'a1', 'u2', 'aSecond']);
  });

  it('skips unparseable timestamps as leaf candidates, and reports NO leaf when none parse', () => {
    // Two independent guards, and a junk stamp trips both: the candidate rules
    // never name it (it is neither the last line written nor a descendant of that
    // line), and Date.parse(NaN) > x is false so it cannot win the tie-break
    // either. Note the candidate rules compare timestamps as STRINGS, where
    // 'not a date' sorts ABOVE every ISO stamp — so the parse guard is load
    // bearing, not decoration.
    const some = transcript()
      .user('u1', 'first', { at: T(1) })
      .from('u1').user('junk', 'unparseable stamp', { at: 'not a date' })
      .from('u1').user('good', 'real stamp', { at: T(5) });
    expect(chainOf(some)).toEqual(['u1', 'good']);

    // No candidate at all: getLastSessionLog treats that as "no session", which
    // for us means validation can never accept a rewind point there.
    const none = transcript()
      .user('u1', 'first', { at: 'nope' })
      .from('u1').user('x', 'a', { at: 'also nope' });
    expect(computeCliLoadedChain(none.lines)).toEqual({ chain: [], chainUuids: new Set(), leafUuid: null });
  });

  it('does not let appended sidechain activity replace the primary leaf', () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .from('u2').user('side', 'subagent line', { isSidechain: true, at: T(99) });
    expect(chainOf(t)).toEqual(['u1', 'a1', 'u2']);

    const sideOnly = transcript()
      .from(null).user('s1', 'subagent prompt', { isSidechain: true })
      .assistant('s2', 'subagent reply', { isSidechain: true });
    expect(computeCliLoadedChain(sideOnly.lines).leafUuid).toBe('s2');
  });

  it('honours an EXPLICIT last-prompt leaf over a newer branch still on disk', () => {
    // The in-place rewind shape: the abandoned branch keeps the NEWEST stamps in
    // the file, and the CLI records `last-prompt {leafUuid, explicit:true}` at EOF.
    // Resume loads the recorded leaf, so a newest-timestamp leaf rule validates
    // rewind points against a chain the CLI would never load.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      .assistant('a2', 'ABANDONED two', { at: T(9) })
      .user('u3', 'ABANDONED third', { at: T(10) })
      .meta({ type: 'last-prompt', leafUuid: 'u2', explicit: true });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('u2');
    expect(res.chain).toEqual(['u1', 'a1', 'u2']);
    for (const uuid of ['a2', 'u3']) expect(res.chainUuids.has(uuid)).toBe(false);
  });

  it('advances a NON-explicit last-prompt to the last line written for it', () => {
    // The ordinary shape: the prompt's own leaf is recorded when the human sends,
    // then the turn is appended. Resume loads the whole turn, so the candidate has
    // to walk FORWARD to the file's last line whenever that line descends from it.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      .meta({ type: 'last-prompt', leafUuid: 'u2' })
      .assistant('a2', 'working on it', { at: T(4) })
      .assistant('a3', 'reply two', { at: T(5) });
    expect(chainOf(t)).toEqual(['u1', 'a1', 'u2', 'a2', 'a3']);
  });

  it('keeps a NON-explicit last-prompt when the file ends on a DIFFERENT branch', () => {
    // No descendant relationship, so there is nothing to advance to: the recorded
    // prompt wins over both file order and the newer stamp.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) }).assistant('a2', 'reply two', { at: T(4) })
      .meta({ type: 'last-prompt', leafUuid: 'a2' })
      .from('u2').assistant('other', 'other branch', { at: T(9) });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('a2');
    expect(res.chain).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(res.chainUuids.has('other')).toBe(false);
  });

  it('loads NOTHING after a recorded clear, and says so', () => {
    // `last-prompt {leafUuid:null, explicit:true}` is the CLI's own record that the
    // session was cleared. An empty chain here is the ANSWER, not a parse failure,
    // so it is reported separately from "no leaf found".
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .meta({ type: 'last-prompt', leafUuid: null, explicit: true });
    expect(computeCliLoadedChain(t.lines)).toEqual({
      chain: [], chainUuids: new Set(), leafUuid: null, clearedToEmpty: true,
    });
  });

  it('a clear survives later sidechain / fork_briefing lines, but ONE tree line ends it', () => {
    const cleared = () => transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .user('u2', 'second', { at: T(3) })
      .meta({ type: 'last-prompt', leafUuid: null, explicit: true });

    // Neither a subagent line nor a fork briefing is conversation the human owns,
    // so neither of them un-clears the session (both are skipped by the same guard
    // that keeps them from becoming the leaf).
    const noise = cleared()
      .from('u2').user('side', 'subagent line', { isSidechain: true, at: T(9) })
      .attachment('fb', { attachment: { type: 'fork_briefing' }, at: T(10) });
    const quiet = computeCliLoadedChain(noise.lines);
    expect(quiet.leafUuid).toBeNull();
    expect(quiet.clearedToEmpty).toBe(true);

    // One ordinary tree line and the session is live again.
    const resumed = computeCliLoadedChain(cleared().from('u2').assistant('a2', 'back to work', { at: T(9) }).lines);
    expect(resumed.clearedToEmpty).toBeUndefined();
    expect(resumed.chain).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('forgets a recorded last-prompt at a compact boundary', () => {
    // The boundary resets the prompt bookkeeping, and it must: a pre-compact uuid
    // is one the CLI can no longer resume to, so an explicit prompt pointing back
    // there cannot be allowed to drag the summarized-away prefix onto the chain.
    const t = transcript()
      .user('u1', 'before the compaction', { at: T(1) })
      .assistant('a1', 'pre-compact reply', { at: T(2) })
      .meta({ type: 'last-prompt', leafUuid: 'u1', explicit: true })
      .compactBoundary('cb', { at: T(3), logicalParentUuid: 'a1' })
      .user('sum', 'summary of the conversation so far', { isCompactSummary: true, at: T(4) })
      .assistant('a2', 'post-compact reply', { at: T(5) });
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['cb', 'sum', 'a2']);
    expect(res.chainUuids.has('u1')).toBe(false);
  });

  it('when the newest line is NOT the last line written, only a descendant of the last line moves the leaf', () => {
    // Backward-stamped EOF lines are routine (an api_error carries the stamp of
    // when the call failed, not of when it was written), so the newest stamp often
    // sits mid-file on a branch the loader will not load. The advance is a
    // reachability question, never a timestamp race.
    const t = transcript()
      .user('u1', 'why is the deploy stuck', { at: T(1) })
      .assistant('a1', 'looking now', { at: T(2) })
      .user('u2', 'confirm it then', { at: T(3) })
      .assistant('a2', 'confirmed: the config was stale', { at: T(20) })   // newest stamp
      .system('err', 'api_error', { parent: 'a1', at: T(4), error: { message: 'overloaded_error' } });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('a1');
    expect(res.chain).toEqual(['u1', 'a1', 'err']);
    for (const uuid of ['u2', 'a2']) expect(res.chainUuids.has(uuid)).toBe(false);
  });

  it('…and a descendant written BEFORE its parent DOES move it', () => {
    // Out-of-order writes are real (the parent-appears-later case below), and here
    // the file's last line is the ROOT: without the forward advance the chain would
    // be ['u1'] alone and the reply would be dropped.
    const t = transcript()
      .raw({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: T(9),
        message: { id: 'msg_a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] } })
      .raw({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: T(1),
        message: { role: 'user', content: 'first' } });
    expect(chainOf(t)).toEqual(['u1', 'a1']);
  });

  it('refuses a reachable descendant that has NO timestamp at all', () => {
    // `d` descends from the file's last line, so reachability alone would elect it
    // — but it carries no timestamp, which the CLI requires before a candidate may
    // advance. Electing it is not a harmless mistake: an unstamped candidate then
    // loses the Date.parse tie-break too, so the whole session reports NO leaf and
    // every rewind point in it fails validation.
    const t = transcript()
      .raw({ type: 'user', uuid: 'd', parentUuid: 'b', message: { role: 'user', content: [] } })
      .raw({ type: 'user', uuid: 'x', parentUuid: null, timestamp: T(9), message: { role: 'user', content: [] } })
      .raw({ type: 'user', uuid: 'b', parentUuid: null, timestamp: T(1), message: { role: 'user', content: [] } });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('b');
    expect(res.chain).toEqual(['b']);
  });

  it('lands the leaf on a user/assistant line and appends its non-conversational tail in TIME order', () => {
    // The file ends on a `system` line hung off an attachment: the leaf climbs to
    // the first conversational ancestor, and the lines below it come back through
    // the descendant sweep — sorted by timestamp, so `hook` precedes the
    // attachment it is a child of.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .attachment('at2', { at: T(9) })
      .system('hook', 'stop_hook_summary', { at: T(5) });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('a1');
    expect(res.chain).toEqual(['u1', 'a1', 'hook', 'at2']);
  });
});

describe('computeCliLoadedChain — walk termination', () => {
  it('is the NEWEST TREE only: a compact boundary ends the chain', () => {
    // /compact never rewrites the file: the boundary is written with
    // parentUuid:null and the real parent in logicalParentUuid, so the CLI's own
    // resume load stops there. This is exactly why rewind validation must run on
    // this chain — a pre-compaction uuid is one the CLI can no longer resume to.
    const t = transcript()
      .user('u1', 'before the compaction').assistant('a1', 'pre-compact reply')
      .compactBoundary('cb', { logicalParentUuid: 'a1' })
      .user('sum', 'summary of the conversation so far', { isCompactSummary: true })
      .assistant('a2', 'post-compact reply');
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['cb', 'sum', 'a2']);
    expect(res.chainUuids.has('u1')).toBe(false);   // pre-compact: not resumable
  });

  it('treats a dangling parentUuid as a root, not an orphan to drop', () => {
    // The normal termination for a forked session (the copied root keeps the
    // SOURCE transcript's parent uuid) and for a post-boundary chain.
    const t = transcript()
      .user('u1', 'forked root', { parent: '0199ffff-0000-4000-8000-00000000dead' })
      .assistant('a1', 'reply in the fork');
    expect(chainOf(t)).toEqual(['u1', 'a1']);
  });

  it('resolves a parent that appears LATER in the file', () => {
    // Real transcripts do this (an attachment whose parentUuid points one line
    // ahead), so the walk must not require parents to be seen first.
    const t = transcript()
      .raw({ type: 'attachment', uuid: 'at1', parentUuid: 'u1', timestamp: T(2), attachment: { type: 'deferred_tools_delta' } })
      .raw({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: T(1), message: { role: 'user', content: 'first' } })
      .from('at1').assistant('a1', 'reply', { at: T(3) });
    expect(chainOf(t)).toEqual(['u1', 'at1', 'a1']);
  });

  it('returns a partial chain (never hangs) on a parentUuid cycle', () => {
    const t = transcript()
      .raw({ type: 'user', uuid: 'c1', parentUuid: 'c2', timestamp: T(1), message: { role: 'user', content: 'a' } })
      .raw({ type: 'user', uuid: 'c2', parentUuid: 'c1', timestamp: T(2), message: { role: 'user', content: 'b' } });
    expect(chainOf(t)).toEqual(['c1', 'c2']);
  });

  it('bridges a MISSING parent to the nearest earlier line within 5s — 5000ms in, 5001ms out', () => {
    // When the named parent is not in the file the CLI does not stop: it adopts the
    // closest line stamped at or before this one, inside a 5s window. The bound is
    // exact, so a case sitting on it pins the comparison as <=, not <.
    const orphaned = (ms: number) => transcript()
      .user('anc', 'the line the walk should land on', { at: TMS(0) })
      .raw({ type: 'user', uuid: 'orphan', parentUuid: '0199dead-0000-4000-8000-000000000000',
        timestamp: TMS(ms), message: { role: 'user', content: 'parent is gone' } });
    expect(chainOf(orphaned(5000))).toEqual(['anc', 'orphan']);
    expect(chainOf(orphaned(5001))).toEqual(['orphan']);
  });

  it('will not bridge across the sidechain flag — `false` and absent are DIFFERENT values', () => {
    // The CLI compares isSidechain with !==, so an explicit `false` never matches a
    // line that carries no flag at all. Relaxing this to a boolean coercion would
    // graft main-thread lines onto subagent walks and vice versa.
    const t = transcript()
      .user('anc', 'explicitly flagged main-thread', { at: TMS(0), isSidechain: false })
      .raw({ type: 'user', uuid: 'orphan', parentUuid: '0199dead-0000-4000-8000-000000000000',
        timestamp: TMS(1000), message: { role: 'user', content: 'no flag at all' } });
    expect(chainOf(t)).toEqual(['orphan']);
  });

  it('uses the same 5s bridge when a CYCLE blocks the walk', () => {
    // The cycle guard stops the walk from hanging; the bridge then carries it on to
    // an off-cycle line, so a cyclic tail costs the chain its cycle, not its history.
    const t = transcript()
      .user('anc', 'off-cycle line', { at: TMS(0) })
      .raw({ type: 'user', uuid: 'c1', parentUuid: 'c2', timestamp: TMS(1000), message: { role: 'user', content: 'a' } })
      .raw({ type: 'user', uuid: 'c2', parentUuid: 'c1', timestamp: TMS(2000), message: { role: 'user', content: 'b' } });
    expect(chainOf(t)).toEqual(['anc', 'c1', 'c2']);
  });

  it('bridges legacy `progress` lines so the chain does not truncate there', () => {
    // Pre-#24099 transcripts put progress lines INSIDE the parent chain. They are
    // consumed into a uuid→parent bridge and the child is re-pointed at the
    // nearest non-progress ancestor; without it a1 would dangle into its own tree
    // and the chain would be two lines long.
    const t = transcript()
      .user('u1', 'first', { at: T(1) })
      .raw({ type: 'progress', uuid: 'p1', parentUuid: 'u1', timestamp: T(2) })
      .raw({ type: 'progress', uuid: 'p2', parentUuid: 'p1', timestamp: T(3) })
      .from('p2').assistant('a1', 'reply one', { at: T(4) })
      .from('a1').user('u2', 'second', { at: T(6) })
      .from('a1').assistant('other', 'other branch', { at: T(5) });
    expect(chainOf(t)).toEqual(['u1', 'a1', 'other']);
  });

  it('collapses a duplicate uuid to one node — later value wins, ORIGINAL position kept', () => {
    // Map.set semantics of the CLI loader (sessionStorage.ts:3646): the rewrite at
    // line 4 replaces the node's fields (parent, timestamp) while the map keeps
    // its FIRST insertion position, which is what still orders the candidate scan.
    // `dup` is then selected because it is the LAST tree line in the file — not
    // because it out-stamps `other`, which carries the same T(7).
    const t = transcript()
      .user('u1', 'first', { at: T(1) })
      .user('dup', 'first write', { parent: 'u1', at: T(1) })
      .user('other', 'the tie candidate', { parent: 'u1', at: T(7) })
      .raw({ type: 'user', uuid: 'dup', parentUuid: 'u1', timestamp: T(7), message: { role: 'user', content: 'rewritten' } });
    expect(computeCliLoadedChain(t.lines).leafUuid).toBe('dup');
    expect(chainOf(t)).toEqual(['u1', 'dup']);
  });

  it('never throws on empty or malformed input', () => {
    expect(computeCliLoadedChain([])).toEqual({ chain: [], chainUuids: new Set(), leafUuid: null });
    expect(computeCliLoadedChain([
      null as never, 42 as never, { foo: 'bar' } as never,
      { type: 'user', message: { content: 'no uuid' } },       // tree type, no uuid
    ]).leafUuid).toBeNull();
  });
});

describe('computeCliLoadedChain — parallel tool DAG recovery', () => {
  it('keeps the FIRST parallel tool_result, which a single-parent walk loses', () => {
    // Streaming writes one assistant line per content block, so two parallel
    // tool_uses share one message.id under two uuids, and each tool_result is
    // re-parented onto its OWN one-block assistant. Walking parents alone
    // reaches r2 but not r1 — 163 of 199 real fork points have this shape.
    const t = transcript()
      .user('u1', 'run both')
      .toolUse('x1', 'tool-1', { msgId: 'msg_par' })
      .toolUse('x2', 'tool-2', { msgId: 'msg_par' })
      .toolResult('r1', 'tool-1', 'output one', { parent: 'x1' })
      .toolResult('r2', 'tool-2', 'output two', { parent: 'x2' })
      .from('r2').assistant('done', 'both finished');
    expect(chainOf(t)).toEqual(['u1', 'x1', 'x2', 'r1', 'r2', 'done']);
  });

  it('recovers an OFF-CHAIN sibling assistant and its tool_result too', () => {
    // x3 is a third block of the same message.id that the walk never touches;
    // both it and its result must come back, spliced after the group's LAST
    // on-chain member so the group stays contiguous.
    const t = transcript()
      .user('u1', 'run three')
      .toolUse('x1', 'tool-1', { msgId: 'msg_par' })
      .toolUse('x2', 'tool-2', { msgId: 'msg_par' })
      .toolUse('x3', 'tool-3', { msgId: 'msg_par', parent: 'x1' })
      .toolResult('r1', 'tool-1', 'output one', { parent: 'x1' })
      .toolResult('r3', 'tool-3', 'output three', { parent: 'x3' })
      .toolResult('r2', 'tool-2', 'output two', { parent: 'x2' })
      .from('r2').assistant('done', 'all finished');
    expect(chainOf(t)).toEqual(['u1', 'x1', 'x2', 'x3', 'r1', 'r3', 'r2', 'done']);
  });
});

describe('computeCliLoadedChain is NOT a display filter (the P0-A shapes)', () => {
  // These two fixtures are the measured reason the round-1 always-on chain filter
  // was reverted. Both are ordinary never-rewound transcripts; both have a newest
  // leaf sitting on a short stub that excludes the whole conversation. They are
  // pinned HERE as chain behaviour (correct, and what the CLI itself would load)
  // and pinned again as display behaviour in the read-path suite, where every row
  // must survive.
  it('excludes a real turn when an api_error line at EOF re-parents the next user message', () => {
    const t = apiErrorEofForkFixture();
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('u3');
    expect(res.chain).toEqual(['u1', 'at1', 'err', 'hook', 'u3']);
    // The entire turn the human read is off the resumable chain.
    for (const uuid of ['a1', 'a2', 'u2', 'a3']) expect(res.chainUuids.has(uuid)).toBe(false);
  });

  it('excludes a real turn when a mid-turn slash command branches off pre-turn state', () => {
    const t = midTurnCommandForkFixture();
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['u1', 'at1', 'cav', 'cmd']);
    for (const uuid of ['a1', 'a2', 'u2', 'a3']) expect(res.chainUuids.has(uuid)).toBe(false);
  });

  it('…and computeRewindDeadSet drops NOTHING on either of them without a cut', () => {
    // The identity guarantee, stated on the exact shapes that used to break it.
    expect(computeRewindDeadSet(apiErrorEofForkFixture().lines, []).deadUuids).toBeNull();
    expect(computeRewindDeadSet(midTurnCommandForkFixture().lines, []).deadUuids).toBeNull();
  });
});

describe('computeRewindDeadSet — the recorded-cut region', () => {
  it('is the identity fast path with no recorded cuts', () => {
    // Every never-rewound session lands here, which is the whole safety property:
    // no cut record, no filtering, no chain reasoning, nothing to get wrong.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .from('u1').user('fork', 'an innocent fork');
    expect(computeRewindDeadSet(t.lines, [])).toEqual({
      deadUuids: null, droppedCount: 0, queueDeadKeys: new Set(), skippedCuts: [],
    });
  });

  it('kills (cutIdx, anchorIdx] — the rewind point itself survives, post-commit lines cannot join', () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED two').user('u3', 'ABANDONED third');
    const cut = cutHere(t, 'u2');                       // anchor = u3, the EOF tree line
    // The CLI then appends the new branch, hung off the rewind point.
    t.from('u2').user('u2b', 'second take').assistant('a2b', 'new two');

    const res = computeRewindDeadSet(t.lines, [cut]);
    expect([...res.deadUuids!]).toEqual(['a2', 'u3']);
    expect(res.droppedCount).toBe(2);
    expect(survivingUuids(t.lines, res.deadUuids)).toEqual(['u1', 'a1', 'u2', 'u2b', 'a2b']);
  });

  it('is a no-op when the rewind point IS the file tip (the death window, nothing appended)', () => {
    // rewindInPlace records lastUuidAtCommit = the last tree line, which right
    // after a rewind-to-the-latest-message is the rewind point itself: an empty
    // region, hence the identity path rather than an empty Set.
    const t = transcript().user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    const res = computeRewindDeadSet(t.lines, [cutHere(t, 'u2')]);
    expect(res.deadUuids).toBeNull();
    expect(res.droppedCount).toBe(0);
  });

  it('kills the whole region regardless of topology — attachment and system lines included', () => {
    // Region membership is POSITIONAL (uuid-anchored indices), so a line inside it
    // dies whether or not the parent chain says it is reachable. That is the point:
    // the record, not the file, decides that a rewind happened.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .attachment('atDead')
      .system('errDead', 'api_error', { error: { message: 'overloaded_error' } })
      .from('u2').assistant('a2', 'ABANDONED two');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'second take');

    const res = computeRewindDeadSet(t.lines, [cut]);
    expect([...res.deadUuids!].sort()).toEqual(['a2', 'atDead', 'errDead']);
  });

  it('never puts a NON-TREE line in the dead set, even inside the region', () => {
    // 16.4% of real lines carry no uuid (queue-operation / mode / last-prompt) and
    // a `progress` line has a uuid but is not a tree node. Neither is filterable.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED two')
      .raw({ type: 'progress', uuid: 'prog', parentUuid: 'a2', timestamp: T(20) })
      .meta({ type: 'mode', mode: 'default', sessionId: 's' })
      .meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'ABANDONED ask' });
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'second take');

    const res = computeRewindDeadSet(t.lines, [cut]);
    expect([...res.deadUuids!]).toEqual(['a2']);
    expect(res.deadUuids!.has('prog')).toBe(false);
    // The uuid-less lines keep their positions (reported as undefined).
    expect(survivingUuids(t.lines, res.deadUuids))
      .toEqual(['u1', 'a1', 'u2', 'prog', undefined, undefined, 'u2b']);
  });

  it('never kills a region uuid whose twin lives OUTSIDE the region', () => {
    // Real duplicate source: a preserved-segment /compact re-appends earlier
    // lines with their ORIGINAL uuids. Collection is index-bounded but the dead
    // set is applied uuid-globally, so killing the region's copy would delete
    // the live pre-cut twin too. Only a uuid unique in the file is safe to
    // kill; unique region uuids still die.
    const t = transcript()
      .user('early', 'live early line', { at: T(1) })
      .user('u2', 'rewind here', { at: T(2) })
      .assistant('aDead', 'ABANDONED reply', { at: T(3) })
      .raw({ type: 'user', uuid: 'early', parentUuid: 'aDead', timestamp: T(1), message: { role: 'user', content: 'live early line' } })
      .raw({ type: 'user', uuid: 'u3', parentUuid: 'aDead', timestamp: T(5), message: { role: 'user', content: 'ABANDONED third' } });
    const res = computeRewindDeadSet(t.lines, [{ uuid: 'u2', lastUuidAtCommit: 'u3', at: T(9) }]);
    expect([...res.deadUuids!].sort()).toEqual(['aDead', 'u3']);
    expect(res.deadUuids!.has('early')).toBe(false);
  });
});

describe('computeRewindDeadSet — multiple cuts', () => {
  it('unions a rewind-of-a-rewind: the first branch AND its replacement both die', () => {
    // Cut 1 rewinds to u2 (killing a2/u3), the CLI writes u2b/a2b, then cut 2
    // rewinds further back to u1 — its region swallows the first cut's region and
    // the branch that replaced it. Only u1 and the newest branch survive.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED two').user('u3', 'ABANDONED third');
    const cut1 = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'ABANDONED second take').assistant('a2b', 'ABANDONED new two');
    const cut2 = cutHere(t, 'u1');
    t.from('u1').user('u1c', 'first again').assistant('a1c', 'live reply');

    const res = computeRewindDeadSet(t.lines, [cut1, cut2]);
    expect([...res.deadUuids!].sort()).toEqual(['a1', 'a2', 'a2b', 'u2', 'u2b', 'u3']);
    expect(survivingUuids(t.lines, res.deadUuids)).toEqual(['u1', 'u1c', 'a1c']);
    // Neither region carries an enqueue line — no queue keys.
    expect(res.queueDeadKeys.size).toBe(0);
  });

  it('composes two INDEPENDENT cuts (one region each, neither nested)', () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one')
      .assistant('deadA', 'ABANDONED A');
    const cutA = cutHere(t, 'a1');
    t.from('a1').user('u2', 'second').assistant('a2', 'reply two')
      .assistant('deadB', 'ABANDONED B');
    const cutB = cutHere(t, 'a2');
    t.from('a2').user('u3', 'third');

    const res = computeRewindDeadSet(t.lines, [cutA, cutB]);
    expect([...res.deadUuids!].sort()).toEqual(['deadA', 'deadB']);
    expect(survivingUuids(t.lines, res.deadUuids)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
  });
});

describe('computeRewindDeadSet — degrades, never guesses', () => {
  it('SKIPS a cut whose rewind point is gone from the file, and REPORTS it once', () => {
    // The file was rewritten under the record (a tombstone, a preserved-segment
    // compact). Serving the whole transcript is the honest answer; cutting a
    // region we can no longer locate would delete live rows.
    //
    // The degrade is REPORTED, not logged: this module is bundled into the
    // session daemon (transcript-rewind-core.ts), where a logging import cannot
    // resolve — so the caller that has a logger warns from `skippedCuts`.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    const res = computeRewindDeadSet(t.lines, [
      { uuid: '0199dead-0000-4000-8000-000000000000', lastUuidAtCommit: 'u2', at: T(9) },
    ]);
    expect(res.deadUuids).toBeNull();
    expect(res.droppedCount).toBe(0);
    expect(res.queueDeadKeys.size).toBe(0);
    expect(res.skippedCuts).toEqual([{
      cutUuid: '0199dead-0000-4000-8000-000000000000',
      lastUuidAtCommit: 'u2',
      cutFound: false,
      anchorFound: true,
      cutDuplicated: false,
      anchorDuplicated: false,
    }]);
  });

  it('SKIPS a cut whose commit-time anchor is gone, and REPORTS it once', () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    const res = computeRewindDeadSet(t.lines, [
      { uuid: 'u1', lastUuidAtCommit: '0199dead-0000-4000-8000-000000000000', at: T(9) },
    ]);
    expect(res.deadUuids).toBeNull();
    expect(res.skippedCuts).toHaveLength(1);
    expect(res.skippedCuts[0]).toMatchObject({ cutFound: true, anchorFound: false });
  });

  it('reports NO skipped cuts when every cut resolves (always an array, never absent)', () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').assistant('dead', 'ABANDONED');
    const good = cutHere(t, 'a1');
    t.from('a1').user('u2', 'second take');
    expect(computeRewindDeadSet(t.lines, [good]).skippedCuts).toEqual([]);
    // …including the cut-less fast path, so a caller can always iterate it.
    expect(computeRewindDeadSet(t.lines, []).skippedCuts).toEqual([]);
  });

  it('skips only the unresolvable cut — a good one next to it still applies', () => {
    // Per-cut degrade, not per-session: one lost anchor must not resurrect the
    // branch a different, still-resolvable rewind threw away.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one')
      .assistant('dead', 'ABANDONED');
    const good = cutHere(t, 'a1');
    t.from('a1').user('u2', 'second take');

    const res = computeRewindDeadSet(t.lines, [
      { uuid: 'gone-uuid', lastUuidAtCommit: 'also-gone', at: T(9) },
      good,
    ]);
    expect([...res.deadUuids!]).toEqual(['dead']);
    expect(res.skippedCuts).toHaveLength(1);
    expect(res.skippedCuts[0].cutUuid).toBe('gone-uuid');
  });

  it('SKIPS a cut whose rewind-point uuid is DUPLICATED in the file, and reports it once', () => {
    // indexOfUuid keeps first occurrences, which is safe for the ANCHOR only: a
    // too-early anchor shrinks the region, but a too-early CUT index grows it
    // BACKWARDS — here it would kill the live turns u3/u4 and the rewind point
    // itself. Duplicates make the ground shaky, so the cut is skipped outright.
    const t = transcript()
      .user('u1', 'first')
      .user('u2', 'rewind point (first copy)')
      .user('u3', 'live').user('u4', 'live too')
      .raw({ type: 'user', uuid: 'u2', parentUuid: 'u4', timestamp: T(5), message: { role: 'user', content: 'rewind point (re-appended)' } })
      .user('u5', 'would-be region', { parent: 'u2' });
    const res = computeRewindDeadSet(t.lines, [{ uuid: 'u2', lastUuidAtCommit: 'u5', at: T(9) }]);
    expect(res.deadUuids).toBeNull();
    expect(res.skippedCuts).toHaveLength(1);
    expect(res.skippedCuts[0]).toMatchObject({ cutDuplicated: true, anchorDuplicated: false });
  });

  it('SKIPS a cut whose commit-time anchor uuid is DUPLICATED in the file', () => {
    const t = transcript()
      .user('u1', 'first')
      .assistant('a2', 'would-be region')
      .user('dup', 'anchor (first copy)')
      .raw({ type: 'user', uuid: 'dup', parentUuid: 'a2', timestamp: T(5), message: { role: 'user', content: 'anchor (re-appended)' } });
    const res = computeRewindDeadSet(t.lines, [{ uuid: 'u1', lastUuidAtCommit: 'dup', at: T(9) }]);
    expect(res.deadUuids).toBeNull();
    expect(res.skippedCuts).toHaveLength(1);
    expect(res.skippedCuts[0]).toMatchObject({ cutDuplicated: false, anchorDuplicated: true });
  });
});

describe('computeRewindDeadSet — queue dead keys', () => {
  it('collects the IDENTITY key of every enqueue inside the region — and nothing outside it', () => {
    // Queue lines carry no uuid, so a dead-region enqueue is keyed by its own
    // timestamp+content pair. Identity, not a time window: nothing outside the
    // region can be collected, whatever its stamp says.
    const t = transcript()
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'continue', timestamp: T(3) })
      .user('u1', 'first', { at: T(10) })
      .assistant('a2', 'ABANDONED two', { at: T(20) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'continue', timestamp: T(30) })
      .raw({ type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: T(40), message: { role: 'user', content: 'ABANDONED third' } });

    const res = computeRewindDeadSet(t.lines, [{ uuid: 'u1', lastUuidAtCommit: 'u3', at: T(41) }]);
    expect(res.queueDeadKeys).toEqual(new Set([`${T(30)} continue`]));
    // The live pre-cut enqueue with IDENTICAL text is not touched.
    expect(res.queueDeadKeys.has(`${T(3)} continue`)).toBe(false);
  });

  it('is immune to backward-stamped lines inside the region (the live pre-cut enqueue survives)', () => {
    // The measured failure the window rule shipped: attachment/api_error lines
    // inside a dead region are routinely stamped BEFORE the rewind point (1ms
    // to 170s early on real transcripts), so a [min,max] window over the
    // region opened before the cut and swallowed live pre-cut enqueue rows.
    // The identity set collects only the region's own enqueue lines.
    const t = transcript()
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'live mid-turn ask', timestamp: T(5) })
      .user('u1', 'first', { at: T(10) })
      .user('u2', 'rewind here', { at: T(20) })
      .assistant('aDead', 'ABANDONED reply', { at: T(21) })
      .attachment('atDead', { at: T(2) })    // backward-stamped, INSIDE the region
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'dead ask', timestamp: T(22) })
      .raw({ type: 'user', uuid: 'u3', parentUuid: 'aDead', timestamp: T(23), message: { role: 'user', content: 'ABANDONED third' } });
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'the live take', { at: T(30) });

    const res = computeRewindDeadSet(t.lines, [cut]);
    expect([...res.deadUuids!].sort()).toEqual(['aDead', 'atDead', 'u3']);
    expect(res.queueDeadKeys.has(`${T(22)} dead ask`)).toBe(true);
    // A time window here would open at T(2) and swallow the T(5) live enqueue.
    expect(res.queueDeadKeys.has(`${T(5)} live mid-turn ask`)).toBe(false);
  });

  it('still keys a TIMESTAMPLESS enqueue inside the region (the old window rule leaked it)', () => {
    const t = transcript()
      .user('u1', 'first', { at: T(1) })
      .assistant('a2', 'ABANDONED', { at: 'not a date' })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'ABANDONED ask' })
      .raw({ type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: T(4), message: { role: 'user', content: 'ABANDONED third' } });
    const res = computeRewindDeadSet(t.lines, [{ uuid: 'u1', lastUuidAtCommit: 'u3', at: T(9) }]);
    expect([...res.deadUuids!].sort()).toEqual(['a2', 'u3']);
    expect(res.queueDeadKeys.has(queueEnqueueKey({ content: 'ABANDONED ask' }))).toBe(true);
  });

  it("unions a resolved cut's trailingQueueKeys (enqueues past the commit-time anchor)", () => {
    // The human queued a message mid-turn, then rewound before the CLI drained
    // it: the enqueue sits past the last tree line, outside any uuid-anchored
    // region, so the commit captured its identity key on the cut record.
    const t = transcript()
      .user('u1', 'first').assistant('aDead', 'ABANDONED reply')
      .meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'queued mid-turn' });
    const cut = cutHere(t, 'u1');            // anchor = aDead; the enqueue trails it
    expect(cut.trailingQueueKeys).toHaveLength(1);
    t.from('u1').user('u1b', 'the live take');

    const res = computeRewindDeadSet(t.lines, [cut]);
    expect([...res.deadUuids!]).toEqual(['aDead']);
    expect(res.queueDeadKeys.has(cut.trailingQueueKeys![0])).toBe(true);
  });
});

describe('computeCliLoadedChain — preserved-segment relink (partial compaction)', () => {
  // A suffix-preserving /compact dedup-skips the kept messages, so on disk they
  // keep PRE-compact parentUuids while the first post-compact message parents
  // onto the ANCHOR (the last summary). The CLI splices the endpoints in memory
  // before leaf selection (applyPreservedSegmentRelinks): head→anchor, anchor's
  // other children→tail. Without the port, a rewind to a preserved message was
  // 409'd although `--resume-session-at` on it works.
  const preservedFixture = (seg: { headUuid: string; anchorUuid: string; tailUuid: string }) => transcript()
    .user('u1', 'summarized away', { at: T(1) })
    .assistant('a1', 'old reply', { at: T(2) })
    .user('headU', 'keep this ask', { at: T(3) })          // preserved head (parent a1 on disk)
    .assistant('tailA', 'keep this reply', { at: T(4) })   // preserved tail
    .compactBoundary('cb', {
      at: T(5), logicalParentUuid: 'tailA',
      compactMetadata: { trigger: 'auto', preTokens: 150_000, preservedSegment: seg },
    })
    .user('sum', 'summary of the earlier conversation', { isCompactSummary: true, at: T(6) })
    .from('sum').user('newU', 'post-compact ask', { at: T(7) })  // parents onto the anchor on disk
    .assistant('newA', 'post-compact reply', { at: T(8) });

  it('splices the preserved segment onto the chain: head→anchor, anchor children→tail', () => {
    const t = preservedFixture({ headUuid: 'headU', anchorUuid: 'sum', tailUuid: 'tailA' });
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['cb', 'sum', 'headU', 'tailA', 'newU', 'newA']);
    // The preserved human message IS resumable — the gate must accept it.
    expect(res.chainUuids.has('headU')).toBe(true);
    // …while the summarized-away prefix stays off the chain.
    expect(res.chainUuids.has('u1')).toBe(false);
  });

  it('does NOT relink when the tail→head walk breaks (the CLI bails the same way)', () => {
    const t = preservedFixture({
      headUuid: 'headU', anchorUuid: 'sum',
      tailUuid: '0199dead-0000-4000-8000-000000000000',   // not in the file
    });
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['cb', 'sum', 'newU', 'newA']);
    expect(res.chainUuids.has('headU')).toBe(false);
  });

  it('treats the seg as STALE when a later no-seg boundary exists (no relink)', () => {
    // Manual /compact after a reactive one: the seg boundary is no longer the
    // absolute-last boundary, and the CLI skips the relink (segIsLive). The
    // straggler leaf hangs off the OLD summary — with an (incorrect) stale
    // relink it would be re-pointed at tailA and pull the preserved segment
    // back onto the chain.
    const t = preservedFixture({ headUuid: 'headU', anchorUuid: 'sum', tailUuid: 'tailA' })
      .compactBoundary('cb2', { at: T(9), logicalParentUuid: 'newA' })
      .user('sum2', 'second summary', { isCompactSummary: true, at: T(10) })
      .raw({ type: 'user', uuid: 'straggler', parentUuid: 'sum', timestamp: T(30), message: { role: 'user', content: 'late line off the old summary' } });
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('straggler');
    expect(res.chain).toEqual(['straggler']);
    expect(res.chainUuids.has('headU')).toBe(false);
  });

  it('a STALE seg protects nothing — its OWN preserved lines are pruned with the prefix', () => {
    // Same staleness, stated on the lines the seg named: once a later no-seg
    // boundary exists, nothing before that boundary is kept, so a line hung off the
    // once-preserved reply can no longer walk back into it.
    const t = preservedFixture({ headUuid: 'headU', anchorUuid: 'sum', tailUuid: 'tailA' })
      .compactBoundary('cb2', { at: T(9), logicalParentUuid: 'newA' })
      .user('sum2', 'second summary', { isCompactSummary: true, at: T(10) })
      .raw({ type: 'user', uuid: 'straggler', parentUuid: 'tailA', timestamp: T(30),
        message: { role: 'user', content: 'late line off a once-preserved reply' } });
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['straggler']);
    expect(res.chainUuids.has('tailA')).toBe(false);
  });

  /** The same compaction shape, but the boundary carries the explicit
   *  `preservedMessages` LIST. `gapA` sits between two kept lines on disk and the
   *  list does NOT name it — the case that tells list order from disk order. */
  const preservedListFixture = (compactMetadata: Record<string, unknown>) => transcript()
    .user('u1', 'summarized away', { at: T(1) })
    .assistant('a1', 'old reply', { at: T(2) })
    .user('headU', 'keep this ask', { at: T(3) })
    .assistant('gapA', 'summarized away mid-segment', { at: T(4) })
    .user('midU', 'keep this follow-up', { at: T(5) })
    .assistant('tailA', 'keep this reply', { at: T(6) })
    .compactBoundary('cb', { at: T(7), logicalParentUuid: 'tailA', compactMetadata })
    .user('sum', 'summary of the earlier conversation', { isCompactSummary: true, at: T(8) })
    .from('sum').user('newU', 'post-compact ask', { at: T(9) })
    .assistant('newA', 'post-compact reply', { at: T(10) });

  /** A late line hung off a summarized-away reply — the probe that shows whether
   *  the pre-boundary prefix is still in the loaded map at all. */
  const withStraggler = (t: ReturnType<typeof transcript>) => t.raw({
    type: 'user', uuid: 'straggler', parentUuid: 'a1', timestamp: T(30),
    message: { role: 'user', content: 'late line off a summarized-away reply' },
  });

  it('relinks the preservedMessages LIST in list order, dropping an unlisted line between them', () => {
    // anchor → headU → midU → tailA, and the anchor's other child (the first
    // post-compact ask) is re-pointed at the list's tail so the segment is spliced
    // in whole. `gapA` was never listed, so it goes with the summarized-away prefix.
    const t = preservedListFixture({
      trigger: 'auto', preTokens: 150_000,
      preservedMessages: { anchorUuid: 'sum', uuids: ['headU', 'midU', 'tailA'] },
    });
    const res = computeCliLoadedChain(t.lines);
    expect(res.chain).toEqual(['cb', 'sum', 'headU', 'midU', 'tailA', 'newU', 'newA']);
    expect(res.chainUuids.has('gapA')).toBe(false);
  });

  it('prefers the LIST over a preservedSegment whose walk is broken', () => {
    // Listed uuids are authoritative, so the seg is never walked. Compare with the
    // seg-only case above, where the same broken tail means no relink at all.
    const t = preservedListFixture({
      trigger: 'auto', preTokens: 150_000,
      preservedMessages: { anchorUuid: 'sum', uuids: ['headU', 'midU', 'tailA'] },
      preservedSegment: { headUuid: 'headU', anchorUuid: 'sum', tailUuid: '0199dead-0000-4000-8000-000000000000' },
    });
    expect(computeCliLoadedChain(t.lines).chain)
      .toEqual(['cb', 'sum', 'headU', 'midU', 'tailA', 'newU', 'newA']);
  });

  it('an EMPTY preservedMessages list keeps nothing: the whole pre-boundary prefix is pruned', () => {
    // A list that names no line is not "no list": the boundary is still the live one,
    // so the prefix is dropped exactly as an ordinary full compaction drops it. The
    // straggler's parent is gone with it and the walk ends on the straggler.
    const t = withStraggler(preservedListFixture({
      trigger: 'auto', preTokens: 150_000,
      preservedMessages: { anchorUuid: 'sum', uuids: [] },
    }));
    const res = computeCliLoadedChain(t.lines);
    expect(res.leafUuid).toBe('straggler');
    expect(res.chain).toEqual(['straggler']);
  });

  it('does NOT relink and does NOT prune when a listed uuid is missing from the file', () => {
    // Same file, same straggler: a list we cannot honour makes the whole splice
    // untrustworthy, so the loader leaves the map alone rather than dropping lines
    // on a record it could not verify — and the prefix is still reachable.
    const t = withStraggler(preservedListFixture({
      trigger: 'auto', preTokens: 150_000,
      preservedMessages: { anchorUuid: 'sum', uuids: ['headU', '0199dead-0000-4000-8000-000000000000'] },
    }));
    expect(computeCliLoadedChain(t.lines).chain).toEqual(['u1', 'a1', 'straggler']);
  });
});
