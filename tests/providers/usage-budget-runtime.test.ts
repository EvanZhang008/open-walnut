import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageBudgetRuntime } from '../../src/providers/usage-budget-runtime.js';
import { createUsageBudgets } from '../../src/providers/usage-budget-core.js';

const roots: string[] = [];
const runtimes: ReturnType<typeof createUsageBudgetRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes) runtime.close();
  runtimes.length = 0;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const SID = 'example-session';
const T = Date.parse('2026-10-14T12:00:00Z');
function assistant(id: string, tokens: number, timestamp = T) {
  return { type: 'assistant', sessionId: SID, timestamp: new Date(timestamp).toISOString(),
    message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {
      input_tokens: 0, output_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      speed: 'standard', inference_geo: '', service_tier: 'standard',
    } } };
}
function proxy(id: string, tokens: number, timestamp = T) {
  return `request CACHE ${JSON.stringify({ request_id: id, session_id: SID, started_ms: timestamp - 100,
    finished_ms: timestamp, requested_model: 'claude-opus-5-5', response_model: 'claude-opus-5-5',
    forwarded_model: 'global.anthropic.claude-opus-5-5', outcome: 'complete', usage_present: true,
    input_tokens: 0, output_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })}\n`;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-budget-runtime-')); roots.push(root);
  const projectsDir = path.join(root, 'projects');
  const project = path.join(projectsDir, 'example');
  const proxyLogDir = path.join(root, 'proxy');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(proxyLogDir);
  const transcript = path.join(project, `${SID}.jsonl`), log = path.join(proxyLogDir, 'proxy.log');
  await fs.writeFile(transcript, JSON.stringify(assistant('initial', 100)) + '\n');
  await fs.writeFile(log, proxy('initial-upstream', 100));
  const pause = vi.fn(async () => {});
  const runtime = createUsageBudgetRuntime({ dir: path.join(root, 'budgets'), projectsDir, pause, now: () => T + 10_000, log: () => {} });
  runtimes.push(runtime);
  return { root, runtime, pause, transcript, log, proxyLogDir, projectsDir };
}
describe('host-owned budget runtime', () => {
  it('checks lifetime evidence, accounts new responses once and blocks at the allowance', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect(await f.runtime.allow(SID)).toBe(true);
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.002);
    const next = assistant('next', 500, T + 1000);
    await fs.appendFile(f.transcript, JSON.stringify(next) + '\n');
    await fs.appendFile(f.log, proxy('next-upstream', 500, T + 1000));
    f.runtime.observe(SID, next);
    expect(await f.runtime.allow(SID)).toBe(false);
    await f.runtime.poll();
    await vi.waitFor(async () => expect((await f.runtime.read(SID)).budget.state).toBe('paused'));
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.012);
    f.runtime.observe(SID, next);
    await f.runtime.poll();
    await vi.waitFor(async () => expect((await f.runtime.read(SID)).usage.verifiedCalls).toBe(2));
    const raised = await f.runtime.configure(SID, { limitUsd: 0.03, revision: 1 });
    await f.runtime.recheck(SID);
    expect(raised.budget.spentUsd).toBeCloseTo(0.012);
    expect(await f.runtime.allow(SID)).toBe(true);
    expect(f.pause).toHaveBeenCalledWith(SID);
  });
  it('repairs a late upstream record without allowing the earlier unknown spend', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    const next = assistant('late-upstream', 100, T + 1000);
    await fs.appendFile(f.transcript, JSON.stringify(next) + '\n');
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
    await fs.appendFile(f.log, proxy('late-request', 100, T + 1000));
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.004);
    expect(await f.runtime.allow(SID)).toBe(true);
  });
  it('does not rebill legacy copied history excluded by the global owner scan', async () => {
    const f = await fixture();
    const otherDir = path.join(f.projectsDir, 'another'); await fs.mkdir(otherDir);
    const source = { ...assistant('copied-history', 100, T - 5000), sessionId: 'another-session' };
    await fs.writeFile(path.join(otherDir, 'another-session.jsonl'), JSON.stringify(source) + '\n');
    await fs.appendFile(f.transcript, JSON.stringify(assistant('copied-history', 100, T - 1000)) + '\n');
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID); await f.runtime.poll();
    expect((await f.runtime.read(SID)).usage.verifiedCalls).toBe(1);
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.002);
  });
  it('holds history containing an assistant without a response identity', async () => {
    const f = await fixture();
    const missing = assistant('missing', 100); delete (missing.message as { id?: string }).id;
    await fs.appendFile(f.transcript, JSON.stringify(missing) + '\n');
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
  });
  it('does not replay another configured session after a peer baseline is refreshed', async () => {
    const f = await fixture();
    const otherDir = path.join(f.projectsDir, 'another'); await fs.mkdir(otherDir);
    const original = { ...assistant('legacy-copy', 100, T - 5000), sessionId: 'original-session' };
    await fs.writeFile(path.join(otherDir, 'original-session.jsonl'), JSON.stringify(original) + '\n');
    await fs.appendFile(f.transcript, JSON.stringify(assistant('legacy-copy', 100, T - 1000)) + '\n');
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    await fs.writeFile(path.join(f.projectsDir, 'example', 'peer-session.jsonl'), '');
    await f.runtime.configure('peer-session', { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck('peer-session'); await f.runtime.poll();
    expect((await f.runtime.read(SID)).usage.verifiedCalls).toBe(1);
  });
  it('does not label a removed allowance ledger as current lifetime cost', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    await f.runtime.configure(SID, { limitUsd: null, revision: 1 });
    expect((await f.runtime.read(SID)).budget).toMatchObject({ state: 'unlimited', spentUsd: null });
    expect((await f.runtime.read(SID)).usage.verifiedCostUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(true);
  });
  it('keeps upstream-only usage unknown even when every canonical response matches', async () => {
    const f = await fixture(); await fs.appendFile(f.log, proxy('canonical-missing', 200, T + 1000));
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
  });
  it('refuses a missing selected transcript rather than assuming zero spend', async () => {
    const f = await fixture(); await fs.unlink(f.transcript); await fs.writeFile(f.log, '');
    await fs.writeFile(path.join(f.projectsDir, 'example', 'another-session.jsonl'), '');
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
  });
  it('persists the source directory and rechecks after a daemon restart', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID); f.runtime.close();
    const restarted = createUsageBudgetRuntime({ dir: path.join(f.root, 'budgets'), projectsDir: f.projectsDir,
      pause: f.pause, now: () => T + 20_000, log: () => {} }); runtimes.push(restarted);
    expect(await restarted.allow(SID)).toBe(false);
    await restarted.recover();
    expect(await restarted.allow(SID)).toBe(true);
    expect((await restarted.read(SID)).budget).toMatchObject({ revision: 1, spentUsd: 0.002 });
  });
  it('does not allow a failed stop to resume after raising or removing the limit', async () => {
    const f = await fixture();
    f.pause.mockRejectedValue(new Error('Stop not confirmed'));
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect(await f.runtime.allow(SID)).toBe(false);
    expect((await f.runtime.read(SID)).budget.stopError).toContain('Stop not confirmed');
    const store = createUsageBudgets({ dir: path.join(f.root, 'budgets') });
    await store.configure(SID, { limitUsd: null, revision: 1 });
    expect(await f.runtime.allow(SID)).toBe(false);
    f.pause.mockResolvedValue();
    await f.runtime.configure(SID, { limitUsd: null, revision: 2 });
    expect((await f.runtime.read(SID)).budget.stopError).toBeNull();
  });
  it('keeps a corrupt policy held without rejecting the poll loop or blocking an unrelated session', async () => {
    const f = await fixture(); f.runtime.close();
    const dir = path.join(f.root, 'corrupt-budgets'); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, `${SID}.json`), '{broken');
    const recovered = createUsageBudgetRuntime({ dir, projectsDir: f.projectsDir, pause: f.pause, log: () => {} }); runtimes.push(recovered);
    await recovered.poll(); await recovered.recover();
    expect(await recovered.allow(SID)).toBe(false);
    expect(await recovered.allow('ordinary-session')).toBe(true);
    expect(f.pause).toHaveBeenCalledWith(SID);
  });
  it('recovers a partial canonical line only after its final bytes and upstream evidence arrive', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    const line = JSON.stringify(assistant('partial', 100, T + 1000)) + '\n';
    await fs.appendFile(f.transcript, line.slice(0, -4));
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
    await fs.appendFile(f.transcript, line.slice(-4));
    await fs.appendFile(f.log, proxy('partial-upstream', 100, T + 1000));
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.004);
    await vi.waitFor(async () => expect(await f.runtime.allow(SID)).toBe(true));
  });
  it('repairs upstream-only evidence when its delayed canonical response is finally written', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    await fs.appendFile(f.log, proxy('delayed-canonical-request', 100, T + 1000));
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    await fs.appendFile(f.transcript, JSON.stringify(assistant('delayed-canonical', 100, T + 1000)) + '\n');
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.004);
    await vi.waitFor(async () => expect(await f.runtime.allow(SID)).toBe(true));
  });
  it('does not turn a malformed final canonical response into a verified lifetime on a later poll', async () => {
    const f = await fixture();
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    await fs.appendFile(f.transcript, '{broken}\n');
    await f.runtime.poll(); await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    expect(await f.runtime.allow(SID)).toBe(false);
  });
  it('retains an already written response after the wall-clock cutoff in its lifetime baseline', async () => {
    const f = await fixture();
    await fs.appendFile(f.transcript, JSON.stringify(assistant('future-snapshot', 100, T + 10_500)) + '\n');
    await fs.appendFile(f.log, proxy('future-upstream', 100, T + 10_500));
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID); await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.004);
    expect((await f.runtime.read(SID)).usage.verifiedCalls).toBe(2);
  });
  it('retries every changed match after a partial durable write failure without double consuming upstream', async () => {
    const f = await fixture();
    const rows = [assistant('a', 100, T + 1000), assistant('c', 100, T + 2000)];
    await fs.writeFile(f.transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await fs.writeFile(f.log, proxy('p1', 100, T + 1000) + proxy('p2', 100, T + 2000));
    await f.runtime.configure(SID, { limitUsd: 0.02, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID); await f.runtime.poll();
    const next = assistant('b', 100, T);
    await fs.appendFile(f.transcript, JSON.stringify(next) + '\n');
    const original = fs.open.bind(fs); let writes = 0;
    const open = vi.spyOn(fs, 'open').mockImplementation(((file, flags, ...rest) => {
      if (String(file).endsWith(`${SID}.jsonl`) && String(file).includes(`${path.sep}budgets${path.sep}`) && typeof flags === 'number'
        && (flags & constants.O_APPEND) !== 0 && ++writes === 2) return Promise.reject(Object.assign(new Error('Transient append failure'), { code: 'EIO' }));
      return original(file, flags, ...rest);
    }) as typeof fs.open);
    try { await f.runtime.poll(); } finally { open.mockRestore(); }
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    await f.runtime.poll();
    const records = await createUsageBudgets({ dir: path.join(f.root, 'budgets') }).records(SID);
    expect(records.filter(row => row.verification === 'matched')).toHaveLength(2);
    expect(new Set(records.filter(row => row.upstream).map(row => row.upstream!.requestId)).size).toBe(2);
    expect(records.find(row => row.responseId === 'c')!.verification).toBe('unmatched');
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeNull();
    await fs.appendFile(f.log, proxy('p3', 100, T + 2000));
    await f.runtime.poll();
    expect((await f.runtime.read(SID)).budget.spentUsd).toBeCloseTo(0.006);
    await vi.waitFor(async () => expect(await f.runtime.allow(SID)).toBe(true));
  });
  it('holds incomplete or missing independent evidence without a numeric total', async () => {
    const f = await fixture(); await fs.writeFile(f.log, '');
    await f.runtime.configure(SID, { limitUsd: 0.01, revision: 0, proxyLogDir: f.proxyLogDir });
    await f.runtime.recheck(SID);
    expect(await f.runtime.allow(SID)).toBe(false);
    expect((await f.runtime.read(SID)).budget).toMatchObject({ state: 'unverified', spentUsd: null });
    await fs.writeFile(f.log, proxy('initial-upstream', 100));
    await f.runtime.recheck(SID);
    expect(await f.runtime.allow(SID)).toBe(true);
  });
});
