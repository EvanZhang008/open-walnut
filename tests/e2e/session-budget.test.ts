import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';
import { guardedPath } from '../setup/exec-guard.js';

vi.mock('../../src/constants.js', () => createMockConstants('session-budget-e2e'));
import { WALNUT_HOME, DAEMON_BINARIES_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { updateConfig } from '../../src/core/config-manager.js';
import * as daemonConnections from '../../src/providers/daemon-connection.js';
import { getDaemonSource } from '../../src/providers/daemon-source.js';

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
  const response = await fetch(url, {
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
  // No conditional skip: a missing packaged runtime is a broken budget deploy.
  await fs.access(sidecar);
  const shipped = await fs.stat(sidecar);
  for (const source of ['usage-host-core.ts', 'usage-budget-core.ts', 'usage-budget-runtime.ts', 'usage-budget-tail.ts', 'usage-budget-control.ts', 'usage-budget-persistence.ts']) {
    const changed = await fs.stat(new URL(`../../src/providers/${source}`, import.meta.url));
    if (changed.mtimeMs > shipped.mtimeMs) throw new Error('Budget sidecar is stale; build the current daemon artifacts before this E2E');
  }
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(transcript, '');
  await fs.writeFile(proxy, '');
  await fs.writeFile(witness, '');
  const script = path.join(root, 'daemon.cjs');
  await fs.copyFile(sidecar, path.join(root, 'usage-core.cjs'));
  await fs.writeFile(script, getDaemonSource());
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: '/bin/sh', PATH: guardedPath([]),
    CLAUDE_CONFIG_DIR: configDir, OPEN_WALNUT_HOME: WALNUT_HOME, OPEN_WALNUT_API_URL: 'http://127.0.0.1:9', WALNUT_SERVER_URL: 'http://127.0.0.1:9',
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'journal.jsonl'), WALNUT_RESUME_RECORD_DIR: path.join(root, 'resume-records'),
    WALNUT_DAEMON_KEEP_SESSIONS: '1', WALNUT_TURN_RETRY_ENABLED: '0',
    BUDGET_FIXTURE_SID: sid, BUDGET_FIXTURE_TRANSCRIPT: transcript, BUDGET_FIXTURE_PROXY: proxy,
    BUDGET_FIXTURE_WITNESS: witness, BUDGET_FIXTURE_CLEANUP: cleanupFile, BUDGET_FIXTURE_NONCE: nonce };
  for (const name of ['WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'WALNUT_DAEMON_PARENT_PID', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR']) delete env[name];
  daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr?.on('data', chunk => { stderr += String(chunk); });
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
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  const hello = await rpc('hello');
  for (const capability of hello.capabilities ?? []) capabilities.add(capability);
  expect(capabilities.has('budget-v1')).toBe(true);
  const connection = { connect: async () => {}, hasCapability: (name: string) => capabilities.has(name),
    send: (cmd: string, params?: Record<string, unknown>, timeout?: number) => rpc(cmd, params, timeout) };
  // Only the transport selection is replaced. Accounting, policy, persistence, RPC and HTTP are real.
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async key => {
    if (key !== host) throw new Error(`Unexpected daemon selection in budget fixture: ${key}`);
    return connection as unknown as daemonConnections.DaemonConnection;
  });
  await updateConfig({ usage: { proxy_log_dirs: { [host]: logs } } });
  const server = await startServer({ port: 0, dev: true });
  serverStarted = true;
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await createSessionRecord(sid, 'budget-example-task', 'Example', home, { host, title: 'Budget example', initialProcessStatus: 'stopped' });
  expect((await startCli()).ok).toBe(true);
  await until(async () => (await rows()).some(row => row.event === 'ready' && row.nonce === nonce), 'fixture CLI ready');
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  // Every fake CLI owns this exact nonce and self-exits. No PID read from disk is signalled.
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.appendFile(witness, '');
    await fs.writeFile(cleanupFile, nonce);
    await until(async () => {
      const evidence = (await rows()).filter(row => row.nonce === nonce);
      return evidence.filter(row => row.event === 'ready').every(ready => evidence.some(row => row.event === 'exit' && row.pid === ready.pid));
    }, 'all fixture CLIs to acknowledge cleanup', 5000);
  } catch (error) { failures.push(error); }
  if (serverStarted) try { await stopServer(); } catch (error) { failures.push(error); }
  socket?.close();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Budget fixture finished')); } pending.clear();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const child = daemon;
    const exit = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture daemon did not exit after SIGTERM')), 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    child.kill('SIGTERM');
    try { await exit; } catch (error) { failures.push(error); }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Budget fixture cleanup was not confirmed');
}, 20_000);

describe('session budget through the real server and owning daemon', () => {
  it('reports unknown cost, enforces verified evidence, rejects conflicts, and resumes only on explicit input', async () => {
    const initial = await request('GET');
    expect(initial.status).toBe(200);
    expect(initial.body.budget).toMatchObject({ state: 'unlimited', spentUsd: null, revision: 0 });
    expect(initial.body.verifiedCostUsd).toBeNull();
    const absent = await fetch(`${base}/api/usage/sessions/absent-budget-session`);
    expect(absent.status).toBe(404);
    const wrong = await rpc('usage.budget.configure', { sid, home: path.join(root, 'not-owner'), limitUsd: 0.01, revision: 0, proxyLogDir: logs });
    expect(wrong).toMatchObject({ ok: false, code: 'NOT_OWNED' });
    const configured = await request('PATCH', '/budget', { limitUsd: 0.01, revision: 0 });
    expect(configured.status).toBe(200);
    await until(async () => { const result = await request('GET'); return result.status === 200 && result.body.budget.state === 'active'; }, 'empty evidence budget active');
    const empty = await request('GET');
    expect(empty.body.budget.spentUsd).toBe(0);
    expect((await startCli()).ok).toBe(true);
    const delivered = await rpc('send', { sid, message: 'Produce one controlled response' });
    expect(delivered.ok).toBe(true);
    await until(async () => { const result = await request('GET'); return result.status === 200 && result.body.budget.state === 'paused'; }, 'verified response pauses budget');
    const paused = await request('GET');
    expect(paused.body.budget.spentUsd).toBeCloseTo(0.02, 10);
    expect(paused.body.verifiedCostUsd).toBeCloseTo(0.02, 10);
    await until(async () => { const state = await rpc('status', { sid }); const result = await request('GET'); return state.alive === false && !result.body.budget.stopError; }, 'owned CLI stop confirmation');
    expect((await rpc('send', { sid, message: 'Blocked input' })).ok).toBe(false);
    expect((await rows()).filter(row => row.event === 'user')).toHaveLength(1);
    const stale = await request('PATCH', '/budget', { limitUsd: 0.1, revision: 0 });
    expect(stale.status).toBe(409);
    const raised = await request('PATCH', '/budget', { limitUsd: 0.1, revision: 1 });
    expect(raised.status).toBe(200);
    await until(async () => (await request('GET')).body.budget.state === 'active', 'raised allowance active');
    const readyCount = (await rows()).filter(row => row.event === 'ready').length;
    await new Promise(resolve => setTimeout(resolve, 750));
    expect((await rpc('status', { sid })).alive).toBe(false);
    expect((await rows()).filter(row => row.event === 'ready')).toHaveLength(readyCount);
    expect((await rows()).filter(row => row.event === 'user')).toHaveLength(1);
    expect((await startCli()).ok).toBe(true);
    expect((await rpc('send', { sid, message: 'Explicitly continue' })).ok).toBe(true);
    await until(async () => (await rows()).filter(row => row.event === 'user').length === 2, 'explicit next input consumed');
    await until(async () => (await request('GET')).body.budget.spentUsd >= 0.04, 'resumed response included in lifetime evidence');
    const resumed = await request('GET');
    expect(resumed.body.budget.limitUsd).toBe(0.1);
    expect(resumed.body.budget.state).toBe('active');
    expect(resumed.body.budget.spentUsd).toBeCloseTo(0.04, 10);
  }, 60_000);
});
