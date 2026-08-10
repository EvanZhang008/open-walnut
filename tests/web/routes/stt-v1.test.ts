/**
 * /api/v1/stt/transcribe — primary-box path (validation + engine dispatch).
 * The engine itself is mocked; the cloud bridge/OpenAI fallback ladder is
 * covered by the route's error contract (503 with stt_unavailable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const transcribeAudio = vi.fn();
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
}));

import express from 'express';
import request from 'supertest';
import { sttV1Router, sttPayloadTooLargeHandler } from '../../../src/web/routes/stt-v1.js';

// Mirrors the production mount order (server.ts): route-scoped 35mb parser +
// the contract-shaped 413 handler BEFORE the global 15mb parser.
function makeApp() {
  const app = express();
  app.use('/api/v1/stt/transcribe', express.json({ limit: '35mb' }));
  app.use('/api/v1/stt/transcribe', sttPayloadTooLargeHandler);
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/v1', sttV1Router);
  return app;
}

describe('POST /api/v1/stt/transcribe', () => {
  beforeEach(() => {
    transcribeAudio.mockReset();
  });

  it('rejects missing audio', async () => {
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ format: 'm4a' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects unsupported format', async () => {
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio: 'aGVsbG8=', format: 'exe' });
    expect(res.status).toBe(400);
  });

  it('transcribes via the local engine on the primary box', async () => {
    transcribeAudio.mockResolvedValue({ text: '你好 world', durationMs: 42 });
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio: 'aGVsbG8=', format: 'm4a', language: 'zh' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('你好 world');
    expect(res.body.via).toBe('primary');
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ audio: 'aGVsbG8=', format: 'm4a', language: 'zh' }),
    );
  });

  it('maps engine failure to 503 stt_unavailable', async () => {
    transcribeAudio.mockRejectedValue(new Error('No STT engine configured'));
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio: 'aGVsbG8=', format: 'wav' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('stt_unavailable');
    expect(res.body.error.message).toContain('No STT engine');
  });

  // Long recordings (voice input has NO duration cap — iOS field data-loss
  // incident 2026-08-09). The global 15mb parser used to 413 at ~62min of
  // 16kHz AAC in a non-contract shape; the route now gets its own 35mb
  // parser, and both overflow layers must answer in the frozen error shape
  // so the phone preserves the audio and offers retry.

  it('accepts a >15MB audio body (long recording rides the 35mb STT parser)', async () => {
    transcribeAudio.mockResolvedValue({ text: 'a very long dictation', durationMs: 9000 });
    // ~21MB of base64 — over the global 15mb cap, under the 35mb STT cap.
    const audio = 'A'.repeat(21 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio, format: 'm4a' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('a very long dictation');
  }, 30_000);

  it('returns contract-shaped 413 when audio exceeds the route cap (25MB base64)', async () => {
    // Past the route's own audio-string cap but inside the 35mb body parser.
    const audio = 'A'.repeat(26 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio, format: 'm4a' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too_large');
    expect(transcribeAudio).not.toHaveBeenCalled();
  }, 30_000);

  it('returns contract-shaped 413 when the body itself blows the 35mb parser', async () => {
    const audio = 'A'.repeat(36 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio, format: 'm4a' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too_large');
    expect(transcribeAudio).not.toHaveBeenCalled();
  }, 30_000);
});
