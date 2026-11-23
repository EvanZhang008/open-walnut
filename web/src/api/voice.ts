/**
 * Voice output API client (src/web/routes/voice-v1.ts): which words voice mode
 * says, and the speech for each piece. The phone calls the same routes.
 */

import { apiGet, apiPost } from './client';
import { deadlineSignal } from '../utils/deadline-signal';

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
 * How long a piece may take: the server gives the local voice up to 8 s and the
 * voice behind it 20 s of its own (src/core/tts/index.ts), with room.
 */
const SPEAK_TIMEOUT_MS = 30_000;

/** The speech of one piece, whole (a piece is a sentence or two: a few KB of MP3, or WAV from the local voice). */
export async function speakPiece(
  piece: { text: string; language?: string; previousText?: string; nextText?: string },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await fetch('/api/v1/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(piece),
    signal: signal ? AbortSignal.any([signal, deadlineSignal(SPEAK_TIMEOUT_MS)]) : deadlineSignal(SPEAK_TIMEOUT_MS),
  });
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
  return res.arrayBuffer();
}
