import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bucketRows, foldCodexRollout, parseCodexRollout, parseOpenCodeExport, resetSessionCostCachesForTests, scanSessionCost } from '../../src/providers/session-cost-core.js';

let root: string;
const SID = '11111111-2222-4333-8444-555555555555';
const T = [100_000, 200_000, 272_000];

function usage(over: Record<string, unknown> = {}) {
  return { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    speed: 'standard', inference_geo: '', service_tier: 'standard', ...over };
}

function assistant(id: string, at: string, over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  return { type: 'assistant', sessionId: SID, timestamp: at, ...row,
    message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: usage(), ...over } };
}

async function lines(file: string, rows: unknown[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(async () => { resetSessionCostCachesForTests(); root = await mkdtemp(path.join(os.tmpdir(), 'session-cost-core-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('claude transcript', () => {
  it('counts each response once, includes subagents, and drops forked history', async () => {
    const projects = path.join(root, 'projects');
    const main = path.join(projects, '-work-acme', `${SID}.jsonl`);
    await lines(main, [
      { type: 'user', sessionId: SID, message: { role: 'user', content: 'hi' } },
      // Streaming snapshot then the final copy of the same message.
      assistant('m1', '2026-10-18T10:00:00.000Z', { stop_reason: null, usage: usage({ output_tokens: 5 }) }),
      assistant('m1', '2026-10-18T10:00:01.000Z'),
      // History a fork inherited from its parent belongs to the parent.
      assistant('p1', '2026-10-17T10:00:00.000Z', {}, { forkedFrom: { sessionId: 'parent', messageUuid: 'x' } }),
      assistant('m2', '2026-10-18T12:00:00.000Z', { usage: usage({ cache_read_input_tokens: 150_000 }) }),
    ]);
    await lines(path.join(projects, '-work-acme', SID, 'subagents', 'agent-a.jsonl'), [
      assistant('s1', '2026-10-18T11:00:00.000Z', { model: 'claude-haiku-5-5' }),
    ]);
    const scan = await scanSessionCost({ engine: 'claude', sessionId: SID, cwd: '/work/acme', thresholds: T, projectsDir: projects });
    expect(scan).toMatchObject({ source: 'claude-transcript', found: true, files: 2,
      firstAt: '2026-10-18T10:00:00.000Z', lastAt: '2026-10-18T12:00:00.000Z' });
    const opus = scan.buckets.filter(b => b.model === 'claude-opus-5-5');
    expect(opus.map(b => [b.band, b.responses, b.output, b.cacheWrite5m, b.cacheWrite1h]).sort()).toEqual([[0, 1, 20, 100, 200], [1, 1, 20, 100, 200]]);
    expect(scan.buckets.find(b => b.model === 'claude-haiku-5-5')).toMatchObject({ responses: 1, input: 10 });
  });

  it('serves an unchanged transcript from its cache and rescans when it grows', async () => {
    const projects = path.join(root, 'projects');
    const main = path.join(projects, 'p', `${SID}.jsonl`);
    await lines(main, [assistant('a', '2026-10-18T10:00:00.000Z')]);
    const req = { engine: 'claude', sessionId: SID, thresholds: T, projectsDir: projects };
    expect((await scanSessionCost(req)).buckets[0]!.responses).toBe(1);
    await appendFile(main, JSON.stringify(assistant('b', '2026-10-18T10:01:00.000Z')) + '\n');
    expect((await scanSessionCost(req)).buckets[0]!.responses).toBe(2);
  });

  it('reads only what the transcript gained, and lands on the same totals as a fresh read', async () => {
    const projects = path.join(root, 'projects')
    const main = path.join(projects, 'p', `${SID}.jsonl`)
    await lines(main, [assistant('a', '2026-10-18T10:00:00.000Z'),
      assistant('b', '2026-10-18T10:01:00.000Z', { stop_reason: null, usage: usage({ output_tokens: 3 }) })])
    // A last line still being written (no newline yet) counts once, not twice.
    await appendFile(main, JSON.stringify(assistant('c', '2026-10-18T10:02:00.000Z')))
    const req = { engine: 'claude', sessionId: SID, thresholds: T, projectsDir: projects }
    expect((await scanSessionCost(req)).buckets[0]).toMatchObject({ responses: 3, output: 43 })
    await appendFile(main, '\n' + JSON.stringify(assistant('b', '2026-10-18T10:01:05.000Z')) + '\n')
    const grown = await scanSessionCost(req)
    expect(grown.buckets[0]).toMatchObject({ responses: 3, output: 60 })
    resetSessionCostCachesForTests()
    const fresh = await scanSessionCost(req)
    expect(fresh.buckets.map(b => [b.responses, b.output, b.cacheRead])).toEqual(grown.buckets.map(b => [b.responses, b.output, b.cacheRead]))
    // A rewritten (shorter) transcript is read from the start again.
    await lines(main, [assistant('z', '2026-10-19T10:00:00.000Z')])
    expect((await scanSessionCost(req)).buckets[0]).toMatchObject({ responses: 1 })
  })

  it('reads a transcript rewritten in place from the start, even when it grew past the old offset', async () => {
    const projects = path.join(root, 'projects')
    const main = path.join(projects, 'p', `${SID}.jsonl`)
    await lines(main, [assistant('a', '2026-10-18T10:00:00.000Z')])
    const req = { engine: 'claude', sessionId: SID, thresholds: T, projectsDir: projects }
    expect((await scanSessionCost(req)).buckets[0]!.responses).toBe(1)
    // Same inode, new first bytes, longer than before.
    await writeFile(main, [assistant('x', '2026-10-19T10:00:00.000Z'), assistant('y', '2026-10-19T10:01:00.000Z')].map(r => JSON.stringify(r)).join('\n') + '\n')
    const again = await scanSessionCost(req)
    expect(again.buckets[0]!.responses).toBe(2)
    expect(again.firstAt).toBe('2026-10-19T10:00:00.000Z')
  })

  it('refuses a session id that is not a plain file name', async () => {
    await expect(scanSessionCost({ engine: 'claude', sessionId: '../x', thresholds: T, projectsDir: root })).rejects.toThrow(/filename/)
  })

  it('answers pending while a long first read goes on, then the finished totals', async () => {
    const projects = path.join(root, 'projects')
    const main = path.join(projects, 'p', `${SID}.jsonl`)
    await lines(main, Array.from({ length: 2_000 }, (_, i) => assistant(`m${i}`, '2026-10-18T10:00:00.000Z')))
    const req = { engine: 'claude', sessionId: SID, thresholds: T, projectsDir: projects, softDeadlineMs: 0 }
    const first = await scanSessionCost(req)
    expect(first.pending).toMatchObject({ totalBytes: expect.any(Number) })
    expect(first.buckets).toEqual([])
    let settled = first
    for (let i = 0; i < 50 && settled.pending; i++) {
      await new Promise(r => setTimeout(r, 50))
      settled = await scanSessionCost({ ...req, softDeadlineMs: 5_000 })
    }
    expect(settled.pending).toBeUndefined()
    expect(settled.buckets[0]!.responses).toBe(2_000)
  })

  it('says so when the transcript is not on this host', async () => {
    await mkdir(path.join(root, 'projects'), { recursive: true });
    const scan = await scanSessionCost({ engine: 'claude', sessionId: SID, thresholds: T, projectsDir: path.join(root, 'projects') });
    expect(scan).toMatchObject({ found: false, buckets: [], reason: expect.stringMatching(/No transcript/) });
  });
});

describe('codex rollout', () => {
  const CID = '01a1326c-f449-75a3-a614-a0a0bbcde579';
  function count(total: number, last: Record<string, number>, at: string) {
    return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: total }, last_token_usage: last } } };
  }

  it('counts one call per token_count change, splits cached and written input, follows model switches', async () => {
    const day = new Date(parseInt(CID.replace(/-/g, '').slice(0, 12), 16));
    const dir = path.join(root, 'codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    await lines(path.join(dir, `rollout-2026-10-12T16-22-44-${CID}.jsonl`), [
      { timestamp: '2026-10-12T23:22:44.000Z', type: 'turn_context', payload: { model: 'openai.gpt-6.1-sol' } },
      count(1_000, { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 800, output_tokens: 100, total_tokens: 1_000 }, '2026-10-12T23:22:45.000Z'),
      // A rate-limit refresh repeats the same call.
      count(1_000, { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 800, output_tokens: 100, total_tokens: 1_000 }, '2026-10-12T23:22:46.000Z'),
      { timestamp: '2026-10-12T23:23:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
      { timestamp: '2026-10-12T23:24:00.000Z', type: 'turn_context', payload: { model: 'openai.gpt-6-luna' } },
      count(301_000, { input_tokens: 299_000, cached_input_tokens: 290_000, cache_write_input_tokens: 0, output_tokens: 1_000, total_tokens: 300_000 }, '2026-10-12T23:24:30.000Z'),
    ]);
    const scan = await scanSessionCost({ engine: 'codex', sessionId: CID, thresholds: T, projectsDir: root, codexHome: path.join(root, 'codex') });
    expect(scan).toMatchObject({ source: 'codex-rollout', found: true });
    const sol = scan.buckets.find(b => b.model === 'gpt-6-1-sol')!;
    expect(sol).toMatchObject({ responses: 1, input: 100, cacheRead: 0, cacheWrite: 800, output: 100, band: 0 });
    const luna = scan.buckets.find(b => b.model === 'gpt-6-luna')!;
    expect(luna).toMatchObject({ responses: 1, input: 9_000, cacheRead: 290_000, output: 1_000, band: 3 });
  });

  it('reads only what a growing rollout gained, a half-written line included, and starts over on a new file', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const ctx = { timestamp: '2026-10-12T23:22:44.000Z', type: 'turn_context', payload: { model: 'openai.gpt-6.1-sol', note: '\u00e9\u4e2d' } };
    const call = (n: number) => count(n * 1_000, { input_tokens: 900, cached_input_tokens: 100, output_tokens: 100 }, '2026-10-12T23:22:45.000Z');
    await lines(file, [ctx, call(1), call(2)]);
    const first = await foldCodexRollout(file);
    expect(first.rows).toHaveLength(2);
    // A line Codex is still writing waits for its newline; a repeat of the last total is still a repeat.
    const whole = JSON.stringify(call(3));
    await appendFile(file, JSON.stringify(call(2)) + '\n' + whole.slice(0, 40));
    const second = await foldCodexRollout(file, first);
    expect(second.rows).toHaveLength(2);
    expect(second.offset).toBeGreaterThan(first.offset);
    await appendFile(file, whole.slice(40) + '\n');
    const third = await foldCodexRollout(file, second);
    expect(third.rows).toHaveLength(3);
    expect(third.rows.map(r => r.model)).toEqual(['gpt-6-1-sol', 'gpt-6-1-sol', 'gpt-6-1-sol']);
    expect(first.rows).toHaveLength(2);
    // The same rows as a full read.
    expect(third.rows).toEqual(await parseCodexRollout(file));
    // A replaced file (another inode) is read from the start.
    await rm(file);
    await lines(file, [ctx, call(9)]);
    expect((await foldCodexRollout(file, third)).rows).toHaveLength(1);
  });

  it('splits on newline bytes, so a chunk ending inside a character loses nothing', async () => {
    const file = path.join(root, 'wide.jsonl');
    // Lines past the 4 MB read chunk, full of three-byte characters.
    const pad = '\u4e2d'.repeat(400_000);
    const rows: unknown[] = [{ timestamp: 't', type: 'turn_context', payload: { model: 'openai.gpt-6.1-sol', pad } }];
    for (let i = 1; i <= 6; i++) rows.push({ ...count(i * 1_000, { input_tokens: 900, output_tokens: 100 }, 't'), pad });
    await lines(file, rows);
    expect((await foldCodexRollout(file)).rows).toHaveLength(6);
  });

  it('reports a missing rollout instead of an empty bill', async () => {
    const scan = await scanSessionCost({ engine: 'codex', sessionId: CID, thresholds: T, projectsDir: root, codexHome: path.join(root, 'none') });
    expect(scan).toMatchObject({ found: false, reason: expect.stringMatching(/No Codex session file/) });
  });
});

describe('opencode export and engines without usage', () => {
  it('reads per-message tokens, reasoning billed as output, and keeps OpenCode\'s own total', () => {
    const text = 'log line\n' + JSON.stringify({ messages: [
      { info: { role: 'user' } },
      { info: { role: 'assistant', modelID: 'us.anthropic.claude-sonnet-4-6', cost: 0.03887505, time: { created: 1788240113093 },
        tokens: { input: 3, output: 460, reasoning: 0, cache: { write: 1591, read: 86666 } } } },
      { info: { role: 'assistant', modelID: 'gpt-6.1-sol', cost: 0.01, time: { created: 1788240114093 },
        tokens: { input: 10, output: 5, reasoning: 7, cache: { write: 4, read: 0 } } } },
    ] });
    const { rows, costUsd } = parseOpenCodeExport(text);
    expect(costUsd).toBeCloseTo(0.04887505, 10);
    expect(rows[0]).toMatchObject({ model: 'claude-sonnet-4-6', input: 3, output: 460, cacheRead: 86666, cacheWrite5m: 1591, cacheWrite: 0 });
    expect(rows[1]).toMatchObject({ model: 'gpt-6-1-sol', output: 12, cacheWrite: 4, cacheWrite5m: 0 });
  });

  it('names why Goose has no per-request usage', async () => {
    const scan = await scanSessionCost({ engine: 'goose', sessionId: 'x', thresholds: T, projectsDir: root });
    expect(scan).toMatchObject({ source: 'none', found: false, reason: expect.stringMatching(/session totals/) });
  });

  it('buckets by every field a price depends on', () => {
    const at = '2026-10-18T00:00:00.000Z';
    const base = { model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, at };
    const buckets = bucketRows([base, base, { ...base, speed: 'fast' }, { ...base, geo: 'us' }, { ...base, input: 150_000 }], T);
    expect(buckets.map(b => [b.speed, b.geo, b.band, b.responses])).toEqual([
      ['standard', 'global', 0, 2], ['fast', 'global', 0, 1], ['standard', 'us', 0, 1], ['standard', 'global', 1, 1],
    ]);
  });
});
