/**
 * Voice > Dictation decisions, kept pure so they are unit tested: which engines
 * the picker offers on this server, which one is recommended, and what the one
 * "Set up" button will do for it (the steps, and the sentence that says so).
 */
import type { DetectionResult } from '@/api/stt';
import { MODEL_CATALOG, MLX_MODEL } from '@/api/stt';

export type SttEngine = 'whisper-cpp' | 'whisper-server' | 'sherpa-onnx' | 'openai' | 'mlx';
/** The engines the one-button setup knows how to install. */
export type SetupEngine = 'mlx' | 'whisper-server';

export interface EngineOption {
  value: SttEngine;
  label: string;
  badge: 'Local' | 'Cloud';
  description: string;
  recommended?: boolean;
}

export interface ServerPlatform { os: string; arch: string }

const QWEN: EngineOption = { value: 'mlx', label: 'Qwen3-ASR', badge: 'Local', description: 'Best for Chinese and English, runs on Apple Silicon.' };
const WHISPER: EngineOption = { value: 'whisper-server', label: 'Whisper', badge: 'Local', description: 'Runs on this Mac; works on any Mac.' };
const OPENAI: EngineOption = { value: 'openai', label: 'OpenAI-compatible API', badge: 'Cloud', description: 'OpenAI, Groq or Fireworks; nothing runs on this Mac.' };
/** Still valid config values; offered only to the install already using one. */
const LEGACY: Partial<Record<SttEngine, EngineOption>> = {
  'whisper-cpp': { value: 'whisper-cpp', label: 'Whisper CLI (legacy)', badge: 'Local', description: 'Starts fresh each call; simpler and lighter on memory.' },
  'sherpa-onnx': { value: 'sherpa-onnx', label: 'sherpa-onnx (legacy)', badge: 'Local', description: 'SenseVoice and Paraformer models, tuned for Chinese.' },
};

/** Qwen3-ASR runs on MLX, which needs Apple Silicon. */
export function qwenSupported(platform: ServerPlatform | null | undefined): boolean {
  return platform?.os === 'darwin' && platform.arch === 'arm64';
}

export function recommendedEngine(platform: ServerPlatform | null | undefined): SetupEngine {
  return qwenSupported(platform) ? 'mlx' : 'whisper-server';
}

/**
 * The picker's options: Qwen3-ASR (Apple Silicon only), Whisper, the cloud API,
 * plus the current engine when it is one of the legacy ones (or Qwen on a
 * server that could not run it), so nobody's working setup vanishes from the list.
 */
export function engineOptionsFor(platform: ServerPlatform | null | undefined, current: SttEngine | null | undefined): EngineOption[] {
  const recommended = platform ? recommendedEngine(platform) : null;
  const options: EngineOption[] = [];
  if (qwenSupported(platform) || current === 'mlx') options.push({ ...QWEN, recommended: recommended === 'mlx' });
  options.push({ ...WHISPER, recommended: recommended === 'whisper-server' });
  const legacy = current ? LEGACY[current] : undefined;
  if (legacy) options.push(legacy);
  options.push(OPENAI);
  return options;
}

export interface SetupStep {
  action: string;
  params: Record<string, string>;
  label: string;
}

export interface SetupPlan {
  steps: SetupStep[];
  /** One sentence: what pressing Set up will do. */
  help: string;
  /** Something to install by hand first; the steps cannot run without it. */
  blocker?: 'homebrew';
  /** Whisper only: the ggml model to activate once the steps finish. */
  activateModel?: string;
}

/** The official one-line installer from brew.sh. */
export const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

const WHISPER_DEFAULT = 'ggml-large-v3-turbo';

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Installs ffmpeg and whisper-cpp with Homebrew, downloads Large v3 Turbo (1.6 GB)." */
export function setupHelpText(parts: { brew?: string[]; venv?: boolean; download?: string }): string {
  const clauses: string[] = [];
  if (parts.brew?.length) clauses.push(`installs ${listWords(parts.brew)} with Homebrew`);
  if (parts.venv) clauses.push('creates a Python environment with mlx-audio (about 400 MB)');
  if (parts.download) clauses.push(`downloads ${parts.download}`);
  if (clauses.length === 0) return 'Everything it needs is already on this Mac.';
  const text = clauses.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

const brewStep = (pkg: string): SetupStep => ({ action: 'install_brew_pkg', params: { pkg }, label: `Install ${pkg}` });

/**
 * Whisper: ffmpeg and whisper-cpp from Homebrew when missing, then Large v3
 * Turbo unless the configured model is already on disk. No VAD model: the
 * whisper-server engine runs without one (it is optional there).
 */
export function planWhisperSetup(d: DetectionResult, activeModel: string | null): SetupPlan {
  const brew: string[] = [];
  if (!d.ffmpeg.found) brew.push('ffmpeg');
  if (!d.whisperServer?.found) brew.push('whisper-cpp');
  const downloaded = new Set(d.models.map((m) => m.name));
  const keepActive = !!activeModel && downloaded.has(activeModel);
  const turbo = MODEL_CATALOG.find((m) => m.name === WHISPER_DEFAULT)!;
  const needsDownload = !keepActive && !downloaded.has(WHISPER_DEFAULT);
  const download = needsDownload ? turbo.label : undefined;
  const steps = [
    ...brew.map(brewStep),
    ...(needsDownload ? [{ action: 'download_ggml_model', params: { model: WHISPER_DEFAULT }, label: `Download ${download}` }] : []),
  ];
  return {
    steps,
    help: setupHelpText({ brew, download }),
    ...(brew.length && !d.homebrew.found ? { blocker: 'homebrew' as const } : {}),
    ...(keepActive ? {} : { activateModel: WHISPER_DEFAULT }),
  };
}

export function pythonVersionOk(version: string | undefined): boolean {
  const m = version?.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 3 || (major === 3 && minor >= 10);
}

/**
 * Qwen3-ASR: ffmpeg from Homebrew when missing, the Python environment
 * (made with uv, installed from Homebrew when missing; a python3 of 3.10 or
 * newer only on a Mac without Homebrew), then the model when it is not cached.
 */
export function planQwenSetup(d: DetectionResult): SetupPlan {
  const brew: string[] = [];
  if (!d.ffmpeg.found) brew.push('ffmpeg');
  const venv = !d.mlx?.ready;
  const python3Ok = !!d.python3?.found && pythonVersionOk(d.python3.version);
  // With Homebrew, uv is worth installing even beside a usable python3: it pins
  // Python 3.12, while the system python3 may be too new for mlx's wheels.
  if (venv && !d.uv?.found && (d.homebrew.found || !python3Ok)) brew.push('uv');
  const download = d.mlx?.modelCached ? undefined : `Qwen3-ASR (${MLX_MODEL.sizeLabel})`;
  const steps: SetupStep[] = [
    ...brew.map(brewStep),
    ...(venv ? [{ action: 'setup_mlx_env', params: {}, label: 'Create the Python environment' }] : []),
    ...(download ? [{ action: 'download_mlx_model', params: {}, label: `Download ${download}` }] : []),
  ];
  return {
    steps,
    help: setupHelpText({ brew, venv, download }),
    ...(brew.length && !d.homebrew.found ? { blocker: 'homebrew' as const } : {}),
  };
}

export function planSetup(engine: SetupEngine, d: DetectionResult, activeWhisperModel: string | null): SetupPlan {
  return engine === 'mlx' ? planQwenSetup(d) : planWhisperSetup(d, activeWhisperModel);
}

/**
 * The `stt` fields a finished setup writes, from a scan taken AFTER the steps
 * ran (so the model and binary paths are the ones now on disk). Written through
 * the settings save path, so the page's own config updates with it and the rows
 * never flash back to "Set up" while a reload catches up.
 */
export function setupConfigPatch(
  engine: SetupEngine,
  fresh: DetectionResult,
  opts: { activateModel?: string; whisperServerPath?: string; defaultMlxModel: string },
): Record<string, string> {
  if (engine === 'mlx') {
    return { engine: 'mlx', mlx_python_path: fresh.mlx.pythonPath, mlx_model: opts.defaultMlxModel };
  }
  if (!opts.activateModel) return { engine: 'whisper-server' };
  const model = fresh.models.find((m) => m.name === opts.activateModel);
  if (!model) throw new Error(`${opts.activateModel} was not found after the download`);
  return {
    engine: 'whisper-server',
    whisper_server_path: fresh.whisperServer?.path ?? opts.whisperServerPath ?? 'whisper-server',
    whisper_server_model: model.path,
  };
}
