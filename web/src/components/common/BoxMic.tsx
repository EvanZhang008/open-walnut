/**
 * The composer's mic for any plain text box (a textarea or a one-line input):
 * the same MicButton and recording bar, with the words written the composer's
 * way (useBoxDictation). The box's owner keeps its text state and calls
 * `handleRef.current.clear()` when it sends the text or switches the box to
 * another target, so a transcription still on its way never lands twice.
 */
import { useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from 'react';
import { MicButton } from '@/components/common/MicButton';
import { useBoxDictation } from '@/hooks/useBoxDictation';
import '@/styles/box-mic.css';

export interface BoxMicHandle {
  /** Stop and throw away a live recording, and forget the dictation spans. */
  clear: () => void;
}

export interface BoxMicProps {
  boxRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  text: string;
  setText: (t: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  handleRef?: RefObject<BoxMicHandle | null>;
}

export function BoxMic({ boxRef, text, setText, disabled, size = 'sm', className, handleRef }: BoxMicProps) {
  const dictation = useBoxDictation(boxRef, text, setText);
  const micControl = useRef<{ discard: () => void } | null>(null);
  useImperativeHandle(handleRef, () => ({
    clear: () => { micControl.current?.discard(); dictation.reset(); },
  }), [dictation]);
  // A box that goes away takes its recording with it.
  useEffect(() => () => micControl.current?.discard(), []);
  // Only the mic itself starts a recording: its chevron and menu sit in the same wrapper.
  const onPress = (target: EventTarget) => {
    const mic = target instanceof Element ? target.closest('.mic-btn') : null;
    if (mic && !mic.classList.contains('mic-recording')) dictation.started();
  };
  return (
    <span
      className={className ? `box-mic ${className}` : 'box-mic'}
      onPointerDownCapture={(e) => { if (e.button === 0) onPress(e.target); }}
      onKeyDownCapture={(e) => { if (e.key === 'Enter' || e.key === ' ') onPress(e.target); }}
    >
      <MicButton
        size={size}
        onTranscribe={dictation.onTranscribe}
        onDraft={dictation.onDraft}
        onRefine={dictation.onRefine}
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
    <div className={cls}>
      {children}
      <BoxMic {...mic} className={className ? `mic-field-mic ${className}` : 'mic-field-mic'} />
    </div>
  );
}
