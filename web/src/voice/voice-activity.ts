/**
 * Voice activity from mic loudness, pure: fed one RMS sample at a time (about
 * every 50 ms), it says when speech starts and when a pause ends a take.
 *
 * The level that counts as speech follows the room: it is a multiple of the
 * noise floor (the quiet level, tracked while nobody talks), never below a fixed
 * minimum. While the answer is being read aloud, the speaker leaks into the mic
 * even with echo cancellation, so talking over it (barge-in) needs a louder and
 * longer voice than the floor measured during the playback.
 */

export interface VoiceActivityOptions {
  /** Loudness that always counts as speech, whatever the floor (RMS of samples in -1..1). */
  minSpeechRms: number;
  /** Speech = this many times the noise floor. */
  floorFactor: number;
  /** Speech must last this long to start a take (a click or a cough does not). */
  startMs: number;
  /** Quiet this long after speech ends the take. */
  endSilenceMs: number;
}

export const LISTEN_OPTIONS: VoiceActivityOptions = { minSpeechRms: 0.012, floorFactor: 3, startMs: 150, endSilenceMs: 1200 };
/** Talking over the answer: louder than what leaks from the speaker, and held longer. */
export const BARGE_IN_OPTIONS: VoiceActivityOptions = { minSpeechRms: 0.035, floorFactor: 2.5, startMs: 300, endSilenceMs: 1200 };

export type ActivityEvent = 'speech-start' | 'end-of-speech' | null;

export class VoiceActivity {
  private floor: number | null = null;
  private loudSince: number | null = null;
  private quietSince: number | null = null;
  private speaking = false;

  constructor(private opts: VoiceActivityOptions) {}

  /** The loudness above which a sample counts as voice now. */
  threshold(): number {
    return Math.max(this.opts.minSpeechRms, (this.floor ?? 0) * this.opts.floorFactor);
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** One sample: its RMS and the time it was taken (ms). */
  push(rms: number, nowMs: number): ActivityEvent {
    const loud = rms > this.threshold();
    // The floor drops fast to the quiet between words and climbs slowly under a steady
    // sound, so a fan or a hum stops counting as speech after a few seconds while real
    // speech, with its gaps, keeps the floor down. It starts low, so speech already
    // going when the mic opens still counts.
    const start = this.opts.minSpeechRms / this.opts.floorFactor;
    const floor = this.floor ?? Math.min(rms, start);
    this.floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.997 + rms * 0.003;
    if (!this.speaking) {
      if (loud) {
        this.loudSince ??= nowMs;
        if (nowMs - this.loudSince >= this.opts.startMs) {
          this.speaking = true;
          this.quietSince = null;
          return 'speech-start';
        }
      } else {
        this.loudSince = null;
      }
      return null;
    }
    if (loud) {
      this.quietSince = null;
      return null;
    }
    this.quietSince ??= nowMs;
    if (nowMs - this.quietSince >= this.opts.endSilenceMs) {
      this.speaking = false;
      this.loudSince = null;
      this.quietSince = null;
      return 'end-of-speech';
    }
    return null;
  }

  /** A new take: forget the speech state, keep the room's floor. */
  reset(opts?: VoiceActivityOptions): void {
    if (opts) this.opts = opts;
    this.loudSince = null;
    this.quietSince = null;
    this.speaking = false;
  }
}

/** RMS of float samples (-1..1). */
export function floatRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
