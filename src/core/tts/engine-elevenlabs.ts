/**
 * ElevenLabs text-to-speech (https://elevenlabs.io/docs/api-reference/text-to-speech/stream).
 *
 * The streaming endpoint answers its first audio bytes in about 200 ms for
 * Flash v2.5 (measured 2026-11-21 from a us-west-2 host: 190 to 250 ms first byte,
 * about 300 ms for a whole sentence), so a client playing piece by piece starts
 * talking well under a second after the reply ends. Flash v2.5 costs half a
 * credit per character and reads Chinese, English and both mixed in one sentence.
 */

import { TtsError, type TtsAudio, type TtsEngine, type TtsRequest } from './types.js';

export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/** "Sarah", a premade voice every account has, verified for Chinese and English. */
export const ELEVENLABS_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';
const BASE_URL = 'https://api.elevenlabs.io';

export interface ElevenLabsConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  /** For tests: the API's address. */
  baseUrl?: string;
  /** For tests: the fetch to use. */
  fetchImpl?: typeof fetch;
}

/** The two-letter code ElevenLabs takes, only for a language it should hold to. */
function languageCode(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const code = language.split('-')[0]?.toLowerCase();
  // Chinese text carries English words ("CI", "build"): auto-detect reads them better
  // than a forced code, so only Japanese is pinned (kanji alone reads as Chinese).
  return code === 'ja' ? 'ja' : undefined;
}

export function createElevenLabsEngine(cfg: ElevenLabsConfig): TtsEngine {
  const model = cfg.model || ELEVENLABS_DEFAULT_MODEL;
  const voice = cfg.voice || ELEVENLABS_DEFAULT_VOICE;
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl ?? BASE_URL;
  return {
    id: 'elevenlabs',
    model,
    voice,
    async synthesize(req: TtsRequest): Promise<TtsAudio> {
      const body: Record<string, unknown> = { text: req.text, model_id: model };
      const code = languageCode(req.language);
      if (code) body.language_code = code;
      if (req.previousText) body.previous_text = req.previousText;
      if (req.nextText) body.next_text = req.nextText;
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw new TtsError('The voice request was cancelled', 499, 'tts_failed');
        throw new TtsError(`ElevenLabs could not be reached: ${err instanceof Error ? err.message : String(err)}`, 503, 'tts_unavailable');
      }
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw elevenLabsError(res.status, detail);
      }
      return { mime: res.headers.get('content-type') || 'audio/mpeg', body: res.body };
    },
  };
}

/** One readable sentence per failure, the API's own status word kept for the log. */
export function elevenLabsError(status: number, detail: string): TtsError {
  let word = '';
  try {
    const parsed = JSON.parse(detail) as { detail?: { status?: string; message?: string } | string };
    word = typeof parsed.detail === 'string' ? parsed.detail : `${parsed.detail?.status ?? ''} ${parsed.detail?.message ?? ''}`.trim();
  } catch { word = detail.slice(0, 200); }
  // ElevenLabs answers 401 for both a bad key and used-up credits: the words tell them apart.
  if (/quota/i.test(word) || status === 402) return new TtsError(`ElevenLabs credits are used up for this month (${word || 'quota exceeded'})`, 503, 'tts_quota');
  if (status === 401) return new TtsError(`ElevenLabs refused the API key (${word || 'unauthorized'})`, 503, 'tts_unavailable');
  if (status === 429) return new TtsError(`ElevenLabs is busy, try again (${word || 'too many requests'})`, 503, 'tts_unavailable');
  return new TtsError(`ElevenLabs answered ${status}${word ? `: ${word}` : ''}`, 502, 'tts_failed');
}
