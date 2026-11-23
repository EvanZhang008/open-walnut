/**
 * Voice output API client (src/web/routes/voice-v1.ts): which words voice mode
 * says, and the speech for each piece. The phone calls the same routes.
 */

import { apiGet, apiPost } from './client';
import { PcmFeed, parseL16 } from '../voice/pcm-feed';

/** `qwen`: the local voice on the Mac, for Chinese pieces only (the `local_chinese_voice` experiment). */
export type TtsEngineId = 'elevenlabs' | 'device' | 'qwen';

export interface VoiceStatus {
  /** The engine voice mode reads with. */
  engine: TtsEngineId;
  engines: {
    id: TtsEngineId; available: boolean; reason?: string; model?: string; voice?: string;
    /** The local voice: off, unsupported, not-chosen, setting-up, failed, loading, ready. */
    state?: string;
    languages?: string[];
    percent?: number;
  }[];
  /** A language read by another engine than `engine` (`zh: 'qwen'`), while that holds. */
  byLanguage?: Record<string, TtsEngineId>;
}

export interface SpokenReply {
  text: string;
  language: string;
  truncated: boolean;
  chunks: string[];
  /** Only when truncated: the rest-on-screen line that ends `text`. */
  rest?: string;
}

export function voiceStatus(): Promise<VoiceStatus> {
  return apiGet<VoiceStatus>('/api/v1/voice/status', undefined, { timeoutMs: 8000 });
}

/**
 * Voice mode opened: the server loads the local voice now (and sets it up the
 * first time), so the first Chinese sentence is not the one that waits. Answers
 * at once with the status; the load goes on in the background.
 */
export function warmUpVoice(): Promise<VoiceStatus> {
  return apiPost<VoiceStatus>('/api/v1/voice/warmup', {}, { timeoutMs: 8000 });
}

/**
 * What to say for a reply, or null when nothing in it can be said (only code, a table).
 * `piece`: the text is one part of an answer still streaming (no length budget, no rest line).
 * `language`: the language it is said in (the rest line follows it), instead of the one detected.
 */
export async function spokenReply(text: string, opts: { piece?: boolean; language?: string } = {}): Promise<SpokenReply | null> {
  const body = { text, ...(opts.piece ? { piece: true } : {}), ...(opts.language ? { language: opts.language } : {}) };
  const res = await apiPost<SpokenReply | { text: null }>('/api/v1/voice/spoken', body, { timeoutMs: 8000 });
  return res.text === null ? null : res as SpokenReply;
}

/**
 * A failed piece; `fallback` = the server has no voice now, the device should speak instead.
 * `code` is the route's error code (`tts_unavailable`, `tts_quota`, `tts_failed`), '' when none came.
 */
export class SpeakError extends Error {
  constructor(message: string, readonly status: number, readonly fallback: boolean, readonly code = '') {
    super(message);
    this.name = 'SpeakError';
  }
}

/**
 * How long a piece may take to start: the server gives the local voice up to 8 s
 * for its first audio and the voice behind it 20 s of its own
 * (src/core/tts/index.ts), with room. A streamed piece then plays as long as it
 * is made, under the run's own signal only.
 */
const SPEAK_TIMEOUT_MS = 30_000;

/**
 * The speech of one piece: whole bytes (a few KB of MP3, or WAV from the local
 * voice's cache), or a PcmFeed when the local voice streams it (`audio/L16`),
 * resolved at its first audio so playing can start before the piece is made.
 * A stream that ends before any audio fails like a failed request.
 */
export async function speakPiece(
  piece: { text: string; language?: string; previousText?: string; nextText?: string },
  signal?: AbortSignal,
  timeoutMs = SPEAK_TIMEOUT_MS,
): Promise<ArrayBuffer | PcmFeed> {
  // Not deadlineSignal: this deadline is called off at the first audio.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs);
  const limit = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const late = () => new SpeakError(`The voice did not start within ${Math.round(timeoutMs / 1000)}s`, 503, true, 'tts_unavailable');
  try {
    let res: Response;
    try {
      res = await fetch('/api/v1/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // stream: this client plays raw PCM as it comes; an older server ignores the field.
        body: JSON.stringify({ ...piece, stream: true }),
        signal: limit,
      });
    } catch (err) {
      if (deadline.signal.aborted && !signal?.aborted) throw late();
      throw err;
    }
    if (!res.ok) {
      let message = res.statusText;
      let code = '';
      try {
        const data = await res.json() as { error?: { code?: string; message?: string } };
        message = data.error?.message ?? message;
        code = data.error?.code ?? '';
      } catch { /* keep statusText */ }
      throw new SpeakError(message, res.status, res.status === 503 || code === 'tts_unavailable' || code === 'tts_quota', code);
    }
    const pcm = parseL16(res.headers.get('content-type'));
    if (!pcm || !res.body) {
      try {
        return await res.arrayBuffer();
      } catch (err) {
        if (deadline.signal.aborted && !signal?.aborted) throw late();
        throw err;
      }
    }
    const feed = new PcmFeed(res.body, pcm, limit);
    try {
      await feed.firstAudio;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (deadline.signal.aborted) throw late();
      throw new SpeakError(`The voice stream ended before any audio: ${err instanceof Error ? err.message : String(err)}`, 503, true, 'tts_unavailable');
    }
    return feed;
  } finally {
    // From the first audio on, only the run's own signal ends the piece.
    clearTimeout(timer);
  }
}
