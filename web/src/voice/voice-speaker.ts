/**
 * Voice mode's speaker: says a reply piece by piece, and the pieces of an answer
 * still streaming as they come (`enqueue`).
 *
 * With a server voice (ElevenLabs), each piece's speech is fetched from
 * /api/v1/voice/speak, the next one while the current one plays, so the voice
 * starts after the first short piece instead of after the whole answer. Played
 * through Web Audio (the context voice mode opened on the person's click, so the
 * browser lets it sound). When the server has no voice, or it fails, the rest is
 * said with the device's own voice (speechSynthesis), never left silent. While
 * voice mode waits for words it plays the waiting cue (waiting-cue.ts) through the
 * same output.
 */

import { speakPiece, SpeakError, type SpokenReply, type TtsEngineId } from '../api/voice';
import { log } from '../utils/log';
import { analyserRms } from './voice-mic';
import { estimatedSeconds } from './stream-reader';
import { WaitingCue } from './waiting-cue';

export type SpeakOutcome = 'done' | 'stopped';

interface Queued {
  text: string;
  language: string;
  /** The piece said before it, for a voice that keeps its tone across pieces. */
  previous?: string;
  audio?: Promise<ArrayBuffer>;
}

export class VoiceSpeaker {
  private run = 0;
  private abort: AbortController | null = null;
  private source: AudioBufferSourceNode | null = null;
  private wake: (() => void) | null = null;
  /** Pieces not yet said, in order. */
  private queue: Queued[] = [];
  /** The last piece queued, for the next one's `previousText`. */
  private lastText: string | undefined;
  /** Resolves when the queue runs out ('done') or on stop() ('stopped'); null while idle. */
  private drain: { promise: Promise<SpeakOutcome>; resolve: (outcome: SpeakOutcome) => void } | null = null;
  /** The engine for the rest of this conversation: a server voice that failed is not tried again. */
  private engine: TtsEngineId;
  /** Everything played goes through it, so barge-in can tell the leak from the person. */
  private readonly out: AnalyserNode;
  private readonly outBuf: Float32Array<ArrayBuffer>;
  private readonly cue: WaitingCue;
  private deviceSpeaking = false;

  constructor(private readonly ctx: AudioContext, engine: TtsEngineId, private readonly onEngineChange?: (engine: TtsEngineId, why: string) => void) {
    this.engine = engine;
    this.out = ctx.createAnalyser();
    this.out.fftSize = 2048;
    this.out.connect(ctx.destination);
    this.outBuf = new Float32Array(new ArrayBuffer(this.out.fftSize * 4));
    this.cue = new WaitingCue(ctx, this.out);
  }

  /** The output's loudness now: 0 when silent, null while the device's voice speaks (not measurable). */
  outputLevel(): number | null {
    if (this.deviceSpeaking) return null;
    if (!this.source && !this.cue.playing) return 0;
    return analyserRms(this.out, this.outBuf);
  }

  get currentEngine(): TtsEngineId {
    return this.engine;
  }

  /** Nothing is being said or waits to be. */
  get idle(): boolean {
    return this.drain === null;
  }

  /** The waiting cue on or off; any speech turns it off. */
  waitingCue(on: boolean): void {
    if (on && this.idle) this.cue.start();
    else this.cue.stop();
  }

  /** Say `reply` now, instead of anything being said; resolves when it is done or `stop()` was called. */
  say(reply: SpokenReply): Promise<SpeakOutcome> {
    this.stop();
    return this.enqueue(reply);
  }

  /**
   * Say `reply` after what is being said (now, when nothing is). Returns the promise
   * of the whole queue: the same one for every piece added while it plays.
   */
  enqueue(reply: SpokenReply): Promise<SpeakOutcome> {
    this.cue.stop();
    for (const text of reply.chunks.length ? reply.chunks : [reply.text]) {
      this.queue.push({ text, language: reply.language, ...(this.lastText ? { previous: this.lastText } : {}) });
      this.lastText = text;
    }
    if (this.drain) {
      // One is playing or on its way: the next piece's audio starts now, so it adds no silence.
      const next = this.queue[0];
      if (next && this.abort) this.fetch(next, this.queue[1], this.abort.signal);
      return this.drain.promise;
    }
    let resolve!: (outcome: SpeakOutcome) => void;
    const promise = new Promise<SpeakOutcome>((r) => { resolve = r; });
    const drain = { promise, resolve };
    this.drain = drain;
    const abort = new AbortController();
    this.abort = abort;
    void this.pump(this.run, drain, abort.signal);
    return promise;
  }

  /** Starts the audio of a queued piece, once (the server voice only). */
  private fetch(item: Queued, next: Queued | undefined, signal: AbortSignal): void {
    if (this.engine === 'device' || item.audio) return;
    item.audio = speakPiece({
      text: item.text,
      language: item.language,
      ...(item.previous ? { previousText: item.previous } : {}),
      ...(next ? { nextText: next.text } : {}),
    }, signal);
    item.audio.catch(() => {});
  }

  private async pump(run: number, drain: NonNullable<VoiceSpeaker['drain']>, signal: AbortSignal): Promise<void> {
    for (let i = 0; run === this.run; i++) {
      const item = this.queue.shift();
      if (!item) break;
      if (this.engine !== 'device') {
        this.fetch(item, this.queue[0], signal);
        try {
          const bytes = await item.audio!;
          if (run !== this.run) return;
          // The next piece's audio comes while this one plays.
          const next = this.queue[0];
          if (next) this.fetch(next, this.queue[1], signal);
          await this.playBytes(bytes, run);
          continue;
        } catch (err) {
          if (run !== this.run || signal.aborted) return;
          const why = err instanceof Error ? err.message : String(err);
          log.warn('voice', 'server voice failed: the device speaks instead', { error: why, piece: i });
          if (!(err instanceof SpeakError) || err.fallback) {
            this.engine = 'device';
            this.onEngineChange?.('device', why);
          }
        }
      }
      await this.sayOnDevice(item.text, item.language, run);
    }
    if (run !== this.run || this.drain !== drain) return;
    this.drain = null;
    this.abort = null;
    drain.resolve('done');
  }

  stop(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    this.queue = [];
    this.lastText = undefined;
    this.cue.stop();
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.deviceSpeaking = false;
    this.wake?.();
    this.wake = null;
    const drain = this.drain;
    this.drain = null;
    drain?.resolve('stopped');
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
      const watchdog = setTimeout(done, estimatedSeconds(text) * 1600 + 2000);
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
