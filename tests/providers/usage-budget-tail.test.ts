import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBudgetTail } from '../../src/providers/usage-budget-tail.js';
import { canonicalRecordFromAssistant } from '../../src/providers/usage-scan-core.js';

const TIME = '2026-10-13T12:00:00.000Z';
const TOKENS = { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 30,
  speed: 'standard', inference_geo: '', service_tier: 'standard' };
function assistant(id: string, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', sessionId: 'main', timestamp: TIME, message: {
    id, model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: TOKENS, ...extra,
  } };
}
let root: string;
let main: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'usage-budget-tail-'));
  await mkdir(path.join(root, 'project'));
  main = path.join(root, 'project', 'main.jsonl');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const rows = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';

describe('createBudgetTail', () => {
  it('reads only the named session and its subagents and discovers later agent files', async () => {
    const initial = assistant('main-final');
    await writeFile(main, rows([initial]));
    await writeFile(path.join(root, 'project', 'other.jsonl'), '{malformed unrelated history}\n');
    const agents = path.join(root, 'project', 'main', 'subagents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'agent-one.jsonl'), rows([assistant('agent-one-final')]));
    await mkdir(path.join(agents, 'nested'));
    await writeFile(path.join(agents, 'nested', 'ignored.jsonl'), '{malformed nested history}\n');
    const tail = createBudgetTail({ projectsDir: root });
    expect(await tail.scan('main')).toEqual({ records: [
      canonicalRecordFromAssistant(initial, { sessionId: 'main' }),
      canonicalRecordFromAssistant(assistant('agent-one-final'), { sessionId: 'main', agentId: 'agent-one' }),
    ], complete: true });
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
    await appendFile(main, rows([assistant('new-main-final')]));
    await writeFile(path.join(agents, 'agent-two.jsonl'), rows([assistant('agent-two-final')]));
    const next = await tail.scan('main');
    expect(next.records.map(row => row.responseId)).toEqual(['new-main-final', 'agent-two-final']);
    expect(next.records[1].agentId).toBe('agent-two');
    expect(next.complete).toBe(true);
  });

  it('rereads a partial UTF-8 line without advancing and recovers once it is complete', async () => {
    const tail = createBudgetTail({ projectsDir: root });
    const row = { ...assistant('split-final'), content: String.fromCodePoint(0x96ea) };
    const bytes = Buffer.from(JSON.stringify(row));
    const split = bytes.indexOf(Buffer.from(String.fromCodePoint(0x96ea))) + 1;
    await writeFile(main, Buffer.concat([Buffer.from(rows([assistant('first')])), bytes.subarray(0, split)]));
    const first = await tail.scan('main');
    expect(first.records.map(row => row.responseId)).toEqual(['first']);
    expect(first.complete).toBe(false);
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
    await appendFile(main, Buffer.concat([bytes.subarray(split), Buffer.from('\r\n')]));
    expect(await tail.scan('main')).toEqual({ records: [canonicalRecordFromAssistant(row, { sessionId: 'main' })], complete: true });
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
  });

  it('reads lines spanning several 64 KiB chunks and does not repeat them', async () => {
    const long = { ...assistant('long-final'), content: 'x'.repeat(200_000) };
    await writeFile(main, rows([long, assistant('after-long')]));
    const tail = createBudgetTail({ projectsDir: root });
    const first = await tail.scan('main');
    expect(first.records.map(row => row.responseId)).toEqual(['long-final', 'after-long']);
    expect(first.complete).toBe(true);
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
    await appendFile(main, rows([assistant('appended')]));
    expect((await tail.scan('main')).records.map(row => row.responseId)).toEqual(['appended']);
  });

  it('resets on truncation, rotation and a session moving to another project', async () => {
    await writeFile(main, rows([assistant('first'), assistant('second')]));
    const tail = createBudgetTail({ projectsDir: root });
    await tail.scan('main');
    await writeFile(main, rows([assistant('short')]));
    expect((await tail.scan('main')).records.map(row => row.responseId)).toEqual(['short']);
    await rename(main, path.join(root, 'project', 'rotated.log'));
    await writeFile(main, rows([assistant('replacement')]));
    expect((await tail.scan('main')).records.map(row => row.responseId)).toEqual(['replacement']);
    await mkdir(path.join(root, 'new-project'));
    await rename(main, path.join(root, 'new-project', 'main.jsonl'));
    expect((await tail.scan('main')).records.map(row => row.responseId)).toEqual(['replacement']);
  });

  it('treats an empty session and absent subagent directory as complete', async () => {
    await writeFile(main, '');
    const tail = createBudgetTail({ projectsDir: root });
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
  });

  it('ignores nonfinal, copied history and zero synthetic rows but holds invalid final usage', async () => {
    await writeFile(main, rows([
      assistant('streaming', { stop_reason: null }),
      assistant('synthetic', { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }),
      { type: 'user', message: { content: 'Unrelated input' } },
      { ...assistant('fork-copy'), forkedFrom: { sessionId: 'main', messageUuid: 'source' } },
      { ...assistant('foreign-source'), sessionId: 'other' },
    ]));
    const tail = createBudgetTail({ projectsDir: root });
    expect(await tail.scan('main')).toEqual({ records: [], complete: true });
    await appendFile(main, rows([
      assistant('no-final-usage', { usage: undefined }),
      assistant('partial-final', { usage: { input_tokens: 12, output_tokens: 8 } }),
    ]));
    const invalid = await tail.scan('main');
    expect(invalid.records).toEqual([expect.objectContaining({ responseId: 'partial-final', complete: false })]);
    expect(invalid.complete).toBe(false);
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
  });

  it('keeps malformed complete lines unsafe across polls and recovers after replacement', async () => {
    await writeFile(main, '{invalid json}\n' + rows([assistant('valid')]));
    const tail = createBudgetTail({ projectsDir: root });
    expect((await tail.scan('main')).complete).toBe(false);
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
    await rename(main, path.join(root, 'project', 'old.log'));
    await writeFile(main, rows([assistant('recovered')]));
    expect((await tail.scan('main')).complete).toBe(true);
  });

  it('retries missing sessions and never reads FIFO or linked session files', async () => {
    const tail = createBudgetTail({ projectsDir: root });
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
    await writeFile(main, rows([assistant('arrived')]));
    expect((await tail.scan('main')).records.map(row => row.responseId)).toEqual(['arrived']);
    await expect(tail.scan('../main')).rejects.toThrow('filename component');
    await expect(tail.scan('.')).rejects.toThrow('filename component');
    await rename(main, path.join(root, 'project', 'regular.log'));
    await symlink(path.join(root, 'project', 'regular.log'), main);
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
    await rm(main);
    execFileSync('mkfifo', [main]);
    expect(await tail.scan('main')).toEqual({ records: [], complete: false });
  });

  it('yields during dense CPU work without truncating complete records', async () => {
    await writeFile(main, rows(Array.from({ length: 300 }, (_, i) => assistant(`dense-${i}`))));
    let calls = 0;
    vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ user: calls++ * 5_001, system: 0 }));
    const result = await createBudgetTail({ projectsDir: root }).scan('main');
    expect(result.records).toHaveLength(300);
    expect(result.complete).toBe(true);
    expect(calls).toBeGreaterThan(300);
  });
});
