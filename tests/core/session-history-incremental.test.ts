/**
 * Incremental append-read for readSessionHistory (HistoryIncrementalState).
 *
 * The 2026-07-24 incident: every mtime change re-read + re-parsed the WHOLE
 * canonical JSONL (7,230 full reads / 167 GB / day; a 233 MB whale re-read
 * 467×, ending in a V8-heap-OOM crash loop). The fix reads only appended
 * bytes and re-parses just the tail segment. These tests verify:
 *   1. append → incremental result identical to a cold full parse
 *   2. /compact rewrite (shrink AND same-size) → detected, full re-parse
 *   3. cross-boundary tool_result → falls back to full read (no lost result)
 *   4. multiple consecutive appends keep extending correctly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  getOrphanFinishedAgentIds,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME;
const CWD = '/tmp/inc-test-project';

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

function jsonlPath(sessionId: string): string {
  return path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

async function writeLines(sessionId: string, lines: unknown[]): Promise<void> {
  const p = jsonlPath(sessionId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

async function appendLines(sessionId: string, lines: unknown[]): Promise<void> {
  await fsp.appendFile(jsonlPath(sessionId), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

/** Bump mtime so the mtime-equality fast path doesn't mask the code under test. */
async function bumpMtime(sessionId: string): Promise<void> {
  const future = new Date(Date.now() + Math.floor(Math.random() * 50_000) + 1_000);
  await fsp.utimes(jsonlPath(sessionId), future, future);
}

let uuidN = 0;
function userLine(text: string) {
  return {
    type: 'user', uuid: `u-${++uuidN}`, timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  };
}
function assistantLine(text: string, id?: string) {
  return {
    type: 'assistant', uuid: `a-${++uuidN}`, timestamp: new Date().toISOString(),
    message: { id: id ?? `msg_${uuidN}`, role: 'assistant', content: [{ type: 'text', text }] },
  };
}
function toolUseLine(toolId: string, name: string, msgId?: string) {
  return {
    type: 'assistant', uuid: `a-${++uuidN}`, timestamp: new Date().toISOString(),
    message: {
      id: msgId ?? `msg_${uuidN}`, role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name, input: { cmd: 'x' } }],
    },
  };
}
function toolResultLine(toolId: string, text: string) {
  return {
    type: 'user', uuid: `u-${++uuidN}`, timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }],
    },
  };
}

describe('incremental append-read', () => {
  it('parses only appended bytes and matches a cold full parse exactly', async () => {
    const sid = 'inc-basic';
    await writeLines(sid, [userLine('hello'), assistantLine('hi there')]);

    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(first.map(m => m.text)).toEqual(['hello', 'hi there']);
    // Seeding happened (small file: whole thing is the tail segment).
    expect(_historyCacheGetForTesting(sid)?.inc).toBeDefined();

    await appendLines(sid, [userLine('second question'), assistantLine('second answer')]);
    await bumpMtime(sid);
    const second = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    // Compare against a COLD full parse of the same file.
    _resetHistoryCacheForTesting();
    const cold = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(second).toEqual(cold);
    expect(second.map(m => m.text)).toEqual(['hello', 'hi there', 'second question', 'second answer']);
  });

  it('detects a shrink rewrite (/compact) and re-parses fully', async () => {
    const sid = 'inc-shrink';
    await writeLines(sid, [userLine('one'), assistantLine('two'), userLine('three'), assistantLine('four')]);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    // Rewrite smaller (compaction).
    await writeLines(sid, [userLine('compacted summary')]);
    await bumpMtime(sid);
    const after = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(after.map(m => m.text)).toEqual(['compacted summary']);
  });

  it('detects a same-or-grown in-place rewrite via last-line fingerprint', async () => {
    const sid = 'inc-rewrite';
    await writeLines(sid, [userLine('aaa'), assistantLine('bbb')]);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    // Rewrite with different content but LARGER size (fingerprint must catch it).
    await writeLines(sid, [
      userLine('totally different opening message'),
      assistantLine('a different and much longer reply than before'),
      userLine('an extra third line to guarantee growth'),
    ]);
    await bumpMtime(sid);
    const after = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(after.map(m => m.text)).toEqual([
      'totally different opening message',
      'a different and much longer reply than before',
      'an extra third line to guarantee growth',
    ]);
  });

  it('attaches a tool_result that arrives in a later append (pending-tool fallback)', async () => {
    const sid = 'inc-toolresult';
    // Tool use with NO result yet — long-running tool.
    await writeLines(sid, [userLine('run it'), toolUseLine('tool-abc-123', 'Bash')]);
    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(first[1].tools?.[0]?.result).toBeUndefined();

    // Result arrives later — references the prefix tool id.
    await appendLines(sid, [toolResultLine('tool-abc-123', 'the output'), assistantLine('done')]);
    await bumpMtime(sid);
    const second = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    const toolMsg = second.find(m => m.tools?.some(t => t.toolUseId === 'tool-abc-123'));
    expect(toolMsg?.tools?.[0]?.result).toBe('the output');

    // Must equal a cold parse.
    _resetHistoryCacheForTesting();
    const cold = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(second).toEqual(cold);
  });

  it('handles several consecutive appends', async () => {
    const sid = 'inc-multi';
    await writeLines(sid, [userLine('m1')]);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    for (let round = 2; round <= 5; round++) {
      await appendLines(sid, [assistantLine(`reply ${round}`), userLine(`m${round}`)]);
      await bumpMtime(sid);
      const got = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
      expect(got[got.length - 1].text).toBe(`m${round}`);
    }

    const warm = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    _resetHistoryCacheForTesting();
    const cold = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(warm).toEqual(cold);
    expect(cold.map(m => m.text)).toEqual([
      'm1', 'reply 2', 'm2', 'reply 3', 'm3', 'reply 4', 'm4', 'reply 5', 'm5',
    ]);
  });

  it('orphan finished-agent ids survive incremental tail reads (prefix ∪ tail)', async () => {
    // inc-1786496042099: the proof rides a WeakMap keyed on the parser's OWN
    // array; the incremental merge builds a NEW array from prefix+tail, so ids
    // proven before the boundary must be unioned back from the cache entry.
    const sid = 'inc-orphan';
    const notif = (toolUseId: string) =>
      `<task-notification>\n<task-id>fixture01</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n<result>r</result>\n</task-notification>`;
    await writeLines(sid, [
      userLine('start'),
      assistantLine('working'),
      // Orphan proof: no tool row anywhere carries this id (nested agent).
      { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: notif('toolu_prefix_orphan') },
    ]);

    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(getOrphanFinishedAgentIds(first)?.has('toolu_prefix_orphan')).toBe(true);
    expect(_historyCacheGetForTesting(sid)?.inc).toBeDefined();
    expect(_historyCacheGetForTesting(sid)?.orphanFinishedIds).toEqual(['toolu_prefix_orphan']);

    // Append plain turns — the tail parse alone would see NO notification.
    await appendLines(sid, [userLine('next'), assistantLine('answer')]);
    await bumpMtime(sid);
    const second = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(second.map(m => m.text)).toContain('answer');
    // The merged array must still carry the prefix-proven orphan id.
    expect(getOrphanFinishedAgentIds(second)?.has('toolu_prefix_orphan')).toBe(true);

    // A NEW orphan proof arriving in a later append unions in alongside.
    await appendLines(sid, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: notif('toolu_tail_orphan') },
      assistantLine('post-notif'),
    ]);
    await bumpMtime(sid);
    const third = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const ids = getOrphanFinishedAgentIds(third);
    expect(ids?.has('toolu_prefix_orphan')).toBe(true);
    expect(ids?.has('toolu_tail_orphan')).toBe(true);
    expect([..._historyCacheGetForTesting(sid)?.orphanFinishedIds ?? []].sort())
      .toEqual(['toolu_prefix_orphan', 'toolu_tail_orphan']);
  });

  it('orphan id in the FROZEN PREFIX survives when the tail parse cannot see it (real boundary)', async () => {
    // The strict shape of the incident: the file is big enough that the
    // notification line freezes into the prefix (boundary = last ~1 MB), so the
    // tail re-parse NEVER sees it — only the cache-entry union can carry it.
    const sid = 'inc-orphan-prefix';
    const notif =
      '<task-notification>\n<task-id>fixture02</task-id>\n<tool-use-id>toolu_deep_prefix</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n<result>r</result>\n</task-notification>';
    const lines: unknown[] = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: notif },
    ];
    // ~3 MB of paired tool turns (results paired so pendingToolIds stays empty
    // — an unresolved prefix tool id would force full reads and mask the path).
    for (let i = 0; i < 12; i++) {
      lines.push(toolUseLine(`bulk-${i}`, 'Bash'), toolResultLine(`bulk-${i}`, 'X'.repeat(250_000)));
    }
    await writeLines(sid, lines);

    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(getOrphanFinishedAgentIds(first)?.has('toolu_deep_prefix')).toBe(true);
    const inc = _historyCacheGetForTesting(sid)?.inc;
    expect(inc).toBeDefined();
    // The notification really is beyond the tail boundary (frozen prefix).
    expect(inc!.tailText).not.toContain('toolu_deep_prefix');

    await appendLines(sid, [userLine('later question'), assistantLine('later answer')]);
    await bumpMtime(sid);
    const second = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(second.map(m => m.text)).toContain('later answer');
    expect(getOrphanFinishedAgentIds(second)?.has('toolu_deep_prefix')).toBe(true);
  });

  it('assistant message blocks split across an append boundary stay merged', async () => {
    const sid = 'inc-splitmsg';
    // Same message.id across two lines — second line appended later.
    const msgId = 'msg_split_1';
    await writeLines(sid, [userLine('go'), {
      type: 'assistant', uuid: 'a-s1', timestamp: new Date().toISOString(),
      message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: 'part one.' }] },
    }]);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    await appendLines(sid, [{
      type: 'assistant', uuid: 'a-s2', timestamp: new Date().toISOString(),
      message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: 'part two.' }] },
    }]);
    await bumpMtime(sid);
    const warm = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    _resetHistoryCacheForTesting();
    const cold = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(warm).toEqual(cold);
    // Both parts present in one message (merged), not two.
    const asst = cold.filter(m => m.role === 'assistant');
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toContain('part one.');
    expect(asst[0].text).toContain('part two.');
  });
});

/**
 * The cache's byte budget (MAX_HISTORY_CACHE_CHARS) can only work if entries are
 * charged their real retained size. The incremental path used to charge only the
 * sum of message `.text` lengths — but tool inputs/results carry no `.text` and
 * dominate a coding transcript, so a 100 MB session was booked as a few hundred KB
 * and eviction effectively never fired for any session refreshed this way.
 */
describe('incremental path byte accounting', () => {
  // The tail segment rolls at 4 MB (TAIL_SEGMENT_ROLL_BYTES). BELOW that the whole
  // file IS the tail, so the old and new formulas nearly agree — a small fixture
  // cannot tell them apart. These fixtures deliberately exceed the roll threshold
  // so the parsed prefix is non-empty, which is exactly where the old formula lost
  // the tool bytes (prefixMessages contribute only their .text).
  const bulkTurns = (n: number, bytesEach: number) => {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      out.push(toolUseLine(`t${i}`, 'Bash'), toolResultLine(`t${i}`, 'X'.repeat(bytesEach)));
    }
    return out;
  };

  it('charges tool-heavy content in the parsed prefix, not just message text', async () => {
    const sid = 'inc-accounting';
    // ~6 MB of tool-result bytes: forces a tail roll, leaving most bytes in the prefix.
    await writeLines(sid, bulkTurns(12, 500_000));
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    await appendLines(sid, [userLine('next question'), assistantLine('next answer')]);
    await bumpMtime(sid);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    const entry = _historyCacheGetForTesting(sid);
    expect(entry?.inc).toBeDefined();
    const fileBytes = (await fsp.stat(jsonlPath(sid))).size;
    // The old formula booked this ~6 MB session at a few hundred bytes (tool_result
    // content carries no .text). Require most of the real size to be charged.
    expect(entry!.approxChars).toBeGreaterThan(fileBytes * 0.5);
    // ...and never MORE than the file (that would mean the tail is double-counted).
    expect(entry!.approxChars).toBeLessThanOrEqual(fileBytes);
  });

  it('does not double-count the rolling tail across repeated appends', async () => {
    const sid = 'inc-no-double';
    await writeLines(sid, bulkTurns(10, 500_000));
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    for (let i = 0; i < 4; i++) {
      await appendLines(sid, bulkTurns(2, 300_000));
      await bumpMtime(sid);
      await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
      const fileBytes = (await fsp.stat(jsonlPath(sid))).size;
      // parsedBytes + tailText.length would drift past the file size as the tail rolls.
      expect(_historyCacheGetForTesting(sid)!.approxChars).toBeLessThanOrEqual(fileBytes);
    }
  });

  it('agrees with the full-read path on the same content', async () => {
    const sid = 'inc-vs-full';
    await writeLines(sid, bulkTurns(12, 500_000));

    // Cold full read charges raw source size — the reference figure.
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const fullCharge = _historyCacheGetForTesting(sid)!.approxChars;
    expect(fullCharge).toBeGreaterThan(1_000_000);

    await appendLines(sid, [userLine('three')]);
    await bumpMtime(sid);
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const incCharge = _historyCacheGetForTesting(sid)!.approxChars;

    // The old bug made the incremental charge orders of magnitude smaller.
    expect(incCharge).toBeGreaterThan(fullCharge * 0.5);
  });
});

/**
 * The reader's hard byte ceiling REJECTS an oversized whole-file read. History must
 * degrade to a bounded tail window rather than surfacing a load error — a very long
 * transcript still renders its recent messages, which is what the UI shows anyway.
 */
describe('history degrades to a bounded tail at the byte ceiling', () => {
  const withLimit = async <T>(bytes: number, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.WALNUT_MAX_FILE_READ_BYTES;
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(bytes);
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
      else process.env.WALNUT_MAX_FILE_READ_BYTES = prev;
    }
  };

  it('serves recent messages instead of failing when the file exceeds the ceiling', async () => {
    const sid = 'ceiling-degrade';
    const lines: unknown[] = [];
    // ~5 MB of bulk, then clearly identifiable recent turns at the very end.
    for (let i = 0; i < 10; i++) {
      lines.push(toolUseLine(`b${i}`, 'Bash'), toolResultLine(`b${i}`, 'X'.repeat(500_000)));
    }
    lines.push(userLine('LATEST QUESTION'), assistantLine('LATEST ANSWER'));
    await writeLines(sid, lines);
    _resetHistoryCacheForTesting();

    await withLimit(2 * 1024 * 1024, async () => {
      const msgs = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
      // Must NOT be an empty/error result — the tail window carries the recent turns.
      expect(msgs.length).toBeGreaterThan(0);
      const texts = msgs.map(m => m.text ?? '').join('\n');
      expect(texts).toContain('LATEST ANSWER');
    });
  });

  it('serves a BOUNDED tail — not the whole transcript — when over the ceiling', async () => {
    // Distinguishes "degradation ran" from "ceiling never fired". An earlier version
    // of this suite mocked the reader without a ceiling, so the assertion above was
    // satisfied by a FULL read and the regression shipped anyway.
    const sid = 'ceiling-bounded';
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(toolUseLine(`b${i}`, 'Bash'), toolResultLine(`b${i}`, 'X'.repeat(500_000)));
    }
    lines.push(userLine('LATEST QUESTION'), assistantLine('LATEST ANSWER'));
    await writeLines(sid, lines);
    _resetHistoryCacheForTesting();

    const full = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    _resetHistoryCacheForTesting();

    await withLimit(1024 * 1024, async () => {
      const msgs = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
      expect(msgs.length).toBeGreaterThan(0);
      // Strictly fewer messages than the full parse — the window really is a window.
      expect(msgs.length).toBeLessThan(full.length);
      expect(msgs.map(m => m.text ?? '').join('\n')).toContain('LATEST ANSWER');
    });
  });

  it('a file under the ceiling is unaffected (full history, not a tail)', async () => {
    const sid = 'ceiling-normal';
    await writeLines(sid, [userLine('first'), assistantLine('second'), userLine('third')]);
    _resetHistoryCacheForTesting();

    await withLimit(32 * 1024 * 1024, async () => {
      const msgs = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
      expect(msgs.map(m => m.text)).toEqual(['first', 'second', 'third']);
    });
  });
});
