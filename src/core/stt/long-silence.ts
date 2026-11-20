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
 * times its quietest tenth, and under 0.004 RMS whatever the floor), and the
 * 0.3 s at each edge of it are kept, so a word's onset or tail is never touched.
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

/** `pcm` with every silence over 2 s shortened; null when there is none. */
export function shortenLongSilences(pcm: Int16Array, sampleRate: number): SilenceCut | null {
  const block = Math.round(sampleRate / 100);
  const blocks = Math.floor(pcm.length / block);
  if (blocks < (LONG_MS / 10) + 2) return null;
  const rms = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let e = 0;
    for (let i = b * block; i < (b + 1) * block; i++) e += pcm[i] * pcm[i];
    rms[b] = Math.sqrt(e / block) / 32768;
  }
  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor(sorted.length * 0.1)];
  const quiet = Math.min(SILENCE_CEILING, Math.max(SILENCE_FLOOR_MIN, noise * 2));
  const longBlocks = LONG_MS / 10;
  const edge = Math.round((EDGE_MS / 1000) * sampleRate);

  const pieces: Array<[number, number]> = [];
  let kept = 0;
  let cursor = 0;
  for (let b = 0; b < blocks;) {
    if (rms[b] >= quiet) { b++; continue; }
    let e = b;
    while (e < blocks && rms[e] < quiet) e++;
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
