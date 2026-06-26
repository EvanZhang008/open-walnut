/**
 * STT (Speech-to-Text) API routes.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { unlink, stat, mkdir, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getConfig, updateConfig } from '../../core/config-manager.js';
import { transcribeAudio, createEngine, getOrCreateEngine, type SttResult } from '../../core/stt/index.js';
import { createWhisperCppEngine } from '../../core/stt/engine-whisper-cpp.js';
import { detectSystem } from '../../core/stt/detect.js';
import { installViaBrew, downloadGgmlModel, MODEL_CATALOG, VAD_MODEL, getModelDir, SHERPA_MODEL_CATALOG, downloadSherpaModel, getSherpaModelDir, findSherpaModels, type SetupEvent } from '../../core/stt/setup.js';
import { log } from '../../logging/index.js';

export const sttRouter = Router();

const ALLOWED_FORMATS = new Set(['webm', 'wav', 'mp3', 'ogg', 'mp4', 'm4a', 'flac']);

/**
 * POST /api/stt/transcribe
 * Body: { audio: string (base64), format: string, language?: string, model?: string }
 *   model — optional: ggml model filename to use for a one-shot whisper-cli retry
 *           (bypasses the configured engine, useful for comparing models)
 * Response: { text: string, durationMs: number, debugAudioPath?: string }
 */
sttRouter.post('/transcribe', express.json({ limit: '35mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { audio, format, language, model } = req.body;
    if (!audio || typeof audio !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "audio" field (base64 string expected)' });
      return;
    }
    if (!format || typeof format !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "format" field' });
      return;
    }
    if (!ALLOWED_FORMATS.has(format)) {
      res.status(400).json({ error: `Unsupported audio format: ${format}` });
      return;
    }

    // Limit size: ~25MB base64 ≈ ~18MB raw
    if (audio.length > 25 * 1024 * 1024) {
      res.status(413).json({ error: 'Audio too large (max 25MB base64)' });
      return;
    }

    const config = await getConfig();
    const effectiveLanguage = language || config.stt?.language;
    const sttReq = { audio, format, language: effectiveLanguage };

    let result: SttResult;

    if (model && typeof model === 'string') {
      // Retry with a specific model via one-shot whisper-cli (doesn't touch whisper-server daemon)
      const catalogEntry = MODEL_CATALOG.find(m => m.name === model);
      if (!catalogEntry) {
        res.status(404).json({ error: `Unknown model: ${model}` });
        return;
      }
      const modelPath = join(getModelDir(), catalogEntry.filename);
      try { await stat(modelPath); } catch {
        res.status(404).json({ error: `Model not downloaded: ${model}` });
        return;
      }
      const cliPath = config.stt?.whisper_cpp_path || 'whisper-cli';
      const engine = createWhisperCppEngine({
        binaryPath: cliPath,
        modelPath,
        vadModelPath: config.stt?.whisper_cpp_vad_model,
        prompt: config.stt?.whisper_cpp_prompt,
      });
      const { available, error } = await engine.isAvailable();
      if (!available) {
        res.status(500).json({ error: `whisper-cli not available: ${error}` });
        return;
      }
      log.stt.info(`Retry transcription with model: ${model} (via whisper-cli)`);
      result = await engine.transcribe(sttReq);
    } else {
      result = await transcribeAudio(config, sttReq);
    }

    // Save audio + result for debugging truncation issues
    const debugAudioPath = await saveDebugAudio(audio, format, effectiveLanguage, result).catch(() => undefined);

    res.json({ ...result, debugAudioPath });
  } catch (err) {
    next(err);
  }
});

// ── Vocabulary management ──
const VOCAB_PATH = join(homedir(), '.open-walnut', 'stt-vocab.txt');

/**
 * GET /api/stt/vocab
 * Read the custom vocabulary file.
 */
sttRouter.get('/vocab', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let raw = '';
    try { raw = await readFile(VOCAB_PATH, 'utf-8'); } catch { /* file doesn't exist yet */ }
    const words = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    res.json({ words, path: VOCAB_PATH });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/vocab
 * Add a word to the vocabulary file.
 * Body: { word: string }
 */
sttRouter.post('/vocab', express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { word } = req.body;
    if (!word || typeof word !== 'string' || !word.trim()) {
      res.status(400).json({ error: 'Missing "word" field' });
      return;
    }
    const trimmed = word.trim();

    // Read existing file
    let raw = '';
    try { raw = await readFile(VOCAB_PATH, 'utf-8'); } catch { /* file doesn't exist yet */ }

    // Check for duplicate
    const existing = raw.split('\n').map(l => l.trim().toLowerCase());
    if (existing.includes(trimmed.toLowerCase())) {
      res.json({ added: false, word: trimmed, reason: 'already exists' });
      return;
    }

    // Append (ensure newline before)
    const prefix = raw.endsWith('\n') || raw === '' ? '' : '\n';
    await appendFile(VOCAB_PATH, `${prefix}${trimmed}\n`);
    log.stt.info(`Added vocab word: "${trimmed}"`);
    res.json({ added: true, word: trimmed });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stt/status
 * Response: { engine: string | null, available: boolean, error?: string }
 */
sttRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig();
    const engine = getOrCreateEngine(config);
    if (!engine) {
      res.json({ engine: null, available: false, error: 'No STT engine configured' });
      return;
    }
    const status = await engine.isAvailable();
    res.json({ engine: engine.name, ...status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stt/detect
 * Scan system for available STT engines, binaries, and models.
 */
sttRouter.get('/detect', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await detectSystem();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/setup
 * SSE stream for installing binaries or downloading models.
 * Body: { action: 'install_brew_pkg', pkg: string } | { action: 'download_ggml_model', model: string }
 */
sttRouter.post('/setup', express.json(), async (req: Request, res: Response) => {
  const { action } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: SetupEvent | Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (action === 'install_brew_pkg') {
      const { pkg } = req.body;
      if (!pkg || typeof pkg !== 'string') {
        send({ type: 'error', message: 'Missing "pkg" field' });
        res.end();
        return;
      }
      // Only allow known safe packages
      const allowed = new Set(['ffmpeg', 'whisper-cpp']);
      if (!allowed.has(pkg)) {
        send({ type: 'error', message: `Package not allowed: ${pkg}` });
        res.end();
        return;
      }
      for await (const event of installViaBrew(pkg)) {
        send(event);
      }
    } else if (action === 'download_ggml_model') {
      const { model } = req.body;
      if (!model || typeof model !== 'string') {
        send({ type: 'error', message: 'Missing "model" field' });
        res.end();
        return;
      }
      const catalogEntry = MODEL_CATALOG.find(m => m.name === model);
      if (!catalogEntry) {
        send({ type: 'error', message: `Unknown model: ${model}. Available: ${MODEL_CATALOG.map(m => m.name).join(', ')}` });
        res.end();
        return;
      }
      const destDir = getModelDir();
      for await (const event of downloadGgmlModel(catalogEntry.url, destDir, catalogEntry.filename)) {
        send(event);
      }
    } else if (action === 'download_vad_model') {
      const destDir = getModelDir();
      for await (const event of downloadGgmlModel(VAD_MODEL.url, destDir, VAD_MODEL.filename)) {
        send(event);
      }
    } else if (action === 'download_sherpa_model') {
      const { model } = req.body;
      if (!model || typeof model !== 'string') {
        send({ type: 'error', message: 'Missing "model" field' });
        res.end();
        return;
      }
      const catalogEntry = SHERPA_MODEL_CATALOG.find(m => m.name === model);
      if (!catalogEntry) {
        send({ type: 'error', message: `Unknown sherpa model: ${model}` });
        res.end();
        return;
      }
      for await (const event of downloadSherpaModel(catalogEntry)) {
        send(event);
      }
    } else {
      send({ type: 'error', message: `Unknown action: ${action}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.stt.error(`Setup failed: ${msg}`);
    send({ type: 'error', message: msg });
  }

  res.end();
});

/**
 * DELETE /api/stt/models/:name
 * Delete a downloaded ggml model file.
 */
sttRouter.delete('/models/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Route param is always a single string; the express types widen it to a union.
    const { name } = req.params as { name: string };
    const catalogEntry = MODEL_CATALOG.find(m => m.name === name);
    if (!catalogEntry) {
      res.status(404).json({ error: `Unknown model: ${name}` });
      return;
    }

    const modelPath = join(getModelDir(), catalogEntry.filename);
    try {
      await stat(modelPath);
    } catch {
      res.status(404).json({ error: `Model file not found: ${catalogEntry.filename}` });
      return;
    }

    // If this model is the currently active one, clear config
    const config = await getConfig();
    if (config.stt?.whisper_cpp_model?.includes(catalogEntry.filename) ||
        config.stt?.whisper_cpp_model?.includes(name)) {
      await updateConfig({ stt: { ...config.stt, whisper_cpp_model: undefined } });
    }

    await unlink(modelPath);
    log.stt.info(`Deleted model: ${modelPath}`);
    res.json({ deleted: name });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/activate-model
 * Switch the active whisper-cpp model.
 * Body: { model: string } — catalog name like "ggml-base.en"
 */
sttRouter.post('/activate-model', express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { model, engine: reqEngine } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'Missing "model" field' });
      return;
    }

    const catalogEntry = MODEL_CATALOG.find(m => m.name === model);
    if (!catalogEntry) {
      res.status(404).json({ error: `Unknown model: ${model}` });
      return;
    }

    const modelPath = join(getModelDir(), catalogEntry.filename);
    try {
      await stat(modelPath);
    } catch {
      res.status(404).json({ error: `Model file not found. Download it first.` });
      return;
    }

    const config = await getConfig();
    const targetEngine = reqEngine === 'whisper-server' ? 'whisper-server' : 'whisper-cpp';

    if (targetEngine === 'whisper-server') {
      const serverPath = config.stt?.whisper_server_path || 'whisper-server';
      await updateConfig({
        stt: {
          ...config.stt,
          engine: 'whisper-server',
          whisper_server_path: serverPath,
          whisper_server_model: modelPath,
        },
      });
    } else {
      const whisperPath = config.stt?.whisper_cpp_path || 'whisper-cli';
      await updateConfig({
        stt: {
          ...config.stt,
          engine: 'whisper-cpp',
          whisper_cpp_path: whisperPath,
          whisper_cpp_model: modelPath,
        },
      });
    }

    log.stt.info(`Activated model: ${model} → ${modelPath} (engine=${targetEngine})`);
    res.json({ activated: model, path: modelPath });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stt/sherpa-models
 * List downloaded sherpa-onnx models.
 */
sttRouter.get('/sherpa-models', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const models = await findSherpaModels();
    res.json({ models });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/activate-sherpa
 * Activate a sherpa-onnx model.
 * Body: { model: string } — catalog name like "sense-voice-zh-en"
 */
sttRouter.post('/activate-sherpa', express.json(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'Missing "model" field' });
      return;
    }

    const catalogEntry = SHERPA_MODEL_CATALOG.find(m => m.name === model);
    if (!catalogEntry) {
      res.status(404).json({ error: `Unknown sherpa model: ${model}` });
      return;
    }

    const modelDir = join(getSherpaModelDir(), catalogEntry.dirName);
    try {
      await stat(join(modelDir, catalogEntry.files[0].localName));
    } catch {
      res.status(404).json({ error: `Model not downloaded. Download it first.` });
      return;
    }

    const config = await getConfig();
    await updateConfig({
      stt: {
        ...config.stt,
        engine: 'sherpa-onnx',
        sherpa_model_dir: modelDir,
        sherpa_model_type: catalogEntry.modelType,
      },
    });

    log.stt.info(`Activated sherpa model: ${model} → ${modelDir}`);
    res.json({ activated: model, path: modelDir, modelType: catalogEntry.modelType });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/stt/sherpa-models/:name
 * Delete a downloaded sherpa-onnx model directory.
 */
sttRouter.delete('/sherpa-models/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const catalogEntry = SHERPA_MODEL_CATALOG.find(m => m.name === name);
    if (!catalogEntry) {
      res.status(404).json({ error: `Unknown sherpa model: ${name}` });
      return;
    }

    const modelDir = join(getSherpaModelDir(), catalogEntry.dirName);
    try {
      await stat(modelDir);
    } catch {
      res.status(404).json({ error: `Model directory not found` });
      return;
    }

    // If active, clear config
    const config = await getConfig();
    if (config.stt?.sherpa_model_dir === modelDir) {
      await updateConfig({ stt: { ...config.stt, sherpa_model_dir: undefined } });
    }

    await rm(modelDir, { recursive: true });
    log.stt.info(`Deleted sherpa model: ${modelDir}`);
    res.json({ deleted: name });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/auto-config
 * Detect system → pick best engine → save config → verify.
 */
sttRouter.post('/auto-config', express.json(), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const detection = await detectSystem();
    const rec = detection.recommendation;

    if (!rec || rec.missingSteps.length > 0) {
      res.status(400).json({
        error: 'Cannot auto-configure: prerequisites missing',
        recommendation: rec,
        detection,
      });
      return;
    }

    // Apply recommended config
    if (rec.engine === 'whisper-cpp') {
      const whisperPath = detection.whisperCli.path ?? 'whisper-cli';
      const modelPath = rec.modelPath ?? detection.models[0]?.path;
      if (!modelPath) {
        res.status(400).json({ error: 'No model found to auto-configure' });
        return;
      }

      const vadPath = detection.vadModel?.path;
      const existingConfig = await getConfig();
      await updateConfig({
        stt: {
          ...existingConfig.stt,
          engine: 'whisper-cpp',
          whisper_cpp_path: whisperPath,
          whisper_cpp_model: modelPath,
          whisper_cpp_vad_model: vadPath,
        },
      });

      // Verify the engine works
      const config = await getConfig();
      const engine = createEngine(config);
      const status = engine ? await engine.isAvailable() : { available: false, error: 'Engine creation failed' };

      res.json({
        success: status.available,
        engine: 'whisper-cpp',
        config: { whisper_cpp_path: whisperPath, whisper_cpp_model: modelPath, whisper_cpp_vad_model: vadPath },
        status,
      });
    } else {
      res.status(400).json({
        error: `Auto-config for "${rec.engine}" requires manual configuration`,
        recommendation: rec,
      });
    }
  } catch (err) {
    next(err);
  }
});

// ── Debug audio saving ──
// Saves raw audio + transcription metadata to ~/.open-walnut/stt-debug/
// for investigating truncation and recognition issues.

const DEBUG_DIR = join(homedir(), '.open-walnut', 'stt-debug');
const MAX_DEBUG_FILES = 100; // keep last 100 recordings

async function saveDebugAudio(
  audio: string,
  format: string,
  language: string | undefined,
  result: SttResult,
): Promise<string> {
  await mkdir(DEBUG_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${ts}`;
  const audioPath = join(DEBUG_DIR, `${baseName}.${format}`);

  // Save raw audio
  await writeFile(audioPath, Buffer.from(audio, 'base64'));

  // Save companion metadata
  await writeFile(
    join(DEBUG_DIR, `${baseName}.json`),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      format,
      language: language || 'auto',
      audioSizeBytes: Math.round(audio.length * 3 / 4),
      result,
    }, null, 2),
  );

  // Prune old files — keep only the latest MAX_DEBUG_FILES recordings
  try {
    const files = await readdir(DEBUG_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
    if (jsonFiles.length > MAX_DEBUG_FILES) {
      const toDelete = jsonFiles.slice(0, jsonFiles.length - MAX_DEBUG_FILES);
      for (const jf of toDelete) {
        const stem = jf.replace('.json', '');
        const af = files.find(f => f.startsWith(stem) && !f.endsWith('.json'));
        await unlink(join(DEBUG_DIR, jf)).catch(() => {});
        if (af) await unlink(join(DEBUG_DIR, af)).catch(() => {});
      }
    }
  } catch {
    // Pruning is best-effort
  }

  log.stt.info(`Debug audio saved: ${audioPath}`);
  return audioPath;
}
