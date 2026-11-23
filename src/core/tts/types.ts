/**
 * Text-to-speech engines: the voice that reads a reply aloud in voice mode.
 *
 * One engine interface for every client. The web and the phone ask the server
 * for speech (POST /api/v1/voice/speak) and play what comes back, so a new engine
 * (a local model, another cloud voice) is one file here and no client change.
 * `device` is the exception: the client speaks with its own system voice (the
 * browser's speechSynthesis, the phone's AVSpeechSynthesizer) and only asks the
 * server which words to say (POST /api/v1/voice/spoken).
 */

/**
 * The engines. `device` = the client's own system voice; `qwen` = Qwen3-TTS on
 * this Mac, only for Chinese pieces (`tts.zh_engine`, experimental).
 */
export const TTS_ENGINE_IDS = ['elevenlabs', 'device', 'qwen'] as const;
export type TtsEngineId = (typeof TTS_ENGINE_IDS)[number];

export interface TtsRequest {
  /** One speakable piece (a sentence or two), already plain text. */
  text: string;
  /** BCP-47 tag of the text ("zh-CN", "en-US"). */
  language?: string;
  /** The pieces said just before and after this one, for a voice that keeps its tone across pieces. */
  previousText?: string;
  nextText?: string;
  /** Ends the upstream request (the client went away, or the deadline passed). */
  signal?: AbortSignal;
  /** How long this engine may take for the piece, for one that tells its backend when to stop. */
  deadlineMs?: number;
}

export interface TtsAudio {
  /** The audio's MIME type ("audio/mpeg"). */
  mime: string;
  /** The audio bytes as they arrive, so the client can start playing before the end. */
  body: ReadableStream<Uint8Array>;
}

export interface TtsEngine {
  id: Exclude<TtsEngineId, 'device'>;
  /** Model and voice, for the status line and the cache key. */
  model: string;
  voice: string;
  /** The voice a piece in `language` is read with, when it differs by language (default `voice`). */
  voiceFor?(language?: string): string;
  /**
   * With another engine behind it: how long this one may take for a piece before
   * the other reads it instead, so the other keeps its own full deadline.
   */
  fallbackBudgetMs?: number;
  /** False for a piece it cannot finish within `fallbackBudgetMs`: the engine behind it reads it at once. */
  fitsBudget?(text: string): boolean;
  synthesize(req: TtsRequest): Promise<TtsAudio>;
}

/** An engine that is configured but cannot answer: `status` is the HTTP status the route answers. */
export class TtsError extends Error {
  constructor(message: string, readonly status: number, readonly code: 'tts_unavailable' | 'tts_failed' | 'tts_quota') {
    super(message);
    this.name = 'TtsError';
  }
}
