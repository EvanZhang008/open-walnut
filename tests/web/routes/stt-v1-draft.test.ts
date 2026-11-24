/**
 * POST /api/v1/stt/draft: the phone's live words while a voice mode take records.
 * A preview pass on the user's own engine; never the hosted API, never kept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const transcribeAudio = vi.fn();
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
}));

const hostedTranscribe = vi.fn();
vi.mock('../../../src/core/stt/engine-openai.js', () => ({
  createOpenAiEngine: () => ({ name: 'openai', transcribe: (...args: unknown[]) => hostedTranscribe(...args) }),
}));

const ingestAudio = vi.fn();
vi.mock('../../../src/core/stt/voice-archive.js', () => ({
  ingestAudio: (...args: unknown[]) => ingestAudio(...args),
  saveText: vi.fn(),
}));

let follower = false;
vi.mock('../../../src/core/server-role.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFollower: () => follower,
}));

const bridgeRequest = vi.fn();
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: (...args: unknown[]) => bridgeRequest(...args),
}));

import express from 'express';
import request from 'supertest';
import { updateConfig } from '../../../src/core/config-manager.js';
import { sttV1Router } from '../../../src/web/routes/stt-v1.js';

function makeApp() {
  const app = express();
  app.use('/api/v1/stt/draft', express.json({ limit: '6mb' }));
  app.use('/api/v1', sttV1Router);
  return app;
}

describe('POST /api/v1/stt/draft', () => {
  beforeEach(async () => {
    transcribeAudio.mockReset();
    hostedTranscribe.mockReset();
    ingestAudio.mockReset();
    bridgeRequest.mockReset();
    follower = false;
    await updateConfig({ stt: {} });
  });

  it('answers the words heard so far as a preview, and keeps no recording', async () => {
    transcribeAudio.mockResolvedValue({ text: 'turn on the lights', durationMs: 40 });
    const res = await request(makeApp()).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'wav', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'turn on the lights', durationMs: 40 });
    const [, req] = transcribeAudio.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(req).toMatchObject({ audio: 'aGVsbG8=', format: 'wav', language: 'en', preview: true });
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(ingestAudio).not.toHaveBeenCalled();
  });

  it('never bills the hosted API for a draft, even with a key the person gave', async () => {
    await updateConfig({ stt: { engine: 'mlx', openai_api_key: 'test-key' } });
    transcribeAudio.mockRejectedValue(new Error('The speech model is still loading'));
    hostedTranscribe.mockResolvedValue({ text: 'hosted words', durationMs: 7 });
    const res = await request(makeApp()).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'wav' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('stt_unavailable');
    expect(hostedTranscribe).not.toHaveBeenCalled();
  });

  it('rejects a missing take, an unknown format and a draft past its cap before any engine runs', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/v1/stt/draft').send({ format: 'wav' })).status).toBe(400);
    expect((await request(app).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'exe' })).status).toBe(400);
    const big = await request(app).post('/api/v1/stt/draft').send({ audio: 'a'.repeat(3 * 1024 * 1024 + 4), format: 'wav' });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('too_large');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it('a primary whose engine is the hosted API answers no live words instead of billing for them', async () => {
    await updateConfig({ stt: { engine: 'openai', openai_api_key: 'test-key' } });
    const res = await request(makeApp()).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'wav' });
    expect(res.status).toBe(503);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(hostedTranscribe).not.toHaveBeenCalled();
  });

  it('on the companion a draft never rides the relay to the Mac', async () => {
    follower = true;
    await updateConfig({ stt: { engine: 'mlx' } });
    transcribeAudio.mockResolvedValue({ text: 'companion words', durationMs: 5 });
    const res = await request(makeApp()).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'wav' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('companion words');
    expect(bridgeRequest).not.toHaveBeenCalled();

    // Its own engine down: no live words, and still nothing asked of the Mac.
    transcribeAudio.mockRejectedValue(new Error('The speech model is still loading'));
    const none = await request(makeApp()).post('/api/v1/stt/draft').send({ audio: 'aGVsbG8=', format: 'wav' });
    expect(none.status).toBe(503);
    expect(bridgeRequest).not.toHaveBeenCalled();
  });
});
