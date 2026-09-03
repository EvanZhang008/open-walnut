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
import { createMlxEngine } from './engine-mlx.js';
import { writeRecordingSecondary } from './recordings.js';

export type { SttEngine, SttRequest, SttResult } from './types.js';

type SttSection = NonNullable<Config['stt']>;
type EngineName = NonNullable<SttSection['engine']>;

/** Create an STT engine from config. Returns null if not configured. */
export function createEngine(config: Config): SttEngine | null {
  const stt = config.stt;
  if (!stt?.engine) return null;
  return createEngineByName(stt.engine, stt);
}

/**
 * Create a specific engine from the shared stt config section. The primary and
 * the secondary (shadow) engine both resolve through here — they share the same
 * per-engine fields, only the engine NAME differs.
 */
export function createEngineByName(engine: EngineName, stt: SttSection): SttEngine | null {
  switch (engine) {
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
    case 'mlx':
      return createMlxEngine({
        pythonPath: stt.mlx_python_path ?? '',
        model: stt.mlx_model,
        port: stt.mlx_port,
        idleTtlMs: stt.mlx_idle_ttl_minutes
          ? stt.mlx_idle_ttl_minutes * 60_000
          : undefined,
      });
    default:
      log.stt.warn(`Unknown STT engine: ${engine}`);
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
// Separate singleton for the shadow engine — same rationale, same lifecycle.
let cachedSecondary: SttEngine | null = null;
let cachedSecondaryKey = '';

function engineKey(engine: string | undefined, s: SttSection | undefined): string {
  if (!engine || !s) return '';
  // Note: prompt is NOT in the key — vocab is loaded per-request from stt-vocab.txt, no engine restart needed.
  return `${engine}|${s.whisper_server_path ?? ''}|${s.whisper_server_model ?? ''}|${s.whisper_server_port ?? ''}|${s.whisper_server_idle_ttl_minutes ?? ''}|${s.whisper_cpp_path ?? ''}|${s.whisper_cpp_model ?? ''}|${s.openai_api_key ?? ''}|${s.sherpa_model_dir ?? ''}|${s.mlx_python_path ?? ''}|${s.mlx_model ?? ''}|${s.mlx_port ?? ''}|${s.mlx_idle_ttl_minutes ?? ''}`;
}

export function getOrCreateEngine(config: Config): SttEngine | null {
  const key = engineKey(config.stt?.engine, config.stt);
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

/** Singleton for the shadow engine (stt.secondary_engine). Null when not set. */
export function getOrCreateSecondaryEngine(config: Config): SttEngine | null {
  const s = config.stt;
  // Same engine as the primary would spawn a SECOND daemon loading the identical
  // model (double RAM/GPU) for a byte-identical comparison — refuse it.
  const secondary = s?.secondary_engine && s.secondary_engine !== s.engine
    ? s.secondary_engine
    : undefined;
  if (s?.secondary_engine && !secondary && cachedSecondaryKey !== '') {
    log.stt.warn(`stt.secondary_engine equals the primary engine (${s.engine}) — shadow disabled`);
  }
  const key = secondary ? engineKey(secondary, s) : '';
  if (cachedSecondary && cachedSecondaryKey === key) return cachedSecondary;

  if (cachedSecondary?.shutdown) {
    log.stt.info(`STT secondary config changed — shutting down previous ${cachedSecondary.name} engine`);
    cachedSecondary.shutdown();
  }

  cachedSecondary = secondary && s ? createEngineByName(secondary, s) : null;
  cachedSecondaryKey = key;
  return cachedSecondary;
}

/**
 * Load the STT models into memory at server startup (stt.prewarm_on_start)
 * instead of on the first dictation — daemon engines pay a 5-15s model load
 * once per boot, and prewarming moves that wait off the user's first
 * utterance. Fire-and-forget: never throws, failures only log (the lazy path
 * still works). Engines without warmup (one-shot CLIs) are skipped.
 */
export async function prewarmSttEngines(config: Config): Promise<void> {
  const engines = [getOrCreateEngine(config), getOrCreateSecondaryEngine(config)];
  await Promise.all(engines.map(async engine => {
    if (!engine?.warmup) return;
    try {
      const avail = await engine.isAvailable();
      if (!avail.available) {
        log.stt.warn(`STT prewarm skipped for ${engine.name}: ${avail.error}`);
        return;
      }
      const t0 = Date.now();
      await engine.warmup();
      log.stt.info(`STT prewarm: ${engine.name} ready in ${Date.now() - t0}ms`);
    } catch (err) {
      log.stt.warn(`STT prewarm failed for ${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
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

/**
 * Strip a trailing "vocab echo" from a transcription.
 *
 * The vocabulary list is injected as decoder context (whisper --prompt /
 * qwen system_prompt) to bias spelling. On trailing silence the decoder has
 * no acoustic evidence and sometimes copies words straight out of that
 * context, so dictations come back ending in "... Kubernetes, DynamoDB,
 * Walnut" (observed live 2026-08-28). An echo is a comma-separated run of vocab
 * words, so: peel trailing vocab words off the end and drop them only if
 * TWO OR MORE were peeled — a single vocab word at the end ("我们管它叫
 * Walnut") is almost always real speech and is kept.
 */
export function stripVocabEcho(text: string, vocabPrompt: string): string {
  const words = vocabPrompt.split(',').map(w => w.trim()).filter(Boolean);
  if (!words.length) return text;
  // Longest first so "Claude Code" wins over "Claude".
  const sorted = [...words].sort((a, b) => b.length - a.length);
  let t = text.trimEnd();
  let peeled = 0;
  for (;;) {
    const base = t.replace(/[\s,，、.。!！?？]+$/u, '');
    const hit = sorted.find(w => base.toLowerCase().endsWith(w.toLowerCase()));
    if (!hit) break;
    const cut = base.slice(0, base.length - hit.length);
    // Word boundary: don't peel "Walnut" out of "MyWalnut".
    if (cut && /[A-Za-z0-9]$/.test(cut)) break;
    t = cut;
    peeled++;
  }
  if (peeled < 2) return text;
  const cleaned = t.replace(/[\s,，、]+$/u, '');
  log.stt.info(`Stripped trailing vocab echo (${peeled} words) from transcription`);
  return cleaned;
}

/** Transcribe audio using the configured engine. */
export async function transcribeAudio(config: Config, req: SttRequest): Promise<SttResult> {
  const engine = getOrCreateEngine(config);
  if (!engine) {
    throw new Error('No STT engine configured. Go to Settings → Voice to set one up.');
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
  if (req.prompt) result.text = stripVocabEcho(result.text, req.prompt);
  return result;
}

/**
 * Run the shadow (secondary) engine on the same audio and attach its result to
 * the stored recording. Fire-and-forget by design: called AFTER the primary
 * result has been sent to the client, and never throws — a shadow failure is
 * recorded in the metadata, not surfaced to the user. The whole point is a
 * zero-risk side-by-side during an engine transition: primary text goes to the
 * chat, the shadow's text shows up in the mic dropdown's history.
 */
export async function runShadowTranscription(
  config: Config,
  req: SttRequest,
  recordingId: string,
  /** Epoch token from writeRecordingResult — a stale shadow (Redo re-ran the
   *  primary meanwhile) drops instead of attaching to the newer result. */
  expectTimestamp?: string,
): Promise<void> {
  let engine: SttEngine | null = null;
  try {
    engine = getOrCreateSecondaryEngine(config);
    if (!engine) return;
    const { available, error } = await engine.isAvailable();
    if (!available) {
      await writeRecordingSecondary(recordingId, { engine: engine.name, error: `not available: ${error}` }, expectTimestamp);
      return;
    }
    if (!req.prompt) {
      const vocab = await loadVocabPrompt();
      if (vocab) req = { ...req, prompt: vocab };
    }
    log.stt.info(`Shadow transcription with ${engine.name} (recording=${recordingId})`);
    const result = await engine.transcribe(req);
    if (req.prompt) result.text = stripVocabEcho(result.text, req.prompt);
    await writeRecordingSecondary(recordingId, {
      engine: engine.name,
      text: result.text,
      durationMs: result.durationMs,
    }, expectTimestamp);
    log.stt.info(`Shadow transcription complete: ${result.text.length} chars in ${result.durationMs}ms (${engine.name})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.stt.warn(`Shadow transcription failed (${engine?.name ?? 'secondary'}): ${msg}`);
    if (engine) {
      await writeRecordingSecondary(recordingId, { engine: engine.name, error: msg }, expectTimestamp).catch(() => {});
    }
  }
}
