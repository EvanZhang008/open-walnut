import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';
import { budgetDaemonEnv, fetchWithin } from './fixtures/budget-daemon-env.js';
import { checkBudgetArtifacts, sameBytes } from './fixtures/budget-artifacts.js';
import { createCleanupLedger, within, type OwnedProcess } from './fixtures/acp-cleanup-ledger.js';
import { processGone } from './fixtures/process-identity.js';

vi.mock('../../src/constants.js', () => createMockConstants('session-budget-e2e'));
import { WALNUT_HOME, DAEMON_BINARIES_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { listLetters } from '../../src/core/human-inbox/store.js';
import { ensurePriceBook, priceThresholds } from '../../src/core/usage/price-book.js';
import { priceSessionScan } from '../../src/core/usage/session-cost.js';
import { sweepSessionBudgets } from '../../src/core/usage/session-budget.js';
import * as daemonConnections from '../../src/providers/daemon-connection.js';
import { getDaemonSource } from '../../src/providers/daemon-source.js';
import { SOURCE_TWIN } from '../helpers/source-twin.js';

const sid = 'session-budget-example';
const nonce = randomUUID();
const host = 'budget-fixture-host';
const root = path.join(WALNUT_HOME, 'budget-fixture');
const home = path.join(root, 'home');
const configDir = path.join(home, 'config');
const transcript = path.join(configDir, 'projects', 'example', sid + '.jsonl');
const logs = path.join(root, 'proxy');
const proxy = path.join(logs, 'proxy.log');
const witness = path.join(root, 'witness.jsonl');
const cleanupFile = path.join(root, 'cleanup');
const fixture = fileURLToPath(new URL('./fixtures/session-budget-cli.mjs', import.meta.url));
let daemon: ChildProcess | undefined;
let socket: WebSocket | undefined;
let base = '';
let sequence = 0;
let stderr = '';
let serverStarted = false;
const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const capabilities = new Set<string>();
/**
 * Every real process this file starts, with the proof that it is gone: the fixture
 * daemon (spawned here), the server's own local daemon (and the session host above
 * it, when the Mac has one), and each fixture CLI (from its witness line).
 */
const ledger = createCleanupLedger();
let daemonRecord: OwnedProcess | null = null;
/** Set when the fixture daemon runs but its identity could not be pinned: its cleanup can never pass. */
let daemonUnpinned = '';
const localRecords: OwnedProcess[] = [];
const cliCommand = `${fixture} --session-id ${sid}`;
async function noteClis() {
  for (const row of await rows()) if (row.event === 'ready' && row.nonce === nonce) ledger.observed(row.pid, cliCommand, 'cli');
}

function rpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Record<string, any>> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Fixture daemon is disconnected'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture daemon RPC timed out: ${cmd}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({ id, cmd, ...params }), error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
}
async function until(check: () => Promise<boolean>, description: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function rows() {
  return (await fs.readFile(witness, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function request(method: 'GET' | 'PATCH', tail = '', body?: unknown) {
  const url = `${base}/api/usage/sessions/${sid}${tail}`;
  const response = await fetchWithin(url, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(error => { throw new Error(`Budget fixture ${method} failed at ${url}`, { cause: error }); });
  return { status: response.status, body: await response.json() };
}
function startCli() {
  return rpc('start', { sid, args: [process.execPath, fixture, '--session-id', sid], cwd: home, message: '', mode: 'default',
    resume: true, origin: { home: WALNUT_HOME, task: 'budget-example-task' } });
}

beforeAll(async () => {
  const sidecar = path.join(DAEMON_BINARIES_DIR, 'usage-core.cjs');
  // No conditional skip: the artifacts must be the ones built from these sources (by hash).
  const manifest = checkBudgetArtifacts(DAEMON_BINARIES_DIR);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(transcript, '');
  await fs.writeFile(proxy, '');
  await fs.writeFile(witness, '');
  const script = path.join(root, 'daemon.cjs');
  await fs.copyFile(sidecar, path.join(root, 'usage-core.cjs'));
  if (!sameBytes(sidecar, path.join(root, 'usage-core.cjs'))) throw new Error('usage-core.cjs copy differs');
  await fs.writeFile(script, getDaemonSource());
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const env = budgetDaemonEnv(root, { walnutHome: WALNUT_HOME, extra: {
    BUDGET_FIXTURE_SID: sid, BUDGET_FIXTURE_TRANSCRIPT: transcript, BUDGET_FIXTURE_UPSTREAM_LOG: proxy,
    BUDGET_FIXTURE_WITNESS: witness, BUDGET_FIXTURE_CLEANUP: cleanupFile, BUDGET_FIXTURE_NONCE: nonce } });
  daemon = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Pinned at once: afterAll signals it only while ps still shows this very process.
  try { daemonRecord = ledger.daemonSpawned(daemon.pid!, script); }
  catch (error) { daemonUnpinned = (error as Error).message; throw error; }
  daemon.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_096); });
  daemon.on('error', error => { stderr += `\nspawn error: ${error.message}`; });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Fixture daemon boot timed out: ' + stderr.slice(-1000))), 30_000);
    daemon!.stdout?.on('data', chunk => { output += String(chunk); const match = output.match(/^\d+$/m); if (match) { clearTimeout(timer); resolve(Number(match[0])); } });
    daemon!.once('error', error => { clearTimeout(timer); reject(error); });
    daemon!.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture daemon exited before readiness: ${code}`)); });
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.on('message', raw => {
    let frame: Record<string, any>; try { frame = JSON.parse(String(raw)); } catch { return; }
    const waiter = pending.get(frame.id); if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(frame.id); waiter.resolve(frame);
  });
  socket.on('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Fixture daemon connection closed')); } pending.clear(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture daemon socket did not open')), 10_000);
    socket!.once('open', () => { clearTimeout(timer); resolve(); });
    socket!.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const hello = await rpc('hello');
  // The daemon under test is this tree's: its source carries the version the artifacts were built from.
  expect(hello.version).toBe(manifest.version);
  console.info('[budget-e2e] daemon', manifest.version, 'artifacts', JSON.stringify(manifest.files));
  for (const capability of hello.capabilities ?? []) capabilities.add(capability);
  expect(capabilities.has('budget-v2')).toBe(true);
  const connection = { connect: async () => {}, hasCapability: (name: string) => capabilities.has(name),
    send: (cmd: string, params?: Record<string, unknown>, timeout?: number) => rpc(cmd, params, timeout) };
  // Only the transport selection is replaced. Accounting, policy, persistence, RPC and HTTP are real.
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async key => {
    if (key !== host) throw new Error(`Unexpected daemon selection in budget fixture: ${key}`);
    return connection as unknown as daemonConnections.DaemonConnection;
  });
  // The pause-letter sweep visits connected hosts; this fixture's daemon stands in for the local one.
  vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockImplementation(key =>
    key === '__local__' ? connection as unknown as daemonConnections.DaemonConnection : null);
  const server = await startServer({ port: 0, dev: true });
  serverStarted = true;
  // The server starts its own local daemon (in the harness's runtime dir) and keeps its pid.
  const { localDaemon } = await import('../../src/providers/local-daemon.js');
  if (localDaemon.pid) localRecords.push(ledger.owned(localDaemon.pid, '--start', 'local-daemon'));
  // The session host (a Mac app supervising the daemon, when present) may hand over and exit: seen, not required.
  if (localDaemon.sessionHostPid) ledger.observed(localDaemon.sessionHostPid, '', 'session-host');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await createSessionRecord(sid, 'budget-example-task', 'Example', home, { host, title: 'Budget example', initialProcessStatus: 'stopped' });
  expect((await startCli()).ok).toBe(true);
  await until(async () => (await rows()).some(row => row.event === 'ready' && row.nonce === nonce), 'fixture CLI ready');
  await noteClis();
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await within(60_000, 'budget E2E cleanup', async () => {
      // Every fake CLI owns this exact nonce and self-exits. No PID read from disk is signalled.
      try {
        await fs.mkdir(root, { recursive: true });
        await fs.appendFile(witness, '');
        await noteClis();
        await fs.writeFile(cleanupFile, nonce);
        await until(async () => {
          const evidence = (await rows()).filter(row => row.nonce === nonce);
          return evidence.filter(row => row.event === 'ready').every(ready => evidence.some(row => row.event === 'exit' && row.pid === ready.pid));
        }, 'all fixture CLIs to acknowledge cleanup', 5000);
      } catch (error) { failures.push(error); }
      if (serverStarted) try { await stopServer(); } catch (error) { failures.push(error); }
      // The server leaves its local daemon running by design; this test stops it the way an
      // isolated owner does, and only while ps still shows the process the server started.
      if (localRecords.length) {
        const { localDaemon } = await import('../../src/providers/local-daemon.js');
        const daemonOfServer = localRecords.find(r => r.role === 'local-daemon');
        if (daemonOfServer && !ledger.stillOurs(daemonOfServer)) failures.push(new Error(`local daemon ${daemonOfServer.pid} is no longer the process the server started; not stopped`));
        else try { await within(10_000, 'local daemon stop', () => localDaemon.stopIfIsolated()); } catch (error) { failures.push(error); }
        try { await until(async () => localRecords.every(r => processGone(r)), 'the local daemon gone', 10_000); } catch (error) { failures.push(error); }
      }
      socket?.close();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Budget fixture finished')); } pending.clear();
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const child = daemon;
        if (!daemonRecord || !ledger.stillOurs(daemonRecord)) failures.push(new Error(`fixture daemon ${child.pid} is no longer the process this test spawned; not signalled`));
        else {
          const exit = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Fixture daemon did not exit after SIGTERM')), 8000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
          child.kill('SIGTERM');
          try { await exit; } catch (error) { failures.push(error); }
        }
      }
      try { await until(async () => !!daemonRecord && processGone(daemonRecord), 'the fixture daemon gone', 5_000); } catch (error) { failures.push(error); }
    });
  } catch (error) { failures.push(error); }
  // Whatever each step said: every process this file saw start must be proven gone.
  for (const reason of ledger.verdict()) failures.push(new Error(reason));
  if (daemonUnpinned) failures.push(new Error(`fixture daemon never pinned: ${daemonUnpinned}`));
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Budget fixture cleanup was not confirmed');
}, 90_000);

describe('session budget through the real server and owning daemon', () => {
  it('prices each response like the cost line, pauses at the limit, writes one letter, and resumes only on explicit input', async () => {
    // The fixture CLI answers each message with 1,000 Opus 5.5 output tokens: $0.02 at the bundled $20/M.
    const perResponse = 0.02;
    const initial = await request('GET');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ engine: 'claude', checkEverySec: 2 });
    expect(initial.body.budget).toMatchObject({ state: 'unlimited', spentUsd: null, revision: 0 });
    const absent = await fetchWithin(`${base}/api/usage/sessions/absent-budget-session`);
    expect(absent.status).toBe(404);
    const wrong = await rpc('usage.budget.configure', { sid, home: path.join(root, 'not-owner'), limitUsd: 0.01, revision: 0 });
    expect(wrong).toMatchObject({ ok: false, code: 'NOT_OWNED' });
    const bad = await request('PATCH', '/budget', { limitUsd: 2_000_000, revision: 0 });
    expect(bad.status).toBe(400);
    // Room for one response, not two.
    const configured = await request('PATCH', '/budget', { limitUsd: perResponse * 1.5, revision: 0 });
    expect(configured.status).toBe(200);
    expect(configured.body.budget).toMatchObject({ state: 'active', spentUsd: 0, revision: 1 });
    expect((await startCli()).ok).toBe(true);
    expect((await rpc('send', { sid, message: 'First response' })).ok).toBe(true);
    await until(async () => (await request('GET')).body.budget.spentUsd >= perResponse - 1e-9, 'first response priced');
    expect((await request('GET')).body.budget.state).toBe('active');
    expect((await rpc('send', { sid, message: 'Second response' })).ok).toBe(true);
    await until(async () => (await request('GET')).body.budget.state === 'paused', 'second response pauses the budget');
    const paused = await request('GET');
    expect(paused.body.budget).toMatchObject({ reason: 'limit', responses: 2, unpricedResponses: 0 });
    expect(paused.body.budget.spentUsd).toBeCloseTo(perResponse * 2, 10);
    expect(paused.body.budget.pauseId).toEqual(expect.any(String));
    await until(async () => { const state = await rpc('status', { sid }); const result = await request('GET'); return state.alive === false && !result.body.budget.stopError; }, 'owned CLI stop confirmation');
    expect((await rpc('send', { sid, message: 'Blocked input' })).ok).toBe(false);
    expect((await rows()).filter(row => row.event === 'user')).toHaveLength(2);
    // One letter per pause, however often the sweep runs.
    const before = (await listLetters()).letters.length;
    expect((await sweepSessionBudgets()).sent).toBe(1);
    expect((await sweepSessionBudgets()).sent).toBe(0);
    const letters = (await listLetters()).letters;
    expect(letters.length).toBe(before + 1);
    expect(letters.find(l => l.subject.includes('Budget reached'))?.subject).toContain('Budget example');
    // A host on the first budget version: this server says it needs the update and changes nothing,
    // while the host keeps enforcing what it holds.
    capabilities.delete('budget-v2');
    const old = await request('GET');
    expect(old.status).toBe(503);
    expect(old.body.code).toBe('budget_needs_upgrade');
    expect((await request('PATCH', '/budget', { limitUsd: 1, revision: 1 })).status).toBe(503);
    expect((await rpc('send', { sid, message: 'Still blocked' })).ok).toBe(false);
    capabilities.add('budget-v2');
    expect((await request('GET')).body.budget).toMatchObject({ state: 'paused', limitUsd: perResponse * 1.5, revision: 1 });
    const stale = await request('PATCH', '/budget', { limitUsd: 1, revision: 0 });
    expect(stale.status).toBe(409);
    const raised = await request('PATCH', '/budget', { limitUsd: 1, revision: 1 });
    expect(raised.status).toBe(200);
    expect(raised.body.budget).toMatchObject({ state: 'active', pauseId: null });
    const readyCount = (await rows()).filter(row => row.event === 'ready').length;
    await new Promise(resolve => setTimeout(resolve, 750));
    // Raising the limit restarts nothing.
    expect((await rpc('status', { sid })).alive).toBe(false);
    expect((await rows()).filter(row => row.event === 'ready')).toHaveLength(readyCount);
    expect((await startCli()).ok).toBe(true);
    expect((await rpc('send', { sid, message: 'Explicitly continue' })).ok).toBe(true);
    await until(async () => (await rows()).filter(row => row.event === 'user').length === 3, 'explicit next input consumed');
    await until(async () => (await request('GET')).body.budget.spentUsd >= perResponse * 3 - 1e-9, 'resumed response counted');
    const resumed = await request('GET');
    expect(resumed.body.budget).toMatchObject({ limitUsd: 1, state: 'active' });
    expect(resumed.body.budget.spentUsd).toBeCloseTo(perResponse * 3, 10);
    // The same number as the picker's cost line.
    // The same number as the picker's cost line: its scan (the daemon RPC the cost route makes) priced by its pricer.
    await ensurePriceBook();
    const thresholds = priceThresholds();
    const scanned = await rpc('usage.sessionCost', { sid, engine: 'claude', cwd: home, thresholds });
    expect(scanned.ok).toBe(true);
    const cost = await priceSessionScan(scanned.result as never, thresholds);
    expect(cost.status).toBe('priced');
    expect(cost.totalUsd).toBeCloseTo(resumed.body.budget.spentUsd, 10);
    // The real source twin + sidecar honour the day split (session-cost-day-v1): the same
    // responses, each bucket dated in the asked zone, and the undivided answer unchanged.
    expect(capabilities.has('session-cost-day-v1')).toBe(true);
    const byDay = await rpc('usage.sessionCost', { sid, engine: 'claude', cwd: home, thresholds, byDay: { timeZone: 'America/Los_Angeles' } });
    expect(byDay.ok).toBe(true);
    expect(byDay.result.byDay).toEqual({ timeZone: 'America/Los_Angeles' });
    const responses = (scan: { buckets: { responses: number }[] }) => scan.buckets.reduce((n, b) => n + b.responses, 0);
    expect(responses(byDay.result)).toBe(responses(scanned.result));
    for (const bucket of byDay.result.buckets) expect(bucket.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(scanned.result.byDay).toBeUndefined();
    for (const bucket of scanned.result.buckets) expect(bucket.day).toBeUndefined();
  }, 90_000);
});
