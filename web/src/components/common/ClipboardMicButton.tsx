/**
 * Dictate to the clipboard: press, speak, press again, and the final words go
 * to the clipboard instead of the text box. Nothing is inserted or sent
 * (2026-11-09, the user: "the final text ... copy to my clipboard, can we also
 * have that button?").
 *
 * The words come from the same dictation as the composer's mic
 * (useSpeechToText with live drafting on, so the stop takes the recorder's own
 * audio path, not a second engine), and the live words show in a bubble above
 * the button while the user speaks.
 *
 * The clipboard write is asked for INSIDE the stop click (copyTextDeferred with
 * the promise of the final words): Safari and the Mac app's WKWebView refuse a
 * write whose click is over by the time the server answers.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useSttStatus, sttBlocksMic } from '@/hooks/useSttStatus';
import { copyTextDeferred } from '@/utils/clipboard';
import { log } from '@/utils/log';
import '@/styles/clipboard-mic.css';

/** How long "Copied" stays above the button. */
const COPIED_NOTE_MS = 2500;
/** No words: the hook's own error when it has one, else this. */
export const NOTHING_HEARD = 'No words heard, nothing copied';

export interface ClipboardMicHandle {
  /** Start a recording, as a press on the idle button does (the composer's "+" menu row). */
  start: () => void;
}

export interface ClipboardMicButtonProps {
  handleRef?: RefObject<ClipboardMicHandle | null>;
  /** Another mic of the same box is recording: a press then does nothing. */
  otherBusy?: () => boolean;
  /** This button's recording (or its transcription) started or ended. */
  onBusyChange?: (busy: boolean) => void;
  /** Dictation became usable here, or stopped being (the "+" menu row follows it). */
  onReadyChange?: (ready: boolean) => void;
  disabled?: boolean;
  language?: string;
}

/** The note for words copied from a dictation whose final pass failed. */
export function partialNote(err: string): string {
  const only = 'Only part was transcribed.';
  return err.startsWith(only) ? `Copied, but only part was transcribed.${err.slice(only.length)}` : `Copied, but ${err}`;
}

type Note = { kind: 'copied'; text: string } | { kind: 'error'; text: string } | null;

export function ClipboardMicButton({ handleRef, otherBusy, onBusyChange, onReadyChange, disabled, language }: ClipboardMicButtonProps) {
  // The words the user will get: the last final text the hook delivered
  // (a stop mid-sentence delivers the draft first, then its refinement).
  const finalRef = useRef('');
  const [live, setLive] = useState('');
  const [note, setNote] = useState<Note>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const { isSupported, isRecording, isTranscribing, error, toggleRecording, finishRecording, level } = useSpeechToText({
    onTranscribe: (text) => { finalRef.current = text; },
    onDraft: (text) => setLive(text),
    onRefine: (text) => { finalRef.current = text; return true; },
    ...(language ? { language } : {}),
  });

  const busy = isRecording || isTranscribing;
  // From the press on, before the microphone is open: the other mic must wait
  // through a permission prompt too.
  const [opening, setOpening] = useState(false);
  const engaged = busy || opening;
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;
  useEffect(() => { onBusyRef.current?.(engaged); }, [engaged]);
  // A button that goes away mid-recording must not leave the other mic disabled.
  useEffect(() => () => onBusyRef.current?.(false), []);
  // One stop per recording: a second click while the recorder winds down copies nothing more.
  const stoppingRef = useRef(false);

  const sttStatus = useSttStatus();
  // Not set up: no button at all. The composer's own mic leads to the setup, and
  // this one needs no router of its own (the composer renders outside one too).
  const sttUnavailable = isSupported && sttBlocksMic(sttStatus, busy);
  const ready = isSupported && !sttUnavailable;
  const onReadyRef = useRef(onReadyChange);
  onReadyRef.current = onReadyChange;
  useEffect(() => { onReadyRef.current?.(ready); }, [ready]);

  const showNote = useCallback((n: Note, ms?: number) => {
    clearTimeout(noteTimer.current);
    setNote(n);
    if (ms) noteTimer.current = setTimeout(() => setNote(null), ms);
  }, []);

  // The "+" menu's row starts the same way a press on the idle button does.
  const startRef = useRef<() => void>(() => {});
  useImperativeHandle(handleRef, () => ({ start: () => startRef.current() }), []);

  // A failure with no stop behind it (no microphone, permission refused) shows too,
  // once: dismissing it is not undone by the next render.
  useEffect(() => {
    if (error && !busy) setNote((n) => n ?? { kind: 'error', text: error });
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready && !engaged && !note) return null;

  const stop = () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    // The final pass failed after part of the words were in: they are copied,
    // and the note says it is only part.
    let partial: string | null = null;
    // Asked for now, inside the click; filled when the final words arrive.
    const words = finishRecording().then(({ error: err }) => {
      const text = finalRef.current.trim();
      if (!text) throw new Error(err ?? NOTHING_HEARD);
      partial = err;
      return text;
    });
    void copyTextDeferred(words).then(
      (how) => {
        if (how === 'failed') {
          log.warn('stt', 'dictation to clipboard: the clipboard refused the words');
          showNote({ kind: 'error', text: 'The clipboard refused the words' });
          return;
        }
        log.info('stt', `dictation copied to the clipboard (${finalRef.current.trim().length} chars, via ${how}${partial ? ', partial' : ''})`);
        if (partial) showNote({ kind: 'error', text: partialNote(partial) });
        else showNote({ kind: 'copied', text: 'Copied' }, COPIED_NOTE_MS);
      },
      (err: unknown) => {
        const text = err instanceof Error ? err.message : String(err);
        log.warn('stt', `dictation to clipboard copied nothing: ${text}`);
        showNote({ kind: 'error', text });
      },
    );
  };

  const start = () => {
    if (sttUnavailable) return;
    // Still opening the microphone from the last press, or the other mic records.
    if (isRecording || isTranscribing || opening || otherBusy?.()) return;
    finalRef.current = '';
    stoppingRef.current = false;
    setLive('');
    showNote(null);
    setOpening(true);
    onBusyRef.current?.(true);
    // Settles once the microphone is open (the recording runs) or refused.
    void toggleRecording().finally(() => setOpening(false));
  };
  startRef.current = start;

  const handleClick = () => {
    if (isRecording) { stop(); return; }
    start();
  };

  const title = isTranscribing
      ? 'Transcribing, then copying...'
      : isRecording
        ? 'Stop and copy the words'
        : 'Dictate to clipboard';

  const btnClass = [
    'btn clipboard-mic-btn',
    isRecording && 'mic-recording',
    isTranscribing && 'mic-transcribing',
  ].filter(Boolean).join(' ');

  const shownNote = note;

  return (
    // Its own classes, never .mic-btn / .mic-btn-wrapper: those name THE composer
    // mic for every page and test that looks for it.
    // Idle in a narrow composer it leaves the row (clipboard-mic.css); the "+"
    // menu's row starts it there, and once it records it stands in the mic's place.
    <div className={`clipboard-mic${engaged || note ? '' : ' is-idle'}`}>
      <button
        className={btnClass}
        onClick={handleClick}
        // A press must not take focus (and with it the composer's caret).
        onMouseDown={(e) => { if (e.button === 0) e.preventDefault(); }}
        type="button"
        disabled={disabled || isTranscribing}
        aria-label={title}
        title={title}
        data-testid="clipboard-mic"
      >
        {isTranscribing ? (
          <svg className="mic-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
          </svg>
        ) : isRecording ? (
          <span className="mic-waveform" aria-hidden="true">
            {[0.45, 0.75, 1, 0.7, 0.4].map((w, i) => (
              <span key={i} className="mic-waveform-bar" style={{ height: `${3 + Math.min(1, level * w) * 15}px` }} />
            ))}
          </span>
        ) : (
          // A clipboard with a small mic on it.
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <rect x="10.5" y="9" width="3" height="6" rx="1.5" />
            <path d="M8.5 13.5a3.5 3.5 0 0 0 7 0" />
            <line x1="12" y1="17" x2="12" y2="19" />
          </svg>
        )}
      </button>
      {isRecording && (
        <div className="mic-silence-warning clipboard-mic-live" role="status" data-testid="clipboard-mic-live">
          <span>{live || 'Listening... press again to copy'}</span>
        </div>
      )}
      {!isRecording && shownNote && (
        <div
          className={`mic-silence-warning clipboard-mic-note${shownNote.kind === 'error' ? ' is-error' : ' is-copied'}`}
          role={shownNote.kind === 'error' ? 'alert' : 'status'}
          data-testid="clipboard-mic-note"
        >
          <span>{shownNote.text}</span>
          {shownNote.kind === 'error' && (
            <button type="button" className="mic-error-dismiss" aria-label="Dismiss" onClick={() => showNote(null)}>
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
