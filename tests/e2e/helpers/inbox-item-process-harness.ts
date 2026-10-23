import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { REQUIRED_DAEMON_CAPABILITIES } from '../../../src/providers/daemon-capabilities.js';
import { guardedPath } from '../../setup/exec-guard-core.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BOOT = path.join(ROOT, 'tests/e2e/fixtures/inbox-item-api-child.ts');
export type Json = Record<string, any>;
export type Reply = { status: number; body: Json };
type Lane = { dir: string; data: string; home: string; runtime: string; proc?: ChildProcess; port: number };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const running = (proc: ChildProcess) => proc.exitCode === null && proc.signalCode === null;

/** Signals only a child handle created here. No pid files, process scans, groups or SIGKILL. */
async function stopChild(proc: ChildProcess): Promise<void> {
  if (!running(proc)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(term); clearTimeout(deadline); resolve(); };
    const term = setTimeout(() => { if (running(proc)) proc.kill('SIGTERM'); }, 10_000);
    const deadline = setTimeout(() => {
      proc.off('exit', finish);
      reject(new Error('Fixture child did not exit after its own SIGTERM; keeping its temp directory'));
    }, 20_000);
    proc.once('exit', finish);
    proc.kill('SIGTERM');
  });
}

export async function eventually<T>(read: () => Promise<T | false>, what: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try { const value = await read(); if (value !== false) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** All URLs are constructed from a port this fixture received from listen(0). */
export async function request(port: number, method: string, route: string, body?: unknown, headers: Record<string, string> = {}, loseResponse = false): Promise<Reply> {
  if (!Number.isInteger(port) || port <= 0 || port === 3456) throw new Error('Refusing non-fixture port');
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
      headers: { ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}),
        ...(loseResponse ? { 'x-fixture-lose-response': '1' } : {}) } }, res => {
      const parts: Buffer[] = [];
      res.on('data', part => parts.push(Buffer.from(part)));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Fixture HTTP deadline')));
    req.on('error', reject);
    req.end(bytes);
  });
}

export class InboxItemProcessHarness {
  base = '';
  primary!: Lane;
  replica!: Lane;
  readonly phoneToken = randomBytes(16).toString('hex');
  readonly bridgeToken = randomBytes(16).toString('hex');
  readonly commands: Json[] = [];
  readonly relays: string[] = [];
  private children: ChildProcess[] = [];
  private daemon?: WebSocketServer;
  private bridge?: WebSocket;
  private daemonPort = 0;
  private nextRelay = 0;
  private pending = new Map<number, { id: number; ws: WebSocket; timer: NodeJS.Timeout }>();
  private sessions = new Map<string, { proc: ChildProcess; stream: string; lines: string[]; clients: Set<WebSocket> }>();
  private holdNextStart = false;
  private heldStart?: { ws: WebSocket; cmd: Json };
  private cancelledStarts = new Set<string>();
  readonly spawnedSessionIds: string[] = [];
  readonly rejectedStarts: Array<{ sid: string; cancelled: true }> = [];
  private cli = '';
  logs = '';

  async start(): Promise<void> {
    this.base = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-inbox-item-process-'));
    for (const name of ['primary', 'replica'] as const) {
      const dir = path.join(this.base, name);
      const lane: Lane = { dir, data: path.join(dir, 'data'), home: path.join(dir, 'home'), runtime: path.join(dir, 'daemon'), port: 0 };
      this[name] = lane;
      for (const folder of [lane.data, lane.home, lane.runtime, path.join(lane.runtime, 'streams'), path.join(dir, 'tmp'), path.join(dir, 'bin')]) await fs.mkdir(folder, { recursive: true });
      for (const command of ['claude', 'ssh', 'git']) await fs.writeFile(path.join(dir, 'bin', command), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
      await fs.writeFile(path.join(lane.data, 'config.yaml'), JSON.stringify({ version: 1, user: { name: 'Tester' }, defaults: { priority: 'none', platform: 'local' }, hosts: {}, plugins: {}, plugin_sources: [], hooks: { enabled: false }, provider: { type: 'claude-code' }, agent: { provider: 'claude-code' } }));
      await fs.writeFile(path.join(lane.data, 'auth.json'), JSON.stringify({ devices: [
        { name: 'fixture-phone', tokenHash: this.hash(this.phoneToken), createdAt: new Date().toISOString() },
        { name: 'bridge-local', kind: 'machine', tokenHash: this.hash(this.bridgeToken), createdAt: new Date().toISOString() },
      ] }), { mode: 0o600 });
    }
    // The CLI records ACCEPTED user lines, not daemon sends or successful HTTP replies.
    this.cli = path.join(this.base, 'fixture-cli.cjs');
    await fs.writeFile(this.cli, `const fs=require('node:fs'),crypto=require('node:crypto');
const sid=process.argv[2],accepted=process.argv[3];
const out=o=>process.stdout.write(JSON.stringify({...o,session_id:sid})+'\\n');
out({type:'system',subtype:'init',cwd:process.cwd(),model:'mock-model',tools:[],mcp_servers:[],permissionMode:'default'});
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk.toString();let nl;while((nl=buffer.indexOf('\\n'))>=0){const raw=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let m;try{m=JSON.parse(raw)}catch{continue}
if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id}});continue}if(m.type!=='user')continue;
const text=m.message.content;fs.appendFileSync(accepted,JSON.stringify({sid,uuid:m.uuid,text})+'\\n');
if(m.uuid)out({type:'command_lifecycle',command_uuid:m.uuid,state:'started'});
out({type:'system',subtype:'session_state_changed',state:'running'});
out({type:'assistant',message:{id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',model:'mock-model',content:[{type:'text',text:'Fixture accepted'}]}});
out({type:'result',subtype:'success',is_error:false,result:'Fixture accepted',usage:{input_tokens:1,output_tokens:1},num_turns:1,total_cost_usd:0});
if(m.uuid)out({type:'command_lifecycle',command_uuid:m.uuid,state:'completed'});out({type:'system',subtype:'session_state_changed',state:'idle'});}});
`);
    this.daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => { this.daemon!.once('listening', resolve); this.daemon!.once('error', reject); });
    this.daemonPort = (this.daemon.address() as { port: number }).port;
    this.daemon.on('connection', ws => ws.on('message', data => { void this.command(ws, JSON.parse(data.toString())).catch(error => this.send(ws, { id: JSON.parse(data.toString()).id, ok: false, error: String(error) })); }));
    await this.boot(this.replica, true);
    await this.boot(this.primary, false);
    this.bridge = new WebSocket(`ws://127.0.0.1:${this.replica.port}/bridge`, { headers: { Authorization: `Bearer ${this.bridgeToken}` } });
    this.bridge.on('error', error => { this.logs += `\nbridge: ${String(error)}`; });
    this.bridge.on('message', data => { void this.command(this.bridge!, JSON.parse(data.toString())).catch(error => { this.logs += `\nbridge command: ${String(error)}`; }); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture bridge open deadline')), 10_000);
      this.bridge!.once('open', () => { clearTimeout(timer); this.send(this.bridge!, { ev: 'hello', hostAlias: '__local__', version: 'fixture', instanceId: 'inbox-fixture', capabilities: ['session.control'] }); resolve(); });
      this.bridge!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await eventually(async () => (await this.control(this.replica, 'state')).body.bridgeConnected === true || false, 'the authenticated replica bridge');
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private env(lane: Lane, cloud = false): NodeJS.ProcessEnv {
    // Allowlist, not an inherited environment: no GIT_*, provider secrets, prod URLs or runtime paths.
    return { PATH: guardedPath([path.join(lane.dir, 'bin')], '/usr/bin:/bin'), HOME: lane.home, USERPROFILE: lane.home,
      TMPDIR: path.join(lane.dir, 'tmp'), SHELL: '/bin/sh', NODE_ENV: 'test', VITEST: '1',
      OPEN_WALNUT_HOME: lane.data, OPEN_WALNUT_API_URL: 'http://127.0.0.1:0',
      CLAUDE_CONFIG_DIR: path.join(lane.home, '.claude'), WALNUT_CLOUD_MODE: cloud ? '1' : '0',
      WALNUT_DAEMON_DIR: lane.runtime, WALNUT_STREAMS_DIR: path.join(lane.runtime, 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(lane.runtime, 'legacy-streams'), WALNUT_SPAWN_JOURNAL: path.join(lane.runtime, 'spawn-journal.jsonl'),
      WALNUT_GIT_HUB_DIR: path.join(lane.dir, 'hub'), WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1',
      WALNUT_STALL_RECORDER: '0', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_BRIDGE_BLIP_GRACE_MS: '0',
      FIXTURE_DAEMON_URL: `ws://127.0.0.1:${this.daemonPort}`, FIXTURE_ROOT: lane.dir };
  }
  private async boot(lane: Lane, cloud: boolean): Promise<void> {
    // bun runs the TypeScript boot script as it is.
    const proc = spawn(process.execPath, [BOOT], { cwd: lane.dir, env: this.env(lane, cloud), stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.push(proc); lane.proc = proc;
    proc.stderr!.on('data', chunk => { this.logs = (this.logs + chunk.toString()).slice(-30_000); });
    lane.port = await new Promise<number>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`API child boot deadline\n${this.logs}`)), 90_000);
      proc.stdout!.on('data', chunk => { text += chunk.toString(); const match = /FIXTURE_PORT=(\d+)/.exec(text); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      proc.once('error', error => { clearTimeout(timer); reject(error); });
      proc.once('exit', code => { clearTimeout(timer); reject(new Error(`API child exited ${code}\n${this.logs}`)); });
    });
  }
  async stopPrimary(): Promise<void> { if (this.primary.proc) await stopChild(this.primary.proc); }
  async restartPrimary(): Promise<void> { await this.stopPrimary(); await this.boot(this.primary, false); }
  async bringPrimaryBack(): Promise<void> { await this.boot(this.primary, false); }
  local(method: string, route: string, body?: unknown): Promise<Reply> { return request(this.primary.port, method, `/api/v1${route}`, body); }
  phone(method: string, route: string, body?: unknown, primary = false, loseResponse = false): Promise<Reply> {
    return request(primary ? this.primary.port : this.replica.port, method, `/api/v1${route}`, body,
      { Authorization: `Bearer ${this.phoneToken}`, 'x-forwarded-for': '192.0.2.10', 'x-walnut-origin': '__local__' }, loseResponse);
  }
  control(lane: Lane, action: string, body?: unknown): Promise<Reply> { return request(lane.port, body === undefined ? 'GET' : 'POST', `/fixture/${action}`, body); }
  hold(kind: 'task_create' | 'task_start'): Promise<Reply> { return this.control(this.primary, 'hold', { kind }); }
  holdDaemonStart(): void {
    if (this.holdNextStart || this.heldStart) throw new Error('A fixture start is already held');
    this.holdNextStart = true;
  }
  heldDaemonStart(): Json | undefined { return this.heldStart && { ...this.heldStart.cmd }; }
  async releaseDaemonStart(): Promise<void> {
    const held = this.heldStart;
    if (!held) throw new Error('No fixture start is held');
    this.heldStart = undefined;
    await this.command(held.ws, held.cmd);
  }
  async copyInbox(): Promise<void> { await fs.cp(path.join(this.primary.data, 'human-inbox'), path.join(this.replica.data, 'human-inbox'), { recursive: true }); }
  async accepted(): Promise<Json[]> {
    try { return (await fs.readFile(path.join(this.base, 'accepted.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private send(ws: WebSocket, message: Json): void { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
  private emit(session: { clients: Set<WebSocket> }, event: Json): void { for (const ws of session.clients) this.send(ws, event); }

  private async command(ws: WebSocket, cmd: Json): Promise<void> {
    const ok = (body: Json = {}) => this.send(ws, { id: cmd.id, ok: true, ...body });
    const fail = (error: string) => this.send(ws, { id: cmd.id, ok: false, error });
    this.commands.push({ ...cmd });
    switch (cmd.cmd) {
      case 'hello': return ok({ version: 'fixture', capabilities: [...REQUIRED_DAEMON_CAPABILITIES, 'cancel-pending-start-v1'], instanceId: 'inbox-fixture' });
      case 'ping': return ok({ pong: true });
      case 'bridge.peer': case 'bridge.configure': case 'skill.sync': case 'leader.configure': return ok();
      case 'session.control': {
        this.relays.push(String(cmd.action));
        const target = [...(this.daemon?.clients ?? [])].find(client => client.readyState === WebSocket.OPEN);
        if (!target) return fail('session.control: no primary server connected');
        const relayId = ++this.nextRelay;
        const timer = setTimeout(() => { this.pending.delete(relayId); fail('session.control: primary server timed out'); }, 7_000);
        this.pending.set(relayId, { ws, id: cmd.id, timer });
        this.send(target, { ev: 'control-request', relayId, action: cmd.action, sessionId: cmd.sessionId, params: cmd.params });
        return;
      }
      case 'control-result': {
        const pending = this.pending.get(cmd.relayId);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(cmd.relayId); this.send(pending.ws, { id: pending.id, ok: !cmd.error, ...(cmd.error ? { error: cmd.error, errorKind: cmd.errorKind, errorCode: cmd.errorCode } : { result: cmd.result }) }); }
        return ok();
      }
      case 'cancelPendingStart': {
        if (typeof cmd.sid !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(cmd.sid)) return fail('Invalid fixture cancellation');
        const session = this.sessions.get(cmd.sid);
        if (session && running(session.proc)) return ok({ alive: true, cancelled: false });
        this.cancelledStarts.add(cmd.sid);
        return ok({ alive: false, cancelled: true });
      }
      case 'start': {
        if (!/^[A-Za-z0-9-]+$/.test(cmd.sid)) return fail('Invalid fixture session');
        if (!path.resolve(cmd.cwd).startsWith(this.primary.data + path.sep)) return fail('Cwd outside fixture data');
        if (this.cancelledStarts.has(cmd.sid)) {
          this.rejectedStarts.push({ sid: cmd.sid, cancelled: true });
          return fail('Initial start was cancelled; retry task_start on the same task');
        }
        if (this.holdNextStart) {
          this.holdNextStart = false;
          this.heldStart = { ws, cmd: { ...cmd } };
          return;
        }
        if (this.sessions.has(cmd.sid)) return fail('Fixture refused duplicate start');
        const stream = path.join(this.primary.runtime, 'streams', `${cmd.sid}.jsonl`);
        const proc = spawn(process.execPath, [this.cli, cmd.sid, path.join(this.base, 'accepted.jsonl')], { cwd: cmd.cwd, env: this.env(this.primary), stdio: ['pipe', 'pipe', 'pipe'] });
        this.children.push(proc);
        this.spawnedSessionIds.push(cmd.sid);
        const session = { proc, stream, lines: [] as string[], clients: new Set([ws]) };
        this.sessions.set(cmd.sid, session);
        let buffer = '';
        proc.stdout!.on('data', chunk => { buffer += chunk.toString(); let nl: number; while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); session.lines.push(line);
          void fs.appendFile(stream, line + '\n'); this.emit(session, { ev: 'jsonl', sid: cmd.sid, line });
        } });
        proc.stderr!.on('data', chunk => { this.logs += chunk.toString(); });
        proc.on('error', error => { this.logs += String(error); });
        proc.on('exit', code => this.emit(session, { ev: 'exit', sid: cmd.sid, code }));
        ok({ pid: proc.pid, outputFile: stream, offset: 0 });
        if (cmd.message) proc.stdin!.write(JSON.stringify({ type: 'user', uuid: cmd.uuid, message: { role: 'user', content: cmd.message } }) + '\n');
        return;
      }
      case 'attach': {
        const session = this.sessions.get(cmd.sid);
        if (!session) return fail('Session not found');
        session.clients.add(ws); return ok({ alive: running(session.proc), pid: session.proc.pid });
      }
      case 'send': case 'sendRaw': {
        const session = this.sessions.get(cmd.sid);
        if (!session || !running(session.proc)) return ok({ ok: false, reason: 'not_found' });
        session.clients.add(ws);
        session.proc.stdin!.write(cmd.cmd === 'sendRaw' ? cmd.raw + '\n' : JSON.stringify({ type: 'user', uuid: cmd.uuid, message: { role: 'user', content: cmd.message } }) + '\n');
        return ok({ ok: true });
      }
      case 'status': case 'getState': { const session = this.sessions.get(cmd.sid); return ok({ alive: !!session && running(session.proc), pid: session?.proc.pid }); }
      case 'list': return ok({ sessions: [...this.sessions].map(([sid, session]) => ({ sid, alive: running(session.proc), pid: session.proc.pid })) });
      case 'stop': { const session = this.sessions.get(cmd.sid); if (session) await stopChild(session.proc); return ok({ stopped: true }); }
      case 'appendUserMarker': return ok();
      // This fixture cannot write arbitrary files or run any daemon-owned program.
      default: return fail(`Unknown fixture command: ${cmd.cmd}`);
    }
  }

  async stop(): Promise<void> {
    this.bridge?.terminate();
    this.heldStart = undefined;
    this.holdNextStart = false;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    const results = await Promise.allSettled(this.children.map(stopChild));
    for (const client of this.daemon?.clients ?? []) client.terminate();
    if (this.daemon) await new Promise<void>(resolve => this.daemon!.close(() => resolve()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (this.base) await fs.rm(this.base, { recursive: true, force: true });
  }
}
