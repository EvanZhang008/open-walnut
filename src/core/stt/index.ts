/**
 * STT (Speech-to-Text) module entry point.
 *
 * Factory function creates the appropriate engine based on config.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import type { Config } from '../types.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';
import { resolveSecret } from '../../agent/providers/secret.js';
import { log } from '../../logging/index.js';
import { createSherpaEngine } from './engine-sherpa.js';
import { createOpenAiEngine } from './engine-openai.js';
import { createWhisperCppEngine } from './engine-whisper-cpp.js';
import { createWhisperServerEngine } from './engine-whisper-server.js';

export type { SttEngine, SttRequest, SttResult } from './types.js';

/** Create an STT engine from config. Returns null if not configured. */
export function createEngine(config: Config): SttEngine | null {
  const stt = config.stt;
  if (!stt?.engine) return null;

  switch (stt.engine) {
    case 'sherpa-onnx':
      return createSherpaEngine({
        modelDir: stt.sherpa_model_dir ?? '',
        modelType: stt.sherpa_model_type ?? 'sense_voice',
      });
    case 'openai':
      return createOpenAiEngine({
        apiKey: resolveSecret(stt.openai_api_key) ?? '',
        baseUrl: stt.openai_base_url,
        model: stt.openai_model,
      });
    case 'whisper-cpp':
      return createWhisperCppEngine({
        binaryPath: stt.whisper_cpp_path ?? 'whisper-cli',
        modelPath: stt.whisper_cpp_model ?? '',
        vadModelPath: stt.whisper_cpp_vad_model,
        prompt: stt.whisper_cpp_prompt,
      });
    case 'whisper-server':
      return createWhisperServerEngine({
        binaryPath: stt.whisper_server_path ?? 'whisper-server',
        modelPath: stt.whisper_server_model ?? stt.whisper_cpp_model ?? '',
        vadModelPath: stt.whisper_server_vad_model ?? stt.whisper_cpp_vad_model,
        prompt: stt.whisper_server_prompt ?? stt.whisper_cpp_prompt,
        port: stt.whisper_server_port,
        idleTtlMs: stt.whisper_server_idle_ttl_minutes
          ? stt.whisper_server_idle_ttl_minutes * 60_000
          : undefined,
      });
    default:
      log.stt.warn(`Unknown STT engine: ${stt.engine}`);
      return null;
  }
}

// ── Engine singleton cache ──
//
// DESIGN DECISION: whisper-server spawns a background HTTP daemon (~1.6 GB RAM)
// that keeps the model loaded in GPU memory for fast repeat transcriptions.
// Creating a new engine per request would spawn MULTIPLE daemons — each one
// allocates ~1.6 GB, and 10+ concurrent instances will OOM-crash the machine.
//
// The singleton ensures exactly ONE daemon process exists at any time:
//   1. `configKey()` fingerprints the engine type + model path.
//   2. `getOrCreateEngine()` returns the cached engine if the key matches.
//   3. When config changes (user switches engine or model), the OLD engine's
//      `shutdown()` is called first to kill the daemon before creating a new one.
//
// This pattern also benefits whisper-cpp (avoids redundant binary resolution)
// and openai (reuses the same HTTP client), though the stakes are lower there.

let cachedEngine: SttEngine | null = null;
let cachedEngineKey = '';

function configKey(config: Config): string {
  const s = config.stt;
  if (!s?.engine) return '';
  // Note: prompt is NOT in the key — vocab is loaded per-request from stt-vocab.txt, no engine restart needed.
  return `${s.engine}|${s.whisper_server_path ?? ''}|${s.whisper_server_model ?? ''}|${s.whisper_server_port ?? ''}|${s.whisper_cpp_path ?? ''}|${s.whisper_cpp_model ?? ''}|${s.openai_api_key ?? ''}|${s.sherpa_model_dir ?? ''}`;
}

export function getOrCreateEngine(config: Config): SttEngine | null {
  const key = configKey(config);
  if (cachedEngine && cachedEngineKey === key) return cachedEngine;

  // Config changed — shut down the old engine to release resources (e.g. kill daemon)
  if (cachedEngine?.shutdown) {
    log.stt.info(`STT config changed — shutting down previous ${cachedEngine.name} engine`);
    cachedEngine.shutdown();
  }

  cachedEngine = createEngine(config);
  cachedEngineKey = key;
  return cachedEngine;
}

// ── Vocabulary file ──
// <data dir>/stt-vocab.txt — one word per line, # comments.
// Read on each transcription so edits take effect immediately.
// Derived from WALNUT_HOME (NOT a hardcoded homedir join) so ephemeral
// servers and tests with a redirected data dir never touch the real file.
const VOCAB_PATH = join(WALNUT_HOME, 'stt-vocab.txt');

async function loadVocabPrompt(): Promise<string> {
  try {
    const raw = await readFile(VOCAB_PATH, 'utf-8');
    const words = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    return words.join(', ');
  } catch {
    return '';
  }
}

/** Transcribe audio using the configured engine. */
export async function transcribeAudio(config: Config, req: SttRequest): Promise<SttResult> {
  const engine = getOrCreateEngine(config);
  if (!engine) {
    throw new Error('No STT engine configured. Go to Settings → Speech-to-Text to set one up.');
  }

  const { available, error } = await engine.isAvailable();
  if (!available) {
    throw new Error(`STT engine "${engine.name}" is not available: ${error}`);
  }

  // Load vocab file as prompt (per-request, no restart needed)
  if (!req.prompt) {
    const vocab = await loadVocabPrompt();
    if (vocab) req = { ...req, prompt: vocab };
  }

  log.stt.info(`Transcribing with ${engine.name} (format=${req.format}, lang=${req.language ?? 'auto'}, prompt=${req.prompt ? req.prompt.length + ' chars' : 'none'})`);
  const result = await engine.transcribe(req);
  log.stt.info(`Transcription complete: ${result.text.length} chars in ${result.durationMs}ms`);
  return result;
}
