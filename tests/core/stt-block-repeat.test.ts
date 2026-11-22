/**
 * The audio an engine reads is heard as it was spoken (2026-11-20): a recording
 * whose recorder wrote each 10 ms block two or three times is heard once
 * (src/lib/audio-block-repeat.ts), and silences over 2 s are shortened
 * (src/core/stt/long-silence.ts), both in the WAV every engine reads
 * (src/core/stt/wav-repair.ts, called from convertToWav).
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBlockRepeat, removeBlockRepeat, blockRepeatLength, type BlockRepeat } from '../../src/lib/audio-block-repeat.js';
import { shortenLongSilences } from '../../src/core/stt/long-silence.js';
import { repairWav, repairWavFile } from '../../src/core/stt/wav-repair.js';
import { speechLike, rng, repeatBlocks as repeated } from '../helpers/speech-pcm.js';

const RATE = 16000;
const BLOCK = 160;

const tone = (hz: number, seconds: number, level = 0.3) =>
  Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / RATE));

function toPcm(f: Float32Array): Int16Array {
  return Int16Array.from(f, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))));
}

function wav(pcm: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

describe('findBlockRepeat', () => {
  for (const factor of [2, 3]) {
    for (const head of [0, 37, 108, 159]) {
      it(`finds each block written ${factor} times (stream starting ${head} samples in) and undoes it exactly`, () => {
        const spoken = speechLike(6, factor * 100 + head);
        const recorded = repeated(spoken, factor, head);
        const r = findBlockRepeat(recorded, RATE);
        expect(r).not.toBeNull();
        expect(r).not.toBe('none');
        const rep = r as BlockRepeat;
        expect(rep.factor).toBe(factor);
        expect(rep.block).toBe(BLOCK);
        expect(rep.within).toBeGreaterThan(0.95);
        const back = removeBlockRepeat(recorded, rep);
        expect(back.length).toBe(blockRepeatLength(recorded.length, rep));
        // Within one sample's step of the true phase the speech comes back whole.
        expect(Math.abs(back.length - spoken.length)).toBeLessThanOrEqual(BLOCK);
        let err = 0;
        const n = Math.min(back.length, spoken.length) - BLOCK;
        for (let i = head + BLOCK; i < n; i++) err += Math.abs(back[i] - spoken[i]);
        expect(err / n).toBeLessThan(0.02);
      });
    }
  }

  it('leaves ordinary speech alone', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(findBlockRepeat(speechLike(8, seed), RATE)).toBe('none');
  });

  it('leaves a held note alone, whose blocks look alike within and across', () => {
    // 100 Hz and 200 Hz repeat exactly every 10 ms block: correlated everywhere,
    // so the gap between within and across is what keeps them.
    for (const hz of [100, 200, 440]) expect(findBlockRepeat(tone(hz, 5), RATE)).toBe('none');
  });

  it('leaves alone a take that repeats only in part, so sound that never repeated is never halved', () => {
    const head = speechLike(1.5, 21), rest = repeated(speechLike(12, 22), 2);
    const mixed = new Float32Array(head.length + rest.length);
    mixed.set(head); mixed.set(rest, head.length);
    expect(findBlockRepeat(mixed, RATE)).toBe('none');
    const tail = speechLike(4, 23);
    const late = new Float32Array(rest.length + tail.length);
    late.set(rest); late.set(tail, rest.length);
    expect(findBlockRepeat(late, RATE)).toBe('none');
  });

  it('leaves alone a take whose repeat slips its alignment partway', () => {
    const a = repeated(speechLike(6, 31), 2), b = repeated(speechLike(6, 32), 2);
    const slipped = new Float32Array(a.length + 80 + b.length);
    slipped.set(a); slipped.set(b, a.length + 80);   // 5 ms inserted
    expect(findBlockRepeat(slipped, RATE)).toBe('none');
  });

  it('leaves voiced, pitched sound alone (vowels with harmonics, a glide, vibrato)', () => {
    const voiced = (f0: (t: number) => number, seconds: number) => {
      let ph = 0;
      return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => {
        ph += (2 * Math.PI * f0(i / RATE)) / RATE;
        let x = 0;
        for (let h = 1; h <= 8; h++) x += Math.sin(h * ph) / h;
        return 0.15 * x * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / RATE));
      });
    };
    for (const f of [66.7, 100, 150, 200]) expect(findBlockRepeat(voiced(() => f, 5), RATE)).toBe('none');
    expect(findBlockRepeat(voiced((t) => 100 + 24 * t, 5), RATE)).toBe('none');
    expect(findBlockRepeat(voiced((t) => 200 + 6 * Math.sin(2 * Math.PI * 5 * t), 5), RATE)).toBe('none');
  });

  it('says it cannot tell from silence or a moment of sound', () => {
    expect(findBlockRepeat(new Float32Array(RATE * 5), RATE)).toBeNull();
    expect(findBlockRepeat(speechLike(0.05), RATE)).toBeNull();
  });

  it('takes a few milliseconds even for a five minute take', () => {
    const long = repeated(speechLike(150, 9), 2);
    const t0 = performance.now();
    const r = findBlockRepeat(long, RATE);
    expect(performance.now() - t0).toBeLessThan(500);
    expect((r as BlockRepeat).factor).toBe(2);
  });

  it('removeBlockRepeat keeps Int16 samples Int16', () => {
    const rec = toPcm(repeated(speechLike(4, 11), 2));
    const r = findBlockRepeat(Float32Array.from(rec, (x) => x / 32768), RATE) as BlockRepeat;
    const out = removeBlockRepeat(rec, r);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(blockRepeatLength(rec.length, r));
  });
});

describe('shortenLongSilences', () => {
  const quiet = (seconds: number) => {
    const r = rng(7);
    return Float32Array.from({ length: Math.round(seconds * RATE) }, () => 0.0005 * r());
  };
  const join2 = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let w = 0;
    for (const p of parts) { out.set(p, w); w += p.length; }
    return out;
  };

  it('cuts a long silence to 0.6 s and keeps every word', () => {
    const a = speechLike(2, 1), b = speechLike(2, 2);
    const pcm = toPcm(join2(a, quiet(10), b));
    const cut = shortenLongSilences(pcm, RATE)!;
    expect(cut).not.toBeNull();
    expect(cut.removedSec).toBeGreaterThan(9.2);
    expect(cut.removedSec).toBeLessThan(9.5);
    // The words on both sides come through sample for sample.
    expect(Array.from(cut.samples.subarray(0, a.length))).toEqual(Array.from(pcm.subarray(0, a.length)));
    expect(Array.from(cut.samples.subarray(cut.samples.length - b.length))).toEqual(Array.from(pcm.subarray(pcm.length - b.length)));
  });

  it('keeps pauses of 2 s or less', () => {
    expect(shortenLongSilences(toPcm(join2(speechLike(2, 1), quiet(1.9), speechLike(2, 2))), RATE)).toBeNull();
  });

  it('never cuts soft speech that stays above the noise floor', () => {
    const soft = Float32Array.from(speechLike(10, 3), (x) => x * 0.05);
    expect(shortenLongSilences(toPcm(join2(quiet(0.5), soft, quiet(0.5))), RATE)).toBeNull();
  });
});

describe('repairWav', () => {
  it('a recording with each block twice and long silences reads as spoken', () => {
    const spoken = (() => {
      const a = speechLike(3, 4), s = new Float32Array(RATE * 8), b = speechLike(3, 5);
      const out = new Float32Array(a.length + s.length + b.length);
      out.set(a); out.set(s, a.length); out.set(b, a.length + s.length);
      return out;
    })();
    const fixed = repairWav(wav(toPcm(repeated(spoken, 2, 50))))!;
    expect(fixed.repeat?.factor).toBe(2);
    expect(fixed.beforeSec).toBeCloseTo(28, 0);
    expect(fixed.afterSec).toBeGreaterThan(6.4);
    expect(fixed.afterSec).toBeLessThan(7);
    expect(fixed.wav.readUInt32LE(40)).toBe(fixed.wav.length - 44);
  });

  it('leaves a recording that needs nothing untouched', () => {
    expect(repairWav(wav(toPcm(speechLike(6, 6))))).toBeNull();
    expect(repairWav(Buffer.from('not a wav'))).toBeNull();
  });

  it('repairWavFile rewrites only the copy it is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walnut-stt-repair-'));
    try {
      const path = join(dir, 'x.wav');
      await writeFile(path, wav(toPcm(repeated(speechLike(5, 8), 2))));
      await repairWavFile(path);
      const after = await readFile(path);
      expect((after.length - 44) / 2 / RATE).toBeCloseTo(5, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
