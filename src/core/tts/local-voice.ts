/**
 * Which engine reads a Chinese piece, and the local voice (Qwen3-TTS) behind it.
 *
 * Only while the `local_chinese_voice` experiment is on; off, every piece is
 * read exactly as before. On: a zh* piece goes to `tts.zh_engine`, which is
 * `qwen` when unset on an Apple Silicon Mac (the experiment is the person's
 * pick) and today's engine elsewhere. The local voice is used once it is set up
 * (qwen-setup.ts) on a server that runs voice (voice-here.ts); until then, and
 * whenever it fails a piece, the piece is read by today's engine.
 */

import type { Config } from '../types.js';
import { experimentalEnabled } from '../experimental.js';
import { voiceOffHere } from '../stt/voice-here.js';
import { isAllowedMlxModel } from '../stt/setup-mlx.js';
import { DEFAULT_MLX_PORT } from '../stt/engine-mlx.js';
import { DEFAULT_CLEANUP_PORT } from '../stt/cleanup-mlx.js';
import { log } from '../../logging/index.js';
import {
  createQwenTtsEngine, QWEN_TTS_DEFAULT_MODEL, QWEN_TTS_DEFAULT_PORT, QWEN_TTS_DEFAULT_VOICE, type QwenTtsEngine,
} from './engine-qwen.js';
import {
  ensureQwenTtsSetup, getQwenTtsSetupStatus, isAppleSiliconHost, qwenTtsPython, qwenTtsSetupRefusal, type QwenTtsSetupStatus,
} from './qwen-setup.js';

export type ZhEngine = 'qwen' | 'elevenlabs' | 'device';

export function isChinese(language: string | undefined): boolean {
  return !!language && language.toLowerCase().startsWith('zh');
}

/** The engine a person chose for Chinese pieces, or null for "as every other piece". */
export function zhEngineChoice(config: Config, appleSilicon = isAppleSiliconHost()): ZhEngine | null {
  if (!experimentalEnabled(config.experimental, 'local_chinese_voice')) return null;
  const pick = config.tts?.zh_engine;
  if (pick === 'elevenlabs' || pick === 'device') return pick;
  return appleSilicon ? 'qwen' : null;
}

// A bad value is said once in the log, not on every status read.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.stt.warn(message);
}

/** The model: an mlx-community repo, as the download takes (its id reaches a child's argv), else the default. */
export function qwenModel(config: Config): string {
  const model = config.tts?.qwen_model;
  if (!model) return QWEN_TTS_DEFAULT_MODEL;
  if (isAllowedMlxModel(model)) return model;
  warnOnce(`tts.qwen_model ${JSON.stringify(String(model)).slice(0, 160)} is not an mlx-community model: using ${QWEN_TTS_DEFAULT_MODEL}`);
  return QWEN_TTS_DEFAULT_MODEL;
}

/** The daemon's port: 1024 to 65535 and none of the speech daemons' own, else the default. */
export function qwenPort(config: Config): number {
  const port = config.tts?.qwen_port;
  if (port === undefined || port === null) return QWEN_TTS_DEFAULT_PORT;
  const taken = [config.stt?.mlx_port || DEFAULT_MLX_PORT, config.stt?.cleanup_port || DEFAULT_CLEANUP_PORT, config.stt?.whisper_server_port];
  if (Number.isInteger(port) && port >= 1024 && port <= 65535 && !taken.includes(port)) return port;
  warnOnce(`tts.qwen_port ${JSON.stringify(port)} is outside 1024-65535 or a speech daemon's port: using ${QWEN_TTS_DEFAULT_PORT}`);
  return QWEN_TTS_DEFAULT_PORT;
}

// The engine, one per server

let current: { daemonKey: string; engine: QwenTtsEngine } | null = null;

/** The local voice engine for this config, kept across requests (its daemon stays warm). */
export function qwenEngineFor(config: Config, make: typeof createQwenTtsEngine = createQwenTtsEngine): QwenTtsEngine {
  const model = qwenModel(config);
  const voice = config.tts?.qwen_voice || QWEN_TTS_DEFAULT_VOICE;
  const port = qwenPort(config);
  const daemonKey = [qwenTtsPython(), model, port].join('|');
  if (current?.daemonKey === daemonKey) {
    // Another voice only: the voice rides each request, so the same daemon (even one still loading) reads it.
    if (current.engine.voice !== voice) current.engine.setVoice(voice);
    return current.engine;
  }
  // Another model or port: the warm daemon is stale.
  current?.engine.shutdown();
  current = { daemonKey, engine: make({ pythonPath: qwenTtsPython(), model, voice, port }) };
  return current.engine;
}

/** The local voice is no longer chosen (the experiment was turned off, another engine picked): its daemon retires. */
export function retireLocalVoiceUnlessChosen(config: Config, appleSilicon = isAppleSiliconHost()): void {
  if (!current || zhEngineChoice(config, appleSilicon) === 'qwen') return;
  log.stt.info('The local voice is no longer chosen: retiring its daemon');
  current.engine.shutdown();
  current = null;
}

/** Test hook. */
export function _resetLocalVoiceForTest(): void {
  current = null;
  warned.clear();
}

export interface LocalVoiceFacts {
  appleSilicon: boolean;
  setup: QwenTtsSetupStatus;
  /** Why this server runs no voice, or null. */
  voiceOff: string | null;
}

export function localVoiceFacts(): LocalVoiceFacts {
  return { appleSilicon: isAppleSiliconHost(), setup: getQwenTtsSetupStatus(), voiceOff: voiceOffHere() };
}

/** The local voice can read a Chinese piece now: chosen, set up for this model, voice allowed here. */
export function localVoiceUsable(config: Config, facts: LocalVoiceFacts): boolean {
  return zhEngineChoice(config, facts.appleSilicon) === 'qwen'
    && facts.setup.state === 'ready' && facts.setup.model === qwenModel(config) && !facts.voiceOff;
}

export type LocalVoiceState = 'off' | 'unsupported' | 'not-chosen' | 'setting-up' | 'failed' | 'loading' | 'ready';

export interface LocalVoiceStatus {
  id: 'qwen';
  available: boolean;
  reason?: string;
  model: string;
  voice: string;
  /** Where the local voice stands: off (experiment), setting up, loading the model, ready. */
  state: LocalVoiceState;
  /** The languages it reads. */
  languages: string[];
  /** Setup progress while it is setting up (0 to 100). */
  percent?: number;
}

/** The local voice's status line, from facts (no side effects). */
export function localVoiceStatus(config: Config, facts: LocalVoiceFacts, engine?: Pick<QwenTtsEngine, 'ready' | 'startError'> | null): LocalVoiceStatus {
  const base = { id: 'qwen' as const, model: qwenModel(config), voice: config.tts?.qwen_voice || QWEN_TTS_DEFAULT_VOICE, languages: ['zh'] };
  const no = (state: LocalVoiceState, reason: string, extra: Partial<LocalVoiceStatus> = {}): LocalVoiceStatus => ({ ...base, available: false, state, reason, ...extra });
  if (!experimentalEnabled(config.experimental, 'local_chinese_voice')) return no('off', 'Turn on the experiment "Local Chinese voice" in Settings to read Chinese with it');
  if (!facts.appleSilicon) return no('unsupported', 'Qwen3-TTS runs on a Mac with Apple Silicon');
  const choice = zhEngineChoice(config, facts.appleSilicon);
  if (choice !== 'qwen') return no('not-chosen', `Chinese is read with ${choice} (tts.zh_engine)`);
  if (facts.voiceOff) return no('unsupported', facts.voiceOff);
  const setup: QwenTtsSetupStatus = facts.setup.model === base.model ? facts.setup : { state: 'idle' };
  if (setup.state === 'failed') return no('failed', `Setting up the local voice failed: ${setup.error ?? 'unknown error'}`);
  if (setup.state === 'installing') {
    const percent = setup.percent ?? 0;
    return no('setting-up', `Setting up the local voice (${percent}%)`, { percent });
  }
  if (setup.state !== 'ready') {
    const refusal = qwenTtsSetupRefusal({ appleSilicon: facts.appleSilicon, voiceOff: facts.voiceOff });
    return no(refusal ? 'unsupported' : 'setting-up', refusal ?? 'The local voice is set up the first time voice mode opens');
  }
  if (engine?.startError) return no('failed', `The local voice could not start: ${engine.startError}`);
  return { ...base, available: true, state: engine?.ready ? 'ready' : 'loading' };
}

/** How long a warm-up waits before it answers: enough to adopt a warm daemon, never a model load. */
const WARM_ANSWER_WAIT_MS = 1_500;

/**
 * Get the local voice going when it is chosen: set it up when it is not yet,
 * and with `warm`, load the model. The setup and a model load run in the
 * background; with `warm` the promise waits a moment for a warm daemon to be
 * adopted, so the status that follows can name the voice. Never rejects.
 * Not chosen any more: the running daemon retires.
 */
export async function kickLocalVoice(config: Config, opts: { warm?: boolean; waitMs?: number } = {}): Promise<void> {
  const appleSilicon = isAppleSiliconHost();
  retireLocalVoiceUnlessChosen(config, appleSilicon);
  if (zhEngineChoice(config, appleSilicon) !== 'qwen') return;
  if (qwenTtsSetupRefusal({ appleSilicon })) return;
  const model = qwenModel(config);
  const setup = ensureQwenTtsSetup(model);
  if (opts.warm && setup.state === 'ready' && setup.model === model) {
    // Starts the load when nothing answers; a failure is logged by the engine and shown in the status.
    await qwenEngineFor(config).readySoon(opts.waitMs ?? WARM_ANSWER_WAIT_MS).catch(() => false);
  }
}
