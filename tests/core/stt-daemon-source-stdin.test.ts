/**
 * The mlx daemons receive their source over stdin, so a daemon restart never
 * depends on a file in tmp.
 *
 * Regression guard for 2026-09-15: the engine wrote server.py into ONE
 * `walnut-mlx-*` dir per server lifetime and reused the path on every daemon
 * restart. A disk-cleanup pass removed the dir (it looked like any other leaked
 * walnut temp entry), and every dictation for the rest of the day failed with
 * `ENOENT ... walnut-mlx-rqNKez/server.py` until the server was restarted.
 *
 * The fake "python" is a node script that speaks the interpreter's surface the
 * engines use (`-c code` for the import probe, `-` for a program on stdin) and
 * the daemon protocol (GET / health with its pid, POST /inference, /cleanup,
 * /shutdown). It refuses to serve unless the real embedded source actually
 * arrived on stdin, so a regression to "no source" fails loudly rather than
 * passing on a daemon that ignores its input.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, chmod, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { createMlxEngine } from '../../src/core/stt/engine-mlx.js';
import { cleanupTranscript } from '../../src/core/stt/cleanup-mlx.js';
import { isConformingWav } from '../../src/core/stt/audio-convert.js';
import type { SttEngine } from '../../src/core/stt/types.js';
import type { Config } from '../../src/core/types.js';
import { removeTempTree } from '../helpers/temp-home.js';

const ASR_MODEL = 'fake/asr-model';
const CLEANUP_MODEL = 'fake/cleanup-model';

let workDir: string;
let privateTmp: string;
let savedTmpdir: string | undefined;
let engine: SttEngine | null = null;
let cleanupPort: number | null = null;

/** 16kHz mono s16le WAV with a few silent samples: takes the no-ffmpeg path. */
function conformingWav(samples = 160): Buffer {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);      // PCM
  buf.writeUInt16LE(1, 22);      // mono
  buf.writeUInt32LE(16000, 24);  // sample rate
  buf.writeUInt32LE(32000, 28);  // byte rate
  buf.writeUInt16LE(2, 32);      // block align
  buf.writeUInt16LE(16, 34);     // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  return buf;
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

/** Resolves once nothing accepts on the port (the observable event, not a guessed sleep). */
async function waitForPortClosed(port: number, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (!open) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`port ${port} still accepting after ${deadlineMs}ms`);
}

async function daemonPid(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  return ((await res.json()) as { pid: number }).pid;
}

async function shutdownDaemon(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => {});
  await waitForPortClosed(port);
}

async function makeFakePython(): Promise<string> {
  const shim = join(workDir, 'fake-python');
  await writeFile(shim, [
    `#!${process.execPath}`,
    "import http from 'node:http';",
    'const [mode, model, port] = process.argv.slice(2);',
    // `python -c "import mlx_lm"`: the availability probe.
    "if (mode === '-c') process.exit(0);",
    "if (mode !== '-') { console.error(`unexpected argv[1] ${mode}`); process.exit(2); }",
    "let source = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { source += c; });",
    "process.stdin.on('end', () => {",
    // The genuine embedded program must have arrived, prologue included.
    "  if (!source.includes('ThreadingHTTPServer') || !source.includes('\"<stdin>\"')) { console.error('no program on stdin'); process.exit(2); }",
    '  http.createServer((req, res) => {',
    "    res.setHeader('Content-Type', 'application/json');",
    "    if (req.method === 'GET') { res.end(JSON.stringify({ status: 'ok', model, role: 'cleanup', pid: process.pid })); return; }",
    "    if (req.url === '/shutdown') { res.end('{\"ok\":true}'); setTimeout(() => process.exit(0), 20); return; }",
    "    let body = ''; req.on('data', (c) => { body += c; });",
    "    req.on('end', () => {",
    "      if (req.url === '/cleanup') { res.end(JSON.stringify({ text: JSON.parse(body).text })); return; }",
    "      res.end(JSON.stringify({ text: 'hello from fake daemon', engineMs: 1 }));",
    '    });',
    "  }).listen(Number(port), '127.0.0.1', () => console.log('READY'));",
    '});',
    // The real daemon has an idle TTL; this one must not outlive a hard-killed run.
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  await chmod(shim, 0o755);
  return shim;
}

async function tmpEntries(): Promise<string[]> {
  return readdir(privateTmp);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-stdin-daemon-test-'));
  // A private os.tmpdir(): the sweep below can be total without touching
  // anything another test (or the developer's machine) keeps in the real one.
  privateTmp = join(workDir, 'tmp');
  await mkdir(privateTmp);
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
});

afterEach(async () => {
  engine?.shutdown?.();
  engine = null;
  if (cleanupPort !== null) await shutdownDaemon(cleanupPort).catch(() => {});
  cleanupPort = null;
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  await removeTempTree(workDir);
});

describe('mlx ASR daemon fed over stdin', () => {
  it('restarts after the daemon died and tmp was swept, and never writes a script to tmp', async () => {
    const pythonPath = await makeFakePython();
    const port = await freePort();
    engine = createMlxEngine({ pythonPath, port, model: ASR_MODEL });
    const wav = conformingWav();
    expect(isConformingWav(wav)).toBe(true); // stays on the no-ffmpeg path
    const audio = wav.toString('base64');

    // Start 1: cold spawn. Nothing of ours may be left in tmp for a cleanup
    // pass to find (the request WAV is removed by the engine itself).
    const first = await engine.transcribe({ audio, format: 'wav' });
    expect(first.text).toBe('hello from fake daemon');
    const pid1 = await daemonPid(port);
    expect(await tmpEntries()).toEqual([]);

    // The daemon dies (idle TTL, crash, a redeploy's group kill...) and a temp
    // sweep removes everything, exactly the 2026-09-15 sequence.
    await shutdownDaemon(port);
    for (const entry of await tmpEntries()) await removeTempTree(join(privateTmp, entry));

    // Start 2 must spawn a NEW daemon and come back healthy. The unfixed engine
    // threw `ENOENT ... walnut-mlx-*/server.py` here.
    const second = await engine.transcribe({ audio, format: 'wav' });
    expect(second.text).toBe('hello from fake daemon');
    expect(await daemonPid(port)).not.toBe(pid1);
    expect(await tmpEntries()).toEqual([]);
  });

  it('reports an interpreter that dies before reading its program, without crashing on the pipe', async () => {
    const pythonPath = join(workDir, 'dying-python');
    await writeFile(pythonPath, '#!/bin/sh\necho "Traceback: ModuleNotFoundError: No module named mlx_audio" >&2\nexit 1\n');
    await chmod(pythonPath, 0o755);
    engine = createMlxEngine({ pythonPath, port: await freePort(), model: ASR_MODEL });

    await expect(engine.transcribe({ audio: conformingWav().toString('base64'), format: 'wav' }))
      .rejects.toThrow(/exited during startup/);
    expect(await tmpEntries()).toEqual([]);
  });
});

describe('cleanup daemon fed over stdin', () => {
  it('restarts after the daemon died, with nothing written to tmp', async () => {
    const pythonPath = await makeFakePython();
    cleanupPort = await freePort();
    const config = {
      stt: { mlx_python_path: pythonPath, cleanup_model: CLEANUP_MODEL, cleanup_port: cleanupPort },
    } as unknown as Config;

    // The fake echoes the text back; an unchanged transcript passes the guard.
    const first = await cleanupTranscript(config, 'hello there');
    expect(first).toMatchObject({ text: 'hello there', applied: true });
    const pid1 = await daemonPid(cleanupPort);
    expect(await tmpEntries()).toEqual([]);

    await shutdownDaemon(cleanupPort);

    const second = await cleanupTranscript(config, 'hello again');
    expect(second).toMatchObject({ text: 'hello again', applied: true });
    expect(await daemonPid(cleanupPort)).not.toBe(pid1);
    expect(await tmpEntries()).toEqual([]);
  });
});
