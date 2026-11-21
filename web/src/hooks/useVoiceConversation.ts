/**
 * Voice conversation with one session: talk, a pause sends it, the answer is
 * read aloud, talking again stops it (the experimental `voice_conversation` flag).
 *
 * The decisions live in voice/conversation-machine.ts; this hook owns the
 * browser parts and runs the machine's effects: the mic and its voice activity
 * (voice/voice-mic.ts, voice/voice-activity.ts), the final transcription through
 * the same route dictation uses (/api/stt/transcribe), the send (with the
 * `voice-reply` hint, so the session answers with a short spoken part first), and
 * the speaker (voice/voice-speaker.ts, which asks /api/v1/voice for the words and
 * the speech).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../api/stt';
import { spokenReply, voiceStatus, type SpokenReply, type TtsEngineId } from '../api/voice';
import { openVoice, reduceVoice, type VoiceEffect, type VoiceEvent, type VoiceState } from '../voice/conversation-machine';
import { BARGE_IN_OPTIONS, LISTEN_OPTIONS, VoiceActivity } from '../voice/voice-activity';
import { VoiceMic } from '../voice/voice-mic';
import { VoiceSpeaker } from '../voice/voice-speaker';
import { log } from '../utils/log';
import { useEvent } from './useWebSocket';

/** How often the mic's loudness is read. setInterval, not rAF: rAF stops in a background tab. */
const SAMPLE_MS = 50;
/** Listening with nothing said this long: the mic turns off (tap to talk again). */
const IDLE_MS = 60_000;

export interface VoiceConversation {
  /** Shown: opening the mic, or running. */
  open: boolean;
  state: VoiceState | null;
  /** Mic loudness 0..1, for the orb's ring. */
  level: number;
  /** The voice answers are read with. */
  engine: TtsEngineId | null;
  /** One line when the voice changed on its own (the server voice failed). */
  engineNote: string | null;
  /** The mic could not open (permission, no device). */
  micError: string | null;
  /** The open mic delivers no sound, or its device went away (mic-health.ts). */
  micWarning: string | null;
  start: () => void;
  stop: () => void;
  tap: () => void;
  /** Read the last answer again. */
  replay: () => void;
}

interface SessionResultLike {
  sessionId?: string;
  result?: string;
  isError?: boolean;
  interrupted?: boolean;
}

export function useVoiceConversation(
  sessionId: string,
  send: (text: string) => Promise<boolean>,
): VoiceConversation {
  const [state, setState] = useState<VoiceState | null>(null);
  const [level, setLevel] = useState(0);
  const [engine, setEngine] = useState<TtsEngineId | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const stateRef = useRef<VoiceState | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<VoiceMic | null>(null);
  const speakerRef = useRef<VoiceSpeaker | null>(null);
  const activityRef = useRef(new VoiceActivity(LISTEN_OPTIONS));
  const lastReplyRef = useRef<SpokenReply | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const listenSinceRef = useRef(0);
  const sessionRef = useRef(sessionId);
  /** Bumps on every open and close: anything an older conversation started finds it changed and drops its result. */
  const genRef = useRef(0);
  /** The mic is off while paused, so the browser's recording mark goes out too; a tap opens it again. */
  const micOpeningRef = useRef<Promise<VoiceMic | null> | null>(null);

  // One place every event goes through: reduce, keep, run the effects.
  const dispatch = useCallback((event: VoiceEvent) => {
    const current = stateRef.current;
    if (!current) return;
    const step = reduceVoice(current, event);
    stateRef.current = step.state;
    setState(step.state);
    if (step.state.phase !== current.phase) log.info('voice', `${current.phase} -> ${step.state.phase}`, { sessionId: sessionRef.current, event: event.type });
    if (step.state.phase === 'paused' && current.phase !== 'paused') closeMic();
    for (const effect of step.effects) runEffect(effect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeMic = () => {
    micRef.current?.close();
    micRef.current = null;
    setLevel(0);
  };

  /** The mic of the conversation `gen`, opened again after a pause; null when that conversation ended. */
  const reopenMic = (gen: number): Promise<VoiceMic | null> => {
    const ctx = ctxRef.current;
    if (!ctx) return Promise.resolve(null);
    micOpeningRef.current ??= VoiceMic.open(ctx).then((mic) => {
      micOpeningRef.current = null;
      if (genRef.current !== gen) { mic.close(); return null; }
      micRef.current = mic;
      return mic;
    }, (err) => {
      micOpeningRef.current = null;
      if (genRef.current === gen) dispatch({ type: 'mic-failed', error: `The microphone did not open: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    });
    return micOpeningRef.current;
  };

  const runEffect = (effect: VoiceEffect) => {
    const mic = micRef.current;
    const gen = genRef.current;
    switch (effect.type) {
      case 'start-take':
        activityRef.current.reset(LISTEN_OPTIONS);
        listenSinceRef.current = performance.now();
        if (mic) mic.startTake();
        else void reopenMic(gen).then((m) => {
          // Still this take: a tap or a pause in between started another one or none.
          if (m && genRef.current === gen && stateRef.current?.phase === 'listening' && stateRef.current.take === effect.take) {
            listenSinceRef.current = performance.now();
            m.startTake();
          }
        });
        return;
      case 'discard-take':
        mic?.discardTake();
        return;
      case 'finish-take': {
        const take = effect.take;
        void (async () => {
          try {
            const clip = await mic?.finishTake();
            if (genRef.current !== gen) return;
            if (!clip) { dispatch({ type: 'transcribed', take, text: '' }); return; }
            const result = await transcribeAudio(clip.blob, clip.format, undefined, undefined, { surface: 'voice-conversation' });
            if (genRef.current !== gen) return;
            dispatch({ type: 'transcribed', take, text: result.text ?? '' });
          } catch (err) {
            if (genRef.current !== gen) return;
            dispatch({ type: 'transcribe-failed', take, error: `Could not hear that: ${err instanceof Error ? err.message : String(err)}` });
          }
        })();
        return;
      }
      case 'send':
        void sendRef.current(effect.text).then((ok) => {
          if (!ok && genRef.current === gen) dispatch({ type: 'send-failed', error: 'The message did not go out. Tap and say it again.' });
        }, (err) => { if (genRef.current === gen) dispatch({ type: 'send-failed', error: err instanceof Error ? err.message : String(err) }); });
        return;
      case 'speak': {
        const reply = lastReplyRef.current;
        const speaker = speakerRef.current;
        if (!reply || !speaker) { dispatch({ type: 'speech-done' }); return; }
        activityRef.current.reset(BARGE_IN_OPTIONS);
        void speaker.say(reply).then(
          (outcome) => { if (outcome === 'done' && genRef.current === gen) dispatch({ type: 'speech-done' }); },
          (err) => { if (genRef.current === gen) dispatch({ type: 'speak-failed', error: `Could not read the answer: ${err instanceof Error ? err.message : String(err)}` }); },
        );
        return;
      }
      case 'stop-speaking':
        speakerRef.current?.stop();
        return;
    }
  };

  const stop = useCallback(() => {
    genRef.current++;
    speakerRef.current?.stop();
    speakerRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    micOpeningRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    stateRef.current = null;
    setState(null);
    setOpening(false);
    setLevel(0);
    setMicWarning(null);
  }, []);

  const start = useCallback(() => {
    if (stateRef.current || ctxRef.current) return;
    const gen = ++genRef.current;
    setOpening(true);
    setMicError(null);
    setEngineNote(null);
    // Made inside the click, so the browser lets it play the answers.
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    // Each await may outlive this open (Keyboard, then Talk again while the browser
    // asks for the mic): nothing is kept, and nothing is closed, unless it is still this one.
    const current = () => genRef.current === gen && ctxRef.current === ctx;
    void (async () => {
      let tts: TtsEngineId = 'device';
      try { tts = (await voiceStatus()).engine; } catch { /* the device's own voice */ }
      if (!current()) return;
      setEngine(tts);
      const speaker = new VoiceSpeaker(ctx, tts, (next, why) => {
        if (genRef.current !== gen) return;
        setEngine(next);
        setEngineNote(`Using this device's voice: ${why}`);
      });
      let mic: VoiceMic;
      try {
        mic = await VoiceMic.open(ctx);
      } catch (err) {
        if (!current()) return;
        setMicError(err instanceof Error && err.name === 'NotAllowedError'
          ? 'Walnut may not use the microphone. Allow it in the browser, then try again.'
          : `The microphone did not open: ${err instanceof Error ? err.message : String(err)}`);
        stop();
        return;
      }
      if (!current()) { mic.close(); return; }
      speakerRef.current = speaker;
      micRef.current = mic;
      const step = openVoice();
      stateRef.current = step.state;
      setState(step.state);
      setOpening(false);
      log.info('voice', 'voice conversation opened', { sessionId: sessionRef.current, engine: tts });
      for (const effect of step.effects) runEffect(effect);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  const tap = useCallback(() => dispatch({ type: 'tap' }), [dispatch]);

  const replay = useCallback(() => {
    if (lastReplyRef.current) dispatch({ type: 'replay', spoken: lastReplyRef.current.text });
  }, [dispatch]);

  // The mic's loudness drives voice activity while listening and barge-in while speaking.
  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => {
      const mic = micRef.current;
      const s = stateRef.current;
      if (!mic || !s) return;
      const { rms, warning } = mic.sample();
      setMicWarning((prev) => (prev === warning ? prev : warning));
      setLevel((prev) => prev * 0.6 + Math.min(1, rms * 4) * 0.4);
      const now = performance.now();
      if (s.phase === 'listening') {
        const ev = activityRef.current.push(rms, now);
        if (ev === 'speech-start') dispatch({ type: 'speech-start' });
        else if (ev === 'end-of-speech') dispatch({ type: 'end-of-speech' });
        else if (!s.heard && now - listenSinceRef.current > IDLE_MS) dispatch({ type: 'idle-timeout' });
      } else if (s.phase === 'speaking') {
        const echo = speakerRef.current ? speakerRef.current.outputLevel() : 0;
        if (activityRef.current.push(rms, now, echo) === 'speech-start') dispatch({ type: 'barge-in' });
      }
    }, SAMPLE_MS);
    return () => clearInterval(timer);
    // Runs while the conversation is open; the phase is read from the ref.
  }, [state !== null, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  // The session's answer: what to say comes from the server (the same words on every client).
  useEvent('session:result', (data) => {
    const ev = data as SessionResultLike;
    if (!stateRef.current || ev.sessionId !== sessionRef.current) return;
    // A stopped turn has nothing to say: back to listening (a later turn's answer is still read).
    if (ev.interrupted) { dispatch({ type: 'reply', spoken: null }); return; }
    const text = ev.isError ? 'Something went wrong. The details are on screen.' : (ev.result ?? '');
    const gen = genRef.current;
    void spokenReply(text).then((reply) => {
      if (genRef.current !== gen) return;
      if (reply) lastReplyRef.current = reply;
      dispatch({ type: 'reply', spoken: reply?.text ?? null });
    }, (err) => {
      log.warn('voice', 'spoken text failed', { sessionId: sessionRef.current, error: err instanceof Error ? err.message : String(err) });
      dispatch({ type: 'reply', spoken: null });
    });
  });

  // Another session, or the page going away: the conversation ends.
  useEffect(() => {
    sessionRef.current = sessionId;
    return () => stop();
  }, [sessionId, stop]);

  return { open: state !== null || opening, state, level, engine, engineNote, micError, micWarning, start, stop, tap, replay };
}
