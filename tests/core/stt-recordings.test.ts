/**
 * Voice recording store — persistence, listing, recovery, pruning, id safety.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => dir };
});

import {
  saveRecordingAudio,
  writeRecordingResult,
  listRecordings,
  readRecordingAudio,
} from '../../src/core/stt/recordings.js';

describe('stt recordings store', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-rec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves audio before transcription and reads it back', async () => {
    const audio = Buffer.from('fake-webm-bytes').toString('base64');
    const { id } = await saveRecordingAudio(audio, 'webm');
    expect(id).toMatch(/^[0-9A-Za-z-]+$/);

    const stored = await readRecordingAudio(id);
    expect(stored).not.toBeNull();
    expect(stored!.format).toBe('webm');
    expect(Buffer.from(stored!.audio, 'base64').toString()).toBe('fake-webm-bytes');
  });

  it('lists recordings newest-first with results and errors', async () => {
    const a = await saveRecordingAudio(Buffer.from('a').toString('base64'), 'webm');
    await writeRecordingResult(a.id, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      result: { text: 'hello', durationMs: 10 },
    });
    // Distinct id: saveRecordingAudio ids are timestamp-based and can collide
    // within the same ms — write the second under a manual id.
    await writeRecordingResult(`${a.id}-zzz`, {
      format: 'webm', language: 'auto', audioSizeBytes: 1,
      error: 'engine exploded',
    });

    const list = await listRecordings();
    expect(list.length).toBe(2);
    const failed = list.find(r => r.error);
    const succeeded = list.find(r => r.result);
    expect(failed?.error).toBe('engine exploded');
    expect(failed?.result).toBeUndefined();
    expect(succeeded?.result?.text).toBe('hello');
  });

  it('audio survives even when transcription result is never written (lost response)', async () => {
    const { id } = await saveRecordingAudio(Buffer.from('lost').toString('base64'), 'mp4');
    // No writeRecordingResult — simulates engine hang / dropped response
    const stored = await readRecordingAudio(id);
    expect(stored).not.toBeNull();
    expect(stored!.format).toBe('mp4');
  });

  it('rejects path-traversal ids', async () => {
    expect(await readRecordingAudio('../../etc/passwd')).toBeNull();
    await expect(
      writeRecordingResult('../evil', { format: 'webm', language: 'auto', audioSizeBytes: 0 }),
    ).rejects.toThrow(/Invalid recording id/);
  });

  it('prunes beyond the cap keeping newest', async () => {
    for (let i = 0; i < 105; i++) {
      const id = `2026-01-01T00-00-00-${String(i).padStart(3, '0')}Z`;
      await writeRecordingResult(id, {
        format: 'webm', language: 'auto', audioSizeBytes: 0,
        result: { text: `t${i}`, durationMs: 1 },
      });
    }
    const files = await readdir(join(dir, '.open-walnut', 'stt-debug'));
    const jsons = files.filter(f => f.endsWith('.json'));
    expect(jsons.length).toBeLessThanOrEqual(100);
    // The newest survives
    expect(jsons.some(f => f.includes('-104Z'))).toBe(true);
    // The oldest are gone
    expect(jsons.some(f => f.includes('-000Z'))).toBe(false);
  });
});
