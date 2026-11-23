/**
 * Which voice reads a reply aloud, and the speech it made recently.
 *
 * `config.tts.engine` names the engine; unset means ElevenLabs when it has a key
 * and the client's own system voice (`device`) otherwise, so voice mode speaks on
 * a fresh install with nothing set up and sounds better once a key is added.
 *
 * Speech is cached by engine, model, voice and words: Replay, a second tab and the
 * phone reading the same answer cost one request, not three (a cloud voice is paid
 * per character).
 *
 * A Chinese piece can have an engine of its own (`tts.zh_engine`, the experimental
 * local voice: local-voice.ts); when that one fails a piece, the piece is read by
 * the engine every other piece uses, so voice mode never falls silent.
 */

import type { Config } from '../types.js';
import { resolveSecret } from '../../model/providers/secret.js';
import { createElevenLabsEngine, ELEVENLABS_DEFAULT_MODEL, ELEVENLABS_DEFAULT_VOICE } from './engine-elevenlabs.js';
import { TtsError, type TtsAudio, type TtsEngine, type TtsEngineId, type TtsRequest } from './types.js';
import { registerMemoryHolder } from '../observability/memory-ledger.js';
import {
  isChinese, kickLocalVoice, localVoiceFacts, localVoiceStatus, localVoiceUsable, qwenEngineFor, retireLocalVoiceUnlessChosen, zhEngineChoice,
  type LocalVoiceFacts, type LocalVoiceStatus,
} from './local-voice.js';
import { log } from '../../logging/index.js';

export { TtsError } from './types.js';
export type { TtsEngineId } from './types.js';

export interface TtsEngineStatus {
  id: TtsEngineId;
  available: boolean;
  /** Why it is not available, in one sentence. */
  reason?: string;
  model?: string;
  voice?: string;
}

export interface TtsStatus {
  /** The engine voice mode uses now. */
  engine: TtsEngineId;
  engines: Array<TtsEngineStatus | LocalVoiceStatus>;
  /** A language read by another engine than `engine` (`zh`: the local voice), while that holds. */
  byLanguage?: Record<string, TtsEngineId>;
}

function elevenLabsKey(config: Config): string | undefined {
  return resolveSecret(config.tts?.elevenlabs_api_key) || process.env.ELEVENLABS_API_KEY || undefined;
}

/** What each engine can do on this server, and which one is in use. */
export function ttsStatus(config: Config, facts: LocalVoiceFacts = localVoiceFacts()): TtsStatus {
  const key = elevenLabsKey(config);
  const elevenlabs: TtsEngineStatus = {
    id: 'elevenlabs',
    available: !!key,
    model: config.tts?.elevenlabs_model || ELEVENLABS_DEFAULT_MODEL,
    voice: config.tts?.elevenlabs_voice_id || ELEVENLABS_DEFAULT_VOICE,
    ...(key ? {} : { reason: 'No ElevenLabs API key in Settings' }),
  };
  const device: TtsEngineStatus = { id: 'device', available: true };
  const engine = usualEngineId(config);
  const qwen = localVoiceUsable(config, facts) ? qwenEngineFor(config) : null;
  const local = localVoiceStatus(config, facts, qwen);
  const zh = zhEngineFor(config, engine, facts, !!qwen?.ready);
  return { engine, engines: [elevenlabs, device, local], ...(zh !== engine ? { byLanguage: { zh } } : {}) };
}

/**
 * The engine a Chinese piece is read with now. The local voice is named only once
 * its model answers: while it loads, a client with no server voice of its own
 * (the device voice) would otherwise send it pieces it can only refuse.
 */
function zhEngineFor(config: Config, engine: TtsEngineId, facts: LocalVoiceFacts, localReady: boolean): TtsEngineId {
  const choice = zhEngineChoice(config, facts.appleSilicon);
  if (choice === 'qwen') return localReady ? 'qwen' : engine;
  if (choice === 'elevenlabs') return elevenLabsKey(config) ? 'elevenlabs' : 'device';
  return choice ?? engine;
}

/** The engine every piece uses unless its language has one of its own. */
function usualEngineId(config: Config): TtsEngineId {
  // A cloud voice without its key falls back to the device's own voice rather than to silence.
  return config.tts?.engine !== 'device' && elevenLabsKey(config) ? 'elevenlabs' : 'device';
}

function elevenLabsEngine(config: Config, deps: { fetchImpl?: typeof fetch; baseUrl?: string }): TtsEngine | null {
  const key = elevenLabsKey(config);
  if (!key) return null;
  return createElevenLabsEngine({
    apiKey: key,
    model: config.tts?.elevenlabs_model,
    voice: config.tts?.elevenlabs_voice_id,
    voiceZh: config.tts?.elevenlabs_voice_id_zh,
    ...deps,
  });
}

/** The server-side engine voice mode uses now, or null when the client speaks itself. */
export function serverEngine(config: Config, deps: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): TtsEngine | null {
  return usualEngineId(config) === 'elevenlabs' ? elevenLabsEngine(config, deps) : null;
}

/** The engine for a piece in `language`, and the one that reads it when that one fails. */
export interface PieceEngines {
  engine: TtsEngine | null;
  fallback: TtsEngine | null;
}

export function enginesFor(
  config: Config,
  language: string | undefined,
  deps: { fetchImpl?: typeof fetch; baseUrl?: string; facts?: LocalVoiceFacts } = {},
): PieceEngines {
  const { facts = localVoiceFacts(), ...elevenDeps } = deps;
  retireLocalVoiceUnlessChosen(config, facts.appleSilicon);
  const usual = (): TtsEngine | null => serverEngine(config, elevenDeps);
  if (!isChinese(language)) return { engine: usual(), fallback: null };
  const choice = zhEngineChoice(config, facts.appleSilicon);
  if (choice === 'device') return { engine: null, fallback: null };
  if (choice === 'elevenlabs') return { engine: elevenLabsEngine(config, elevenDeps), fallback: null };
  if (choice === 'qwen') {
    if (localVoiceUsable(config, facts)) return { engine: qwenEngineFor(config), fallback: usual() };
    // Not set up yet: say it the usual way, and get the setup going for the next one.
    void kickLocalVoice(config);
  }
  return { engine: usual(), fallback: null };
}

/** How long an engine may take to start answering a piece, each engine its own. */
export const SPEAK_DEADLINE_MS = 20_000;

/**
 * Speak one piece with its engine, and with the fallback when that one cannot
 * (unreachable, too slow, refused). A cancelled request is not retried.
 *
 * Each try has its own deadline: the engine gets its `fallbackBudgetMs` when a
 * fallback stands behind it (and a piece it cannot finish in that goes to the
 * fallback at once), and the fallback gets the whole `deadlineMs` of its own.
 */
export async function speakWithFallback(
  engines: PieceEngines,
  req: TtsRequest,
  deadlineMs = SPEAK_DEADLINE_MS,
): Promise<TtsAudio & { cached: boolean; engine: TtsEngine }> {
  const { engine, fallback } = engines;
  if (!engine) throw new TtsError('No voice engine on this server: the device speaks with its own voice', 503, 'tts_unavailable');
  if (fallback && engine.fitsBudget?.(req.text) === false) {
    log.web.info('tts piece too long for its engine\'s budget, the fallback reads it', { engine: engine.id, fallback: fallback.id, chars: req.text.length });
    return { ...(await speakWithin(fallback, req, deadlineMs)), engine: fallback };
  }
  const budget = fallback && engine.fallbackBudgetMs ? Math.min(deadlineMs, engine.fallbackBudgetMs) : deadlineMs;
  try {
    return { ...(await speakWithin(engine, req, budget)), engine };
  } catch (err) {
    if (!fallback || !(err instanceof TtsError) || err.status === 499 || req.signal?.aborted) throw err;
    log.web.warn('tts engine failed, the piece goes to the fallback', { engine: engine.id, fallback: fallback.id, code: err.code, message: err.message });
    return { ...(await speakWithin(fallback, req, deadlineMs)), engine: fallback };
  }
}

/**
 * `speak` that must start answering within `ms` (a streaming engine then goes on;
 * the caller's own signal still ends it). A try cut by its deadline is
 * `tts_unavailable`, never a cancel, so the fallback reads the piece.
 */
async function speakWithin(engine: TtsEngine, req: TtsRequest, ms: number): Promise<TtsAudio & { cached: boolean }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ms);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline.signal]) : deadline.signal;
  try {
    return await speak(engine, { ...req, signal, deadlineMs: ms });
  } catch (err) {
    if (deadline.signal.aborted && !req.signal?.aborted) {
      throw new TtsError(`The ${engine.id} voice did not answer within ${Math.round(ms / 1000)}s`, 503, 'tts_unavailable');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache ──

const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { mime: string; bytes: Uint8Array }>();
let cacheBytes = 0;
registerMemoryHolder({
  name: 'tts.speech',
  budgetBytes: CACHE_MAX_BYTES,
  read: () => ({ entries: cache.size, bytes: cacheBytes }),
});

function cacheKey(engine: TtsEngine, req: TtsRequest): string {
  return [engine.id, engine.model, engine.voiceFor?.(req.language) ?? engine.voice, req.language ?? '', req.text].join('\u0000');
}

function remember(key: string, mime: string, bytes: Uint8Array): void {
  if (bytes.byteLength > CACHE_MAX_BYTES / 4) return;
  const was = cache.get(key);
  if (was) { cacheBytes -= was.bytes.byteLength; cache.delete(key); }
  cache.set(key, { mime, bytes });
  cacheBytes += bytes.byteLength;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.bytes.byteLength;
    cache.delete(oldest);
  }
}

/** For tests. */
export function clearTtsCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/**
 * Speech for one piece: from the cache when these words were said recently,
 * else from the engine, passed on as it arrives and kept once it is whole.
 */
export async function speak(engine: TtsEngine, req: TtsRequest): Promise<TtsAudio & { cached: boolean }> {
  const key = cacheKey(engine, req);
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, hit);
    return { mime: hit.mime, cached: true, body: new ReadableStream({ start(c) { c.enqueue(hit.bytes); c.close(); } }) };
  }
  const audio = await engine.synthesize(req);
  const parts: Uint8Array[] = [];
  let size = 0;
  const keep = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      parts.push(chunk);
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      if (size === 0) return;
      const all = new Uint8Array(size);
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.byteLength; }
      remember(key, audio.mime, all);
    },
  });
  return { mime: audio.mime, cached: false, body: audio.body.pipeThrough(keep) };
}

export function isTtsError(err: unknown): err is TtsError {
  return err instanceof TtsError;
}
