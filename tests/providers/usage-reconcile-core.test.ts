import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileUsage, scanProxyUsage, type ProxyUsageRecord } from '../../src/providers/usage-reconcile-core.js';
import { scanCanonicalUsage, type CanonicalUsageRecord } from '../../src/providers/usage-scan-core.js';
import * as canonicalScanner from '../../src/providers/usage-scan-core.js';
import { scanHostUsage, createUsagePages } from '../../src/providers/usage-host-core.js';

const START = Date.parse('2026-10-12T12:00:00Z');
const iso = (offset = 0) => new Date(START + offset).toISOString();
const TOKENS = { input_tokens: 19, output_tokens: 47, cache_creation_input_tokens: 120, cache_read_input_tokens: 8_500 };

function canonical(overrides: Partial<CanonicalUsageRecord> = {}): CanonicalUsageRecord {
  return { responseId: 'msg-a', model: 'claude-opus-4-6', sessionId: 'session-a', timestamp: iso(1_000),
    ...TOKENS, complete: true, ...overrides };
}
function proxy(overrides: Partial<ProxyUsageRecord> = {}): ProxyUsageRecord {
  return { source: 'proxy', requestId: 'p1', sessionId: 'session-a', model: 'claude-opus-4-6',
    requestedModel: 'claude-opus-4-6', responseModel: 'claude-opus-4-6', forwardedModel: 'claude-opus-4-6',
    startedMs: START, finishedMs: START + 1_000, usagePresent: true, complete: true,
    fileIndex: 0, lineNumber: 1, ...TOKENS, ...overrides };
}
/** Actual CACHE log envelope with neutral request/session/account labels. */
function cache(overrides: Record<string, unknown> = {}): string {
  return '2026-10-12 12:00:01 INFO request CACHE ' + JSON.stringify({
    account: 'route-a', request_id: 'p1', session_id: 'session-a', started_ms: START,
    requested_model: 'claude-opus-4-6', forwarded_model: 'global.anthropic.claude-opus-4-6-v1:0',
    response_model: 'claude-opus-4-6', duration_ms: 1_000, total_ms: 1_000,
    outcome: 'complete', success: true, usage_present: true, ...TOKENS,
    cache_markers: [{ ttl: '1h', scope: 'system', block_index: 0 }],
    ...overrides,
  });
}
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'wn-usage-reconcile-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function logFile(name: string, lines: string[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

describe('scanProxyUsage', () => {
  it('reads actual top-level usage, not prompt content, account labels or cache marker TTL', async () => {
    const file = await logFile('usage.log', [
      'INFO request BODY {"prompt":"must not be returned"}',
      cache({ prompt: 'must not be returned', input_tokens: 2 }),
      cache({ request_id: 'p2', response_model: null, duration_ms: 2_000, total_ms: 99_000 }),
      cache({ request_id: 'p3', response_model: null, forwarded_model: null, duration_ms: null, total_ms: 3_000 }),
    ]);
    const result = await scanProxyUsage({ files: [file] });
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({ ...TOKENS, input_tokens: 2, requestId: 'p1',
      sessionId: 'session-a', startedMs: START, finishedMs: START + 1_000, complete: true, source: 'proxy' });
    expect(result.records[1]).toMatchObject({ model: 'global.anthropic.claude-opus-4-6-v1:0', finishedMs: START + 2_000 });
    expect(result.records[2]).toMatchObject({ model: 'claude-opus-4-6', finishedMs: START + 3_000 });
    expect(result.coverage).toMatchObject({ filesScanned: 1, cacheLines: 3, allFilesRead: true, incomplete: 0 });
    expect(result.diagnostics).toEqual([]);
    const exported = JSON.stringify(result);
    for (const privateValue of ['must not be returned', 'route-a', file, 'cache_markers', 'cache_creation"']) {
      expect(exported).not.toContain(privateValue);
    }
  });

  it('deduplicates across files by account, local request id and request start', async () => {
    const fileA = await logFile('a.log', [cache(), cache()]);
    const fileB = await logFile('b.log', [cache(), cache({ account: 'route-b' }), cache({ started_ms: START + 1 })]);
    const result = await scanProxyUsage({ files: [fileA, fileB, fileA] });
    expect(result.records).toHaveLength(3);
    expect(result.coverage.duplicates).toBe(4);
    expect(result.records.map((record) => record.startedMs)).toEqual([START, START, START + 1]);
  });

  it('returns stable opaque identities across batches without exposing account labels', async () => {
    const file = await logFile('identities.log', [cache()]);
    const first = await scanProxyUsage({ files: [file], offsets: {} });
    const identity = first.records[0].evidenceId;
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    await appendFile(file, [cache(), cache({ account: 'route-b' }), cache({ started_ms: START + 1 })].join('\n') + '\n');
    const next = await scanProxyUsage({ files: [file], offsets: first.checkpoints });
    expect(next.records[0].evidenceId).toBe(identity);
    expect(new Set(next.records.map(row => row.evidenceId)).size).toBe(3);
    await appendFile(file, cache({ input_tokens: 20 }) + '\n');
    const conflict = await scanProxyUsage({ files: [file], offsets: next.checkpoints });
    expect(conflict.records[0]).toMatchObject({ evidenceId: identity, input_tokens: 20, complete: true });
    expect(first.records[0]).toMatchObject({ evidenceId: identity, input_tokens: 19, complete: true });
    const full = await scanProxyUsage({ files: [file] });
    expect(full.records.find(row => row.evidenceId === identity)).toMatchObject({ input_tokens: null, complete: false });
    const records = JSON.stringify([...first.records, ...next.records, ...conflict.records, ...full.records]);
    expect(records).not.toContain('route-a');
    expect(records).not.toContain('route-b');
    expect(records).not.toContain('account');
  });

  it('does not verify conflicting duplicates or turn unknown counters into zero', async () => {
    const file = await logFile('conflict.log', [cache(), cache({ input_tokens: 20 })]);
    const result = await scanProxyUsage({ files: [file] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ input_tokens: null, complete: false });
    expect(result.diagnostics).toEqual([{ fileIndex: 0, lineNumber: 2, code: 'conflicting-duplicate' }]);
    expect(reconcileUsage([canonical()], result.records).records[0].verification).toBe('unmatched');
  });

  it.each(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])
    ('keeps missing, null and malformed %s unknown', async (field) => {
      const values = [undefined, null, '0', -1, 1.5, true];
      const file = await logFile('unknown.log', values.map((value, index) => cache({ request_id: `p${index}`, [field]: value })));
      const result = await scanProxyUsage({ files: [file] });
      expect(result.records).toHaveLength(values.length);
      expect(result.records.every((record) => record[field as keyof ProxyUsageRecord] === null && !record.complete)).toBe(true);
      expect(result.coverage.incomplete).toBe(values.length);
    });

  it('distinguishes valid zero usage from absent usage and unsuccessful outcomes', async () => {
    const file = await logFile('states.log', [
      cache({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      cache({ request_id: 'p2', usage_present: false }), cache({ request_id: 'p3', outcome: 'error', success: false }),
      cache({ request_id: 'p4', outcome: 'success' }), cache({ request_id: 'p5', outcome: undefined }),
    ]);
    const result = await scanProxyUsage({ files: [file] });
    expect(result.records.map((record) => record.complete)).toEqual([true, false, false, true, true]);
    expect(result.records[2].output_tokens).toBe(TOKENS.output_tokens);
  });

  it('filters by half-open request-start bounds and preserves unattributed coverage', async () => {
    const file = await logFile('window.log', [
      cache({ request_id: 'before', started_ms: START - 1, duration_ms: 60_000 }),
      cache({ request_id: 'at-start' }),
      cache({ request_id: 'at-end', started_ms: START + 1_000 }),
      cache({ request_id: 'after', started_ms: START + 1_001 }),
      cache({ request_id: 'other-session', session_id: 'session-b' }),
      cache({ request_id: 'unknown-session', session_id: null }),
    ]);
    const result = await scanProxyUsage({ files: [file], since: iso(), until: iso(1_000), sessionIds: ['session-a'] });
    expect(result.records.map((record) => record.requestId)).toEqual(['at-start', 'unknown-session']);
    expect(result.coverage).toMatchObject({ filtered: 4, unattributed: 1, firstStartedMs: START, lastStartedMs: START });
    const emptyFilter = await scanProxyUsage({ files: [file], sessionIds: [] });
    expect(emptyFilter.records.map((record) => record.sessionId)).toEqual([null]);
  });

  it('supports Date and local-date boundaries without silently accepting invalid bounds', async () => {
    const file = await logFile('dates.log', [cache()]);
    expect((await scanProxyUsage({ files: [file], since: new Date(START), until: START + 1 })).records).toHaveLength(1);
    expect((await scanProxyUsage({ files: [file], since: START, until: START })).records).toHaveLength(0);
    expect((await scanProxyUsage({ files: [file], since: '2026-10-12', until: '2026-10-13' })).records).toHaveLength(1);
    for (const since of ['invalid', '2026-02-30']) {
      await expect(scanProxyUsage({ files: [file], since })).rejects.toThrow('Invalid usage time bound');
    }
    await expect(scanProxyUsage({ files: [file], since: START + 1, until: START })).rejects.toThrow('Reversed');
  });

  it('reports malformed CACHE records and unreadable or non-regular files without raw contents', async () => {
    const file = await logFile('broken.log', [
      'INFO request CACHE {not-json-secret}', cache({ started_ms: null }), cache({ request_id: null }), cache(),
    ]);
    const linked = path.join(dir, 'linked.log');
    await symlink(file, linked);
    const result = await scanProxyUsage({ files: [file, path.join(dir, 'missing.log'), dir, linked] });
    expect(result.records).toHaveLength(1);
    expect(result.coverage).toMatchObject({ filesRequested: 4, filesScanned: 1, allFilesRead: false });
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'invalid-cache-json', 'invalid-request-identity', 'invalid-request-identity', 'ENOENT', 'not-regular-file', 'ELOOP',
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret');
  });

  it('has no implicit files and reads an explicit empty file cleanly', async () => {
    expect((await scanProxyUsage({ files: [] })).records).toEqual([]);
    const file = path.join(dir, 'empty.log'); await writeFile(file, '');
    expect((await scanProxyUsage({ files: [file] })).coverage).toMatchObject({ filesScanned: 1, cacheLines: 0, allFilesRead: true });
  });

  it('checkpoints only complete incremental lines and rereads an appended UTF-8 fragment', async () => {
    const firstLine = cache({ request_id: 'first' }) + '\r\n';
    const unicode = String.fromCodePoint(0xe9, 0x96ea);
    const pendingLine = cache({ request_id: 'pending', prompt: unicode });
    const pendingBytes = Buffer.from(pendingLine);
    const split = pendingBytes.indexOf(Buffer.from(unicode.slice(1))) + 1;
    const file = path.join(dir, 'incremental.log');
    await writeFile(file, Buffer.concat([Buffer.from(firstLine), pendingBytes.subarray(0, split)]));
    const first = await scanProxyUsage({ files: [file], offsets: {} });
    expect(first.records.map(row => row.requestId)).toEqual(['first']);
    expect(first.checkpoints?.[file].offset).toBe(Buffer.byteLength(firstLine));
    expect(first.diagnostics).toEqual([]);
    const unchanged = await scanProxyUsage({ files: [file], offsets: first.checkpoints });
    expect(unchanged.records).toEqual([]);
    expect(unchanged.checkpoints).toEqual(first.checkpoints);
    await appendFile(file, Buffer.concat([pendingBytes.subarray(split), Buffer.from('\n' + cache({ request_id: 'last' }))]));
    const second = await scanProxyUsage({ files: [file], offsets: first.checkpoints });
    expect(second.records.map(row => row.requestId)).toEqual(['pending']);
    expect(second.checkpoints?.[file].offset).toBe(Buffer.byteLength(firstLine + pendingLine + '\n'));
    expect(second.diagnostics).toEqual([]);
    await appendFile(file, '\n');
    const third = await scanProxyUsage({ files: [file], offsets: second.checkpoints });
    expect(third.records.map(row => row.requestId)).toEqual(['last']);
    expect(third.checkpoints?.[file].offset).toBe((await stat(file)).size);
    expect((await scanProxyUsage({ files: [file], offsets: third.checkpoints })).records).toEqual([]);
  });

  it('preserves whole-file EOF behavior while incremental mode waits for a newline', async () => {
    const file = path.join(dir, 'unterminated.log');
    await writeFile(file, cache());
    const whole = await scanProxyUsage({ files: [file] });
    expect(whole.records).toHaveLength(1);
    expect(whole).not.toHaveProperty('checkpoints');
    const incremental = await scanProxyUsage({ files: [file], offsets: {} });
    expect(incremental.records).toEqual([]);
    expect(incremental.checkpoints?.[file].offset).toBe(0);
    await appendFile(file, '\n');
    expect((await scanProxyUsage({ files: [file], offsets: incremental.checkpoints })).records).toHaveLength(1);
  });

  it('restarts incremental reads when a file is truncated or replaced by rotation', async () => {
    const file = await logFile('proxy.log', [cache({ request_id: 'old-one' }), cache({ request_id: 'old-two' })]);
    const first = await scanProxyUsage({ files: [file], offsets: {} });
    await writeFile(file, cache({ request_id: 'short' }) + '\n');
    const truncated = await scanProxyUsage({ files: [file], offsets: first.checkpoints });
    expect(truncated.records.map(row => row.requestId)).toEqual(['short']);
    expect(truncated.checkpoints?.[file].ino).toBe(first.checkpoints?.[file].ino);
    expect(truncated.checkpoints?.[file].offset).toBe((await stat(file)).size);
    const rotatedFile = path.join(dir, 'proxy.log.2026-10-12');
    await rename(file, rotatedFile);
    await writeFile(file, cache({ request_id: 'replacement' }) + '\n');
    const rotated = await scanProxyUsage({ files: [file, rotatedFile], offsets: {
      ...truncated.checkpoints, [rotatedFile]: truncated.checkpoints![file],
    } });
    expect(rotated.records.map(row => row.requestId)).toEqual(['replacement']);
    expect(rotated.checkpoints?.[file].ino).not.toBe(truncated.checkpoints?.[file].ino);
    expect(rotated.checkpoints?.[rotatedFile]).toEqual(truncated.checkpoints?.[file]);
  });

  it('keeps conflict detection within a new batch and leaves cross-batch merging to the caller', async () => {
    const file = await logFile('batches.log', [cache()]);
    const first = await scanProxyUsage({ files: [file], offsets: {} });
    await appendFile(file, [cache({ input_tokens: 20 }), cache({ input_tokens: 21 })].join('\n') + '\n');
    const second = await scanProxyUsage({ files: [file], offsets: first.checkpoints });
    expect(first.records[0]).toMatchObject({ input_tokens: 19, complete: true });
    expect(second.records[0]).toMatchObject({ requestId: 'p1', input_tokens: null, complete: false });
    expect(second.coverage.duplicates).toBe(1);
    expect(second.diagnostics).toEqual([{ fileIndex: 0, lineNumber: 2, code: 'conflicting-duplicate' }]);
  });

  it('checkpoints complete malformed and filtered lines and validates offsets before opening files', async () => {
    const file = await logFile('filtered.log', ['INFO request CACHE {invalid}', cache({ session_id: 'other' })]);
    const result = await scanProxyUsage({ files: [file], offsets: {}, sessionIds: ['session-a'] });
    expect(result.records).toEqual([]);
    expect(result.coverage.filtered).toBe(1);
    expect(result.checkpoints?.[file].offset).toBe((await stat(file)).size);
    expect((await scanProxyUsage({ files: [file], offsets: result.checkpoints })).diagnostics).toEqual([]);
    for (const offset of [-1, 1.5, NaN]) {
      await expect(scanProxyUsage({ files: [path.join(dir, 'missing.log')], offsets: { [file]: { offset, dev: 1, ino: 1 } } }))
        .rejects.toThrow('Invalid usage file checkpoint');
    }
    const emptyFile = path.join(dir, 'empty-incremental.log');
    await writeFile(emptyFile, '');
    expect((await scanProxyUsage({ files: [emptyFile], offsets: {} })).checkpoints?.[emptyFile].offset).toBe(0);
  });

  it('yields after a five-millisecond CPU budget even when all scanned lines are unrelated', async () => {
    const file = await logFile('yield.log', Array.from({ length: 8 }, () => 'DEBUG unrelated entry'));
    let calls = 0;
    const clock = vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ user: calls++ * 5_001, system: 0 }));
    try {
      const result = await scanProxyUsage({ files: [file] });
      expect(result.coverage.yields).toBe(8);
      expect(result.records).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('streams a dense log while ignoring unrelated lines', async () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => index % 2
      ? cache({ request_id: `p${index}`, started_ms: START + index }) : 'DEBUG unrelated lifecycle entry');
    const file = await logFile('dense.log', lines);
    const result = await scanProxyUsage({ files: [file] });
    expect(result.records).toHaveLength(1_000);
    expect(result.coverage.cacheLines).toBe(1_000);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('host evidence windows and pagination', () => {
  function response(id: string, offset: number) {
    return { type: 'assistant', sessionId: 'session-a', timestamp: iso(offset), message: {
      id, model: 'claude-opus-4-6', stop_reason: 'end_turn',
      usage: { ...TOKENS, cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 0 } },
    } };
  }
  async function hostEvidence() {
    const projectsDir = path.join(dir, 'projects');
    await mkdir(path.join(projectsDir, 'example'), { recursive: true });
    await writeFile(path.join(projectsDir, 'example', 'session-a.jsonl'), [9_000, 11_000].map((offset, index) =>
      JSON.stringify(response(`msg-${index}`, offset))).join('\n') + '\n');
    await logFile('proxy.log', [cache({ started_ms: START + 8_000 })]);
    return { projectsDir, proxyLogDir: dir, sessionIds: ['session-a'] };
  }
  it('does not reuse a prior-window upstream record through the actual host scanner', async () => {
    const request = await hostEvidence();
    const first = await scanHostUsage({ ...request, until: iso(10_000) });
    const second = await scanHostUsage({ ...request, since: iso(10_000), until: iso(20_000) });
    expect(first.reconciliation.records[0].verification).toBe('matched');
    expect(second.reconciliation.records[0].verification).toBe('unmatched');
    expect(second.canonical.records.map(r => r.responseId)).toEqual(['msg-1']);
    expect(second.reconciliation.residuals[0]).toMatchObject({ source: 'canonical', count: 1 });
  });
  it('bounds snapshots but retains out-of-window proxy competitors and historical fork ownership', async () => {
    const request = await hostEvidence();
    const history = Array.from({ length: 300 }, (_, index) => response(`historical-${index}`, -86_400_000));
    await mkdir(path.join(request.projectsDir, 'original'));
    await writeFile(path.join(request.projectsDir, 'original', 'source.jsonl'), history.map(row =>
      JSON.stringify({ ...row, sessionId: 'source' })).join('\n') + '\n');
    await writeFile(path.join(request.projectsDir, 'example', 'session-a.jsonl'), [
      ...history.map(row => ({ ...row, timestamp: iso(11_000),
        forkedFrom: { sessionId: 'source', messageUuid: row.message.id } })),
      response('before-retained-window', -5_001), response('retained-start', -5_000),
      response('left-endpoint', 3_000), response('in-window', 11_000),
      response('right-endpoint', 55_000), response('after-retained-window', 55_001), response('future', 100_000),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await logFile('proxy.log', [cache({ request_id: 'competitor', started_ms: START + 8_000 }),
      cache({ request_id: 'left-extension', started_ms: START, input_tokens: 20 }),
      cache({ request_id: 'right-extension', started_ms: START + 50_000, duration_ms: null, total_ms: null }),
    ]);
    const allCanonical = await scanCanonicalUsage(request);
    const allProxy = await scanProxyUsage({ files: [path.join(dir, 'proxy.log')], sessionIds: request.sessionIds });
    const expected = reconcileUsage(allCanonical.records, allProxy.records, { since: START + 10_000, until: START + 20_000 });
    expect(reconcileUsage(allCanonical.records, allProxy.records).records.find(row => row.responseId === 'left-endpoint'))
      .toMatchObject({ verification: 'matched', upstream: { requestId: 'competitor' } });
    const scanner = vi.spyOn(canonicalScanner, 'scanCanonicalUsage');
    const result = await scanHostUsage({ ...request, since: iso(10_000), until: iso(20_000) });
    expect(scanner).toHaveBeenCalledWith({ ...request, since: new Date(START - 5_000), until: new Date(START + 55_001) });
    const retained = await (scanner.mock.results[0]!.value as ReturnType<typeof scanCanonicalUsage>);
    expect(retained.records.map(row => row.responseId)).toEqual([
      'retained-start', 'left-endpoint', 'in-window', 'right-endpoint',
    ]);
    expect(result.reconciliation).toEqual(expected);
    expect(result.canonical.records).toEqual(expected.records);
    expect(result.reconciliation.records).toEqual([expect.objectContaining({ responseId: 'in-window', verification: 'unmatched' })]);
    expect(result.upstream.records).toEqual([]);
    expect(result.canonical.diagnostics.duplicate_usage_lines).toBe(300);
  });

  it('keeps the left side unbounded when since is absent, even without proxy evidence', async () => {
    const request = await hostEvidence();
    await writeFile(path.join(dir, 'proxy.log'), '');
    await writeFile(path.join(request.projectsDir, 'example', 'session-a.jsonl'), [
      response('historical', -86_400_000), response('today', 11_000), response('at-until', 20_000),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const scanner = vi.spyOn(canonicalScanner, 'scanCanonicalUsage');
    const result = await scanHostUsage({ ...request, until: iso(20_000) });
    expect(scanner).toHaveBeenCalledWith({ ...request, since: undefined, until: new Date(START + 20_000) });
    expect(result.canonical.records.map(row => row.responseId)).toEqual(['historical', 'today']);
    expect(result.reconciliation.records.every(row => row.verification === 'unmatched')).toBe(true);
  });

  it('uses the requested half-open window when proxy evidence is absent', async () => {
    const request = await hostEvidence();
    await writeFile(path.join(dir, 'proxy.log'), '');
    const scanner = vi.spyOn(canonicalScanner, 'scanCanonicalUsage');
    const result = await scanHostUsage({ ...request, since: iso(10_000), until: iso(11_000) });
    expect(scanner).toHaveBeenCalledWith({ ...request, since: new Date(START + 10_000), until: new Date(START + 11_000) });
    expect(result.canonical.records).toEqual([]);
    expect(result.upstream.records).toEqual([]);
  });

  it('preserves an empty requested window without proxy evidence', async () => {
    const request = await hostEvidence();
    await writeFile(path.join(dir, 'proxy.log'), '');
    const result = await scanHostUsage({ ...request, since: iso(11_000), until: iso(11_000) });
    expect(result.reconciliation).toEqual({ records: [], upstreamUnmatched: [], residuals: [] });
    expect(result.upstream.records).toEqual([]);
  });

  it.each([
    { since: 'invalid', until: iso(20_000) },
    { since: '', until: iso(20_000) },
    { since: iso(20_000), until: iso(10_000) },
    { until: 'invalid' },
  ])('rejects an invalid host window before filesystem work: %j', async (window) => {
    const readdir = vi.spyOn(fs, 'readdir');
    const scanner = vi.spyOn(canonicalScanner, 'scanCanonicalUsage');
    await expect(scanHostUsage({ projectsDir: path.join(dir, 'missing-projects'), proxyLogDir: dir, ...window }))
      .rejects.toThrow('Invalid usage collection window');
    expect(readdir).not.toHaveBeenCalled();
    expect(scanner).not.toHaveBeenCalled();
  });

  it('pages dense evidence without dropping counts or retaining a completed job', async () => {
    const result = await scanHostUsage({ ...await hostEvidence(), until: iso(20_000) });
    result.reconciliation.records = Array.from({ length: 1_201 }, (_, index) => ({
      ...result.reconciliation.records[0], responseId: `reply-${index}`,
    }));
    const pages = createUsagePages();
    const first = pages.put(result);
    expect(first.result.reconciliation.records).toHaveLength(500);
    expect(first.result.reconciliation.responseCount).toBe(1_201);
    const second = pages.page(first.key, first.offset);
    const third = pages.page(first.key, second.offset);
    expect(second.result.reconciliation.records).toHaveLength(500);
    expect(third.result.reconciliation.records).toHaveLength(201);
    expect(third.done).toBe(true);
    expect(() => pages.page(first.key, third.offset)).toThrow('expired');
  });
});

describe('reconcileUsage', () => {
  it('matches independently recorded counters and normalized response models, not request ids', () => {
    const input = canonical({ agentId: 'worker-a', cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 120 } });
    const evidence = proxy({ model: 'global.anthropic.claude-opus-4-6-v1:0' });
    const result = reconcileUsage([input], [evidence]);
    expect(result.records[0]).toMatchObject({ ...input, verification: 'matched', upstream: evidence });
    expect(result.upstreamUnmatched).toEqual([]);
    expect(result.residuals).toEqual([]);
    expect(input).not.toHaveProperty('verification');
    expect(evidence).not.toHaveProperty('verification');
  });

  it('rejects model, session and individual counter mismatches', () => {
    const variants: Partial<ProxyUsageRecord>[] = [
      { model: 'claude-sonnet-4-6' }, { sessionId: 'session-b' }, { input_tokens: 20 },
      { output_tokens: 48 }, { cache_creation_input_tokens: 121 }, { cache_read_input_tokens: 8_501 },
    ];
    for (const variant of variants) {
      const result = reconcileUsage([canonical()], [proxy(variant)]);
      expect(result.records[0].verification).toBe('unmatched');
      expect(result.upstreamUnmatched).toHaveLength(1);
      expect(result.residuals.map((record) => record.source)).toEqual(['canonical', 'proxy']);
    }
  });

  it('treats incomplete canonical data and missing counter evidence as unverified', () => {
    const inputs = [canonical({ complete: false }), canonical({ output_tokens: null }), canonical({ timestamp: 'bad' })];
    const result = reconcileUsage(inputs, [proxy({ complete: false }), proxy({ input_tokens: null }), proxy({ usagePresent: false })]);
    expect(result.records.map((record) => record.verification)).toEqual(['incomplete', 'incomplete', 'incomplete']);
    expect(result.upstreamUnmatched).toHaveLength(3);
    expect(result.upstreamUnmatched.map((record) => record.verification)).toEqual(['incomplete', 'incomplete', 'incomplete']);
    expect(result.residuals.find((record) => record.source === 'canonical')).toMatchObject({ count: 3, output_tokens: null });
    expect(result.residuals.find((record) => record.source === 'proxy')).toMatchObject({ count: 3, input_tokens: null });
  });

  it('does not match unknown models or invalid observation times even when token counts agree', () => {
    expect(reconcileUsage([canonical({ model: 'unknown' })], [proxy({ model: 'unknown' })])
      .records[0].verification).toBe('incomplete');
    for (const overrides of [{ startedMs: NaN }, { finishedMs: START - 1 }, { finishedMs: Infinity }]) {
      const result = reconcileUsage([canonical()], [proxy(overrides)]);
      expect(result.records[0].verification).toBe('unmatched');
      expect(result.upstreamUnmatched[0].verification).toBe('incomplete');
    }
  });

  it('never attributes a session-less proxy observation to a known session', () => {
    const result = reconcileUsage([canonical()], [proxy({ sessionId: null })]);
    expect(result.records[0].verification).toBe('unmatched');
    expect(result.upstreamUnmatched[0].verification).toBe('unattributed');
  });

  it('consumes repeated signatures one-to-one despite shuffled inputs and timestamp drift', () => {
    const c = [canonical({ responseId: 'late', timestamp: iso(21_000) }), canonical({ responseId: 'early' }),
      canonical({ responseId: 'middle', timestamp: iso(11_000) })];
    const u = [proxy({ requestId: 'middle-p', startedMs: START + 10_000, finishedMs: START + 11_000 }), proxy()];
    const result = reconcileUsage(c, u);
    expect(result.records.map((record) => [record.responseId, record.verification, record.upstream?.requestId])).toEqual([
      ['late', 'unmatched', undefined], ['early', 'matched', 'p1'], ['middle', 'matched', 'middle-p'],
    ]);
    expect(result.upstreamUnmatched).toEqual([]);
    expect(result.residuals).toEqual([{ source: 'canonical', model: 'claude-opus-4-6', count: 1, ...TOKENS }]);
  });

  it('matches globally before trimming adjacent windows so evidence is never reused', () => {
    const inputs = [canonical({ responseId: 'early', timestamp: iso(9_000) }),
      canonical({ responseId: 'late', timestamp: iso(11_000) })];
    const upstream = [proxy({ requestId: 'early-p', startedMs: START + 8_000, finishedMs: START + 9_000 }),
      proxy({ requestId: 'late-p', startedMs: START + 10_000, finishedMs: START + 11_000 })];
    const first = reconcileUsage(inputs, upstream, { until: START + 10_000 });
    const second = reconcileUsage(inputs, upstream, { since: START + 10_000 });
    expect(first.records.map(r => r.upstream?.requestId)).toEqual(['early-p']);
    expect(second.records.map(r => r.upstream?.requestId)).toEqual(['late-p']);
    expect(second.upstreamUnmatched).toEqual([]);
    const missing = reconcileUsage(inputs, upstream.slice(0, 1), { since: START + 10_000 });
    expect(missing.records[0].verification).toBe('unmatched');
    expect(missing.residuals).toEqual([{ source: 'canonical', model: 'claude-opus-4-6', count: 1, ...TOKENS }]);
  });

  it('preserves a matched request that starts before the response window', () => {
    const result = reconcileUsage([canonical({ timestamp: iso(11_000) })],
      [proxy({ startedMs: START + 8_000, finishedMs: START + 11_000 })], { since: START + 10_000 });
    expect(result.records[0].verification).toBe('matched');
  });

  it('does not let the nearest-finish greedy choice lose a compatible second call', () => {
    const inputs = [canonical({ timestamp: iso(5_000) }), canonical({ responseId: 'msg-b', timestamp: iso(10_000) })];
    const upstream = [proxy({ requestId: 'later', finishedMs: START + 5_000 }), proxy({ requestId: 'earlier', finishedMs: START + 4_000 })];
    expect(reconcileUsage(inputs, upstream).records.map((record) => record.upstream?.requestId)).toEqual(['earlier', 'later']);
  });

  it('allows response timestamps within a completed start/finish interval, but not outside its drift window', () => {
    const evidence = proxy({ finishedMs: START + 120_000 });
    for (const offset of [-5_000, 0, 60_000, 120_000, 125_000]) {
      expect(reconcileUsage([canonical({ timestamp: iso(offset) })], [evidence]).records[0].verification).toBe('matched');
    }
    for (const offset of [-5_001, 125_001]) {
      expect(reconcileUsage([canonical({ timestamp: iso(offset) })], [evidence]).records[0].verification).toBe('unmatched');
    }
    expect(reconcileUsage([canonical({ timestamp: iso(125_000) })], [evidence], { maxTimestampDriftMs: 0 })
      .records[0].verification).toBe('unmatched');
    expect(() => reconcileUsage([], [], { maxTimestampDriftMs: -1 })).toThrow('Invalid usage timestamp drift');
  });

  it('bounds a missing completion timestamp to request start instead of matching arbitrary later calls', () => {
    expect(reconcileUsage([canonical({ timestamp: iso(5_000) })], [proxy({ finishedMs: null })]).records[0].verification).toBe('matched');
    expect(reconcileUsage([canonical({ timestamp: iso(5_001) })], [proxy({ finishedMs: null })]).records[0].verification).toBe('unmatched');
  });

  it('keeps already fork-deduped canonical inputs unchanged and preserves upstream multiplicity', () => {
    const result = reconcileUsage([canonical()], [proxy(), proxy({ requestId: 'p2' })]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].verification).toBe('matched');
    expect(result.upstreamUnmatched).toHaveLength(1);
    expect(result.residuals).toEqual([{ source: 'proxy', model: 'claude-opus-4-6', count: 1, ...TOKENS }]);
  });

  it('reports per-source, per-model counter residuals when either side is missing', () => {
    const onlyCanonical = reconcileUsage([canonical(), canonical({ responseId: 'msg-b' }), canonical({ model: 'claude-sonnet-4-6' })], []);
    expect(onlyCanonical.records.every((record) => record.verification === 'unmatched')).toBe(true);
    expect(onlyCanonical.residuals).toEqual([
      { source: 'canonical', model: 'claude-opus-4-6', count: 2, input_tokens: 38, output_tokens: 94,
        cache_creation_input_tokens: 240, cache_read_input_tokens: 17_000 },
      { source: 'canonical', model: 'claude-sonnet-4-6', count: 1, ...TOKENS },
    ]);
    const onlyProxy = reconcileUsage([], [proxy({ model: null, complete: false })]);
    expect(onlyProxy.upstreamUnmatched[0].verification).toBe('incomplete');
    expect(onlyProxy.residuals).toEqual([{ source: 'proxy', model: 'unknown', count: 1, ...TOKENS }]);
    expect(reconcileUsage([], [])).toEqual({ records: [], upstreamUnmatched: [], residuals: [] });
  });

  it('handles repeated same-signature calls at density without double consumption', () => {
    const upstream = Array.from({ length: 2_000 }, (_, index) => proxy({ requestId: `p${index}`,
      startedMs: START + index * 10_000, finishedMs: START + index * 10_000 + 1_000 }));
    const inputs = upstream.map((record, index) => canonical({ responseId: `msg-${index}`,
      timestamp: new Date(record.finishedMs!).toISOString() })).reverse();
    const result = reconcileUsage(inputs, upstream);
    expect(result.records.every((record) => record.verification === 'matched')).toBe(true);
    expect(new Set(result.records.map((record) => record.upstream?.requestId)).size).toBe(2_000);
    expect(result.residuals).toEqual([]);
  });
});
