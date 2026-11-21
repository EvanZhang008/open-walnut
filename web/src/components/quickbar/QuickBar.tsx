/**
 * The quick bar (experimental `quick_bar`): pressed open with Control-Option-Command-Space, it
 * listens at once and shows the words as they are said; the name said first ("to Walnut VP,
 * ...") or the picker (Tab) chooses who gets them; two seconds after the take ends it sends,
 * unless Esc stops the count or a key is typed into the words. Enter sends at once: the bar
 * leaves at that moment and a take still running finishes and goes from here, out of sight.
 * Esc during a take only stops listening. A keyword and Tab switch to searching tasks or notes,
 * or to a quick question answered in the bar (quickbar-modes.ts).
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
import { addresseeOf, personOfRecent, readRecents, sectionPeople, startingPerson, type QuickPerson } from './quickbar-people';
import { MODES, matchMode, modeSpec, type QuickMode } from './quickbar-modes';
import { QuickBarResults, type QuickBarResultsHandle, type QuickResult } from './QuickBarResults';
import { QuickBarAsk, useQuickAsk } from './QuickBarAsk';
import { QuickBarFoot, MicGlyph, Waveform } from './QuickBarFoot';
import { QuickBarPicker, flatPicks } from './QuickBarPicker';
import { PersonAvatar } from './PersonAvatar';
import { AttachPictureButton, PictureStrip, usePictureInput } from '@/components/common/PictureStrip';
import { useImageAttachments } from '@/components/common/image-attachments';
import '@/styles/quickbar.css';
import { taskPath } from '@/utils/task-path';

/** How long the count runs after a take ends before the words go. */
export const SEND_COUNTDOWN_MS = 2_000;

export interface OpenOptions {
  /** Start listening at once (the key, the magnifier); Cmd-K opens it for typing. */
  listen?: boolean;
  /** Open in this mode (Cmd-K on the Notes page opens the notes search). */
  mode?: QuickMode;
}

export interface QuickBarHandle {
  /** The bar was just opened: read the people again and start listening (unless told not to). */
  opened(opts?: OpenOptions): void;
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
  /** Open an app path (a task's chat, a note): the page navigates, the Mac app's panel asks the app. */
  onOpen: (to: string) => void;
  /** The Mac app can take a screenshot of an area (Cmd-Shift-S). */
  onCapture?: () => void;
}

/**
 * Run `fn` once the words just set are on the page. A frame is the usual moment; a hidden window
 * (the Mac app's panel, ordered out right after Enter) paints no frames, so a short timer stands in.
 */
function afterPaint(fn: () => void): void {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(once);
  setTimeout(once, 60);
}

/** How long the bar waits before it reads the people list again after a failure, growing. */
const PEOPLE_RETRY_MS = [3_000, 6_000, 12_000, 30_000];

export const QuickBar = forwardRef<QuickBarHandle, QuickBarProps>(function QuickBar({ surface, onClose, onSend, onOpen, onCapture }, ref) {
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
  // The people list did not load (Walnut restarting, say): the bar says so, and reads it again.
  const [peopleFailed, setPeopleFailed] = useState(false);
  const peopleRetry = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempt: number }>({ timer: null, attempt: 0 });
  // What the words are for (quickbar-modes.ts); in a mode the box holds a query, never the message.
  const [mode, setMode] = useState<QuickMode>('send');
  // The mode as of now, for calls made in the same tick as a switch (opened() switches, then listens).
  const modeNow = useRef<QuickMode>('send');
  // The message a typed keyword switched away from ("ask the VP ..." + Tab): it comes back on the
  // way back to the message, unless the mode opened something or asked.
  const leftMessage = useRef<string | null>(null);
  // The bar is on screen: a failed people read is tried again only then.
  const onScreen = useRef(false);
  const [query, setQuery] = useState('');
  const resultsRef = useRef<QuickBarResultsHandle | null>(null);
  const asking = useQuickAsk();
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Enter pressed while the take was still running: send once its words are in.
  const sendWhenDone = useRef(false);
  // Esc during a take: it only stops listening, so no count follows it.
  const quietAfterTake = useRef(false);
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
    const retry = peopleRetry.current;
    if (retry.timer) { clearTimeout(retry.timer); retry.timer = null; }
    fetchQuickPeople(14).then(({ people: rows }) => {
      retry.attempt = 0;
      setPeopleFailed(false);
      setPeople(rows);
      // The person the chip shows stays (words may be on their way to them), refreshed from the list.
      setPerson((cur) => (cur?.id ? rows.find((r) => r.id === cur.id) ?? cur : startingPerson(rows, readRecents())));
    }).catch((err: unknown) => {
      log.warn('quickbar', 'people list failed', { error: err instanceof Error ? err.message : String(err), attempt: retry.attempt });
      setPeopleFailed(true);
      // The chip and the send stay one person: the one shown now, else the last one sent to
      // (as the bar would open on), else the CEO, which the chip then says.
      setPerson((cur) => cur ?? personOfRecent(readRecents()));
      if (!onScreen.current) return;
      retry.timer = setTimeout(() => { retry.timer = null; loadPeople(); }, PEOPLE_RETRY_MS[Math.min(retry.attempt, PEOPLE_RETRY_MS.length - 1)]);
      retry.attempt += 1;
    });
  }, []);
  useEffect(() => () => { if (peopleRetry.current.timer) clearTimeout(peopleRetry.current.timer); }, []);

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
    onScreen.current = false;
    if (peopleRetry.current.timer) { clearTimeout(peopleRetry.current.timer); peopleRetry.current.timer = null; }
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
    // In a mode the box holds a query (opened again before these words came): the message is the store's.
    const value = modeNow.current === 'send' ? boxRef.current?.value ?? text : text;
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
    if (sendWhenDone.current) {
      sendWhenDone.current = false;
      // Enter already closed the bar: what was said goes, or nothing did and the next open says so.
      if (words.trim() || images.length > 0) send({ to, words });
      else setNotice("Didn't catch that. Nothing was sent.");
      quietAfterTake.current = false;
      return;
    }
    if (!words.trim() && images.length === 0) { quietAfterTake.current = false; setNotice("Didn't catch that. Try again, or type."); return; }
    if (quietAfterTake.current) { quietAfterTake.current = false; boxRef.current?.focus({ preventScroll: true }); return; }
    // Two takes ending together (Enter, then the key) arm one count, never two.
    stopCount();
    setCountdownAt(Date.now());
    timer.current = setTimeout(() => { timer.current = null; setCountdownAt(null); send(); }, SEND_COUNTDOWN_MS);
  }, [people, person, images, text, send]);

  const finishTake = useLeanCallback(async () => {
    const outcome = await stt.finishRecording();
    if (outcome.error) {
      setNotice(outcome.error);
      quietAfterTake.current = false;
      // Enter closed the bar already: the live words it showed still go, never nothing.
      if (sendWhenDone.current) afterPaint(() => tookWords());
      return;
    }
    // The final words reach the box a frame after the promise; read them after it paints.
    afterPaint(() => tookWords());
  }, [stt, tookWords]);

  // Opened before the voice setup was read: the take waits for it, and never starts without voice
  // (a take started blind kept recording, and its late words landed in a box put back since).
  const takeWhenKnown = useRef(false);
  const startTake = useLeanCallback(() => {
    if (modeNow.current !== 'send') return;
    quietAfterTake.current = false;
    // A take into an empty box starts a new message: a name said first picks the person again.
    if (!(boxRef.current?.value ?? text).trim()) addressTaken.current = false;
    if (sttStatus.isLoading) { takeWhenKnown.current = true; return; }
    if (voiceOff || recording) return;
    setNotice(null);
    dictation.started();
    stt.toggleRecording();
  }, [voiceOff, recording, dictation, stt, sttStatus.isLoading, text]);

  useEffect(() => {
    if (sttStatus.isLoading || !takeWhenKnown.current) return;
    takeWhenKnown.current = false;
    startTake();
  }, [sttStatus.isLoading, startTake]);

  /** The bar goes away (closed, sent, or a result opened): it reads nothing again until it opens. */
  const leave = useLeanCallback(() => {
    onScreen.current = false;
    if (peopleRetry.current.timer) { clearTimeout(peopleRetry.current.timer); peopleRetry.current.timer = null; }
    onClose();
  }, [onClose]);

  const close = useLeanCallback(() => {
    stopCount();
    takeWhenKnown.current = false;
    // A take still running keeps its words for the next open; nothing is sent.
    if (stt.isRecording) void stt.finishRecording();
    setPicking(false);
    leave();
  }, [stt, leave]);

  /**
   * Switch what the words are for. `typed`: the keyword was typed into the message box (Tab on
   * "task tile"), so it leaves the box; a message waiting there otherwise stays for when the bar
   * comes back to it.
   */
  const enterMode = useLeanCallback((next: QuickMode, words = '', typed = false) => {
    stopCount();
    setPicking(false);
    setNotice(null);
    if (next !== 'send') {
      takeWhenKnown.current = false;
      if (stt.isRecording || stt.micOpening) { stt.discardRecording(); dictation.reset(); }
      if (typed) { leftMessage.current = text; setText(''); }
    } else if (leftMessage.current !== null) {
      // Back without opening or asking anything: the message typed before the switch comes back.
      if (!text.trim()) setText(leftMessage.current);
      leftMessage.current = null;
    }
    if (next !== 'ask') asking.reset();
    modeNow.current = next;
    setMode(next);
    setQuery(next === 'send' ? '' : words);
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
  }, [stt, dictation, asking, text]);

  const openResult = useLeanCallback((result: QuickResult) => {
    leftMessage.current = null;
    onOpen(result.to);
    enterMode('send');
    leave();
  }, [onOpen, enterMode, leave]);

  useImperativeHandle(ref, () => ({
    opened: (opts = {}) => {
      onScreen.current = true;
      leftMessage.current = null;
      stopCount();
      loadPeople();
      setPicking(false);
      setPerson((cur) => (text.trim() ? cur : startingPerson(people, readRecents()) ?? cur));
      // An empty box is a new message: its first words may name who gets it again.
      if (!text.trim()) { pickedByHand.current = false; addressTaken.current = false; }
      enterMode(opts.mode ?? 'send');
      boxRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
      if ((opts.listen ?? true) && !opts.mode) startTake();
    },
    hotkey: () => {
      if (recording) { void finishTake(); return; }
      if (countdownAt !== null) { send(); return; }
      if (!text.trim() && images.length === 0) { leave(); return; }
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
  }), [close, stopCount, loadPeople, startTake, finishTake, recording, countdownAt, send, text, images, leave, people, stt, dictation]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const pick = useLeanCallback((p: QuickPerson) => {
    pickedByHand.current = true;
    setPerson(p);
    setPickedBySpeech(false);
    setPicking(false);
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
  }, []);


  // A keyword switches only typed words: a take still running or being written out is a message.
  const typedMode = mode === 'send' && !recording && !stt.isTranscribing ? matchMode(text) : null;

  const onKeyDown = useLeanCallback((e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mode === 'send' && mod && /^[1-9]$/.test(e.key)) {
      const p = picks[Number(e.key) - 1];
      if (p) { e.preventDefault(); stopCount(); pick(p); }
      return;
    }
    if (mod && e.shiftKey && (e.key === 's' || e.key === 'S') && onCapture) { e.preventDefault(); stopCount(); onCapture(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (picking) { setPicking(false); boxRef.current?.focus(); return; }
      // During a take Esc only stops listening: the words stay in the box, nothing is sent.
      if (recording) { quietAfterTake.current = true; stopCount(); void finishTake(); return; }
      if (countdownAt !== null) { stopCount(); setNotice('Not sent. Edit the words, then press Enter.'); return; }
      if (mode !== 'send') { enterMode('send'); return; }
      close();
      return;
    }
    if (picking) return;
    if (mode === 'tasks' || mode === 'notes') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); resultsRef.current?.move(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter') { e.preventDefault(); const hit = resultsRef.current?.chosen(); if (hit) openResult(hit); return; }
    }
    if (mode !== 'send') {
      if (e.key === 'Tab') { e.preventDefault(); return; }
      // Backspace past the query clears it on purpose: back to an empty message.
      if (e.key === 'Backspace' && !query) { e.preventDefault(); leftMessage.current = null; enterMode('send'); return; }
      if (mode === 'ask' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (query.trim()) { leftMessage.current = null; asking.ask(query.trim()); setQuery(''); }
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      stopCount();
      // A keyword typed first ("task tile") switches to its mode; else Tab is who gets the words.
      if (typedMode && !e.shiftKey) { enterMode(typedMode.mode.id, typedMode.rest, true); return; }
      setPicking(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (stt.micOpening && !stt.isRecording) {
        // The mic is not open yet: nothing was said. Cancel the start; typed words go now.
        stt.toggleRecording();
        if (text.trim() || images.length > 0) send();
        else leave();
        return;
      }
      if (recording || stt.isTranscribing) {
        // The bar leaves now; the last words are written out and sent from here, out of sight.
        sendWhenDone.current = true;
        quietAfterTake.current = false;
        stopCount();
        void finishTake();
        setPicking(false);
        leave();
        return;
      }
      send();
      return;
    }
    // Any other key during the count is an edit: the words wait for Enter.
    if (countdownAt !== null && !['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) stopCount();
  }, [picks, pick, picking, countdownAt, close, recording, stt, finishTake, send, onCapture, mode, query, typedMode, enterMode, openResult, asking, leave, text, images]);

  // The box grows with the words, up to five lines.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const preview = addressed(text);
  const shown = preview.to ?? person;
  const spec = modeSpec(mode);
  const value = mode === 'send' ? text : query;
  // Idle, the box says Tab is there: what else the bar does is never a hidden key (2026-11-20).
  const placeholder = spec ? spec.placeholder : recording ? 'Speak now…' : voiceOff ? 'Type a message, or Tab to see what you can do' : 'Speak or type, or Tab to see what you can do';

  return (
    <div
      className={`${surface === 'panel' ? 'qb-bar qb-bar-panel' : 'qb-bar'}${pictureInput.dragOver ? ' qb-drag-over' : ''}`}
      role="dialog"
      aria-label="Quick bar"
      data-recording={recording ? 'true' : 'false'}
      data-mode={mode}
      onKeyDown={onKeyDown}
      {...(mode === 'send' ? pictureInput.dropProps : {})}
    >
      <div className="qb-row">
        <button
          type="button"
          className={`qb-mic${recording ? ' qb-mic-on' : ''}${voiceOff ? ' qb-mic-off' : ''}`}
          aria-label={recording ? 'Stop listening' : 'Start listening'}
          title={voiceOff ? 'Voice input is not set up (Settings, Voice)' : recording ? 'Stop listening (Esc)' : 'Speak'}
          onClick={() => (recording ? void finishTake() : startTake())}
          disabled={(voiceOff || mode !== 'send') && !recording}
        >
          <MicGlyph level={recording ? stt.level : 0} />
        </button>
        {spec ? (
          <button type="button" className={`qb-to qb-mode-chip qb-mode-${mode}`} onClick={() => enterMode('send')} aria-label={`${spec.chip}. Back to the message`} title="Back to the message (Esc)">
            <span className="qb-to-name">{spec.chip}</span>
            <span className="qb-mode-x" aria-hidden="true">×</span>
          </button>
        ) : (
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
        )}
        <textarea
          ref={boxRef}
          className="qb-text"
          data-draft-key={draft.key ?? undefined}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={spec ? spec.action : 'Message'}
          onChange={(e) => {
            if (mode !== 'send') { setQuery(e.target.value); return; }
            setText(e.target.value);
            setNotice(null);
            if (!e.target.value.trim()) addressTaken.current = false;
          }}
          onPaste={mode === 'send' ? pictureInput.onPaste : undefined}
          spellCheck={false}
        />
        {recording ? <Waveform level={stt.level} /> : mode === 'send' && <AttachPictureButton pictures={pictures} className="qb-attach" testId="qb-attach" />}
      </div>
      {mode === 'send' && <PictureStrip pictures={pictures} className="qb-shots" testId="qb-pictures" />}
      {countdownAt !== null && <div key={countdownAt} className="qb-count" style={{ animationDuration: `${SEND_COUNTDOWN_MS}ms` }} />}
      {picking && (
        <QuickBarPicker
          sections={sections}
          current={shown}
          onPick={pick}
          onClose={() => { setPicking(false); boxRef.current?.focus(); }}
          modes={MODES}
          // During a take the words are a message: Enter still picks who gets them.
          startOnPeople={recording || stt.isTranscribing}
          // The words in the box become the search or the question; Esc brings them back.
          onMode={(next) => { const words = text.trim(); enterMode(next, words, words.length > 0); }}
        />
      )}
      {(mode === 'tasks' || mode === 'notes') && <QuickBarResults ref={resultsRef} mode={mode} query={query} onOpen={openResult} />}
      {mode === 'ask' && <QuickBarAsk turns={asking.turns} onTask={(taskId) => openResult({ key: taskId, title: '', sub: '', to: taskPath(taskId) })} />}
      <QuickBarFoot
        mode={mode}
        recording={recording}
        transcribing={stt.isTranscribing}
        micLive={stt.micLive}
        counting={countdownAt !== null}
        to={shown}
        note={notice ?? stt.error ?? stt.silenceWarning ?? (stt.isRecording ? stt.draftNotice : null) ?? null}
        peopleFailed={peopleFailed}
        onRetryPeople={loadPeople}
        typedMode={typedMode}
        // The Tab list shows the modes itself: no second row of them under it.
        empty={!text.trim() && !picking}
        onMode={(next) => enterMode(next)}
        canCapture={!!onCapture}
      />
    </div>
  );
});

