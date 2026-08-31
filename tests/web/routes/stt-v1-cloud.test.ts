/**
 * /api/v1/stt/transcribe on the CLOUD companion — the bridge-relay ladder.
 *
 * A separate file from `stt-v1.test.ts` because `CLOUD_MODE` is a module
 * constant: one `vi.mock` per file, and the primary-box tests need it false.
 * Without this file the whole cloud half of the route was untested, which is how
 * a sentence that claimed "your Mac is offline" after the Mac had answered and
 * declined survived review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () =>
  createMockConstants('walnut-test-stt-cloud', { CLOUD_MODE: true }));

const bridgeRequest = vi.fn();
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: (...args: unknown[]) => bridgeRequest(...args),
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

function post(body: Record<string, unknown>) {
  return request(makeApp()).post('/api/v1/stt/transcribe').send(body);
}

describe('POST /api/v1/stt/transcribe (cloud companion)', () => {
  beforeEach(() => {
    bridgeRequest.mockReset();
    // The fallback leg must be reached deterministically. A real key in the
    // developer's environment would silently turn every no-key assertion below
    // into a live OpenAI call.
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  it('serves a relayed transcription as via=bridge', async () => {
    bridgeRequest.mockResolvedValue({ ok: true, text: 'relayed words', durationMs: 120 });
    const res = await post({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'relayed words', via: 'bridge' });
  });

  // THE LEG THIS FILE EXISTS FOR. The Mac was reached, its engine inspected the
  // file and called it undecodable. That is a verdict about the audio, and it has
  // to reach the phone AS one (4xx) — relaying it as a 503 would tell the phone
  // "transport problem, keep retrying" about a file the Mac has already read.
  it('forwards the Mac verdict on a damaged recording as 422 bad_audio', async () => {
    bridgeRequest.mockResolvedValue({
      ok: false,
      error: '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x9c08] moov atom not found',
    });
    const res = await post({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bad_audio');
    expect(res.body.error.message).toContain('damaged');
    expect(res.body.error.message).not.toContain('moov');
    expect(bridgeRequest).toHaveBeenCalledTimes(1);
  });

  it('does not blame the connection when the Mac answered and declined', async () => {
    bridgeRequest.mockResolvedValue({ ok: false, error: 'No STT engine configured' });
    const res = await post({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('stt_unavailable');
    expect(res.body.error.message).not.toContain('offline');
    expect(res.body.error.message).toContain('try again');
  });

  it('says offline only when the bridge really could not reach the Mac', async () => {
    bridgeRequest.mockRejectedValue(new Error('bridge offline: no live connection for __local__'));
    const res = await post({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('offline');
  });

  // Skipped by SIZE, not by connectivity, so the notice must claim nothing about
  // the Mac at all — and the relay must not even be attempted.
  it('skips the relay for audio too big for one bridge frame', async () => {
    const audio = 'A'.repeat(4 * 1024 * 1024);
    const res = await post({ audio, format: 'm4a' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('too long');
    expect(res.body.error.message).not.toContain('offline');
    expect(bridgeRequest).not.toHaveBeenCalled();
  }, 30_000);
});
