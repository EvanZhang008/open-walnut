/**
 * The local voice's real Python daemon (QWEN_TTS_PY) on the system python3
 * against a fake `mlx_audio` package on PYTHONPATH, whose model streams float
 * chunks the way Qwen3-TTS's generate(stream=True) does. Checks the WAV it
 * writes byte by byte (header, 16-bit samples, clipping), the warm-up before
 * it binds, its refusals, and that a cancel or a deadline stops a generation
 * between chunks. The streaming mode (`stream: true`): audio/L16 chunks as the
 * model makes them, a cut-off stream that ends without its last chunk, and a
 * reader that goes away stopping the generation. Only bytes are written and
 * read: nothing is played.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { findPython3 } from '../../../src/core/stt/setup-mlx.js';
import { STDIN_MAIN_PROLOGUE } from '../../../src/core/stt/daemon-source.js';
import { QWEN_TTS_PY } from '../../../src/core/tts/qwen-daemon-script.js';
import { removeTempTree } from '../../helpers/temp-home.js';

/** A stand-in for mlx-audio's TTS loader: chunks of `.audio` with tolist(), like mx.array. */
const TTS_UTILS = `
import json, os, time

class Arr:
    def __init__(self, values):
        self.values = values
    def tolist(self):
        return list(self.values)

class Result:
    def __init__(self, values):
        self.audio = Arr(values)

class Model:
    sample_rate = 24000
    speakers = ["Uncle_Fu", "Dylan"]
    def generate(self, text, voice=None, lang_code=None, stream=False, streaming_interval=2.0):
        with open(os.environ["FAKE_TTS_CALLS"], "a") as f:
            f.write(json.dumps({"text": text, "voice": voice, "lang_code": lang_code, "stream": stream, "interval": streaming_interval}) + "\\n")
        if text == "BOOM":
            raise RuntimeError("the model broke")
        if text == "LONG":
            for _ in range(200):
                time.sleep(0.05)
                yield Result([0.0] * 10)
            return
        if text == "STEPS":
            for _ in range(3):
                time.sleep(0.25)
                yield Result([0.5, -0.5])
            return
        if text == "MIDBOOM":
            yield Result([0.5])
            raise RuntimeError("the model broke mid-piece")
        yield Result([0.5, -0.5])
        yield Result([[2.0, -2.0], [0.25]])

def load_model(model_id):
    return Model()
`;

let python: string | null = null;
let workDir: string;
let callsPath: string;
const procs: ChildProcess[] = [];

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

async function startDaemon(): Promise<{ port: number; proc: ChildProcess; output: () => string }> {
  const port = await freePort();
  const proc = spawn(python!, ['-', 'fake/qwen3-tts', String(port), '60', 'test-rev', 'Uncle_Fu'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: join(workDir, 'site'), FAKE_TTS_CALLS: callsPath },
  });
  procs.push(proc);
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stdin!.end(STDIN_MAIN_PROLOGUE + QWEN_TTS_PY);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { port, proc, output: () => out };
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`daemon exited: ${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon never answered: ${out}`);
}

const speak = (port: number, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/speak`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function calls(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(callsPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(async () => { python = (await findPython3())?.path ?? null; });

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-tts-script-'));
  callsPath = join(workDir, 'calls.jsonl');
  const pkg = join(workDir, 'site', 'mlx_audio');
  await mkdir(join(pkg, 'tts'), { recursive: true });
  await writeFile(join(pkg, '__init__.py'), '');
  await writeFile(join(pkg, 'tts', '__init__.py'), '');
  await writeFile(join(pkg, 'tts', 'utils.py'), TTS_UTILS);
});

afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  await removeTempTree(workDir);
});

describe('local voice daemon script', () => {
  it('warms up with the configured voice before it binds, and says who it is', async (ctx) => {
    if (!python) ctx.skip();
    const { port, output } = await startDaemon();
    const health = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    expect(health).toEqual({ status: 'ok', model: 'fake/qwen3-tts', rev: 'test-rev', role: 'tts', sampleRate: 24000, voices: ['Uncle_Fu', 'Dylan'] });
    const [warm] = await calls();
    expect(warm).toEqual({ text: '\u4f60\u597d\u3002', voice: 'Uncle_Fu', lang_code: 'zh', stream: true, interval: 0.32 });
    expect(output()).toMatch(/warm-up took/);
  }, 30_000);

  it('writes the whole piece as 24 kHz mono 16-bit WAV, clipping out-of-range samples', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const res = await speak(port, { text: '\u4eca\u5929\u3002', voice: 'Dylan', lang_code: 'zh', id: 'a1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const wav = Buffer.from(await res.arrayBuffer());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(5 * 2);
    const samples = [0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2));
    expect(samples).toEqual([16383, -16383, 32767, -32767, 8191]);
    expect((await calls()).at(-1)).toMatchObject({ text: '\u4eca\u5929\u3002', voice: 'Dylan', lang_code: 'zh', stream: true });
  }, 30_000);

  it('refuses an empty or overlong piece and answers a model error in words, staying up', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    expect((await speak(port, { text: '  ' })).status).toBe(400);
    expect((await speak(port, { text: 'x'.repeat(2001) })).status).toBe(400);
    const broke = await speak(port, { text: 'BOOM' });
    expect(broke.status).toBe(500);
    expect((await broke.json()).error).toMatch(/the model broke/);
    expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
  }, 30_000);

  it('refuses a POST a web page could send: not JSON, with an Origin, or to another Host name', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const before = (await calls()).length;
    const body = JSON.stringify({ text: 'x', id: 'w1' });
    // A cross-site no-cors POST can only be text/plain, a form or multipart.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect((await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', headers: { 'Content-Type': type }, body })).status).toBe(403);
    }
    expect((await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', body })).status).toBe(403);
    // A browser adds Origin to every POST, a same-origin one after a DNS rebinding too.
    expect((await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/speak', method: 'POST', headers: { Host: `attacker.example:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
    expect(rebound).toBe(403);
    // The streaming mode is behind the same guard.
    const streamBody = JSON.stringify({ text: 'x', id: 'w3', stream: true });
    expect((await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: streamBody })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: streamBody })).status).toBe(403);
    // Nothing reached the model, and a local JSON request still does.
    expect((await calls()).length).toBe(before);
    expect((await speak(port, { text: 'ok', id: 'w2' })).status).toBe(200);
  }, 30_000);

  it('a cancel or the deadline stops a generation between chunks, and the next piece runs', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const t0 = Date.now();
    const long = speak(port, { text: 'LONG', id: 'r1' });
    // The cancel goes once the model has the piece (its fake records the call), not after a guess.
    await vi.waitFor(async () => { expect((await calls()).some((c) => c.text === 'LONG')).toBe(true); }, { timeout: 10_000, interval: 25 });
    await fetch(`http://127.0.0.1:${port}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'r1' }) });
    const stopped = await long;
    expect(stopped.status).toBe(408);
    expect((await stopped.json()).error).toBe('stopped: cancelled');
    expect(Date.now() - t0).toBeLessThan(5_000);

    const late = await speak(port, { text: 'LONG', id: 'r2', deadline_ms: 300 });
    expect(late.status).toBe(408);
    expect((await late.json()).error).toBe('stopped: deadline');

    expect((await speak(port, { text: 'ok', id: 'r3' })).status).toBe(200);
  }, 30_000);

  it('stream: answers audio/L16 at once and writes each chunk as the model makes it, big-endian', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const t0 = Date.now();
    const res = await speak(port, { text: 'STEPS', id: 's1', stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/L16; rate=24000; channels=1');
    const reader = res.body!.getReader();
    const parts: { at: number; bytes: Uint8Array }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push({ at: Date.now() - t0, bytes: value });
    }
    // Three chunks a quarter second apart: the first came long before the last was made.
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.at(-1)!.at - parts[0]!.at).toBeGreaterThanOrEqual(300);
    const all = Buffer.concat(parts.map((p) => p.bytes));
    expect(all.byteLength).toBe(12);
    expect([0, 1, 2, 3, 4, 5].map((i) => all.readInt16BE(i * 2))).toEqual([16383, -16383, 16383, -16383, 16383, -16383]);
    expect((await calls()).at(-1)).toMatchObject({ text: 'STEPS', stream: true, interval: 0.32 });
  }, 30_000);

  it('stream: a piece cut off (model error, cancel) ends without its last chunk, so the read fails; it stays up', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { for (;;) { if ((await reader.read()).done) return; } };
    const broke = await speak(port, { text: 'MIDBOOM', id: 's2', stream: true });
    expect(broke.status).toBe(200);
    await expect(drain(broke.body!.getReader())).rejects.toThrow();

    const long = await speak(port, { text: 'LONG', id: 's3', stream: true });
    const reader = long.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
    await fetch(`http://127.0.0.1:${port}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 's3' }) });
    await expect(drain(reader)).rejects.toThrow();

    expect((await speak(port, { text: 'ok', id: 's4' })).status).toBe(200);
  }, 30_000);

  it('stream: a reader that goes away stops the generation, so the next piece does not wait for it', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/speak`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'LONG', id: 's5', stream: true }), signal: abort.signal,
    });
    await res.body!.getReader().read();
    abort.abort();
    // LONG takes 10 s whole; the next piece gets the model within a moment of the reader leaving.
    const t0 = Date.now();
    expect((await speak(port, { text: 'ok', id: 's6' })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 30_000);

  it('/shutdown ends it', async (ctx) => {
    if (!python) ctx.skip();
    const { port, proc } = await startDaemon();
    const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
    expect((await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
    expect(await exited).toBe(0);
  }, 30_000);
});
