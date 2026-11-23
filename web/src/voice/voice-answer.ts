/**
 * The session's answer in voice mode, read as it streams.
 *
 * Fed the session's stream (text increments, tool calls, the turn's end), it keeps
 * one StreamReader per turn (stream-reader.ts picks the sentences that can be said
 * now), has the server clean each part (POST /api/v1/voice/spoken, `piece: true`),
 * strictly in order, and hands it to the conversation as a `piece`. At the turn's
 * end it adds the rest-on-screen line when the reader cut something, and falls back
 * to reading the whole result when none of it streamed (events missed, an error).
 *
 * No React here: useVoiceConversation makes one and forwards the events to it.
 */

import { spokenReply, type SpokenReply } from '../api/voice';
import { log } from '../utils/log';
import { joinSpoken, type VoiceEvent, type VoiceState } from './conversation-machine';
import { StreamReader } from './stream-reader';

export interface VoiceAnswerHost {
  sessionId(): string;
  state(): VoiceState | null;
  /** Bumps on every open and close of the conversation. */
  gen(): number;
  dispatch(event: VoiceEvent): void;
}

interface Turn {
  reader: StreamReader;
  /** What was said of it, in order (for Replay). */
  said: SpokenReply[];
  /** One voice for the whole turn, once its words show a clear language. */
  language: string | null;
}

interface StreamEvent {
  sessionId?: string;
  delta?: string;
  msgId?: string;
  parentToolUseId?: string;
  result?: string;
  isError?: boolean;
  interrupted?: boolean;
}

const ERROR_LINE = 'Something went wrong. The details are on screen.';
/** The words of the pieces said lately, by their text, for the speaker. */
const KEPT_WORDS = 64;
/** A result with the same words this soon after the last one, with no turn running: announced twice. */
const REPEAT_MS = 60_000;
/** The same, right after the next send and before any of its text: still the old one announced again. */
const ECHO_MS = 5_000;

const newTurn = (): Turn => ({ reader: new StreamReader(), said: [], language: null });

function joined(said: SpokenReply[]): SpokenReply | null {
  if (!said.length) return null;
  const text = said.map((r) => r.text).reduce(joinSpoken);
  return { text, language: said[0]!.language, truncated: said.some((r) => r.truncated), chunks: said.flatMap((r) => (r.chunks.length ? r.chunks : [r.text])) };
}

/**
 * The language words are said in, or null while too few to tell ("OK."). Unlike the
 * server's detection, one Chinese character is enough to rule out an English voice.
 */
export function clearLanguage(text: string): string | null {
  let cjk = 0, kana = 0, letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if (/\p{L}/u.test(ch)) letters++;
  }
  if (kana > 0 && kana * 5 >= cjk) return 'ja-JP';
  if (cjk > 0 && cjk / (cjk + letters) >= 0.15) return 'zh-CN';
  return letters >= 12 ? 'en-US' : null;
}

export class VoiceAnswer {
  private turn: Turn | null = null;
  /** A turn whose result is still being finished (its last pieces, its rest line): a barge-in mutes it too. */
  private ending: Turn | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly words = new Map<string, SpokenReply>();
  private lastReply: SpokenReply | null = null;
  /** The bar's Stop ended the turn: its interrupted result is never read. */
  private stopped = false;
  /** The last answer read, so a result announced twice is read once. */
  private lastResult: { text: string; at: number } | null = null;

  constructor(private readonly host: VoiceAnswerHost) {}

  /** A message went out: its turn is read as it streams (a muted turn reads what comes next). */
  sent(): void {
    this.stopped = false;
    if (this.turn) {
      this.turn.reader.markSend();
      this.turn.reader.resume();
    } else {
      this.turn = newTurn();
    }
  }

  /** Nothing more of the running turn is read, nor of one still finishing. */
  mute(): void {
    this.turn?.reader.mute();
    this.ending?.reader.mute();
  }

  /** The person stopped the turn from the bar. */
  runStopped(): void {
    this.stopped = true;
    this.mute();
  }

  /** The conversation closed: whatever is still on its way is dropped (the generation changed too). */
  reset(): void {
    this.turn = null;
    this.ending = null;
    this.chain = Promise.resolve();
  }

  /** The words to say for a `speak` or `enqueue` effect. */
  wordsFor(text: string): SpokenReply | null {
    return this.words.get(text) ?? this.last();
  }

  /** Everything said in the last turn, for Replay. */
  last(): SpokenReply | null {
    return (this.turn && joined(this.turn.said)) ?? this.lastReply;
  }

  onDelta(data: unknown): void {
    const ev = data as StreamEvent;
    if (!this.mine(ev) || ev.parentToolUseId || !ev.delta) return;
    if (!this.turn) {
      // The session started a turn itself: read it only while the person is quiet. Otherwise
      // its result is read whole when it ends, as before (held while they talk).
      const s = this.host.state()!;
      if (!(s.phase === 'waiting' || s.phase === 'speaking' || (s.phase === 'listening' && !s.heard && !s.listenFirst))) return;
      this.turn = newTurn();
    }
    this.release(this.turn, this.turn.reader.feed(ev.msgId, ev.delta));
  }

  onToolUse(data: unknown): void {
    const ev = data as StreamEvent;
    if (!this.mine(ev) || ev.parentToolUseId || !this.turn) return;
    this.release(this.turn, this.turn.reader.closeOpen());
  }

  onResult(data: unknown): void {
    const ev = data as StreamEvent;
    if (!this.mine(ev)) return;
    const text = ev.isError ? ERROR_LINE : (ev.result ?? '');
    const now = Date.now();
    // Announced twice: only a repeat of a turn already over, decided before anything changes.
    // With a turn running, the same words are that turn's answer and are read, unless they come
    // seconds after the last ones with none of the new turn's text yet (the old one announced again).
    const ago = this.lastResult?.text === text ? now - this.lastResult.at : Infinity;
    const over = !this.turn && !this.host.state()?.turn;
    if ((over && ago < REPEAT_MS) || (this.turn?.reader.empty && ago < ECHO_MS)) return;
    const turn = this.turn;
    // A turn the person stopped from the bar is not read, nor a stopped turn with no words.
    // Any other answer is, even marked interrupted: a message sent into a busy or restarting
    // session, or sent again after a stop, comes back so (2026-11-22, the Mac app: the answer
    // to a voice message was skipped that way and nothing was said).
    if (ev.interrupted && (this.stopped || !(ev.result ?? '').trim())) {
      this.stopped = false;
      this.turn = null;
      turn?.reader.mute();
      this.host.dispatch({ type: 'reply', spoken: null });
      return;
    }
    this.lastResult = { text, at: now };
    if (turn) this.release(turn, turn.reader.finish());
    const { outcome, index } = turn && !ev.isError ? turn.reader.match(text) : { outcome: 'unseen' as const, index: -1 };
    // A message sent while this turn ran gets a turn of its own when this result answers
    // something that began before it: this ends only the older turn.
    const continues = !!turn && outcome !== 'unseen' && turn.reader.sendMark >= 0 && index < turn.reader.sendMark;
    this.turn = continues ? newTurn() : null;
    this.ending = turn;
    const muteCount = turn?.reader.muteCount ?? 0;
    const muted = () => !!turn && turn.reader.muteCount !== muteCount;
    const gen = this.host.gen();
    const more = continues ? { continues: true } : {};
    this.then(async () => {
      try {
        if (gen !== this.host.gen()) return;
        if (turn && (outcome !== 'unseen' || turn.said.length)) {
          // Said as it streamed (or talked over): at most the rest-on-screen line is left. A result
          // that matches no streamed message (a missed increment, a turn picked up part way through) is never
          // read whole again after its pieces: only its rest line, when it has a cut.
          let line: SpokenReply | null = null;
          const source = outcome === 'read' ? (turn.reader.cut ? turn.reader.allText() : null) : outcome === 'unseen' ? text : null;
          const language = turn.language ?? clearLanguage(turn.said.map((r) => r.text).join(' ')) ?? turn.said[0]?.language;
          if (source !== null && !muted()) {
            try {
              const rest = (await spokenReply(source, language ? { language } : {}))?.rest;
              if (rest) line = { text: rest, language: language ?? 'en-US', truncated: false, chunks: [rest] };
            } catch (err) { this.warn('rest line failed', err); }
            if (gen !== this.host.gen()) return;
          }
          if (muted()) line = null;
          if (line) { turn.said.push(line); this.keep(line); }
          this.lastReply = joined(turn.said) ?? this.lastReply;
          this.host.dispatch({ type: 'reply', spoken: line?.text ?? null, streamed: true, ...more });
          return;
        }
        // Nothing of it streamed: the whole answer, as before.
        let reply: SpokenReply | null = null;
        try { reply = await spokenReply(text); } catch (err) { this.warn('spoken text failed', err); }
        if (gen !== this.host.gen()) return;
        if (reply) { this.lastReply = reply; this.keep(reply); }
        this.host.dispatch({ type: 'reply', spoken: reply?.text ?? null, ...more });
      } finally {
        if (this.ending === turn) this.ending = null;
      }
    });
  }

  private mine(ev: StreamEvent): boolean {
    return this.host.state() !== null && ev.sessionId === this.host.sessionId();
  }

  /** Cleans `segments` on the server and hands them on as one piece, after everything before. */
  private release(turn: Turn, segments: string[]): void {
    if (!segments.length) return;
    const text = segments.join('\n');
    const gen = this.host.gen();
    const muteCount = turn.reader.muteCount;
    const current = () => gen === this.host.gen() && turn.reader.muteCount === muteCount;
    this.then(async () => {
      if (!current()) return;
      let piece: SpokenReply | null = null;
      try { piece = await spokenReply(text, { piece: true }); } catch (err) { this.warn('spoken piece failed', err); }
      if (!piece || !current()) return;
      // The turn's voice is decided by the first words that show a language clearly ("OK." does
      // not); until then each piece is read in the language its own words lean to.
      turn.language ??= clearLanguage([...turn.said.map((r) => r.text), piece.text].join(' '));
      piece = { ...piece, language: turn.language ?? clearLanguage(piece.text) ?? piece.language };
      turn.said.push(piece);
      this.keep(piece);
      this.host.dispatch({ type: 'piece', spoken: piece.text });
    });
  }

  /** Runs `step` after every step before it (pieces are cleaned and said strictly in order). */
  private then(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch((err) => this.warn('voice answer step failed', err));
  }

  private keep(reply: SpokenReply): void {
    this.words.delete(reply.text);
    this.words.set(reply.text, reply);
    while (this.words.size > KEPT_WORDS) this.words.delete(this.words.keys().next().value!);
  }

  private warn(message: string, err: unknown): void {
    log.warn('voice', message, { sessionId: this.host.sessionId(), error: err instanceof Error ? err.message : String(err) });
  }
}
