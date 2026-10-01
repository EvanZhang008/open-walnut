/**
 * Voice > Dictation decisions (web/src/components/settings/sections/stt-setup-plan.ts):
 * which engines the picker offers on which server, which one is recommended,
 * and what the one "Set up" button does and says for each state of a Mac.
 *
 * Background: a real new-user test found five engines in the picker, none
 * preselected, and a setup that took four separate clicks. The product answer is
 * three engines, the right one preselected, and one button whose help sentence
 * says exactly what it will install and download.
 */
import { describe, it, expect } from 'vitest';
import {
  engineOptionsFor, recommendedEngine, qwenSupported, setupHelpText, planWhisperSetup, planQwenSetup,
  pythonVersionOk, setupConfigPatch, HOMEBREW_INSTALL_COMMAND,
} from '../../web/src/components/settings/sections/stt-setup-plan.js';
import type { DetectionResult } from '../../web/src/api/stt.js';

const MAC = { os: 'darwin', arch: 'arm64' };
const INTEL_MAC = { os: 'darwin', arch: 'x64' };
const LINUX = { os: 'linux', arch: 'x64' };

const found = (name: string, extra: Record<string, string> = {}) => ({ name, found: true, path: `/opt/homebrew/bin/${name}`, ...extra });
const missing = (name: string) => ({ name, found: false });

/** A fresh Mac: nothing installed, not even Homebrew. */
function freshMac(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    platform: MAC,
    ffmpeg: missing('ffmpeg'),
    whisperCli: missing('whisper-cli'),
    whisperServer: missing('whisper-server'),
    sherpaOnnxNode: missing('sherpa-onnx-node'),
    homebrew: missing('homebrew'),
    uv: missing('uv'),
    python3: missing('python3'),
    mlx: { venvPath: '/home/u/.local/share/open-walnut/stt-mlx', pythonPath: '/home/u/.local/share/open-walnut/stt-mlx/bin/python', ready: false, modelCached: false },
    models: [],
    vadModel: null,
    recommendation: null,
    ...overrides,
  };
}

const labels = (opts: { label: string }[]) => opts.map((o) => o.label);

describe('engineOptionsFor: the picker offers exactly three engines', () => {
  it('Apple Silicon: Qwen3-ASR (recommended), Whisper, the cloud API', () => {
    const opts = engineOptionsFor(MAC, null);
    expect(labels(opts)).toEqual(['Qwen3-ASR', 'Whisper', 'OpenAI-compatible API']);
    expect(opts.map((o) => o.value)).toEqual(['mlx', 'whisper-server', 'openai']);
    expect(opts.filter((o) => o.recommended).map((o) => o.value)).toEqual(['mlx']);
    expect(opts.map((o) => o.badge)).toEqual(['Local', 'Local', 'Cloud']);
  });

  it('Intel Mac or Linux: no Qwen3-ASR, Whisper is recommended', () => {
    for (const p of [INTEL_MAC, LINUX]) {
      const opts = engineOptionsFor(p, null);
      expect(labels(opts)).toEqual(['Whisper', 'OpenAI-compatible API']);
      expect(opts.find((o) => o.recommended)?.value).toBe('whisper-server');
    }
  });

  it('keeps Qwen3-ASR listed when it is the active engine on a server that cannot run it', () => {
    expect(labels(engineOptionsFor(INTEL_MAC, 'mlx'))).toEqual(['Qwen3-ASR', 'Whisper', 'OpenAI-compatible API']);
  });

  it('offers a legacy engine only to the install already using it, labelled legacy', () => {
    expect(labels(engineOptionsFor(MAC, 'whisper-cpp'))).toEqual(['Qwen3-ASR', 'Whisper', 'Whisper CLI (legacy)', 'OpenAI-compatible API']);
    expect(labels(engineOptionsFor(MAC, 'sherpa-onnx'))).toEqual(['Qwen3-ASR', 'Whisper', 'sherpa-onnx (legacy)', 'OpenAI-compatible API']);
    for (const current of [null, 'mlx', 'whisper-server', 'openai'] as const) {
      const text = labels(engineOptionsFor(MAC, current)).join(' ');
      expect(text).not.toMatch(/Whisper CLI|sherpa-onnx/);
    }
  });

  it('before the scan answers there is no platform: nothing is marked recommended', () => {
    const opts = engineOptionsFor(null, null);
    expect(labels(opts)).toEqual(['Whisper', 'OpenAI-compatible API']);
    expect(opts.some((o) => o.recommended)).toBe(false);
  });

  it('recommendedEngine / qwenSupported follow the server platform', () => {
    expect(recommendedEngine(MAC)).toBe('mlx');
    expect(recommendedEngine(INTEL_MAC)).toBe('whisper-server');
    expect(recommendedEngine(LINUX)).toBe('whisper-server');
    expect(qwenSupported({ os: 'linux', arch: 'arm64' })).toBe(false);
  });
});

describe('setupHelpText: one sentence saying what Set up will do', () => {
  it('names the Homebrew installs, the Python environment and the download', () => {
    expect(setupHelpText({ brew: ['ffmpeg', 'whisper-cpp'], download: 'Large v3 Turbo (1.6 GB)' }))
      .toBe('Installs ffmpeg and whisper-cpp with Homebrew, downloads Large v3 Turbo (1.6 GB).');
    expect(setupHelpText({ brew: ['ffmpeg'], venv: true, download: 'Qwen3-ASR (2.3 GB)' }))
      .toBe('Installs ffmpeg with Homebrew, creates a Python environment with mlx-audio (about 400 MB), downloads Qwen3-ASR (2.3 GB).');
    expect(setupHelpText({ brew: ['ffmpeg', 'uv', 'x'] })).toBe('Installs ffmpeg, uv and x with Homebrew.');
    expect(setupHelpText({ venv: true })).toBe('Creates a Python environment with mlx-audio (about 400 MB).');
    expect(setupHelpText({ download: 'Qwen3-ASR (2.3 GB)' })).toBe('Downloads Qwen3-ASR (2.3 GB).');
  });

  it('says so when nothing is missing', () => {
    expect(setupHelpText({})).toBe('Everything it needs is already on this Mac.');
  });

  it('never uses a dash or a decorative symbol (settings copy rules)', () => {
    const all = [
      setupHelpText({ brew: ['ffmpeg', 'whisper-cpp'], venv: true, download: 'Qwen3-ASR (2.3 GB)' }),
      planQwenSetup(freshMac({ homebrew: found('brew') })).help,
      planWhisperSetup(freshMac({ homebrew: found('brew') }), null).help,
    ].join(' ');
    // Dashes and the decorative symbols the settings copy spec bans (escaped here).
    expect(all).not.toMatch(/[\u2014\u2013\u00b7\u2192\u203a\u25b8\u25be\u2713\u2717\u00d7\u2026\u2197]/);
  });
});

describe('planWhisperSetup', () => {
  it('fresh Mac with Homebrew: installs ffmpeg and whisper-cpp, downloads and activates Large v3 Turbo', () => {
    const plan = planWhisperSetup(freshMac({ homebrew: found('brew') }), null);
    expect(plan.steps.map((s) => [s.action, s.params])).toEqual([
      ['install_brew_pkg', { pkg: 'ffmpeg' }],
      ['install_brew_pkg', { pkg: 'whisper-cpp' }],
      ['download_ggml_model', { model: 'ggml-large-v3-turbo' }],
    ]);
    expect(plan.help).toBe('Installs ffmpeg and whisper-cpp with Homebrew, downloads Large v3 Turbo (1.6 GB).');
    expect(plan.activateModel).toBe('ggml-large-v3-turbo');
    expect(plan.blocker).toBeUndefined();
    // No VAD step: the whisper-server engine runs without a VAD model.
    expect(plan.steps.some((s) => s.action === 'download_vad_model')).toBe(false);
  });

  it('no Homebrew and something to install: Homebrew is the one thing to install first', () => {
    const plan = planWhisperSetup(freshMac(), null);
    expect(plan.blocker).toBe('homebrew');
    expect(HOMEBREW_INSTALL_COMMAND).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
  });

  it('binaries present, no model: only the download (no Homebrew needed)', () => {
    const d = freshMac({ ffmpeg: found('ffmpeg'), whisperServer: found('whisper-server') });
    const plan = planWhisperSetup(d, null);
    expect(plan.steps.map((s) => s.action)).toEqual(['download_ggml_model']);
    expect(plan.blocker).toBeUndefined();
    expect(plan.help).toBe('Downloads Large v3 Turbo (1.6 GB).');
  });

  it('Turbo already downloaded: nothing to run, it still gets activated', () => {
    const d = freshMac({
      ffmpeg: found('ffmpeg'), whisperServer: found('whisper-server'),
      models: [{ name: 'ggml-large-v3-turbo', path: '/m/ggml-large-v3-turbo.bin', sizeBytes: 1 }],
    });
    const plan = planWhisperSetup(d, null);
    expect(plan.steps).toEqual([]);
    expect(plan.activateModel).toBe('ggml-large-v3-turbo');
    expect(plan.help).toBe('Everything it needs is already on this Mac.');
  });

  it('keeps a configured model that is on disk (only the missing binary is installed)', () => {
    const d = freshMac({
      homebrew: found('brew'), ffmpeg: found('ffmpeg'),
      models: [{ name: 'ggml-base.en', path: '/m/ggml-base.en.bin', sizeBytes: 1 }],
    });
    const plan = planWhisperSetup(d, 'ggml-base.en');
    expect(plan.steps.map((s) => s.params.pkg ?? s.action)).toEqual(['whisper-cpp']);
    expect(plan.activateModel).toBeUndefined();
  });
});

describe('planQwenSetup', () => {
  it('Homebrew and uv present, ffmpeg missing: ffmpeg, the env, the model', () => {
    const plan = planQwenSetup(freshMac({ homebrew: found('brew'), uv: found('uv') }));
    expect(plan.steps.map((s) => s.action)).toEqual(['install_brew_pkg', 'setup_mlx_env', 'download_mlx_model']);
    expect(plan.steps[0].params).toEqual({ pkg: 'ffmpeg' });
    expect(plan.help).toBe('Installs ffmpeg with Homebrew, creates a Python environment with mlx-audio (about 400 MB), downloads Qwen3-ASR (2.3 GB).');
    expect(plan.blocker).toBeUndefined();
  });

  it('Homebrew but neither uv nor a new enough python3: installs uv with Homebrew first', () => {
    const d = freshMac({ homebrew: found('brew'), ffmpeg: found('ffmpeg'), python3: found('python3', { version: '3.9.6' }) });
    const plan = planQwenSetup(d);
    expect(plan.steps.map((s) => s.params.pkg ?? s.action)).toEqual(['uv', 'setup_mlx_env', 'download_mlx_model']);
    expect(plan.help).toMatch(/^Installs uv with Homebrew, creates a Python environment/);
  });

  it('Homebrew and a new python3 but no uv: still installs uv, which pins Python 3.12', () => {
    const d = freshMac({ homebrew: found('brew'), ffmpeg: found('ffmpeg'), python3: found('python3', { version: '3.14.7' }) });
    expect(planQwenSetup(d).steps.map((s) => s.params.pkg ?? s.action)).toEqual(['uv', 'setup_mlx_env', 'download_mlx_model']);
  });

  it('python3 3.10 or newer is enough without uv or Homebrew', () => {
    const d = freshMac({ ffmpeg: found('ffmpeg'), python3: found('python3', { version: '3.12.4' }) });
    const plan = planQwenSetup(d);
    expect(plan.blocker).toBeUndefined();
    expect(plan.steps.map((s) => s.action)).toEqual(['setup_mlx_env', 'download_mlx_model']);
  });

  it('no Homebrew, no uv, no new enough python3: Homebrew first', () => {
    expect(planQwenSetup(freshMac({ ffmpeg: found('ffmpeg') })).blocker).toBe('homebrew');
    expect(planQwenSetup(freshMac({ ffmpeg: found('ffmpeg'), python3: found('python3', { version: '3.9.6' }) })).blocker).toBe('homebrew');
  });

  it('ffmpeg missing and no Homebrew blocks even when uv exists', () => {
    expect(planQwenSetup(freshMac({ uv: found('uv') })).blocker).toBe('homebrew');
  });

  it('env ready, model cached: nothing left but turning it on', () => {
    const d = freshMac({ ffmpeg: found('ffmpeg'), mlx: { ...freshMac().mlx, ready: true, modelCached: true } });
    const plan = planQwenSetup(d);
    expect(plan.steps).toEqual([]);
    expect(plan.help).toBe('Everything it needs is already on this Mac.');
  });

  it('env ready, model missing: only the download', () => {
    const d = freshMac({ ffmpeg: found('ffmpeg'), mlx: { ...freshMac().mlx, ready: true } });
    expect(planQwenSetup(d).steps.map((s) => s.action)).toEqual(['download_mlx_model']);
  });
});

describe('pythonVersionOk', () => {
  it('accepts 3.10 and newer only', () => {
    expect(pythonVersionOk('3.10.0')).toBe(true);
    expect(pythonVersionOk('3.14.7')).toBe(true);
    expect(pythonVersionOk('4.0')).toBe(true);
    expect(pythonVersionOk('3.9.6')).toBe(false);
    expect(pythonVersionOk(undefined)).toBe(false);
    expect(pythonVersionOk('garbage')).toBe(false);
  });
});

describe('setupConfigPatch: what a finished setup writes', () => {
  it('Qwen3-ASR: the managed venv python and the default model', () => {
    const d = freshMac();
    expect(setupConfigPatch('mlx', d, { defaultMlxModel: 'mlx-community/Qwen3-ASR-1.7B-8bit' })).toEqual({
      engine: 'mlx', mlx_python_path: d.mlx.pythonPath, mlx_model: 'mlx-community/Qwen3-ASR-1.7B-8bit',
    });
  });

  it('Whisper: the binary and the downloaded model paths from the fresh scan', () => {
    const d = freshMac({
      whisperServer: found('whisper-server'),
      models: [{ name: 'ggml-large-v3-turbo', path: '/m/ggml-large-v3-turbo.bin', sizeBytes: 1 }],
    });
    expect(setupConfigPatch('whisper-server', d, { activateModel: 'ggml-large-v3-turbo', defaultMlxModel: 'x' })).toEqual({
      engine: 'whisper-server', whisper_server_path: '/opt/homebrew/bin/whisper-server', whisper_server_model: '/m/ggml-large-v3-turbo.bin',
    });
    // Kept model: only the engine changes.
    expect(setupConfigPatch('whisper-server', d, { defaultMlxModel: 'x' })).toEqual({ engine: 'whisper-server' });
  });

  it('refuses to point the engine at a model the scan cannot find', () => {
    expect(() => setupConfigPatch('whisper-server', freshMac(), { activateModel: 'ggml-large-v3-turbo', defaultMlxModel: 'x' }))
      .toThrow(/not found/);
  });
});
