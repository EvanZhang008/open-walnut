/**
 * A cold read of a whole transcript never holds the server's loop for more than a slice of it.
 *
 * 2026-11-24: the full read parsed the transcript in one go, then the incremental seed checked
 * itself with a parse of the prefix (most of the file) and one of the tail, up to three times
 * when a boundary split a tool call from its result, all in the same turn of the loop: 145 to
 * 343 ms for a 16 MB transcript, 370 to 718 ms at 31 MB. Now every parse gets turns of its own
 * (session-history.ts seedIncrementalState) and its JSON.parse of the lines runs in slices
 * (history-parse.ts parseSessionMessagesYielding).
 *
 * Measured by what the loop does, not by a clock: every JSON.parse is counted against the turn it
 * ran in (a self-rescheduling setImmediate ticks once a turn), and no turn may take more than a
 * share of the file. The seed's retries stay (the 2026-11-03 rule: a boundary that splits a pair
 * is moved, or the session is read whole on every change): the read is still seeded, and the next
 * change reads only its new lines.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cold-read-turns'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath, readSessionHistory, _historyCacheGetForTesting, _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';

const CWD = '/tmp/marina/cold-read-turns';
const T0 = Date.UTC(2026, 0, 1);

/**
 * Turns of eight tool calls. The calls carry the bytes (long commands, short results), so the
 * seed's first boundary, a megabyte from the end, falls inside a call and splits it from its
 * result: the seed must move it, the costly case.
 */
function transcript(targetBytes: number): string {
  const out: string[] = [];
  let bytes = 0;
  let s = 0;
  const at = () => new Date(T0 + (s++) * 7000).toISOString();
  const push = (o: unknown) => { const j = JSON.stringify(o); out.push(j); bytes += j.length + 1; };
  for (let t = 0; bytes < targetBytes; t++) {
    push({ type: 'user', uuid: `u${t}`, cwd: CWD, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: `Do step ${t}.` }] } });
    for (let c = 0; c < 8; c++) {
      const id = `toolu_${t}x${c}abcdefgh`;
      push({ type: 'assistant', uuid: `a${t}-${c}`, timestamp: at(), message: { id: `m${t}-${c}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${'x'.repeat(4000)} ${t}.${c}` } }] } });
      push({ type: 'user', uuid: `r${t}-${c}`, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    }
    push({ type: 'assistant', uuid: `p${t}`, timestamp: at(), message: { id: `p${t}`, role: 'assistant', content: [{ type: 'text', text: `Step ${t} done.` }] } });
  }
  return out.join('\n') + '\n';
}

let fileChars = 0;
const FILE = () => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), 's-cold.jsonl');

beforeAll(async () => {
  await fsp.mkdir(path.dirname(FILE()), { recursive: true });
  const text = transcript(8 * 1024 * 1024);
  fileChars = text.length;
  await fsp.writeFile(FILE(), text);
});

/** Characters JSON.parse took in each turn of the loop while `work` ran. */
async function charsPerTurn<T>(work: () => Promise<T>): Promise<{ value: T; turns: number[] }> {
  const turns: number[] = [0];
  let on = true;
  const tick = () => { if (!on) return; turns.push(0); setImmediate(tick); };
  setImmediate(tick);
  const real = JSON.parse;
  const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    turns[turns.length - 1] += typeof text === 'string' ? text.length : 0;
    return real(text, reviver);
  }) as typeof JSON.parse);
  try {
    return { value: await work(), turns };
  } finally {
    on = false;
    spy.mockRestore();
  }
}

afterAll(() => { vi.restoreAllMocks(); });

describe('a cold read of a whole transcript', () => {
  it('parses no more than a slice of it in any one turn of the loop, and still seeds the next read', async () => {
    _resetHistoryCacheForTesting();
    const { value, turns } = await charsPerTurn(() => readSessionHistory('s-cold', CWD, undefined, undefined, { skipSubagents: true }));
    expect(value.length).toBeGreaterThan(1000);
    const total = turns.reduce((a, b) => a + b, 0);
    // The read parsed the file and the seed checked itself (more parses of it): at least twice the file.
    expect(total).toBeGreaterThanOrEqual(fileChars * 2);
    // Before: the whole file two or three times over in one turn. Now a slice of lines at a time
    // (history-parse.ts PARSE_SLICE_CHARS, 1 MB, an eighth of this file).
    expect(Math.max(...turns)).toBeLessThan(fileChars / 4);
    // The seed moved its boundary off the split pair and took: the next change is an incremental read.
    expect(_historyCacheGetForTesting('s-cold')?.inc).toBeDefined();
  }, 60_000);
});

describe('the cwd a full read looks for', () => {
  it('parses only lines that name a cwd, so a transcript without one is not parsed whole for it', async () => {
    const { extractCwdFromJsonlContent } = await import('../../src/core/session-file-reader.js');
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: 'no folder here' } }));
    const { value, turns } = await charsPerTurn(async () => extractCwdFromJsonlContent(lines.join('\n')));
    expect(value).toBeUndefined();
    expect(turns.reduce((a, b) => a + b, 0)).toBe(0);
    const withCwd = [...lines, JSON.stringify({ type: 'user', cwd: '/tmp/marina/here', message: { role: 'user', content: 'x' } })];
    expect(extractCwdFromJsonlContent(withCwd.join('\n'))).toBe('/tmp/marina/here');
  });
});
