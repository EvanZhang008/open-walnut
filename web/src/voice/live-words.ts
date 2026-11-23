/**
 * Voice mode's live words: what the person is saying, shown in the composer while they talk.
 *
 * While a take hears speech, the audio so far (VoiceMic.peekTake) is drafted through the same
 * route dictation's live draft uses (/api/stt/draft), one request at a time, every
 * DRAFT_INTERVAL_MS. A draft only shows the words; the take's whole-clip transcription is still
 * what is sent. A draft that comes back after its take ended is dropped.
 */

import { draftTranscribe } from '../api/stt';
import { blobToBase64 } from '../utils/blob-base64';
import type { VoiceState } from './conversation-machine';
import type { VoiceMic } from './voice-mic';

/** How often the take so far is drafted. The first draft waits this long after speech starts. */
export const DRAFT_INTERVAL_MS = 1200;

export class LiveWords {
  private take = -1;
  private since = 0;
  private inFlight = false;
  private abort: AbortController | null = null;

  constructor(private readonly onText: (text: string | null) => void) {}

  /** Called on every mic sample: drafts the take so far while it hears speech. */
  tick(mic: VoiceMic | null, state: VoiceState, now: number): void {
    if (!mic || state.phase !== 'listening' || !state.heard) return;
    if (state.take !== this.take) {
      this.clear();
      this.take = state.take;
      this.since = now;
      return;
    }
    if (this.inFlight || now - this.since < DRAFT_INTERVAL_MS) return;
    const clip = mic.peekTake();
    if (!clip) return;
    this.since = now;
    this.inFlight = true;
    const take = this.take;
    const abort = new AbortController();
    this.abort = abort;
    void blobToBase64(clip.blob, 'draft audio')
      .then((audio) => draftTranscribe(audio, clip.format, undefined, abort.signal))
      .then((draft) => {
        if (this.take === take && !abort.signal.aborted) this.onText(draft.text.trim() || null);
      }, () => { /* a draft is a preview: the take's own transcription still goes out */ })
      .finally(() => { if (this.abort === abort) { this.inFlight = false; this.abort = null; } });
  }

  /** The take's words leave the composer: it was sent, dropped, or a new one began. */
  clear(): void {
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
    this.take = -1;
    this.onText(null);
  }
}
