/**
 * Qwen3-ASR on Linux: the platform plan, the pinned downloads, the segmenter, and
 * the llama-server engine against a stand-in llama-server (a node script that
 * answers the same endpoints), so spawn, adoption and the request shape are real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-stt-qwen'));

import { planQwen } from '../../src/core/stt/qwen-plan.js';
import {
  segmentBoundaries, wavPcm, pcmToWav, joinSegmentTexts, SAMPLE_RATE,
} from '../../src/core/stt/wav-segment.js';
import {
  downloadPinned, installLlama, isLlamaInstalled, LLAMA_RUNTIME, LLAMA_MODELS, LLAMA_TAG, llamaServerPath, llamaModelPaths,
  type PinnedFile,
} from '../../src/core/stt/llama-runtime.js';
import { createLlamaEngine, stripAsrHeader, maxTokensFor } from '../../src/core/stt/engine-llama.js';
import { extractTarGz } from '../../src/core/stt/untar.js';
import { gzipSync } from 'node:zlib';

const GB = 1024 ** 3;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stt-qwen-'));

describe('planQwen', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64', cpus: 10, totalMemBytes: 32 * GB }, 'mlx'],
    [{ platform: 'darwin', arch: 'x64', cpus: 8, totalMemBytes: 16 * GB }, 'none'],
    [{ platform: 'win32', arch: 'x64', cpus: 8, totalMemBytes: 16 * GB }, 'none'],
  ] as const)('%o runs %s', (host, runtime) => {
    expect(planQwen(host).runtime).toBe(runtime);
  });

  it('gives a two-core 8 GB Linux box the small model, a big box the large one', () => {
    expect(planQwen({ platform: 'linux', arch: 'arm64', cpus: 2, totalMemBytes: 7.6 * GB }))
      .toEqual({ runtime: 'llama', size: '0.6B', target: 'linux-arm64' });
    expect(planQwen({ platform: 'linux', arch: 'x64', cpus: 8, totalMemBytes: 15.5 * GB }))
      .toEqual({ runtime: 'llama', size: '1.7B', target: 'linux-x64' });
    // Many cores but too little memory stays small.
    expect(planQwen({ platform: 'linux', arch: 'x64', cpus: 16, totalMemBytes: 8 * GB })).toMatchObject({ size: '0.6B' });
  });

  it('pins every model file by size and hash', () => {
    for (const m of Object.values(LLAMA_MODELS)) {
      for (const f of [m.model, m.mmproj]) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(100_000_000);
        expect(f.url).toContain('/resolve/');
      }
    }
  });
});

describe('Qwen3-ASR output', () => {
  it('strips the language header', () => {
    expect(stripAsrHeader('language Chinese<asr_text>hello there')).toBe('hello there');
    expect(stripAsrHeader('language None<asr_text>')).toBe('');
    expect(stripAsrHeader('no header at all')).toBe('no header at all');
    expect(stripAsrHeader('language English hello')).toBe('hello');
  });

  it('bounds the output budget by the audio length', () => {
    expect(maxTokensFor(1)).toBe(256);
    expect(maxTokensFor(60)).toBe(60 * 32 + 128);
    expect(maxTokensFor(3600)).toBe(4096);
  });
});

/** Tone with silent stretches at the given seconds (each 1 s long). */
function speech(seconds: number, silentAt: number[] = []): Int16Array {
  const pcm = new Int16Array(seconds * SAMPLE_RATE);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE;
    const silent = silentAt.some((s) => t >= s && t < s + 1);
    pcm[i] = silent ? 0 : Math.round(8000 * Math.sin(2 * Math.PI * 220 * t));
  }
  return pcm;
}

describe('segmenter', () => {
  it('keeps a recording within the limit whole', () => {
    expect(segmentBoundaries(speech(30))).toEqual([30 * SAMPLE_RATE]);
  });

  it('cuts a long recording in its silence, never past the limit', () => {
    const pcm = speech(200, [70, 150]);
    const cuts = segmentBoundaries(pcm);
    expect(cuts.at(-1)).toBe(pcm.length);
    expect(cuts.length).toBe(3);
    expect(cuts[0] / SAMPLE_RATE).toBeGreaterThanOrEqual(70);
    expect(cuts[0] / SAMPLE_RATE).toBeLessThanOrEqual(71);
    expect(cuts[1] / SAMPLE_RATE).toBeGreaterThanOrEqual(150);
    expect(cuts[1] / SAMPLE_RATE).toBeLessThanOrEqual(151);
    let prev = 0;
    for (const c of cuts) { expect(c - prev).toBeLessThanOrEqual(90 * SAMPLE_RATE); prev = c; }
  });

  it('still cuts continuous speech at the limit', () => {
    const cuts = segmentBoundaries(speech(100));
    expect(cuts.length).toBe(2);
    expect(cuts[0]).toBeLessThanOrEqual(90 * SAMPLE_RATE);
  });

  it('round-trips PCM through a WAV', () => {
    const pcm = speech(2);
    expect(Array.from(wavPcm(pcmToWav(pcm)))).toEqual(Array.from(pcm));
  });

  it('joins CJK without spaces and everything else with one', () => {
    // Test data: two CJK words ("hello", "world").
    expect(joinSegmentTexts(['\u4f60\u597d', '\u4e16\u754c'])).toBe('\u4f60\u597d\u4e16\u754c');
    expect(joinSegmentTexts(['hello', 'world', ''])).toBe('hello world');
    expect(joinSegmentTexts(['\u4f60\u597d', 'Walnut'])).toBe('\u4f60\u597d Walnut');
  });
});

// ── Pinned downloads against a local file server with Range support ──

let fileServer: http.Server;
let base = '';
const served = new Map<string, Buffer>();
const ranges: string[] = [];

beforeAll(async () => {
  fileServer = http.createServer((req, res) => {
    const body = served.get(req.url ?? '');
    if (!body) { res.writeHead(404).end(); return; }
    const range = req.headers.range;
    if (range) {
      ranges.push(range);
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      res.writeHead(206, { 'Content-Length': body.length - from }).end(body.subarray(from));
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => fileServer.close(() => r())));

function pinned(name: string, body: Buffer, hash = sha(body)): PinnedFile {
  served.set(`/${name}`, body);
  return { name, url: `${base}/${name}`, size: body.length, sha256: hash };
}

describe('downloadPinned', () => {
  it('downloads, verifies, and skips a file already verified', async () => {
    const dir = tmp();
    const body = Buffer.alloc(300_000, 7);
    const file = pinned('a.bin', body);
    const seen: number[] = [];
    await downloadPinned(file, path.join(dir, 'a.bin'), (b) => seen.push(b));
    expect(fs.readFileSync(path.join(dir, 'a.bin')).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(body.length);
    served.delete('/a.bin'); // a second call must not fetch
    await downloadPinned(file, path.join(dir, 'a.bin'), () => {});
  });

  it('refuses a file that does not match its hash and leaves nothing behind', async () => {
    const dir = tmp();
    const file = pinned('bad.bin', Buffer.alloc(1000, 1), 'f'.repeat(64));
    await expect(downloadPinned(file, path.join(dir, 'bad.bin'), () => {})).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects, never hangs or crashes, when the disk refuses the write', async () => {
    const dir = tmp();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    const file = pinned('w.bin', Buffer.alloc(200_000, 9));
    try {
      await expect(downloadPinned(file, path.join(locked, 'w.bin'), () => {})).rejects.toThrow(/EACCES|permission/i);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('resumes a partial download with a Range request', async () => {
    const dir = tmp();
    const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
    const file = pinned('r.bin', body);
    fs.writeFileSync(path.join(dir, 'r.bin.part'), body.subarray(0, 120_000));
    ranges.length = 0;
    await downloadPinned(file, path.join(dir, 'r.bin'), () => {});
    expect(ranges).toEqual(['bytes=120000-']);
    expect(fs.readFileSync(path.join(dir, 'r.bin')).equals(body)).toBe(true);
  });
});

describe('extractTarGz (no tar binary needed)', () => {
  it('unpacks directories, executable files and symlinks', async () => {
    const src = tmp();
    fs.mkdirSync(path.join(src, 'pkg'));
    fs.writeFileSync(path.join(src, 'pkg', 'bin'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'pkg', 'libx.so.1.2'), 'lib');
    fs.symlinkSync('libx.so.1.2', path.join(src, 'pkg', 'libx.so.1'));
    // A name past the 100 bytes of a plain header.
    const long = `${'n'.repeat(120)}.txt`;
    fs.writeFileSync(path.join(src, 'pkg', long), 'long');
    const archive = path.join(tmp(), 'a.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'pkg']);
    const out = tmp();
    await extractTarGz(archive, out);
    expect(fs.statSync(path.join(out, 'pkg', 'bin')).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(out, 'pkg', 'libx.so.1'))).toBe('libx.so.1.2');
    expect(fs.readFileSync(path.join(out, 'pkg', 'libx.so.1'), 'utf8')).toBe('lib');
    expect(fs.readFileSync(path.join(out, 'pkg', long), 'utf8')).toBe('long');
  });

  /** One ustar entry, hand-built so a hostile name can be tested. */
  function entry(name: string, type: string, body = '', link = ''): Buffer {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write(type, 156);
    h.write(link, 157);
    h.write('ustar\0', 257);
    h.write('        ', 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    data.write(body);
    return Buffer.concat([h, data]);
  }

  it.each([
    ['a path out of the destination', entry('../escape.txt', '0', 'x')],
    ['an absolute path', entry('/tmp/abs.txt', '0', 'x')],
    ['a link out of the destination', entry('pkg/evil', '2', '', '../../outside')],
    // Each step stays inside on paper; chained, they climb out.
    ['a link to a parent', entry('pkg/up', '2', '', '..')],
    ['a link into a subdirectory', entry('pkg/sub', '2', '', 'a/b')],
  ])('refuses %s', async (_name, e) => {
    const dir = tmp();
    const archive = path.join(dir, 'bad.tar.gz');
    fs.writeFileSync(archive, gzipSync(Buffer.concat([e, Buffer.alloc(1024)])));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await expect(extractTarGz(archive, out)).rejects.toThrow(/leaves the destination|absolute path/);
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false);
  });
});

// ── A stand-in llama-server ──

const FAKE_SERVER = `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const arg = (k) => args[args.indexOf(k) + 1];
const model = arg('-m'), port = Number(arg('--port'));
fs.appendFileSync(process.env.FAKE_LLAMA_SPAWNS, process.pid + ' ' + args.join(' ') + '\\n');
let n = 0;
setTimeout(() => http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  if (req.url === '/props') return res.end(JSON.stringify({ model_path: model }));
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    const audio = msg.messages.at(-1).content[0].input_audio.data;
    const sys = msg.messages[0].role === 'system' ? 'sys' : 'nosys';
    n++;
    res.end(JSON.stringify({ choices: [{ message: { content: 'language English<asr_text>seg' + n + ' ' + sys + ' ' + Buffer.from(audio, 'base64').length } }] }));
  });
}).listen(port, '127.0.0.1'), 300);
`;

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('installLlama', () => {
  it('installs the runtime archive and the model, then reports installed', async () => {
    const home = tmp();
    const stage = tmp();
    fs.mkdirSync(path.join(stage, 'llama-server'));
    fs.writeFileSync(path.join(stage, 'llama-server', 'llama-server'), FAKE_SERVER, { mode: 0o755 });
    const archive = path.join(tmp(), 'rt.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', stage, 'llama-server']);
    const saved = { rt: LLAMA_RUNTIME['linux-x64'], m: LLAMA_MODELS['0.6B'] };
    LLAMA_RUNTIME['linux-x64'] = pinned('rt.tar.gz', fs.readFileSync(archive));
    LLAMA_MODELS['0.6B'] = { model: pinned('m.gguf', Buffer.alloc(5000, 2)), mmproj: pinned('p.gguf', Buffer.alloc(3000, 3)) };
    try {
      expect(await isLlamaInstalled('linux-x64', '0.6B', home)).toBe(false);
      await installLlama('linux-x64', '0.6B', () => {}, undefined, home);
      expect(await isLlamaInstalled('linux-x64', '0.6B', home)).toBe(true);
      expect(fs.statSync(llamaServerPath(home)).mode & 0o111).not.toBe(0);
      expect(llamaServerPath(home)).toContain(LLAMA_TAG);
      // The archive is not kept once extracted.
      expect(fs.existsSync(path.join(home, 'downloads', 'rt.tar.gz'))).toBe(false);

      // Another size and an older runtime are removed by the next install: each is gigabytes.
      fs.writeFileSync(path.join(home, 'models', 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'old');
      fs.writeFileSync(path.join(home, 'models', 'Qwen3-ASR-1.7B-Q8_0.gguf.verified'), 'old');
      fs.mkdirSync(path.join(home, 'runtime', 'b1'), { recursive: true });
      served.clear(); // nothing is fetched again
      await installLlama('linux-x64', '0.6B', () => {}, undefined, home);
      expect(fs.readdirSync(path.join(home, 'models')).sort()).toEqual(['m.gguf', 'm.gguf.verified', 'p.gguf', 'p.gguf.verified']);
      expect(fs.readdirSync(path.join(home, 'runtime')).sort()).toEqual([LLAMA_TAG, `${LLAMA_TAG}.verified`]);
    } finally {
      LLAMA_RUNTIME['linux-x64'] = saved.rt;
      LLAMA_MODELS['0.6B'] = saved.m;
    }
  });
});

describe('llama-server engine', () => {
  let home = '';
  let spawns = '';
  const pids: number[] = [];

  beforeAll(() => {
    home = tmp();
    spawns = path.join(home, 'spawns.log');
    process.env.FAKE_LLAMA_SPAWNS = spawns;
    const bin = llamaServerPath(home);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, FAKE_SERVER, { mode: 0o755 });
    fs.writeFileSync(`${path.join(home, 'runtime', LLAMA_TAG)}.verified`, LLAMA_RUNTIME['linux-arm64'].sha256);
    const paths = llamaModelPaths('0.6B', home);
    fs.mkdirSync(path.dirname(paths.model), { recursive: true });
    for (const [p, f] of [[paths.model, LLAMA_MODELS['0.6B'].model], [paths.mmproj, LLAMA_MODELS['0.6B'].mmproj]] as const) {
      fs.writeFileSync(p, 'x');
      fs.writeFileSync(`${p}.verified`, f.sha256);
    }
  });
  afterAll(() => {
    for (const line of fs.existsSync(spawns) ? fs.readFileSync(spawns, 'utf8').trim().split('\n') : []) {
      pids.push(Number(line.split(' ')[0]));
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    delete process.env.FAKE_LLAMA_SPAWNS;
  });

  it('starts llama-server, splits long audio, and returns the joined text', async () => {
    const port = await freePort();
    const engine = createLlamaEngine({ size: '0.6B', target: 'linux-arm64', threads: 2, port, home });
    expect(await engine.isAvailable()).toEqual({ available: true });
    const wav = pcmToWav(speech(120, [60]));
    const res = await engine.transcribe({ audio: wav.toString('base64'), format: 'wav', prompt: 'Walnut' });
    const parts = res.text.split(' sys ');
    expect(res.text).toMatch(/^seg1 sys \d+ seg2 sys \d+$/);
    expect(parts.length).toBe(3);
    const spawnLines = fs.readFileSync(spawns, 'utf8').trim().split('\n');
    expect(spawnLines.length).toBe(1);
    expect(spawnLines[0]).toContain('-np 1');
    expect(spawnLines[0]).toContain('-c 8192');
    expect(spawnLines[0]).toContain('--sleep-idle-seconds');
    expect(fs.readFileSync(path.join(home, 'llama-server.pid'), 'utf8').trim()).toBe(spawnLines[0].split(' ')[0]);

    // The next server (a redeploy) adopts the running daemon instead of starting another.
    const next = createLlamaEngine({ size: '0.6B', target: 'linux-arm64', threads: 2, port, home });
    const again = await next.transcribe({ audio: pcmToWav(speech(3)).toString('base64'), format: 'wav' });
    expect(again.text).toMatch(/^seg3 nosys \d+$/);
    expect(fs.readFileSync(spawns, 'utf8').trim().split('\n').length).toBe(1);
  }, 30_000);

  it('serves concurrent requests one at a time, sharing one start', async () => {
    const port = await freePort();
    const engine = createLlamaEngine({ size: '0.6B', target: 'linux-arm64', threads: 2, port, home });
    const before = fs.readFileSync(spawns, 'utf8').trim().split('\n').length;
    const audio = pcmToWav(speech(2)).toString('base64');
    const results = await Promise.all([1, 2, 3].map(() => engine.transcribe({ audio, format: 'wav' })));
    expect(results.map((r) => r.text.split(' ')[0]).sort()).toEqual(['seg1', 'seg2', 'seg3']);
    expect(fs.readFileSync(spawns, 'utf8').trim().split('\n').length).toBe(before + 1);
  }, 30_000);

  it('says the model is not installed when files are missing', async () => {
    const engine = createLlamaEngine({ size: '1.7B', target: 'linux-arm64', threads: 2, port: await freePort(), home });
    const status = await engine.isAvailable();
    expect(status.available).toBe(false);
    expect(status.error).toContain('not installed');
  });
});
