/**
 * Voice conversation: the state machine, pure.
 *
 *   listening ──(speech, then a pause)──▶ transcribing ──(words)──▶ waiting
 *       ▲  ▲                                   │ (no words)            │ (the turn's answer)
 *       │  └───────────────────────────────────┘                       ▼
 *       └──────(done speaking, or the person talks over it)──── speaking
 *   paused: the mic is off (a tap, nothing said for a while, an error); a tap listens again.
 *   An answer that ends while paused is kept for Replay, never read on its own: paused stays paused.
 *
 * The answer is read as it streams: each `piece` (a few sentences of a turn still
 * running) starts the voice or joins what it says, and when the voice runs out
 * while the turn still works it goes back to `waiting` (the waiting cue plays), not
 * to listening. The turn's end (`reply` with `streamed`) adds the last line, if any,
 * and the voice then listens once it is done. Talking over it mutes the rest of
 * that turn (`mute-turn`).
 *
 * The reducer returns the next state and the effects to run (open a take, send,
 * speak, stop speaking); useVoiceConversation runs them. Keeping the decisions
 * here, with no timers or browser calls, is what lets tests walk every path.
 */

export type VoicePhase = 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'paused';

export interface VoiceState {
  phase: VoicePhase;
  /** In `listening`: speech was heard in this take. */
  heard: boolean;
  /** What the person said last (shown under the orb). */
  lastHeard: string | null;
  /** What is being or was last said aloud. */
  lastSpoken: string | null;
  /** One sentence when something went wrong; cleared by the next take. */
  error: string | null;
  /** Bumps on every new take, so a late transcription of an old take is dropped. */
  take: number;
  /** An answer that came while another was read or the person talked: read once it is quiet again. */
  pending?: string | null;
  /** A turn of the session is running (set by a send or a piece, cleared by its reply). */
  turn?: boolean;
  /** A piece of the running turn was said: `lastSpoken` holds that turn so far. */
  streamed?: boolean;
  /** The person asked to talk (talked over the voice, or tapped while it worked): nothing
   *  starts speaking into this take; an answer waits as `pending`. */
  listenFirst?: boolean;
}

export type VoiceEffect =
  | { type: 'start-take'; take: number }
  | { type: 'finish-take'; take: number }
  | { type: 'discard-take' }
  | { type: 'send'; text: string }
  | { type: 'speak'; text: string }
  /** Say a piece after what is being said (or now, when nothing is). */
  | { type: 'enqueue'; text: string }
  | { type: 'stop-speaking' }
  /** Nothing more of the running turn is read (the person talked over it or stopped it). */
  | { type: 'mute-turn' };

export type VoiceEvent =
  /** Voice activity began in the current take. */
  | { type: 'speech-start' }
  /** A pause long enough after speech: the take is done. */
  | { type: 'end-of-speech' }
  | { type: 'transcribed'; take: number; text: string }
  | { type: 'transcribe-failed'; take: number; error: string }
  | { type: 'send-failed'; error: string }
  /**
   * The session's turn ended; `spoken` is what to say (null: nothing speakable).
   * `streamed`: the answer was already said as it streamed, and `spoken` is only a
   * last line to add after it (the rest-on-screen line). `continues`: this ended an
   * older turn, and the turn of a message sent meanwhile still runs.
   */
  | { type: 'reply'; spoken: string | null; streamed?: boolean; continues?: boolean }
  /** Part of the answer of a turn still running, as it streams. */
  | { type: 'piece'; spoken: string }
  /** The person stopped the session's turn from the bar: nothing more of it is read. */
  | { type: 'run-stopped' }
  /** Read the last answer again (the Replay button). */
  | { type: 'replay'; spoken: string }
  /** The person talked while the answer was being read. */
  | { type: 'barge-in' }
  | { type: 'speech-done' }
  | { type: 'speak-failed'; error: string }
  /** The mic did not open again (after a pause). */
  | { type: 'mic-failed'; error: string }
  /** The big button. */
  | { type: 'tap' }
  /** Listening with nothing heard for a long while: stop listening. */
  | { type: 'idle-timeout' };

export interface Step {
  state: VoiceState;
  effects: VoiceEffect[];
}

/** The state voice mode opens in: listening, a take already started. */
export function openVoice(): Step {
  const state: VoiceState = { phase: 'listening', heard: false, lastHeard: null, lastSpoken: null, error: null, take: 1 };
  return { state, effects: [{ type: 'start-take', take: 1 }] };
}

function speak(state: VoiceState, spoken: string): Step {
  const effects: VoiceEffect[] = state.phase === 'listening' ? [{ type: 'discard-take' }] : [];
  effects.push({ type: 'speak', text: spoken });
  return { state: { ...state, phase: 'speaking', heard: false, lastSpoken: spoken, error: null, pending: null, streamed: false }, effects };
}

function listen(state: VoiceState, extra: VoiceEffect[] = [], patch: Partial<VoiceState> = {}): Step {
  const take = state.take + 1;
  return {
    state: { ...state, listenFirst: false, ...patch, phase: 'listening', heard: false, take },
    effects: [...extra, { type: 'start-take', take }],
  };
}

const same = (state: VoiceState): Step => ({ state, effects: [] });

/** Two spoken parts as one: Chinese and Japanese run on with no space. */
export function joinSpoken(before: string, text: string): string {
  return /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]$/.test(before) ? before + text : `${before} ${text}`;
}

/** What was said this turn, with `text` added. */
function said(state: VoiceState, text: string): string {
  const before = state.streamed ? state.lastSpoken : null;
  return before ? joinSpoken(before, text) : text;
}

/** Start saying `text` after what is queued, or now. */
function enqueue(state: VoiceState, text: string, patch: Partial<VoiceState> = {}): Step {
  const effects: VoiceEffect[] = state.phase === 'listening' ? [{ type: 'discard-take' }] : [];
  effects.push({ type: 'enqueue', text });
  return { state: { ...state, phase: 'speaking', heard: false, lastSpoken: said(state, text), streamed: true, error: null, ...patch }, effects };
}

/** The voice stops and listens; a running turn is muted so none of it is read afterwards. */
function interrupt(state: VoiceState): Step {
  return listen(state, state.turn ? [{ type: 'stop-speaking' }, { type: 'mute-turn' }] : [{ type: 'stop-speaking' }], { listenFirst: true });
}

/** Listening with nothing heard, and not because the person asked to talk: an answer may start. */
const quietListening = (state: VoiceState) => state.phase === 'listening' && !state.heard && !state.listenFirst;

/** The turn ended with its answer already said as it streamed; `line` is added after it. */
function streamedReply(state: VoiceState, line: string | null, continues: boolean): Step {
  const ended: VoiceState = { ...state, turn: continues };
  switch (state.phase) {
    case 'paused':
      return same(line ? { ...ended, lastSpoken: said(state, line), streamed: false } : { ...ended, streamed: false });
    case 'speaking':
      return line ? { state: { ...ended, lastSpoken: said(state, line), streamed: false }, effects: [{ type: 'enqueue', text: line }] } : same({ ...ended, streamed: false });
    case 'waiting':
      if (line) return enqueue(ended, line, { streamed: false });
      return continues ? same({ ...ended, streamed: false }) : listen({ ...ended, streamed: false });
    default:
      // The person is talking, or listening after talking over it: the last line is not worth cutting in.
      return same({ ...ended, streamed: false });
  }
}

export function reduceVoice(state: VoiceState, event: VoiceEvent): Step {
  switch (event.type) {
    case 'speech-start':
      if (state.phase === 'listening' && !state.heard) return { state: { ...state, heard: true, error: null }, effects: [] };
      return same(state);

    case 'end-of-speech':
      if (state.phase === 'listening' && state.heard) {
        return { state: { ...state, phase: 'transcribing' }, effects: [{ type: 'finish-take', take: state.take }] };
      }
      return same(state);

    case 'transcribed': {
      if (state.phase !== 'transcribing' || event.take !== state.take) return same(state);
      const text = event.text.trim();
      // Noise, a cough: nothing to send; an answer that came meanwhile is read, else keep listening.
      if (!text) return state.pending ? speak(state, state.pending) : listen(state);
      // They said something new: an answer that came while they talked is stale now.
      return { state: { ...state, phase: 'waiting', lastHeard: text, error: null, pending: null, turn: true, streamed: false, listenFirst: false }, effects: [{ type: 'send', text }] };
    }

    case 'transcribe-failed':
      if (state.phase !== 'transcribing' || event.take !== state.take) return same(state);
      return { state: { ...state, phase: 'paused', error: event.error }, effects: [] };

    case 'send-failed':
      if (state.phase !== 'waiting') return same(state);
      return { state: { ...state, phase: 'paused', error: event.error }, effects: [] };

    case 'reply': {
      const continues = !!event.continues;
      if (event.streamed) return streamedReply(state, event.spoken, continues);
      state = { ...state, turn: continues, streamed: false };
      // Paused means the mic and the voice are off until a tap: keep it for Replay only.
      if (state.phase === 'paused') return event.spoken ? same({ ...state, lastSpoken: event.spoken }) : same(state);
      // An answer arrives for a turn we were waiting on, or one the session started
      // itself while the person was quiet; never over what they are saying.
      const quiet = state.phase === 'waiting' || quietListening(state);
      if (!quiet) return event.spoken ? same({ ...state, pending: event.spoken }) : same(state);
      if (!event.spoken) return state.phase === 'waiting' && !continues ? listen(state) : same(state);
      return speak(state, event.spoken);
    }

    case 'piece': {
      const running: VoiceState = { ...state, turn: true };
      switch (state.phase) {
        // Kept for Replay, never read on its own.
        case 'paused':
          return same({ ...running, lastSpoken: said(state, event.spoken), streamed: true });
        case 'speaking':
          return { state: { ...running, lastSpoken: said(state, event.spoken), streamed: true }, effects: [{ type: 'enqueue', text: event.spoken }] };
        case 'waiting':
          return enqueue(running, event.spoken);
        case 'listening':
          // A turn the session runs while the person is quiet is read; never over their words,
          // nor into a take they asked for.
          return quietListening(state) ? enqueue(running, event.spoken, { pending: null }) : same(running);
        case 'transcribing':
          return same(running);
      }
      return same(running);
    }

    case 'run-stopped':
      if (state.phase === 'speaking' && state.turn) {
        const step = interrupt(state);
        return { ...step, state: { ...step.state, turn: false, streamed: false } };
      }
      if (state.phase === 'waiting') return listen({ ...state, turn: false, streamed: false });
      return same({ ...state, turn: false, streamed: false });

    case 'replay': {
      const idle = state.phase === 'waiting' || state.phase === 'paused' || (state.phase === 'listening' && !state.heard);
      return idle ? speak(state, event.spoken) : same(state);
    }

    case 'barge-in':
      if (state.phase !== 'speaking') return same(state);
      return interrupt(state);

    case 'speech-done':
      if (state.phase !== 'speaking') return same(state);
      // An answer that came meanwhile is read next.
      if (state.pending) return speak(state, state.pending);
      // The turn still works: wait for the rest of its answer.
      return state.turn ? { state: { ...state, phase: 'waiting' }, effects: [] } : listen(state);

    case 'speak-failed':
      if (state.phase !== 'speaking') return same(state);
      return listen(state, [], { error: event.error });

    case 'mic-failed':
      return { state: { ...state, phase: 'paused', heard: false, error: event.error }, effects: [] };

    case 'idle-timeout':
      if (state.phase === 'listening' && !state.heard) return { state: { ...state, phase: 'paused' }, effects: [{ type: 'discard-take' }] };
      return same(state);

    case 'tap':
      switch (state.phase) {
        // Done talking before the pause came: send now. Nothing said: stop listening.
        case 'listening':
          return state.heard
            ? { state: { ...state, phase: 'transcribing' }, effects: [{ type: 'finish-take', take: state.take }] }
            : { state: { ...state, phase: 'paused' }, effects: [{ type: 'discard-take' }] };
        case 'transcribing':
          return same(state);
        // Say more while it works (the message queues behind the running turn).
        case 'waiting':
          return listen(state, [], { error: null, listenFirst: true });
        // Stop the voice and talk.
        case 'speaking':
          return interrupt(state);
        case 'paused':
          return listen(state, [], { error: null });
      }
  }
}
