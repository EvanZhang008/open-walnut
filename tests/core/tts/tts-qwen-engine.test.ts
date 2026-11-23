/**
 * The local voice's daemon client (src/core/tts/engine-qwen.ts) against a fake
 * interpreter: a node script that takes the daemon's argv (`- <model> <port>
 * <idle ttl> <rev> <voice>`), refuses to serve unless the real Qwen3-TTS source
 * arrived on stdin, and speaks its HTTP contract (GET health, POST /speak with
 * WAV bytes, /cancel, /shutdown). A control file makes it slow, failing or late
 * to start. With `stream: true` it answers audio/L16 in chunks, which the control
 * file can delay, space out or cut. Nothing here makes a sound: the bytes are
 * only compared.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, readFile, chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createQwenTtsEngine, qwenDeadlineMs, qwenFitsBudget, qwenStreamDeadlineMs, QWEN_BUDGET_MS, type QwenTtsEngine } from '../../../src/core/tts/engine-qwen.js';
import { clearTtsCache, speakWithFallback } from '../../../src/core/tts/index.js';
import type { TtsEngine } from '../../../src/core/tts/types.js';
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
  /** A streamed piece: its chunks (4 bytes each), the wait before its answer (a piece ahead), before its first chunk, between chunks, and a cut after N chunks. */
  streamChunks?: number;
  streamHeaderMs?: number;
  streamFirstMs?: number;
  streamGapMs?: number;
  streamBreakAfter?: number;
  /** The daemon process exits after N streamed chunks (a crash). */
  streamExitAfter?: number;
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
    "      const { text, stream } = JSON.parse(body);",
    "      if (stream) {",
    "        let i = 0; let ended = false;",
    "        res.on('close', () => { if (!ended) note(`STREAM-GONE ${i}`); });",
    "        const send = () => {",
    "          if (res.destroyed) return;",
    "          if (c.streamBreakAfter !== undefined && i >= c.streamBreakAfter) { ended = true; res.socket.destroy(); return; }",
    "          if (c.streamExitAfter !== undefined && i >= c.streamExitAfter) { note('EXIT'); process.exit(1); }",
    "          if (i >= (c.streamChunks ?? 3)) { ended = true; res.end(); return; }",
    "          const b = Buffer.alloc(4); b.writeInt16BE((i + 1) * 1000, 0); b.writeInt16BE(-(i + 1) * 1000, 2); res.write(b); i++;",
    "          setTimeout(send, c.streamGapMs ?? 0);",
    "        };",
    "        setTimeout(() => { res.setHeader('Content-Type', 'audio/L16; rate=24000; channels=1'); res.flushHeaders(); setTimeout(send, c.streamFirstMs ?? 0); }, c.streamHeaderMs ?? 0);",
    "        return;",
    "      }",
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

/** The bytes of a stream, each read with when it came (ms since `t0`). */
async function reads(body: ReadableStream<Uint8Array>, t0: number): Promise<{ at: number; bytes: number[] }[]> {
  const out: { at: number; bytes: number[] }[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push({ at: Date.now() - t0, bytes: [...value] });
  }
}

/** The fake daemon's chunk i: two big-endian samples, (i + 1) * 1000 and its negative. */
const chunk = (i: number) => { const b = Buffer.alloc(4); b.writeInt16BE((i + 1) * 1000, 0); b.writeInt16BE(-(i + 1) * 1000, 2); return [...b]; };

function fallbackEngine(): TtsEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'elevenlabs', model: 'eleven-model', voice: 'eleven-voice', calls,
    async synthesize(req) {
      calls.push(req.text);
      return { mime: 'audio/mpeg', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([9, 9])); c.close(); } }) };
    },
  };
}

describe('a streamed piece (stream: true)', () => {
  afterEach(() => clearTtsCache());

  it('resolves at the first audio, before the piece is made, and passes the rest on as it comes', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort() });
    await e.warmup();
    await setControl({ streamChunks: 4, streamGapMs: 150 });
    const t0 = Date.now();
    const audio = await e.synthesize({ text: '\u4eca\u5929\u3002', language: 'zh-CN', stream: true });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(audio.mime).toBe('audio/L16; rate=24000; channels=1');
    const got = await reads(audio.body, t0);
    expect(got.flatMap((r) => r.bytes)).toEqual([0, 1, 2, 3].flatMap(chunk));
    expect(got.at(-1)!.at - got[0]!.at).toBeGreaterThanOrEqual(300);
    const speak = (await requestLog()).find((l) => l.includes('POST /speak'))!;
    expect(JSON.parse(speak.slice(speak.indexOf('{')))).toMatchObject({ stream: true, deadline_ms: qwenStreamDeadlineMs('\u4eca\u5929\u3002') });
  }, 30_000);

  it('no first audio within its deadline after the daemon started it: tts_unavailable, and the daemon is told', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort(), firstAudioMs: 200 });
    await e.warmup();
    await setControl({ streamFirstMs: 3_000 });
    const t0 = Date.now();
    await expect(e.synthesize({ text: 'late', language: 'zh', stream: true })).rejects.toMatchObject({ status: 503, code: 'tts_unavailable', message: expect.stringMatching(/no audio within/) });
    expect(Date.now() - t0).toBeLessThan(1_500);
    // The cancel and the closed stream reach the daemon a moment after the refusal.
    await vi.waitFor(async () => {
      const log = await requestLog();
      const sent = log.find((l) => l.includes('POST /speak'))!;
      const id = JSON.parse(sent.slice(sent.indexOf('{'))).id;
      expect(log.some((l) => l.includes('POST /cancel') && l.includes(id))).toBe(true);
      expect(log.some((l) => l.includes('STREAM-GONE 0'))).toBe(true);
    }, { timeout: 5_000, interval: 50 });
  }, 30_000);

  it('a piece queued behind another waits for its start: only the time after it is the first audio\'s', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort(), firstAudioMs: 300 });
    await e.warmup();
    await setControl({ streamHeaderMs: 800 });
    const audio = await e.synthesize({ text: 'queued', language: 'zh', stream: true });
    expect((await reads(audio.body, Date.now())).flatMap((r) => r.bytes)).toEqual([0, 1, 2].flatMap(chunk));
  }, 30_000);

  it('a reader that goes away ends the daemon\'s piece and tells it', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort() });
    await e.warmup();
    await setControl({ streamChunks: 20, streamGapMs: 100 });
    const audio = await e.synthesize({ text: 'gone', language: 'zh', stream: true });
    const reader = audio.body.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(async () => {
      const log = await requestLog();
      expect(log.some((l) => l.includes('POST /cancel'))).toBe(true);
      expect(log.some((l) => /STREAM-GONE [1-9]\d*$/.test(l))).toBe(true);
    }, { timeout: 5_000, interval: 50 });
  }, 30_000);

  it('through speakWithFallback: late first audio goes to the fallback; a break part way only ends it; a whole one is cached as WAV', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort(), firstAudioMs: 200 });
    await e.warmup();
    const eleven = fallbackEngine();
    const engines = { engine: e, fallback: eleven };

    // No audio in time: the usual engine reads it, as for a whole piece.
    await setControl({ streamFirstMs: 2_000 });
    const late = await speakWithFallback(engines, { text: 'late one', language: 'zh-CN', stream: true });
    expect(late.engine.id).toBe('elevenlabs');
    expect([...new Uint8Array(await new Response(late.body).arrayBuffer())]).toEqual([9, 9]);

    // Audio went out, then the daemon broke: no fallback, the stream fails, nothing is cached.
    await setControl({ streamChunks: 5, streamGapMs: 50, streamBreakAfter: 2 });
    const broke = await speakWithFallback(engines, { text: 'broken one', language: 'zh-CN', stream: true });
    expect(broke.engine.id).toBe('qwen');
    await expect(reads(broke.body, Date.now())).rejects.toThrow();
    expect(eleven.calls).toEqual(['late one']);
    await setControl({});
    const retried = await speakWithFallback(engines, { text: 'broken one', language: 'zh-CN', stream: true });
    expect(retried.cached).toBe(false);
    await reads(retried.body, Date.now());

    // A long piece streams too (it plays while the rest is made); whole, it is kept as WAV and answers whole.
    const long = '\u4eca'.repeat(80);
    expect(qwenFitsBudget(long)).toBe(false);
    const whole = await speakWithFallback(engines, { text: long, language: 'zh-CN', stream: true });
    expect(whole.engine.id).toBe('qwen');
    expect(whole.mime).toMatch(/^audio\/L16/);
    await reads(whole.body, Date.now());
    const again = await speakWithFallback(engines, { text: long, language: 'zh-CN', stream: true });
    expect(again).toMatchObject({ cached: true, mime: 'audio/wav' });
    const wav = Buffer.from(await new Response(again.body).arrayBuffer());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(12);
    expect([0, 1, 2, 3, 4, 5].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([1000, -1000, 2000, -2000, 3000, -3000]);

    // Without stream nothing changed: the whole WAV, and a long piece still goes to the fallback.
    const plain = await speakWithFallback(engines, { text: 'plain one', language: 'zh-CN' });
    expect(plain.mime).toBe('audio/wav');
    expect(await text(plain.body)).toBe('RIFF:plain one:Uncle_Fu');
    expect((await speakWithFallback(engines, { text: '\u660e'.repeat(80), language: 'zh-CN' })).engine.id).toBe('elevenlabs');
  }, 30_000);

  it('a piece asked for while the one before still streams waits its turn, and that wait is not its budget: no fallback', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort(), budgetMs: 300, firstAudioMs: 1_000 });
    await e.warmup();
    const eleven = fallbackEngine();
    const engines = { engine: e, fallback: eleven };
    // Each piece takes about 750 ms to make, well past the 300 ms budget.
    await setControl({ streamChunks: 6, streamGapMs: 150 });
    const first = await speakWithFallback(engines, { text: 'first one', language: 'zh-CN', stream: true });
    const nextOne = speakWithFallback(engines, { text: 'second one', language: 'zh-CN', stream: true });
    expect((await reads(first.body, Date.now())).flatMap((r) => r.bytes)).toEqual([0, 1, 2, 3, 4, 5].flatMap(chunk));
    const second = await nextOne;
    expect(second.engine.id).toBe('qwen');
    expect((await reads(second.body, Date.now())).flatMap((r) => r.bytes)).toEqual([0, 1, 2, 3, 4, 5].flatMap(chunk));
    expect(eleven.calls).toEqual([]);
    // The daemon got the second piece only after the first was done: one at a time, as its model runs.
    const speaks = (await requestLog()).filter((l) => l.includes('POST /speak'));
    expect(speaks.map((l) => JSON.parse(l.slice(l.indexOf('{'))).text)).toEqual(['first one', 'second one']);
    expect(e.busy).toBe(false);

  }, 30_000);

  it('a caller that goes away mid-stream (the route\'s client closed) frees the engine and tells the daemon, though nobody reads on', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort() });
    await e.warmup();
    await setControl({ streamChunks: 50, streamGapMs: 100 });
    const abort = new AbortController();
    const audio = await e.synthesize({ text: 'left', language: 'zh', stream: true, signal: abort.signal });
    expect(audio.mime).toMatch(/^audio\/L16/);
    expect(e.busy).toBe(true);
    abort.abort();
    expect(e.busy).toBe(false);
    await vi.waitFor(async () => {
      const log = await requestLog();
      const sent = log.find((l) => l.includes('POST /speak'))!;
      const id = JSON.parse(sent.slice(sent.indexOf('{'))).id;
      expect(log.some((l) => l.includes('POST /cancel') && l.includes(id))).toBe(true);
      expect(log.some((l) => /STREAM-GONE \d+$/.test(l))).toBe(true);
    }, { timeout: 5_000, interval: 50 });
    // The next piece is not held behind the one that was dropped.
    await setControl({});
    const next = await e.synthesize({ text: 'next', language: 'zh', stream: true });
    expect((await reads(next.body, Date.now())).flatMap((r) => r.bytes)).toEqual([0, 1, 2].flatMap(chunk));
  }, 30_000);

  it('a stream cut part way by a daemon that is still up (its deadline, a model error) keeps it ready; one that died is started again', async () => {
    const pythonPath = await makeFakePython();
    const e = engine({ pythonPath, port: await freePort() });
    await e.warmup();
    const probes = async () => (await requestLog()).filter((l) => l.includes(' GET /')).length;
    await setControl({ streamChunks: 5, streamGapMs: 50, streamBreakAfter: 2 });
    const before = await probes();
    const cut = await e.synthesize({ text: 'cut', language: 'zh', stream: true });
    await expect(reads(cut.body, Date.now())).rejects.toMatchObject({ name: 'TtsError', code: 'tts_unavailable' });
    expect(e.ready).toBe(true);
    // The engine looked: the daemon answered, so it stays the voice for the next piece.
    await vi.waitFor(async () => expect(await probes()).toBeGreaterThan(before), { timeout: 5_000, interval: 50 });
    expect(e.ready).toBe(true);
    expect(e.busy).toBe(false);
    await setControl({});
    const next = await e.synthesize({ text: 'after', language: 'zh', stream: true });
    await reads(next.body, Date.now());

    // A daemon that died part way: nothing answers the look, so it is started again for the next piece.
    await setControl({ streamChunks: 5, streamGapMs: 50, streamExitAfter: 2 });
    const died = await e.synthesize({ text: 'crash', language: 'zh', stream: true });
    await expect(reads(died.body, Date.now())).rejects.toMatchObject({ name: 'TtsError' });
    await vi.waitFor(async () => expect((await requestLog()).filter((l) => / START /.test(l))).toHaveLength(2), { timeout: 5_000, interval: 50 });
  }, 30_000);
});
