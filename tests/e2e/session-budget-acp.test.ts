/**
 * Session budgets on an ACP engine (Codex), through a REAL daemon of each twin
 * with its sidecars, the real ACP worker, and the scripted mock ACP agent as the
 * adapter. The test plays Codex's part of writing the rollout file the budget
 * reads (one token_count line per model call). No model, no real CLI, no SSH:
 * the daemon gets only budgetDaemonEnv, every directory under one scratch root.
 *
 * Covers: a turn that takes the session over pauses it at the turn's end (not
 * at the next interval), stops the worker and refuses its next turn; a worker
 * started again for the same session (a new runtime id) is refused from its
 * first turn; raising the limit lets the next turn through; a thread started
 * over under a new provider id keeps its budget and its spend; a daemon
 * restart keeps every budget and carries a first-version budget over.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { processGone } from './fixtures/process-identity.js';
import { createCleanupLedger, within, type OwnedProcess } from './fixtures/acp-cleanup-ledger.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaemonSource } from '../../src/providers/daemon-source.js';
import { budgetDaemonEnv, stderrTail } from './fixtures/budget-daemon-env.js';
import { checkBudgetArtifacts, sameBytes } from './fixtures/budget-artifacts.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN_DIR = path.join(REPO_ROOT, 'dist/daemon-binaries');
const DAEMON_BIN = path.join(BIN_DIR, 'daemon-darwin-arm64');
const WORKER_BUNDLE = path.join(BIN_DIR, 'acp-worker.js');
const MOCK_AGENT = path.join(REPO_ROOT, 'tests/providers/mock-acp-agent.mjs');

const PRICES = { hash: 'acp-e2e', snapshot: { source: 'litellm', url: '', fetchedAt: '2026-10-23T00:00:00.000Z', models: {
  'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } } } };
const HOME_TAG = '/acp-budget-e2e-home';
/** A shared parent the harness reaper never removes (NEVER_OURS in tests/setup/tmp-reaper.ts): a root kept after a failed cleanup stays for a look. */
const ROOT_PARENT = path.join(os.tmpdir(), 'walnut-budget-e2e');

function sourceDaemonScript(dir: string): string {
  fs.writeFileSync(path.join(dir, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 });
  for (const sidecar of ['acp-daemon-core.cjs', 'usage-core.cjs']) {
    fs.copyFileSync(path.join(BIN_DIR, sidecar), path.join(dir, sidecar));
    if (!sameBytes(path.join(BIN_DIR, sidecar), path.join(dir, sidecar))) throw new Error(`${sidecar} copy differs`);
  }
  return path.join(dir, 'daemon.cjs');
}

// Both twins, always: a missing or stale artifact fails here instead of skipping a twin.
const TWINS: Array<{ name: string; command: (dir: string) => [string, string[]] }> = [
  { name: 'source daemon + sidecars', command: dir => [process.execPath, [sourceDaemonScript(dir), '--start']] },
  { name: 'real binary', command: () => [DAEMON_BIN, ['--start']] },
];

for (const twin of TWINS) describe(`ACP session budget (${twin.name})`, () => {
  let root = '';
  let proc: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  let rpcId = 0;
  const pushed: Array<Record<string, unknown>> = [];
  let command: [string, string[]];

  let stderr = stderrTail();
  /** Everything this test started, and the proof it is gone (tests/e2e/fixtures/acp-cleanup-ledger.ts). */
  const ledger = createCleanupLedger();
  let daemonRecord: OwnedProcess | null = null;
  /** Set when the cleanup's deadline passed: work still running after it may observe, never signal or remove. */
  let abandoned = false;
  let witnessRead = 0;
  const witnessLines = (): Array<{ pid: number; ppid: number }> => {
    const file = path.join(root, 'acp-witness.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  };
  /** A start that spawned a worker must show its adapter (and through it the worker) within the bound; else it stays unproven. */
  async function recordProcesses(sid: string): Promise<void> {
    try { await until(() => witnessLines().length > witnessRead, `the adapter of ${sid} to report`, 15_000); }
    catch (error) { ledger.spawned(sid, [], { adapter: MOCK_AGENT, worker: WORKER_BUNDLE }); throw error; }
    const lines = witnessLines();
    const fresh = lines.slice(witnessRead);
    witnessRead = lines.length;
    ledger.spawned(sid, fresh, { adapter: MOCK_AGENT, worker: WORKER_BUNDLE });
  }
  async function startDaemon(): Promise<void> {
    const env = budgetDaemonEnv(root, { extra: { MOCK_ACP_FAIL_LOAD_FILE: path.join(root, 'fail-next-load'), MOCK_ACP_WITNESS: path.join(root, 'acp-witness.jsonl') } });
    stderr = stderrTail();
    const p = spawn(command[0], command[1], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    if (!p.pid) throw new Error('daemon did not spawn: ' + stderr.text);
    daemonRecord = null;
    // Between the spawn and this record there is a live child with no proof of identity: if the record
    // fails, the start is unproven (the root is kept) and stopDaemon will not signal it.
    try { daemonRecord = ledger.daemonSpawned(p.pid, path.basename(command[1][0] === '--start' ? command[0] : command[1][0])); }
    catch (error) { ledger.unknown(`daemon ${p.pid}`, `its identity could not be recorded: ${(error as Error).message}`); throw error; }
    p.stderr!.on('data', chunk => stderr.push(chunk));
    p.on('error', error => stderr.push(`\nspawn error: ${error.message}`));
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon spawn timeout: ' + stderr.text)), 30_000);
      p.stdout!.on('data', (chunk: Buffer) => { const m = chunk.toString().match(/^\d+$/m); if (m) { clearTimeout(timer); resolve(Number(m[0])); } });
      p.once('error', error => { clearTimeout(timer); reject(error); });
      p.once('exit', code => { clearTimeout(timer); reject(new Error(`daemon exited early (${code}): ${stderr.text}`)); });
    });
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon socket did not open')), 10_000);
      ws!.once('open', () => { clearTimeout(timer); resolve(); });
      ws!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    ws.on('message', raw => { try { const msg = JSON.parse(String(raw)); if (msg.ev) pushed.push(msg); } catch { /* not a frame */ } });
  }
  /** SIGTERM the daemon this test spawned and wait for it to really exit (throws when it does not). */
  async function stopDaemon(): Promise<void> {
    ws?.close(); ws = null;
    const p = proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) { proc = null; return; }
    const exit = new Promise<boolean>(resolve => p.once('exit', () => resolve(true)));
    // Signal only the process this test spawned, as ps still shows it, and never after the cleanup gave up.
    if (abandoned) throw new Error(`cleanup deadline passed; daemon ${p.pid} not signalled`);
    if (!daemonRecord || !ledger.stillOurs(daemonRecord)) throw new Error(`daemon ${p.pid} is no longer the process this test spawned; not signalled`);
    p.kill('SIGTERM');
    const exited = await Promise.race([exit, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
    if (!exited) throw new Error(`daemon ${p.pid} did not exit after SIGTERM: ${stderr.text}`);
    await until(() => !!daemonRecord && processGone(daemonRecord), `daemon ${p.pid} gone`, 5_000);
    proc = null;
  }
  /** Stop one ACP worker this test started: the daemon says so, and its worker and adapter processes are gone. */
  async function stopWorker(sid: string): Promise<void> {
    const stopped = await rpc('acpStop', { sid }, 5_000);
    if (!stopped.ok) throw new Error(`acpStop ${sid}: ${JSON.stringify(stopped)}`);
    await until(async () => { const state = await rpc('acpState', { sid }, 3_000); return state.ok === false && state.errorKind === 'no_worker'; },
      `acpState ${sid} to say no_worker`, 5_000);
    // The daemon forgets a worker before its process is gone: wait for the processes themselves (never true for an unproven start).
    await until(() => ledger.allGone(sid), `worker and adapter of ${sid} exited`, 10_000);
  }
  function rpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, any>> {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws?.off('message', onMsg); reject(new Error(`rpc timeout: ${cmd}`)); }, timeoutMs);
      const onMsg = (raw: Buffer) => {
        let msg: Record<string, any>; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMsg); resolve(msg); }
      };
      ws!.on('message', onMsg);
      ws!.send(JSON.stringify({ cmd, id, ...params }));
    });
  }
  async function until(check: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`Timed out waiting for ${what}`);
  }
  async function start(sid: string, extra: Record<string, unknown> = {}) {
    ledger.created(sid);
    let resp: Record<string, any>;
    try {
      resp = await rpc('acpStart', {
        sid, cwd: path.join(root, 'work'), workerCmd: [process.execPath, WORKER_BUNDLE], adapterCmd: [process.execPath, MOCK_AGENT], ...extra });
    } catch (error) { ledger.unknown(sid, `acpStart did not answer: ${(error as Error).message}`); throw error; }
    // A refusal other than these two is made before any worker is spawned (budget, bad params).
    if (!resp.ok && resp.errorKind !== 'load_failed' && resp.errorKind !== 'budget_paused' && resp.code !== 'BUDGET_PAUSED') {
      ledger.unknown(sid, `acpStart failed in a way that may have spawned: ${JSON.stringify(resp)}`);
    }
    // Started, or started and then failed to load its thread: either way a worker and an adapter run.
    if (resp.ok || resp.errorKind === 'load_failed') await recordProcesses(sid);
    return resp;
  }
  const turnEnded = (sid: string, after: number) => pushed.slice(after).some(f => f.ev === 'jsonl' && f.sid === sid
    && typeof f.line === 'string' && /"turn-ended"/.test(f.line as string));
  const budget = async (sid: string) => (await rpc('usage.budget.get', { sid, engine: 'codex', home: HOME_TAG })).result.budget;
  // Codex's own record of its model calls: $1.00 each at $2 / 1M input tokens.
  let total = 0;
  function rollout(providerId: string): string { return path.join(root, 'home', 'codex', 'sessions', `rollout-2026-10-23T00-00-00-${providerId}.jsonl`); }
  function codexCall(providerId: string): void {
    const file = rollout(providerId);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-10-23T00:00:00.000Z', type: 'turn_context', payload: { model: 'openai.gpt-6.1-sol' } }) + '\n');
    total += 500_000;
    fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-10-23T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 0 } } } }) + '\n');
  }

  let providerId = '';
  beforeAll(async () => {
    fs.mkdirSync(ROOT_PARENT, { recursive: true, mode: 0o700 });
    root = fs.mkdtempSync(path.join(ROOT_PARENT, 'acp-'));
    for (const dir of ['tmp', 'work', 'daemon', 'streams', 'home/codex/sessions', 'home/config/projects', 'twin']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const manifest = checkBudgetArtifacts(BIN_DIR);
    command = twin.command(path.join(root, 'twin'));
    await startDaemon();
    const hello = await rpc('hello');
    expect(hello.version).toBe(manifest.version);
    expect(hello.capabilities).toEqual(expect.arrayContaining(['budget-v2', 'acpStart', 'acpSend']));
  }, 60_000);
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await within(100_000, 'ACP budget cleanup', async () => {
        if (ws) for (const sid of ledger.sids()) {
          if (abandoned) return;
          try { await stopWorker(sid); } catch (error) { failures.push(error); }
        }
        else if (ledger.sids().length) failures.push(new Error(`no daemon connection to stop ${ledger.sids().join(', ')}`));
        if (abandoned) return;
        try { await stopDaemon(); } catch (error) { failures.push(error); }
      });
    } catch (error) { abandoned = true; failures.push(error); }
    // Whatever the daemon said, every process this test saw start must be proven gone, and every start proven at all.
    for (const reason of ledger.verdict()) failures.push(new Error(reason));
    // A directory a live process may still use is kept for a look, never removed under it.
    if (failures.length) throw new AggregateError(failures, `ACP budget cleanup not proven; kept ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('pauses at the end of the turn that went over, and refuses the next turn', async () => {
    const started = await start('rt-1');
    expect(started.ok).toBe(true);
    providerId = started.session.sessionId;
    codexCall(providerId);
    const set = await rpc('usage.budget.configure', { sid: providerId, engine: 'codex', runtimeId: 'rt-1', limitUsd: 1.5, revision: 0, home: HOME_TAG, prices: PRICES });
    expect(set.ok).toBe(true);
    expect(set.result.budget).toMatchObject({ state: 'active', spentUsd: 1, responses: 1 });
    // A turn during which Codex makes its second call: the turn is held until the call is on disk.
    const gate = path.join(root, 'gate-1');
    const mark = pushed.length;
    expect((await rpc('acpSend', { sid: 'rt-1', budgetSid: providerId, commandId: 'c1', walnutMessageId: 'qm-1', text: `lifecycle-gate ${gate}` })).ok).toBe(true);
    codexCall(providerId);
    fs.writeFileSync(gate, '');
    await until(() => turnEnded('rt-1', mark), 'turn end');
    const endedAt = Date.now();
    await until(async () => (await budget(providerId)).state === 'paused', 'pause after the turn');
    // Decided by the turn's end, well inside Codex's 5 s interval.
    expect(Date.now() - endedAt).toBeLessThan(4_000);
    expect(await budget(providerId)).toMatchObject({ reason: 'limit', spentUsd: 2, stopError: null, pauseId: expect.any(String) });
    await until(async () => (await rpc('acpState', { sid: 'rt-1' })).ok === false, 'worker stopped');
    const refused = await rpc('acpSend', { sid: 'rt-1', budgetSid: providerId, commandId: 'c2', walnutMessageId: 'qm-2', text: 'more' });
    expect(refused).toMatchObject({ ok: false, errorKind: 'budget_paused', code: 'BUDGET_PAUSED' });
  }, 60_000);

  it('refuses the first turn of a worker started again, until the limit is raised', async () => {
    const pauseId = (await budget(providerId)).pauseId;
    expect((await start('rt-2', { providerSessionId: providerId })).ok).toBe(true);
    // Bound at its start: refused with and without the session named.
    expect(await rpc('acpSend', { sid: 'rt-2', commandId: 'c3', walnutMessageId: 'qm-3', text: 'hi' })).toMatchObject({ ok: false, errorKind: 'budget_paused' });
    expect(await rpc('acpSend', { sid: 'rt-2', budgetSid: providerId, commandId: 'c4', walnutMessageId: 'qm-4', text: 'hi' })).toMatchObject({ ok: false, errorKind: 'budget_paused' });
    expect((await budget(providerId)).pauseId).toBe(pauseId);
    const raised = await rpc('usage.budget.configure', { sid: providerId, engine: 'codex', limitUsd: 10, revision: 1, home: HOME_TAG });
    expect(raised.result.budget).toMatchObject({ state: 'active', limitUsd: 10, pauseId: null });
    const mark = pushed.length;
    expect((await rpc('acpSend', { sid: 'rt-2', budgetSid: providerId, commandId: 'c5', walnutMessageId: 'qm-5', text: 'go on' })).ok).toBe(true);
    await until(() => turnEnded('rt-2', mark), 'turn end on the new worker');
    await stopWorker('rt-2');
  }, 60_000);

  it('keeps the budget and its spend when the thread is started over under a new id', async () => {
    fs.writeFileSync(path.join(root, 'fail-next-load'), '');
    const resumed = await start('rt-3', { providerSessionId: providerId });
    expect(resumed).toMatchObject({ ok: false, errorKind: 'load_failed' });
    const fresh = await rpc('acpNewSession', { sid: 'rt-3', cwd: path.join(root, 'work') });
    expect(fresh.ok).toBe(true);
    const nextId = fresh.result.sessionId ?? fresh.result.session?.sessionId;
    expect(nextId).toBeTruthy();
    expect(nextId).not.toBe(providerId);
    codexCall(nextId);
    const mark = pushed.length;
    expect((await rpc('acpSend', { sid: 'rt-3', budgetSid: nextId, commandId: 'c6', walnutMessageId: 'qm-6', text: 'new thread' })).ok).toBe(true);
    await until(() => turnEnded('rt-3', mark), 'turn end on the new thread');
    expect(await budget(nextId)).toMatchObject({ limitUsd: 10, spentUsd: 3, state: 'active' });
    expect((await budget(providerId)).state).toBe('unlimited');
    providerId = nextId;
  }, 60_000);

  it('keeps every budget across a daemon restart, and carries a first-version budget over', async () => {
    const budgets = path.join(root, 'usage-budgets');
    const legacy = 'legacy-claude-session';
    fs.mkdirSync(budgets, { recursive: true });
    fs.writeFileSync(path.join(budgets, `${legacy}.json`), JSON.stringify({ version: 2, journal: `${legacy}.jsonl` }));
    fs.writeFileSync(path.join(budgets, `${legacy}.jsonl`), JSON.stringify({ version: 2, sequence: 1, updatedAt: '2026-10-20T00:00:00.000Z', kind: 'policy', policy: { limitUsd: 7, revision: 3 } }) + '\n');
    await stopWorker('rt-3');
    await stopDaemon();
    await startDaemon();
    expect(await budget(providerId)).toMatchObject({ limitUsd: 10, spentUsd: 3 });
    const listed = await rpc('usage.budget.list', { home: HOME_TAG });
    const carried = listed.result.budgets.find((b: { sid: string }) => b.sid === legacy);
    expect(carried).toMatchObject({ limitUsd: 7, revision: 3, engine: 'claude' });
    // The first version's files stay for a rollback.
    expect(fs.existsSync(path.join(budgets, `${legacy}.jsonl`))).toBe(true);
    expect(listed.result.budgets.map((b: { sid: string }) => b.sid).sort()).toEqual([legacy, providerId].sort());
    expect(listed.result.pricesHash).toBe('acp-e2e');
  }, 60_000);
});
