/** STT engine abstraction types */

export interface SttRequest {
  /** Base64-encoded audio data */
  audio: string;
  /** Audio format (webm, wav, mp3, etc.) */
  format: string;
  /** ISO 639-1 language hint. Empty/undefined = auto-detect. */
  language?: string;
  /** Domain vocabulary to bias decoder (e.g. "Kubernetes, TypeScript, Walnut"). */
  prompt?: string;
}

export interface SttResult {
  text: string;
  durationMs: number;
}

export interface SttEngine {
  readonly name: string;
  /** Check if this engine is available (model exists, binary found, etc.) */
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  /** Transcribe audio to text */
  transcribe(req: SttRequest): Promise<SttResult>;
  /**
   * Gracefully shut down this engine, releasing resources.
   * For daemon-based engines (whisper-server), this kills the background process.
   * Optional — engines that hold no persistent resources can omit this.
   */
  shutdown?(): void;
  /**
   * Load the model into memory ahead of the first transcription. For
   * daemon-based engines this starts the daemon so the first dictation skips
   * the multi-second cold start. Optional — one-shot engines omit it.
   */
  warmup?(): Promise<void>;
}
