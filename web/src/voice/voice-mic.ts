/**
 * Voice mode's microphone: one stream for the whole conversation, its loudness
 * (for voice activity), whether it delivers sound at all (mic-health.ts, the same
 * rule dictation uses) and a recorder per take.
 *
 * It asks for dictation's constraints (utils/mic-constraints.ts), echo
 * cancellation off: in WebKit it rebuilds the audio device whenever the output
 * changes, and voice mode changes the output on every answer, so the mic would
 * stall mid-sentence. The answer that leaks from the speaker into the mic is
 * told apart from the person by voice-activity.ts instead (it hears the output
 * level too). While the mic is open the music of this machine stays paused
 * (api/media-hold.ts), as it does for dictation.
 */

import { acquireMediaHold, type MediaHoldHandle } from '@/api/media-hold';
import { DICTATION_AUDIO_CONSTRAINTS } from '@/utils/mic-constraints';
import { byteFrameRms, initialMicHealth, micHealthTick, micHealthTrackEnded, SAMPLE_INTERVAL_MS, type MicHealthState } from '@/utils/mic-health';
import { floatRms } from './voice-activity';

/** The recorder's format and the name the transcribe route takes for it. */
function recorderFormat(): { mimeType?: string; format: string } {
  const R = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  for (const [mimeType, format] of [['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/mp4', 'mp4']] as const) {
    if (R?.isTypeSupported?.(mimeType)) return { mimeType, format };
  }
  return { format: 'webm' };
}

export interface Take {
  blob: Blob;
  format: string;
  ms: number;
}

export interface MicSample {
  /** Loudness now (RMS of the float frame, 0..1): voice activity reads it. */
  rms: number;
  /** The mic warning now (mic-health.ts): no sound at all, or the device went away. */
  warning: string | null;
}

/** The loudness an analyser carries now (RMS of its float frame); `buf` is the analyser's own size. */
export function analyserRms(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  return floatRms(buf);
}

export class VoiceMic {
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private startedAt = 0;
  private readonly buf: Float32Array<ArrayBuffer>;
  private readonly bytes: Uint8Array<ArrayBuffer>;
  private health: MicHealthState = initialMicHealth();
  private warning: string | null = null;
  private lastHealthAt = 0;

  private constructor(
    private readonly stream: MediaStream,
    private readonly analyser: AnalyserNode,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly hold: MediaHoldHandle,
  ) {
    this.buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.bytes = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        const tick = micHealthTrackEnded(this.health);
        this.health = tick.state;
        this.warning = tick.warning;
      });
    }
  }

  static async open(ctx: AudioContext): Promise<VoiceMic> {
    // Asked at once, so the music is already off when the first words come.
    const hold = acquireMediaHold('voice-conversation');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: DICTATION_AUDIO_CONSTRAINTS });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      return new VoiceMic(stream, analyser, source, hold);
    } catch (err) {
      hold.release();
      throw err;
    }
  }

  /** One reading. The health rule counts its own ticks, so it is fed at its own pace. */
  sample(now = performance.now()): MicSample {
    const rms = analyserRms(this.analyser, this.buf);
    if (now - this.lastHealthAt >= SAMPLE_INTERVAL_MS) {
      this.lastHealthAt = now;
      // Bytes on purpose: DEAD_STREAM_RMS is measured on the byte frame (see byteFrameRms).
      this.analyser.getByteTimeDomainData(this.bytes);
      const tick = micHealthTick(this.health, byteFrameRms(this.bytes));
      this.health = tick.state;
      this.warning = tick.warning;
    }
    return { rms, warning: this.warning };
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  startTake(): void {
    this.discardTake();
    const { mimeType } = recorderFormat();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.parts = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) this.parts.push(e.data); };
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
  }

  /**
   * What the take holds so far, while it goes on (the recorder hands a part every second, the
   * first one carrying the header): the live words are drafted from it. Null with no take or no part yet.
   */
  peekTake(): Take | null {
    if (!this.recorder || this.recorder.state === 'inactive' || !this.parts.length) return null;
    const blob = new Blob(this.parts, { type: this.recorder.mimeType || 'audio/webm' });
    return { blob, format: recorderFormat().format, ms: performance.now() - this.startedAt };
  }

  /** The take so far, whole; null when no take is running. */
  finishTake(): Promise<Take | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    this.recorder = null;
    const ms = performance.now() - this.startedAt;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.parts, { type: recorder.mimeType || 'audio/webm' });
        this.parts = [];
        resolve(blob.size > 0 ? { blob, format: recorderFormat().format, ms } : null);
      };
      recorder.stop();
    });
  }

  discardTake(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.parts = [];
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
  }

  close(): void {
    this.discardTake();
    this.source.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    this.hold.release();
  }
}
