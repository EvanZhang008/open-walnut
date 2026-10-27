import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readdir, rename, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanCanonicalUsage, type CanonicalUsageRecord } from '../../src/providers/usage-scan-core.js';
import { INDEX_HORIZON_MS, scanCanonicalUsageIndexed } from '../../src/providers/usage-scan-index.js';

// The index must give exactly the full scan's answer for the same files and window.
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const SINCE = '2026-10-14T09:00:00.000Z';
const UNTIL = '2026-10-14T12:00:00.000Z';
const at = (hh: number, mm = 0, ss = 0) => `2026-10-14T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;
const USAGE = { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 30,
  speed: 'standard', inference_geo: '', service_tier: 'standard', server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, iterations: [] };

function reply(id: string, timestamp: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return { type: 'assistant', timestamp, ...extra, message: { id, model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { ...USAGE, ...usage } } };
}
const line = (row: unknown) => JSON.stringify(row) + '\n';

let root: string;
let indexPath: string;
async function write(relative: string, rows: unknown[], raw = '') {
  const target = path.join(root, 'projects', relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rows.map(line).join('') + raw);
  return target;
}
const file = (relative: string) => path.join(root, 'projects', relative);

function sorted(records: CanonicalUsageRecord[]) {
  return [...records].sort((a, b) => `${a.model}|${a.responseId}`.localeCompare(`${b.model}|${b.responseId}`));
}

async function both(opts: { since?: string; until?: string; sessionIds?: string[]; now?: number } = {}) {
  const window = { projectsDir: path.join(root, 'projects'), since: opts.since ?? SINCE, until: opts.until ?? UNTIL, sessionIds: opts.sessionIds };
  const indexed = await scanCanonicalUsageIndexed({ ...window, indexPath, now: opts.now ?? NOW });
  const full = await scanCanonicalUsage(window);
  expect(sorted(indexed.records)).toEqual(sorted(full.records));
  return indexed;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'usage-index-'));
  indexPath = path.join(root, 'index', 'projects.jsonl');
  await mkdir(path.join(root, 'projects'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('scanCanonicalUsageIndexed', () => {
  it('builds the index on the first scan and then reads only what the files gained', async () => {
    await write('p/main.jsonl', [reply('m1', at(9, 30)), reply('m2', at(10))]);
    await write('p/other.jsonl', [reply('o1', at(9, 45))]);
    await write('p/main/subagents/agent-a.jsonl', [reply('a1', at(10, 5))]);
    const first = await both();
    expect(first.scan.mode).toBe('rebuilt');
    expect(first.records).toHaveLength(4);
    await appendFile(file('p/main.jsonl'), line(reply('m3', at(11))));
    const second = await both();
    expect(second.scan).toMatchObject({ mode: 'incremental', filesUnchanged: 2, filesReread: 0 });
    expect(second.records.map(r => r.responseId).sort()).toEqual(['a1', 'm1', 'm2', 'm3', 'o1']);
    // main.jsonl's new line, plus one small check read per file and main's head and mark.
    expect(second.scan.bytesRead).toBeLessThan(line(reply("m3", at(11))).length + 3 * 1024 + 256 + 1024 + 256);
  });

  it('reads new calls in an old conversation whatever its modification time says', async () => {
    const target = await write('p/old.jsonl', [reply('before', at(9, 10))]);
    await both();
    await appendFile(target, line(reply('new-call', at(11))));
    await utimes(target, new Date('2000-01-01'), new Date('2000-01-01'));
    const again = await both();
    expect(again.records.map(r => r.responseId).sort()).toEqual(['before', 'new-call']);
  });

  it('notices a file rewritten in place at the same size, and one truncated, and one replaced', async () => {
    const same = await write('p/same.jsonl', [reply('s1', at(9, 30), {}, { output_tokens: 10 })]);
    const short = await write('p/short.jsonl', [reply('t1', at(9, 30)), reply('t2', at(9, 40))]);
    const moved = await write('p/moved.jsonl', [reply('r1', at(9, 30))]);
    await both();
    await writeFile(same, line(reply('s1', at(9, 30), {}, { output_tokens: 20 })));
    await truncate(short, 0);
    await writeFile(short, line(reply('t3', at(10))));
    await writeFile(`${moved}.new`, line(reply('r2', at(10))));
    await rename(`${moved}.new`, moved);
    const again = await both();
    expect(again.scan.filesReread).toBeGreaterThanOrEqual(2);
    expect(sorted(again.records).map(r => [r.responseId, r.output_tokens])).toEqual([['r2', 8], ['s1', 20], ['t3', 8]]);
  });

  it('counts a last line still being written once, and its final form once it ends', async () => {
    const target = await write('p/live.jsonl', [reply('done', at(9, 30))],
      JSON.stringify({ type: 'assistant', timestamp: at(10), message: { id: 'live', model: 'claude-opus-4-8', stop_reason: null, usage: { ...USAGE, output_tokens: 3 } } }));
    const first = await both();
    expect(first.records.find(r => r.responseId === 'live')?.output_tokens).toBe(3);
    await appendFile(target, '\n' + line(reply('live', at(10), {}, { output_tokens: 50 })));
    const second = await both();
    expect(second.records.filter(r => r.responseId === 'live').map(r => r.output_tokens)).toEqual([50]);
  });

  it('keeps a response with its own session when a fork made after the last scan copies it', async () => {
    await write('p/origin.jsonl', [reply('shared', at(10), { sessionId: 'origin' })]);
    await both();
    await write('p/fork.jsonl', [reply('shared', at(10), { sessionId: 'origin', forkedFrom: { sessionId: 'origin' } }), reply('fork-own', at(11), { sessionId: 'fork' })]);
    const again = await both();
    expect(sorted(again.records).map(r => [r.responseId, r.sessionId])).toEqual([['fork-own', 'fork'], ['shared', 'origin']]);
    await both({ sessionIds: ['fork'] });
  });

  it('never charges today a copy of a response first written before the horizon', async () => {
    const before = new Date(NOW - 3 * 86_400_000).toISOString();
    await write('z/original.jsonl', [reply('hist', before, { sessionId: 'original' })]);
    // Copied before the index exists: the rebuild must see the old line too.
    await write('a/fork.jsonl', [reply('hist', at(10), { sessionId: 'fork' }), reply('fork-own', at(10, 5), { sessionId: 'fork' })]);
    expect((await both()).records.map(r => r.responseId)).toEqual(['fork-own']);
    // Copied after: the index answers from the old line's hash alone.
    await write('a/later.jsonl', [reply('hist', at(11), { sessionId: 'later' })]);
    const again = await both();
    expect(again.scan.mode).toBe('incremental');
    expect(again.records.map(r => r.responseId)).toEqual(['fork-own']);
    await both({ sessionIds: ['later'] });
  });

  it('remembers a response the horizon moved past, so a later copy of it stays history', async () => {
    await write('p/main.jsonl', [reply('aging', at(10))]);
    await both();
    const later = NOW + INDEX_HORIZON_MS + 86_400_000;
    const window = { now: later, since: new Date(later - 3 * 3_600_000).toISOString(), until: new Date(later).toISOString() };
    await both(window);
    await write('p/copy.jsonl', [reply('aging', new Date(later - 3_600_000).toISOString())]);
    const again = await both(window);
    expect(again.scan.mode).toBe('incremental');
    expect(again.records).toEqual([]);
  });

  it('cleans up after a save that fails', async () => {
    await write('p/main.jsonl', [reply('m1', at(10))]);
    await mkdir(indexPath, { recursive: true });
    expect((await both()).records).toHaveLength(1);
    expect(await readdir(path.dirname(indexPath))).toEqual([path.basename(indexPath)]);
  });

  it('rebuilds for a window up to a week back in one read, and takes the full scan past that', async () => {
    await write('p/main.jsonl', [reply('early', at(1)), reply('late', at(10))]);
    const past = await both({ since: '2026-10-11T00:00:00.000Z' });
    expect(past.scan.mode).toBe('rebuilt');
    expect(past.records).toHaveLength(2);
    expect((await both({ since: '2026-10-01T00:00:00.000Z' })).scan.mode).toBe('full');
    const later = NOW + INDEX_HORIZON_MS + 86_400_000;
    const gap = await both({ now: later, since: new Date(later - 3 * 3_600_000).toISOString(), until: new Date(later).toISOString() });
    // The index still holds every response from its own horizon on, so a gap needs no rebuild.
    expect(gap.scan.mode).toBe('incremental');
  });

  it('starts over from a missing, unreadable or foreign index', async () => {
    await write('p/main.jsonl', [reply('m1', at(10))]);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, 'not json\n');
    expect((await both()).scan.mode).toBe('rebuilt');
    await writeFile(indexPath, JSON.stringify({ v: 1, root: '/elsewhere', horizon: 0 }) + '\n');
    expect((await both()).scan.mode).toBe('rebuilt');
    expect((await both()).scan.mode).toBe('incremental');
  });
});
