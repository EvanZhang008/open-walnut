/**
 * STT system detection — scan for available engines, binaries, and models.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sttSpawnEnv } from './spawn-env.js';

const execFileAsync = promisify(execFile);

/** Common directories where whisper-cpp models (ggml) and VAD models may be found. */
const MODEL_SEARCH_DIRS = (() => {
  const home = homedir();
  return [
    join(home, '.local', 'share', 'whisper-cpp'),
    join(home, '.local', 'share', 'whisper-cpp', 'models'),
    '/opt/homebrew/share/whisper-cpp/models',
    join(home, 'whisper-models'),
    join(home, '.cache', 'whisper'),
  ];
})();

export interface DetectionItem {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface GgmlModel {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface DetectionResult {
  ffmpeg: DetectionItem;
  whisperCli: DetectionItem;
  whisperServer: DetectionItem;
  sherpaOnnxNode: DetectionItem;
  homebrew: DetectionItem;
  models: GgmlModel[];
  vadModel: GgmlModel | null;
  recommendation: Recommendation | null;
}

export interface Recommendation {
  engine: 'whisper-cpp' | 'sherpa-onnx' | 'openai';
  reason: string;
  /** If whisper-cpp, which model to use */
  modelPath?: string;
  /** What's still needed before this engine works */
  missingSteps: string[];
}

async function whichBinary(name: string): Promise<{ found: boolean; path?: string }> {
  try {
    // Augmented PATH: under launchd/systemd the inherited PATH misses Homebrew.
    const { stdout } = await execFileAsync('which', [name], { timeout: 5000, env: sttSpawnEnv() });
    const path = stdout.trim();
    if (path) return { found: true, path };
    return { found: false };
  } catch {
    return { found: false };
  }
}

async function getVersion(binary: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { timeout: 5000 });
    // ffmpeg prints version to stderr, whisper-cli to stdout
    const text = (stdout || stderr).trim();
    const match = text.match(/version\s+([\w.\-]+)/i);
    return match?.[1] ?? text.split('\n')[0]?.slice(0, 80);
  } catch {
    return undefined;
  }
}

export async function detectFfmpeg(): Promise<DetectionItem> {
  const { found, path } = await whichBinary('ffmpeg');
  if (!found) return { name: 'ffmpeg', found: false };
  const version = await getVersion('ffmpeg', ['-version']);
  return { name: 'ffmpeg', found: true, path, version };
}

export async function detectWhisperCli(): Promise<DetectionItem> {
  // Try common names
  for (const name of ['whisper-cli', 'whisper-cpp', 'main']) {
    const { found, path } = await whichBinary(name);
    if (found) {
      const version = await getVersion(path!, ['--help']).catch(() => undefined);
      return { name: 'whisper-cli', found: true, path, version };
    }
  }
  // Check homebrew Cellar path
  const brewPath = '/opt/homebrew/bin/whisper-cli';
  try {
    const s = await stat(brewPath);
    if (s.isFile()) {
      return { name: 'whisper-cli', found: true, path: brewPath };
    }
  } catch { /* not found */ }

  return { name: 'whisper-cli', found: false };
}

export async function detectWhisperServer(): Promise<DetectionItem> {
  const { found, path } = await whichBinary('whisper-server');
  if (found) {
    return { name: 'whisper-server', found: true, path };
  }
  // Check homebrew path
  const brewPath = '/opt/homebrew/bin/whisper-server';
  try {
    const s = await stat(brewPath);
    if (s.isFile()) {
      return { name: 'whisper-server', found: true, path: brewPath };
    }
  } catch { /* not found */ }

  return { name: 'whisper-server', found: false };
}

export async function detectSherpaOnnxNode(): Promise<DetectionItem> {
  try {
    await import('sherpa-onnx-node');
    return { name: 'sherpa-onnx-node', found: true };
  } catch {
    return { name: 'sherpa-onnx-node', found: false, error: 'npm package not installed' };
  }
}

export async function detectHomebrew(): Promise<DetectionItem> {
  const { found, path } = await whichBinary('brew');
  if (!found) return { name: 'homebrew', found: false };
  return { name: 'homebrew', found: true, path };
}

/** Scan common directories for ggml model files */
export async function findGgmlModels(): Promise<GgmlModel[]> {
  const models: GgmlModel[] = [];
  const seen = new Set<string>();

  for (const dir of MODEL_SEARCH_DIRS) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.startsWith('ggml-') || seen.has(entry)) continue;
        const fullPath = join(dir, entry);
        try {
          const s = await stat(fullPath);
          if (s.isFile() && s.size > 1_000_000) {
            seen.add(entry);
            // Strip .bin suffix so name matches catalog (e.g. "ggml-base.en")
            const name = entry.endsWith('.bin') ? entry.slice(0, -4) : entry;
            models.push({ name, path: fullPath, sizeBytes: s.size });
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scan common directories for a Silero VAD model file */
export async function findVadModel(): Promise<GgmlModel | null> {
  for (const dir of MODEL_SEARCH_DIRS) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.includes('silero')) continue;
        const fullPath = join(dir, entry);
        try {
          const s = await stat(fullPath);
          if (s.isFile()) {
            const name = entry.endsWith('.bin') ? entry.slice(0, -4) : entry;
            return { name, path: fullPath, sizeBytes: s.size };
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  return null;
}

export function getRecommendation(result: Pick<DetectionResult, 'ffmpeg' | 'whisperCli' | 'sherpaOnnxNode' | 'homebrew' | 'models'>): Recommendation | null {
  const { ffmpeg, whisperCli, models, homebrew } = result;

  // Best case: whisper-cli + ffmpeg + model all found
  if (whisperCli.found && ffmpeg.found && models.length > 0) {
    // Pick the best model (prefer base.en for speed, then small, medium)
    const preferred = models.find(m => m.name.includes('base.en'))
      ?? models.find(m => m.name.includes('small'))
      ?? models.find(m => m.name.includes('base'))
      ?? models[0];
    return {
      engine: 'whisper-cpp',
      reason: 'whisper-cli and model detected — ready to use',
      modelPath: preferred.path,
      missingSteps: [],
    };
  }

  // whisper-cli + ffmpeg but no model
  if (whisperCli.found && ffmpeg.found) {
    return {
      engine: 'whisper-cpp',
      reason: 'whisper-cli detected but no model found. Download a model to get started.',
      missingSteps: ['download_model'],
    };
  }

  // Have homebrew — can install everything
  if (homebrew.found) {
    const missing: string[] = [];
    if (!ffmpeg.found) missing.push('install_ffmpeg');
    if (!whisperCli.found) missing.push('install_whisper_cpp');
    if (models.length === 0) missing.push('download_model');
    return {
      engine: 'whisper-cpp',
      reason: 'Homebrew detected — can install whisper.cpp automatically',
      missingSteps: missing,
    };
  }

  // Nothing useful — suggest OpenAI cloud as fallback
  return {
    engine: 'openai',
    reason: 'No local engines detected. Use OpenAI-compatible cloud API, or install Homebrew first for local STT.',
    missingSteps: ['configure_api_key'],
  };
}

/** Run full system detection */
export async function detectSystem(): Promise<DetectionResult> {
  const [ffmpeg, whisperCli, whisperServer, sherpaOnnxNode, homebrew, models, vadModel] = await Promise.all([
    detectFfmpeg(),
    detectWhisperCli(),
    detectWhisperServer(),
    detectSherpaOnnxNode(),
    detectHomebrew(),
    findGgmlModels(),
    findVadModel(),
  ]);

  const recommendation = getRecommendation({ ffmpeg, whisperCli, sherpaOnnxNode, homebrew, models });

  return { ffmpeg, whisperCli, whisperServer, sherpaOnnxNode, homebrew, models, vadModel, recommendation };
}
