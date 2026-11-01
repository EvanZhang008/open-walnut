/**
 * Decides, from the live level samples, whether the mic warning should show.
 *
 * The warning exists for a capture that delivers nothing but digital zeros: a
 * wedged browser capture, a muted or wrong input device. A real mic always
 * carries a noise floor, so a zero run after the stream has carried any signal
 * is something else. In the Mac app (WebKit) the capture stopped delivering
 * samples for a few seconds and then recovered (2026-10-31: recordings lost 4
 * to 6 s of audio, and the old "3 s of zeros" rule told the user to check the
 * device while they were talking). The cause was WebKit's echo cancellation
 * rebuilding its audio device (see mic-constraints.ts), now off; a gap after
 * sound is still no proof of a dead device. So:
 *
 *  - never alive since the start, zeros for DEAD_FROM_START_TICKS: warn;
 *  - alive before, zeros for STALL_WARN_TICKS (far past any hiccup seen): warn;
 *  - the track ended (device unplugged, permission revoked): warn at once;
 *  - any sound clears the warning.
 *
 * Counted in sampled ticks, not wall-clock, so a throttled sampler never makes
 * a run look longer than the audio it saw. Pure: no timers, no DOM, so every
 * transition is unit-testable (tests/web/mic-health.test.ts).
 */

/** RMS at or below this = digital zero (a live mic's noise floor is far above it). */
export const DEAD_STREAM_RMS = 0.0008;
/** How often the hook samples the level. */
export const SAMPLE_INTERVAL_MS = 100;
/** ~3 s of zeros with no signal ever: the device is not delivering sound. */
export const DEAD_FROM_START_TICKS = 30;
/** ~15 s of zeros after the stream was alive: no longer a pipeline hiccup. */
export const STALL_WARN_TICKS = 150;
/** A zero run after the stream was alive this long is logged as a stall. */
export const STALL_LOG_TICKS = 10;

export const DEAD_MIC_WARNING = 'No sound from the mic — check your device or restart the browser. Still recording.';
export const SILENT_AFTER_SOUND_WARNING = 'No sound from the mic for a while — check your device. Still recording.';
export const TRACK_ENDED_WARNING = 'The microphone was disconnected. Stop and record again.';

export interface MicHealthState {
  /** The stream carried any signal above the dead floor this recording. */
  alive: boolean;
  /** Consecutive dead ticks right now. */
  deadTicks: number;
  trackEnded: boolean;
}

export interface MicTick {
  state: MicHealthState;
  /** What the warning should be after this tick. */
  warning: string | null;
  /** Set on the tick a zero run after the stream was alive ends: its length in ticks. */
  stallEndedTicks?: number;
}

export function initialMicHealth(): MicHealthState {
  return { alive: false, deadTicks: 0, trackEnded: false };
}

function warningFor(s: MicHealthState): string | null {
  if (s.trackEnded) return TRACK_ENDED_WARNING;
  if (!s.alive) return s.deadTicks >= DEAD_FROM_START_TICKS ? DEAD_MIC_WARNING : null;
  return s.deadTicks >= STALL_WARN_TICKS ? SILENT_AFTER_SOUND_WARNING : null;
}

/** Feed one level sample. */
export function micHealthTick(prev: MicHealthState, rms: number): MicTick {
  if (rms > DEAD_STREAM_RMS) {
    const ended = prev.alive && prev.deadTicks >= STALL_LOG_TICKS ? prev.deadTicks : undefined;
    const state = { ...prev, alive: true, deadTicks: 0 };
    return { state, warning: warningFor(state), ...(ended !== undefined ? { stallEndedTicks: ended } : {}) };
  }
  const state = { ...prev, deadTicks: prev.deadTicks + 1 };
  return { state, warning: warningFor(state) };
}

/** The capture track ended: final, never a hiccup. */
export function micHealthTrackEnded(prev: MicHealthState): MicTick {
  const state = { ...prev, trackEnded: true };
  return { state, warning: warningFor(state) };
}

/**
 * RMS of an analyser's BYTE time-domain frame (128 = zero). Bytes on purpose:
 * the analyser truncates, so any negative sample reads 127 and a live mic's
 * noise floor (about 0.0003 in the user's recordings) lands near 0.0055, well
 * above DEAD_STREAM_RMS. A float frame would put that floor under it.
 */
export function byteFrameRms(frame: ArrayLike<number>): number {
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = (frame[i] - 128) / 128;
    sumSq += v * v;
  }
  return frame.length ? Math.sqrt(sumSq / frame.length) : 0;
}
