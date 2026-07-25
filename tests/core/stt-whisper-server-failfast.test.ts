/**
 * whisper-server engine: fail-fast startup + diagnostic surfacing.
 *
 * Regression guard for the launchd incident — the daemon exited (code 0,
 * "ffmpeg: command not found") within ~1s but the engine kept polling the
 * port for the full 30s and then threw a generic timeout. The engine must:
 *   1. detect the child's exit and fail in ~1 health-check tick, not 30s;
 *   2. include the child's own stderr complaint in the thrown error.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, chmod, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhisperServerEngine } from '../../src/core/stt/engine-whisper-server.js';

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  workDir = null;
});

/** A fake whisper-server that mimics the incident: prints the ffmpeg complaint and exits 0. */
async function makeExitingBinary(): Promise<{ bin: string; model: string }> {
  workDir = await mkdtemp(join(tmpdir(), 'walnut-stt-failfast-'));
  const bin = join(workDir, 'fake-whisper-server');
  await writeFile(bin, [
    '#!/bin/sh',
    'echo "load_backend: loaded CPU backend" >&2',
    'echo "ffmpeg is not found. Please ensure that ffmpeg is installed" >&2',
    'exit 0',
  ].join('\n'));
  await chmod(bin, 0o755);
  const model = join(workDir, 'fake-model.bin');
  await writeFile(model, 'not-a-real-model');
  return { bin, model };
}

describe('whisper-server engine fail-fast', () => {
  it('fails within ~2s (not 30s) when the daemon exits during startup, surfacing its stderr', async () => {
    const { bin, model } = await makeExitingBinary();
    const engine = createWhisperServerEngine({ binaryPath: bin, modelPath: model });

    const t0 = Date.now();
    let error: Error | null = null;
    try {
      await engine.transcribe({ audio: Buffer.from('x').toString('base64'), format: 'webm' });
    } catch (e) {
      error = e as Error;
    } finally {
      engine.shutdown?.();
    }
    const elapsed = Date.now() - t0;

    expect(error).not.toBeNull();
    // Fail-fast: one or two 500ms health-check ticks, nowhere near 30s.
    expect(elapsed).toBeLessThan(5000);
    expect(error!.message).toContain('exited during startup');
    // The child's actual complaint must reach the user-facing error.
    expect(error!.message).toContain('ffmpeg is not found');
  }, 15_000);
});
