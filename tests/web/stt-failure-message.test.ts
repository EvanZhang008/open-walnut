/**
 * The words a failed dictation shows the user.
 *
 * The 2026-09-28 bubble read `signal timed out`: an AbortSignal's message,
 * which says how the request ended and nothing about what went wrong. The one
 * before it read `draft transcription failed: 500: fetch failed`, two layers of
 * plumbing around "the engine went away".
 */
import { describe, it, expect } from 'vitest';
import { SttDraftError, sttFailureMessage } from '../../web/src/api/stt.js';

describe('sttFailureMessage', () => {
  it('says a timeout is a timeout, whichever layer raised it', () => {
    expect(sttFailureMessage(new DOMException('signal timed out', 'TimeoutError'))).toBe('Transcription timed out');
    expect(sttFailureMessage(new Error('POST /api/stt/recordings/x/transcribe timed out after 120000ms')))
      .toBe('Transcription timed out');
    // The server's own fetch to the engine timing out, relayed as a 500's text.
    expect(sttFailureMessage(new SttDraftError(500, 'draft transcription failed: 500: The operation was aborted due to timeout')))
      .toBe('Transcription timed out');
  });

  it('names the engine, not the plumbing, when the server lost its connection to it', () => {
    expect(sttFailureMessage(new SttDraftError(500, 'draft transcription failed: 500: fetch failed')))
      .toBe('The transcription engine stopped responding');
    expect(sttFailureMessage(new SttDraftError(500, 'draft transcription failed: 500: mlx daemon connection lost twice in a row')))
      .toBe('The transcription engine stopped responding');
    // /transcribe relays the server's message as a plain Error.
    expect(sttFailureMessage(new Error('fetch failed'))).toBe('The transcription engine stopped responding');
    // No detail at all: still the engine.
    expect(sttFailureMessage(new SttDraftError(502, 'draft transcription failed: 502'))).toBe('The transcription engine stopped responding');
  });

  it('says the browser could not reach Walnut, in both engines\' words', () => {
    expect(sttFailureMessage(new TypeError('Failed to fetch'))).toBe("Couldn't reach Walnut to transcribe");
    expect(sttFailureMessage(new TypeError('Load failed'))).toBe("Couldn't reach Walnut to transcribe");
  });

  it('passes a real engine explanation through, without the draft-lane prefix', () => {
    expect(sttFailureMessage(new SttDraftError(500, 'draft transcription failed: 500: mlx daemon failed to start within 120s')))
      .toBe('mlx daemon failed to start within 120s');
    expect(sttFailureMessage(new Error('No STT engine configured. Go to Settings → Voice to set one up.')))
      .toBe('No STT engine configured. Go to Settings → Voice to set one up.');
  });
});
