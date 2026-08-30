/**
 * Raw PCM capture alongside MediaRecorder, for the live dictation draft.
 *
 * MediaRecorder's webm chunks are only decodable as a from-the-start
 * concatenation, so a draft built from them must always re-transcribe the whole
 * clip. Capturing raw PCM in parallel lets the draft slice ANY window of the
 * recording and encode it as a standalone WAV, which is what makes
 * segment-commit (stt-segments.ts) possible: committed audio is simply never
 * sliced again.
 *
 * ScriptProcessorNode is deprecated but universally supported and needs no
 * worklet module file; the capture is best-effort anyway (no PCM → the hook
 * falls back to whole-clip drafting).
 */

import { findSilenceCommitPoint, type PcmBlockInfo, type CommitPointOptions } from './stt-segments';

/** Everything the STT engines use — also 3x smaller uploads than 48kHz. */
const TARGET_SAMPLE_RATE = 16000;
/** ~85ms at 48kHz: fine enough silence resolution, few enough blocks. */
const PROCESSOR_BUFFER = 4096;

interface PcmBlock extends PcmBlockInfo {
  samples: Float32Array;
}

export class PcmCapture {
  private blocks: PcmBlock[] = [];
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private total = 0;
  readonly sampleRate: number;

  private constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** Returns null when the graph can't be built — callers must handle that. */
  static attach(ctx: AudioContext, stream: MediaStream): PcmCapture | null {
    try {
      const cap = new PcmCapture(ctx.sampleRate);
      cap.source = ctx.createMediaStreamSource(stream);
      cap.node = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
      cap.node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const samples = new Float32Array(input); // the buffer is reused; copy
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        cap.blocks.push({
          startSample: cap.total,
          length: samples.length,
          rms: Math.sqrt(sumSq / samples.length),
          samples,
        });
        cap.total += samples.length;
      };
      cap.source.connect(cap.node);
      // A ScriptProcessor only fires when connected to a destination; route it
      // there via a zero-gain node so nothing is audible.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      cap.node.connect(mute);
      mute.connect(ctx.destination);
      return cap;
    } catch {
      return null;
    }
  }

  detach(): void {
    this.node?.disconnect();
    this.source?.disconnect();
    this.node = null;
    this.source = null;
  }

  /** Samples captured so far (absolute position of "now"). */
  get totalSamples(): number {
    return this.total;
  }

  /** Absolute sample position where speech (not noise floor) was last heard. */
  lastVoiceSample(voiceRms: number): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.rms >= voiceRms) return b.startSample + b.length;
    }
    return 0;
  }

  findCommitPoint(windowStartSample: number, opts: Omit<CommitPointOptions, 'sampleRate'>): number | null {
    return findSilenceCommitPoint(this.blocks, windowStartSample, { ...opts, sampleRate: this.sampleRate });
  }

  /**
   * Encodes [fromSample, toSample) as a 16kHz mono 16-bit WAV, base64.
   * Returns null when the slice is empty.
   */
  sliceWavBase64(fromSample: number, toSample?: number): { base64: string; endSample: number } | null {
    const end = Math.min(toSample ?? this.total, this.total);
    if (end <= fromSample) return null;

    // Gather the slice into one Float32Array.
    const raw = new Float32Array(end - fromSample);
    for (const b of this.blocks) {
      const bEnd = b.startSample + b.length;
      if (bEnd <= fromSample || b.startSample >= end) continue;
      const srcFrom = Math.max(0, fromSample - b.startSample);
      const srcTo = Math.min(b.length, end - b.startSample);
      raw.set(b.samples.subarray(srcFrom, srcTo), b.startSample + srcFrom - fromSample);
    }

    // Linear resample to 16kHz. The engines resample to this anyway, so nothing
    // they would use is lost, and the upload shrinks ~3x.
    const ratio = this.sampleRate / TARGET_SAMPLE_RATE;
    const outLen = Math.max(1, Math.floor(raw.length / ratio));
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = raw[i0] * (1 - frac) + (raw[Math.min(i0 + 1, raw.length - 1)] ?? 0) * frac;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }

    return { base64: encodeWav(pcm, TARGET_SAMPLE_RATE), endSample: end };
  }
}

/** Minimal RIFF/WAVE writer: 16-bit mono PCM, returned as base64. */
function encodeWav(pcm: Int16Array, sampleRate: number): string {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);       // fmt chunk size
  v.setUint16(20, 1, true);        // PCM
  v.setUint16(22, 1, true);        // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);        // block align
  v.setUint16(34, 16, true);       // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);

  // Chunked btoa to avoid call-stack limits on long recordings.
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}
