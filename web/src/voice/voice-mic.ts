/**
 * Voice mode's microphone: one stream for the whole conversation, its loudness
 * (for voice activity) and a recorder per take.
 *
 * Unlike dictation (utils/mic-constraints.ts turns echo cancellation off for the
 * cleanest words), voice mode plays answers through the speaker while it listens,
 * so it asks the browser for echo cancellation and noise suppression: without
 * them the answer read aloud would count as the person talking over it.
 */

import { floatRms } from './voice-activity';

const CONVERSATION_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

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

export class VoiceMic {
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private startedAt = 0;
  private readonly buf: Float32Array<ArrayBuffer>;

  private constructor(
    private readonly stream: MediaStream,
    private readonly analyser: AnalyserNode,
    private readonly source: MediaStreamAudioSourceNode,
  ) {
    this.buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  }

  static async open(ctx: AudioContext): Promise<VoiceMic> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: CONVERSATION_CONSTRAINTS });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    return new VoiceMic(stream, analyser, source);
  }

  /** Loudness now (RMS, 0..1). */
  rms(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    return floatRms(this.buf);
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
  }
}
