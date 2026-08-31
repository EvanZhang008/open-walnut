/**
 * The recorded-rewind filter on the REAL readSessionHistory path (replaces
 * tests/core/session-history-rewind-cut.test.ts, which drove the deleted offset
 * slicer). It proves the whole chain: record lookup (inPlaceRewinds) →
 * readSessionJsonlContent → parseSessionMessages with `chainFilter: 'auto'` →
 * rendered messages, so a transcript that legitimately holds two branches (the
 * CLI keeps both under one session id after `--resume-session-at` with no
 * `--fork-session`) renders only the surviving branch.
 *
 * The two properties this file exists to hold apart:
 *
 *   WITHOUT a recorded cut nothing is ever dropped. Round 1 filtered by chain
 *   reachability always-on and measurably deleted 8.4% of rendered rows from
 *   never-rewound sessions, because innocent forks (an api_error line at EOF
 *   re-parenting the next user message; a mid-turn slash command branching off
 *   pre-turn state) are topologically identical to rewind branches. Both shapes
 *   are pinned here against an UNFILTERED baseline parse.
 *
 *   WITH a recorded cut only the recorded region goes. In particular the first
 *   post-rewind turn stays fully visible while `pendingResumeSessionAt` is still
 *   set to the rewind point (the production value, set for the whole first turn):
 *   round 1 truncated display at the rewind point for that entire window and then
 *   froze the poisoned set into the incremental cache.
 *
 * The user-visible expectations of the old golden case are ported verbatim (no
 * text contains 'ABANDONED'; the surviving texts are all present).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
import {
  transcript, cutHere, apiErrorEofForkFixture, midTurnCommandForkFixture,
  type TranscriptFixture,
} from '../helpers/transcript-fixtures.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

// The read path asks the tracker one thing only: which in-place rewinds has this
// session RECORDED? Everything else the filter needs is in the transcript, and
// pendingResumeSessionAt is pure spawn plumbing that display must ignore.
let mockRecord: { inPlaceRewinds?: InPlaceRewindCut[]; pendingResumeSessionAt?: string } | undefined;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async () => mockRecord),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  parseSessionMessages,
  readSessionHistory,
  readSessionHistoryTail,
  isWindowedHistory,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/proj/chain-walk';
const prevReadLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;
const T = (sec: number) => new Date(Date.UTC(2026, 7, 30, 0, 0, sec)).toISOString();

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  mockRecord = undefined;
});
afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  if (prevReadLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevReadLimit;
});

async function write(sessionId: string, t: TranscriptFixture): Promise<void> {
  const dir = path.join(tmpBase, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), t.text());
}

const read = (sid: string) => readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
const textsOf = (msgs: Array<{ text: string }>) => msgs.map((m) => m.text);
/** What the parser produces with NO filter at all — the identity baseline. */
const unfiltered = (t: TranscriptFixture) => textsOf(parseSessionMessages(t.text()));

describe('readSessionHistory with a recorded rewind cut', () => {
  it('hides the abandoned branch and keeps the new one', async () => {
    // Original branch: U1 A1 U2 A2 U3 A3, rewound to U2. The CLI then appended
    // the new branch parented at U2 — the shape a live in-place rewind writes.
    const t = transcript()
      .user('u1', 'set up the project').assistant('a1', 'done setup')
      .user('u2', 'add a feature')
      .assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third ask')
      .assistant('a3', 'ABANDONED reply three');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'add a DIFFERENT feature').assistant('a2b', 'NEW reply two');
    await write('s-rw', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-rw'));
    expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false);
    // File order preserved (msgId merging and tool pairing depend on it).
    expect(texts).toEqual(['set up the project', 'done setup', 'add a feature',
      'add a DIFFERENT feature', 'NEW reply two']);
  });

  it('keeps the FIRST POST-REWIND TURN whole while pendingResumeSessionAt is still set', async () => {
    // THE P0-B regression. Production writes pendingResumeSessionAt = the
    // REWIND-POINT uuid and clears it only on SESSION_RESULT, i.e. it is set for
    // the entire first post-rewind turn. Round 1 fed that flag into the display
    // filter and truncated history at the rewind point, so the message the human
    // had just sent and the reply streaming back both vanished from every full
    // read taken in that window — and the poisoned set then froze into the
    // incremental cache. The flag must now change NOTHING about what is served.
    const t = transcript()
      .user('u1', 'set up the project').assistant('a1', 'done setup')
      .user('u2', 'add a feature')
      .assistant('a2', 'ABANDONED reply two');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'add a DIFFERENT feature').assistant('a2b', 'NEW reply two');
    await write('s-window', t);
    mockRecord = { inPlaceRewinds: [cut], pendingResumeSessionAt: 'u2' };

    expect(textsOf(await read('s-window'))).toEqual(['set up the project', 'done setup',
      'add a feature', 'add a DIFFERENT feature', 'NEW reply two']);

    // …and with no cut recorded at all, the flag alone filters NOTHING — not even
    // the branch it names. It is spawn plumbing; only inPlaceRewinds can cut.
    _resetHistoryCacheForTesting();
    mockRecord = { pendingResumeSessionAt: 'u2' };
    expect(textsOf(await read('s-window'))).toEqual(unfiltered(t));
    expect(textsOf(await read('s-window'))).toContain('ABANDONED reply two');
  });

  it('hides the abandoned tip during the death window, before any new turn lands', async () => {
    // Right after the commit nothing has been appended yet, so the abandoned tip
    // is still the file's last line. The recorded cut ends at the commit-time last
    // tree line, which is that tip — so it goes, and the rewind point stays.
    const t = transcript()
      .user('u1', 'set up the project').assistant('a1', 'done setup')
      .user('u2', 'add a feature')
      .assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third ask');
    await write('s-death', t);
    mockRecord = { inPlaceRewinds: [cutHere(t, 'u2')], pendingResumeSessionAt: 'u2' };

    expect(textsOf(await read('s-death'))).toEqual(['set up the project', 'done setup', 'add a feature']);
  });

  it('composes a rewind of a rewind — neither abandoned branch leaks back', async () => {
    const t = transcript()
      .user('u1', 'set up the project').assistant('a1', 'done setup')
      .user('u2', 'add a feature').assistant('a2', 'ABANDONED reply two');
    const cut1 = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'ABANDONED different feature').assistant('a2b', 'ABANDONED new two');
    const cut2 = cutHere(t, 'a1');
    t.from('a1').user('u2c', 'scrap that, do this instead').assistant('a2c', 'NEW reply');
    await write('s-rw2', t);
    mockRecord = { inPlaceRewinds: [cut1, cut2] };

    const texts = textsOf(await read('s-rw2'));
    expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(texts).toEqual(['set up the project', 'done setup', 'scrap that, do this instead', 'NEW reply']);
  });

  it('serves the file UNFILTERED when a recorded cut can no longer be located', async () => {
    // Replaces the old stale-fingerprint case: the named degrade must show the
    // whole transcript rather than an empty or 404'd panel.
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one')
      .user('u2', 'DROP ME candidate')
      .from('u1').user('u1b', 'the live branch');
    await write('s-stale', t);
    mockRecord = { inPlaceRewinds: [{
      uuid: '0199dead-0000-4000-8000-000000000000', lastUuidAtCommit: 'u2', at: T(9),
    }] };

    const texts = textsOf(await read('s-stale'));
    expect(texts).toContain('DROP ME candidate');
    expect(texts).toContain('the live branch');
  });

  it('cuts only the recorded region of a compacted transcript, keeping pre-compact history', async () => {
    // Walnut's history view deliberately keeps every tree (users scroll back past
    // compactions) — a compact boundary is a new root, not a cut. A rewind INSIDE
    // the post-compact epoch must not touch anything before the boundary.
    const t = transcript()
      .user('u1', 'before the compaction').assistant('a1', 'pre-compact reply')
      .compactBoundary('cb', { logicalParentUuid: 'a1' })
      .user('sum', 'summary of what we did so far', { isCompactSummary: true })
      .user('u2', 'after the compaction')
      .assistant('a2', 'ABANDONED post-compact reply');
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'after the compaction, take two');
    await write('s-compact', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-compact'));
    expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(texts).toContain('before the compaction');
    expect(texts).toContain('pre-compact reply');
    expect(texts).toContain('summary of what we did so far');
    expect(texts).toContain('after the compaction, take two');
  });
});

describe('a never-rewound session is served byte-for-byte (the P0-A regressions)', () => {
  it('reads a transcript with no parentUuid at all identically', async () => {
    // Pre-port fixtures (and the Playwright pw-pins-session fixture) carry real
    // uuids but NO parentUuid, so every line is its own root.
    const t = transcript()
      .user('k1', 'keep everything', { parent: null })
      .assistant('k2', 'sure', { parent: null })
      .user('k3', 'and this too', { parent: null });
    await write('s-none', t);
    expect(textsOf(await read('s-none'))).toEqual(['keep everything', 'sure', 'and this too']);
  });

  it('keeps every row when an api_error line at EOF re-parents the next user message', async () => {
    // The measured worst shape: the newest leaf sits on a two-line stub hanging
    // off pre-turn state, so the whole 15-minute turn is off the CLI's resumable
    // chain (pinned as such in tests/core/transcript-chain.test.ts). Nothing was
    // ever rewound here, so every row must be served.
    const t = apiErrorEofForkFixture();
    await write('s-apierr', t);

    const texts = textsOf(await read('s-apierr'));
    expect(texts).toEqual(unfiltered(t));
    expect(texts).toContain('Found bug #1 visually');
    expect(texts).toContain('Root cause found in the logs. Let me confirm the config.');
    expect(texts).toContain('it still happened did you fix it');
    expect(texts.some((x) => x.startsWith('API error:'))).toBe(true);
  });

  it('keeps every row when a mid-turn slash command branches off pre-turn state', async () => {
    const t = midTurnCommandForkFixture();
    await write('s-cmdfork', t);

    const texts = textsOf(await read('s-cmdfork'));
    expect(texts).toEqual(unfiltered(t));
    expect(texts).toContain('Two distinct problems confirmed. Now profiling the server...');
    expect(texts).toContain('Root causes now clear.');
    expect(texts).toContain('Done, the first one is fixed.');
  });

  it('keeps both innocent forks on a REWOUND session whose cut region excludes them', async () => {
    // The same trap one step harder: this session really was rewound, so the
    // filter is active — but the api_error stub sits before the rewind point and
    // must survive the read exactly as it would with no cut at all.
    const t = apiErrorEofForkFixture();
    t.from('u3').assistant('aDead', 'ABANDONED reply to the last ask', { at: T(22) });
    const cut = cutHere(t, 'u3');
    t.from('u3').user('u4', 'the live take', { at: T(23) })
      .assistant('a4', 'NEW reply', { at: T(24) });
    await write('s-apierr-rw', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-apierr-rw'));
    expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(texts).toContain('Found bug #1 visually');
    expect(texts).toContain('Root cause found in the logs. Let me confirm the config.');
    expect(texts.some((x) => x.startsWith('API error:'))).toBe(true);
    expect(texts).toContain('the live take');
    // Exactly one row gone: the recorded region held one line.
    expect(texts).toHaveLength(unfiltered(t).length - 1);
  });

  it('keeps both results of a parallel tool call (DAG shape survives the parse)', async () => {
    // Two tool_uses of ONE message.id, each tool_result re-parented onto its own
    // one-block assistant. A positional cut can't lose one half of a group the way
    // a parent walk could, but the pairing must still come out whole.
    const t = transcript()
      .user('u1', 'run both')
      .toolUse('x1', 'tool-1', { msgId: 'msg_par' })
      .toolUse('x2', 'tool-2', { msgId: 'msg_par' })
      .toolResult('r1', 'tool-1', 'output one', { parent: 'x1' })
      .toolResult('r2', 'tool-2', 'output two', { parent: 'x2' })
      .from('r2').assistant('done', 'both finished');
    await write('s-par', t);

    const messages = await read('s-par');
    const results = messages.flatMap((m) => (m.tools ?? []).map((tool) => tool.result));
    expect(results).toContain('output one');
    expect(results).toContain('output two');
  });
});

describe('queue-operation echoes of a rewound-away message', () => {
  it('suppresses a dead-region enqueue by IDENTITY, while identical text outside it survives', async () => {
    // queue-operation / mode / last-prompt carry no uuid (16.4% of real lines) —
    // never filterable. A Pattern-B enqueue written INSIDE the dead region is the
    // echo of a message the rewind threw away (its real user line was just
    // filtered out), so it must not re-render as a queue row.
    //
    // The suppression is by the line's own timestamp+content identity key, never
    // by text alone (the round-1 text-matching version deleted a LIVE queue row
    // whenever the human reused a short instruction) and never by a time window
    // (file order is not time order — a [min,max] window reached back past the
    // rewind point and deleted live pre-cut rows). 'continue' appears twice here
    // — once dead, once live — and only the dead one may go.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .meta({ type: 'mode', mode: 'default', sessionId: 's-meta' })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-meta', content: 'continue', timestamp: T(4) })
      .from('a1').user('uDead', 'continue', { at: T(5) });
    const cut = cutHere(t, 'a1');
    t.from('a1').assistant('aLive', 'the live branch', { at: T(10) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-meta', content: 'continue', timestamp: T(11) });
    await write('s-meta', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-meta'));
    // One 'continue' row, not two, and not zero.
    expect(texts).toEqual(['first', 'reply one', 'the live branch', 'continue']);
  });

  it('suppresses BATCHED TWIN enqueues drained into one dead user line', async () => {
    // Two mid-turn sends the CLI drained into ONE '\n'-joined user line. Once that
    // line is filtered out, neither enqueue can find its twin, so both would
    // re-render as separate Pattern-B queue rows — the exact leak the round-1
    // text-set version could not catch (it only held the joined string).
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-batch', content: 'part one', timestamp: T(3) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-batch', content: 'part two', timestamp: T(4) })
      .from('a1').user('uDead', 'part one\npart two', { at: T(5) })
      .assistant('aDead', 'ABANDONED answer to both', { at: T(6) });
    const cut = cutHere(t, 'a1');
    t.from('a1').user('uLive', 'never mind, different plan', { at: T(10) });
    await write('s-batch', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-batch'));
    expect(texts).toEqual(['first', 'reply one', 'never mind, different plan']);
  });

  it('keeps a LIVE pre-cut queue row when the region carries backward-stamped lines', async () => {
    // The measured aa9758ba shape: an attachment inside the dead region is
    // stamped minutes BEFORE the rewind point (backward stamps are the norm —
    // 35/40 real transcripts), so the old [min,max] time window opened before
    // the cut and deleted live pre-cut Pattern-B rows, including a human-typed
    // message. Identity keys collect only the region's own enqueue lines, so
    // the live pre-cut queue row must survive every read.
    const t = transcript()
      .user('u1', 'first', { at: T(10) }).assistant('a1', 'reply one', { at: T(11) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-back', content: 'live mid-turn ask', timestamp: T(12) })
      .from('a1').user('u2', 'rewind here', { at: T(13) })
      .assistant('aDead', 'ABANDONED reply', { at: T(14) })
      .attachment('atDead', { at: T(2) })    // backward-stamped, inside the region
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-back', content: 'ABANDONED ask', timestamp: T(15) })
      .raw({ type: 'user', uuid: 'u3', parentUuid: 'aDead', timestamp: T(16), message: { role: 'user', content: 'ABANDONED third' } });
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'the live take', { at: T(20) });
    await write('s-back', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const texts = textsOf(await read('s-back'));
    expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false);
    expect(texts).toEqual(['first', 'reply one', 'live mid-turn ask', 'rewind here', 'the live take']);
  });

  it('suppresses an enqueue that TRAILED the commit-time anchor (captured on the cut record)', async () => {
    // The human queued a message mid-turn, then hit Rewind before the CLI
    // drained it. Queue lines carry no uuid, so the trailing enqueue sits
    // outside the uuid-anchored region — the commit captured its identity key
    // as cut.trailingQueueKeys, and the read unions it into the dead keys.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .assistant('aDead', 'ABANDONED reply', { at: T(3) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-trail', content: 'ABANDONED queued ask', timestamp: T(4) });
    const cut = cutHere(t, 'a1');            // anchor = aDead; the enqueue trails it
    expect(cut.trailingQueueKeys).toHaveLength(1);
    t.from('a1').user('u2', 'the live take', { at: T(10) });
    await write('s-trail', t);
    mockRecord = { inPlaceRewinds: [cut] };

    expect(textsOf(await read('s-trail'))).toEqual(['first', 'reply one', 'the live take']);
  });

  it('leaves every enqueue alone on a session with no recorded rewind', async () => {
    // No cut → no dead keys → the queue rows render exactly as before the port.
    const t = transcript()
      .user('u1', 'first', { at: T(1) }).assistant('a1', 'reply one', { at: T(2) })
      .raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-noq', content: 'continue', timestamp: T(3) })
      .from('a1').user('u2', 'and then this', { at: T(4) });
    await write('s-noq', t);

    expect(textsOf(await read('s-noq'))).toEqual(['first', 'reply one', 'continue', 'and then this']);
  });
});

describe('windowed reads are refused for a session with recorded rewinds', () => {
  /** ~60 threaded padding pairs so a small byte bound still windows the file. */
  function padded(): TranscriptFixture {
    const t = transcript();
    t.user('p-u0', 'padding question 0 ' + 'x'.repeat(120));
    for (let i = 1; i <= 60; i++) {
      t.assistant(`p-a${i}`, `padding answer ${i} ` + 'y'.repeat(120));
      t.user(`p-u${i}`, `padding question ${i} ` + 'x'.repeat(120));
    }
    return t;
  }

  /** padded() + a rewound-away tail, with the cut a real commit would record. */
  function paddedRewound(): { t: TranscriptFixture; cut: InPlaceRewindCut } {
    const t = padded().user('u2', 'add a feature')
      .assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third ask');
    return { t, cut: cutHere(t, 'u2') };
  }

  it('a recorded rewind forces the bounded COLD read onto the full filtering read', async () => {
    // A 4 KiB tail window cannot resolve the cut anchors (they may precede the
    // window), so it would serve the branch the user rewound away as live.
    const { t, cut } = paddedRewound();
    await write('s-cold-pending', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const messages = await readSessionHistory('s-cold-pending', CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4096 });
    expect(isWindowedHistory(messages)).toBe(false);
    expect(textsOf(messages).some((x) => x.includes('ABANDONED'))).toBe(false);
  });

  it('without a recorded rewind the bounded cold read still windows (unchanged contract)', async () => {
    await write('s-cold-plain', padded());
    const messages = await readSessionHistory('s-cold-plain', CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4096 });
    expect(isWindowedHistory(messages)).toBe(true);
    expect(messages.length).toBeLessThan(121);
  });

  it('readSessionHistoryTail also refuses its window for a session with recorded rewinds', async () => {
    const { t, cut } = paddedRewound();
    await write('s-tail-pending', t);
    mockRecord = { inPlaceRewinds: [cut] };

    const messages = await readSessionHistoryTail('s-tail-pending', CWD, undefined, undefined, 4096);
    expect(messages).not.toBeNull();
    expect(isWindowedHistory(messages!)).toBe(false);
    expect(textsOf(messages!).some((x) => x.includes('ABANDONED'))).toBe(false);
  });

  it('readSessionHistoryTail windows a plain session (unchanged contract)', async () => {
    await write('s-tail-plain', padded());
    const messages = await readSessionHistoryTail('s-tail-plain', CWD, undefined, undefined, 4096);
    expect(messages).not.toBeNull();
    expect(isWindowedHistory(messages!)).toBe(true);
  });

  it('over the reader byte ceiling, the bounded tail is served UNFILTERED (documented degrade)', async () => {
    // A transcript past the reader's hard ceiling cannot be read whole, so the cut
    // anchors are unresolvable. Showing recent history, abandoned lines included,
    // beats a blank panel — so this pins the degrade deliberately, with the warn
    // the read path logs.
    const { t, cut } = paddedRewound();
    await write('s-ceiling', t);
    mockRecord = { inPlaceRewinds: [cut] };
    process.env.WALNUT_MAX_FILE_READ_BYTES = '8192';

    const messages = await read('s-ceiling');
    expect(isWindowedHistory(messages)).toBe(true);
    expect(textsOf(messages).some((x) => x.includes('ABANDONED'))).toBe(true);
  });
});
