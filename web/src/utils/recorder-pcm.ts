/**
 * The live draft's audio, decoded from the recorder's own WebM as it grows.
 *
 * MediaRecorder is the one capture in the Mac app that keeps every word: the mic
 * pushes its samples to it. The Web Audio side capture (pcm-stream.ts) instead
 * pulls them on the audio thread and gets zeros whenever it reads ahead, so a
 * draft built from it heard holes the recording never had (2026-11-08: the
 * whole recording said "这个和它 overlap 和不 overlap 是没有关系", the draft said
 * "德莱和波文"). Decoding the recorder's bytes makes the draft hear exactly
 * what the final pass hears.
 *
 * Every refresh decodes the chunks so far from the start (a WebM only decodes
 * with its header) at 16 kHz mono, the rate the engines use, so slices need no
 * resampling. The samples before the last block are kept and only the rest is
 * mixed and measured again, so a tick costs one decode plus the new audio.
 *
 * With some headsets the Mac app's recorder writes every 10 ms twice
 * (src/lib/audio-block-repeat.ts): the draft heard speech at half its tempo and
 * came back empty. The decode is read once as spoken, decided from the sound
 * itself as soon as there is enough of it.
 */

import { findSilenceCommitPoint, type PcmBlockInfo, type CommitPointOptions } from './stt-segments';
import { encodeWav, lastVoiceIn, voiceBetween, type PcmSource } from './pcm-stream';
import { findBlockRepeat, removeBlockRepeat, type BlockRepeat } from '../../../src/lib/audio-block-repeat';

const SAMPLE_RATE = 16000;
/** ~85 ms, the side capture's block length, so the silence rules read the same. */
const BLOCK = 1365;
/** Audio after which a take that repeats nothing is taken not to (20 s). */
const SETTLE_SAMPLES = SAMPLE_RATE * 20;

/** What a decode returns: the channels of the audio, at SAMPLE_RATE. */
export interface DecodedAudio {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}
export type DecodeAudio = (bytes: ArrayBuffer) => Promise<DecodedAudio>;

/** The browser's decoder, resampling to 16 kHz. Null where Web Audio is missing. */
export function browserDecoder(): DecodeAudio | null {
  const Offline = typeof window !== 'undefined'
    ? (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext)
    : undefined;
  if (!Offline) return null;
  let ctx: OfflineAudioContext | null = null;
  return (bytes) => {
    ctx ??= new Offline(1, 1, SAMPLE_RATE);
    return ctx.decodeAudioData(bytes);
  };
}

export class RecorderPcm implements PcmSource {
  readonly sampleRate = SAMPLE_RATE;
  private samples = new Float32Array(SAMPLE_RATE * 30);
  private total = 0;
  private blocks: PcmBlockInfo[] = [];
  private gen = 0;
  // null: not decided yet; 'none': the recording repeats nothing.
  private repeat: BlockRepeat | 'none' | null = null;
  private rebase = 0;
  private decoded = 0;

  constructor(private readonly decode: DecodeAudio) {}

  get totalSamples(): number {
    return this.total;
  }

  /**
   * Decodes `blob` (every recorder chunk so far) and takes its audio as the new
   * timeline. Throws when the browser cannot decode it; the caller keeps the
   * timeline it had, so positions it holds stay valid.
   */
  async refresh(blob: Blob): Promise<void> {
    // The stop's refresh can overtake a tick's: a decode that finishes after a
    // later one started holds less audio, so it is dropped.
    const gen = ++this.gen;
    const audio = await this.decode(await blob.arrayBuffer());
    if (gen !== this.gen) return;
    if (audio.sampleRate !== SAMPLE_RATE) throw new Error(`decoded at ${audio.sampleRate} Hz, not ${SAMPLE_RATE}`);
    // Mono as the side capture and the server's ffmpeg make it: the mean of the
    // channels (the Mac app records two, the second one silent).
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const n = channels.length || 1;
    let mono = new Float32Array(audio.length);
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i];
      mono[i] = s / n;
    }
    this.decoded = audio.length;
    if (this.repeat === null) {
      const verdict = findBlockRepeat(mono, SAMPLE_RATE);
      // A first second of a headset still switching can read as no repeat:
      // "none" is only taken as settled once the take is long enough.
      this.repeat = verdict === 'none' && mono.length < SETTLE_SAMPLES ? null : verdict;
      if (this.repeat && this.repeat !== 'none') {
        // Every position taken so far was on the repeated timeline.
        this.rebase = 1 / this.repeat.factor;
        this.blocks.length = 0;
      }
    } else if (this.repeat !== 'none' && findBlockRepeat(mono, SAMPLE_RATE) === 'none') {
      // The take stopped repeating at one phase (findBlockRepeat leaves such a
      // take as it is): the draft goes back to the audio as decoded.
      this.rebase = this.repeat.factor;
      this.repeat = 'none';
      this.blocks.length = 0;
    }
    if (this.repeat && this.repeat !== 'none') mono = removeBlockRepeat(mono, this.repeat);
    const len = mono.length;
    // Keep every whole block but the last: the end of a stream decoded again
    // with more bytes after it can differ in its final frames. A decode a few
    // frames shorter than the last one keeps only the blocks inside it.
    const keepBlocks = Math.max(0, Math.min(this.blocks.length - 1, Math.floor(len / BLOCK)));
    const from = keepBlocks * BLOCK;
    this.blocks.length = keepBlocks;
    if (len > this.samples.length) {
      const grown = new Float32Array(Math.max(len, this.samples.length * 2));
      grown.set(this.samples.subarray(0, from));
      this.samples = grown;
    }
    this.samples.set(mono.subarray(from), from);
    for (let start = from; start < len; start += BLOCK) {
      const end = Math.min(len, start + BLOCK);
      let sumSq = 0;
      for (let i = start; i < end; i++) sumSq += this.samples[i] * this.samples[i];
      this.blocks.push({ startSample: start, length: end - start, rms: Math.sqrt(sumSq / (end - start)) });
    }
    this.total = len;
  }

  /** Samples the last decode held before any repeat was dropped: what a tick costs to decode. */
  get decodedSamples(): number {
    return this.decoded;
  }

  /**
   * What positions taken before this refresh must be multiplied by, once: set
   * when the refresh found the recording repeats its sound (1/factor), or that
   * it does not after all (factor). 0 otherwise.
   */
  takeRebase(): number {
    const f = this.rebase;
    this.rebase = 0;
    return f;
  }

  lastVoiceSample(voiceRms: number): number {
    return lastVoiceIn(this.blocks, voiceRms);
  }

  hasVoiceBetween(fromSample: number, toSample: number, voiceRms: number): boolean {
    return voiceBetween(this.blocks, fromSample, toSample, voiceRms);
  }

  findCommitPoint(windowStartSample: number, opts: Omit<CommitPointOptions, 'sampleRate'>): number | null {
    return findSilenceCommitPoint(this.blocks, windowStartSample, { ...opts, sampleRate: this.sampleRate });
  }

  /** [fromSample, toSample) as a 16 kHz mono 16-bit WAV, base64; null when empty. */
  sliceWavBase64(fromSample: number, toSample?: number): { base64: string; endSample: number } | null {
    const end = Math.min(toSample ?? this.total, this.total);
    if (end <= fromSample) return null;
    const pcm = new Int16Array(end - fromSample);
    for (let i = 0; i < pcm.length; i++) {
      const s = this.samples[fromSample + i];
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    return { base64: encodeWav(pcm, SAMPLE_RATE), endSample: end };
  }
}
