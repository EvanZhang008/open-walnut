/**
 * Voice activity from mic loudness, pure: fed one RMS sample at a time (about
 * every 50 ms), it says when speech starts and when a pause ends a take.
 *
 * The level that counts as speech follows the room: it is a multiple of the
 * noise floor (the quiet level, tracked while nobody talks), never below a fixed
 * minimum. While the answer is being read aloud the speaker leaks into the mic
 * (the mic runs with echo cancellation off, see voice-mic.ts), so talking over it
 * (barge-in) is judged against the output too: the first moments of each answer
 * measure how much of the output reaches the mic (nobody talks over the first
 * half second), and after that only a voice clearly louder than that leak counts.
 * When the output cannot be measured (the device's own voice), a fixed, louder
 * level stands in for it.
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
  /** Barge-in with an output nobody can measure (the device's voice): at least this loud. */
  blindMinRms?: number;
}

export const LISTEN_OPTIONS: VoiceActivityOptions = { minSpeechRms: 0.012, floorFactor: 3, startMs: 150, endSilenceMs: 1200 };
/** Talking over the answer: louder than what leaks from the speaker, and held longer. */
export const BARGE_IN_OPTIONS: VoiceActivityOptions = { minSpeechRms: 0.035, floorFactor: 2.5, startMs: 300, endSilenceMs: 1200, blindMinRms: 0.08 };

/** Output this quiet is no sound (a pause between pieces). */
const ECHO_MIN_RMS = 0.003;
/** How long, of output that sounds, the leak is measured before anything counts as barge-in. */
export const ECHO_LEARN_MS = 500;
/** A voice must be this many times louder than the leak it would carry anyway. */
const ECHO_MARGIN = 2;
/** The leak measured is never taken above this: someone talking at once must not lock barge-in out. */
const MAX_LEAK = 3;

export type ActivityEvent = 'speech-start' | 'end-of-speech' | null;

export class VoiceActivity {
  private floor: number | null = null;
  private loudSince: number | null = null;
  private quietSince: number | null = null;
  private speaking = false;
  /** How much of the output reaches the mic (mic RMS / output RMS), measured per answer. */
  private leak = 0;
  private echoSince: number | null = null;
  /** The output's recent peak: the room's echo trails the sound that made it. */
  private echoEnv = 0;

  constructor(private opts: VoiceActivityOptions) {}

  /** The loudness above which a sample counts as voice now. */
  threshold(): number {
    return Math.max(this.opts.minSpeechRms, (this.floor ?? 0) * this.opts.floorFactor);
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /**
   * One sample: its RMS and the time it was taken (ms). `echo` is the output's RMS
   * at the same moment while an answer is read: a number when it can be measured,
   * null when it plays but cannot be (the device's voice), undefined while listening.
   */
  push(rms: number, nowMs: number, echo?: number | null): ActivityEvent {
    let threshold = this.threshold();
    if (echo === null) threshold = Math.max(threshold, this.opts.blindMinRms ?? 0);
    else if (echo !== undefined) {
      this.echoEnv = Math.max(echo, this.echoEnv * 0.85);
      if (this.echoEnv > ECHO_MIN_RMS) {
        this.echoSince ??= nowMs;
        if (nowMs - this.echoSince < ECHO_LEARN_MS) {
          this.leak = Math.min(MAX_LEAK, Math.max(this.leak, rms / this.echoEnv));
          this.loudSince = null;
          return null;
        }
        threshold = Math.max(threshold, this.echoEnv * this.leak * ECHO_MARGIN);
      }
    }
    const loud = rms > threshold;
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

  /** A new take or a new answer: forget the speech state and the leak, keep the room's floor. */
  reset(opts?: VoiceActivityOptions): void {
    if (opts) this.opts = opts;
    this.loudSince = null;
    this.quietSince = null;
    this.speaking = false;
    this.leak = 0;
    this.echoSince = null;
    this.echoEnv = 0;
  }
}

/** RMS of float samples (-1..1). */
export function floatRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
