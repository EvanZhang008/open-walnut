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
import { sttV1Router } from '../../../src/web/routes/stt-v1.js';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
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
});
