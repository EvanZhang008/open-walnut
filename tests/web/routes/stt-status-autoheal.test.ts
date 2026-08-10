/**
 * STT route behaviors that guard past incidents:
 *  - GET /api/stt/status self-healing a config that lost its `stt:` section;
 *  - the custom vocabulary file's one-time move into config/share/ (2026-08).
 *
 * GET /api/stt/status — self-heal when `stt:` is missing from config.
 *
 * 2026-07-25 incident: a git-sync merge carried a remote deletion of a
 * still-TRACKED config.yaml, wiping the file. Readers fell back to defaults and
 * the next writer persisted that skeleton, so the `stt:` section was gone —
 * voice input greyed out with "No STT engine configured" even though
 * whisper-cli/whisper-server and the models were all still installed.
 *
 * The route now re-detects local engines and rewrites the config when (and only
 * when) nothing is configured, so a lost config is a hiccup, not a dead mic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const detectSystem = vi.fn();
vi.mock('../../../src/core/stt/detect.js', () => ({
  detectSystem: () => detectSystem(),
}));

import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { sttRouter } from '../../../src/web/routes/stt.js';
import { CONFIG_FILE, WALNUT_HOME, STT_VOCAB_FILE } from '../../../src/constants.js';
import { _resetWriteLockForTest } from '../../../src/core/config-manager.js';
import { _resetSttVocabMigrationForTest } from '../../../src/core/stt/index.js';

const LEGACY_VOCAB_FILE = path.join(WALNUT_HOME, 'stt-vocab.txt');

const MODEL = '/models/ggml-large-v3-turbo.bin';

/** Detection result for a box that has whisper fully installed. */
function healthyDetection(opts: { server: boolean }) {
  return {
    ffmpeg: { name: 'ffmpeg', found: true, path: '/opt/homebrew/bin/ffmpeg' },
    whisperCli: { name: 'whisper-cli', found: true, path: '/opt/homebrew/bin/whisper-cli' },
    whisperServer: opts.server
      ? { name: 'whisper-server', found: true, path: '/opt/homebrew/bin/whisper-server' }
      : { name: 'whisper-server', found: false },
    sherpaOnnxNode: { name: 'sherpa-onnx-node', found: false },
    homebrew: { name: 'homebrew', found: true, path: '/opt/homebrew/bin/brew' },
    models: [{ name: 'ggml-large-v3-turbo', path: MODEL, sizeBytes: 1_600_000_000 }],
    vadModel: { name: 'ggml-silero', path: '/models/ggml-silero.bin', sizeBytes: 885_098 },
    recommendation: {
      engine: 'whisper-cpp' as const,
      reason: 'whisper-cli and model detected — ready to use',
      modelPath: MODEL,
      missingSteps: [] as string[],
    },
  };
}

function makeApp() {
  const app = express();
  app.use('/api/stt', sttRouter);
  return app;
}

async function readConfig(): Promise<Record<string, any>> {
  return (yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>) ?? {};
}

beforeEach(async () => {
  detectSystem.mockReset();
  _resetWriteLockForTest();
  // The legacy→config/share vocab move is memoized per process; each test starts
  // from a fresh WALNUT_HOME, so it has to be allowed to run again.
  _resetSttVocabMigrationForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

describe('GET /api/stt/status self-heal', () => {
  it('heals a config that lost its stt section, preferring whisper-server', async () => {
    // The post-incident config: everything else intact, `stt:` gone.
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, provider: { type: 'bedrock' } }), 'utf-8');
    detectSystem.mockResolvedValue(healthyDetection({ server: true }));

    const res = await request(makeApp()).get('/api/stt/status');

    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('whisper-server');
    // Persisted, so the next boot doesn't need to re-detect.
    const saved = await readConfig();
    expect(saved.stt.engine).toBe('whisper-server');
    expect(saved.stt.whisper_server_model).toBe(MODEL);
    // Unrelated sections must survive the heal.
    expect(saved.provider.type).toBe('bedrock');
  });

  it('falls back to whisper-cpp when only the CLI is installed', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1 }), 'utf-8');
    detectSystem.mockResolvedValue(healthyDetection({ server: false }));

    const res = await request(makeApp()).get('/api/stt/status');

    expect(res.body.engine).toBe('whisper-cpp');
    expect((await readConfig()).stt.whisper_cpp_model).toBe(MODEL);
  });

  it('does NOT overwrite an engine the user already configured', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      stt: { engine: 'openai', openai_api_key: 'sk-test', openai_model: 'whisper-1' },
    }), 'utf-8');
    detectSystem.mockResolvedValue(healthyDetection({ server: true }));

    await request(makeApp()).get('/api/stt/status');

    expect((await readConfig()).stt.engine).toBe('openai');
    expect(detectSystem).not.toHaveBeenCalled(); // no detection needed at all
  });

  it('reports not-configured (and writes nothing) when no local engine exists', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1 }), 'utf-8');
    detectSystem.mockResolvedValue({
      ...healthyDetection({ server: false }),
      whisperCli: { name: 'whisper-cli', found: false },
      models: [],
      // Nothing local → the detector recommends the cloud engine, which needs
      // an API key we must never invent.
      recommendation: {
        engine: 'openai' as const,
        reason: 'No local engines detected.',
        missingSteps: ['configure_api_key'],
      },
    });

    const res = await request(makeApp()).get('/api/stt/status');

    expect(res.body).toMatchObject({ engine: null, available: false });
    expect((await readConfig()).stt).toBeUndefined();
  });

  it('surfaces not-configured rather than 500 when detection itself throws', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1 }), 'utf-8');
    detectSystem.mockRejectedValue(new Error('which: command not found'));

    const res = await request(makeApp()).get('/api/stt/status');

    expect(res.status).toBe(200);
    expect(res.body.engine).toBeNull();
  });
});

describe('custom vocabulary in config/share/', () => {
  it('moves a pre-2026-08 root stt-vocab.txt on first read', async () => {
    await fs.writeFile(LEGACY_VOCAB_FILE, '# my words\nWalnut\nMarina\n', 'utf-8');

    const res = await request(makeApp()).get('/api/stt/vocab');

    expect(res.status).toBe(200);
    expect(res.body.words).toEqual(['Walnut', 'Marina']);
    // A move, not a copy: the root path must stop being a live location.
    await expect(fs.access(STT_VOCAB_FILE)).resolves.toBeUndefined();
    await expect(fs.access(LEGACY_VOCAB_FILE)).rejects.toThrow();
  });

  it('reports the path RELATIVE to the data dir, never the host filesystem path', async () => {
    const res = await request(makeApp()).get('/api/stt/vocab');
    // A paired phone / cloud box has no use for the Mac's /Users/... prefix.
    expect(res.body.path).toBe(path.join('config', 'share', 'stt-vocab.txt'));
    expect(path.isAbsolute(res.body.path)).toBe(false);
  });

  it('creates config/share/ when adding the first word (no vocab file yet)', async () => {
    const res = await request(makeApp()).post('/api/stt/vocab').send({ word: 'Walnut' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: true, word: 'Walnut' });
    expect(await fs.readFile(STT_VOCAB_FILE, 'utf-8')).toBe('Walnut\n');
  });

  it('leaves an already-migrated file alone (new location wins)', async () => {
    await fs.mkdir(path.dirname(STT_VOCAB_FILE), { recursive: true });
    await fs.writeFile(STT_VOCAB_FILE, 'Migrated\n', 'utf-8');
    await fs.writeFile(LEGACY_VOCAB_FILE, 'Stale\n', 'utf-8');

    const res = await request(makeApp()).get('/api/stt/vocab');

    expect(res.body.words).toEqual(['Migrated']);
    await expect(fs.access(LEGACY_VOCAB_FILE)).resolves.toBeUndefined();
  });
});
