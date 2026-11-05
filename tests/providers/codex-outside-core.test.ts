import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanCodexOutside } from '../../src/providers/codex-outside-core.js';

let home: string;
const LA = { timeZone: 'America/Los_Angeles' };

function meta(id: string, over: Record<string, unknown> = {}) {
  return { timestamp: '2026-11-04T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/work/marina', originator: 'codex_exec',
    model_provider: 'amazon-bedrock', base_instructions: { text: 'x'.repeat(30_000) }, ...over } };
}
function count(total: number, input: number, cached: number, output: number, at: string) {
  return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } };
}
const ctx = { timestamp: '2026-11-04T10:00:01.000Z', type: 'turn_context', payload: { model: 'openai.gpt-6.1-sol' } };

async function rollout(day: string, name: string, rows: unknown[], dir = 'sessions') {
  const [y, m, d] = day.split('-');
  const file = path.join(home, dir, ...(dir === 'sessions' ? [y, m, d] : []), `rollout-${day}T10-00-00-${name}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'codex-outside-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('codex outside scan', () => {
  it('counts every run per request with its account, folder and local days, flags the ones Walnut started, and keeps a known id as meta only', async () => {
    await rollout('2026-11-04', 'aaa', [meta('aaa'), ctx,
      count(1_000, 900, 600, 100, '2026-11-04T10:00:05.000Z'),
      count(1_000, 900, 600, 100, '2026-11-04T10:00:06.000Z'), // same call reported again: not a second request
      count(3_000, 1_900, 1_500, 100, '2026-11-05T02:00:00.000Z')]);
    // A run Walnut started with no session record of its own (a child thread Codex made): counted, flagged.
    await rollout('2026-11-04', 'bbb', [meta('bbb', { originator: 'open-walnut', model_provider: 'local-proxy' }), ctx, count(500, 400, 0, 100, '2026-11-04T11:00:00.000Z')]);
    await rollout('2026-11-03', 'ccc', [meta('ccc', { originator: 'codex-tui', model_provider: 'bp', cwd: '/home/u/open-walnut/tasks/abc12345-def6' }), ctx,
      count(700, 600, 0, 100, '2026-11-03T20:00:00.000Z')]);
    await rollout('2026-11-02', 'known', [meta('known', { originator: 'open-walnut' }), ctx, count(100, 90, 0, 10, '2026-11-02T10:00:00.000Z')]);
    const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA, knownSessionIds: ['known'] });
    expect(scan.next).toBeUndefined();
    expect(scan.byDay).toEqual(LA);
    const by = Object.fromEntries(scan.entries.map(e => [e.sessionId, e]));
    expect(Object.keys(by).sort()).toEqual(['aaa', 'bbb', 'ccc', 'known']);
    expect(by.aaa).toMatchObject({ originator: 'codex_exec', provider: 'amazon-bedrock', cwd: '/work/marina', counted: true, walnut: false });
    // Two requests: the repeated token_count is one call. 2026-11-04T10:00Z and 2026-11-05T02:00Z are 11-04 in Los Angeles.
    const buckets = by.aaa.buckets!;
    expect(buckets.reduce((n, b) => n + b.responses, 0)).toBe(2);
    expect(buckets.every(b => b.day === '2026-11-04')).toBe(true);
    expect(buckets.reduce((n, b) => n + b.cacheRead, 0)).toBe(2_100);
    expect(by.bbb).toMatchObject({ originator: 'open-walnut', provider: 'local-proxy', counted: true, walnut: true });
    expect(by.bbb.buckets!.reduce((n, b) => n + b.responses, 0)).toBe(1);
    expect(by.ccc).toMatchObject({ originator: 'codex-tui', provider: 'bp', counted: true, walnut: false, cwd: '/home/u/open-walnut/tasks/abc12345-def6' });
    expect(by.known).toMatchObject({ counted: false, walnut: true, provider: 'amazon-bedrock' });
    expect(by.known.buckets).toBeUndefined();
  });

  it('counts a forked thread from where it began, not the history it inherited, and reports a file it could not read', async () => {
    await rollout('2026-11-04', 'parent', [meta('parent'), ctx, count(1_000, 1_000, 0, 0, '2026-11-04T09:00:00.000Z')]);
    // The fork carries the parent's call (with the parent's own time) before its own.
    await rollout('2026-11-04', 'fork', [
      { ...meta('fork', { parent_thread_id: 'parent', timestamp: '2026-11-04T10:00:00.000Z', model_provider: 'bp' }), timestamp: '2026-11-04T10:00:00.000Z' }, ctx,
      count(1_000, 1_000, 0, 0, '2026-11-04T09:00:00.000Z'), count(3_000, 2_000, 0, 0, '2026-11-04T10:05:00.000Z')]);
    const bad = await rollout('2026-11-04', 'locked', [meta('locked'), ctx, count(100, 90, 0, 10, '2026-11-04T10:00:05.000Z')]);
    await chmod(bad, 0o000);
    const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA });
    await chmod(bad, 0o600);
    const by = Object.fromEntries(scan.entries.map(e => [e.sessionId, e]));
    const input = (id: string) => by[id].buckets!.reduce((n, b) => n + b.input, 0);
    expect(input('parent')).toBe(1_000);
    expect(input('fork')).toBe(2_000); // the parent's 1,000 is not counted again
    // Running as root, a mode of 0 does not stop a read: only the shape of the answer is pinned then.
    if (!by.locked) expect(scan.failed).toEqual([expect.stringContaining('locked')]);
  });

  it('names a folder it cannot list instead of calling the scan complete', async () => {
    await rollout('2026-10-01', 'old', [meta('old'), ctx, count(100, 90, 0, 10, '2026-10-01T10:00:05.000Z')]);
    await rollout('2026-11-04', 'new', [meta('new'), ctx, count(100, 90, 0, 10, '2026-11-04T10:00:05.000Z')]);
    const locked = path.join(home, 'sessions', '2026', '10', '01');
    await chmod(locked, 0o000);
    const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA });
    await chmod(locked, 0o700);
    // A missing folder is just empty; an unreadable one is named (unless this process may read it anyway).
    if (!scan.entries.some(e => e.sessionId === 'old')) expect(scan.failed).toEqual([`dir:${locked}`]);
    expect(scan.entries.some(e => e.sessionId === 'new')).toBe(true);
    const none = await scanCodexOutside({ codexHome: path.join(home, 'nothing'), thresholds: [], byDay: LA });
    expect(none.failed).toBeUndefined();
  });

  it('reads archived runs too', async () => {
    await rollout('2026-10-01', 'old1', [meta('old1'), ctx, count(100, 90, 0, 10, '2026-10-01T10:00:05.000Z')], 'archived_sessions');
    const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA });
    expect(scan.entries.map(e => [e.sessionId, e.counted])).toEqual([['old1', true]]);
  });

  it('pages newest first with a cursor and returns every run exactly once', async () => {
    for (let i = 1; i <= 7; i++) {
      await rollout(`2026-11-0${i}`, `run${i}`, [meta(`run${i}`), ctx, count(100, 90, 0, 10, `2026-11-0${i}T10:00:05.000Z`)]);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      // A budget of one millisecond stops each page right after its first file.
      const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA, budgetMs: 0.0001, ...(cursor ? { cursor } : {}) });
      seen.push(...scan.entries.map(e => e.sessionId));
      cursor = scan.next;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toEqual(['run7', 'run6', 'run5', 'run4', 'run3', 'run2', 'run1']);
    expect(pages).toBeGreaterThan(1);
  });

  it('skips files not changed since `since`, and files that are not rollouts or are unreadable', async () => {
    const oldFile = await rollout('2026-10-01', 'old', [meta('old'), ctx, count(100, 90, 0, 10, '2026-10-01T10:00:05.000Z')]);
    await utimes(oldFile, new Date('2026-10-01T12:00:00Z'), new Date('2026-10-01T12:00:00Z'));
    await rollout('2026-11-04', 'new', [meta('new'), ctx, count(100, 90, 0, 10, '2026-11-04T10:00:05.000Z')]);
    await rollout('2026-11-04', 'junk', ['not json at all']);
    await mkdir(path.join(home, 'sessions', '2026', '11', '04'), { recursive: true });
    await writeFile(path.join(home, 'sessions', '2026', '11', '04', 'notes.txt'), 'hello');
    await symlink('/etc/passwd', path.join(home, 'sessions', '2026', '11', '04', 'rollout-2026-11-04T10-00-00-link.jsonl'));
    const scan = await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA, since: '2026-11-01T00:00:00Z' });
    expect(scan.entries.map(e => e.sessionId)).toEqual(['new']);
  });

  it('answers an empty page for a host with no Codex home', async () => {
    const scan = await scanCodexOutside({ codexHome: path.join(home, 'nothing'), thresholds: [], byDay: LA });
    expect(scan).toMatchObject({ entries: [], files: 0 });
  });

  it('never writes: the rollout files are unchanged after a scan', async () => {
    const file = await rollout('2026-11-04', 'ro', [meta('ro'), ctx, count(100, 90, 0, 10, '2026-11-04T10:00:05.000Z')]);
    const { stat } = await import('node:fs/promises');
    const before = await stat(file);
    await scanCodexOutside({ codexHome: home, thresholds: [], byDay: LA });
    const after = await stat(file);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });
});
