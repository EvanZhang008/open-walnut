/**
 * The composer's mic for any plain text box (a textarea or a one-line input):
 * the same MicButton and recording bar, with the words written the composer's
 * way (useBoxDictation). The box's owner keeps its text state and calls
 * `handleRef.current.clear()` when it sends the text. A box that writes to
 * another object while it stays on screen (another draft, lane, node) passes
 * that object as `target`: a change drops a recording or transcription still on
 * its way, so its words never land in the next object.
 *
 * MicInput is a one-line box with the mic inside it, for the many boxes whose
 * only submit is Enter, a blur, or none (a live filter): it owns its send gate,
 * so its owner's plain Enter and blur handlers wait for words still being
 * dictated (tests/web/compose-voice-guard.test.ts fails on a box where a person
 * writes words that has no mic; tests/web/mic-input-submit-waits.test.ts holds
 * the waiting).
 */
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { MicButton, type MicControl } from '@/components/common/MicButton';
import { ownsMicControl } from '@/components/common/MicPopover';
import { useSendAfterDictation, type DictationControl } from '@/hooks/useSendAfterDictation';
import { useBoxDictation } from '@/hooks/useBoxDictation';
import { claimDictation, forgetDictatedTakes, noteDictatedTake, type DictationClaim } from '@/utils/dictation-takes';
import '@/styles/box-mic.css';

export interface BoxMicHandle extends DictationControl {
  /** Stop and throw away a live recording, and forget the dictation spans. */
  clear: () => void;
  /** The recordings dictated into this box whose words its text being sent still holds, for the send to carry (utils/dictation-takes.ts). */
  claimDictation: (sent: string) => DictationClaim;
}

export interface BoxMicProps {
  boxRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  text: string;
  setText: (t: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  handleRef?: RefObject<BoxMicHandle | null>;
  /** What the box writes to now; a change drops a dictation still on its way (see the file head). */
  target?: unknown;
}

export function BoxMic({ boxRef, text, setText, disabled, size = 'sm', className, handleRef, target }: BoxMicProps) {
  const dictation = useBoxDictation(boxRef, text, setText);
  const micControl = useRef<MicControl | null>(null);
  // On the stable `reset`, not the per-render `dictation` object: the handle would otherwise be
  // detached and re-attached on every commit, so a clear() from a layout cleanup found null.
  const reset = dictation.reset;
  const takesBox = `box-mic:${useId()}`;
  useImperativeHandle(handleRef, () => ({
    clear: () => { micControl.current?.discard(); reset(); forgetDictatedTakes(takesBox); },
    claimDictation: (sent: string) => claimDictation(takesBox, sent),
    busy: () => micControl.current?.busy() ?? false,
    finish: () => micControl.current?.finish() ?? Promise.resolve({ error: null }),
  }), [reset, takesBox]);
  // An emptied box holds none of its dictations any more.
  useEffect(() => { if (!text.trim()) forgetDictatedTakes(takesBox); }, [text, takesBox]);
  // A box that goes away takes its recording with it.
  useEffect(() => () => micControl.current?.discard(), []);
  // A box moved to another object drops the words still owed to the old one, before they can land.
  const shownTarget = useRef(target);
  useLayoutEffect(() => {
    if (Object.is(shownTarget.current, target)) return;
    shownTarget.current = target;
    micControl.current?.discard();
    reset();
  }, [target, reset]);
  // Only the mic itself starts a recording: its chevron and menu sit in the same wrapper.
  const onPress = (target: EventTarget) => {
    const mic = target instanceof Element ? target.closest('.mic-btn') : null;
    if (mic && !mic.classList.contains('mic-recording')) dictation.started();
  };
  return (
    <span
      className={className ? `box-mic ${className}` : 'box-mic'}
      onPointerDownCapture={(e) => { if (e.button === 0) onPress(e.target); }}
      // A press on the mic is the mic's: it never reaches a row or card the box sits in (opening it).
      onClick={(e) => e.stopPropagation()}
      onKeyDownCapture={(e) => { if (e.key === 'Enter' || e.key === ' ') onPress(e.target); }}
    >
      <MicButton
        size={size}
        onTranscribe={dictation.onTranscribe}
        onDraft={dictation.onDraft}
        onRefine={dictation.onRefine}
        onTake={(id, words) => noteDictatedTake(takesBox, id, words)}
        controlRef={micControl}
        onSettled={dictation.settled}
        disabled={disabled}
        insertBox={() => boxRef.current}
      />
    </span>
  );
}

export interface MicFieldProps extends BoxMicProps {
  children: ReactNode;
  /** One-line input: the mic sits centred at the right; a textarea's sits at its bottom right. */
  inline?: boolean;
  /** Extra class on the wrapper (the box's own layout: width, flex). */
  fieldClassName?: string;
}

/**
 * A box with the composer's mic inside its right edge, for boxes that have no
 * button row of their own to hold one. The wrapper takes the box's place in the
 * layout; the box gets room on the right so typed text never runs under the mic.
 */
export function MicField({ children, inline, fieldClassName, className, ...mic }: MicFieldProps) {
  const cls = ['mic-field', inline ? 'mic-field-inline' : 'mic-field-area', fieldClassName].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {children}
      <BoxMic {...mic} className={className ? `mic-field-mic ${className}` : 'mic-field-mic'} />
    </span>
  );
}

export interface MicInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> {
  value: string;
  /** Words the mic writes into the box (and typed ones, when the box has no onChange of its own). */
  setText: (text: string) => void;
  /** Enter submits the box: it waits for words still being dictated, then runs once. */
  onEnter?: () => void;
  /** What the box writes to (a draft key, an object id); a change drops a dictation on its way. */
  target?: unknown;
  ref?: Ref<HTMLInputElement>;
  /** The mic's handle, for an owner with another button that submits these words through its own gate. */
  micRef?: RefObject<BoxMicHandle | null>;
  /** The wrapper's class: the box's own layout (width, flex) moves onto it. */
  fieldClassName?: string;
  /** A smaller mic for a compact row. */
  compact?: boolean;
  micDisabled?: boolean;
  /** Parts of a field box (`wn-field`, SearchField) before and after the words: an icon, a clear key. */
  before?: ReactNode;
  after?: ReactNode;
}

/** Input types whose Enter submits their form when no other such field shares it (HTML implicit submission). */
const IMPLICIT_SUBMIT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);

/** What the browser does with an Enter nobody prevented in a form's box. A replayed Enter is
 *  untrusted, so it has no default action: do it here. */
function submitImplicitly(el: HTMLInputElement): void {
  const form = el.closest('form');
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement | HTMLInputElement>('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
  if (button) {
    if (!button.disabled) button.click();
    return;
  }
  const fields = Array.from(form.querySelectorAll('input')).filter((f) => IMPLICIT_SUBMIT_TYPES.has(f.type || 'text'));
  if (fields.length !== 1) return;
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new (el.ownerDocument.defaultView?.Event ?? Event)('submit', { bubbles: true, cancelable: true }));
}

/** What waits for the words still being dictated: one Enter, or the person leaving the box. */
type Pending =
  | { kind: 'enter'; keys: Pick<KeyboardEventInit, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>; target: unknown }
  | { kind: 'blur'; event: FocusEvent<HTMLInputElement>; target: unknown };

/**
 * A one-line box with the composer's mic inside its right edge. Its owner submits it the plain way
 * (`onEnter`, an Enter in its own `onKeyDown`, `onBlur`, its form), and the box makes every one of
 * them wait for words still being dictated:
 *
 *  - An Enter while the mic records or transcribes stops it, waits for the final (and refined)
 *    words, then runs as that Enter: the owner's latest `onKeyDown`, `onEnter` and form see it once.
 *    A second Enter or Esc while it waits cancels it (the words still land, nothing runs); an error
 *    or a new `target` runs nothing. An IME's confirming Enter is never caught.
 *  - Leaving the box mid-dictation does the same for `onBlur`: the owner hears the blur once the
 *    words are in, so a save on blur never saves half of them or unmounts the box under its own
 *    recording, and the words do not pull focus back into the box the person left. An Enter
 *    already waiting is the one submit: the blur after it is not a second one.
 *  - Focus moving into this box's own mic (its button, chevron, history menu), or the window losing
 *    focus mid-dictation, is not leaving: the owner hears the blur only when focus then goes
 *    elsewhere, and nothing at all when it comes back to the box.
 *
 * With nothing being dictated every event passes straight through, as on a plain input.
 */
export function MicInput({ value, setText, onEnter, target, ref, micRef, fieldClassName, compact, micDisabled, before, after, onChange, onKeyDown, onBlur, onFocus, disabled, readOnly, ...input }: MicInputProps) {
  const box = useRef<HTMLInputElement | null>(null);
  const ownMic = useRef<BoxMicHandle | null>(null);
  const mic = micRef ?? ownMic;
  // A waiting submit runs the owner's handlers of the render that holds the final words.
  const latest = useRef({ onBlur, target });
  latest.current = { onBlur, target };
  const pending = useRef<Pending | null>(null);
  const replaying = useRef(false);
  const escaping = useRef(false);
  // The person left the box mid-dictation: the dictation's writer sees no box, so its words land
  // without pulling focus (and the caret) back into it.
  const away = useRef(false);
  const [dictationBox] = useState(() => ({ get current() { return away.current ? null : box.current; } }));

  const runPending = () => {
    const p = pending.current;
    pending.current = null;
    away.current = false;
    const el = box.current;
    if (!p || !el?.isConnected || !Object.is(p.target, latest.current.target)) return;
    if (p.kind === 'blur') { latest.current.onBlur?.(p.event); return; }
    const Key = el.ownerDocument.defaultView?.KeyboardEvent ?? globalThis.KeyboardEvent;
    const enter = new Key('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...p.keys });
    replaying.current = true;
    try { el.dispatchEvent(enter); } finally { replaying.current = false; }
    if (!enter.defaultPrevented) submitImplicitly(el);
  };
  const gate = useSendAfterDictation([mic], runPending, target);
  // Read from listeners that outlive the render they were made in.
  const gateNow = useRef(gate);
  gateNow.current = gate;
  const enterWaits = () => gateNow.current.waiting && pending.current?.kind === 'enter';

  /** Focus is out of the box for good: the owner's blur, now or once the words are in. */
  const leave = (e: FocusEvent<HTMLInputElement>) => {
    if (enterWaits()) { away.current = true; return; }
    if (mic.current?.busy()) {
      pending.current = { kind: 'blur', event: e, target: latest.current.target };
      away.current = true;
      gateNow.current.send();
      return;
    }
    latest.current.onBlur?.(e);
  };

  // A held blur: focus sits in the box's own mic (or another window). It becomes a leave when
  // focus or a press lands outside the field, and is dropped when focus comes back to the box.
  const unhold = useRef<(() => void) | null>(null);
  const release = () => { unhold.current?.(); unhold.current = null; };
  const hold = (e: FocusEvent<HTMLInputElement>) => {
    release();
    const doc = e.currentTarget.ownerDocument;
    const outside = (ev: Event) => {
      if (ownsMicControl(box.current?.closest('.mic-field'), ev.target as Node | null)) return;
      release();
      leave(e);
    };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('focusin', outside, true);
    unhold.current = () => {
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('focusin', outside, true);
    };
  };
  useEffect(() => () => unhold.current?.(), []);

  // A press on the mic's own controls. WebKit does not focus a pressed button, so the blur it
  // causes names no element; this is how that blur is known to stay in the box.
  const pressedMic = useRef(false);
  useEffect(() => {
    const field = box.current?.closest('.mic-field');
    if (!field) return;
    const press = (ev: Event) => {
      if (ev.target === box.current) return;
      pressedMic.current = true;
      away.current = false;
      setTimeout(() => { pressedMic.current = false; }, 0);
    };
    field.addEventListener('pointerdown', press, true);
    return () => field.removeEventListener('pointerdown', press, true);
  }, []);

  const setRefs = (el: HTMLInputElement | null) => {
    box.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as RefObject<HTMLInputElement | null>).current = el;
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An IME's confirming Enter (Safari reports keyCode 229) is never a submit.
    const enterKey = e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
    if (enterKey && !replaying.current && (gate.waiting || mic.current?.busy())) {
      e.preventDefault();
      e.stopPropagation();
      if (!gate.waiting) pending.current = { kind: 'enter', keys: { shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey }, target };
      gate.send();
      return;
    }
    // A blur the owner's own Escape causes is its call, not a leave to wait on.
    escaping.current = e.key === 'Escape';
    try { onKeyDown?.(e); } finally { escaping.current = false; }
    if (enterKey && onEnter && !e.defaultPrevented) {
      e.preventDefault();
      onEnter();
    }
  };
  const blur = (e: FocusEvent<HTMLInputElement>) => {
    if (escaping.current) { onBlur?.(e); return; }
    const to = e.relatedTarget as Node | null;
    if (ownsMicControl(e.currentTarget.closest('.mic-field'), to) || pressedMic.current) { hold(e); return; }
    const doc = e.currentTarget.ownerDocument;
    const windowLost = !to && typeof doc.hasFocus === 'function' && !doc.hasFocus();
    if (windowLost && mic.current?.busy()) { hold(e); return; }
    leave(e);
  };
  const focus = (e: FocusEvent<HTMLInputElement>) => {
    // Back from a blur the owner never heard: it hears no focus either.
    const unheard = !!unhold.current || pending.current?.kind === 'blur';
    release();
    away.current = false;
    if (pending.current?.kind === 'blur') { pending.current = null; gate.cancel(); }
    if (!unheard) onFocus?.(e);
  };
  const cls = [compact ? 'mic-field-compact' : '', fieldClassName].filter(Boolean).join(' ') || undefined;
  return (
    <MicField inline boxRef={dictationBox} text={value} setText={setText} handleRef={mic} target={target} disabled={disabled || readOnly || micDisabled} fieldClassName={cls}>
      {before}
      {/* The caller's own data-draft-key or data-no-draft (in `input`) wins: its MicInput tag is the box. */}
      <input
        data-no-draft="mirror"
        {...input}
        ref={setRefs}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={onChange ?? ((e) => setText(e.target.value))}
        onKeyDown={keyDown}
        onBlur={blur}
        onFocus={focus}
      />
      {after}
    </MicField>
  );
}
