/**
 * The quick bar (experimental `quick_bar`): pressed open with Control-Option-Command-Space, it
 * listens at once and shows the words as they are said; the name said first ("to Walnut VP,
 * ...") or the picker (Tab) chooses who gets them; two seconds after the take ends it sends,
 * unless Esc stops the count or a key is typed into the words. Enter sends at once.
 *
 * The same component is the in-app overlay (QuickBarHost.tsx) and the Mac app's floating panel
 * (QuickBarPanelPage.tsx). It stays mounted while hidden, so a take still being transcribed when
 * the bar closes lands in the words kept for the next open, never nowhere.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useBoxDictation } from '@/hooks/useBoxDictation';
import { useSttStatus, sttBlocksMic } from '@/hooks/useSttStatus';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { fetchQuickPeople, type QuickImage } from '@/api/quick';
import { log } from '@/utils/log';
import { addresseeOf, personLine, readRecents, sectionPeople, startingPerson, type QuickPerson } from './quickbar-people';
import { QuickBarPicker, flatPicks } from './QuickBarPicker';
import { PersonAvatar } from './PersonAvatar';
import { AttachPictureButton, PictureStrip, usePictureInput } from '@/components/common/PictureStrip';
import { useImageAttachments } from '@/components/common/image-attachments';
import '@/styles/quickbar.css';

/** How long the count runs after a take ends before the words go. */
export const SEND_COUNTDOWN_MS = 2_000;

export interface QuickBarHandle {
  /** The bar was just opened: read the people again and start listening. */
  opened(): void;
  /** The hotkey was pressed while the bar is open: stop the take, send now, or close. */
  hotkey(): void;
  /** A screenshot to send with the words (the Mac app's capture). */
  attach(image: QuickImage): void;
  /** A send that never went out comes back into the bar, to fix and send again. */
  restore(person: QuickPerson, text: string, images: QuickImage[]): void;
  /** Close as Esc does: a take still running keeps its words for the next open. */
  close(): void;
}

interface QuickBarProps {
  surface: 'overlay' | 'panel';
  onClose: () => void;
  onSend: (person: QuickPerson, text: string, images: QuickImage[]) => void;
  /** The Mac app can take a screenshot of an area (Cmd-Shift-S). */
  onCapture?: () => void;
}

export const QuickBar = forwardRef<QuickBarHandle, QuickBarProps>(function QuickBar({ surface, onClose, onSend, onCapture }, ref) {
  const [people, setPeople] = useState<QuickPerson[]>([]);
  const [person, setPerson] = useState<QuickPerson | null>(null);
  // The words wait in the draft store, so a reload, an app restart or the panel's release keeps them.
  const draft = useDraft(draftKey('quickbar'));
  const text = draft.text;
  const setText = draft.setText as (t: string) => void;
  // Pictures as every box for an AI takes them (pasted, dropped, picked), plus the Mac app's capture.
  const pictures = useImageAttachments();
  const images = pictures.images;
  const pictureInput = usePictureInput(pictures);
  const [picking, setPicking] = useState(false);
  const [countdownAt, setCountdownAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickedBySpeech, setPickedBySpeech] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Enter pressed while the take was still running: send once its words are in.
  const sendWhenDone = useRef(false);
  // The person was chosen by hand (the list, a number key, a put-back), or a take's address was
  // already read from these words: either way no name is read from them again until they are sent
  // or emptied (an edit during the count keeps the person the count names).
  const pickedByHand = useRef(false);
  const addressTaken = useRef(false);

  const dictation = useBoxDictation(boxRef, text, setText);
  const stt = useSpeechToText({ onDraft: dictation.onDraft, onTranscribe: dictation.onTranscribe, onRefine: dictation.onRefine });
  const sttStatus = useSttStatus();
  const voiceOff = !stt.isSupported || sttBlocksMic(sttStatus, stt.isRecording || stt.isTranscribing);
  const recording = stt.isRecording || stt.micOpening;

  const sections = useMemo(() => sectionPeople(people, readRecents()), [people]);
  const picks = useMemo(() => flatPicks(sections), [sections]);

  const stopCount = useLeanCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCountdownAt(null);
  }, []);

  const loadPeople = useLeanCallback(() => {
    fetchQuickPeople(14).then(({ people: rows }) => {
      setPeople(rows);
      setPerson((cur) => (cur && rows.some((r) => r.id === cur.id) ? rows.find((r) => r.id === cur.id)! : startingPerson(rows, readRecents())));
    }).catch((err: unknown) => {
      log.warn('quickbar', 'people list failed', { error: err instanceof Error ? err.message : String(err) });
      setNotice((n) => n ?? 'Could not load who you can talk to. Sending goes to the CEO.');
    });
  }, []);

  /** The words as they will go: a name said first picks that person and leaves the words. */
  const addressed = useLeanCallback((words: string): { to: QuickPerson | null; words: string } => {
    const hit = addresseeOf(words, people);
    if (!hit) return { to: person, words };
    return { to: hit.person, words: hit.rest };
  }, [people, person]);

  /**
   * Send the box's words. `taken` is what a take that just ended worked out (its person and the
   * words without the address), passed straight in: its state is not rendered yet when Enter
   * pressed during the take sends at once.
   */
  const send = useLeanCallback((taken?: { to: QuickPerson | null; words: string }) => {
    stopCount();
    const parse = !taken && !pickedByHand.current && !addressTaken.current;
    const { to, words } = taken ?? (parse ? addressed(text) : { to: person, words: text });
    const trimmed = words.trim();
    if (!trimmed && images.length === 0) { setNotice('Nothing to send yet.'); return; }
    const target = to ?? { id: '', title: 'CEO', kind: 'ceo', project: '', state: '', stateLabel: '', line: '', needs: 0 } as QuickPerson;
    onSend(target, trimmed, images);
    dictation.reset();
    // The words sent, whatever this render shows: the store's copy goes with them.
    draft.clear();
    pickedByHand.current = false;
    addressTaken.current = false;
    pictures.clear();
    setNotice(null);
    setPickedBySpeech(false);
    setPerson(target.id ? target : person);
  }, [text, images, addressed, onSend, person, draft]);

  /** The take ended with words: show who they go to, then count down to the send. */
  const tookWords = useLeanCallback(() => {
    const value = boxRef.current?.value ?? text;
    // A person picked by hand stays: words that start like a name are only words then.
    const hit = pickedByHand.current || addressTaken.current ? null : addresseeOf(value, people);
    const words = hit ? hit.rest : value;
    const to = hit ? hit.person : person;
    if (hit) {
      // The address picked the person; the words go without it.
      if (hit.person.id !== person?.id) setPickedBySpeech(true);
      setPerson(hit.person);
      setText(words);
    }
    // Read once: the send after the count must not take a second name from what is left.
    addressTaken.current = true;
    if (!words.trim() && images.length === 0) { setNotice("Didn't catch that. Try again, or type."); return; }
    if (sendWhenDone.current) { sendWhenDone.current = false; send({ to, words }); return; }
    // Two takes ending together (Enter, then the key) arm one count, never two.
    stopCount();
    setCountdownAt(Date.now());
    timer.current = setTimeout(() => { timer.current = null; setCountdownAt(null); send(); }, SEND_COUNTDOWN_MS);
  }, [people, person, images, text, send]);

  const finishTake = useLeanCallback(async () => {
    const outcome = await stt.finishRecording();
    if (outcome.error) { setNotice(outcome.error); sendWhenDone.current = false; return; }
    // The final words reach the box a frame after the promise; read them after it paints.
    requestAnimationFrame(() => tookWords());
  }, [stt, tookWords]);

  // Opened before the voice setup was read: the take waits for it, and never starts without voice
  // (a take started blind kept recording, and its late words landed in a box put back since).
  const takeWhenKnown = useRef(false);
  const startTake = useLeanCallback(() => {
    if (sttStatus.isLoading) { takeWhenKnown.current = true; return; }
    if (voiceOff || recording) return;
    setNotice(null);
    dictation.started();
    stt.toggleRecording();
  }, [voiceOff, recording, dictation, stt, sttStatus.isLoading]);

  useEffect(() => {
    if (sttStatus.isLoading || !takeWhenKnown.current) return;
    takeWhenKnown.current = false;
    startTake();
  }, [sttStatus.isLoading, startTake]);

  const close = useLeanCallback(() => {
    stopCount();
    takeWhenKnown.current = false;
    // A take still running keeps its words for the next open; nothing is sent.
    if (stt.isRecording) void stt.finishRecording();
    setPicking(false);
    onClose();
  }, [stt, onClose]);

  useImperativeHandle(ref, () => ({
    opened: () => {
      stopCount();
      loadPeople();
      setPicking(false);
      setPerson((cur) => (text.trim() ? cur : startingPerson(people, readRecents()) ?? cur));
      requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
      startTake();
    },
    hotkey: () => {
      if (recording) { void finishTake(); return; }
      if (countdownAt !== null) { send(); return; }
      if (!text.trim() && images.length === 0) { onClose(); return; }
      startTake();
    },
    attach: (image) => pictures.set([...pictures.images, { ...image, name: 'screenshot.png' }]),
    restore: (to, words, shots) => {
      stopCount();
      // The words come back as they were sent: a take still running, or its late words, add nothing.
      takeWhenKnown.current = false;
      if (stt.isRecording) stt.discardRecording();
      dictation.reset();
      loadPeople();
      setPicking(false);
      pickedByHand.current = true;
      setPerson(to);
      setText(words);
      pictures.set(shots.map((shot) => ({ name: 'screenshot.png', ...shot })));
      setNotice('Put back. Press Enter to send it again.');
      requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
    },
    close: () => close(),
  }), [close, stopCount, loadPeople, startTake, finishTake, recording, countdownAt, send, text, images, onClose, people, stt, dictation]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const pick = useLeanCallback((p: QuickPerson) => {
    pickedByHand.current = true;
    setPerson(p);
    setPickedBySpeech(false);
    setPicking(false);
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
  }, []);


  const onKeyDown = useLeanCallback((e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && /^[1-9]$/.test(e.key)) {
      const p = picks[Number(e.key) - 1];
      if (p) { e.preventDefault(); stopCount(); pick(p); }
      return;
    }
    if (mod && e.shiftKey && (e.key === 's' || e.key === 'S') && onCapture) { e.preventDefault(); stopCount(); onCapture(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (picking) { setPicking(false); boxRef.current?.focus(); return; }
      if (countdownAt !== null) { stopCount(); setNotice('Not sent. Edit the words, then press Enter.'); return; }
      close();
      return;
    }
    if (picking) return;
    if (e.key === 'Tab') { e.preventDefault(); stopCount(); setPicking(true); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (recording || stt.isTranscribing) { sendWhenDone.current = true; stopCount(); void finishTake(); return; }
      send();
      return;
    }
    // Any other key during the count is an edit: the words wait for Enter.
    if (countdownAt !== null && !['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) stopCount();
  }, [picks, pick, picking, countdownAt, close, recording, stt, finishTake, send, onCapture]);

  // The box grows with the words, up to five lines.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const preview = addressed(text);
  const shown = preview.to ?? person;
  const hint = recording ? (stt.micLive ? 'Listening' : 'Opening the microphone') : stt.isTranscribing ? 'Finishing the last words' : null;

  return (
    <div
      className={`${surface === 'panel' ? 'qb-bar qb-bar-panel' : 'qb-bar'}${pictureInput.dragOver ? ' qb-drag-over' : ''}`}
      role="dialog"
      aria-label="Quick bar"
      data-recording={recording ? 'true' : 'false'}
      onKeyDown={onKeyDown}
      {...pictureInput.dropProps}
    >
      <div className="qb-row">
        <button
          type="button"
          className={`qb-mic${recording ? ' qb-mic-on' : ''}${voiceOff ? ' qb-mic-off' : ''}`}
          aria-label={recording ? 'Stop listening' : 'Start listening'}
          title={voiceOff ? 'Voice input is not set up (Settings, Voice)' : recording ? 'Stop (Control-Option-Command-Space)' : 'Speak'}
          onClick={() => (recording ? void finishTake() : startTake())}
          disabled={voiceOff && !recording}
        >
          <MicGlyph level={recording ? stt.level : 0} />
        </button>
        <button
          type="button"
          className={`qb-to${pickedBySpeech ? ' qb-to-heard' : ''}`}
          onClick={() => { stopCount(); setPicking((v) => !v); }}
          aria-label={`To ${shown?.title ?? 'CEO'}. Change`}
          aria-expanded={picking}
        >
          {shown && <PersonAvatar person={shown} size={20} />}
          <span className="qb-to-name">{shown?.title ?? 'CEO'}</span>
          <span className="qb-to-caret" aria-hidden="true" />
        </button>
        <textarea
          ref={boxRef}
          className="qb-text"
          data-draft-key={draft.key ?? undefined}
          rows={1}
          value={text}
          placeholder={recording ? 'Speak now…' : voiceOff ? 'Type a message…' : 'Speak or type…'}
          aria-label="Message"
          onChange={(e) => { setText(e.target.value); setNotice(null); if (!e.target.value.trim()) addressTaken.current = false; }}
          onPaste={pictureInput.onPaste}
          spellCheck={false}
        />
        {recording ? <Waveform level={stt.level} /> : <AttachPictureButton pictures={pictures} className="qb-attach" testId="qb-attach" />}
      </div>
      <PictureStrip pictures={pictures} className="qb-shots" testId="qb-pictures" />
      {countdownAt !== null && <div key={countdownAt} className="qb-count" style={{ animationDuration: `${SEND_COUNTDOWN_MS}ms` }} />}
      {picking && <QuickBarPicker sections={sections} current={shown} onPick={pick} onClose={() => { setPicking(false); boxRef.current?.focus(); }} />}
      <div className="qb-foot">
        {countdownAt !== null ? (
          <span className="qb-foot-send">Sending to {shown?.title ?? 'CEO'}…</span>
        ) : notice || stt.error || stt.silenceWarning ? (
          <span className="qb-foot-note" role="status">{notice ?? stt.error ?? stt.silenceWarning}</span>
        ) : hint ? (
          <span className="qb-foot-live"><span className="qb-dot" />{hint}</span>
        ) : (
          <span className="qb-foot-idle">{shown ? personLine(shown) : ''}</span>
        )}
        <span className="qb-keys">
          {countdownAt !== null
            ? <><Key k="esc" />stop <Key k="↵" />send now</>
            : recording
              ? <><Key k="⌃⌥⌘␣" />done <Key k="↵" />send <Key k="esc" />close</>
              : <><Key k="tab" />who <Key k="↵" />send{onCapture && <> <Key k="⇧⌘S" />screenshot</>} <Key k="esc" />close</>}
        </span>
      </div>
    </div>
  );
});

function Key({ k }: { k: string }) {
  return <kbd className="qb-key">{k}</kbd>;
}

function MicGlyph({ level }: { level: number }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style={{ transform: `scale(${1 + Math.min(level, 1) * 0.12})` }}>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Waveform({ level }: { level: number }) {
  const weights = [0.4, 0.7, 1, 0.8, 0.55, 0.9, 0.45];
  return (
    <span className="qb-wave" aria-hidden="true">
      {weights.map((w, i) => <span key={i} style={{ height: `${4 + Math.min(1, level * w * 1.4) * 16}px` }} />)}
    </span>
  );
}
