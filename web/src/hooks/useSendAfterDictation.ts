/**
 * Send waits for the dictation (2026-11-01, the user: "currently send doesn't
 * wait the voice button I think it should wait, and send afterward").
 *
 * Pressing Send (the button or Enter) while the composer's mic is recording, or
 * its words are still being transcribed, stops the recording, waits for the
 * final words to land in the box, then sends the whole message once. While it
 * waits the send button says so (`dictationWaitProps`); a second press or Esc
 * cancels the wait and the words still land in the box, unsent. A recording
 * that ends on a transcription error sends nothing: the text stays and the
 * mic shows its error.
 *
 * Every composer with a mic routes its send through this hook; the guard test
 * `tests/web/send-waits-for-dictation-ratchet.test.ts` lists them.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { DictationOutcome } from '@/hooks/useSpeechToText';
import { log } from '@/utils/log';
import '@/styles/dictation-wait.css';

/** What a mic hands its composer: MicButton's controlRef, BoxMic's handle. */
export interface DictationControl {
  /** Recording, or its words still on their way. */
  busy: () => boolean;
  /** Stop recording (if it is) and resolve once the words are in the box. */
  finish: () => Promise<DictationOutcome>;
}

type ControlRef = RefObject<Partial<DictationControl> | null>;

// Mics tell composers when they start or stop being busy, so a Send button that
// is disabled on an empty box can light up while the first words are coming.
const activityListeners = new Set<() => void>();
export function notifyDictationActivity(): void {
  for (const listener of activityListeners) listener();
}

// The send waiting on each mic. One mic can feed several sends (Send and
// Interrupt & send, Send and Ask on phone): the last one pressed is the one that
// runs, so a press on another of them takes the wait over instead of adding a second send.
const waitOwners = new Map<DictationControl, () => void>();

export const DICTATION_WAIT_TITLE = 'Waiting for your words before sending. Press again or Esc to cancel';

export interface SendAfterDictation {
  /** Send now, or stop the dictation, wait for its words and send then. A press while waiting cancels. */
  send: () => void;
  /** Stop waiting; the words still land in the box. */
  cancel: () => void;
  /** A send is waiting on the dictation. */
  waiting: boolean;
  /** A mic of this composer is recording or transcribing (so Send should be pressable). */
  micBusy: boolean;
}

/**
 * `target`: what the composer is writing to (a draft key). A wait never carries
 * over to another target: switching cancels it, so the words land but nothing is sent.
 */
export function useSendAfterDictation(mics: ReadonlyArray<ControlRef>, send: () => void, target?: unknown): SendAfterDictation {
  const sendRef = useRef(send);
  sendRef.current = send;
  const micsRef = useRef(mics);
  micsRef.current = mics;
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const [micBusy, setMicBusy] = useState(false);
  // Each wait gets a number; a cancel or unmount moves it on, so a stale wait never sends.
  const seq = useRef(0);
  // The send runs from an effect after the render that holds the final words,
  // so it reads the composer's text as it is now, not as it was at the press.
  // `dueRef` is consumed once, so an effect that re-runs never sends again.
  const [due, setDue] = useState(0);
  const dueRef = useRef(false);
  // The mics this gate's wait holds in waitOwners.
  const claimed = useRef<DictationControl[]>([]);

  const busyControls = useCallback(() => micsRef.current
    .map((ref) => ref.current)
    .filter((c): c is DictationControl => !!c && typeof c.busy === 'function' && typeof c.finish === 'function' && c.busy()), []);

  useEffect(() => {
    const update = () => setMicBusy(busyControls().length > 0);
    activityListeners.add(update);
    update();
    return () => { activityListeners.delete(update); };
  }, [busyControls]);

  const release = useCallback(() => {
    for (const c of claimed.current) if (waitOwners.get(c) === cancelRef.current) waitOwners.delete(c);
    claimed.current = [];
  }, []);
  const setWait = useCallback((on: boolean) => {
    waitingRef.current = on;
    setWaiting(on);
    if (!on) release();
  }, [release]);

  const cancelRef = useRef<() => void>(() => {});
  const cancel = useCallback(() => {
    if (!waitingRef.current) return;
    seq.current += 1;
    setWait(false);
    log.info('stt', 'send after dictation cancelled; the words stay in the box');
  }, [setWait]);
  cancelRef.current = cancel;

  const run = useCallback(() => {
    if (waitingRef.current) { cancel(); return; }
    const busy = busyControls();
    if (busy.length === 0) { sendRef.current(); return; }
    const mine = ++seq.current;
    // Another send waiting on one of these mics gives way to this press.
    for (const c of busy) {
      const other = waitOwners.get(c);
      if (other && other !== cancelRef.current) other();
    }
    setWait(true);
    claimed.current = busy;
    for (const c of busy) waitOwners.set(c, cancelRef.current);
    const startedAt = performance.now();
    log.info('stt', `send waits for the dictation (${busy.length} mic${busy.length === 1 ? '' : 's'})`);
    void Promise.all(busy.map((c) => c.finish().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))))
      .then((outcomes) => {
        if (mine !== seq.current) return;
        setWait(false);
        const failed = outcomes.find((o) => o.error);
        const ms = Math.round(performance.now() - startedAt);
        if (failed) {
          log.warn('stt', `send after dictation held: the dictation ended on an error after ${ms}ms (${failed.error})`);
          return;
        }
        log.info('stt', `dictation finished after ${ms}ms; sending`);
        dueRef.current = true;
        setDue((n) => n + 1);
      });
  }, [busyControls, cancel, setWait]);

  useEffect(() => {
    if (!dueRef.current) return;
    dueRef.current = false;
    sendRef.current();
  }, [due]);

  // Esc cancels the wait, before the composer's own Esc handling sees it.
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [waiting, cancel]);

  useEffect(() => () => { seq.current += 1; dueRef.current = false; release(); }, [release]);

  const targetRef = useRef(target);
  useEffect(() => {
    if (Object.is(targetRef.current, target)) return;
    targetRef.current = target;
    dueRef.current = false;
    cancel();
  }, [target, cancel]);

  return { send: run, cancel, waiting, micBusy };
}

/**
 * A composer with one mic per row (a question each, an executor field each):
 * `micOf(key)` is the ref a row hands its mic, and `group` is all of them as the
 * one control a Send waits on (busy while any is; finished when every busy one is,
 * with the first error).
 */
export function useDictationGroup<T extends DictationControl = DictationControl>(): { micOf: (key: string) => RefObject<T | null>; group: RefObject<DictationControl> } {
  const refs = useRef(new Map<string, { current: T | null }>());
  const micOf = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) { ref = { current: null }; refs.current.set(key, ref); }
    return ref;
  }, []);
  const group = useRef<DictationControl>({
    busy: () => [...refs.current.values()].some((r) => r.current?.busy() ?? false),
    finish: async () => {
      const busy = [...refs.current.values()].map((r) => r.current).filter((c): c is T => !!c && c.busy());
      const outcomes = await Promise.all(busy.map((c) => c.finish()));
      return outcomes.find((o) => o.error) ?? { error: null };
    },
  });
  return { micOf, group };
}

/** Props for a composer's send button: marks it while it waits, and says what a press does then. */
export function dictationWaitProps(gate: Pick<SendAfterDictation, 'waiting'>, title?: string) {
  return gate.waiting
    ? { 'data-dictation-wait': 'true', 'aria-busy': true, title: DICTATION_WAIT_TITLE, 'aria-label': DICTATION_WAIT_TITLE }
    : (title ? { title } : {});
}
