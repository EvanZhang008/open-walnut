/**
 * whisper.cpp local STT engine.
 *
 * Runs the whisper-cli binary with ffmpeg for audio conversion.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { log } from '../../logging/index.js';
import { convertToWav, cleanupTempFile, isFfmpegAvailable } from './audio-convert.js';
import { sttSpawnEnv } from './spawn-env.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

const execFileAsync = promisify(execFile);

interface WhisperCppConfig {
  binaryPath: string;   // path to whisper-cli or main binary
  modelPath: string;    // path to ggml model file
  vadModelPath?: string; // path to Silero VAD model — prevents hallucination during silence
  prompt?: string;       // domain words to bias decoder (max 224 tokens)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Resolve a binary name to its full path via `which`. Returns null if not found. */
async function resolveBinary(name: string): Promise<string | null> {
  // Already an absolute path
  if (name.startsWith('/')) return (await fileExists(name)) ? name : null;
  try {
    // Augmented PATH: under launchd/systemd the inherited PATH misses Homebrew.
    const { stdout } = await execFileAsync('which', [name], { timeout: 5000, env: sttSpawnEnv() });
    const resolved = stdout.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

export function createWhisperCppEngine(cfg: WhisperCppConfig): SttEngine {
  let resolvedBinaryPath: string | null = null;

  return {
    name: 'whisper-cpp',

    async isAvailable() {
      resolvedBinaryPath = await resolveBinary(cfg.binaryPath);
      if (!resolvedBinaryPath) {
        return { available: false, error: `whisper-cpp binary not found: ${cfg.binaryPath}` };
      }
      if (!(await fileExists(cfg.modelPath))) {
        return { available: false, error: `Model file not found: ${cfg.modelPath}` };
      }
      if (cfg.vadModelPath && !(await fileExists(cfg.vadModelPath))) {
        return { available: false, error: `VAD model not found: ${cfg.vadModelPath}` };
      }
      if (!(await isFfmpegAvailable())) {
        return { available: false, error: 'ffmpeg is required for audio conversion but not found' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();

      const wavPath = await convertToWav(req.audio, req.format);
      try {
        const args = [
          '-m', cfg.modelPath,
          '-f', wavPath,
          '--no-timestamps',
          '--max-context', '64',
          // Whispering-style noise suppression: reduce hallucination on silence/noise
          '--suppress-nst',
          '--no-speech-thold', '0.2',
        ];
        if (cfg.vadModelPath) {
          args.push('--vad', '--vad-model', cfg.vadModelPath);
        }
        const effectivePrompt = req.prompt || cfg.prompt;
        if (effectivePrompt) {
          args.push('--prompt', effectivePrompt);
        }
        // whisper-cli defaults to 'en' — pass 'auto' for multilingual auto-detect
        args.push('-l', req.language || 'auto');

        const bin = resolvedBinaryPath ?? cfg.binaryPath;
        log.stt.info(`Running whisper-cpp: ${bin} ${args.join(' ')}`);

        const { stdout } = await execFileAsync(bin, args, {
          timeout: 0,             // No timeout — whisper-cli is RAM-bounded (~115 MB/hr audio), not time-bounded.
          maxBuffer: 50 * 1024 * 1024,
        });

        const text = stdout.trim();
        return { text, durationMs: Date.now() - t0 };
      } finally {
        await cleanupTempFile(wavPath);
      }
    },
  };
}
