/**
 * Shadow (secondary) STT engine — recordings merge, engine factory, shadow runner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stored on globalThis, NOT a module-level `let`: src/core/stt/index.ts derives a
// constant from WALNUT_HOME at IMPORT time, which runs before this module's body
// (imports are hoisted above the `let` initializer → TDZ). globalThis dodges that;
// beforeEach points it at the per-test temp dir.
let dir: string;
const g = globalThis as unknown as { __sttSecDir?: string };
vi.mock('../../src/constants.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  // Reference globalThis directly — the module-body `const g` above is itself in
  // the TDZ when hoisted imports evaluate this factory.
  const base = () =>
    (globalThis as unknown as { __sttSecDir?: string }).__sttSecDir ?? join(tmpdir(), 'stt-sec-unset');
  return {
    ...orig,
    get TMP_DIR() { return join(base(), 'tmp'); },
    get WALNUT_HOME() { return base(); },
    get STT_VOCAB_FILE() { return join(base(), 'config', 'share', 'stt-vocab.txt'); },
  };
});

// Stub the sherpa engine so the shadow SUCCESS path can run end-to-end without
// native deps. Only createSherpaEngine is replaced; sherpa is otherwise unused here.
vi.mock('../../src/core/stt/engine-sherpa.js', () => ({
  createSherpaEngine: () => ({
    name: 'sherpa-onnx',
    isAvailable: async () => ({ available: true }),
    transcribe: async () => ({ text: 'stub shadow text', durationMs: 7 }),
  }),
}));

import {
  saveRecordingAudio,
  writeRecordingResult,
  writeRecordingSecondary,
  listRecordings,
  recordingsDir,
} from '../../src/core/stt/recordings.js';
import { createEngineByName, runShadowTranscription, getOrCreateSecondaryEngine, stripVocabEcho } from '../../src/core/stt/index.js';
import { mlxLanguageName, DEFAULT_MLX_MODEL } from '../../src/core/stt/engine-mlx.js';
import type { Config } from '../../src/core/types.js';

describe('recordings secondary result', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-sec-'));
    g.__sttSecDir = dir;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges the shadow result without clobbering the primary', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'primary text', durationMs: 10 },
    });
    await writeRecordingSecondary(id, { engine: 'whisper-server', text: 'shadow text', durationMs: 99 });

    const [rec] = await listRecordings();
    expect(rec.result?.text).toBe('primary text');
    expect(rec.secondary).toEqual({ engine: 'whisper-server', text: 'shadow text', durationMs: 99 });

    // Raw JSON keeps both — read-merge-write, not overwrite
    const raw = JSON.parse(await readFile(join(recordingsDir(), `${id}.json`), 'utf-8'));
    expect(raw.result.text).toBe('primary text');
    expect(raw.secondary.text).toBe('shadow text');
  });

  it('records a shadow ERROR without touching the primary', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'ok', durationMs: 5 },
    });
    await writeRecordingSecondary(id, { engine: 'mlx', error: 'daemon exploded' });

    const [rec] = await listRecordings();
    expect(rec.result?.text).toBe('ok');
    expect(rec.secondary?.error).toBe('daemon exploded');
    expect(rec.secondary?.text).toBeUndefined();
  });

  it('is a no-op when the recording metadata does not exist', async () => {
    await expect(writeRecordingSecondary('2026-01-01T00-00-00-000Z', { engine: 'mlx', text: 'x' }))
      .resolves.toBeUndefined();
    expect(await listRecordings()).toEqual([]);
  });

  it('rejects path-traversal ids', async () => {
    await expect(writeRecordingSecondary('../evil', { engine: 'mlx', text: 'x' }))
      .rejects.toThrow(/Invalid recording id/);
  });

  it('drops a stale shadow whose epoch token no longer matches (Redo re-ran the primary)', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    const stamp1 = await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'first run', durationMs: 5 },
    });
    // Redo overwrites the primary with a new stamp…
    const stamp2 = await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      timestamp: '2099-01-01T00:00:00.000Z', // force a distinct stamp (same-ms writes)
      result: { text: 'second run', durationMs: 5 },
    });
    expect(stamp2).not.toBe(stamp1);
    // …then the FIRST run's slow shadow finally lands: must be dropped.
    await writeRecordingSecondary(id, { engine: 'whisper-server', text: 'stale shadow' }, stamp1);
    let [rec] = await listRecordings();
    expect(rec.secondary).toBeUndefined();
    // The current epoch's shadow attaches fine.
    await writeRecordingSecondary(id, { engine: 'whisper-server', text: 'fresh shadow' }, stamp2);
    [rec] = await listRecordings();
    expect(rec.secondary?.text).toBe('fresh shadow');
    expect(rec.result?.text).toBe('second run');
  });
});

describe('engine factory', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-sec-'));
    g.__sttSecDir = dir;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates an mlx engine from the shared stt section', () => {
    const engine = createEngineByName('mlx', { mlx_python_path: '/nonexistent/python' });
    expect(engine?.name).toBe('mlx');
    engine?.shutdown?.(); // release the instance's process signal handlers
  });

  it('refuses a secondary engine equal to the primary (would double the daemon)', () => {
    const config = {
      stt: { engine: 'mlx', secondary_engine: 'mlx', mlx_python_path: '/nonexistent/python' },
    } as Config;
    expect(getOrCreateSecondaryEngine(config)).toBeNull();
  });

  it('maps ISO language hints to mlx model language names', () => {
    expect(mlxLanguageName('zh')).toBe('Chinese');
    expect(mlxLanguageName('en')).toBe('English');
    expect(mlxLanguageName('')).toBeUndefined();
    expect(mlxLanguageName(undefined)).toBeUndefined();
    expect(mlxLanguageName('xx')).toBeUndefined(); // unknown → auto-detect
  });

  it('has a sensible default model', () => {
    expect(DEFAULT_MLX_MODEL).toMatch(/Qwen3-ASR/);
  });
});

describe('runShadowTranscription', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-sec-'));
    g.__sttSecDir = dir;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    // Reset the module-level secondary singleton so the next test's config change
    // doesn't inherit this one's cached engine.
    getOrCreateSecondaryEngine({} as Config);
  });

  it('does nothing when no secondary engine is configured', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'ok', durationMs: 5 },
    });
    await runShadowTranscription({ stt: { engine: 'whisper-cpp' } } as Config, { audio: 'x', format: 'webm' }, id);
    const [rec] = await listRecordings();
    expect(rec.secondary).toBeUndefined();
  });

  it('writes an unavailability error instead of throwing', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'ok', durationMs: 5 },
    });
    const config = {
      stt: {
        engine: 'whisper-cpp',
        secondary_engine: 'mlx',
        mlx_python_path: join(dir, 'no-such-python'), // stat fails → unavailable, nothing spawned
      },
    } as Config;
    await runShadowTranscription(config, { audio: 'x', format: 'webm' }, id);
    const [rec] = await listRecordings();
    expect(rec.secondary?.engine).toBe('mlx');
    expect(rec.secondary?.error).toMatch(/not available/);
    expect(rec.result?.text).toBe('ok');
  });

  it('merges the shadow SUCCESS text with its epoch token intact', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    const stamp = await writeRecordingResult(id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'primary', durationMs: 5 },
    });
    const config = {
      stt: { engine: 'whisper-cpp', secondary_engine: 'sherpa-onnx', sherpa_model_dir: '/x' },
    } as Config;
    await runShadowTranscription(config, { audio: 'x', format: 'webm' }, id, stamp);
    const [rec] = await listRecordings();
    expect(rec.result?.text).toBe('primary');
    expect(rec.secondary).toEqual({ engine: 'sherpa-onnx', text: 'stub shadow text', durationMs: 7 });
  });
});

describe('stripVocabEcho', () => {
  const VOCAB = 'Kubernetes, DynamoDB, PostgreSQL, Walnut, Claude, Anthropic';

  it('strips a trailing comma-separated echo of the vocab list', () => {
    const t = '冷启动和热启动是怎么work的? Kubernetes, DynamoDB, PostgreSQL';
    expect(stripVocabEcho(t, VOCAB)).toBe('冷启动和热启动是怎么work的?');
  });

  it('is case-insensitive and tolerates trailing punctuation', () => {
    const t = '好的。 kubernetes, walnut.';
    expect(stripVocabEcho(t, VOCAB)).toBe('好的。');
  });

  it('keeps a single trailing vocab word — that is real speech', () => {
    const t = '我们管这个项目叫 Walnut';
    expect(stripVocabEcho(t, VOCAB)).toBe(t);
  });

  it('keeps vocab words mid-sentence', () => {
    const t = 'Walnut 和 Claude 都部署好了吗';
    expect(stripVocabEcho(t, VOCAB)).toBe(t);
  });

  it('respects word boundaries — no peeling out of a larger word', () => {
    const t = '这个库叫 MyWalnut, Claude';
    expect(stripVocabEcho(t, VOCAB)).toBe(t);
  });

  it('empty vocab is a no-op', () => {
    expect(stripVocabEcho('anything Kubernetes, DynamoDB', '')).toBe('anything Kubernetes, DynamoDB');
  });
});
