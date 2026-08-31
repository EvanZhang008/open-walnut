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
import {
  sttV1Router, sttPayloadTooLargeHandler, sttEngineNotice, sttEngineFailure, noKeyNotice,
} from '../../../src/web/routes/stt-v1.js';

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

  // The phone renders `error.message` verbatim in a two-line caption. A real
  // simulator screenshot (2026-08-31) caught it showing forty lines of ffmpeg
  // build configuration, cut off mid-path, as the whole explanation for a
  // recording the app was holding. The raw text still goes to the server log.
  //
  // The STATUS matters as much as the sentence: iOS classifies any 4xx as a
  // verdict about the audio and any 5xx as transport, so answering 503 here made
  // the phone re-upload a file this route had just called damaged until its
  // 6-attempt ceiling gave up. `bad_audio` retires it in two.
  it('answers an undecodable recording with 422 bad_audio and a sentence, not an ffmpeg dump', async () => {
    transcribeAudio.mockRejectedValue(new Error(
      'Command failed: ffmpeg -y -i /tmp/a.m4a -ar 16000 -ac 1 /tmp/a.wav\n'
      + 'ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers\n'
      + '  configuration: --prefix=/opt/homebrew/Cellar/ffmpeg --enable-shared\n'
      + '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x9c0810000] moov atom not found\n'
      + 'Error opening input files: Invalid data found when processing input\n',
    ));
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bad_audio');
    expect(res.body.error.message).toBe(
      "That recording is damaged and can't be transcribed — it was cut off before it finished saving",
    );
    expect(res.body.error.message).not.toContain('ffmpeg');
  });

  // The other half of the split, and the reason it is safe: an engine that is
  // merely unwell must STAY a 503, or the phone would retire good audio after two
  // attempts because a whisper server was restarting.
  it('keeps a non-decode engine failure on 503, and never shows the command line', async () => {
    transcribeAudio.mockRejectedValue(new Error(
      'Command failed: ffmpeg -y -i /var/folders/ph/qftcnrr0000gn/T/voice-9f2.m4a -f wav -\n'
      + 'ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers\n'
      + 'Segmentation fault: 11\n',
    ));
    const res = await request(makeApp())
      .post('/api/v1/stt/transcribe')
      .send({ audio: 'aGVsbG8=', format: 'm4a' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('stt_unavailable');
    // The first cut shipped the exact string the sentence exists to kill: the
    // first LINE of this dump is still a command invocation with a temp path.
    expect(res.body.error.message).toBe('Transcription failed');
    expect(res.body.error.message).not.toContain('ffmpeg');
    expect(res.body.error.message).not.toContain('/var/folders');
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

// The string the phone shows. Rules, not prettiness: a damaged file must not be
// reported as a service outage (the app would keep retrying it forever), and no
// notice may be a wall of stderr or empty.
describe('sttEngineNotice', () => {
  it('keeps a short engine message as-is', () => {
    expect(sttEngineNotice('No STT engine configured')).toBe('No STT engine configured');
  });

  it('names a damaged recording instead of blaming the service', () => {
    expect(sttEngineNotice('[mov,mp4] moov atom not found')).toContain('damaged');
  });

  it('reduces a multi-line dump to one bounded line', () => {
    const notice = sttEngineNotice(`whisper-server refused: ${'x'.repeat(400)}\nstack frame\n`);
    expect(notice.length).toBeLessThanOrEqual(160);
    expect(notice).not.toContain('stack frame');
  });

  it('never returns an empty explanation', () => {
    expect(sttEngineNotice('')).toBe('Transcription failed');
    expect(sttEngineNotice('\n  \n')).toBe('Transcription failed');
  });

  // "One line" is not the same as "readable". The first version of this function
  // shipped the exact string it exists to remove, one line of it, to the phone.
  it('refuses a first line that is a command invocation or a path', () => {
    expect(sttEngineNotice(
      'Command failed: ffmpeg -y -i /var/folders/ph/qftcnrr0000gn/T/voice-9f2.m4a -f wav -\nmore\n',
    )).toBe('Transcription failed');
    expect(sttEngineNotice('ffprobe exited with code 1')).toBe('Transcription failed');
    expect(sttEngineNotice('spawn /opt/homebrew/bin/whisper ENOENT')).toBe('Transcription failed');
    expect(sttEngineNotice('fetch failed: https://api.openai.com/v1/audio')).toBe('Transcription failed');
    expect(sttEngineNotice('Traceback (most recent call last)')).toBe('Transcription failed');
    // …while a real sentence about the service still reaches the user, because
    // "that recording is fine, the engine isn't" is worth knowing.
    expect(sttEngineNotice('No STT engine configured')).toBe('No STT engine configured');
    expect(sttEngineNotice('Whisper model is still downloading')).toBe('Whisper model is still downloading');
    expect(sttEngineNotice('The transcription engine is not installed on this Mac'))
      .toBe('The transcription engine is not installed on this Mac');
  });

  // THE REASON THIS IS AN ALLOWLIST. Every string below is a realistic failure
  // from the engines in src/core/stt, and every one walked through the denylist
  // this function shipped with: it had to enumerate machine shapes, and the set of
  // machine shapes is unbounded. The set worth SHOWING is small, so that is the
  // set that gets enumerated. Anything not provably prose becomes the generic
  // sentence, which costs the user nothing they could have acted on.
  it('blocks realistic engine diagnostics that no denylist would have named', () => {
    for (const raw of [
      // Would leak a redacted API key fragment straight onto a lock screen.
      '{"error":{"message":"Incorrect API key provided: sk-abc…","type":"invalid_request_error"}}',
      'Error: connect ECONNREFUSED 127.0.0.1:8080',
      'whisper-server returned 500: model load failed',
      'mlx daemon returned 500: detail',
      'spawn /Volumes/tools/whisper-cli ENOENT',
      'C:\\whisper\\models\\ggml-base.bin not found',
      'sherpa: /data/models/encoder.onnx missing',
      'exit status 1: signal killed, core dumped (pid 48213)',
      'whisper-server: model load failed after 3 retries at 0x9c0810000',
      'ffprobe: could not find codec parameters',
    ]) {
      expect(sttEngineNotice(raw), `leaked: ${raw}`).toBe('Transcription failed');
    }
  });

  it('never shows a lone machine token as if it were a sentence', () => {
    expect(sttEngineNotice('ECONNREFUSED')).toBe('Transcription failed');
    expect(sttEngineNotice('EPIPE')).toBe('Transcription failed');
    expect(sttEngineNotice('killed')).toBe('Transcription failed');
  });
});

// Status AND code, not just copy: the phone's retry policy is driven entirely by
// the status class, so this is the function that decides how many times a broken
// file gets re-uploaded over cellular data.
describe('sttEngineFailure', () => {
  it('calls undecodable audio a 422 verdict', () => {
    for (const raw of [
      '[mov,mp4,m4a] moov atom not found',
      'Error opening input files: Invalid data found when processing input',
      'Invalid data found when processing input',
    ]) {
      const failure = sttEngineFailure(raw);
      expect(failure.status).toBe(422);
      expect(failure.code).toBe('bad_audio');
      expect(failure.message).toContain('damaged');
    }
  });

  it('leaves every other failure on 503 stt_unavailable', () => {
    for (const raw of ['No STT engine configured', 'ECONNREFUSED 127.0.0.1:8080', '']) {
      const failure = sttEngineFailure(raw);
      expect(failure.status).toBe(503);
      expect(failure.code).toBe('stt_unavailable');
    }
  });
});

// Three different truths, and one of them is a claim about REACHABILITY. Saying
// "your Mac is offline" after the bridge reached the Mac and the Mac's engine
// refused the audio is a fact this box does not have, and the phone user cannot
// act on it.
describe('noKeyNotice', () => {
  it('only blames the connection when the bridge really could not reach the Mac', () => {
    expect(noKeyNotice('unreachable')).toContain('offline');
  });

  it('says the Mac answered and declined, without mentioning connectivity', () => {
    const notice = noKeyNotice('declined');
    expect(notice).not.toContain('offline');
    expect(notice).toContain('try again');
  });

  it('explains a recording too long to relay, and does not claim anything about the Mac', () => {
    const notice = noKeyNotice('not-attempted');
    expect(notice).not.toContain('offline');
    expect(notice).toContain('too long');
  });

  it('never returns the same sentence for two different outcomes', () => {
    const all = [noKeyNotice('unreachable'), noKeyNotice('declined'), noKeyNotice('not-attempted')];
    expect(new Set(all).size).toBe(3);
  });
});
