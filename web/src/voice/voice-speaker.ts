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
 *
 * A piece the local voice streams (a PcmFeed, `audio/L16`) plays as it arrives:
 * each run of samples becomes a buffer scheduled right after the one before, so
 * the first sound comes as soon as the first chunk is made; the piece is done
 * when the stream ended and its last buffer finished.
 */

import { speakPiece, SpeakError, type SpokenReply, type TtsEngineId } from '../api/voice';
import { log } from '../utils/log';
import { analyserRms } from './voice-mic';
import { estimatedSeconds } from './stream-reader';
import { WaitingCue } from './waiting-cue';
import { PcmFeed } from './pcm-feed';

export type SpeakOutcome = 'done' | 'stopped';

/**
 * A language's own voice that cannot read a piece now (`tts_unavailable`: the
 * local voice loading, or too slow once) has that piece said on the device and
 * is asked again for the next; this many such misses in a row, or any other
 * failure, and the language is said on the device for the rest of the conversation.
 */
const OWN_VOICE_MAX_MISSES = 3;
/**
 * How far ahead of now the first buffer of a streamed piece (or one after a gap)
 * is scheduled: room for the next chunk to come before this one runs out. A
 * buffer that came after the one before had ended (an underrun) doubles it, up
 * to STREAM_MAX_LEAD_S, for the rest of the conversation.
 */
const STREAM_LEAD_S = 0.2;
const STREAM_MAX_LEAD_S = 1.0;

interface Queued {
  text: string;
  language: string;
  /** The piece said before it, for a voice that keeps its tone across pieces. */
  previous?: string;
  audio?: Promise<ArrayBuffer | PcmFeed>;
}

export class VoiceSpeaker {
  private run = 0;
  private abort: AbortController | null = null;
  /** Every buffer playing or scheduled (one for a whole piece, a run of them for a stream). */
  private sources = new Set<AudioBufferSourceNode>();
  /** The streamed piece being played, so stop() ends its reading too. */
  private feed: PcmFeed | null = null;
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
  /** A language another server voice reads (`zh: 'qwen'`, the local Chinese voice), while it works. */
  private byLanguage: Record<string, TtsEngineId>;
  /** Misses in a row of each language's own voice (see OWN_VOICE_MAX_MISSES). */
  private ownMisses = new Map<string, number>();
  /** The lead a streamed piece starts with now (see STREAM_LEAD_S). */
  private streamLead = STREAM_LEAD_S;
  /**
   * The next piece may be fetched: the current one's audio is here and, when it
   * streams, its stream has ended. The local voice makes one piece at a time and
   * faster than it plays, so a fetch started earlier only waits in its line.
   */
  private prefetchOpen = true;

  constructor(
    private readonly ctx: AudioContext,
    engine: TtsEngineId,
    private readonly onEngineChange?: (engine: TtsEngineId, why: string) => void,
    byLanguage: Record<string, TtsEngineId> = {},
  ) {
    this.engine = engine;
    this.byLanguage = { ...byLanguage };
    this.out = ctx.createAnalyser();
    this.out.fftSize = 2048;
    this.out.connect(ctx.destination);
    this.outBuf = new Float32Array(new ArrayBuffer(this.out.fftSize * 4));
    this.cue = new WaitingCue(ctx, this.out);
  }

  /** The output's loudness now: 0 when silent, null while the device's voice speaks (not measurable). */
  outputLevel(): number | null {
    if (this.deviceSpeaking) return null;
    if (!this.sources.size && !this.cue.playing) return 0;
    return analyserRms(this.out, this.outBuf);
  }

  get currentEngine(): TtsEngineId {
    return this.engine;
  }

  /** The language key `byLanguage` is read with ('zh' for 'zh-CN'). */
  private static lang(language: string): string {
    return language.toLowerCase().split('-')[0] ?? '';
  }

  /** The server reads this piece: the conversation's server voice, or a voice of its own language. */
  private served(item: Queued): boolean {
    if (this.engine !== 'device') return true;
    const own = this.byLanguage[VoiceSpeaker.lang(item.language)];
    return !!own && own !== 'device';
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
      // One is playing or on its way: the next piece's audio starts as soon as it may, so it adds no silence.
      if (this.abort) this.prefetch(this.abort.signal);
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

  /** Starts the next piece's audio, once the current one allows it (prefetchOpen). */
  private prefetch(signal: AbortSignal): void {
    const next = this.queue[0];
    if (this.prefetchOpen && next && !signal.aborted) this.fetch(next, this.queue[1], signal);
  }

  /** Starts the audio of a queued piece, once (the server voice only). */
  private fetch(item: Queued, next: Queued | undefined, signal: AbortSignal): void {
    if (!this.served(item) || item.audio) return;
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
      this.prefetchOpen = !this.served(item);
      if (this.served(item)) {
        const ownVoice = this.engine === 'device';
        this.fetch(item, this.queue[0], signal);
        try {
          const audio = await item.audio!;
          if (run !== this.run) return;
          // The next piece's audio comes while this one plays: after its stream ended, for a streamed one.
          if (audio instanceof PcmFeed) {
            void audio.done.then(() => {
              if (run !== this.run) return;
              this.prefetchOpen = true;
              this.prefetch(signal);
            });
          } else {
            this.prefetchOpen = true;
            this.prefetch(signal);
          }
          if (ownVoice) this.ownMisses.delete(VoiceSpeaker.lang(item.language));
          if (audio instanceof PcmFeed) await this.playFeed(audio, run, i);
          else await this.playBytes(audio, run);
          continue;
        } catch (err) {
          if (run !== this.run || signal.aborted) return;
          this.prefetchOpen = true;
          const why = err instanceof Error ? err.message : String(err);
          log.warn('voice', 'server voice failed: the device speaks instead', { error: why, piece: i });
          if (ownVoice) this.ownVoiceMissed(VoiceSpeaker.lang(item.language), err);
          else if (!(err instanceof SpeakError) || err.fallback) {
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

  /** The language's own voice could not read a piece: kept after a passing miss, dropped otherwise. */
  private ownVoiceMissed(lang: string, err: unknown): void {
    const misses = (this.ownMisses.get(lang) ?? 0) + 1;
    if (err instanceof SpeakError && err.code === 'tts_unavailable' && misses < OWN_VOICE_MAX_MISSES) {
      this.ownMisses.set(lang, misses);
      return;
    }
    log.warn('voice', 'the language\'s own voice keeps failing: the device says it from now on', { language: lang, misses });
    delete this.byLanguage[lang];
    this.ownMisses.delete(lang);
  }

  stop(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    this.queue = [];
    this.lastText = undefined;
    this.prefetchOpen = true;
    this.cue.stop();
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.feed?.cancel();
    this.feed = null;
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
    this.sources.add(source);
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(watchdog); if (this.wake === done) this.wake = null; resolve(); };
      const watchdog = setTimeout(done, buffer.duration * 1000 + 1500);
      this.wake = done;
      source.onended = done;
      source.start();
    });
    this.sources.delete(source);
  }

  /** A streamed piece: each run of samples scheduled back to back as it arrives, through `out`. */
  private async playFeed(feed: PcmFeed, run: number, piece: number): Promise<void> {
    this.feed = feed;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    let at = 0;
    let last: AudioBufferSourceNode | null = null;
    for await (const samples of feed.samples()) {
      if (run !== this.run) return;
      const buffer = this.ctx.createBuffer(samples.length, samples[0]!.length, feed.format.rate);
      samples.forEach((channel, c) => buffer.getChannelData(c).set(channel));
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.out);
      source.onended = () => { this.sources.delete(source); };
      this.sources.add(source);
      // Right after the buffer before it; after a gap (the stream fell behind), a moment from now,
      // and a longer moment from then on.
      const now = this.ctx.currentTime;
      if (last && at < now) this.streamLead = Math.min(STREAM_MAX_LEAD_S, this.streamLead * 2);
      at = Math.max(now + this.streamLead, at);
      source.start(at);
      at += buffer.duration;
      last = source;
    }
    if (this.feed === feed) this.feed = null;
    if (run !== this.run) return;
    if (feed.failed) log.warn('voice', 'the streamed piece broke off part way: it ends there', { error: String(feed.failed), piece });
    const final = last;
    if (!final || !this.sources.has(final)) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(watchdog); if (this.wake === done) this.wake = null; resolve(); };
      const watchdog = setTimeout(done, Math.max(0, at - this.ctx.currentTime) * 1000 + 1500);
      this.wake = done;
      final.onended = () => { this.sources.delete(final); done(); };
    });
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
