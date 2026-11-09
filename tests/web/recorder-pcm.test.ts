/**
 * The live draft's audio comes from the recorder's own WebM (recorder-pcm.ts).
 * A fake decoder stands in for the browser's.
 */
import { describe, it, expect } from 'vitest';
import { RecorderPcm, type DecodedAudio } from '../../web/src/utils/recorder-pcm.js';

const RATE = 16000;

function audio(channels: Float32Array[], sampleRate = RATE): DecodedAudio {
  return { length: channels[0].length, numberOfChannels: channels.length, sampleRate, getChannelData: (c) => channels[c] };
}

/** A decoder that answers with whatever the test set last. */
function fakeDecoder() {
  let next: DecodedAudio | Error = audio([new Float32Array(0)]);
  return {
    set: (a: DecodedAudio | Error) => { next = a; },
    decode: async () => { if (next instanceof Error) throw next; return next; },
  };
}

const blob = () => new Blob([new Uint8Array([1, 2, 3])]);
const tone = (n: number, level: number) => Float32Array.from({ length: n }, (_, i) => level * Math.sin(i / 3));

function wavSamples(base64: string): Int16Array {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  return new Int16Array(bytes.buffer.slice(44));
}

describe('RecorderPcm', () => {
  it('mixes the channels to their mean, as the server and the side capture do', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    // The Mac app records two channels with the second one silent.
    d.set(audio([new Float32Array(RATE).fill(0.5), new Float32Array(RATE)]));
    await pcm.refresh(blob());
    expect(pcm.totalSamples).toBe(RATE);
    const s = wavSamples(pcm.sliceWavBase64(0, 10)!.base64);
    expect(s.length).toBe(10);
    expect(s[0]).toBe(Math.round(0.25 * 32767));
  });

  it('measures speech and silence per block, so the commit rules read it', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    // 2 s of speech, 1 s of silence.
    const ch = new Float32Array(3 * RATE);
    ch.set(tone(2 * RATE, 0.3));
    d.set(audio([ch]));
    await pcm.refresh(blob());
    const lastVoice = pcm.lastVoiceSample(0.012);
    expect(lastVoice).toBeGreaterThan(2 * RATE - 1400);
    expect(lastVoice).toBeLessThanOrEqual(2 * RATE + 1365);
    expect(pcm.hasVoiceBetween(0, RATE, 0.012)).toBe(true);
    expect(pcm.hasVoiceBetween(2.2 * RATE, 3 * RATE, 0.012)).toBe(false);
  });

  it('a later refresh takes the longer decode and keeps the earlier audio', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    const full = tone(5 * RATE, 0.2);
    d.set(audio([full.slice(0, 2 * RATE)]));
    await pcm.refresh(blob());
    d.set(audio([full]));
    await pcm.refresh(blob());
    expect(pcm.totalSamples).toBe(5 * RATE);
    const all = wavSamples(pcm.sliceWavBase64(0)!.base64);
    expect(all.length).toBe(5 * RATE);
    for (const i of [0, RATE, 2 * RATE - 1, 2 * RATE, 4 * RATE]) expect(all[i]).toBe(Math.round(full[i] * 32767));
  });

  it('a decode a little shorter than the last keeps only the audio inside it', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    d.set(audio([new Float32Array(3 * RATE).fill(0.4)]));
    await pcm.refresh(blob());
    d.set(audio([new Float32Array(3 * RATE - 100).fill(0.4)]));
    await pcm.refresh(blob());
    expect(pcm.totalSamples).toBe(3 * RATE - 100);
    expect(pcm.sliceWavBase64(3 * RATE - 100)).toBeNull();
    expect(pcm.lastVoiceSample(0.012)).toBe(3 * RATE - 100);
  });

  it('a decode that finishes after a later one started is dropped', async () => {
    let release!: (a: ReturnType<typeof audio>) => void;
    const calls: Array<Promise<ReturnType<typeof audio>>> = [
      new Promise((r) => { release = r; }),
      Promise.resolve(audio([new Float32Array(2 * RATE).fill(0.4)])),
    ];
    let n = 0;
    const pcm = new RecorderPcm(() => calls[n++]);
    const older = pcm.refresh(blob());
    await pcm.refresh(blob());
    release(audio([new Float32Array(RATE).fill(0.4)]));
    await older;
    expect(pcm.totalSamples).toBe(2 * RATE);
  });

  it('a decode that fails keeps the timeline it had', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    d.set(audio([tone(RATE, 0.3)]));
    await pcm.refresh(blob());
    d.set(new Error('EncodingError'));
    await expect(pcm.refresh(blob())).rejects.toThrow('EncodingError');
    expect(pcm.totalSamples).toBe(RATE);
    expect(pcm.sliceWavBase64(0)).not.toBeNull();
  });

  it('refuses audio decoded at another rate', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    d.set(audio([new Float32Array(48000)], 48000));
    await expect(pcm.refresh(blob())).rejects.toThrow(/48000/);
    expect(pcm.totalSamples).toBe(0);
  });

  it('an empty or reversed slice is null', async () => {
    const d = fakeDecoder();
    const pcm = new RecorderPcm(d.decode);
    d.set(audio([tone(RATE, 0.3)]));
    await pcm.refresh(blob());
    expect(pcm.sliceWavBase64(RATE)).toBeNull();
    expect(pcm.sliceWavBase64(500, 100)).toBeNull();
  });
});
