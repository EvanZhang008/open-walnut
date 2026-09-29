/**
 * The mlx engine must not mistake a SLOW daemon for a DEAD one, and a restart
 * must not adopt the daemon it is retiring.
 *
 * The 2026-09-28 dictation failure, from the server log: at load ~250 a 2s
 * health probe to a healthy, adopted daemon timed out, the engine POSTed
 * /shutdown (the daemon exits 200ms later), probed the port again at once,
 * found the same daemon still answering, "adopted" it, and sent the next
 * dictation into a process on its way out: `fetch failed`. The next recording
 * then waited out a 54s cold model load.
 *
 * The fake interpreter below speaks the daemon's HTTP contract (GET health,
 * POST /inference, POST /shutdown that exits 200ms later, like the real one)
 * and reads a control file on every request, so a test can make exactly one
 * probe slow, one probe fail, or one request drop its connection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import http from 'node:http';
import { createMlxEngine } from '../../src/core/stt/engine-mlx.js';
import { probeDaemon, probeDaemonPatiently, isDaemonConnectionLost } from '../../src/core/stt/daemon-health.js';
import type { SttEngine } from '../../src/core/stt/types.js';
import { removeTempTree } from '../helpers/temp-home.js';

const MODEL = 'fake/asr-model';

let workDir: string;
let savedTmpdir: string | undefined;
let savedControl: string | undefined;
let controlPath: string;
let logPath: string;
let engine: SttEngine | null = null;
const servers: http.Server[] = [];

interface Control {
  /** The next N health GETs sleep getDelayMs before answering. */
  slowGets?: number;
  getDelayMs?: number;
  /** The next N health GETs answer 503. */
  badGets?: number;
  /** The next N /inference requests drop the connection and the process exits. */
  dropInference?: number;
  /** How long a generate takes. */
  inferenceMs?: number;
}

async function setControl(c: Control): Promise<void> {
  await writeFile(controlPath, JSON.stringify(c));
}

/** One line per request the fake saw: `<pid> <METHOD> <url>`, plus `<pid> START`. */
async function requestLog(): Promise<string[]> {
  try { return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
}

function conformingWav(samples = 160): string {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  return buf.toString('base64');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function daemonPid(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  return ((await res.json()) as { pid: number }).pid;
}

async function makeFakePython(): Promise<string> {
  const shim = join(workDir, 'fake-python');
  await writeFile(shim, [
    `#!${process.execPath}`,
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    'const [mode, model, port] = process.argv.slice(2);',
    "if (mode === '-c') process.exit(0);",
    'const CONTROL = process.env.FAKE_MLX_CONTROL;',
    'const LOG = process.env.FAKE_MLX_LOG;',
    "const note = (line) => fs.appendFileSync(LOG, `${process.pid} ${line}\\n`);",
    // Read-modify-write so a counter is consumed once across daemon generations.
    'function take(key) {',
    "  let c = {}; try { c = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch {}",
    '  if (!(c[key] > 0)) return { hit: false, c };',
    '  c[key]--; fs.writeFileSync(CONTROL, JSON.stringify(c));',
    '  return { hit: true, c };',
    '}',
    "function peek() { try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return {}; } }",
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "  note('START');",
    '  http.createServer((req, res) => {',
    "    res.setHeader('Content-Type', 'application/json');",
    '    note(`${req.method} ${req.url}`);',
    "    if (req.method === 'GET') {",
    "      if (take('badGets').hit) { res.statusCode = 503; res.end('{}'); return; }",
    "      const slow = take('slowGets');",
    "      const answer = () => res.end(JSON.stringify({ status: 'ok', model, pid: process.pid }));",
    '      if (slow.hit) setTimeout(answer, slow.c.getDelayMs ?? 2600); else answer();',
    '      return;',
    '    }',
    "    if (req.url === '/shutdown') { res.end('{\"ok\":true}'); setTimeout(() => process.exit(0), 200); return; }",
    "    let body = ''; req.on('data', (c) => { body += c; });",
    "    req.on('end', () => {",
    "      if (take('dropInference').hit) { req.socket.destroy(); process.exit(0); }",
    "      setTimeout(() => res.end(JSON.stringify({ text: `heard by ${process.pid}`, engineMs: 1 })), peek().inferenceMs ?? 300);",
    '    });',
    "  }).listen(Number(port), '127.0.0.1', () => console.log('READY'));",
    '});',
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  await chmod(shim, 0o755);
  return shim;
}

/** Start a daemon the way a PREVIOUS walnut server would have, so the engine adopts it. */
async function spawnForeignOwnedDaemon(pythonPath: string, port: number): Promise<number> {
  const proc = spawn(pythonPath, ['-', MODEL, String(port), '60'], { stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
  proc.stdin.end('# program\n');
  proc.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probeDaemon(port, 500) === 'ok') return daemonPid(port);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('fake daemon never came up');
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-mlx-health-test-'));
  const privateTmp = join(workDir, 'tmp');
  await mkdir(privateTmp);
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  controlPath = join(workDir, 'control.json');
  logPath = join(workDir, 'requests.log');
  savedControl = process.env.FAKE_MLX_CONTROL;
  process.env.FAKE_MLX_CONTROL = controlPath;
  process.env.FAKE_MLX_LOG = logPath;
  await setControl({});
});

afterEach(async () => {
  engine?.shutdown?.();
  engine = null;
  for (const srv of servers.splice(0)) { srv.closeAllConnections(); srv.close(); }
  // Every fake this test started logged START with its pid; end the ones still
  // running THIS test's shim (a finished fake's pid may have been reused).
  for (const line of await requestLog()) {
    const [pid, what] = line.split(' ');
    const n = Number(pid);
    if (what !== 'START' || !Number.isInteger(n) || n <= 1) continue;
    let command = '';
    try { command = execFileSync('ps', ['-o', 'command=', '-p', String(n)], { encoding: 'utf8' }); } catch { continue; }
    if (command.includes(join(workDir, 'fake-python'))) {
      try { process.kill(n, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  if (savedControl === undefined) delete process.env.FAKE_MLX_CONTROL; else process.env.FAKE_MLX_CONTROL = savedControl;
  delete process.env.FAKE_MLX_LOG;
  await removeTempTree(workDir);
});

describe('mlx engine: slow is not dead', () => {
  it('keeps an adopted daemon whose health probe answers late, instead of retiring it mid-dictation', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const pid = await spawnForeignOwnedDaemon(pythonPath, port);
    engine = createMlxEngine({ pythonPath, port, model: MODEL });

    expect((await engine.transcribe({ audio: conformingWav(), format: 'wav' })).text).toBe(`heard by ${pid}`);

    // One probe misses the 2s quick deadline, as it did at load 250.
    await setControl({ slowGets: 1, getDelayMs: 2600 });
    const second = await engine.transcribe({ audio: conformingWav(), format: 'wav' });

    expect(second.text).toBe(`heard by ${pid}`);
    expect(await daemonPid(port)).toBe(pid);
    const log = await requestLog();
    expect(log.filter(l => l.endsWith('POST /shutdown'))).toEqual([]);
  }, 30_000);

  it('retires a daemon that answers its probe with an error, and waits for it to exit before starting another', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const oldPid = await spawnForeignOwnedDaemon(pythonPath, port);
    engine = createMlxEngine({ pythonPath, port, model: MODEL });
    await engine.transcribe({ audio: conformingWav(), format: 'wav' });

    // The next probe fails, every probe after it (including the restart's own
    // look at the port) would succeed: the dying daemon is still answering.
    await setControl({ badGets: 1 });
    const result = await engine.transcribe({ audio: conformingWav(), format: 'wav' });

    const newPid = await daemonPid(port);
    expect(newPid).not.toBe(oldPid);
    expect(result.text).toBe(`heard by ${newPid}`);
    const log = await requestLog();
    expect(log.filter(l => l === `${oldPid} POST /shutdown`)).toHaveLength(1);
    // Nothing was sent to the daemon after it was told to shut down.
    const shutdownAt = log.indexOf(`${oldPid} POST /shutdown`);
    expect(log.slice(shutdownAt + 1).filter(l => l === `${oldPid} POST /inference`)).toEqual([]);
  }, 30_000);

  it('asks once more on a fresh daemon when the connection drops mid-request', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    engine = createMlxEngine({ pythonPath, port, model: MODEL });
    await engine.transcribe({ audio: conformingWav(), format: 'wav' });
    const oldPid = await daemonPid(port);

    await setControl({ dropInference: 1 });
    const result = await engine.transcribe({ audio: conformingWav(), format: 'wav' });

    const newPid = await daemonPid(port);
    expect(newPid).not.toBe(oldPid);
    expect(result.text).toBe(`heard by ${newPid}`);
  }, 30_000);

  it('does not send a draft the browser already dropped to the model', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    engine = createMlxEngine({ pythonPath, port, model: MODEL });
    await engine.transcribe({ audio: conformingWav(), format: 'wav' });
    const before = (await requestLog()).filter(l => l.endsWith('POST /inference')).length;

    const gone = new AbortController();
    gone.abort();
    await expect(engine.transcribe({ audio: conformingWav(), format: 'wav', signal: gone.signal }))
      .rejects.toThrow(/abort/i);

    // Dropped while the generate is running: the caller is released at once.
    await setControl({ inferenceMs: 5000 });
    const late = new AbortController();
    const t0 = Date.now();
    const pending = engine.transcribe({ audio: conformingWav(), format: 'wav', signal: late.signal });
    setTimeout(() => late.abort(), 200);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(Date.now() - t0).toBeLessThan(3000);

    const after = (await requestLog()).filter(l => l.endsWith('POST /inference')).length;
    expect(after - before).toBe(1); // only the one aborted mid-generate reached the daemon
  }, 30_000);

  it('treats a daemon still generating a dropped draft as busy, not dead', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    engine = createMlxEngine({ pythonPath, port, model: MODEL });
    await engine.transcribe({ audio: conformingWav(), format: 'wav' });
    const pid = await daemonPid(port);

    // A draft is dropped mid-generate: nothing of ours is in flight any more,
    // but the daemon cannot know and keeps generating.
    await setControl({ inferenceMs: 1500 });
    const dropped = new AbortController();
    const orphan = engine.transcribe({ audio: conformingWav(), format: 'wav', signal: dropped.signal });
    setTimeout(() => dropped.abort(), 100);
    await expect(orphan).rejects.toThrow(/abort/i);

    // It misses both the quick probe and a patient one. Busy with the orphan,
    // it must be queued behind, not shut down and reloaded.
    await setControl({ slowGets: 2, getDelayMs: 16_000, inferenceMs: 50 });
    const t0 = Date.now();
    const next = await engine.transcribe({ audio: conformingWav(), format: 'wav' });
    expect(next.text).toBe(`heard by ${pid}`);
    expect(Date.now() - t0).toBeLessThan(10_000); // no patient look, no restart
    expect((await requestLog()).filter(l => l.endsWith('POST /shutdown'))).toEqual([]);
  }, 40_000);
});

describe('daemon health probe classification', () => {
  function listen(handler: http.RequestListener): Promise<number> {
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
    });
  }

  it('tells a refused port, an error status, a silent listener and a healthy one apart', async () => {
    const closed = await freePort();
    expect(await portOpen(closed)).toBe(false);
    expect(await probeDaemon(closed, 1000)).toBe('refused');

    const bad = await listen((_req, res) => { res.statusCode = 500; res.end(); });
    expect(await probeDaemon(bad, 1000)).toBe('bad-status');

    const silent = await listen(() => { /* never answers */ });
    expect(await probeDaemon(silent, 300)).toBe('unresponsive');

    const ok = await listen((_req, res) => res.end('{}'));
    expect(await probeDaemon(ok, 1000)).toBe('ok');
  });

  it('gives a slow listener a patient second look before calling it unresponsive', async () => {
    let gets = 0;
    const port = await listen((_req, res) => {
      gets++;
      if (gets === 1) setTimeout(() => res.end('{}'), 2600); else res.end('{}');
    });
    let slowNoted = false;
    expect(await probeDaemonPatiently(port, { onSlow: () => { slowNoted = true; } })).toBe('ok');
    expect(slowNoted).toBe(true);
  }, 20_000);

  it('counts a dropped connection as lost, and a timeout as not', async () => {
    const port = await listen((req) => { req.socket.destroy(); });
    const dropped = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    expect(isDaemonConnectionLost(dropped)).toBe(true);

    const silent = await listen(() => { /* never answers */ });
    const timedOut = await fetch(`http://127.0.0.1:${silent}/`, { signal: AbortSignal.timeout(200) }).catch((e: unknown) => e);
    expect(isDaemonConnectionLost(timedOut)).toBe(false);
  });
});
