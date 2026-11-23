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
 */

import type { Config } from '../types.js';
import { resolveSecret } from '../../model/providers/secret.js';
import { createElevenLabsEngine, ELEVENLABS_DEFAULT_MODEL, ELEVENLABS_DEFAULT_VOICE } from './engine-elevenlabs.js';
import { TtsError, type TtsAudio, type TtsEngine, type TtsEngineId, type TtsRequest } from './types.js';
import { registerMemoryHolder } from '../observability/memory-ledger.js';

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
  engines: TtsEngineStatus[];
}

function elevenLabsKey(config: Config): string | undefined {
  return resolveSecret(config.tts?.elevenlabs_api_key) || process.env.ELEVENLABS_API_KEY || undefined;
}

/** What each engine can do on this server, and which one is in use. */
export function ttsStatus(config: Config): TtsStatus {
  const key = elevenLabsKey(config);
  const elevenlabs: TtsEngineStatus = {
    id: 'elevenlabs',
    available: !!key,
    model: config.tts?.elevenlabs_model || ELEVENLABS_DEFAULT_MODEL,
    voice: config.tts?.elevenlabs_voice_id || ELEVENLABS_DEFAULT_VOICE,
    ...(key ? {} : { reason: 'No ElevenLabs API key in Settings' }),
  };
  const device: TtsEngineStatus = { id: 'device', available: true };
  // A cloud voice without its key falls back to the device's own voice rather than to silence.
  const engine: TtsEngineId = config.tts?.engine !== 'device' && key ? 'elevenlabs' : 'device';
  return { engine, engines: [elevenlabs, device] };
}

/** The server-side engine voice mode uses now, or null when the client speaks itself. */
export function serverEngine(config: Config, deps: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): TtsEngine | null {
  const status = ttsStatus(config);
  if (status.engine !== 'elevenlabs') return null;
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
