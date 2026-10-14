import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanCanonicalUsage, scanCostState, normalizeUsageModel } from '../../src/providers/usage-scan-core.js';

const EARLY = '2026-10-12T12:00:00.000Z';
const TODAY = '2026-10-13T12:00:00.000Z';
const LATER = '2026-10-13T12:00:01.000Z';
const TOKENS = { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 30,
  speed: 'standard', inference_geo: '', service_tier: 'standard',
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, iterations: [],
};

function assistant(id: string | undefined, timestamp: unknown = TODAY, usage: unknown = TOKENS, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', timestamp, message: {
    id, model: 'claude-opus-4-8', stop_reason: 'end_turn', usage, ...extra,
  } };
}

function cost(sessionId: string, totalCostUSD: number, extra: Record<string, unknown> = {}) {
  return { type: 'cost-state', sessionId, totalCostUSD, totalAPIDuration: 1,
    totalAPIDurationWithoutRetries: 1, totalToolDuration: 2, totalLinesAdded: 0,
    totalLinesRemoved: 0, totalDuration: 3, startTime: 1, modelUsage: {
      'claude-opus-4-8': { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 30,
        cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: totalCostUSD },
    }, ...extra };
}

let root: string;
async function log(relative: string, rows: unknown[], rawTail = '') {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + rawTail);
  return target;
}

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'canonical-usage-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('scanCanonicalUsage', () => {
  it('folds streamed snapshots into final counters and maximum cumulative output', async () => {
    await log('project/main.jsonl', [
      assistant('msg-1', TODAY, { ...TOKENS, input_tokens: 900, output_tokens: 1,
        cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } }, { stop_reason: null }),
      assistant('msg-1', LATER, { ...TOKENS, input_tokens: 18, output_tokens: 40,
        cache_creation_input_tokens: 70, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 50 } }),
      assistant('msg-1', LATER, { ...TOKENS, output_tokens: 35,
        cache_creation_input_tokens: 70, cache_creation: { ephemeral_5m_input_tokens: 20 } }),
      assistant('msg-1', LATER, { ...TOKENS, input_tokens: 999, output_tokens: 1 }, { stop_reason: null }),
    ]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([{
      responseId: 'msg-1', model: 'claude-opus-4-8', sessionId: 'main', timestamp: TODAY,
      input_tokens: 12, output_tokens: 40, cache_creation_input_tokens: 70, cache_read_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 50 },
      speed: 'standard', inference_geo: '', service_tier: 'standard',
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, pricing_context_complete: true, complete: false,
    }]);
    expect(result.diagnostics).toMatchObject({ files_scanned: 1, duplicate_usage_lines: 3, changed_usage_duplicates: 2, incomplete_records: 1 });
  });

  it('does not let a later initial estimate overwrite a final snapshot', async () => {
    await log('project/main.jsonl', [assistant('msg-1'), assistant('msg-1', LATER, {
      ...TOKENS, input_tokens: 900, output_tokens: 1,
    }, { stop_reason: null })]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ input_tokens: 12, output_tokens: 8, complete: true })]);
  });

  it('deduplicates normalized response identities across projects, forks and subagents', async () => {
    await log('a-project/fork.jsonl', [assistant('shared', LATER, { ...TOKENS, input_tokens: 999, output_tokens: 11 }, { model: 'opus-4.8' })]);
    await log('z-project/original.jsonl', [assistant('shared', TODAY)]);
    await log('z-project/original/subagents/agent-alpha.jsonl', [assistant('shared', TODAY), assistant('agent-only')]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toHaveLength(2);
    expect(result.records.find(row => row.responseId === 'shared')).toMatchObject({
      sessionId: 'original', input_tokens: 12, output_tokens: 11, complete: false,
    });
    expect(result.records.find(row => row.responseId === 'shared')).not.toHaveProperty('agentId');
    expect(result.records.find(row => row.responseId === 'agent-only')).toMatchObject({ sessionId: 'original', agentId: 'agent-alpha', complete: true });
    expect(result.diagnostics.duplicate_usage_lines).toBe(2);
  });

  it('uses main over subagent and stable lexical path when owner timestamps tie', async () => {
    await log('b-project/z-last.jsonl', [assistant('same-time')]);
    await log('a-project/a-first.jsonl', [assistant('same-time')]);
    await log('0-project/parent/subagents/agent-first.jsonl', [assistant('same-time')]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ sessionId: 'a-first', complete: false })]);
  });

  it('uses the official forkedFrom source instead of the copied row new session ID', async () => {
    const original = { ...assistant('same-id'), sessionId: 'z-original', uuid: 'source-message' };
    await log('project/a-fork.jsonl', [{ ...original, sessionId: 'a-fork',
      forkedFrom: { sessionId: 'z-original', messageUuid: 'source-message' } }]);
    await log('project/z-original.jsonl', [original]);
    const result = await scanCanonicalUsage({ projectsDir: root, sessionIds: ['z-original'] });
    expect(result.records).toEqual([expect.objectContaining({ sessionId: 'z-original', complete: true })]);
    expect((await scanCanonicalUsage({ projectsDir: root, sessionIds: ['a-fork'] })).records).toEqual([]);
  });

  it('keeps a copied response for its explicit source when the original log is absent', async () => {
    await log('project/a-fork.jsonl', [{ ...assistant('copied-only'), sessionId: 'a-fork',
      forkedFrom: { sessionId: 'z-original', messageUuid: 'source-message' } }]);
    expect((await scanCanonicalUsage({ projectsDir: root, sessionIds: ['z-original'] })).records).toEqual([
      expect.objectContaining({ sessionId: 'z-original', complete: false }),
    ]);
  });

  it('prefers a matching original session ID over a legacy copy retaining its old session ID', async () => {
    const original = { ...assistant('legacy-copy'), sessionId: 'z-original' };
    await log('project/a-fork.jsonl', [original]);
    await log('project/z-original.jsonl', [original]);
    expect((await scanCanonicalUsage({ projectsDir: root, sessionIds: ['z-original'] })).records).toEqual([
      expect.objectContaining({ sessionId: 'z-original', complete: true }),
    ]);
  });

  it('preserves the selected source but marks ambiguous same-time ownership unverified', async () => {
    await log('project/a-fork.jsonl', [{ ...assistant('ambiguous'), sessionId: 'a-fork' }]);
    await log('project/z-original.jsonl', [{ ...assistant('ambiguous'), sessionId: 'z-original' }]);
    expect((await scanCanonicalUsage({ projectsDir: root, sessionIds: ['z-original'] })).records).toEqual([
      expect.objectContaining({ sessionId: 'z-original', complete: false }),
    ]);
  });

  it('lets an earlier subagent own a later main copy', async () => {
    await log('project/main.jsonl', [assistant('same-id', TODAY)]);
    await log('project/parent/subagents/agent-one.jsonl', [assistant('same-id', EARLY)]);
    expect((await scanCanonicalUsage({ projectsDir: root })).records).toEqual([
      expect.objectContaining({ sessionId: 'parent', agentId: 'agent-one', timestamp: EARLY }),
    ]);
  });

  it('recovers a terminating fork copy only when the owner has no final usage', async () => {
    await log('project/original.jsonl', [assistant('recover', TODAY, { ...TOKENS, input_tokens: 900, output_tokens: 1 }, { stop_reason: null })]);
    await log('project/fork.jsonl', [assistant('recover', LATER, { ...TOKENS, input_tokens: 19, output_tokens: 20 })]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ sessionId: 'original', timestamp: TODAY, input_tokens: 19, output_tokens: 20, complete: true })]);
    expect(result.diagnostics.recovered_final_count).toBe(1);
  });

  it('recovers a terminating copy when the owner stop marker has no final usage', async () => {
    await log('project/original.jsonl', [assistant('recover-missing', TODAY, undefined, { usage: undefined })]);
    await log('project/fork.jsonl', [assistant('recover-missing', LATER)]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ sessionId: 'original', input_tokens: 12, complete: true })]);
    expect(result.diagnostics.recovered_final_count).toBe(1);
  });

  it('does not recover a final fork with output below the owner cumulative output', async () => {
    await log('project/original.jsonl', [assistant('weak-final', TODAY, { ...TOKENS, output_tokens: 40 }, { stop_reason: null })]);
    await log('project/fork.jsonl', [assistant('weak-final', LATER, TOKENS)]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ output_tokens: 40, complete: false })]);
    expect(result.diagnostics.recovered_final_count).toBe(0);
  });

  it('deduplicates globally before filtering sessions and half-open windows', async () => {
    await log('a-project/fork.jsonl', [assistant('old-response', TODAY), assistant('new-response', TODAY), assistant('until-response', LATER)]);
    await log('z-project/original.jsonl', [assistant('old-response', EARLY)]);
    const result = await scanCanonicalUsage({ projectsDir: root, sessionIds: ['fork'], since: TODAY, until: LATER });
    expect(result.records.map(row => row.responseId)).toEqual(['new-response']);
    expect(result.diagnostics.files_scanned).toBe(2);
    expect((await scanCanonicalUsage({ projectsDir: root, sessionIds: [] })).records).toEqual([]);
  });

  it('reads new calls in an old conversation to EOF regardless of mtime or depth', async () => {
    const filename = await log('project/old-session.jsonl', [
      { type: 'user', timestamp: EARLY, message: { content: 'A long existing conversation' } },
      assistant('before-window', EARLY),
    ], JSON.stringify(assistant('new-call')));
    await utimes(filename, new Date('2000-01-01'), new Date('2000-01-01'));
    await log('project/old-session/subagents/agent-one.jsonl', [assistant('new-agent-call')]);
    await log('project/old-session/subagents/nested/ignored.jsonl', [assistant('nested')]);
    await log('project/old-session/stream.jsonl', [assistant('stream-replica')]);
    await log('root-ignored.jsonl', [assistant('not-canonical')]);
    const result = await scanCanonicalUsage({ projectsDir: root, since: TODAY, until: '2026-10-14' });
    expect(result.records.map(row => row.responseId).sort()).toEqual(['new-agent-call', 'new-call']);
    expect(result.diagnostics.files_scanned).toBe(2);
  });

  it('keeps distinct models under the same response ID and preserves unknown identities', async () => {
    await log('project/main.jsonl', [assistant('same-id'), assistant('same-id', TODAY, TOKENS, { model: 'acme-model-v9' })]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records.map(row => row.model)).toEqual(['claude-opus-4-8', 'acme-model-v9']);
  });

  it('marks streaming, missing counters, unknown models and incomplete TTL details as incomplete', async () => {
    await log('project/main.jsonl', [
      assistant('streaming', TODAY, { ...TOKENS, output_tokens: 1 }, { stop_reason: null }),
      assistant('no-usage', TODAY, undefined, { usage: undefined }),
      assistant('partial-counters', TODAY, { input_tokens: 7 }),
      assistant('no-model', TODAY, TOKENS, { model: undefined }),
      assistant('unknown-ttl', TODAY, { ...TOKENS, cache_creation_input_tokens: 10 }),
      assistant('partial-ttl', TODAY, { ...TOKENS, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } }),
      assistant('wrong-ttl', TODAY, { ...TOKENS, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 9 } }),
      assistant('complete-ttl', TODAY, { ...TOKENS, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } }),
    ]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records.filter(row => row.complete).map(row => row.responseId)).toEqual(['complete-ttl']);
    expect(result.records.find(row => row.responseId === 'no-usage')).toMatchObject({ input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null });
    expect(result.records.find(row => row.responseId === 'partial-ttl')).not.toHaveProperty('cache_creation');
    expect(result.diagnostics.incomplete_records).toBe(7);
  });

  it('accepts final GPT implicit cache creation without inventing cache TTL details', async () => {
    await log('project/main.jsonl', [assistant('gpt-implicit', TODAY,
      { ...TOKENS, cache_creation_input_tokens: 10 }, { model: 'GPT-6.1-Sol' }),
      assistant('claude-missing-ttl', TODAY, { ...TOKENS, cache_creation_input_tokens: 10 }),
    ]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records[0]).toMatchObject({ model: 'gpt-6-1-sol', cache_creation_input_tokens: 10, complete: true });
    expect(result.records[0]).not.toHaveProperty('cache_creation');
    expect(result.records[1]!.complete).toBe(false);
  });

  it('preserves final standard, fast and regional pricing fields without changing token completeness', async () => {
    await log('project/main.jsonl', [
      assistant('standard'),
      assistant('fast-us', TODAY, { ...TOKENS, speed: 'fast', inference_geo: 'us' }),
      assistant('global', TODAY, { ...TOKENS, inference_geo: 'global', iterations: null }),
      assistant('priority', TODAY, { ...TOKENS, service_tier: 'priority' }),
      assistant('batch', TODAY, { ...TOKENS, service_tier: 'batch' }),
    ]);
    const records = (await scanCanonicalUsage({ projectsDir: root })).records;
    expect(records.every(record => record.complete)).toBe(true);
    expect(records.map(record => record.pricing_context_complete)).toEqual([true, true, true, false, false]);
    expect(records[1]).toMatchObject({ speed: 'fast', inference_geo: 'us', service_tier: 'standard' });
    expect(records[3]!.service_tier).toBe('priority');
    expect(records[4]!.service_tier).toBe('batch');
  });

  it('preserves missing versus explicit unknown pricing metadata instead of inventing standard rates', async () => {
    const { speed: _speed, inference_geo: _geo, service_tier: _tier, ...legacy } = TOKENS;
    await log('project/main.jsonl', [assistant('legacy', TODAY, legacy),
      assistant('unknown', TODAY, { ...TOKENS, speed: null, inference_geo: null, service_tier: null }),
      assistant('invalid', TODAY, { ...TOKENS, speed: false, inference_geo: 7, service_tier: {} }),
      assistant('unknown-geo', TODAY, { ...TOKENS, inference_geo: 'other-region' }),
    ]);
    const records = (await scanCanonicalUsage({ projectsDir: root })).records;
    expect(records.every(record => record.complete && record.pricing_context_complete === false)).toBe(true);
    expect(records[0]).not.toHaveProperty('speed');
    expect(records[0]).not.toHaveProperty('inference_geo');
    expect(records[0]).not.toHaveProperty('service_tier');
    expect(records[1]).toMatchObject({ speed: null, inference_geo: null, service_tier: null });
    expect(records[2]).toMatchObject({ speed: null, inference_geo: null, service_tier: null });
    expect(records[3]!.inference_geo).toBe('other-region');
  });

  it('preserves server tool counters and declines incomplete or non-token pricing contexts', async () => {
    await log('project/main.jsonl', [
      assistant('zero-tools'),
      assistant('search', TODAY, { ...TOKENS, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }),
      assistant('partial-tool', TODAY, { ...TOKENS, server_tool_use: { web_search_requests: 0 } }),
      assistant('invalid-tool', TODAY, { ...TOKENS, server_tool_use: { web_search_requests: -1, web_fetch_requests: false } }),
      assistant('invalid-tool-object', TODAY, { ...TOKENS, server_tool_use: 'invalid' }),
      assistant('iterations', TODAY, { ...TOKENS, iterations: [{ type: 'fallback_message', model: 'claude-opus-4-8' }] }),
      assistant('invalid-iterations', TODAY, { ...TOKENS, iterations: false }),
    ]);
    const records = (await scanCanonicalUsage({ projectsDir: root })).records;
    expect(records.every(record => record.complete)).toBe(true);
    expect(records.map(record => record.pricing_context_complete)).toEqual([true, false, false, false, false, false, false]);
    expect(records[1]!.server_tool_use).toEqual({ web_search_requests: 2, web_fetch_requests: 1 });
    expect(records[2]!.server_tool_use).toEqual({ web_search_requests: 0, web_fetch_requests: null });
    expect(records[3]!.server_tool_use).toEqual({ web_search_requests: null, web_fetch_requests: null });
    expect(records[4]!.server_tool_use).toEqual({ web_search_requests: null, web_fetch_requests: null });
  });

  it('selects pricing fields from the final original snapshot or recovered final copy', async () => {
    await log('project/original.jsonl', [
      assistant('final-original', TODAY, { ...TOKENS, speed: 'fast', inference_geo: 'us' }, { stop_reason: null }),
      assistant('final-original', LATER),
      assistant('copy-final', TODAY, TOKENS, { stop_reason: null }),
    ]);
    await log('project/fork.jsonl', [assistant('copy-final', LATER, { ...TOKENS, speed: 'fast', inference_geo: 'us' })]);
    const records = (await scanCanonicalUsage({ projectsDir: root })).records;
    expect(records.find(record => record.responseId === 'final-original')).toMatchObject({ speed: 'standard', inference_geo: '', pricing_context_complete: true });
    expect(records.find(record => record.responseId === 'copy-final')).toMatchObject({ speed: 'fast', inference_geo: 'us', pricing_context_complete: true });
  });

  it('does not carry estimated initial counters into a partial final snapshot', async () => {
    await log('project/main.jsonl', [assistant('partial-final', TODAY, TOKENS, { stop_reason: null }),
      assistant('partial-final', LATER, { input_tokens: 2, output_tokens: 9 })]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toEqual([expect.objectContaining({ input_tokens: 2, output_tokens: 9, cache_creation_input_tokens: null, cache_read_input_tokens: null, complete: false })]);
  });

  it('reports invalid records and counters without inventing response IDs or zero usage', async () => {
    await log('project/main.jsonl', [
      assistant(undefined), assistant('bad-time', '2026-10-13T12:00:00'),
      assistant('bad-counter', TODAY, { ...TOKENS, input_tokens: -1 }),
      assistant('bad-object', TODAY, 'invalid'),
      assistant('bad-cache', TODAY, { ...TOKENS, cache_creation: 'invalid' }),
      assistant('bool-counter', TODAY, { ...TOKENS, output_tokens: true }),
      assistant('synthetic', TODAY, { input_tokens: 0, output_tokens: 0 }, { model: '<synthetic>' }),
      [], null,
    ], '{"partial":');
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records.map(row => row.responseId)).toEqual(['bad-counter', 'bad-object', 'bad-cache', 'bool-counter']);
    expect(result.records.every(row => !row.complete)).toBe(true);
    expect(result.records[0]!.input_tokens).toBeNull();
    expect(result.diagnostics).toMatchObject({ missing_message_ids: 1, invalid_timestamps: 1, invalid_usage: 4, invalid_lines: 3 });
    await writeFile(path.join(root, 'project', 'main.jsonl'), JSON.stringify(assistant('repaired')));
    expect((await scanCanonicalUsage({ projectsDir: root })).records.map(row => row.responseId)).toEqual(['repaired']);
  });

  it('never opens FIFO, directory or symbolic-link JSONLs', async () => {
    const valid = await log('project/main.jsonl', [assistant('valid')]);
    await mkdir(path.join(root, 'project', 'directory.jsonl'));
    await symlink(valid, path.join(root, 'project', 'link.jsonl'));
    execFileSync('mkfifo', [path.join(root, 'project', 'pipe.jsonl')]);
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records.map(row => row.responseId)).toEqual(['valid']);
    expect(result.diagnostics).toMatchObject({ files_scanned: 1, skipped_non_regular_files: 3, unreadable_files: 0 });
  });

  it('streams dense logs completely and yields during scan CPU work', async () => {
    await log('project/main.jsonl', Array.from({ length: 3_000 }, (_, i) => assistant(`dense-${i}`)));
    const result = await scanCanonicalUsage({ projectsDir: root });
    expect(result.records).toHaveLength(3_000);
    expect(result.records[2_999]!.responseId).toBe('dense-2999');
    expect(result.diagnostics.yields).toBeGreaterThan(0);
  });

  it('keeps dense historical ownership lightweight without charging copied history today', async () => {
    const old = Array.from({ length: 2_000 }, (_, i) => assistant(`historical-${i}`, EARLY));
    await log('z-project/original.jsonl', old);
    await log('a-project/fork.jsonl', old.map(row => ({ ...row, timestamp: TODAY })).concat([assistant('today-only')]));
    const result = await scanCanonicalUsage({ projectsDir: root, since: TODAY, sessionIds: ['fork'] });
    expect(result.records.map(row => row.responseId)).toEqual(['today-only']);
    expect(result.diagnostics.duplicate_usage_lines).toBe(2_000);
  });

  it('allows independent concurrent scans and repeat scans without retained state', async () => {
    await log('project/main.jsonl', [assistant('one'), assistant('two', LATER)]);
    const results = await Promise.all([
      scanCanonicalUsage({ projectsDir: root, until: LATER }),
      scanCanonicalUsage({ projectsDir: root, since: LATER }),
    ]);
    expect(results.map(result => result.records.map(row => row.responseId))).toEqual([['one'], ['two']]);
    expect((await scanCanonicalUsage({ projectsDir: root })).records.map(row => row.responseId)).toEqual(['one', 'two']);
  });

  it('validates boundaries and requires a named directory', async () => {
    await expect(scanCanonicalUsage({ projectsDir: root, since: '2026-10-13T12:00:00' })).rejects.toThrow('boundary');
    await expect(scanCanonicalUsage({ projectsDir: root, since: LATER, until: TODAY })).rejects.toThrow('precede');
    await expect(scanCanonicalUsage({ projectsDir: root, since: '2026-02-30' })).rejects.toThrow('boundary');
    await expect(scanCanonicalUsage({ projectsDir: root, since: '2026-02-30T12:00:00Z' })).rejects.toThrow('boundary');
    const filename = await log('project/main.jsonl', []);
    await expect(scanCanonicalUsage({ projectsDir: filename })).rejects.toThrow('directory');
  });
});

describe('cost-state restoration', () => {
  it('returns the last schema-valid source state, not the largest cost or newest timestamp', async () => {
    await log('project/main.jsonl', [cost('main', 9, { timestamp: LATER }), cost('main', 3, { timestamp: TODAY }),
      cost('main', 10, { totalToolDuration: 'invalid' }), cost('other', 99),
      { type: 'result', session_id: 'main', total_cost_usd: 400 },
    ]);
    await log('project/main/subagents/agent-one.jsonl', [cost('main', 100)]);
    const result = await scanCanonicalUsage({ projectsDir: root, since: LATER, sessionIds: ['main'] });
    expect(result.costStates).toEqual([{ sessionId: 'main', totalCostUsd: 3, timestamp: TODAY }]);
    expect(await scanCostState({ projectsDir: root, sessionId: 'main' })).toEqual(result.costStates[0]);
  });

  it('does not guess a timestamp from startTime or a neighbouring transcript line', async () => {
    await log('project/main.jsonl', [assistant('msg'), cost('main', 4), cost('main', 2, { startTime: -1 })]);
    expect(await scanCostState({ projectsDir: root, sessionId: 'main' })).toEqual({ sessionId: 'main', totalCostUsd: 4 });
  });

  it('validates model counters, limits and optional state fields like the official schema', async () => {
    const valid = cost('main', 1);
    await log('project/main.jsonl', [valid, cost('main', 2, { modelUsage: { 'bad\u0000model': {} } }),
      cost('main', 3, { hasUnknownModelCost: 'yes' }), cost('main', 1e9 + 1),
      cost('main', 4, { modelUsage: { model: { ...valid.modelUsage['claude-opus-4-8'], thinkingTokens: -1 } } }),
      cost('main', 5, { modelUsage: { first: { ...valid.modelUsage['claude-opus-4-8'], inputTokens: 6e14 },
        second: { ...valid.modelUsage['claude-opus-4-8'], inputTokens: 6e14 } } }),
    ]);
    expect(await scanCostState({ projectsDir: root, sessionId: 'main' })).toEqual({ sessionId: 'main', totalCostUsd: 1 });
  });

  it('uses cwd project first and reads only that main file, never FIFO or copied parent state', async () => {
    await log('a-project/main.jsonl', [cost('main', 1)]);
    await log('-work-acme/main.jsonl', [cost('main', 2)]);
    await log('-work-acme/fork.jsonl', [cost('main', 90)]);
    execFileSync('mkfifo', [path.join(root, 'a-project', 'not-a-session.jsonl')]);
    expect(await scanCostState({ projectsDir: root, sessionId: 'main', cwd: '/work/acme' })).toEqual({ sessionId: 'main', totalCostUsd: 2 });
    expect(await scanCostState({ projectsDir: root, sessionId: 'fork', cwd: '/work/acme' })).toBeUndefined();
    expect(await scanCostState({ projectsDir: root, sessionId: 'not-a-session' })).toBeUndefined();
    expect(await scanCostState({ projectsDir: root, sessionId: 'missing' })).toBeUndefined();
    await expect(scanCostState({ projectsDir: root, sessionId: '../main' })).rejects.toThrow('filename component');
  });
});

describe('normalizeUsageModel', () => {
  it.each([
    ['bedrock/converse/us.anthropic.claude-opus-4-8-20261001-v1:0[1m]', 'claude-opus-4-8'],
    [' CLAUDE-SONNET-4-5-20250929 ', 'claude-sonnet-4-5'],
    ['claude-3-5-haiku', 'claude-haiku-3-5'], ['opus-4.8', 'claude-opus-4-8'],
    ['global.anthropic.claude-opus-5-5-fast-v1:0', 'claude-opus-5-5-fast'],
    ['GPT-6.1-Sol', 'gpt-6-1-sol'], ['gpt6astra', 'gpt-6-astra'],
    ['openai.gpt-6-luna-v1:0', 'gpt-6-luna'],
    ['acme-model-v9', 'acme-model-v9'], ['', 'unknown'], [null, 'unknown'],
  ])('normalizes %s without guessing prices', (input, expected) => {
    expect(normalizeUsageModel(input)).toBe(expected);
  });
});
