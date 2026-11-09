/**
 * Stop-time decision for live-drafted dictation: when the draft already heard
 * everything, keep it; when the user stopped mid-sentence, draft first + refine;
 * with no draft or no level data, wait for the server.
 */
import { describe, it, expect } from 'vitest';
import { decideStopAction } from '../../web/src/utils/stt-stop.js';

describe('decideStopAction', () => {
  it('keeps the draft when it covered all the speech (user waited out the tail silence)', () => {
    // Spoke through chunk 6, last draft ran at chunk 8, user stopped at chunk 10.
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: true,
      draftCoveredChunks: 8, lastVoiceChunk: 6, draftIsPreview: false,
    })).toBe('draft-is-final');
  });

  it('draft covering exactly up to the last speech chunk counts as complete', () => {
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: true,
      draftCoveredChunks: 6, lastVoiceChunk: 6, draftIsPreview: false,
    })).toBe('draft-is-final');
  });

  it('refines when speech continued past the newest draft (stopped mid-sentence)', () => {
    // Last draft saw 6 chunks but speech was still happening in chunk 9.
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: true,
      draftCoveredChunks: 6, lastVoiceChunk: 9, draftIsPreview: false,
    })).toBe('draft-then-refine');
  });

  it('waits for the server when no draft was ever delivered', () => {
    expect(decideStopAction({
      hasDraft: false, knowsWhenSpeechEnded: true,
      draftCoveredChunks: 0, lastVoiceChunk: 3, draftIsPreview: false,
    })).toBe('wait-for-server');
  });

  it('waits for the server without level data — a pause is indistinguishable from speech', () => {
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: false,
      draftCoveredChunks: 8, lastVoiceChunk: 0, draftIsPreview: false,
    })).toBe('wait-for-server');
  });

  // 2026-11-08: the side capture's segment drafts dropped words the recorder
  // kept, so a draft that is not the recording itself is never the result.
  it('never keeps a preview draft as the result, even when it covered all the speech', () => {
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: true,
      draftCoveredChunks: 8, lastVoiceChunk: 6, draftIsPreview: true,
    })).toBe('draft-then-refine');
  });

  it('a preview draft with no level data still waits for the server', () => {
    expect(decideStopAction({
      hasDraft: true, knowsWhenSpeechEnded: false,
      draftCoveredChunks: 8, lastVoiceChunk: 0, draftIsPreview: true,
    })).toBe('wait-for-server');
  });
});
