import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const execFile = vi.hoisted(() => vi.fn((..._args: unknown[]) => { throw new Error('ffmpeg must not run for PCM CAF') }))
vi.mock('node:child_process', () => ({ execFile }))

import { cafToWav } from '../../src/core/stt/caf-to-wav.js'
import { convertToWav, cleanupTempFile, isConformingWav } from '../../src/core/stt/audio-convert.js'

interface CafOpts { rate: number; channels: number; bits: number; float?: boolean; little?: boolean; format?: string; dataSize?: bigint }

/** A CAF the way Core Audio writes one: header, desc, an unrelated chunk, then data. */
function caf(samples: number[][], o: CafOpts): Buffer {
  const desc = Buffer.alloc(32)
  desc.writeDoubleBE(o.rate, 0)
  desc.write(o.format ?? 'lpcm', 8, 'ascii')
  desc.writeUInt32BE((o.float ? 1 : 0) | (o.little ? 2 : 0), 12)
  desc.writeUInt32BE(o.channels * (o.bits / 8), 16)
  desc.writeUInt32BE(1, 20)
  desc.writeUInt32BE(o.channels, 24)
  desc.writeUInt32BE(o.bits, 28)
  const step = o.bits / 8
  const pcm = Buffer.alloc(samples.length * o.channels * step)
  samples.forEach((frame, f) => frame.forEach((v, c) => {
    const at = (f * o.channels + c) * step
    if (o.float) { if (o.bits === 32) { o.little ? pcm.writeFloatLE(v, at) : pcm.writeFloatBE(v, at) } else { o.little ? pcm.writeDoubleLE(v, at) : pcm.writeDoubleBE(v, at) } }
    else if (o.bits === 16) { const s = Math.round(v * 32767); o.little ? pcm.writeInt16LE(s, at) : pcm.writeInt16BE(s, at) }
    else if (o.bits === 24) { const s = Math.round(v * 0x7fffff); o.little ? pcm.writeIntLE(s, at, 3) : pcm.writeIntBE(s, at, 3) }
    else { const s = Math.round(v * 0x7fffffff); o.little ? pcm.writeInt32LE(s, at) : pcm.writeInt32BE(s, at) }
  }))
  const chunk = (type: string, body: Buffer, size = BigInt(body.length)) => {
    const h = Buffer.alloc(12); h.write(type, 0, 'ascii'); h.writeBigInt64BE(size, 4)
    return Buffer.concat([h, body])
  }
  const head = Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0])
  const data = Buffer.concat([Buffer.alloc(4), pcm])
  return Buffer.concat([head, chunk('desc', desc), chunk('free', Buffer.alloc(16)), chunk('data', data, o.dataSize ?? BigInt(data.length))])
}

function wavSamples(wav: Buffer): number[] {
  expect(isConformingWav(wav)).toBe(true)
  const out: number[] = []
  for (let at = 44; at + 2 <= wav.length; at += 2) out.push(wav.readInt16LE(at) / 32767)
  return out
}

const ramp = (n: number) => Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5)

describe('cafToWav', () => {
  it('copies the phone shape (16kHz mono int16 little-endian) sample for sample', () => {
    const src = ramp(1600).map((v) => [v])
    const input = caf(src, { rate: 16000, channels: 1, bits: 16, little: true })
    const wav = cafToWav(input)!
    expect(wav.readUInt32LE(40)).toBe(3200)
    expect(wav.subarray(44).equals(input.subarray(input.length - 3200))).toBe(true)
  })

  it.each([
    ['int16 big-endian', { bits: 16 }],
    ['int24 little-endian', { bits: 24, little: true }],
    ['int32 big-endian', { bits: 32 }],
    ['float32 little-endian', { bits: 32, float: true, little: true }],
    ['float64 big-endian', { bits: 64, float: true }],
  ])('decodes %s', (_name, o) => {
    const src = ramp(400)
    const out = wavSamples(cafToWav(caf(src.map((v) => [v]), { rate: 16000, channels: 1, ...o }))!)
    expect(out).toHaveLength(400)
    out.forEach((v, i) => expect(v).toBeCloseTo(src[i], 3))
  })

  it('downmixes stereo and resamples 48kHz to 16kHz', () => {
    const frames = 4800
    const src = Array.from({ length: frames }, () => [0.4, -0.2])
    const out = wavSamples(cafToWav(caf(src, { rate: 48000, channels: 2, bits: 32, float: true, little: true }))!)
    expect(out).toHaveLength(1600)
    out.forEach((v) => expect(v).toBeCloseTo(0.1, 3))
  })

  it('reads a data chunk that runs to end of file and one cut off mid-chunk', () => {
    const src = ramp(100).map((v) => [v])
    const open = caf(src, { rate: 16000, channels: 1, bits: 16, little: true, dataSize: -1n })
    expect(wavSamples(cafToWav(open)!)).toHaveLength(100)
    const full = caf(src, { rate: 16000, channels: 1, bits: 16, little: true })
    // 41 bytes off the end: 20 whole frames go, half a frame is dropped.
    expect(wavSamples(cafToWav(full.subarray(0, full.length - 41))!)).toHaveLength(79)
  })

  it('declines what it cannot rewrap, so ffmpeg still gets it', () => {
    expect(cafToWav(caf([[0]], { rate: 16000, channels: 1, bits: 16, format: 'aac ' }))).toBeNull()
    expect(cafToWav(caf([], { rate: 16000, channels: 1, bits: 12 }))).toBeNull()
    expect(cafToWav(caf([], { rate: 16000, channels: 1, bits: 16 }))).toBeNull()
    expect(cafToWav(Buffer.from('RIFF....WAVEfmt '))).toBeNull()
    expect(cafToWav(Buffer.alloc(0))).toBeNull()
    const noDesc = caf([[0.1]], { rate: 16000, channels: 1, bits: 16 })
    noDesc.write('xxxx', 8, 'ascii')
    expect(cafToWav(noDesc)).toBeNull()
  })
})

describe('convertToWav for CAF', () => {
  it('needs no ffmpeg for PCM CAF', async () => {
    const input = caf(ramp(800).map((v) => [v]), { rate: 16000, channels: 1, bits: 16, little: true })
    const path = await convertToWav(input.toString('base64'), 'caf')
    try {
      expect(wavSamples(await readFile(path))).toHaveLength(800)
      expect(execFile).not.toHaveBeenCalled()
    } finally { await cleanupTempFile(path) }
  })

  it('hands compressed CAF to ffmpeg', async () => {
    const input = caf([[0]], { rate: 16000, channels: 1, bits: 16, format: 'aac ' })
    await expect(convertToWav(input.toString('base64'), 'caf')).rejects.toThrow('ffmpeg must not run')
    expect(execFile).toHaveBeenCalledWith('ffmpeg', expect.anything(), expect.anything(), expect.anything())
  })
})
