/**
 * Voice mode's speaker: says a reply piece by piece.
 *
 * With a server voice (ElevenLabs), each piece's speech is fetched from
 * /api/v1/voice/speak, the next one while the current one plays, so the voice
 * starts after the first short piece instead of after the whole answer. Played
 * through Web Audio (the context voice mode opened on the person's click, so the
 * browser lets it sound). When the server has no voice, or it fails, the rest is
 * said with the device's own voice (speechSynthesis), never left silent.
 */

import { speakPiece, SpeakError, type SpokenReply, type TtsEngineId } from '../api/voice';
import { log } from '../utils/log';
import { analyserRms } from './voice-mic';

export type SpeakOutcome = 'done' | 'stopped';

/** Rough length of a piece when said, for the watchdog: a voice that never reports its end must not hold the conversation. */
function estimateMs(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length;
  const words = (text.replace(/[\u3040-\u30ff\u4e00-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return (cjk * 0.25 + words * 0.4) * 1000;
}

export class VoiceSpeaker {
  private run = 0;
  private abort: AbortController | null = null;
  private source: AudioBufferSourceNode | null = null;
  private wake: (() => void) | null = null;
  /** The engine for the rest of this conversation: a server voice that failed is not tried again. */
  private engine: TtsEngineId;
  /** Everything played goes through it, so barge-in can tell the leak from the person. */
  private readonly out: AnalyserNode;
  private readonly outBuf: Float32Array<ArrayBuffer>;
  private deviceSpeaking = false;

  constructor(private readonly ctx: AudioContext, engine: TtsEngineId, private readonly onEngineChange?: (engine: TtsEngineId, why: string) => void) {
    this.engine = engine;
    this.out = ctx.createAnalyser();
    this.out.fftSize = 2048;
    this.out.connect(ctx.destination);
    this.outBuf = new Float32Array(new ArrayBuffer(this.out.fftSize * 4));
  }

  /** The output's loudness now: 0 when silent, null while the device's voice speaks (not measurable). */
  outputLevel(): number | null {
    if (this.deviceSpeaking) return null;
    if (!this.source) return 0;
    return analyserRms(this.out, this.outBuf);
  }

  get currentEngine(): TtsEngineId {
    return this.engine;
  }

  /** Say `reply`; resolves when it is done or `stop()` was called. */
  async say(reply: SpokenReply): Promise<SpeakOutcome> {
    this.stop();
    const run = ++this.run;
    const abort = new AbortController();
    this.abort = abort;
    const pieces = reply.chunks.length ? reply.chunks : [reply.text];
    const fetchPiece = (i: number) => speakPiece({
      text: pieces[i]!,
      language: reply.language,
      ...(i > 0 ? { previousText: pieces[i - 1] } : {}),
      ...(i + 1 < pieces.length ? { nextText: pieces[i + 1] } : {}),
    }, abort.signal);
    let next: Promise<ArrayBuffer> | null = this.engine === 'device' ? null : fetchPiece(0);
    next?.catch(() => {});
    for (let i = 0; i < pieces.length; i++) {
      if (run !== this.run) return 'stopped';
      if (this.engine !== 'device' && next) {
        try {
          const bytes = await next;
          next = i + 1 < pieces.length ? fetchPiece(i + 1) : null;
          next?.catch(() => {});
          if (run !== this.run) return 'stopped';
          await this.playBytes(bytes, run);
          continue;
        } catch (err) {
          if (run !== this.run || abort.signal.aborted) return 'stopped';
          const why = err instanceof Error ? err.message : String(err);
          log.warn('voice', 'server voice failed: the device speaks instead', { error: why, piece: i });
          if (!(err instanceof SpeakError) || err.fallback) {
            this.engine = 'device';
            this.onEngineChange?.('device', why);
          }
          next = null;
        }
      }
      await this.sayOnDevice(pieces[i]!, reply.language, run);
    }
    return run === this.run ? 'done' : 'stopped';
  }

  stop(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.deviceSpeaking = false;
    this.wake?.();
    this.wake = null;
  }

  private async playBytes(bytes: ArrayBuffer, run: number): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(bytes);
    if (run !== this.run) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);
    this.source = source;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(watchdog); if (this.wake === done) this.wake = null; resolve(); };
      const watchdog = setTimeout(done, buffer.duration * 1000 + 1500);
      this.wake = done;
      source.onended = done;
      source.start();
    });
    if (this.source === source) this.source = null;
  }

  private sayOnDevice(text: string, language: string, run: number): Promise<void> {
    if (typeof speechSynthesis === 'undefined' || run !== this.run) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language;
      const voice = pickVoice(language);
      if (voice) utterance.voice = voice;
      const done = () => { clearTimeout(watchdog); this.deviceSpeaking = false; if (this.wake === done) this.wake = null; resolve(); };
      // Chrome drops long utterances without an end event, and a muted test page never speaks.
      const watchdog = setTimeout(done, estimateMs(text) * 1.6 + 2000);
      this.wake = done;
      utterance.onend = done;
      utterance.onerror = done;
      this.deviceSpeaking = true;
      speechSynthesis.speak(utterance);
    });
  }
}

/** The best installed voice for a language: a local "Premium"/"Enhanced" one first. */
function pickVoice(language: string): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  const base = language.split('-')[0]!.toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
  if (!matching.length) return null;
  const score = (v: SpeechSynthesisVoice) =>
    (/premium/i.test(v.name) ? 4 : /enhanced/i.test(v.name) ? 2 : 0)
    + (v.lang.toLowerCase().replace('_', '-') === language.toLowerCase() ? 1 : 0)
    + (v.localService ? 1 : 0);
  return [...matching].sort((a, b) => score(b) - score(a))[0] ?? null;
}
