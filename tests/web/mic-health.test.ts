/**
 * The mic warning's rules (web/src/utils/mic-health.ts).
 *
 * Reported 2026-10-31 on the Mac app: "while I talk it suddenly says not
 * available, and two seconds later it is available again". The warning was
 * "No sound from the mic — check your device or restart the browser": WebKit's
 * capture stopped delivering samples for a few seconds (the user's recordings
 * lost 4 to 6 s of audio; the cause, echo cancellation, is pinned by
 * mic-constraints-ratchet.test.ts), the analyser read
 * digital zeros, and the old rule warned after 3 s of zeros whatever came
 * before. A real dead device delivers zeros from the start; a pipeline hiccup
 * comes after sound and recovers.
 */
import { describe, it, expect } from 'vitest';
import {
  initialMicHealth, micHealthTick, micHealthTrackEnded, byteFrameRms, classifyTake, TAKE_ERRORS,
  DEAD_STREAM_RMS, DEAD_FROM_START_TICKS, STALL_WARN_TICKS, STALL_LOG_TICKS,
  DEAD_MIC_WARNING, SILENT_AFTER_SOUND_WARNING, TRACK_ENDED_WARNING,
  type MicHealthState, type MicTick,
} from '../../web/src/utils/mic-health.js';

const SPEECH = 0.1;
/** A live mic's noise floor as the analyser's truncating bytes report it. */
const NOISE = 0.0055;
const ZERO = 0;

/** Feeds `runs` of (ticks, rms) and returns every tick's result. */
function feed(runs: Array<[number, number]>, from: MicHealthState = initialMicHealth()): MicTick[] {
  const out: MicTick[] = [];
  let s = from;
  for (const [n, rms] of runs) {
    for (let i = 0; i < n; i++) {
      const t = micHealthTick(s, rms);
      out.push(t);
      s = t.state;
    }
  }
  return out;
}
const warnings = (ticks: MicTick[]) => ticks.map((t) => t.warning);

describe('mic health: a hiccup after sound never warns', () => {
  it('six seconds of zeros mid-speech (the reported stall) shows nothing and logs the stall when sound returns', () => {
    const ticks = feed([[20, SPEECH], [60, ZERO], [10, SPEECH]]);
    expect(warnings(ticks).every((w) => w === null)).toBe(true);
    const ended = ticks.filter((t) => t.stallEndedTicks !== undefined);
    expect(ended.map((t) => t.stallEndedTicks)).toEqual([60]);
  });

  it('noise floor alone counts as alive, so a later stall does not warn', () => {
    const ticks = feed([[5, NOISE], [100, ZERO]]);
    expect(warnings(ticks).every((w) => w === null)).toBe(true);
  });

  it('zero runs shorter than the log threshold are not reported as stalls', () => {
    const ticks = feed([[5, SPEECH], [STALL_LOG_TICKS - 1, ZERO], [1, SPEECH]]);
    expect(ticks.some((t) => t.stallEndedTicks !== undefined)).toBe(false);
  });

  it('a long silence after sound (device really went quiet) warns, then clears on sound', () => {
    const ticks = feed([[5, SPEECH], [STALL_WARN_TICKS, ZERO], [1, SPEECH]]);
    expect(ticks[5 + STALL_WARN_TICKS - 2].warning).toBeNull();
    expect(ticks[5 + STALL_WARN_TICKS - 1].warning).toBe(SILENT_AFTER_SOUND_WARNING);
    expect(ticks.at(-1)!.warning).toBeNull();
  });

  it('repeated stalls in one recording each stay quiet', () => {
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) runs.push([10, SPEECH], [70, ZERO]);
    expect(warnings(feed(runs)).every((w) => w === null)).toBe(true);
  });
});

describe('mic health: a dead device still warns', () => {
  it('zeros from the start warn after ~3 s, and sound clears it', () => {
    const ticks = feed([[DEAD_FROM_START_TICKS, ZERO], [1, NOISE]]);
    expect(ticks[DEAD_FROM_START_TICKS - 2].warning).toBeNull();
    expect(ticks[DEAD_FROM_START_TICKS - 1].warning).toBe(DEAD_MIC_WARNING);
    expect(ticks.at(-1)!.warning).toBeNull();
    // The dead-from-start run is not a mid-recording stall.
    expect(ticks.some((t) => t.stallEndedTicks !== undefined)).toBe(false);
  });

  it('a track that ended warns at once and stays warned', () => {
    const [first] = feed([[3, SPEECH]]);
    const ended = micHealthTrackEnded(first.state);
    expect(ended.warning).toBe(TRACK_ENDED_WARNING);
    expect(micHealthTick(ended.state, SPEECH).warning).toBe(TRACK_ENDED_WARNING);
  });
});

// 2026-11-15 (voice-compose-everywhere.spec.ts, the retry): Send 87 ms after the
// recording began, before the analyser's first sample, showed "No sound detected ...
// Check your mic device", held the send and never sent the clip to the engine; a take
// with no recorder bytes ended silently, so a waiting Send went on without the words.
// The stop now judges a take by evidence only, and no stop but 'audio' is silent.
describe('classifyTake: what a stopped recording holds', () => {
  const after = (runs: Array<[number, number]>) => feed(runs).at(-1)?.state ?? initialMicHealth();

  it('a take the analyser has not sampled yet goes to the engine when the recorder has bytes', () => {
    expect(classifyTake(900, initialMicHealth())).toBe('audio');
    expect(classifyTake(1, null)).toBe('audio');
  });

  it('a take with nothing captured is an error, never a silent end', () => {
    expect(classifyTake(0, initialMicHealth())).toBe('empty');
    expect(classifyTake(0, null)).toBe('empty');
    // Only digital zeros while the mic was still starting: no words to hear, not a dead device either.
    expect(classifyTake(900, after([[1, ZERO]]))).toBe('empty');
    expect(classifyTake(900, after([[DEAD_FROM_START_TICKS - 1, ZERO]]))).toBe('empty');
    expect(TAKE_ERRORS.empty).toBeTruthy();
    expect(TAKE_ERRORS.empty).not.toMatch(/No sound detected|mic device/);
  });

  it('zeros from the start for as long as the live warning needs is a dead device, and says so', () => {
    expect(classifyTake(4096, after([[DEAD_FROM_START_TICKS, ZERO]]))).toBe('dead');
    expect(TAKE_ERRORS.dead).toMatch(/No sound detected/);
    // A track that ended before any sound is the device too.
    expect(classifyTake(0, micHealthTrackEnded(initialMicHealth()).state)).toBe('dead');
  });

  it('sound heard with recorder bytes is audio, even a short or quiet take, and even if it later went silent', () => {
    expect(classifyTake(512, after([[1, NOISE]]))).toBe('audio');
    expect(classifyTake(512, after([[2, SPEECH], [STALL_WARN_TICKS, ZERO]]))).toBe('audio');
    expect(TAKE_ERRORS.audio).toBeNull();
  });

  it('sound heard but no recorder bytes is lost words, an error', () => {
    expect(classifyTake(0, after([[3, SPEECH]]))).toBe('lost');
    expect(TAKE_ERRORS.lost).toBeTruthy();
  });

  it('every verdict but audio shows an error', () => {
    for (const [verdict, text] of Object.entries(TAKE_ERRORS)) expect(text === null, verdict).toBe(verdict === 'audio');
  });
});

describe('byteFrameRms', () => {
  it('reads a flat 128 frame as zero and a truncated noise floor above the dead floor', () => {
    expect(byteFrameRms(new Uint8Array(512).fill(128))).toBe(0);
    // The analyser truncates 128*(1+x): any small negative sample reads 127.
    const noisy = new Uint8Array(512).map((_, i) => (i % 2 ? 127 : 128));
    expect(byteFrameRms(noisy)).toBeGreaterThan(DEAD_STREAM_RMS);
  });
});
