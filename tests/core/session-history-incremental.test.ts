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
