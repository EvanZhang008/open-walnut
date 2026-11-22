/**
 * The mlx daemon's loop guard reaches the model through mlx-audio's own
 * logits-processor factory, and says when it could not.
 *
 * The real MLX_SERVER_PY runs here on the system python3 against a fake
 * `mlx_audio` package on PYTHONPATH. Its stub model behaves like qwen3_asr's
 * generate(): it asks sample_utils.make_logits_processors for processors only
 * when a repetition penalty is given, then drives them the way generate_step
 * does (the history grows by one token per step), with mx-like arrays. Left
 * alone it says three words and then one filler token until the token cap.
 * Env switches make the fake break the hook the two ways a newer mlx-audio
 * could: no factory at all, or a generate() that never calls it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { findPython3 } from '../../src/core/stt/setup-mlx.js';
import { MLX_SERVER_PY } from '../../src/core/stt/mlx-daemon-script.js';
import { STDIN_MAIN_PROLOGUE } from '../../src/core/stt/daemon-source.js';
import { createMlxEngine } from '../../src/core/stt/engine-mlx.js';
import { log } from '../../src/logging/index.js';
import type { SttEngine } from '../../src/core/stt/types.js';
import { removeTempTree } from '../helpers/temp-home.js';
import { optInToVoice } from '../helpers/voice-opt-in.js';

const SAMPLE_UTILS = `
import os
if os.environ.get("FAKE_NO_FACTORY") != "1":
    def make_logits_processors(logit_bias=None, repetition_penalty=None, repetition_context_size=20, **kwargs):
        return []
`;

const STT_UTILS = `
import os

class Arr:
    """The slice of mx.array the guard uses: ndim, shape, slicing, tolist, setitem."""
    def __init__(self, rows):
        self.rows = rows
    @property
    def ndim(self):
        return 2 if self.rows and isinstance(self.rows[0], list) else 1
    @property
    def shape(self):
        return (len(self.rows), len(self.rows[0])) if self.ndim == 2 else (len(self.rows),)
    def __getitem__(self, key):
        return Arr(self.rows[key])
    def tolist(self):
        return list(self.rows)
    def __setitem__(self, key, value):
        for row in self.rows:
            if key is Ellipsis:
                row[:] = [value] * len(row)
            else:
                row[key[1]] = value

WORDS, FILLER, OTHER, EOS, VOCAB = [1, 2, 3], 7, 8, 99, 100
LETTERS = {1: "a", 2: "b", 3: "c", 7: "m", 8: "x"}

class Out:
    def __init__(self, text, n):
        self.text, self.generation_tokens = text, n

class StubModel:
    def _eos_token_ids(self):
        return {EOS}

    def generate(self, audio, *, max_tokens=8192, repetition_penalty=None, repetition_context_size=100,
                 chunk_duration=1200.0, language=None, system_prompt=None, **kwargs):
        from mlx_audio.lm import sample_utils
        processors = None
        if repetition_penalty and os.environ.get("FAKE_SKIPS_FACTORY") != "1":
            processors = sample_utils.make_logits_processors(
                repetition_penalty=repetition_penalty, repetition_context_size=repetition_context_size)
        history, out = [500], []
        while len(out) < max_tokens:
            row = [0.0] * VOCAB
            row[WORDS[len(out)] if len(out) < len(WORDS) else FILLER] = 10.0
            row[OTHER], row[EOS] = 5.0, 1.0
            logits = Arr([row])
            for p in processors or []:
                logits = p(Arr(list(history)), logits)
            token = max(range(VOCAB), key=lambda t: logits.rows[0][t])
            if token == EOS:
                break
            out.append(token)
            history.append(token)
        return Out("".join(LETTERS[t] for t in out), len(out))

def load_model(model_id):
    return StubModel()
`;

const GUARDED_TEXT = `abc${'m'.repeat(12)}x${'m'.repeat(12)}`;

let python: string | null = null;
let workDir: string;
let privateTmp: string;
let savedEnv: Record<string, string | undefined>;
const procs: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function wavBytes(samples = 1600): Buffer {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(data, 40);
  return buf;
}

/** The real daemon script on the fake package; resolves once GET / answers. */
async function startDaemon(env: Record<string, string> = {}): Promise<{ port: number; stdout: () => string }> {
  const port = await freePort();
  const proc = spawn(python!, ['-', 'fake/model', String(port), '60', 'test-rev'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  procs.push(proc);
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stdin!.end(STDIN_MAIN_PROLOGUE + MLX_SERVER_PY);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { port, stdout: () => out };
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`daemon exited: ${out}`);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`daemon never answered: ${out}`);
}

async function health(port: number): Promise<{ loopGuard?: boolean; rev?: string }> {
  return (await fetch(`http://127.0.0.1:${port}/`)).json() as Promise<{ loopGuard?: boolean; rev?: string }>;
}

interface Reply { text: string; tokens: number; loopGuard: number | null; loopGuardOff?: string }
async function hear(port: number, extra: Record<string, unknown> = {}): Promise<Reply> {
  const wav = join(privateTmp, `take-${Date.now()}-${Math.random()}.wav`);
  await writeFile(wav, wavBytes());
  const res = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wav, ...extra }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<Reply>;
}

beforeAll(async () => { python = (await findPython3())?.path ?? null; });

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-loop-guard-hook-'));
  privateTmp = join(workDir, 'tmp');
  await mkdir(privateTmp);
  const pkg = join(workDir, 'site', 'mlx_audio');
  await mkdir(join(pkg, 'lm'), { recursive: true });
  await mkdir(join(pkg, 'stt'), { recursive: true });
  await writeFile(join(pkg, '__init__.py'), '');
  await writeFile(join(pkg, 'lm', '__init__.py'), '');
  await writeFile(join(pkg, 'lm', 'sample_utils.py'), SAMPLE_UTILS);
  await writeFile(join(pkg, 'stt', '__init__.py'), '');
  await writeFile(join(pkg, 'stt', 'utils.py'), STT_UTILS);
  savedEnv = { TMPDIR: process.env.TMPDIR, PYTHONPATH: process.env.PYTHONPATH };
  process.env.TMPDIR = privateTmp;
  process.env.PYTHONPATH = join(workDir, 'site');
});

afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
  await removeTempTree(workDir);
});

describe('mlx daemon loop guard, through the real script', () => {
  it('rides mlx-audio\'s factory, bans once, then ends the chunk; the text is the model\'s own', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon();
    expect(await health(port)).toMatchObject({ loopGuard: true, rev: 'test-rev' });

    const guarded = await hear(port);
    expect(guarded).toMatchObject({ text: GUARDED_TEXT, tokens: GUARDED_TEXT.length, loopGuard: 2 });

    // Turned off by the request: the stub loops to the token cap (1024 for a short take).
    const off = await hear(port, { loop_guard: false });
    expect(off).toMatchObject({ loopGuard: null, loopGuardOff: 'turned off by the request', tokens: 1024 });
    expect(off.text).toBe(`abc${'m'.repeat(1021)}`);
  }, 30_000);

  it('says so when mlx-audio has no factory to hook, and still hears', async (ctx) => {
    if (!python) ctx.skip();
    const { port, stdout } = await startDaemon({ FAKE_NO_FACTORY: '1' });
    expect(stdout()).toMatch(/loop guard not installed/);
    expect((await health(port)).loopGuard).toBe(false);
    const reply = await hear(port);
    expect(reply.loopGuard).toBeNull();
    expect(reply.loopGuardOff).toMatch(/make_logits_processors/);
    expect(reply.text).toBe(`abc${'m'.repeat(1021)}`);
  }, 30_000);

  it('says so when generate() never calls the factory, from that request on', async (ctx) => {
    if (!python) ctx.skip();
    const { port } = await startDaemon({ FAKE_SKIPS_FACTORY: '1' });
    expect((await health(port)).loopGuard).toBe(true); // not known before a generate
    const reply = await hear(port);
    expect(reply.loopGuard).toBeNull();
    expect(reply.loopGuardOff).toMatch(/hook never ran/);
    expect((await health(port)).loopGuard).toBe(false);
  }, 30_000);
});

describe('mlx engine logs what the loop guard did', () => {
  optInToVoice();
  let engine: SttEngine | null = null;
  afterEach(() => { engine?.shutdown?.(); engine = null; });

  async function transcribeTwice(env: Record<string, string>): Promise<string[]> {
    Object.assign(process.env, env);
    try {
      engine = createMlxEngine({ pythonPath: python!, port: await freePort(), model: 'fake/model' });
      const texts: string[] = [];
      for (let i = 0; i < 2; i++) texts.push((await engine.transcribe({ audio: wavBytes().toString('base64'), format: 'wav' })).text);
      return texts;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  }

  it('logs the steps it fired on', async (ctx) => {
    if (!python) ctx.skip();
    const info = vi.spyOn(log.stt, 'info');
    const warn = vi.spyOn(log.stt, 'warn');
    expect(await transcribeTwice({})).toEqual([GUARDED_TEXT, GUARDED_TEXT]);
    expect(info.mock.calls.filter(([m]) => /Loop guard fired on 2 decoding step/.test(String(m)))).toHaveLength(2);
    expect(warn.mock.calls.filter(([m]) => /without its loop guard/.test(String(m)))).toEqual([]);
  }, 40_000);

  it('warns once when the daemon runs without it', async (ctx) => {
    if (!python) ctx.skip();
    const warn = vi.spyOn(log.stt, 'warn');
    await transcribeTwice({ FAKE_NO_FACTORY: '1' });
    const warned = warn.mock.calls.filter(([m]) => /without its loop guard/.test(String(m)));
    expect(warned).toHaveLength(1);
    expect(String(warned[0][0])).toMatch(/make_logits_processors/);
  }, 40_000);
});
