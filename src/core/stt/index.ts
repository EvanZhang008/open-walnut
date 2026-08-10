/**
 * STT (Speech-to-Text) module entry point.
 *
 * Factory function creates the appropriate engine based on config.
 */

import fs from 'node:fs';
import { readFile, rename, copyFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WALNUT_HOME, STT_VOCAB_FILE } from '../../constants.js';
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
// config/share/stt-vocab.txt — one word per line, # comments.
// Read on each transcription so edits take effect immediately.
// STT_VOCAB_FILE is derived from WALNUT_HOME (NOT a hardcoded homedir join), so
// ephemeral servers and tests with a redirected data dir never touch the real
// file. It lives under config/share/ because a user's proper nouns are the same
// on every device — see the constant's doc comment.

/** Pre-2026-08 location (WALNUT_HOME root, before config/share/ existed). */
const LEGACY_VOCAB_PATH = join(WALNUT_HOME, 'stt-vocab.txt');

let vocabMigration: Promise<void> | null = null;

/**
 * One-time move of the root stt-vocab.txt into config/share/. A plain move —
 * unlike ui-prefs, every line here is portable.
 *
 * Same shape as migrateLegacyMemoryFile() in core/init.ts: only when the old
 * path exists AND the new one doesn't, memoized per process, never throws (a
 * failed move degrades to "no custom vocabulary this transcription", never to a
 * failed transcription). Awaited from the reader rather than run at import time
 * so a test with a redirected WALNUT_HOME still gets its own pass.
 */
async function migrateLegacyVocab(): Promise<void> {
  try {
    if (!fs.existsSync(LEGACY_VOCAB_PATH) || fs.existsSync(STT_VOCAB_FILE)) return;
    await mkdir(dirname(STT_VOCAB_FILE), { recursive: true });
    try {
      await rename(LEGACY_VOCAB_PATH, STT_VOCAB_FILE);
    } catch {
      // EXDEV (separate filesystems) — copy, then drop the original only once
      // the copy landed.
      await copyFile(LEGACY_VOCAB_PATH, STT_VOCAB_FILE);
      await rm(LEGACY_VOCAB_PATH, { force: true });
    }
    log.stt.info('Migrated stt-vocab.txt into config/share/');
  } catch (err) {
    log.stt.warn('stt-vocab migration into config/share/ failed (retried on next access)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Await before the first read/write of the vocab file. Runs at most once per process. */
export function ensureSttVocabMigrated(): Promise<void> {
  vocabMigration ??= migrateLegacyVocab();
  return vocabMigration;
}

/** Test hook: forget the memoized migration so a fresh WALNUT_HOME re-runs it. */
export function _resetSttVocabMigrationForTest(): void {
  vocabMigration = null;
}

async function loadVocabPrompt(): Promise<string> {
  try {
    await ensureSttVocabMigrated();
    const raw = await readFile(STT_VOCAB_FILE, 'utf-8');
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
