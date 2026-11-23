/**
 * The local voice sets itself up: the first time the `local_chinese_voice`
 * experiment is on (at boot, or when voice mode asks the status or warms up),
 * an Apple Silicon Mac installs mlx-audio into a Python env and downloads the
 * Qwen3-TTS model, in the background. No request waits for it; until it is
 * ready, Chinese is read by the voice it had before.
 *
 * The same installers as the speech recognizer (src/core/stt/setup-mlx.ts,
 * auto-setup.ts's uv), with an env of its own at
 * ~/.local/share/open-walnut/tts-mlx: the voice needs the newest mlx-audio,
 * and upgrading the recognizer's env under a working dictation would put the
 * person's voice input at risk for a feature they only try. The weights go to
 * the Hugging Face cache, where mlx-audio's loader looks.
 *
 * Never on an isolated server unless WALNUT_STT_AUTO_SETUP=1 opts it in
 * (voice-here.ts), never with WALNUT_STT_AUTO_SETUP=0. A failure waits out a
 * backoff before the next trigger tries again.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logging/index.js';
import type { SetupEvent } from '../stt/setup-stream.js';
import { voiceOffHere } from '../stt/voice-here.js';

export type QwenTtsSetupState = 'idle' | 'installing' | 'ready' | 'failed';

export interface QwenTtsSetupStatus {
  state: QwenTtsSetupState;
  model?: string;
  message?: string;
  percent?: number;
  error?: string;
  /** When a failed setup may try again (ISO). */
  retryAt?: string;
}

/** The voice's own env, beside the recognizer's (stt-mlx); outside the git-synced data dir. */
export function getTtsVenvDir(): string {
  return join(homedir(), '.local', 'share', 'open-walnut', 'tts-mlx');
}

export function qwenTtsPython(): string {
  return join(getTtsVenvDir(), 'bin', 'python');
}

export function isAppleSiliconHost(platform = process.platform, arch = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

/** The module the daemon loads its model with: a venv that imports it can run Qwen3-TTS. */
const TTS_MODULE = 'mlx_audio.tts.utils';
/** The oldest mlx-audio known to run Qwen3-TTS here (the voice was measured on it); an older env is upgraded. */
export const MIN_TTS_MLX_AUDIO = '0.6.1';

/** True when the env imports mlx-audio's TTS loader, new enough, and the model's weights are cached. */
export async function isQwenTtsInstalled(model: string, python = qwenTtsPython()): Promise<boolean> {
  const { pythonImportsMlxAudio, isHfModelCached } = await import('../stt/setup-mlx.js');
  // A first import after an install compiles the package: give it time.
  return await isHfModelCached(model) && await pythonImportsMlxAudio(python, 30_000, TTS_MODULE, MIN_TTS_MLX_AUDIO);
}

/** Forward a setup generator, failing on its error event. */
async function drain(gen: AsyncGenerator<SetupEvent>, onEvent: (e: SetupEvent) => void): Promise<void> {
  for await (const e of gen) {
    if (e.type === 'error') throw new Error(e.message ?? 'Setup failed');
    onEvent(e);
  }
}

/** Install the env and the model, reporting progress (the env is about a quarter of the work). */
export async function installQwenTts(model: string, onEvent: (e: SetupEvent) => void, signal?: AbortSignal): Promise<void> {
  const { setupMlxEnv, downloadMlxModel } = await import('../stt/setup-mlx.js');
  const { ensureUv } = await import('../stt/auto-setup.js');
  const uvPath = await ensureUv(signal);
  await drain(setupMlxEnv({ signal, uvPath, venvDir: getTtsVenvDir(), label: 'The local voice', minMlxAudio: MIN_TTS_MLX_AUDIO }), (e) =>
    onEvent(e.type === 'progress' ? { ...e, percent: Math.round((e.percent ?? 0) * 0.25) } : e));
  await drain(downloadMlxModel({ signal, model, python: qwenTtsPython(), label: 'Qwen3-TTS' }), (e) =>
    onEvent(e.type === 'progress' ? { ...e, percent: 25 + Math.round((e.percent ?? 0) * 0.75) } : e));
}

const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

let status: QwenTtsSetupStatus = { state: 'idle' };
let running: Promise<void> | null = null;
let failures = 0;

export function getQwenTtsSetupStatus(): QwenTtsSetupStatus {
  return { ...status };
}

export interface QwenTtsSetupOptions {
  /** Test seams. */
  appleSilicon?: boolean;
  installed?: (model: string) => Promise<boolean>;
  install?: (model: string, onEvent: (e: SetupEvent) => void) => Promise<void>;
  now?: () => number;
}

/** Why this server sets up no local voice, or null when it may. */
export function qwenTtsSetupRefusal(opts: { appleSilicon: boolean; voiceOff?: string | null; env?: NodeJS.ProcessEnv }): string | null {
  if (!opts.appleSilicon) return 'Qwen3-TTS runs on a Mac with Apple Silicon';
  if ((opts.env ?? process.env).WALNUT_STT_AUTO_SETUP === '0') return 'Voice setup is turned off on this server (WALNUT_STT_AUTO_SETUP=0)';
  return opts.voiceOff !== undefined ? opts.voiceOff : voiceOffHere();
}

/**
 * Make sure the model is (being) set up. Returns at once: the check and the
 * install run in the background, and `getQwenTtsSetupStatus` tells how far it is.
 * A model other than the one set up (a config change) starts again.
 */
export function ensureQwenTtsSetup(model: string, opts: QwenTtsSetupOptions = {}): QwenTtsSetupStatus {
  const now = opts.now ?? Date.now;
  if (running) return getQwenTtsSetupStatus();
  if (status.model === model && status.state === 'ready') return getQwenTtsSetupStatus();
  if (status.model === model && status.state === 'failed' && status.retryAt && now() < Date.parse(status.retryAt)) {
    return getQwenTtsSetupStatus();
  }
  const refusal = qwenTtsSetupRefusal({ appleSilicon: opts.appleSilicon ?? isAppleSiliconHost() });
  if (refusal) return { state: 'idle', model, message: refusal };
  if (status.model !== model) failures = 0;
  status = { state: 'installing', model, percent: 0, message: 'Checking the local voice' };
  const installed = opts.installed ?? ((m: string) => isQwenTtsInstalled(m));
  const install = opts.install ?? ((m: string, on: (e: SetupEvent) => void) => installQwenTts(m, on));
  running = (async () => {
    try {
      if (!(await installed(model))) {
        status = { ...status, message: 'Setting up the local voice' };
        log.stt.info(`Local voice setup: installing ${model}`);
        const t0 = now();
        await install(model, (e) => {
          if (e.type === 'progress') status = { ...status, percent: e.percent ?? status.percent, message: e.message ?? status.message };
        });
        log.stt.info(`Local voice setup: ${model} ready in ${Math.round((now() - t0) / 1000)}s`);
      }
      failures = 0;
      status = { state: 'ready', model, percent: 100, message: 'Local voice ready' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
      failures++;
      status = { state: 'failed', model, error, retryAt: new Date(now() + wait).toISOString() };
      log.stt.warn(`Local voice setup failed: ${error}; trying again after ${Math.round(wait / 60_000)} min`);
    }
  })().finally(() => { running = null; });
  return getQwenTtsSetupStatus();
}

/** Test hooks. */
export function _resetQwenTtsSetupForTest(): void {
  status = { state: 'idle' };
  running = null;
  failures = 0;
}

export function _qwenTtsSetupRunning(): Promise<void> | null {
  return running;
}
