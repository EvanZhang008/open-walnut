/**
 * Qwen3-TTS on this Mac (mlx-audio), the local voice for Chinese pieces.
 *
 * Measured 2026-11-22 on an M4 Pro with the 0.6B CustomVoice 8-bit model: load
 * about 25 s, the first generate after it about 7 s (the daemon does that one
 * itself before it says ready), then 0.1 to 0.3 s to first audio and 0.3 to 0.7
 * of real time for the whole piece, about 2 GB resident.
 *
 * The daemon (qwen-daemon-script.ts) is the speech recognizer's kind
 * (src/core/stt/python-daemon.ts): a fixed port, adopted warm by the next
 * server, its own idle timer. A request never waits for a model load: while
 * the daemon loads (or when it is not up within a moment, the time an adopt
 * takes), synthesize() fails at once with `tts_unavailable` and the start goes
 * on in the background, so the piece is read by the fallback voice and a later
 * one by this one.
 *
 * With a fallback behind it the local voice has QWEN_BUDGET_MS for a piece, so
 * the fallback keeps its own full deadline; a piece too long to finish in that
 * (qwenFitsBudget) goes to the fallback at once.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { log } from '../../logging/index.js';
import { createPythonDaemon, type PythonDaemon } from '../stt/python-daemon.js';
import { isDaemonConnectionLost } from '../stt/daemon-health.js';
import { voiceOffHere } from '../stt/voice-here.js';
import { QWEN_TTS_PY, QWEN_TTS_REV } from './qwen-daemon-script.js';
import { TtsError, type TtsAudio, type TtsEngine, type TtsRequest } from './types.js';

export const QWEN_TTS_DEFAULT_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit';
/** A male speaker of standard Mandarin (Dylan reads Beijing dialect, Eric Sichuanese). */
export const QWEN_TTS_DEFAULT_VOICE = 'Uncle_Fu';
/** Next to the speech recognizer's 7893 and the cleanup daemon's 7894. */
export const QWEN_TTS_DEFAULT_PORT = 7895;
// About 2 GB held while it runs: it leaves after 10 idle minutes like the other daemons.
const IDLE_TTL_MS = 10 * 60 * 1000;
// Load plus warm-up is about 30 s; the weights are downloaded beforehand (qwen-setup.ts).
const STARTUP_TIMEOUT_MS = 180_000;
/** How long a request waits for a daemon that is not answering yet (an adopt takes a probe). */
const READY_WAIT_MS = 2_500;
/** The most a piece may take here when another voice stands behind this one. */
export const QWEN_BUDGET_MS = 8_000;
/**
 * Spoken Mandarin runs about 0.22 s of audio a character, and a piece is made at
 * about half of real time (0.3 to 0.7 measured), after about 0.3 s to start.
 */
const MS_PER_CHAR = 110;
const START_MS = 300;
/** Room left for the piece queued ahead and a slow moment. */
const BUDGET_MARGIN_MS = 1_000;

export interface QwenTtsConfig {
  pythonPath: string;
  model?: string;
  voice?: string;
  port?: number;
  /** Test seams. */
  readyWaitMs?: number;
  deadlineMs?: (text: string) => number;
  startupTimeoutMs?: number;
  idleTtlMs?: number;
}

export interface QwenTtsEngine extends TtsEngine {
  id: 'qwen';
  /** Load the model in the background; resolves when it is ready, rejects when it cannot start. */
  warmup(): Promise<void>;
  /** The daemon answers now (started or adopted, and not starting). */
  readonly ready: boolean;
  /** Why the last start failed, while no daemon runs; null otherwise. */
  readonly startError: string | null;
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  /**
   * Start (or adopt) the daemon and wait at most `waitMs`: true when it answers
   * by then, false while it loads (said at once, once a child was spawned).
   */
  readySoon(waitMs: number): Promise<boolean>;
  /** The speaker for the pieces from now on; the daemon stays (the voice rides each request). */
  setVoice(voice: string): void;
  /** Retire the daemon (its config changed, or the local voice was turned off). */
  shutdown(): void;
}

/** The deadline for one piece: the queue ahead (one piece) plus its own generation, with room. */
export function qwenDeadlineMs(text: string): number {
  return Math.min(15_000, 4_000 + text.length * 300);
}

/** About how long the local voice takes to make a piece. */
export function qwenEstimateMs(text: string): number {
  return START_MS + [...text].length * MS_PER_CHAR;
}

/** The piece can be made within the budget (about 60 Chinese characters at most). */
export function qwenFitsBudget(text: string): boolean {
  return qwenEstimateMs(text) <= QWEN_BUDGET_MS - BUDGET_MARGIN_MS;
}

export function createQwenTtsEngine(cfg: QwenTtsConfig, deps: { daemon?: PythonDaemon } = {}): QwenTtsEngine {
  const model = cfg.model || QWEN_TTS_DEFAULT_MODEL;
  let voice = cfg.voice || QWEN_TTS_DEFAULT_VOICE;
  const idleTtlMs = cfg.idleTtlMs ?? IDLE_TTL_MS;
  let inFlight = 0;
  // Waiters to release the moment a child is spawned: a model load is not worth waiting for.
  const spawnWaiters = new Set<() => void>();
  const daemon = deps.daemon ?? createPythonDaemon({
    label: 'tts daemon',
    pythonPath: cfg.pythonPath,
    model,
    port: cfg.port || QWEN_TTS_DEFAULT_PORT,
    rev: QWEN_TTS_REV,
    source: QWEN_TTS_PY,
    // The voice here only warms up; each request names its own.
    argv: (port) => [model, String(port), String(idleTtlMs / 1000), QWEN_TTS_REV, voice],
    startupTimeoutMs: cfg.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    isBusy: () => inFlight > 0,
    onSpawn: () => { for (const wake of spawnWaiters) wake(); },
  });
  let lastStartError: string | null = null;
  // A request found the daemon gone: not ready until a start or an answer says otherwise.
  let lost = false;

  /** Start (or join) the daemon in the background; the error is kept for the status line. */
  function startInBackground(): Promise<number> {
    const p = daemon.ensure();
    p.then(() => { lastStartError = null; lost = false; }, (err) => {
      lastStartError = err instanceof Error ? err.message : String(err);
      log.stt.warn(`tts daemon could not start: ${lastStartError}`);
    });
    return p;
  }

  /**
   * The daemon's port when it answers within `waitMs`, else null (it keeps
   * starting). A daemon loading its model is null at once: only an adopt or a
   * health probe is worth a wait.
   */
  async function portSoon(waitMs: number): Promise<number | null> {
    if (daemon.loading) return null;
    const started = startInBackground();
    let timer: NodeJS.Timeout | undefined;
    let wake!: () => void;
    const late = new Promise<null>((r) => { wake = () => r(null); timer = setTimeout(wake, waitMs); });
    spawnWaiters.add(wake);
    try {
      return await Promise.race([started.catch(() => null), late]);
    } finally {
      clearTimeout(timer);
      spawnWaiters.delete(wake);
    }
  }

  const deadlineFor = cfg.deadlineMs ?? qwenDeadlineMs;

  async function post(port: number, req: TtsRequest, id: string, ms: number): Promise<Response> {
    const deadline = AbortSignal.timeout(ms);
    const signal = req.signal ? AbortSignal.any([deadline, req.signal]) : deadline;
    try {
      return await fetch(`http://127.0.0.1:${port}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, voice, lang_code: 'zh', id, deadline_ms: ms }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        // The daemon keeps generating a piece it cannot see was dropped: tell it.
        void fetch(`http://127.0.0.1:${port}/cancel`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(1_000),
        }).catch(() => {});
        if (req.signal?.aborted) throw new TtsError('The voice request was cancelled', 499, 'tts_failed');
        throw new TtsError(`The local voice took longer than ${Math.round(ms / 1000)}s`, 503, 'tts_unavailable');
      }
      lost = true;
      if (isDaemonConnectionLost(err)) {
        // Gone (its idle timer, a crash): the next piece starts it again.
        void startInBackground().catch(() => {});
        throw new TtsError('The local voice is not running; it is starting again', 503, 'tts_unavailable');
      }
      throw new TtsError(`The local voice could not be reached: ${err instanceof Error ? err.message : String(err)}`, 503, 'tts_unavailable');
    }
  }

  return {
    id: 'qwen',
    model,
    get voice() { return voice; },
    fallbackBudgetMs: QWEN_BUDGET_MS,
    fitsBudget: qwenFitsBudget,

    get ready() { return daemon.port !== null && !daemon.starting && !lost; },
    get startError() { return daemon.port === null && !daemon.starting ? lastStartError : null; },

    async isAvailable() {
      const off = voiceOffHere();
      if (off) return { available: false, error: off };
      try {
        if (!(await stat(cfg.pythonPath)).isFile()) return { available: false, error: `Python interpreter not found: ${cfg.pythonPath}` };
      } catch {
        return { available: false, error: `Python interpreter not found: ${cfg.pythonPath}` };
      }
      if (lastStartError && daemon.port === null && !daemon.starting) return { available: false, error: lastStartError };
      return { available: true };
    },

    async warmup() {
      await startInBackground();
    },

    async readySoon(waitMs: number) {
      if (voiceOffHere()) return false;
      return (await portSoon(waitMs)) !== null;
    },

    setVoice(next: string) {
      voice = next || QWEN_TTS_DEFAULT_VOICE;
    },

    shutdown() {
      daemon.retire();
    },

    async synthesize(req: TtsRequest): Promise<TtsAudio> {
      const off = voiceOffHere();
      if (off) throw new TtsError(off, 503, 'tts_unavailable');
      const end = Date.now() + (req.deadlineMs ?? Infinity);
      const readyWait = cfg.readyWaitMs ?? READY_WAIT_MS;
      const port = await portSoon(Math.min(readyWait, Math.max(0, (end - Date.now()) / 2)));
      if (port === null) {
        throw new TtsError(lastStartError ? `The local voice could not start: ${lastStartError}` : 'The local voice is still loading', 503, 'tts_unavailable');
      }
      if (req.signal?.aborted) throw new TtsError('The voice request was cancelled', 499, 'tts_failed');
      // Its own deadline, within what the caller left it, so the daemon stops by itself in time.
      const ms = Math.min(deadlineFor(req.text), end - Date.now());
      if (ms <= 0) throw new TtsError('No time was left for the local voice', 503, 'tts_unavailable');
      const id = randomUUID();
      inFlight++;
      let res: Response;
      let bytes: ArrayBuffer;
      try {
        res = await post(port, req, id, ms);
        if (!res.ok) {
          let detail = '';
          try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not JSON */ }
          throw new TtsError(`The local voice answered ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 408 ? 503 : 502, res.status === 408 ? 'tts_unavailable' : 'tts_failed');
        }
        bytes = await res.arrayBuffer();
        lost = false;
      } catch (err) {
        if (err instanceof TtsError) throw err;
        if (req.signal?.aborted) throw new TtsError('The voice request was cancelled', 499, 'tts_failed');
        lost = true;
        throw new TtsError(`The local voice broke off: ${err instanceof Error ? err.message : String(err)}`, 503, 'tts_unavailable');
      } finally {
        inFlight--;
      }
      const audio = new Uint8Array(bytes);
      return {
        mime: res.headers.get('content-type') || 'audio/wav',
        body: new ReadableStream({ start(c) { c.enqueue(audio); c.close(); } }),
      };
    },
  };
}
