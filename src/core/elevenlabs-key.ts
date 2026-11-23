/**
 * The user's ElevenLabs key: one account key, saved in Settings > Voice (`tts.elevenlabs_api_key`,
 * voice mode's reader) or in the ELEVENLABS_API_KEY environment variable. Voice Accuracy uses the
 * same key unless the user saved one of its own there (stt/compare/settings.ts).
 */
import type { Config } from './types.js';
import { resolveSecret } from '../model/providers/secret.js';

export function elevenLabsAccountKey(config: Config): string | undefined {
  return resolveSecret(config.tts?.elevenlabs_api_key) || process.env.ELEVENLABS_API_KEY || undefined;
}
