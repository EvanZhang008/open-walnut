/**
 * Two STT route contracts the 2026-09-28 dictation failure depended on.
 *
 *  · POST /api/stt/draft tells the engine when the browser has gone. Every stop
 *    aborts the preview in flight; the server used to transcribe it anyway, so
 *    the orphans took model turns ahead of the stop's own pass (and, during a
 *    cold start, ahead of the user's Retry).
 *  · POST /api/stt/save stores a recording whose final pass FAILED, with the
 *    failure beside it, so the voice history can offer Redo on a clip that has
 *    no text. Before, a failed tail pass stored nothing and the audio was lost.
 *
 * The engine and the recordings store are mocked; the HTTP edge is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const transcribeAudio = vi.fn();
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
  runShadowTranscription: vi.fn(async () => {}),
  createEngine: vi.fn(() => null),
  getOrCreateEngine: vi.fn(() => ({ name: 'mlx' })),
  ensureSttVocabMigrated: vi.fn(async () => {}),
  prewarmSttEngines: vi.fn(async () => {}),
}));

const writeRecordingResult = vi.fn(async () => '2026-09-29T00:00:00.000Z');
vi.mock('../../../src/core/stt/recordings.js', () => ({
  saveRecordingAudio: vi.fn(async () => ({ id: 'rec-1', audioPath: '/tmp/rec-1.webm' })),
  writeRecordingResult: (...args: unknown[]) => writeRecordingResult(...(args as [])),
  listRecordings: vi.fn(async () => []),
  readRecordingAudio: vi.fn(async () => null),
}));

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ stt: { engine: 'mlx', language: '' } }),
  updateConfig: async () => {},
}));

import express from 'express';
import request from 'supertest';

const { sttRouter } = await import('../../../src/web/routes/stt.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

function makeApp() {
  const app = express();
  app.use(['/api/v1/stt/draft', '/api/stt/draft'], express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/stt', sttRouter);
  app.use(errorHandler);
  return app;
}

let server: Server | null = null;

beforeEach(() => {
  transcribeAudio.mockReset();
  writeRecordingResult.mockClear();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('POST /api/stt/draft — the browser going away', () => {
  it('aborts the engine call when the client drops the request, and reports nothing', async () => {
    let seen: AbortSignal | undefined;
    let settled = false;
    transcribeAudio.mockImplementation((_cfg: unknown, req: { signal?: AbortSignal }) => {
      seen = req.signal;
      return new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => { settled = true; reject(new DOMException('aborted', 'AbortError')); });
      });
    });
    server = makeApp().listen(0);
    const port = (server.address() as { port: number }).port;

    const client = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/stt/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: 'AAAA', format: 'wav' }),
      signal: client.signal,
    }).catch(() => 'client-aborted');
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);

    client.abort();
    expect(await pending).toBe('client-aborted');
    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it('leaves the signal alone on a request that completes', async () => {
    let seen: AbortSignal | undefined;
    transcribeAudio.mockImplementation(async (_cfg: unknown, req: { signal?: AbortSignal }) => {
      seen = req.signal;
      return { text: 'hello', durationMs: 5 };
    });
    const res = await request(makeApp()).post('/api/stt/draft').send({ audio: 'AAAA', format: 'wav' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello');
    expect(seen?.aborted).toBe(false);
  });

  it('still reports a real engine failure', async () => {
    transcribeAudio.mockRejectedValue(new Error('mlx daemon returned 500: boom'));
    const res = await request(makeApp()).post('/api/stt/draft').send({ audio: 'AAAA', format: 'wav' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/stt/save — a clip whose final pass failed', () => {
  it('stores a failure with no text as a failed row: the error, and no result', async () => {
    const res = await request(makeApp()).post('/api/stt/save')
      .send({ audio: 'AAAA', format: 'webm', text: '', error: 'Transcription timed out' });
    expect(res.status).toBe(200);
    expect(res.body.recordingId).toBe('rec-1');
    const meta = (writeRecordingResult.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(meta.error).toBe('Transcription timed out');
    expect(meta).not.toHaveProperty('result');
  });

  it('keeps the words the user already had as the row text, beside the failure', async () => {
    await request(makeApp()).post('/api/stt/save')
      .send({ audio: 'AAAA', format: 'webm', text: 'why does phase', error: 'Transcription timed out' });
    const meta = (writeRecordingResult.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(meta.result).toEqual({ text: 'why does phase', durationMs: 0 });
    expect(meta.error).toBe('Transcription timed out');
  });

  it('is unchanged for an ordinary save, and rejects a non-string error', async () => {
    await request(makeApp()).post('/api/stt/save').send({ audio: 'AAAA', format: 'webm', text: 'hello' });
    const meta = (writeRecordingResult.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(meta.result).toEqual({ text: 'hello', durationMs: 0 });
    expect(meta).not.toHaveProperty('error');

    const bad = await request(makeApp()).post('/api/stt/save').send({ audio: 'AAAA', format: 'webm', text: '', error: 42 });
    expect(bad.status).toBe(400);
  });
});
