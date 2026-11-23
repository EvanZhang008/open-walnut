/**
 * Raw PCM speech as the local voice streams it: `audio/L16; rate=<hz>; channels=<n>`
 * (RFC 2586: signed 16-bit big-endian samples, no header). The cache keeps a
 * whole piece as WAV instead, which every client already plays.
 *
 * Shared with the browser (`@open-walnut/pcm-l16`), which plays the stream as it
 * comes: keep this file free of Node imports.
 */

export interface L16Format {
  rate: number;
  channels: number;
}

/** The format an `audio/L16` content type names, or null for any other type. */
export function parseL16(mime: string | null | undefined): L16Format | null {
  if (!mime) return null;
  const [type, ...params] = mime.split(';').map((p) => p.trim());
  if (type?.toLowerCase() !== 'audio/l16') return null;
  const value = (name: string) => {
    const p = params.find((x) => x.toLowerCase().startsWith(`${name}=`));
    const n = p ? Number(p.slice(name.length + 1)) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return { rate: value('rate') ?? 24_000, channels: value('channels') ?? 1 };
}

/** Big-endian L16 samples as a 16-bit WAV file (little-endian samples behind a 44-byte header). */
export function l16ToWav(pcm: Uint8Array, format: L16Format): Uint8Array {
  const frame = 2 * format.channels;
  const size = pcm.byteLength - (pcm.byteLength % frame);
  const out = new Uint8Array(44 + size);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.rate, true);
  view.setUint32(28, format.rate * frame, true);
  view.setUint16(32, frame, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, size, true);
  for (let i = 0; i < size; i += 2) {
    out[44 + i] = pcm[i + 1]!;
    out[45 + i] = pcm[i]!;
  }
  return out;
}

/**
 * The whole frames at the start of `bytes` as float samples in [-1, 1), one array
 * per channel; `used` is how many bytes they took (a frame cut across two network
 * chunks waits for the rest).
 */
export function l16ToFloat(bytes: Uint8Array, channels: number): { samples: Float32Array[]; used: number } {
  const frame = 2 * channels;
  const frames = Math.floor(bytes.byteLength / frame);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * frame);
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) samples[c]![f] = view.getInt16(f * frame + c * 2, false) / 32768;
  }
  return { samples, used: frames * frame };
}
