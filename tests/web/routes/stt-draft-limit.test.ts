/**
 * POST /api/stt/draft body bounds, through the real HTTP edge.
 *
 * Why this route gets its own parser: a draft fires every 2 seconds from a live
 * recording, so it is the one upload a single client repeats indefinitely, and
 * `express.json` parses on the shared event loop. On 2026-09-01 a runaway
 * dictation posted a body that grew to 15.7MB every 2s; the generic 15mb parser
 * was what finally answered 413, which means bodies up to 15MB were being PARSED
 * on the loop first, in front of every other route.
 *
 * The mount ORDER below is the load-bearing part: `express.json` skips a body
 * that is already parsed, so the first matching mount wins. A parser declared
 * only inside the router (as this route used to have) is a no-op in production.
 *
 * The STT engine is mocked — no transcription, no child process, no microphone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getConfig: async () => ({ stt: { engine: 'whisper-cpp', language: 'en' } }),
  updateConfig: async () => {},
}));

import express from 'express';
import request from 'supertest';

const { sttRouter } = await import('../../../src/web/routes/stt.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

/** Mirrors the production mount order in server.ts. */
function makeApp() {
  const app = express();
  app.use(['/api/v1/stt/draft', '/api/stt/draft'], express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/stt', sttRouter);
  app.use(errorHandler);
  return app;
}

/** A JSON body of about `mb` megabytes, sent raw so nothing re-serializes it. */
function jsonBodyOfSize(mb: number): string {
  const envelope = JSON.stringify({ audio: '', format: 'wav' });
  const audio = 'A'.repeat(Math.round(mb * 1024 * 1024) - envelope.length);
  return JSON.stringify({ audio, format: 'wav' });
}

beforeEach(() => {
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue({ text: 'hello there', durationMs: 12 });
});

describe('POST /api/stt/draft — body bounds', () => {
  it('rejects a 7MB body with 413 without parsing or transcribing it', async () => {
    const res = await request(makeApp())
      .post('/api/stt/draft')
      .set('Content-Type', 'application/json')
      .send(jsonBodyOfSize(7));

    expect(res.status).toBe(413);
    // The specific 6mb mount answered, not the generic 15mb one, and the engine
    // was never reached.
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('rejects an oversized audio string with a coded 413 before any decode', async () => {
    // Fits the 6mb parser, exceeds the handler's 5MB audio cap.
    const res = await request(makeApp())
      .post('/api/stt/draft')
      .send({ audio: 'A'.repeat(5.5 * 1024 * 1024), format: 'wav' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('draft_too_large');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('lets an ordinary draft through to the engine', async () => {
    const res = await request(makeApp())
      .post('/api/stt/draft')
      .send({ audio: 'A'.repeat(64 * 1024), format: 'wav', language: 'en' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello there', durationMs: 12 });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('accepts a draft at the client cap (4MB of base64)', async () => {
    // The bound must never reject a legitimate draft: the client's own cap is
    // 4MB, and 6mb exists precisely to leave that room.
    const res = await request(makeApp())
      .post('/api/stt/draft')
      .send({ audio: 'A'.repeat(4 * 1024 * 1024), format: 'wav' });

    expect(res.status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('still validates audio and format', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/stt/draft').send({ format: 'wav' })).status).toBe(400);
    expect((await request(app).post('/api/stt/draft').send({ audio: 'AAAA', format: 'exe' })).status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('does not tighten the authoritative /transcribe lane', async () => {
    // /transcribe carries a whole recording (its own 35mb mount) — the draft cap
    // must not leak onto it.
    const app = express();
    app.use(['/api/v1/stt/transcribe', '/api/stt/transcribe'], express.json({ limit: '35mb' }));
    app.use(['/api/v1/stt/draft', '/api/stt/draft'], express.json({ limit: '6mb' }));
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/stt', sttRouter);
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/stt/transcribe')
      .send({ audio: 'A'.repeat(8 * 1024 * 1024), format: 'webm' });

    expect(res.status).toBe(200);
  });
});
