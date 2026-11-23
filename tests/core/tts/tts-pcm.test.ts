/**
 * The local voice's raw PCM (src/core/tts/pcm.ts, shared with the browser):
 * the audio/L16 content type, its big-endian samples as floats with a frame cut
 * across two chunks, and a whole piece kept as WAV.
 */
import { describe, expect, it } from 'vitest'
import { l16ToFloat, l16ToWav, parseL16 } from '../../../src/core/tts/pcm.js'

const be = (...samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16BE(s, i * 2))
  return new Uint8Array(b)
}

describe('audio/L16', () => {
  it('reads the rate and channels of an audio/L16 type, and nothing else', () => {
    expect(parseL16('audio/L16; rate=24000; channels=1')).toEqual({ rate: 24000, channels: 1 })
    expect(parseL16('AUDIO/l16;rate=16000;channels=2')).toEqual({ rate: 16000, channels: 2 })
    expect(parseL16('audio/L16')).toEqual({ rate: 24000, channels: 1 })
    expect(parseL16('audio/L16; rate=abc')).toEqual({ rate: 24000, channels: 1 })
    for (const other of ['audio/wav', 'audio/mpeg', 'audio/L24; rate=24000', '', null, undefined]) expect(parseL16(other)).toBeNull()
  })

  it('turns whole frames into floats and leaves a cut frame for the next chunk', () => {
    const bytes = be(16384, -32768, 32767)
    const { samples, used } = l16ToFloat(bytes.slice(0, 5), 1)
    expect(used).toBe(4)
    expect([...samples[0]!]).toEqual([0.5, -1])
    const stereo = l16ToFloat(be(1000, -1000, 2000), 2)
    expect(stereo.used).toBe(4)
    expect(stereo.samples.map((c) => c.length)).toEqual([1, 1])
    expect(stereo.samples[1]![0]).toBeCloseTo(-1000 / 32768)
  })

  it('a whole piece becomes 16-bit WAV with little-endian samples', () => {
    const wav = Buffer.from(l16ToWav(be(1000, -2000, 3), { rate: 24000, channels: 1 }))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 6)
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34)]).toEqual([1, 1, 24000, 48000, 2, 16])
    expect(wav.readUInt32LE(40)).toBe(6)
    expect([0, 1, 2].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([1000, -2000, 3])
    // A trailing half frame is dropped, never read as a sample.
    expect(l16ToWav(new Uint8Array([1, 2, 3]), { rate: 8000, channels: 1 }).byteLength).toBe(46)
  })
})
