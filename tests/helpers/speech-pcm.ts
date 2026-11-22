/**
 * Synthetic 16 kHz sound for STT tests, deterministic per seed. Never played.
 *
 *  - speechPcm: words of smoothed noise with near-silent pauses between them;
 *  - speechLike: smoothed noise under a syllable-rate envelope, on a -1..1 scale;
 *  - toneSpeech: a steady tone with silent seconds where asked;
 *  - repeatBlocks: the recorder fault audio-block-repeat.ts undoes.
 */

export const RATE = 16_000;

/** Deterministic noise in -1..1. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** `seconds` of words (0.6 s) and pauses (0.3 s, near silence). */
export function speechPcm(seconds: number, seed = 1): Int16Array {
  const r = rng(seed);
  const out = new Int16Array(Math.round(seconds * RATE));
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = 0.7 * y + 0.3 * r();
    const inWord = (i % Math.round(0.9 * RATE)) < 0.6 * RATE;
    out[i] = Math.round(y * (inWord ? 9000 : 20));
  }
  return out;
}

/** Speech-like sound on a -1..1 scale: smoothed noise under a 4 Hz syllable envelope. */
export function speechLike(seconds: number, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = 0.7 * y + 0.3 * r();
    const env = 0.25 * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / RATE));
    out[i] = y * env;
  }
  return out;
}

/** A tone of `hz` at `level`, silent (zero) for the second starting at each of `silentAt` (seconds). */
export function toneSpeech(seconds: number, silentAt: number[] = [], { level = 6000, hz = 201 } = {}): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    pcm[i] = silentAt.some((s) => t >= s && t < s + 1) ? 0 : Math.round(level * Math.sin(2 * Math.PI * hz * t));
  }
  return pcm;
}

/** `s` as a faulty recorder writes it: `head` samples as they are, then every 10 ms block `factor` times. */
export function repeatBlocks<T extends Float32Array | Int16Array>(s: T, factor: number, head = 0, block = RATE / 100): T {
  const out = new (s.constructor as new (n: number) => T)(head + (s.length - head) * factor);
  out.set(s.subarray(0, head) as never, 0);
  let w = head;
  for (let at = head; at < s.length; at += block) {
    const b = s.subarray(at, Math.min(s.length, at + block));
    for (let k = 0; k < factor; k++) { out.set(b as never, w); w += b.length; }
  }
  return out;
}
