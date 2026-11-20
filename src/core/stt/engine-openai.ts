/**
 * OpenAI-compatible STT engine.
 *
 * Works with OpenAI, Groq, Fireworks AI, and any provider
 * that implements the /v1/audio/transcriptions endpoint.
 *
 * Not gated by voice-here.ts on an isolated server: it starts no local process,
 * loads no model and records nothing, and the isolation rule is about this
 * machine's memory, processes and microphone. A key copied with the data home
 * still makes real calls, as a copied plugin's settings do.
 */

import { log } from '../../logging/index.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';
import { audioForUpload } from './audio-convert.js';

/** The transcription API's upload limit is 25 MB; a repaired WAV past this keeps the original. */
const OPENAI_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

interface OpenAiSttConfig {
  apiKey: string;
  baseUrl?: string;  // default: https://api.openai.com/v1
  model?: string;    // default: whisper-1
}

export function createOpenAiEngine(cfg: OpenAiSttConfig): SttEngine {
  const baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.model ?? 'whisper-1';

  return {
    name: 'openai',

    async isAvailable() {
      if (!cfg.apiKey) {
        return { available: false, error: 'API key not configured' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();

      // The original bytes, or the repaired WAV when the recording needed it
      // (wav-repair.ts) and it stays under the API's 25 MB upload limit.
      const { audio: audioBuffer, format } = await audioForUpload(req.audio, req.format, OPENAI_UPLOAD_MAX_BYTES);
      const mimeType = `audio/${format}`;

      const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, `audio.${format}`);
      formData.append('model', model);
      if (req.language) {
        formData.append('language', req.language);
      }

      const url = `${baseUrl}/audio/transcriptions`;
      log.stt.info(`POST ${url} (model=${model}, size=${audioBuffer.length})`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`OpenAI STT ${res.status}: ${errText}`);
      }

      const data = await res.json() as { text: string };
      return { text: (data.text ?? '').trim(), durationMs: Date.now() - t0 };
    },
  };
}
