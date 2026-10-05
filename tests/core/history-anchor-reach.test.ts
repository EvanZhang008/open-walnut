/**
 * readHistoryReachingAnchor against an in-memory reader that answers short reads,
 * so the edges a real daemon can produce are pinned: a read returns fewer bytes
 * than asked, the anchor id straddles two reads, the anchor's own line is longer
 * than the lookbehind, and the reader's ceiling bounds the search.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-anchor-reach-unit'));

let file = Buffer.alloc(0);
/** Bytes one readRangeBytes call hands back at most (a daemon may answer short). */
let shortRead = 300_000;
let ceiling = 8 * 1024 * 1024;
let reads = 0;

vi.mock('../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    static maxReadBytes(): number { return ceiling; }
    async stat() { return { size: file.length, mtimeMs: 1 }; }
    async findSessionPath() { return '/fake/session.jsonl'; }
    async readRangeBytes(_p: string, start: number, length: number) {
      reads++;
      const end = Math.min(file.length, start + Math.min(length, shortRead));
      return { buf: file.subarray(start, end), fileSize: file.length, eof: end >= file.length };
    }
  },
}));

vi.mock('../../src/core/session-history.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/session-history.js')>()),
  hasInPlaceRewinds: async () => false,
  resolveHistoryWindowPath: async () => '/fake/session.jsonl',
}));

import { readHistoryReachingAnchor } from '../../src/core/history-anchor-reach.js';

const SID = 'anchor-reach-unit';
let t0 = Date.parse('2026-10-05T10:00:00Z');
const ts = () => new Date(t0 += 1000).toISOString();

function user(uuid: string, text: string, pad = 0): string {
  return JSON.stringify({
    type: 'user', sessionId: SID, timestamp: ts(), message: { role: 'user', content: text },
    ...(pad ? { pastedBytes: 'p'.repeat(pad) } : {}), uuid,
  });
}
function reply(id: string, text: string): string {
  return JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: ts(), uuid: `u-${id}`, message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
}
function bulk(n: number, bytes: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const tu = `tu-${t0}-${i}`;
    out.push(
      JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: ts(), uuid: `c-${tu}`, message: { id: `msg_c_${tu}`, role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', sessionId: SID, timestamp: ts(), uuid: `r-${tu}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'i'.repeat(bytes) }] } }),
    );
  }
  return out;
}
const build = (lines: string[]) => { file = Buffer.from(lines.join('\n') + '\n'); };

beforeEach(() => {
  shortRead = 300_000;
  ceiling = 8 * 1024 * 1024;
  reads = 0;
});

describe('readHistoryReachingAnchor', () => {
  it('reads through short reads and returns the run from before the anchor to the end', async () => {
    build([...bulk(4, 1_000_000), reply('msg_anchor', 'anchor reply'), ...bulk(5, 1_000_000), reply('msg_last', 'last reply')]);
    const got = await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_anchor');
    expect(got).not.toBeNull();
    const texts = got!.messages.map((m) => m.text);
    expect(texts).toContain('anchor reply');
    expect(texts.at(-1)).toBe('last reply');
    expect(texts.indexOf('anchor reply')).toBeLessThan(texts.indexOf('last reply'));
    expect(reads, 'more calls than 1 MB chunks: the reader answered short').toBeGreaterThan(8);
  });

  it('finds an id that straddles the first run boundary (8 MB from the end)', async () => {
    const lines = (filler: number) => [
      ...bulk(3, 900_000), reply('msg_straddle', 'straddle reply'),
      JSON.stringify({ type: 'user', sessionId: SID, timestamp: '2026-10-05T11:00:00.000Z', uuid: 'r-fill', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-fill', content: 'f'.repeat(filler) }] } }),
      reply('msg_tail', 'tail reply'),
    ];
    // Room to grow past the first run.
    ceiling = 16 * 1024 * 1024;
    // Size the filler so the first run starts 5 bytes into the quoted id.
    build(lines(8_000_000));
    const off = (file.length - file.indexOf('"msg_straddle"')) - (8 * 1024 * 1024 + 5);
    build(lines(8_000_000 - off));
    expect(file.length - 8 * 1024 * 1024).toBe(file.indexOf('"msg_straddle"') + 5);
    const got = await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_straddle');
    expect(got?.messages.some((m) => m.msgId === 'msg_straddle')).toBe(true);
    expect(got?.messages.at(-1)?.text).toBe('tail reply');
  });

  it('finds a user anchor whose uuid sits at the end of a line longer than the lookbehind', async () => {
    build([...bulk(2, 500_000), user('u-anchor-1', 'pasted a picture', 1_600_000), ...bulk(5, 1_000_000), reply('msg_after', 'after')]);
    const got = await readHistoryReachingAnchor(SID, '/c', undefined, 'u-anchor-1');
    expect(got?.messages.find((m) => m.msgId === 'u-anchor-1')?.text).toBe('pasted a picture');
  });

  it('skips a newer line that only quotes the id and keeps looking further back', async () => {
    build([
      ...bulk(2, 500_000), reply('msg_quoted', 'the real row'), ...bulk(3, 1_000_000),
      JSON.stringify({ type: 'user', sessionId: SID, timestamp: ts(), uuid: 'r-grep', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-grep', content: 'grep hit "msg_quoted"' }] } }),
      ...bulk(2, 1_000_000), reply('msg_end', 'end'),
    ]);
    const got = await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_quoted');
    expect(got?.messages.find((m) => m.msgId === 'msg_quoted')?.text).toBe('the real row');
  });

  it('gives up past the reader ceiling and when the id is nowhere', async () => {
    build([reply('msg_far', 'far'), ...bulk(10, 1_000_000), reply('msg_end', 'end')]);
    expect(await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_far')).toBeNull();
    expect(await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_missing')).toBeNull();
    ceiling = 16 * 1024 * 1024;
    expect((await readHistoryReachingAnchor(SID, '/c', undefined, 'msg_far'))?.messages[0].text).toBe('far');
  });
});
