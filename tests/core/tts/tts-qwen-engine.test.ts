/**
 * The local voice's daemon client (src/core/tts/engine-qwen.ts) against a fake
 * interpreter: a node script that takes the daemon's argv (`- <model> <port>
 * <idle ttl> <rev> <voice>`), refuses to serve unless the real Qwen3-TTS source
 * arrived on stdin, and speaks its HTTP contract (GET health, POST /speak with
 * WAV bytes, /cancel, /shutdown). A control file makes it slow, failing or late
 * to start. Nothing here makes a sound: the WAV bytes are only compared.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createQwenTtsEngine, qwenDeadlineMs, qwenFitsBudget, QWEN_BUDGET_MS, type QwenTtsEngine } from '../../../src/core/tts/engine-qwen.js';
import { _setVoiceIsolationForTest } from '../../../src/core/stt/voice-here.js';
import { removeTempTree } from '../../helpers/temp-home.js';
import { optInToVoice } from '../../helpers/voice-opt-in.js';

optInToVoice();

const MODEL = 'fake/qwen3-tts';

let workDir: string;
let controlPath: string;
let logPath: string;
const engines: QwenTtsEngine[] = [];

interface Control {
  /** Each /speak waits this long before answering. */
  speakMs?: number;
  /** /speak answers 500. */
  fail?: boolean;
  /** The daemon binds its port this long after it starts (a model load). */
  startDelayMs?: number;
}

async function setControl(c: Control): Promise<void> {
  await writeFile(controlPath, JSON.stringify(c));
}

async function requestLog(): Promise<string[]> {
  try { return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
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

async function makeFakePython(): Promise<string> {
  const shim = join(workDir, 'fake-python');
  await writeFile(shim, [
    `#!${process.execPath}`,
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    'const [mode, model, port, , rev, voice] = process.argv.slice(2);',
    "if (mode === '-c') process.exit(0);",
    "const note = (line) => fs.appendFileSync(process.env.FAKE_TTS_LOG, `${process.pid} ${line}\\n`);",
    "const control = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_TTS_CONTROL, 'utf8')); } catch { return {}; } };",
    "let source = ''; process.stdin.on('data', (d) => { source += d; });",
    "process.stdin.on('end', () => {",
    "  if (!source.includes('mlx_audio.tts.utils') || !source.includes('/speak')) { note('NO-SOURCE'); process.exit(3); }",
    '  note(`START ${voice}`);',
    '  const server = http.createServer((req, res) => {',
    "    let body = ''; req.on('data', (c) => { body += c; });",
    "    req.on('end', () => {",
    '      note(`${req.method} ${req.url} ${body}`);',
    "      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', model, rev, role: 'tts' })); return; }",
    "      if (req.url === '/shutdown') { res.end('{}'); setTimeout(() => process.exit(0), 100); return; }",
    "      if (req.url === '/cancel') { res.end('{}'); return; }",
    '      const c = control();',
    "      if (c.fail) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{\"error\":\"model broke\"}'); return; }",
    '      const { text } = JSON.parse(body);',
    "      const answer = () => { res.setHeader('Content-Type', 'audio/wav'); res.end(Buffer.from(`RIFF:${text}:${voice}`)); };",
    '      if (c.speakMs) setTimeout(answer, c.speakMs); else answer();',
    '    });',
    '  });',
    "  setTimeout(() => server.listen(Number(port), '127.0.0.1', () => console.log('READY')), control().startDelayMs ?? 0);",
    '});',
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  await chmod(shim, 0o755);
  return shim;
}

function engine(cfg: Partial<Parameters<typeof createQwenTtsEngine>[0]> & { pythonPath: string; port: number }): QwenTtsEngine {
  const e = createQwenTtsEngine({ model: MODEL, voice: 'Uncle_Fu', readyWaitMs: 5_000, startupTimeoutMs: 10_000, ...cfg });
  engines.push(e);
  return e;
}

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await new Response(body).arrayBuffer());
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-tts-qwen-test-'));
  controlPath = join(workDir, 'control.json');
  logPath = join(workDir, 'requests.log');
  process.env.FAKE_TTS_CONTROL = controlPath;
  process.env.FAKE_TTS_LOG = logPath;
  await setControl({});
});

afterEach(async () => {
  for (const e of engines.splice(0)) e.shutdown();
  _setVoiceIsolationForTest(undefined);
  // End every fake this test started that still runs THIS test's shim (a finished one's pid may be reused).
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
  delete process.env.FAKE_TTS_CONTROL;
  delete process.env.FAKE_TTS_LOG;
  await removeTempTree(workDir);
});

describe('local voice daemon client', () => {
  it('starts the daemon with the script over stdin, sends the piece with its voice, and gets the WAV back', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port });
    expect(await e.isAvailable()).toEqual({ available: true });
    // A piece never waits for the load: the first one goes elsewhere while the daemon starts.
    await expect(e.synthesize({ text: 'piece zero', language: 'zh-CN' })).rejects.toMatchObject({ code: 'tts_unavailable' });
    await e.warmup();
    const audio = await e.synthesize({ text: 'piece one', language: 'zh-CN' });
    expect(audio.mime).toBe('audio/wav');
    expect(await text(audio.body)).toBe('RIFF:piece one:Uncle_Fu');
    expect(e.ready).toBe(true);
    const log = await requestLog();
    expect(log.filter((l) => l.includes(' START '))).toHaveLength(1);
    const speak = log.find((l) => l.includes('POST /speak'))!;
    const sent = JSON.parse(speak.slice(speak.indexOf('{')));
    expect(sent).toMatchObject({ text: 'piece one', voice: 'Uncle_Fu', lang_code: 'zh', deadline_ms: qwenDeadlineMs('piece one') });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it('a second engine (the next server, or another voice) adopts the warm daemon instead of loading again', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    await engine({ pythonPath, port }).warmup();
    const next = engine({ pythonPath, port, voice: 'Dylan' });
    expect(await text((await next.synthesize({ text: 'again', language: 'zh' })).body)).toBe('RIFF:again:Uncle_Fu');
    expect((await requestLog()).filter((l) => l.includes(' START '))).toHaveLength(1);
    // The voice rides each request: the adopted daemon reads it with the voice asked for.
    const speak = (await requestLog()).find((l) => l.includes('POST /speak'))!;
    expect(JSON.parse(speak.slice(speak.indexOf('{'))).voice).toBe('Dylan');
  }, 30_000);

  it('a daemon still loading: the piece fails at once (no ready wait) with tts_unavailable, and a later piece finds it ready', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    await setControl({ startDelayMs: 3_000 });
    // A long ready wait: only an adopt is worth it, so a spawn (a model load) ends it at once.
    const e = engine({ pythonPath, port, readyWaitMs: 5_000 });
    let t0 = Date.now();
    await expect(e.synthesize({ text: 'too early', language: 'zh' })).rejects.toMatchObject({ status: 503, code: 'tts_unavailable', message: expect.stringMatching(/still loading/) });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(e.ready).toBe(false);
    // Asked again while it loads: refused before any wait.
    t0 = Date.now();
    await expect(e.synthesize({ text: 'still early', language: 'zh' })).rejects.toMatchObject({ code: 'tts_unavailable' });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(await e.readySoon(5_000)).toBe(false);
    await e.warmup();
    expect(e.ready).toBe(true);
    expect(await e.readySoon(1_000)).toBe(true);
    expect(await text((await e.synthesize({ text: 'now', language: 'zh' })).body)).toBe('RIFF:now:Uncle_Fu');
    expect((await requestLog()).filter((l) => l.includes(' START '))).toHaveLength(1);
  }, 30_000);

  it('the caller\'s deadline caps the one the daemon is told, so it stops by itself in time', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port });
    await e.warmup();
    await e.synthesize({ text: 'capped', language: 'zh', deadlineMs: 3_000 });
    const speak = (await requestLog()).find((l) => l.includes('POST /speak'))!;
    const sent = JSON.parse(speak.slice(speak.indexOf('{'))).deadline_ms;
    expect(sent).toBeLessThanOrEqual(3_000);
    expect(sent).toBeGreaterThan(2_000);
  }, 30_000);

  it('a piece fits the budget up to about 60 Chinese characters', () => {
    expect(QWEN_BUDGET_MS).toBe(8_000);
    expect(qwenFitsBudget('\u4eca'.repeat(60))).toBe(true);
    expect(qwenFitsBudget('\u4eca'.repeat(61))).toBe(false);
    expect(qwenFitsBudget('\u4f60\u597d\u3002')).toBe(true);
  });

  it('a slow piece is cut at its deadline, and the daemon is told to stop generating it', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port, deadlineMs: () => 300 });
    await e.warmup();
    await setControl({ speakMs: 3_000 });
    const t0 = Date.now();
    await expect(e.synthesize({ text: 'slow one', language: 'zh' })).rejects.toMatchObject({ status: 503, code: 'tts_unavailable' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 300));
    const log = await requestLog();
    const speak = log.find((l) => l.includes('POST /speak'))!;
    const id = JSON.parse(speak.slice(speak.indexOf('{'))).id;
    expect(log.some((l) => l.includes('POST /cancel') && l.includes(id))).toBe(true);
  }, 30_000);

  it('a daemon that answers an error is tts_failed; a client that went away is a cancel (499)', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port });
    await e.warmup();
    await setControl({ fail: true });
    await expect(e.synthesize({ text: 'x', language: 'zh' })).rejects.toMatchObject({ status: 502, code: 'tts_failed', message: expect.stringMatching(/model broke/) });
    await setControl({ speakMs: 2_000 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await expect(e.synthesize({ text: 'y', language: 'zh', signal: abort.signal })).rejects.toMatchObject({ status: 499 });
  }, 30_000);

  it('a daemon that went away (its idle timer): the piece fails fast and the next one starts it again', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port });
    await e.warmup();
    expect(e.ready).toBe(true);
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 400));
    // The health probe finds nothing on the port and starts a new daemon: this piece goes
    // elsewhere at once, and the engine says it is not ready until the new one answers.
    const t0 = Date.now();
    await expect(e.synthesize({ text: 'gone', language: 'zh' })).rejects.toMatchObject({ code: 'tts_unavailable' });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(e.ready).toBe(false);
    await e.warmup();
    expect(e.ready).toBe(true);
    expect(await text((await e.synthesize({ text: 'back', language: 'zh' })).body)).toBe('RIFF:back:Uncle_Fu');
    expect((await requestLog()).filter((l) => l.includes(' START '))).toHaveLength(2);
  }, 30_000);

  it('another voice rides the same engine and daemon', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    const e = engine({ pythonPath, port });
    await e.warmup();
    e.setVoice('Dylan');
    expect(e.voice).toBe('Dylan');
    expect(await text((await e.synthesize({ text: 'v', language: 'zh' })).body)).toBe('RIFF:v:Uncle_Fu');
    const speak = (await requestLog()).find((l) => l.includes('POST /speak'))!;
    expect(JSON.parse(speak.slice(speak.indexOf('{'))).voice).toBe('Dylan');
    expect((await requestLog()).filter((l) => l.includes(' START '))).toHaveLength(1);
  }, 30_000);

  it('an interpreter that is not there: unavailable, with the path', async () => {
    const e = engine({ pythonPath: join(workDir, 'no-python'), port: await freePort(), readyWaitMs: 2_000 });
    expect(await e.isAvailable()).toMatchObject({ available: false, error: expect.stringMatching(/Python interpreter not found/) });
    await expect(e.synthesize({ text: 'x', language: 'zh' })).rejects.toMatchObject({ status: 503, code: 'tts_unavailable' });
    await e.warmup().catch(() => {});
    expect(e.startError).toMatch(/spawn|exited|ENOENT/i);
  }, 30_000);

  it('an isolated server starts no daemon and says why', async () => {
    _setVoiceIsolationForTest('test-runner');
    const saved = process.env.WALNUT_STT_AUTO_SETUP;
    delete process.env.WALNUT_STT_AUTO_SETUP;
    try {
      const pythonPath = await makeFakePython();
      const e = engine({ pythonPath, port: await freePort() });
      expect(await e.isAvailable()).toMatchObject({ available: false, error: expect.stringMatching(/Voice is off on this isolated server/) });
      await expect(e.synthesize({ text: 'x', language: 'zh' })).rejects.toMatchObject({ status: 503, code: 'tts_unavailable' });
      expect(await requestLog()).toEqual([]);
    } finally {
      process.env.WALNUT_STT_AUTO_SETUP = saved;
    }
  }, 30_000);
});
