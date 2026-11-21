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
}

export type VoiceEffect =
  | { type: 'start-take'; take: number }
  | { type: 'finish-take'; take: number }
  | { type: 'discard-take' }
  | { type: 'send'; text: string }
  | { type: 'speak'; text: string }
  | { type: 'stop-speaking' };

export type VoiceEvent =
  /** Voice activity began in the current take. */
  | { type: 'speech-start' }
  /** A pause long enough after speech: the take is done. */
  | { type: 'end-of-speech' }
  | { type: 'transcribed'; take: number; text: string }
  | { type: 'transcribe-failed'; take: number; error: string }
  | { type: 'send-failed'; error: string }
  /** The session's turn ended; `spoken` is what to say (null: nothing speakable, or the turn was stopped). */
  | { type: 'reply'; spoken: string | null }
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
  return { state: { ...state, phase: 'speaking', heard: false, lastSpoken: spoken, error: null }, effects };
}

function listen(state: VoiceState, extra: VoiceEffect[] = [], patch: Partial<VoiceState> = {}): Step {
  const take = state.take + 1;
  return {
    state: { ...state, ...patch, phase: 'listening', heard: false, take },
    effects: [...extra, { type: 'start-take', take }],
  };
}

const same = (state: VoiceState): Step => ({ state, effects: [] });

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
      // Noise, a cough: nothing to send, keep listening.
      if (!text) return listen(state);
      return { state: { ...state, phase: 'waiting', lastHeard: text, error: null }, effects: [{ type: 'send', text }] };
    }

    case 'transcribe-failed':
      if (state.phase !== 'transcribing' || event.take !== state.take) return same(state);
      return { state: { ...state, phase: 'paused', error: event.error }, effects: [] };

    case 'send-failed':
      if (state.phase !== 'waiting') return same(state);
      return { state: { ...state, phase: 'paused', error: event.error }, effects: [] };

    case 'reply': {
      // Paused means the mic and the voice are off until a tap: keep it for Replay only.
      if (state.phase === 'paused') return event.spoken ? same({ ...state, lastSpoken: event.spoken }) : same(state);
      // An answer arrives for a turn we were waiting on, or one the session started
      // itself while the person was quiet; never over what they are saying.
      const quiet = state.phase === 'waiting' || (state.phase === 'listening' && !state.heard);
      if (!quiet) return same(state);
      if (!event.spoken) return state.phase === 'waiting' ? listen(state) : same(state);
      return speak(state, event.spoken);
    }

    case 'replay': {
      const idle = state.phase === 'waiting' || state.phase === 'paused' || (state.phase === 'listening' && !state.heard);
      return idle ? speak(state, event.spoken) : same(state);
    }

    case 'barge-in':
      if (state.phase !== 'speaking') return same(state);
      return listen(state, [{ type: 'stop-speaking' }]);

    case 'speech-done':
      if (state.phase !== 'speaking') return same(state);
      return listen(state);

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
          return listen(state, [], { error: null });
        // Stop the voice and talk.
        case 'speaking':
          return listen(state, [{ type: 'stop-speaking' }]);
        case 'paused':
          return listen(state, [], { error: null });
      }
  }
}
