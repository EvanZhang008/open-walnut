/**
 * Qwen3-ASR on the CPU through llama.cpp's llama-server (Linux servers, the
 * cloud companion first among them).
 *
 * llama-server loads the GGUF model plus its audio projector and answers
 * OpenAI-style chat completions whose user turn carries the WAV as `input_audio`.
 * The vocabulary prompt goes in as the system message, which is where Qwen3-ASR
 * reads context. The model writes `language <Name><asr_text><text>`; only the
 * text after the tag is returned.
 *
 * Lifecycle, shaped by how the companion runs: its systemd unit uses
 * KillMode=process, so a child outlives every redeploy. The daemon therefore sits
 * on a fixed port and the next server ADOPTS it (checked through `/props`, which
 * names the model file) instead of starting a second one. Its own
 * `--sleep-idle-seconds` unloads the model when nobody has spoken for a while, so
 * an idle daemon holds next to no memory and the next request reloads it (about
 * 2 s for 0.6B on two cores, measured 2026-10-24). `warmup()` reloads it on
 * purpose: a take being recorded asks for it, so the load is done before the
 * user stops speaking. The pid is written beside the install so a daemon
 * for another model size can be retired.
 *
 * One request at a time (`-np 1`): every slot would otherwise get a fraction of
 * the context, and two cores gain nothing from overlap.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, rm, open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { convertToWav, cleanupTempFile } from './audio-convert.js';
import { isDaemonConnectionLost } from './daemon-health.js';
import { segmentBoundaries, wavPcm, pcmToWav, joinSegmentTexts, SAMPLE_RATE } from './wav-segment.js';
import { llamaHome, llamaServerPath, llamaModelPaths, isLlamaInstalled } from './llama-runtime.js';
import type { LlamaTarget, QwenSize } from './qwen-plan.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

export interface LlamaEngineConfig {
  size: QwenSize;
  target: LlamaTarget;
  threads: number;
  port?: number;
  /** Seconds idle before llama-server unloads the model. */
  sleepIdleSec?: number;
  /** Install root (tests point it at a temp dir). */
  home?: string;
}

export const DEFAULT_LLAMA_PORT = 7894;
const CONTEXT_TOKENS = 8192;
// A cold load is ~8 s (0.6B) to ~22 s (1.7B) on two Graviton cores; leave room
// for a busy machine.
const STARTUP_TIMEOUT_MS = 180_000;

/** Strip the `language X<asr_text>` header Qwen3-ASR writes before the text. */
export function stripAsrHeader(raw: string): string {
  const i = raw.indexOf('<asr_text>');
  const text = i >= 0 ? raw.slice(i + '<asr_text>'.length) : raw.replace(/^language\s+\S+\s*/i, '');
  return text.replace(/<\/?asr_text>/g, '').trim();
}

/** Output budget for a segment: generous for dense speech, tight enough to end a repetition loop. */
export function maxTokensFor(seconds: number): number {
  return Math.max(256, Math.min(Math.round(seconds * 32) + 128, 4096));
}

export function createLlamaEngine(cfg: LlamaEngineConfig): SttEngine {
  const home = cfg.home ?? llamaHome();
  // The env override is for a second, isolated server on the same box (tests);
  // give it its own WALNUT_STT_LLAMA_HOME too, so the pid files stay apart.
  const envPort = Number(process.env.WALNUT_STT_LLAMA_PORT);
  const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_LLAMA_PORT);
  const paths = llamaModelPaths(cfg.size, home);
  const pidFile = join(home, 'llama-server.pid');
  let child: ChildProcess | null = null;
  let ready = false;
  let starting: Promise<void> | null = null;
  // Serializes requests so each one's timeout starts when it reaches the model.
  let queue: Promise<unknown> = Promise.resolve();

  async function probe(): Promise<'ours' | 'loading' | 'other-model' | 'foreign' | 'none'> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(3_000) });
      if (res.status === 503) return 'loading';
      if (!res.ok) return 'foreign';
      const props = await res.json() as { model_path?: string };
      if (typeof props.model_path !== 'string') return 'foreign';
      return props.model_path === paths.model ? 'ours' : 'other-model';
    } catch (err) {
      return isDaemonConnectionLost(err) ? 'none' : 'foreign';
    }
  }

  async function retireByPidFile(): Promise<void> {
    const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
    if (!pid) return;
    // Only signal a pid that is still THIS install's llama-server: pids are
    // reused, and another Walnut on the box has an install of its own.
    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (!cmd.split('\0').includes(llamaServerPath(home))) return;
    log.stt.info(`Retiring llama-server pid=${pid} (another model)`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 50 && (await probe()) !== 'none'; i++) await new Promise(r => setTimeout(r, 200));
  }

  async function waitHealthy(deadline: number, proc: ChildProcess | null): Promise<void> {
    let exited = false;
    proc?.once('exit', () => { exited = true; });
    while (Date.now() < deadline) {
      if (exited) throw new Error('llama-server exited during startup');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`llama-server did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  async function start(): Promise<void> {
    const found = await probe();
    if (found === 'ours' || found === 'loading') {
      if (found === 'loading') await waitHealthy(Date.now() + STARTUP_TIMEOUT_MS, null);
      log.stt.info(`Adopted llama-server on :${port} (${cfg.size})`);
      ready = true;
      return;
    }
    if (found === 'other-model') await retireByPidFile();
    if (found === 'foreign' || (found === 'other-model' && (await probe()) !== 'none')) {
      throw new Error(`Port ${port} is held by another process; voice transcription cannot start`);
    }
    const args = [
      '-m', paths.model, '--mmproj', paths.mmproj,
      '--host', '127.0.0.1', '--port', String(port),
      '-t', String(Math.max(1, cfg.threads)), '-c', String(CONTEXT_TOKENS), '-np', '1',
      '--no-webui', '--sleep-idle-seconds', String(cfg.sleepIdleSec ?? 600), '-lv', '2',
    ];
    log.stt.info(`Starting llama-server ${cfg.size} on :${port} (${cfg.threads} threads)`);
    // Output goes to a file, never to a pipe: the daemon outlives this server, and
    // a write to a pipe nobody reads any more would kill it with SIGPIPE.
    await mkdir(home, { recursive: true });
    const logFile = join(home, 'llama-server.log');
    const out = await open(logFile, 'w');
    let proc: ChildProcess;
    try {
      // Detached in its own group so it outlives this server and the next one adopts it.
      proc = spawn(llamaServerPath(home), args, { stdio: ['ignore', out.fd, out.fd], detached: true, env: sttSpawnEnv() });
    } finally {
      await out.close();
    }
    proc.on('exit', (code, signal) => {
      log.stt.info(`llama-server exited (code=${code}, signal=${signal})`);
      if (child === proc) { child = null; ready = false; }
    });
    proc.on('error', (err) => log.stt.error(`llama-server spawn error: ${err.message}`));
    child = proc;
    if (proc.pid) {
      // It uses every core while it transcribes; a little below the server, so
      // the server's own requests still answer at once on a two-core box.
      try { os.setPriority(proc.pid, 5); } catch {}
      await writeFile(pidFile, String(proc.pid)).catch(() => {});
    }
    try {
      await waitHealthy(Date.now() + STARTUP_TIMEOUT_MS, proc);
    } catch (err) {
      const tail = (await readFile(logFile, 'utf8').catch(() => '')).split('\n');
      const why = tail.filter(l => /error|fail|cannot|unable/i.test(l)).slice(-3).join('; ');
      try { proc.kill('SIGTERM'); } catch {}
      child = null;
      await rm(pidFile, { force: true });
      throw new Error(`${err instanceof Error ? err.message : String(err)}${why ? `: ${why}` : ''}`);
    }
    proc.unref();
    ready = true;
    log.stt.info(`llama-server ready on :${port} (pid=${proc.pid})`);
  }

  async function ensureRunning(): Promise<void> {
    if (starting) return starting;
    if (ready && (await probe()) !== 'none') return;
    ready = false;
    starting = start().finally(() => { starting = null; });
    return starting;
  }

  async function askSegment(wav: Buffer, seconds: number, prompt: string | undefined, signal?: AbortSignal): Promise<string> {
    const messages: unknown[] = [];
    if (prompt) messages.push({ role: 'system', content: prompt });
    messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] });
    // 0.6B runs at ~0.6x realtime on two cores; allow 4x plus a cold reload.
    const timeout = AbortSignal.timeout(Math.round(60_000 + seconds * 4_000));
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0, max_tokens: maxTokensFor(seconds) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`llama-server returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return stripAsrHeader(json.choices?.[0]?.message?.content ?? '');
  }

  async function transcribeSerial(req: SttRequest, t0: number): Promise<SttResult> {
    req.signal?.throwIfAborted();
    const wavPath = await convertToWav(req.audio, req.format);
    try {
      const pcm = wavPcm(await readFile(wavPath));
      const cuts = segmentBoundaries(pcm);
      const texts: string[] = [];
      let from = 0;
      for (const to of cuts) {
        const piece = pcm.subarray(from, to);
        const seconds = piece.length / SAMPLE_RATE;
        from = to;
        if (seconds < 0.2) continue;
        const wav = pcmToWav(piece);
        await ensureRunning();
        try {
          texts.push(await askSegment(wav, seconds, req.prompt, req.signal));
        } catch (err) {
          // The daemon went away under the request: bring it back and ask once more.
          if (req.signal?.aborted || !isDaemonConnectionLost(err)) throw err;
          log.stt.warn(`llama-server connection lost mid-request, retrying once`);
          ready = false;
          await ensureRunning();
          texts.push(await askSegment(wav, seconds, req.prompt, req.signal));
        }
      }
      return { text: joinSegmentTexts(texts), durationMs: Date.now() - t0 };
    } finally {
      await cleanupTempFile(wavPath);
    }
  }

  return {
    name: 'qwen',

    async isAvailable() {
      if (!(await isLlamaInstalled(cfg.target, cfg.size, home))) {
        const { getQwenSetupStatus } = await import('./auto-setup.js');
        return getQwenSetupStatus().state === 'installing'
          ? { available: false, error: 'The voice model is still being installed' }
          : { available: false, error: 'The voice model is not installed. Install it in Settings, Voice' };
      }
      return { available: true };
    },

    async warmup() {
      await ensureRunning();
      // Any task wakes a sleeping daemon; tokenizing a word is the cheapest one.
      await fetch(`http://127.0.0.1:${port}/tokenize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'a' }), signal: AbortSignal.timeout(30_000),
      }).then((res) => res.body?.cancel()).catch(() => {});
    },

    shutdown() {
      // Config changed: retire the daemon this server started; an adopted one
      // sleeps on its own idle timer.
      if (child) { try { child.kill('SIGTERM'); } catch {} }
      child = null;
      ready = false;
    },

    transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();
      const run = queue.then(() => transcribeSerial(req, t0));
      queue = run.catch(() => {});
      return run;
    },
  };
}
