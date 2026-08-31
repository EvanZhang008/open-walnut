/**
 * The live-draft fast path: audio that is already 16kHz mono 16-bit PCM WAV
 * must skip ffmpeg entirely. Every draft tick used to spawn ffmpeg to "convert"
 * WAV the browser had already encoded correctly, which cost a process launch on
 * a 2s timer (measured at 3.3s on a loaded machine).
 */
import { describe, it, expect } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { isConformingWav, convertToWav } from '../../src/core/stt/audio-convert.js';

/** Minimal WAV header + silence, with the format fields under test. */
function wav({ rate = 16000, channels = 1, bits = 16, format = 1, samples = 160 } = {}): Buffer {
  const blockAlign = channels * (bits / 8);
  const dataBytes = samples * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

describe('isConformingWav', () => {
  it('accepts 16kHz mono 16-bit PCM (what the browser draft encoder emits)', () => {
    expect(isConformingWav(wav())).toBe(true);
  });

  it('rejects the wrong sample rate, channel count, or bit depth', () => {
    expect(isConformingWav(wav({ rate: 48000 }))).toBe(false);
    expect(isConformingWav(wav({ channels: 2 }))).toBe(false);
    expect(isConformingWav(wav({ bits: 8 }))).toBe(false);
  });

  it('rejects non-PCM encodings even at the right rate', () => {
    expect(isConformingWav(wav({ format: 3 }))).toBe(false); // IEEE float
  });

  it('rejects truncated or non-RIFF input', () => {
    expect(isConformingWav(Buffer.alloc(20))).toBe(false);
    expect(isConformingWav(Buffer.from('not audio at all, definitely not a wav file'))).toBe(false);
  });

  it('finds fmt past an extra leading chunk instead of assuming offset 12', () => {
    const base = wav();
    const extra = Buffer.alloc(8 + 4);
    extra.write('LIST', 0, 'ascii');
    extra.writeUInt32LE(4, 4);
    const withChunk = Buffer.concat([base.subarray(0, 12), extra, base.subarray(12)]);
    expect(isConformingWav(withChunk)).toBe(true);
  });
});

describe('convertToWav fast path', () => {
  it('writes conforming wav through byte-for-byte, without ffmpeg', async () => {
    const input = wav({ samples: 1600 });
    // Mark the audio so a re-encode would be detectable.
    input.writeInt16LE(1234, 44);
    const outPath = await convertToWav(input.toString('base64'), 'wav');
    try {
      const out = await readFile(outPath);
      expect(out.equals(input)).toBe(true);
    } finally {
      await unlink(outPath).catch(() => {});
    }
  });
});
