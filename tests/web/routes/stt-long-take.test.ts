/**
 * A take of any length reaches the engine whole (2026-11-20: the 25MB-base64 cap
 * of POST /api/stt/transcribe ends a Mac app take at about 11 minutes, whose
 * recorder writes about 1.7 MB a minute). The web recorder sends its clip as raw
 * bytes; the JSON lane keeps its cap. Through the real HTTP edge, in the
 * production mount order; the engine is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const transcribeAudio = vi.fn();
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
  runShadowTranscription: vi.fn(async () => {}),
  createEngine: vi.fn(() => null),
  getOrCreateEngine: vi.fn(() => null),
  ensureSttVocabMigrated: vi.fn(async () => {}),
  prewarmSttEngines: vi.fn(async () => {}),
}));

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ stt: { engine: 'mlx' } }),
  updateConfig: async () => {},
}));

import express from 'express';
import request from 'supertest';

const { sttRouter, STT_CLIP_RAW_LIMIT } = await import('../../../src/web/routes/stt.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

/** Mirrors the production mount order in server.ts. */
function makeApp() {
  const app = express();
  app.use(['/api/v1/stt/transcribe', '/api/stt/transcribe'], express.json({ limit: '35mb' }));
  app.use('/api/stt/transcribe', express.raw({ type: 'application/octet-stream', limit: STT_CLIP_RAW_LIMIT }));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/stt', sttRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue({ text: 'the whole take', durationMs: 60_000 });
});

describe('POST /api/stt/transcribe with a long take', () => {
  it('takes a 40 MB clip (about 24 minutes of the Mac app recorder) as raw bytes, whole', async () => {
    const clip = Buffer.alloc(40 * 1024 * 1024, 7);
    const res = await request(makeApp())
      .post('/api/stt/transcribe?format=webm&language=zh&surface=%2Fsessions')
      .set('Content-Type', 'application/octet-stream')
      .send(clip);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('the whole take');
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const req = transcribeAudio.mock.calls[0]![1] as { audio: string; format: string; language: string };
    expect(req.format).toBe('webm');
    expect(req.language).toBe('zh');
    expect(Buffer.from(req.audio, 'base64').equals(clip)).toBe(true);
  });

  it('still refuses a raw clip with no format', async () => {
    const res = await request(makeApp()).post('/api/stt/transcribe').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(10, 1));
    expect(res.status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('the JSON lane keeps its 25MB base64 cap', async () => {
    const res = await request(makeApp())
      .post('/api/stt/transcribe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ audio: 'A'.repeat(26 * 1024 * 1024), format: 'webm' }));
    expect(res.status).toBe(413);
  });

  it('production mounts the raw parser for the web route, before the generic JSON parser', () => {
    const server = readFileSync(join(__dirname, '../../../src/web/server.ts'), 'utf8');
    const raw = server.indexOf("app.use('/api/stt/transcribe', express.raw({ type: 'application/octet-stream', limit: STT_CLIP_RAW_LIMIT }))");
    const generic = server.indexOf("app.use(express.json({ limit: '15mb' }))");
    expect(raw).toBeGreaterThan(0);
    expect(raw).toBeLessThan(generic);
  });

  it('a failed pass answers with the id of the clip it kept, so Retry hears it again with no upload', async () => {
    transcribeAudio.mockRejectedValueOnce(new Error('engine timed out'));
    const res = await request(makeApp())
      .post('/api/stt/transcribe?format=webm')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(30 * 1024 * 1024, 3));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('engine timed out');
    expect(typeof res.body.recordingId).toBe('string');
  });

  it('ffmpeg gets time for a long clip', async () => {
    const { convertTimeoutMs } = await import('../../../src/core/stt/audio-convert.js');
    expect(convertTimeoutMs(100_000)).toBe(40_000);
    // A 30-minute take of the Mac app recorder is about 51 MB.
    expect(convertTimeoutMs(51 * 1024 * 1024)).toBeGreaterThanOrEqual(80_000);
  });
});

