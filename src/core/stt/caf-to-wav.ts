/**
 * Linear PCM CAF → 16kHz mono 16-bit WAV, in-process.
 *
 * The phone records LPCM CAF, and the hosted engine does not accept CAF. Before
 * this, every CAF went through ffmpeg, so a box without ffmpeg (the cloud
 * companion, 2026-10-14) failed every phone recording while the Mac slept.
 * PCM in a CAF container needs no codec, only a rewrap, so the server does it
 * itself. Anything compressed (AAC, ALAC, …) returns null and goes to ffmpeg.
 */

const TARGET_RATE = 16_000
const FLAG_FLOAT = 1
const FLAG_LITTLE_ENDIAN = 2

interface Desc { rate: number; float: boolean; little: boolean; channels: number; bits: number }

function readDesc(buf: Buffer, at: number): Desc | null {
  if (buf.toString('ascii', at + 8, at + 12) !== 'lpcm') return null
  const flags = buf.readUInt32BE(at + 12)
  const channels = buf.readUInt32BE(at + 24)
  const bits = buf.readUInt32BE(at + 28)
  const rate = buf.readDoubleBE(at)
  const float = (flags & FLAG_FLOAT) !== 0
  const supported = float ? bits === 32 || bits === 64 : bits === 16 || bits === 24 || bits === 32
  if (!supported || channels < 1 || channels > 32 || !(rate >= 1000 && rate <= 768_000)) return null
  return { rate, float, little: (flags & FLAG_LITTLE_ENDIAN) !== 0, channels, bits }
}

/** One sample as a float in [-1, 1]. */
function sampleAt(buf: Buffer, at: number, d: Desc): number {
  if (d.float) {
    if (d.bits === 32) return d.little ? buf.readFloatLE(at) : buf.readFloatBE(at)
    return d.little ? buf.readDoubleLE(at) : buf.readDoubleBE(at)
  }
  if (d.bits === 16) return (d.little ? buf.readInt16LE(at) : buf.readInt16BE(at)) / 0x8000
  if (d.bits === 24) return (d.little ? buf.readIntLE(at, 3) : buf.readIntBE(at, 3)) / 0x800000
  return (d.little ? buf.readInt32LE(at) : buf.readInt32BE(at)) / 0x80000000
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(TARGET_RATE, 24); h.writeUInt32LE(TARGET_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii'); h.writeUInt32LE(dataBytes, 40)
  return h
}

/** The WAV bytes, or null when this is not a linear PCM CAF this function reads. */
export function cafToWav(buf: Buffer): Buffer | null {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'caff' || buf.readUInt16BE(4) !== 1) return null
  let desc: Desc | null = null
  let dataStart = -1
  let dataEnd = -1
  let at = 8
  while (at + 12 <= buf.length) {
    const type = buf.toString('ascii', at, at + 4)
    const size = buf.readBigInt64BE(at + 4)
    const body = at + 12
    // -1 = the data chunk runs to end of file (a recorder that has not finalized it).
    const end = size < 0n ? buf.length : Math.min(buf.length, body + Number(size))
    if (type === 'desc') {
      if (end - body < 32) return null
      desc = readDesc(buf, body)
      if (!desc) return null
    } else if (type === 'data') {
      // A file cut off mid-chunk keeps the frames it has.
      dataStart = body + 4
      dataEnd = end
    }
    if (size < 0n || end >= buf.length) break
    at = end
  }
  if (!desc || dataStart < 0 || dataEnd <= dataStart) return null

  const frameBytes = desc.channels * (desc.bits / 8)
  const frames = Math.floor((dataEnd - dataStart) / frameBytes)
  if (frames < 1) return null

  // Already the target shape: copy the samples as they are.
  if (!desc.float && desc.bits === 16 && desc.little && desc.channels === 1 && desc.rate === TARGET_RATE) {
    const pcm = buf.subarray(dataStart, dataStart + frames * 2)
    return Buffer.concat([wavHeader(pcm.length), pcm])
  }

  const mono = new Float64Array(frames)
  const step = desc.bits / 8
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const base = dataStart + f * frameBytes
    for (let c = 0; c < desc.channels; c++) sum += sampleAt(buf, base + c * step, desc)
    mono[f] = sum / desc.channels
  }
  const outFrames = Math.max(1, Math.floor((frames * TARGET_RATE) / desc.rate))
  const pcm = Buffer.alloc(outFrames * 2)
  const ratio = desc.rate / TARGET_RATE
  for (let i = 0; i < outFrames; i++) {
    const pos = i * ratio
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, frames - 1)
    const v = mono[lo] + (mono[hi] - mono[lo]) * (pos - lo)
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2)
  }
  return Buffer.concat([wavHeader(pcm.length), pcm])
}
