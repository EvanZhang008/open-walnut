/**
 * The recorded-rewind filter meets the INCREMENTAL append reader.
 *
 * The invariant that is silent-failure-prone: seeding must still happen for a
 * FILTERED session. seedIncrementalState validates a segmented parse against the
 * full parse; if the two segment parses did not apply the EXACT dead set + queue
 * dead keys the full parse computed, the equality gate would fail forever, `inc`
 * would never be seeded, and every mtime change on every rewound session would
 * cost a full read+parse (the regime that produced the 383-reads / 1.8 GB restart
 * storm). Both inputs are position-free (a uuid set + line-identity keys),
 * which is what makes a segment parse able to reproduce the full parse at all.
 *
 * What is deliberately NOT here any more: the round-1 seam guard, which
 * re-parsed the whole rolling tail on EVERY incremental round (measured +70-97%
 * on a real 11 MB transcript) to notice an appended line re-rooting the frozen
 * prefix. With the filter driven by recorded cuts that check is unnecessary: an
 * appended line always sits past every cut's commit-time anchor, so it can never
 * join a dead region, and a rewind commit invalidates this whole cache entry
 * anyway. An out-of-band rewind run in a terminal (no Walnut commit) shows both
 * branches — the pre-port status quo, not a regression the guard could fix
 * without paying that cost on every append of every session.
 *
 * Fixtures are deliberately > 1 MiB (TAIL_SEGMENT_KEEP_BYTES) so the seed has a
 * non-empty FROZEN PREFIX; below that everything is tail and the boundary cannot
 * be exercised at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
import {
  transcript, cutHere,
  type TranscriptFixture, type TranscriptLine,
} from '../helpers/transcript-fixtures.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

let mockRecord: { inPlaceRewinds?: InPlaceRewindCut[] } | undefined;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async () => mockRecord),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  invalidateSessionHistoryCaches,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/proj/chain-incremental';

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  mockRecord = undefined;
});
afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

function jsonlPath(sessionId: string): string {
  return path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

/**
 * A rewound transcript just over 1 MiB: ~190 KB of fat "head" lines (which end
 * up in the frozen prefix), ~1 MiB of small "tail" lines, then the rewind shape
 * — an ABANDONED assistant, the cut a real commit would record at that moment,
 * and the new branch the CLI appends afterwards off the same parent.
 */
function rewoundFixture(): { t: TranscriptFixture; cut: InPlaceRewindCut } {
  const t = transcript();
  t.user('h-u0', 'head question 0 ' + 'x'.repeat(9000));
  for (let i = 1; i <= 10; i++) {
    t.assistant(`h-a${i}`, `head answer ${i} ` + 'y'.repeat(9000));
    t.user(`h-u${i}`, `head question ${i} ` + 'x'.repeat(9000));
  }
  for (let i = 1; i <= 525; i++) {
    t.assistant(`t-a${i}`, `tail answer ${i} ` + 'y'.repeat(900));
    t.user(`t-u${i}`, `tail question ${i} ` + 'x'.repeat(900));
  }
  t.assistant('dead-a', 'ABANDONED reply to the rewound turn');
  const cut = cutHere(t, 't-u525');
  t.from('t-u525').user('new-u', 'the live branch');
  return { t, cut };
}

async function writeFixture(sessionId: string, t: TranscriptFixture): Promise<void> {
  const p = jsonlPath(sessionId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, t.text());
}

async function append(sessionId: string, lines: TranscriptLine[]): Promise<void> {
  await fsp.appendFile(jsonlPath(sessionId), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // Bump mtime so the mtime-equality fast path can't mask the code under test.
  const future = new Date(Date.now() + 60_000);
  await fsp.utimes(jsonlPath(sessionId), future, future);
}

const read = (sid: string) => readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

/** Same file, same record, no caches — what a cold reader sees. */
async function coldRead(sid: string) {
  _resetHistoryCacheForTesting();
  return read(sid);
}

/** Appended lines are always NEWER than the fixture's, and newer than each
 *  other — a timestamp TIE would hand the leaf to the earliest line (strict `>`
 *  in findLatestMessage), which is not what an append means. */
let appendSeq = 0;
const line = (uuid: string, parentUuid: string, text: string): TranscriptLine => ({
  type: 'user', uuid, parentUuid,
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + ++appendSeq * 1000).toISOString(),
  message: { role: 'user', content: text },
});

describe('incremental state under the recorded-rewind filter', () => {
  it('still seeds incremental state for a session whose transcript IS filtered', async () => {
    const sid = 'seam-seed';
    const { t, cut } = rewoundFixture();
    await writeFixture(sid, t);
    mockRecord = { inPlaceRewinds: [cut] };

    const first = await read(sid);
    expect(first.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(false);
    // The seed's two segment parses used the full parse's dead set + keys, so
    // the equality gate passed and incremental state exists (no permanent cliff).
    const inc = _historyCacheGetForTesting(sid)?.inc;
    expect(inc).toBeDefined();
    expect(inc!.deadUuids).not.toBeNull();
    expect([...inc!.deadUuids!]).toEqual(['dead-a']);
    expect(inc!.queueDeadKeys.size).toBe(0);   // no enqueue lines in the region
    expect(inc!.prefixMessages.length).toBeGreaterThan(0);
  });

  it('seeds with NO filter at all for a never-rewound session (identity)', async () => {
    const sid = 'seam-plain';
    const { t } = rewoundFixture();
    await writeFixture(sid, t);            // same file, no cut recorded

    const messages = await read(sid);
    expect(messages.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(true);
    const inc = _historyCacheGetForTesting(sid)?.inc;
    expect(inc).toBeDefined();
    expect(inc!.deadUuids).toBeNull();
    expect(inc!.queueDeadKeys.size).toBe(0);
  });

  it('an ordinary append rides the incremental path and never re-emits a dead line', async () => {
    const sid = 'seam-append';
    const { t, cut } = rewoundFixture();
    await writeFixture(sid, t);
    mockRecord = { inPlaceRewinds: [cut] };
    const first = await read(sid);

    await append(sid, [line('follow-u', 'new-u', 'a follow-up on the live branch')]);
    const second = await read(sid);
    expect(second.length).toBe(first.length + 1);
    expect(second[second.length - 1].text).toBe('a follow-up on the live branch');
    expect(second.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(second).toEqual(await coldRead(sid));
  });

  it('an append parented INSIDE the frozen prefix stays on the incremental path', async () => {
    // This is an out-of-band rewind (a terminal ran --resume-session-at against a
    // message deep in the frozen prefix). Walnut recorded no cut, so BOTH branches
    // show — deliberately, and identically through the incremental path and a cold
    // read. Round 1 paid a full tail re-parse on every append of every session to
    // detect this; the equality with the cold read is what makes that unnecessary.
    const sid = 'seam-oob';
    const { t } = rewoundFixture();
    await writeFixture(sid, t);
    const before = await read(sid);
    expect(before.length).toBeGreaterThan(500);

    await append(sid, [line('rewound-u', 'h-u2', 'restarting from an early message')]);
    const after = await read(sid);

    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].text).toBe('restarting from an early message');
    expect(after).toEqual(await coldRead(sid));
  });

  it('a rewind COMMIT mid-session re-seeds and hides the new region on the next append', async () => {
    // The real sequence: the session was read and seeded unfiltered, the human
    // rewinds (record gains a cut, every cache is dropped — the file's mtime never
    // changed but its meaning did), the CLI appends the new branch, and the next
    // read must serve the new branch while hiding the region. Without the
    // invalidation the mtime-validated entry would keep serving the old rows.
    const sid = 'seam-commit';
    const { t } = rewoundFixture();
    await writeFixture(sid, t);
    const before = await read(sid);
    expect(before.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(true);

    // Commit: rewind to t-u520, whose region covers everything written since.
    const cut = cutHere(t, 't-u520');
    mockRecord = { inPlaceRewinds: [cut] };
    await invalidateSessionHistoryCaches(sid);
    expect(_historyCacheGetForTesting(sid)).toBeUndefined();

    // Full read re-seeds under the filter…
    const filtered = await read(sid);
    expect(filtered.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(filtered.map((m) => m.text)).not.toContain('the live branch');
    expect(filtered.length).toBeLessThan(before.length);
    const inc = _historyCacheGetForTesting(sid)?.inc;
    expect(inc?.deadUuids?.has('dead-a')).toBe(true);

    // …and the append after it rides the incremental path with that same set.
    await append(sid, [line('post-rewind-u', 't-u520', 'the take after the rewind')]);
    const after = await read(sid);
    expect(after.length).toBe(filtered.length + 1);
    expect(after[after.length - 1].text).toBe('the take after the rewind');
    expect(after.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(after).toEqual(await coldRead(sid));
  });

  it('a tail roll re-parses from scratch and still hides the abandoned branch', async () => {
    // Past TAIL_SEGMENT_ROLL_BYTES the incremental state is dropped on purpose;
    // the replacement full read must re-apply the filter (a stale prefix would
    // otherwise re-surface the abandoned lines it was seeded with).
    const sid = 'seam-roll';
    const { t, cut } = rewoundFixture();
    await writeFixture(sid, t);
    mockRecord = { inPlaceRewinds: [cut] };
    await read(sid);

    const fat = Array.from({ length: 4 }, (_, i) =>
      line(`roll-u${i}`, i === 0 ? 'new-u' : `roll-u${i - 1}`, `rolling append ${i} ` + 'z'.repeat(900_000)));
    await append(sid, fat);

    const after = await read(sid);
    expect(after.map((m) => m.text).some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(after[after.length - 1].text.startsWith('rolling append 3')).toBe(true);
    // The roll really happened: the state was re-seeded with a fresh ~1 MiB
    // window instead of carrying a 4.6 MiB rolling tail.
    const inc = _historyCacheGetForTesting(sid)?.inc;
    expect(inc).toBeDefined();
    expect(Buffer.byteLength(inc!.tailText, 'utf-8')).toBeLessThan(3 * 1024 * 1024);
    expect(after).toEqual(await coldRead(sid));
  });

  it('charges the retained dead set to the cache entry byte budget', async () => {
    // inc.deadUuids rides the cache entry for the session's lifetime (~0.5 MB on a
    // whale with 7500 dead uuids, times up to 30 entries). It has to be counted, or
    // MAX_HISTORY_CACHE_CHARS under-reports and eviction never fires.
    const sid = 'seam-budget';
    const { t, cut } = rewoundFixture();
    await writeFixture(sid, t);
    mockRecord = { inPlaceRewinds: [cut] };
    await read(sid);
    const plainChars = _historyCacheGetForTesting(sid)!.approxChars;

    await append(sid, [line('follow-u', 'new-u', 'a follow-up')]);
    await read(sid);
    const entry = _historyCacheGetForTesting(sid)!;
    // parsedBytes grew by the appended line, plus 40 chars for the one dead uuid.
    expect(entry.approxChars).toBeGreaterThan(plainChars);
    expect(entry.approxChars - (entry.inc?.parsedBytes ?? 0)).toBe(40);
  });
});
