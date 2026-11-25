/**
 * Long silences in a take, shortened before the engine hears it.
 *
 * 2026-11-20, the user's 152 s dictation held about 110 s of silence (thinking between
 * sentences). Qwen3-ASR filled a long silence with its own context, so the whole
 * take was heard twice (7.4 s of engine time), and the engine spent most of it
 * on nothing. With every silence over 2 s cut to 0.6 s the same take was 43 s of
 * audio, heard in 1.6 s, with no context read back and the same words.
 *
 * Only the sound between words is cut, never a word: a stretch counts as silent
 * only while every 10 ms of it stays near the take's own noise floor (under 2
 * times its quietest tenth, at least 0.0015 and under 0.004 RMS), and the
 * 0.3 s at each edge of it are kept, so a word's onset or tail is never touched.
 *
 * Quiet speech is speech too (2026-11-25, the user's 3 s dictation "现在给我一个
 * update 吧。现在是还有什么没有 merge 啊？" came back as "现在给我一个UP日啊！"):
 * a MacBook's built-in mic in the Mac app records about the first 3 s of a take
 * some 14 dB quieter (304 of his 322 takes over 8 s, from 3.0 s on in every one;
 * 8 of 85 on AirPods), so his words there sat at 0.0005 to 0.0018 RMS, under the
 * 0.0015 floor, and 1.6 s of them were cut as silence. So in a clip's first 6 s
 * a quiet 3 s stretch whose loud tenth is far above its own quiet tenth (his dimmed
 * words do that, a pause between his words does not) is judged against its own
 * floor; the rest of the clip keeps the clip's level, and zeros a capture delivers
 * never set a level.
 */

/** Silences longer than this are shortened. */
const LONG_MS = 2000;
/** Kept at each edge of a shortened silence. */
const EDGE_MS = 300;
/** A 10 ms block above this RMS (on a -1..1 scale) is never silence. */
const SILENCE_CEILING = 0.004;
const SILENCE_FLOOR_MIN = 0.0015;

export interface SilenceCut {
  samples: Int16Array;
  /** Seconds removed. */
  removedSec: number;
}

/** RMS (on a -1..1 scale) of each whole 10 ms block of `pcm`. */
function blockRms(pcm: Int16Array, block: number): Float32Array {
  const blocks = Math.floor(pcm.length / block);
  const rms = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let e = 0;
    for (let i = b * block; i < (b + 1) * block; i++) e += pcm[i] * pcm[i];
    rms[b] = Math.sqrt(e / block) / 32768;
  }
  return rms;
}

/** Blocks judged together for quiet speech: 3 s. */
const STRETCH_BLOCKS = 300;
/** Only a clip's first 6 s can be a dimmed start (his mic's level rises from 3.0 s on, by 6 s in 137 of 139 takes). */
const START_BLOCKS = 600;
/** A stretch is quiet while its loud tenth stays under this many times the clip's silence level. */
const QUIET_STRETCH = 4;
/**
 * A quiet stretch is speech when its loud tenth is this many times its quiet tenth.
 * His takes' dimmed first 3 s: 21 times at the median, 7.3 at the 10th percentile; a
 * pause between his words: 2.3 times, 6.2 at the 90th percentile. SPREAD_DIMMED
 * applies where the stretch's floor is also far under the clip's own (the dimmed start
 * of a longer take), SPREAD_SPEECH to a first stretch with nothing louder to compare.
 */
const SPREAD_SPEECH = 10;
const SPREAD_DIMMED = 7;
/** A stretch needs this many blocks that are not zeros (0.5 s) to be judged on its own. */
const MIN_SOUND_BLOCKS = 50;
/** Under this RMS (under one 16-bit step) a block is silence whatever is around it. */
const SILENCE_ABSOLUTE = 0.00002;

const tenth = (sorted: Float32Array, q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
/** The blocks of `rms` a capture actually filled, sorted: zeros (a capture not yet delivering, a dropout) never set a level. */
const filled = (rms: Float32Array) => rms.filter((r) => r > 0).sort();

/**
 * The level each block must stay under to count as silence: near the clip's own
 * noise floor, and in a dimmed start that holds speech, near that stretch's own floor.
 */
function quietLevels(rms: Float32Array): Float32Array {
  const sorted = Float32Array.from(rms).sort();
  const quiet = Math.min(SILENCE_CEILING, Math.max(SILENCE_FLOOR_MIN, tenth(sorted, 0.1) * 2));
  const levels = new Float32Array(rms.length).fill(quiet);
  const sound = filled(rms);
  if (!sound.length) return levels;
  const clipFloor = tenth(sound, 0.1);
  for (let from = 0; from < Math.min(rms.length, START_BLOCKS); from += STRETCH_BLOCKS) {
    const to = Math.min(rms.length, from + STRETCH_BLOCKS);
    const stretch = filled(rms.subarray(from, to));
    if (stretch.length < MIN_SOUND_BLOCKS) continue;
    const floor = tenth(stretch, 0.1), loud = tenth(stretch, 0.9);
    if (loud >= QUIET_STRETCH * quiet) continue;
    const spread = loud / floor;
    const dimmed = floor * 4 <= clipFloor;
    if (dimmed ? spread >= SPREAD_DIMMED : from === 0 && spread >= SPREAD_SPEECH) {
      levels.fill(Math.min(quiet, Math.max(SILENCE_ABSOLUTE, floor * 2)), from, to);
    }
  }
  return levels;
}

/**
 * Whether `pcm` holds any 10 ms block that is not silence, by the same measure
 * as the shortening below. A clip with none would reach the engine as a moment
 * of silence, which an engine fills with words never said ("Thank you.", its
 * context read back), so a piece like that is not heard at all (take-ahead.ts).
 */
export function hasSound(pcm: Int16Array, sampleRate: number): boolean {
  const rms = blockRms(pcm, Math.round(sampleRate / 100));
  if (!rms.length) return false;
  const quiet = quietLevels(rms);
  return rms.some((r, b) => r >= quiet[b]!);
}

/** `pcm` with every silence over 2 s shortened; null when there is none. */
export function shortenLongSilences(pcm: Int16Array, sampleRate: number): SilenceCut | null {
  const block = Math.round(sampleRate / 100);
  const blocks = Math.floor(pcm.length / block);
  if (blocks < (LONG_MS / 10) + 2) return null;
  const rms = blockRms(pcm, block);
  const quiet = quietLevels(rms);
  const longBlocks = LONG_MS / 10;
  const edge = Math.round((EDGE_MS / 1000) * sampleRate);

  const pieces: Array<[number, number]> = [];
  let kept = 0;
  let cursor = 0;
  for (let b = 0; b < blocks;) {
    if (rms[b]! >= quiet[b]!) { b++; continue; }
    let e = b;
    while (e < blocks && rms[e]! < quiet[e]!) e++;
    if (e - b > longBlocks) {
      const cutFrom = b * block + edge;
      const cutTo = e * block - edge;
      pieces.push([cursor, cutFrom]);
      kept += cutFrom - cursor;
      cursor = cutTo;
    }
    b = e;
  }
  if (!pieces.length) return null;
  pieces.push([cursor, pcm.length]);
  kept += pcm.length - cursor;
  const out = new Int16Array(kept);
  let w = 0;
  for (const [from, to] of pieces) {
    out.set(pcm.subarray(from, to), w);
    w += to - from;
  }
  return { samples: out, removedSec: (pcm.length - kept) / sampleRate };
}
