import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeSessionMetas, outsideSessionIds } from '../../src/providers/claude-outside-core.js';
import { createUsagePages, scanHostUsage } from '../../src/providers/usage-host-core.js';

const WHEN = '2026-10-13T12:00:00.000Z';
const TOKENS = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, speed: 'standard',
  inference_geo: '', service_tier: 'standard', server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, iterations: [] };

let root: string, index: string;

/** A transcript: a user line naming how the session started, then one finished response per id. */
async function transcript(relative: string, entrypoint: string | undefined, ids: string[], cwd = '/work/marina') {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const rows: unknown[] = [{ type: 'user', timestamp: WHEN, cwd, ...(entrypoint ? { entrypoint } : {}), message: { role: 'user', content: 'hello' } }];
  for (const id of ids) rows.push({ type: 'assistant', timestamp: WHEN, message: { id, model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: TOKENS } });
  await writeFile(target, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'claude-outside-'));
  root = path.join(base, 'projects'); index = path.join(base, 'index');
  await mkdir(root, { recursive: true });
});
afterEach(async () => { await rm(path.dirname(root), { recursive: true, force: true }); });

describe('claudeSessionMetas', () => {
  it('names how each top-level transcript began and where, and leaves subagent transcripts to their parent', async () => {
    await transcript('p1/walnut-run.jsonl', 'sdk-cli', ['a']);
    await transcript('p1/terminal.jsonl', 'cli', ['b'], '/home/u/repo');
    await transcript('p2/helper.jsonl', 'walnut-utility', ['c']);
    await transcript('p1/terminal/subagents/agent-1.jsonl', 'cli', ['d']);
    const metas = await claudeSessionMetas(root, index);
    expect([...metas.keys()].sort()).toEqual(['helper', 'terminal', 'walnut-run']);
    expect(metas.get('terminal')).toEqual({ sessionId: 'terminal', entrypoint: 'cli', cwd: '/home/u/repo' });
    // Walnut's own helper calls are never read as outside work; a session that has not named itself yet waits.
    await transcript('p1/fresh.jsonl', undefined, []);
    const again = await claudeSessionMetas(root, index);
    expect(again.get('fresh')!.entrypoint).toBe('');
    expect(outsideSessionIds(again).sort()).toEqual(['terminal', 'walnut-run']);
  });

  it('reads a transcript once: the answer is kept in the index folder, and a vanished file leaves it', async () => {
    await transcript('p1/one.jsonl', 'cli', ['a']);
    await claudeSessionMetas(root, index);
    const cache = path.join(index, 'claude-session-meta.json');
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual({ 'p1/one.jsonl': ['cli', '/work/marina'] });
    // Rewritten with another entrypoint, the cached answer stays (a transcript's first lines never change).
    await transcript('p1/one.jsonl', 'sdk-cli', ['a']);
    expect((await claudeSessionMetas(root, index)).get('one')!.entrypoint).toBe('cli');
    await rm(path.join(root, 'p1/one.jsonl'));
    await claudeSessionMetas(root, index);
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual({});
  });

  it('finds the entrypoint behind a long first line', async () => {
    const target = path.join(root, 'p1/long.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    const big = JSON.stringify({ type: 'attachment', blob: 'x'.repeat(200_000) });
    await writeFile(target, big + '\n' + JSON.stringify({ type: 'user', cwd: '/work/marina', entrypoint: 'cli' }) + '\n');
    expect((await claudeSessionMetas(root, index)).get('long')).toMatchObject({ entrypoint: 'cli', cwd: '/work/marina' });
  });

  it('finds the entrypoint inside one huge first line, after an inline image', async () => {
    const target = path.join(root, 'p1/image.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    const first = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', data: 'A'.repeat(4_500_000) }] }, cwd: '/work/marina', entrypoint: 'sdk-cli' }); // a 3 MiB picture, past the old 4 MB limit
    await writeFile(target, first + '\n');
    expect((await claudeSessionMetas(root, index)).get('image')).toMatchObject({ entrypoint: 'sdk-cli', cwd: '/work/marina' });
  });

  it('finds the cwd even when the entrypoint ends exactly at a read boundary', async () => {
    const target = path.join(root, 'p1/edge.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    const head = '{"entrypoint":"cli","pad":"';
    const tail = '","cwd":"/home/u/.local/state/open-walnut/tasks/example-task/repo"}\n';
    // The closing quote of the entrypoint value is the last byte of the first 64 KB chunk.
    await writeFile(target, head.replace('"pad":"', '') .slice(0, -1) + ' '.repeat(65_536 - head.replace('"pad":"', '').length) + tail);
    const meta = (await claudeSessionMetas(root, index)).get('edge')!;
    expect(meta.entrypoint).toBe('cli');
    expect(meta.cwd).toBe('/home/u/.local/state/open-walnut/tasks/example-task/repo');
  });

  it('a transcript read up to the limit with no entrypoint is remembered, and read again only when it has grown', async () => {
    const target = path.join(root, 'p1/huge.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ type: 'attachment', blob: 'x'.repeat(34_000_000) }) + '\n');
    expect((await claudeSessionMetas(root, index)).get('huge')!.entrypoint).toBe('unknown');
    const cache = JSON.parse(await readFile(path.join(index, 'claude-session-meta.json'), 'utf8'));
    expect(cache['p1/huge.jsonl'][2]).toBeGreaterThan(32_000_000);
  });

  it('an old transcript with no entrypoint is remembered too, while a fresh one is read again next time', async () => {
    const oldFile = path.join(root, 'p1/old.jsonl');
    const fresh = path.join(root, 'p1/fresh.jsonl');
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, JSON.stringify({ type: 'user', cwd: '/work/marina' }) + '\n');
    await writeFile(fresh, JSON.stringify({ type: 'user', cwd: '/work/marina' }) + '\n');
    const past = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await utimes(oldFile, past, past);
    await claudeSessionMetas(root, index);
    const cache = JSON.parse(await readFile(path.join(index, 'claude-session-meta.json'), 'utf8'));
    expect(cache['p1/old.jsonl']).toEqual(['', '/work/marina', expect.any(Number)]);
    expect(cache['p1/fresh.jsonl']).toBeUndefined();
    const metas = await claudeSessionMetas(root, index);
    expect(outsideSessionIds(metas)).toContain('old'); // an older CLI named no entrypoint: its usage still counts
    expect(outsideSessionIds(metas)).not.toContain('fresh'); // a session just begun waits for its entrypoint
  });

  it('counts a transcript whose head cannot be read, and the scan reports it as an unreadable file', async () => {
    await transcript('p1/ok.jsonl', 'cli', ['a']);
    await mkdir(path.join(root, 'p1/broken.jsonl'), { recursive: true }); // opens, cannot be read
    const metas = await claudeSessionMetas(root, index);
    expect(metas.unreadable).toBe(1);
    const until = '2026-10-13T13:00:00.000Z';
    const plain = await scanHostUsage({ projectsDir: root, until, sessionIds: [] });
    const result = await scanHostUsage({ projectsDir: root, until, sessionIds: [], outside: true, indexDir: index });
    expect(result.canonical.diagnostics.unreadable_files).toBeGreaterThanOrEqual(plain.canonical.diagnostics.unreadable_files + 1);
  });

  it('an unreadable projects folder is empty', async () => {
    expect((await claudeSessionMetas(path.join(root, 'missing'), index)).size).toBe(0);
  });
});

describe('scanHostUsage with outside', () => {
  const until = '2026-10-14T00:00:00.000Z';

  it('adds the sessions Walnut has no record of, keeps helper calls out, and says how each began', async () => {
    await transcript('p1/known.jsonl', 'sdk-cli', ['m1']);
    await transcript('p1/terminal.jsonl', 'cli', ['m2']);
    await transcript('p1/unknown-sdk.jsonl', 'sdk-cli', ['m3']);
    await transcript('p2/helper.jsonl', 'walnut-utility', ['m4']);
    const plain = await scanHostUsage({ projectsDir: root, until, sessionIds: ['known', 'terminal'] });
    expect(plain.canonical.records.map(r => r.sessionId).sort()).toEqual(['known', 'terminal']);
    const result = await scanHostUsage({ projectsDir: root, until, sessionIds: ['known', 'terminal'], outside: true, indexDir: index });
    expect(result.canonical.records.map(r => r.sessionId).sort()).toEqual(['known', 'terminal', 'unknown-sdk']);
    const page = createUsagePages().put(result);
    // A known Walnut session started by claude -p is not listed; a known terminal one and an unknown one are.
    expect((page.result as { outsideSessions?: { sessionId: string; entrypoint: string }[] }).outsideSessions!.map(s => [s.sessionId, s.entrypoint]).sort())
      .toEqual([['terminal', 'cli'], ['unknown-sdk', 'sdk-cli']]);
  });

  it('counts a response copied into a Walnut session and a terminal one once, under its earliest owner', async () => {
    await transcript('p1/known.jsonl', 'sdk-cli', ['shared']);
    await transcript('p1/terminal.jsonl', 'cli', ['shared', 'own']);
    const result = await scanHostUsage({ projectsDir: root, until, sessionIds: ['known'], outside: true, indexDir: index });
    expect(result.canonical.records.map(r => r.responseId).sort()).toEqual(['own', 'shared']);
  });

  it('carries each session on every page that holds one of its records', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `r${i}`);
    await transcript('p1/big.jsonl', 'cli', ids);
    await transcript('p1/other.jsonl', 'cli', ['z']);
    const pages = createUsagePages();
    const first = pages.put(await scanHostUsage({ projectsDir: root, until, sessionIds: ['known'], outside: true, indexDir: index }));
    const seen = (r: { outsideSessions?: { sessionId: string }[] }) => (r.outsideSessions ?? []).map(s => s.sessionId);
    expect(first.done).toBe(false);
    const second = pages.page(first.key, first.offset);
    const all = [...seen(first.result as never), ...seen(second.result as never)];
    expect(all.filter(id => id === 'big').length).toBe(2); // its 600 records span both pages
    expect(all).toContain('other');
  });

  it('reads every session when no list is given, outside or not', async () => {
    await transcript('p1/a.jsonl', 'cli', ['m1']);
    await transcript('p1/b.jsonl', 'sdk-cli', ['m2']);
    const result = await scanHostUsage({ projectsDir: root, until, outside: true, indexDir: index });
    expect(result.canonical.records.map(r => r.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('proxy evidence of outside sessions', () => {
  it('is kept for the sessions the outside scan adds, not only the ones asked for', async () => {
    await transcript('p1/known.jsonl', 'sdk-cli', ['a']);
    await transcript('p1/terminal.jsonl', 'cli', ['b']);
    const proxyDir = path.join(path.dirname(root), 'proxy');
    await mkdir(proxyDir, { recursive: true });
    const started = Date.parse(WHEN);
    const line = (sessionId: string, id: string) => '2026-10-13 12:00:01 INFO request CACHE ' + JSON.stringify({ account: 'route-a', request_id: id, session_id: sessionId,
      started_ms: started, requested_model: 'claude-opus-4-8', forwarded_model: 'claude-opus-4-8', response_model: 'claude-opus-4-8', duration_ms: 1_000,
      total_ms: 1_000, outcome: 'complete', success: true, usage_present: true, input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 });
    await writeFile(path.join(proxyDir, 'proxy.log'), [line('known', 'r1'), line('terminal', 'r2')].join('\n') + '\n');
    const until = '2026-10-13T13:00:00.000Z';
    const plain = await scanHostUsage({ projectsDir: root, until, sessionIds: ['known'], proxyLogDir: proxyDir });
    const withOutside = await scanHostUsage({ projectsDir: root, until, sessionIds: ['known'], outside: true, indexDir: index, proxyLogDir: proxyDir });
    expect(plain.upstream.records.map(r => r.sessionId).sort()).toEqual(['known']);
    expect(withOutside.upstream.records.map(r => r.sessionId).sort()).toEqual(['known', 'terminal']);
  });
});

describe('a scan that outlives its requester', () => {
  it('is taken up by the same request asked again, and is scanned again once its pages are gone or it failed', async () => {
    await transcript('p1/terminal.jsonl', 'cli', Array.from({ length: 600 }, (_, i) => `m${i}`));
    const pages = createUsagePages();
    const request = { projectsDir: root, until: '2026-10-13T13:00:00.000Z', sessionIds: [] as string[], outside: true, indexDir: index };
    let runs = 0;
    const run = (until: string) => () => { runs++; return scanHostUsage({ ...request, until }); };
    // The first requester's link drops: it never reads the answer, and its scan goes on.
    const first = pages.scan(request, run(request.until));
    first.catch(() => {});
    // The next collection, a little later, asks the same thing.
    const again = await pages.scan({ ...request, until: '2026-10-13T13:30:00.000Z' }, run('2026-10-13T13:30:00.000Z'));
    expect(runs).toBe(1);
    expect(again.result.reconciliation.responseCount).toBe(600);
    expect(again.done).toBe(false);
    // Its pages were read to the end, so asking again scans anew.
    expect(pages.page(again.key, again.offset).done).toBe(true);
    await pages.scan(request, run(request.until));
    expect(runs).toBe(2);
    // A failed scan is not remembered.
    const failing = createUsagePages();
    await expect(failing.scan(request, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await failing.scan(request, run(request.until))).result.reconciliation.responseCount).toBe(600);
  });
});

