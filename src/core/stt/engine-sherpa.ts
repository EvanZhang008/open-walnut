/**
 * sherpa-onnx local STT engine.
 *
 * Unified engine for SenseVoice, Whisper, Paraformer, and other sherpa-onnx models.
 * Uses sherpa-onnx-node npm package for native Node.js inference.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../logging/index.js';
import { convertToWav, cleanupTempFile, isFfmpegAvailable } from './audio-convert.js';
import { assertVoiceHere, voiceOffHere } from './voice-here.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

interface SherpaConfig {
  modelDir: string;
  modelType: 'sense_voice' | 'whisper' | 'paraformer';
  numThreads?: number;
}

// Lazily loaded recognizer (stays in memory after first load)
// Cache key includes both modelDir and modelType to avoid serving wrong recognizer on config change
let cachedRecognizer: unknown = null;
let cachedModelDir: string | null = null;
let cachedModelType: string | null = null;

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function buildRecognizerConfig(cfg: SherpaConfig) {
  const dir = cfg.modelDir;
  const numThreads = cfg.numThreads ?? 4;

  switch (cfg.modelType) {
    case 'sense_voice':
      return {
        modelConfig: {
          senseVoice: {
            model: join(dir, 'model.int8.onnx'),
            useInverseTextNormalization: 1,
          },
          tokens: join(dir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
        },
        featConfig: { sampleRate: 16000, featureDim: 80 },
      };
    case 'whisper':
      return {
        modelConfig: {
          whisper: {
            encoder: join(dir, 'encoder.int8.onnx'),
            decoder: join(dir, 'decoder.int8.onnx'),
          },
          tokens: join(dir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
        },
        featConfig: { sampleRate: 16000, featureDim: 80 },
      };
    case 'paraformer':
      return {
        modelConfig: {
          paraformer: { model: join(dir, 'model.int8.onnx') },
          tokens: join(dir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
        },
        featConfig: { sampleRate: 16000, featureDim: 80 },
      };
    default:
      log.stt.warn(`Unknown sherpa model type: ${cfg.modelType}, falling back to sense_voice config`);
      return {
        modelConfig: {
          senseVoice: {
            model: join(dir, 'model.int8.onnx'),
            useInverseTextNormalization: 1,
          },
          tokens: join(dir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
        },
        featConfig: { sampleRate: 16000, featureDim: 80 },
      };
  }
}

async function getRecognizer(cfg: SherpaConfig) {
  // The model loads into this process and stays there (voice-here.ts).
  assertVoiceHere();
  // Return cached if model dir and type haven't changed
  if (cachedRecognizer && cachedModelDir === cfg.modelDir && cachedModelType === cfg.modelType) {
    return cachedRecognizer;
  }

  let sherpa: typeof import('sherpa-onnx-node');
  try {
    sherpa = await import('sherpa-onnx-node');
  } catch {
    throw new Error('sherpa-onnx-node is not installed. Run: npm install sherpa-onnx-node');
  }

  const config = buildRecognizerConfig(cfg);
  log.stt.info(`Loading sherpa-onnx model from ${cfg.modelDir} (type: ${cfg.modelType})`);
  const t0 = Date.now();

  const recognizer = new (sherpa as any).OfflineRecognizer(config);

  log.stt.info(`sherpa-onnx model loaded in ${Date.now() - t0}ms`);
  cachedRecognizer = recognizer;
  cachedModelDir = cfg.modelDir;
  cachedModelType = cfg.modelType;
  return recognizer;
}

/** Read WAV file and extract float32 PCM samples (skipping 44-byte header) */
async function readWavSamples(wavPath: string): Promise<Float32Array> {
  const buf = await readFile(wavPath);
  // 44-byte offset is safe because convertToWav always writes minimal-header PCM WAV via ffmpeg -c:a pcm_s16le
  const dataOffset = 44;
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, (buf.byteLength - dataOffset) / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export function createSherpaEngine(cfg: SherpaConfig): SttEngine {
  return {
    name: 'sherpa-onnx',

    async isAvailable() {
      const off = voiceOffHere();
      if (off) return { available: false, error: off };
      if (!(await dirExists(cfg.modelDir))) {
        return { available: false, error: `Model directory not found: ${cfg.modelDir}` };
      }
      const tokensPath = join(cfg.modelDir, 'tokens.txt');
      if (!(await fileExists(tokensPath))) {
        return { available: false, error: `tokens.txt not found in ${cfg.modelDir}` };
      }
      if (!(await isFfmpegAvailable())) {
        return { available: false, error: 'ffmpeg is required for audio conversion but not found' };
      }
      try {
        await import('sherpa-onnx-node');
      } catch {
        return { available: false, error: 'sherpa-onnx-node npm package not installed' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      assertVoiceHere();
      const t0 = Date.now();

      // Convert to WAV for sherpa-onnx
      const wavPath = await convertToWav(req.audio, req.format);
      try {
        const samples = await readWavSamples(wavPath);
        const recognizer = await getRecognizer(cfg) as any;
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        // sherpa-onnx returns either a plain string or {text: string} depending on version
        const text = (typeof result === 'string' ? result : result?.text ?? '').trim();

        return { text, durationMs: Date.now() - t0 };
      } finally {
        await cleanupTempFile(wavPath);
      }
    },
  };
}
