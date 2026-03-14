/**
 * Text-to-speech tool using edge-tts (free, no API key needed).
 * Generates audio files saved to ~/.open-walnut/media/tts/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition } from '../tools.js';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const TTS_DIR = path.join(WALNUT_HOME, 'media', 'tts');
const DEFAULT_VOICE = 'en-US-AriaNeural';

function ensureTtsDir(): void {
  if (!fs.existsSync(TTS_DIR)) {
    fs.mkdirSync(TTS_DIR, { recursive: true });
  }
}

export const ttsTool: ToolDefinition = {
  name: 'tts',
  description:
    'Convert text to speech audio using edge-tts (free, no API key). Returns the path to the generated MP3 file.',
  input_schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to convert to speech',
      },
      voice: {
        type: 'string',
        description:
          'Voice name (default: en-US-AriaNeural). Examples: en-US-GuyNeural, en-GB-SoniaNeural, zh-CN-XiaoxiaoNeural',
      },
    },
    required: ['text'],
  },
  async execute(params) {
    const text = params.text as string;
    if (!text) return 'Error: text is required.';

    const voice = (params.voice as string) || DEFAULT_VOICE;

    try {
      // @ts-expect-error edge-tts has no type declarations
      const { ttsSave } = await import('edge-tts');
      ensureTtsDir();

      const hash = crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
      const timestamp = Date.now();
      const filename = `${timestamp}-${hash}.mp3`;
      const audioPath = path.join(TTS_DIR, filename);

      await ttsSave(text, audioPath, { voice });

      // Estimate duration: ~150 words per minute, ~5 chars per word
      const wordCount = text.split(/\s+/).length;
      const durationEstimate = Math.round((wordCount / 150) * 60);

      log.agent.info('tts generated', { voice, textLength: text.length, audioPath });
      return json({
        audio_path: audioPath,
        voice,
        text_length: text.length,
        duration_estimate_seconds: durationEstimate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.error('tts error', { error: msg });
      return `Error: TTS conversion failed — ${msg}`;
    }
  },
};
