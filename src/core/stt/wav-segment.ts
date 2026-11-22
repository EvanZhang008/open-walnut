/**
 * Split 16 kHz mono s16le PCM into segments a speech model can take in one pass,
 * cutting in the quietest stretch near each limit so a word is never split.
 *
 * Qwen3-ASR under llama-server reads one request into a fixed context (8192
 * tokens, about 12.5 audio tokens a second plus the text it writes), so a long
 * recording goes through in pieces and the texts are joined.
 */

export const SAMPLE_RATE = 16_000;

export interface SegmentOptions {
  /** Longest segment, in seconds. */
  maxSec: number;
  /** A cut is looked for in the last `searchSec` before the limit. */
  searchSec: number;
}

export const DEFAULT_SEGMENT: SegmentOptions = { maxSec: 90, searchSec: 40 };

const WINDOW = SAMPLE_RATE / 10; // 100 ms energy windows

/** Sum of squares of one window, as a loudness score. */
function energy(pcm: Int16Array, start: number, end: number): number {
  let e = 0;
  for (let i = start; i < end; i++) e += pcm[i] * pcm[i];
  return e;
}

/**
 * Sample offsets where the audio is cut, ending with `pcm.length`. A recording
 * within the limit is one segment.
 */
export function segmentBoundaries(pcm: Int16Array, opts: SegmentOptions = DEFAULT_SEGMENT): number[] {
  const max = Math.round(opts.maxSec * SAMPLE_RATE);
  const search = Math.min(max - WINDOW, Math.round(opts.searchSec * SAMPLE_RATE));
  const cuts: number[] = [];
  let start = 0;
  while (pcm.length - start > max) {
    // Quietest 100 ms window in [start + max - search, start + max).
    let best = start + max;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let w = start + max - search; w + WINDOW <= start + max; w += WINDOW) {
      const e = energy(pcm, w, w + WINDOW);
      if (e < bestEnergy) { bestEnergy = e; best = w + WINDOW / 2; }
    }
    cuts.push(best);
    start = best;
  }
  cuts.push(pcm.length);
  return cuts;
}

/**
 * Where the PCM payload of a 16 kHz mono s16le WAV lies, as byte offsets
 * [start, end) (walks the chunk list in `head`, the file's first bytes; `end`
 * is cut to `fileLength` and to whole samples).
 */
export function wavDataRange(head: Buffer, fileLength = head.length): { start: number; end: number } {
  let offset = 12;
  while (offset + 8 <= head.length) {
    const id = head.toString('ascii', offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === 'data') {
      const start = offset + 8;
      const end = Math.min(fileLength, start + size);
      return { start, end: end - ((end - start) % 2) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Locate the PCM payload of a 16 kHz mono s16le WAV (walks the chunk list). */
export function wavPcm(buf: Buffer): Int16Array {
  const { start, end } = wavDataRange(buf);
  // Copy so the view is 2-byte aligned whatever the buffer's offset.
  const aligned = Buffer.from(buf.subarray(start, end));
  return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
}

/** A 16 kHz mono s16le WAV holding `pcm`. */
export function pcmToWav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Kana, CJK ideographs, compatibility ideographs, full-width forms, CJK punctuation.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** Join segment texts: no space between two CJK sides, one space otherwise. */
export function joinSegmentTexts(parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    out += CJK.test(out[out.length - 1]) && CJK.test(t[0]) ? t : ` ${t}`;
  }
  return out;
}
