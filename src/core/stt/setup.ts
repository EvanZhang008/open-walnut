/**
 * STT setup helpers — brew install packages, download ggml/sherpa models.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rename, unlink, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';

const execFileAsync = promisify(execFile);

export interface SetupEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  message?: string;
  /** 0-100 for downloads */
  percent?: number;
  /** For done events */
  path?: string;
}

export interface ModelCatalogEntry {
  name: string;
  displayName: string;
  label: string;
  filename: string;
  url: string;
  sizeBytes: number;
  description: string;
  languageNote: string;
}

const HUGGINGFACE_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    name: 'ggml-tiny',
    displayName: 'Tiny',
    label: 'Tiny (75 MB)',
    filename: 'ggml-tiny.bin',
    url: `${HUGGINGFACE_BASE}/ggml-tiny.bin`,
    sizeBytes: 75_000_000,
    description: 'Fastest, basic accuracy',
    languageNote: 'Multilingual',
  },
  {
    name: 'ggml-tiny.en',
    displayName: 'Tiny (English)',
    label: 'Tiny English (75 MB)',
    filename: 'ggml-tiny.en.bin',
    url: `${HUGGINGFACE_BASE}/ggml-tiny.en.bin`,
    sizeBytes: 75_000_000,
    description: 'Fastest, English optimized',
    languageNote: 'English only',
  },
  {
    name: 'ggml-base',
    displayName: 'Base',
    label: 'Base (142 MB)',
    filename: 'ggml-base.bin',
    url: `${HUGGINGFACE_BASE}/ggml-base.bin`,
    sizeBytes: 142_000_000,
    description: 'Fast, good for general use',
    languageNote: 'Multilingual',
  },
  {
    name: 'ggml-base.en',
    displayName: 'Base (English)',
    label: 'Base English (148 MB)',
    filename: 'ggml-base.en.bin',
    url: `${HUGGINGFACE_BASE}/ggml-base.en.bin`,
    sizeBytes: 148_000_000,
    description: 'Fast, English optimized',
    languageNote: 'English only',
  },
  {
    name: 'ggml-small',
    displayName: 'Small',
    label: 'Small (466 MB)',
    filename: 'ggml-small.bin',
    url: `${HUGGINGFACE_BASE}/ggml-small.bin`,
    sizeBytes: 466_000_000,
    description: 'Good accuracy, balanced speed',
    languageNote: 'Multilingual',
  },
  {
    name: 'ggml-small.en',
    displayName: 'Small (English)',
    label: 'Small English (466 MB)',
    filename: 'ggml-small.en.bin',
    url: `${HUGGINGFACE_BASE}/ggml-small.en.bin`,
    sizeBytes: 466_000_000,
    description: 'Good accuracy, English optimized',
    languageNote: 'English only',
  },
  {
    name: 'ggml-medium',
    displayName: 'Medium',
    label: 'Medium (1.5 GB)',
    filename: 'ggml-medium.bin',
    url: `${HUGGINGFACE_BASE}/ggml-medium.bin`,
    sizeBytes: 1_500_000_000,
    description: 'Balanced speed and accuracy',
    languageNote: 'Multilingual',
  },
  {
    name: 'ggml-medium.en',
    displayName: 'Medium (English)',
    label: 'Medium English (1.5 GB)',
    filename: 'ggml-medium.en.bin',
    url: `${HUGGINGFACE_BASE}/ggml-medium.en.bin`,
    sizeBytes: 1_500_000_000,
    description: 'Balanced speed and accuracy, English optimized',
    languageNote: 'English only',
  },
  {
    name: 'ggml-large-v2',
    displayName: 'Large v2',
    label: 'Large v2 (3 GB)',
    filename: 'ggml-large-v2.bin',
    url: `${HUGGINGFACE_BASE}/ggml-large-v2.bin`,
    sizeBytes: 3_000_000_000,
    description: 'High accuracy, slower',
    languageNote: 'Multilingual',
  },
  {
    name: 'ggml-large-v3-turbo',
    displayName: 'Large v3 Turbo',
    label: 'Large v3 Turbo (1.6 GB)',
    filename: 'ggml-large-v3-turbo.bin',
    url: `${HUGGINGFACE_BASE}/ggml-large-v3-turbo.bin`,
    sizeBytes: 1_600_000_000,
    description: 'Best accuracy, distilled for speed',
    languageNote: 'Multilingual',
  },
];

/** Silero VAD model for silence detection (prevents hallucination) */
// Note: VAD model is from ggml-org/whisper-vad repo, NOT the main ggerganov/whisper.cpp repo.
export const VAD_MODEL = {
  name: 'ggml-silero-v6.2.0',
  filename: 'ggml-silero-v6.2.0.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  sizeBytes: 864_000,
};

/** Default model directory */
export function getModelDir(): string {
  return join(homedir(), '.local', 'share', 'whisper-cpp');
}

/**
 * Install a package via Homebrew. Yields progress events.
 */
export async function* installViaBrew(pkg: string): AsyncGenerator<SetupEvent> {
  // Augmented PATH: under launchd/systemd the inherited PATH misses Homebrew.
  const env = sttSpawnEnv();

  // Check if brew exists
  try {
    await execFileAsync('which', ['brew'], { timeout: 5000, env });
  } catch {
    yield { type: 'error', message: 'Homebrew not found. Install from https://brew.sh' };
    return;
  }

  // Check if already installed
  try {
    await execFileAsync('brew', ['list', pkg], { timeout: 10000, env });
    yield { type: 'log', message: `${pkg} is already installed` };
    yield { type: 'done', message: `${pkg} already installed` };
    return;
  } catch {
    // Not installed, proceed
  }

  yield { type: 'log', message: `Installing ${pkg} via Homebrew...` };
  yield { type: 'progress', percent: 5, message: `brew install ${pkg}` };

  const child = spawn('brew', ['install', pkg], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000, // 10 min max
    env,
  });

  let lastLine = '';

  const processLine = (line: string) => {
    if (line.trim()) {
      lastLine = line.trim();
      log.stt.info(`[brew] ${lastLine}`);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').forEach(processLine);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').forEach(processLine);
  });

  // Emit periodic progress
  let progressInterval: ReturnType<typeof setInterval> | undefined;
  let percent = 10;
  const progressGen = {
    events: [] as SetupEvent[],
  };

  progressInterval = setInterval(() => {
    if (percent < 90) percent += 5;
    progressGen.events.push({ type: 'progress', percent, message: lastLine || `Installing ${pkg}...` });
  }, 3000);

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  clearInterval(progressInterval);

  // Yield any accumulated progress events
  for (const evt of progressGen.events) {
    yield evt;
  }

  if (exitCode !== 0) {
    yield { type: 'error', message: `brew install ${pkg} failed (exit ${exitCode}): ${lastLine}` };
    return;
  }

  yield { type: 'progress', percent: 100, message: `${pkg} installed` };
  yield { type: 'done', message: `${pkg} installed successfully` };
}

/**
 * Download a ggml model file. Yields progress events.
 */
export async function* downloadGgmlModel(
  url: string,
  destDir: string,
  filename: string,
): AsyncGenerator<SetupEvent> {
  await mkdir(destDir, { recursive: true });

  const destPath = join(destDir, filename);
  const tmpPath = destPath + '.downloading';

  // Check if already exists
  try {
    const s = await stat(destPath);
    if (s.isFile() && s.size > 100) {
      yield { type: 'log', message: `${filename} already exists (${(s.size / 1e6).toFixed(0)} MB)` };
      yield { type: 'done', message: `${filename} already exists`, path: destPath };
      return;
    }
  } catch { /* doesn't exist */ }

  yield { type: 'log', message: `Downloading ${filename}...` };
  yield { type: 'progress', percent: 0, message: `Starting download: ${filename}` };

  log.stt.info(`Downloading model: ${url} → ${destPath}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(1800_000) }); // 30 min timeout
  if (!res.ok) {
    yield { type: 'error', message: `Download failed: HTTP ${res.status} ${res.statusText}` };
    return;
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: 'No response body' };
    return;
  }

  const writeStream = createWriteStream(tmpPath);
  let downloaded = 0;
  let lastPercent = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      writeStream.write(value);
      downloaded += value.length;

      if (contentLength > 0) {
        const percent = Math.round((downloaded / contentLength) * 100);
        if (percent - lastPercent >= 2) {
          lastPercent = percent;
          yield {
            type: 'progress',
            percent,
            message: `${(downloaded / 1e6).toFixed(1)} / ${(contentLength / 1e6).toFixed(0)} MB`,
          };
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });

    // Atomic rename
    await rename(tmpPath, destPath);

    log.stt.info(`Model downloaded: ${destPath} (${(downloaded / 1e6).toFixed(0)} MB)`);
    yield { type: 'progress', percent: 100, message: `Download complete` };
    yield { type: 'done', message: `${filename} downloaded`, path: destPath };
  } catch (err) {
    writeStream.destroy();
    await unlink(tmpPath).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message: `Download failed: ${msg}` };
  }
}

// ── Sherpa-onnx model catalog ──────────────────────────

export interface SherpaModelCatalogEntry {
  name: string;
  displayName: string;
  modelType: 'sense_voice' | 'whisper' | 'paraformer';
  /** Directory name inside getSherpaModelDir() */
  dirName: string;
  description: string;
  languageNote: string;
  sizeBytes: number;
  /** Files to download: { localName: HuggingFace URL } */
  files: { localName: string; url: string }[];
}

const HF_SHERPA = 'https://huggingface.co/csukuangfj';

export const SHERPA_MODEL_CATALOG: SherpaModelCatalogEntry[] = [
  {
    name: 'sense-voice-zh-en',
    displayName: 'SenseVoice (zh/en/ja/ko)',
    modelType: 'sense_voice',
    dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    description: 'Best multilingual, fast & accurate',
    languageNote: 'zh, en, ja, ko, yue',
    sizeBytes: 84_000_000,
    files: [
      { localName: 'model.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx` },
      { localName: 'tokens.txt', url: `${HF_SHERPA}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt` },
    ],
  },
  {
    name: 'paraformer-zh',
    displayName: 'Paraformer (Chinese)',
    modelType: 'paraformer',
    dirName: 'sherpa-onnx-paraformer-zh-2023-09-14',
    description: 'Fast Chinese transcription',
    languageNote: 'Chinese',
    sizeBytes: 232_000_000,
    files: [
      { localName: 'model.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-paraformer-zh-2023-09-14/resolve/main/model.int8.onnx` },
      { localName: 'tokens.txt', url: `${HF_SHERPA}/sherpa-onnx-paraformer-zh-2023-09-14/resolve/main/tokens.txt` },
    ],
  },
  {
    name: 'whisper-tiny.en',
    displayName: 'Whisper Tiny (English)',
    modelType: 'whisper',
    dirName: 'sherpa-onnx-whisper-tiny.en',
    description: 'Tiny English-only, very fast',
    languageNote: 'English only',
    sizeBytes: 60_000_000,
    files: [
      { localName: 'encoder.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-encoder.int8.onnx` },
      { localName: 'decoder.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-decoder.int8.onnx` },
      { localName: 'tokens.txt', url: `${HF_SHERPA}/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-tokens.txt` },
    ],
  },
  {
    name: 'whisper-base.en',
    displayName: 'Whisper Base (English)',
    modelType: 'whisper',
    dirName: 'sherpa-onnx-whisper-base.en',
    description: 'Good English accuracy',
    languageNote: 'English only',
    sizeBytes: 120_000_000,
    files: [
      { localName: 'encoder.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-whisper-base.en/resolve/main/base.en-encoder.int8.onnx` },
      { localName: 'decoder.int8.onnx', url: `${HF_SHERPA}/sherpa-onnx-whisper-base.en/resolve/main/base.en-decoder.int8.onnx` },
      { localName: 'tokens.txt', url: `${HF_SHERPA}/sherpa-onnx-whisper-base.en/resolve/main/base.en-tokens.txt` },
    ],
  },
];

/** Default sherpa-onnx model directory */
export function getSherpaModelDir(): string {
  return join(homedir(), '.local', 'share', 'sherpa-onnx');
}

/** List downloaded sherpa-onnx models */
export async function findSherpaModels(): Promise<{ name: string; dirName: string; path: string }[]> {
  const baseDir = getSherpaModelDir();
  const models: { name: string; dirName: string; path: string }[] = [];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const catalogEntry = SHERPA_MODEL_CATALOG.find(m => m.dirName === entry.name);
      if (catalogEntry) {
        // Check if required files exist
        const modelDir = join(baseDir, entry.name);
        const firstFile = catalogEntry.files[0];
        try {
          await stat(join(modelDir, firstFile.localName));
          models.push({ name: catalogEntry.name, dirName: entry.name, path: modelDir });
        } catch { /* incomplete download */ }
      }
    }
  } catch { /* directory doesn't exist */ }
  return models;
}

/**
 * Download a sherpa-onnx model. Downloads all required files into a subdirectory.
 */
export async function* downloadSherpaModel(entry: SherpaModelCatalogEntry): AsyncGenerator<SetupEvent> {
  const baseDir = getSherpaModelDir();
  const modelDir = join(baseDir, entry.dirName);
  await mkdir(modelDir, { recursive: true });

  const totalFiles = entry.files.length;
  for (let i = 0; i < totalFiles; i++) {
    const file = entry.files[i];
    const destPath = join(modelDir, file.localName);
    const tmpPath = destPath + '.downloading';

    // Check if file already exists
    try {
      const s = await stat(destPath);
      if (s.isFile() && s.size > 100) {
        yield { type: 'progress', percent: Math.round(((i + 1) / totalFiles) * 100), message: `${file.localName} already exists` };
        continue;
      }
    } catch { /* not found, download */ }

    yield { type: 'progress', percent: Math.round((i / totalFiles) * 100), message: `Downloading ${file.localName}...` };

    const res = await fetch(file.url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) {
      yield { type: 'error', message: `Failed to download ${file.localName}: HTTP ${res.status}` };
      return;
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: 'error', message: `No response body for ${file.localName}` };
      return;
    }

    const writeStream = createWriteStream(tmpPath);
    let downloaded = 0;
    let lastPercent = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writeStream.write(value);
        downloaded += value.length;

        if (contentLength > 0) {
          const fileProgress = downloaded / contentLength;
          const overallPercent = Math.round(((i + fileProgress) / totalFiles) * 100);
          if (overallPercent - lastPercent >= 2) {
            lastPercent = overallPercent;
            yield { type: 'progress', percent: overallPercent, message: `${file.localName}: ${(downloaded / 1e6).toFixed(1)} MB` };
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });
      await rename(tmpPath, destPath);
    } catch (err) {
      writeStream.destroy();
      await unlink(tmpPath).catch(() => {});
      yield { type: 'error', message: `Download failed: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }
  }

  log.stt.info(`Sherpa model downloaded: ${modelDir}`);
  yield { type: 'progress', percent: 100, message: 'Download complete' };
  yield { type: 'done', message: `${entry.displayName} downloaded`, path: modelDir };
}
