/**
 * The prompt cards a session timeline answers in place: a permission request
 * (Allow / Deny, or an ACP adapter's own options) and AskUserQuestion. One
 * store per request id (web/src/stores/permission-request-store.ts).
 *
 * Phone rules (spec 4.2, 4.7 "Permission prompt"; C31, C60, C82, C84): taps
 * are ignored for 500 ms after a card appears or moves (useArmAfterAppear);
 * the tap disables both buttons in the same frame; a settled card holds its
 * height 300 ms before it collapses to its result line; a failure keeps the
 * card and gives the buttons back. The command reads in full: over 6 lines it
 * shows the first 3, an ellipsis and the last 3, with `Show all (N lines)`.
 */
import { ICON_WARNING } from '@/components/common/Icons';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRowDisclosure } from './row-disclosure';
import { createPortal } from 'react-dom';
import { usePhoneLayerWithBar } from './phone-session-layer';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useArmAfterAppear, useHoldSettled } from '@/hooks/useArmAfterAppear';
import { foldLongCommand } from './tool-call-grouping';
import { ChevronRightIcon, QuestionCircleIcon } from '@/components/common/PhoneIcons';
import { AnswerBox } from '@/components/common/AnswerBox';
import { PermissionNoteBox } from './PermissionNoteBox';
import { useImageAttachments, type ImageAttachments } from '@/components/common/image-attachments';
import type { ImageAttachment } from '@/api/chat';
import type { BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps, useDictationGroup } from '@/hooks/useSendAfterDictation';
import { useDraftValue } from '@/hooks/useDraft';
import { askAnswerDraftKey, permissionNoteDraftKey } from '@/utils/drafts';
import {
  isSettledPermission, respondToPermissionRequest, usePermissionRequest,
  type PermissionRequestStatus,
} from '@/stores/permission-request-store';
import { parseAskUserQuestionInput, buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection, type AskQuestion } from './ask-user-question';
import { denyNoteMessage, noteOfDenyMessage, promptKeyHint, splitPromptHint, promptKeyRange, choiceKeys, promptKeyList, usePromptKeyFocus, usePromptKeys, usePromptKeyTarget } from './prompt-keys';
import { AnswerText, RuleDetail } from './RuleDetail';
import { callAnswerText, useToolDecisions } from './waiting-tools';

/** One question's own-words answer, with the composer's mic. The card's Submit
 *  waits for this mic's words (`answerMic`), then settles the card. */
function AskOtherInput({ placeholder, value, disabled, onChange, onEnter, draftKey, answerMic, pictures }: {
  placeholder: string; value: string; disabled: boolean; onChange: (v: string) => void; draftKey: string | null;
  /** Enter in the box (Shift+Enter is a new line), as in the permission note box. */
  onEnter: () => void;
  answerMic: RefObject<BoxMicHandle | null>;
  /** The card's pictures (one set per ask, shown under its last question). */
  pictures?: ImageAttachments;
}) {
  return (
    <AnswerBox
      className="qp-input-row"
      inputClassName="qp-input"
      draftKey={draftKey}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={onChange}
      onSubmit={onEnter}
      maxRows={4}
      micRef={answerMic}
      pictures={pictures}
    />
  );
}

/** Inline AskUserQuestion card: the CLI's multiple-choice tool, answered for real.
 *
 * AskUserQuestion is a requiresUserInteraction tool whose control_request reaches
 * walnut in EVERY mode (including bypass). Allowing it without `answers` makes the
 * CLI tell the model "user answered your questions" with nothing in it, so this card
 * renders the real options and submits the chosen labels as `answers`
 * (question text to label / free text). Option pills reuse the Personal AI's
 * QuestionPopover `qp-*` styles; the frame keeps the permission-card classes. */
function AskUserQuestionCard({ questions, onSubmit, onDismiss, status, busy, answered }: {
  questions: AskQuestion[];
  onSubmit: (answers: Record<string, string>, images?: ImageAttachment[]) => void;
  onDismiss: () => void;
  status: PermissionRequestStatus;
  /** A response is in flight: the controls lock, but the card already shows the
   *  optimistic outcome (the store settles on click, not on the round-trip). */
  busy?: boolean;
  answered?: Record<string, string>;
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // The own-words answers are a draft of this ask (the toast, the panel and the card share it).
  const otherDraft = useDraftValue<Record<string, string>>(askAnswerDraftKey(questions), {});
  const { value: otherText, setValue: setOtherText } = otherDraft;
  // Settled (answered or dismissed, here or on another surface) and landed: the words are spent.
  // Not while the answer is still on the wire: a failure rolls back to pending with them kept.
  const settledNow = isSettledPermission(status) && !busy;
  const clearOther = otherDraft.clear;
  useEffect(() => { if (settledNow) clearOther(); }, [settledNow, clearOther]);
  // Pictures with the answers, sent in the same request (RespondOptions.images); spent once it settles.
  const pictures = useImageAttachments();
  const { clear: clearPictures } = pictures;
  useEffect(() => { if (settledNow) clearPictures(); }, [settledNow, clearPictures]);
  const phone = usePhoneLayout();
  const arm = useArmAfterAppear<HTMLDivElement>(undefined, phone && !isSettledPermission(status));
  const locked = !!busy || !arm.armed;
  // Number keys answer this question; a single-choice pick moves to the next.
  const [activeQ, setActiveQ] = useState(0);
  // The last pick made with a digit, so Esc can take it back (as on the permission card).
  const [keyPick, setKeyPick] = useState<{ qi: number; before: string[] } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const armRef = arm.ref;
  const setCardRef = useCallback((el: HTMLDivElement | null) => { cardRef.current = el; armRef(el); }, [armRef]);

  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);
  const resolvedAnswers = answered ?? buildAskUserAnswers(questions, selections, otherText);

  // Each question's own-words mic, and all of them as the one control Submit waits on.
  const { micOf, group: answerMic } = useDictationGroup<BoxMicHandle>();
  const submitNow = () => {
    if (!complete || locked) return;
    onSubmit(buildAskUserAnswers(questions, selections, otherText), pictures.images.length ? pictures.images : undefined);
  };
  const gate = useSendAfterDictation([answerMic], submitNow);

  const pick = (qi: number, label: string) => {
    const q = questions[qi];
    if (!q) return;
    setSelections(prev => ({ ...prev, [q.question]: toggleAskUserSelection(prev[q.question], label, q.multiSelect) }));
    setActiveQ(!q.multiSelect && qi < questions.length - 1 ? qi + 1 : qi);
  };
  const answeredQ = (q: AskQuestion) => (selections[q.question]?.length ?? 0) > 0 || !!otherText[q.question]?.trim();
  const keyQ = Math.min(activeQ, questions.length - 1);
  const keysOn = usePromptKeys(cardRef, {
    onDigit: (n) => {
      const q = questions[keyQ];
      if (locked || !q || n > q.options.length) return false;
      setKeyPick({ qi: keyQ, before: selections[q.question] ?? [] });
      pick(keyQ, q.options[n - 1].label);
      return true;
    },
    onEnter: () => {
      if (locked) return false;
      if (complete) { gate.send(); return true; }
      // Not all answered: Enter moves on from an answered question to the next open one.
      const q = questions[keyQ];
      const next = questions.findIndex((x, i) => i > keyQ && !answeredQ(x));
      if (!q || !answeredQ(q) || next < 0) return false;
      setActiveQ(next);
      return true;
    },
  }, !isSettledPermission(status) && !phone);
  const keyFocus = usePromptKeyFocus(cardRef, keysOn);
  const keyTarget = usePromptKeyTarget(cardRef, keysOn);
  const keysElsewhere = keysOn && keyTarget.several && !keyTarget.target;

  if (isSettledPermission(status)) {
    return (
      <div className={`permission-request-card${settledCardClass(status)}`}>
        <div className="permission-request-header">
          <span className="permission-request-icon">{status === 'allowed' ? '\u2713' : '\u2717'}</span>
          <span className="permission-request-tool">AskUserQuestion</span>
        </div>
        {status === 'allowed' ? (
          <div className="permission-request-resolved permission-request-resolved--allowed">
            {Object.entries(resolvedAnswers).length > 0
              ? Object.entries(resolvedAnswers).map(([q, a]) => (
                <div key={q} className="ask-user-answer-line">{q} {'\u2192'} {a}</div>
              ))
              : 'Answered'}
          </div>
        ) : status === 'denied' ? (
          <div className="permission-request-resolved permission-request-resolved--denied">Dismissed</div>
        ) : (
          /* Settled without this browser seeing the outcome: say that, never
             "Dismissed" (which claims the user did it). */
          <div className="permission-request-resolved">{SETTLED_LABEL[status]}</div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setCardRef}
      onClickCapture={arm.guard}
      // Esc takes back the last digit pick (the panel's own Esc runs when there is none).
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !keyPick || !keysOn) return;
        const q = questions[keyPick.qi];
        if (!q) return;
        e.preventDefault();
        e.stopPropagation();
        setSelections((prev) => ({ ...prev, [q.question]: keyPick.before }));
        setActiveQ(keyPick.qi);
        setKeyPick(null);
        cardRef.current?.focus({ preventScroll: true });
      }}
      tabIndex={keysOn ? -1 : undefined}
      className={`permission-request-card ask-user-question-card is-pending${arm.armed ? '' : ' is-arming'}${keysOn && keyTarget.several && keyTarget.target ? ' is-key-target' : ''}`}
      data-prompt-pending={busy ? undefined : 'true'}
      data-prompt-tool="AskUserQuestion"
    >
      <div className="permission-request-header">
        <span className="permission-request-icon" aria-hidden="true"><QuestionCircleIcon size={14} /></span>
        <span className="permission-request-title">Agent has a question</span>
      </div>
      {questions.map((q, qi) => {
        const picked = selections[q.question] ?? [];
        const keyed = keysOn && qi === keyQ;
        return (
          <div key={q.question} className={`ask-user-question${keyed && questions.length > 1 ? ' is-key-active' : ''}`}>
            {q.header && <div className="qp-chip">{q.header}</div>}
            <div className="qp-question">{q.question}</div>
            {q.options.length > 0 && (
              <div className={`qp-options${phone ? ' qp-options--rows' : ''}`} role={phone ? (q.multiSelect ? 'group' : 'radiogroup') : undefined}>
                {q.options.map((opt, oi) => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`qp-option ${picked.includes(opt.label) ? 'qp-option-selected' : ''}${phone ? (q.multiSelect ? ' qp-option--check' : ' qp-option--radio') : ''}${keyed && oi < 9 ? ' qp-option--keyed' : ''}`}
                    title={opt.description}
                    disabled={locked}
                    aria-keyshortcuts={keyed && oi < 9 ? String(oi + 1) : undefined}
                    {...(phone ? { role: q.multiSelect ? 'checkbox' : 'radio', 'aria-checked': picked.includes(opt.label) } : {})}
                    onClick={() => { setKeyPick(null); pick(qi, opt.label); }}
                  >
                    {keyed && oi < 9 && <kbd className="prompt-key" aria-hidden="true">{oi + 1}</kbd>}
                    {phone && <span className="qp-option-mark" aria-hidden="true" />}
                    {phone ? <span className="qp-option-label">{opt.label}</span> : opt.label}
                    {/* A description that only repeats the label says nothing. */}
                    {opt.description && opt.description.trim() !== opt.label.trim() && <span className="qp-option-desc">{opt.description}</span>}
                  </button>
                ))}
              </div>
            )}
            <AskOtherInput
              placeholder={q.options.length > 0 ? 'Other (type your own answer)...' : 'Type your answer...'}
              value={otherText[q.question] ?? ''}
              disabled={locked}
              onChange={(v) => setOtherText(prev => ({ ...prev, [q.question]: v }))}
              // Enter sends a whole set of answers; with some still open it moves to the next one.
              onEnter={() => {
                if (complete) { gate.send(); return; }
                const next = questions.findIndex((x, i) => i !== qi && !answeredQ(x));
                if (next >= 0) setActiveQ(next);
              }}
              draftKey={otherDraft.key}
              answerMic={micOf(q.question)}
              {...(qi === questions.length - 1 ? { pictures } : {})}
            />
          </div>
        );
      })}
      {phone && !complete && <div className="ask-user-submit-hint">Answer every question to submit.</div>}
      {keysOn && questions[keyQ]?.options.length > 0 && (
        <div className="permission-request-keyhint" aria-hidden="true">
          {promptKeyHint(keyFocus, keyPick
            // Picked with a digit: what Enter does, in the permission card's words ("Enter: Allow once").
            ? `${complete ? (questions.length === 1 ? `Enter: ${(selections[questions[keyPick.qi]?.question ?? ''] ?? []).join(', ')}` : 'Enter: submit') : 'Enter: next question'} \u00b7 Esc: undo`
            : `${promptKeyRange(questions[keyQ].options.length)} to choose${questions.length > 1 ? ` (question ${keyQ + 1} of ${questions.length})` : ''}${complete || questions.length === 1 ? ', Enter to submit' : ', Enter to go to the next question'}`, `${complete || questions.length === 1 ? 'Enter to submit' : 'Enter to go to the next question'} \u00b7 Shift+Enter for a new line`, keysElsewhere)}
        </div>
      )}
      <div className="permission-request-actions">
        <button
          className="permission-request-btn permission-request-btn--allow"
          disabled={(!complete && !gate.micBusy && !gate.waiting) || locked}
          onClick={gate.send}
          {...dictationWaitProps(gate)}
        >
          {busy ? 'Sending...' : 'Submit'}
        </button>
        <button
          className="permission-request-btn permission-request-btn--deny"
          disabled={locked}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** One answer on a permission card: an ACP adapter's or Claude's option, or the plain Allow / Deny. */
interface PromptChoice {
  key: string;
  label: string;
  /** What a remembering option allows (`Bash(npm test:*)`), from the server. */
  detail?: string;
  allow: boolean;
  optionId?: string;
  /** This deny carries the note box's words to the agent. */
  takesNote: boolean;
  /** Where a standing rule is written (`.claude/settings.local.json`). */
  savedTo?: string;
  /** Remembers a rule (a session or a standing one): never styled as the plain yes. */
  remembers: boolean;
}

/** What a settled card says, from what this browser sent (`chosen`: the option it picked). */
function settledLabel(status: PermissionRequestStatus, chosen?: PromptChoice, message?: string, byMessage?: boolean): string {
  // Beside remembering choices, the plain yes reads as the one it was.
  if (status === 'allowed' && chosen?.optionId === 'allow_once') return 'Allowed once';
  if (status === 'allowed' && chosen?.optionId && chosen.optionId !== 'allow_once') {
    // A Claude prompt's remembering choices (they carry their rule) read as what they did.
    if (chosen.detail && chosen.optionId === 'allow_session') return 'Allowed for this session';
    if (chosen.detail && chosen.optionId === 'allow_always') return chosen.label === 'Always allow' ? 'Always allowed' : 'Always allowed in this project';
    return `Allowed: ${chosen.label}`;
  }
  const note = status === 'denied' ? noteOfDenyMessage(message) : null;
  if (note) return `Denied with note \u201C${note}\u201D`;
  // The person's message to the session denied it (markDeniedByMessage), not a Deny here.
  if (status === 'denied' && byMessage) return 'Denied by your message';
  return SETTLED_LABEL[status];
}

/** Inline permission request card for sensitive operations.
 *
 * The choices: an ACP adapter's own options (Allow Once / Allow for Session /
 * prefix amendment / Reject), a Claude prompt's options built by the server from
 * the CLI's suggested rules (Allow / Allow for this session / Always allow in
 * this project / Deny; claude-permission-options.ts), or the plain Allow / Deny.
 * A Claude deny can carry a note, which the agent reads as the tool's result.
 * On a keyboard, 1..N picks a choice and Enter sends it (prompt-keys.ts). */
export function PermissionRequestCard({ sessionId, requestId, toolName, input, reason, initialStatus, acpOptions, toolUseId }: {
  sessionId: string; requestId: string; toolName: string;
  /** The call it gates: the server's line for it says how it was answered from anywhere. */
  toolUseId?: string;
  input?: Record<string, unknown>; reason?: string;
  initialStatus?: 'pending' | 'allowed' | 'denied';
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string; detail?: string; takesNote?: boolean; savedTo?: string }>;
}) {
  // ONE store per request id, shared with the notification rail card and the
  // toast (web/src/stores/permission-request-store.ts). This card used to seed a
  // private useState ONCE from `initialStatus` and never re-read it: blocks
  // render under index keys, so nothing remounted it: which is why answering
  // from the rail left Approve/Deny armed here, and clicking them 404'd and
  // stamped "Denied" on a request the user had just approved.
  const stored = usePermissionRequest(requestId);
  const serverLine = useToolDecisions().get(toolUseId ?? '');
  // Fallback for a card the store has never seen: a reloaded page, or an entry
  // trimmed by the store's cap. The stream block's own status is the record.
  const status: PermissionRequestStatus = stored?.status
    ?? (initialStatus && initialStatus !== 'pending' ? initialStatus : 'pending');
  const busy = stored?.inFlight ?? false;
  const [inputExpanded, setInputExpanded] = useRowDisclosure(`perm-input-${requestId}`, false);
  const phone = usePhoneLayout();
  const settled = isSettledPermission(status);
  // Phone: the answered card keeps its pending face (buttons off) for 300 ms.
  const holding = useHoldSettled(settled, 300, phone);
  // AskUserQuestion answers ARE the permission response (see AskUserQuestionCard),
  // and that card arms its own controls: this card's arm is for Allow / Deny.
  const askQuestions = toolName === 'AskUserQuestion' ? parseAskUserQuestionInput(input) : null;
  const arm = useArmAfterAppear<HTMLDivElement>(undefined, phone && !settled && !askQuestions);
  const [tapped, setTapped] = useState<string | null>(null);
  // The choice number keys picked; Enter sends it.
  const [picked, setPicked] = useState<number | null>(null);
  // The server held a pick it cannot carry out (its rule's file cannot be written): the pick
  // goes, so Enter never repeats it; the line under the card says why.
  const failReason = stored?.failReason;
  useEffect(() => { if (failReason) setPicked(null); }, [failReason]);
  const heldChoice = failReason && stored?.failed ? stored.optionId : undefined;
  // A digit for an Allow while a note is typed: said in the hint for a moment.
  const [noteBlocked, setNoteBlocked] = useState(false);
  const blockTimer = useRef<number | null>(null);
  const flashNoteBlock = () => {
    setNoteBlocked(true);
    if (blockTimer.current) window.clearTimeout(blockTimer.current);
    blockTimer.current = window.setTimeout(() => setNoteBlocked(false), 2000);
  };
  useEffect(() => () => { if (blockTimer.current) window.clearTimeout(blockTimer.current); }, []);
  // Enter with nothing picked: the hint says to pick first, for a moment, so the key never reads as lost.
  const [enterEarly, setEnterEarly] = useState(false);
  const earlyTimer = useRef<number | null>(null);
  const flashPickFirst = () => {
    setEnterEarly(true);
    if (earlyTimer.current) window.clearTimeout(earlyTimer.current);
    earlyTimer.current = window.setTimeout(() => setEnterEarly(false), 2000);
  };
  useEffect(() => () => { if (earlyTimer.current) window.clearTimeout(earlyTimer.current); }, []);
  // The note is a draft of this prompt: a reload or another surface keeps the words.
  const noteDraft = useDraftValue<string>(permissionNoteDraftKey(requestId), '');
  const { value: note, setValue: setNote, clear: clearNote } = noteDraft;
  useEffect(() => { if (settled && !busy) clearNote(); }, [settled, busy, clearNote]);
  const face: PermissionRequestStatus = holding ? 'pending' : status;
  const locked = busy || holding || !arm.armed;
  // The card element for the number keys, beside the arm's own (callback) ref.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const armRef = arm.ref;
  const setCardRef = useCallback((el: HTMLDivElement | null) => { cardRef.current = el; armRef(el); }, [armRef]);

  const handleResponse = (allow: boolean, optionId?: string, message?: string, answers?: Record<string, string>, images?: ImageAttachment[], key?: string) => {
    if (locked) return;
    setTapped(key ?? optionId ?? (allow ? 'allow' : 'deny'));
    void respondToPermissionRequest(sessionId, requestId, allow, {
      ...(optionId ? { optionId } : {}),
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {}),
      ...(images?.length ? { images } : {}),
    });
  };
  const btnBusy = (key: string) => ((busy || holding) && tapped === key ? ' is-busy' : '');

  const inputPreview = input ? JSON.stringify(input, null, 2) : null;
  const command = typeof input?.command === 'string' ? input.command : null;
  const description = typeof input?.description === 'string' && input.description.trim() ? input.description.trim() : null;
  // A file tool's ask names its file on the card (the toast does): what a yes would touch is read first.
  const filePath = command ? null : typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : null;
  const writtenLines = filePath && typeof input?.content === 'string' ? input.content.split('\n').length : null;
  // Plan approval reads as one on a phone: the plan's head, Approve / Keep planning (C83).
  const planText = toolName === 'ExitPlanMode' && typeof input?.plan === 'string' ? input.plan : null;
  const allowLabel = phone && planText !== null ? 'Approve' : 'Allow';
  const denyLabel = phone && planText !== null ? 'Keep planning' : 'Deny';
  const validAcpOptions = (acpOptions ?? []).filter(
    (o): o is { optionId: string; kind?: string; name?: string; detail?: string; takesNote?: boolean; savedTo?: string } => !!o.optionId,
  );
  const { hint: promptHint, options: hintedOptions } = splitPromptHint(validAcpOptions);
  const choices: PromptChoice[] = hintedOptions.length > 0
    ? hintedOptions.map((o) => {
      const reject = o.kind?.startsWith('reject') ?? false;
      return {
        key: o.optionId, label: o.name ?? o.optionId, allow: !reject, optionId: o.optionId,
        takesNote: reject && o.takesNote === true, remembers: !reject && o.kind === 'allow_always',
        ...(o.detail ? { detail: o.detail } : {}), ...(o.savedTo ? { savedTo: o.savedTo } : {}),
      };
    })
    // The plain pair is a Claude prompt's (an ACP prompt always lists its options): its deny takes a note.
    : [
      { key: 'allow', label: allowLabel, allow: true, takesNote: false, remembers: false },
      { key: 'deny', label: denyLabel, allow: false, takesNote: true, remembers: false },
    ];
  const noteChoice = choices.find((c) => c.takesNote) ?? null;
  const keys = choiceKeys(choices.map((c) => c.optionId));
  const noteText = note.trim();
  // A note goes only with Deny: an Allow picked before it was typed is no longer lit.
  const pickedAllows = picked !== null && !!choices[picked] && !choices[picked].takesNote;
  useEffect(() => { if (noteText && pickedAllows) setPicked(null); }, [noteText, pickedAllows]);
  const noteIndex = noteChoice ? choices.indexOf(noteChoice) : -1;
  const pending = face === 'pending';

  const send = (c: PromptChoice) => {
    const message = c.takesNote && noteText ? denyNoteMessage(noteText) : undefined;
    handleResponse(c.allow, c.optionId, message, undefined, undefined, c.key);
  };
  // Keyboard: a digit picks, Enter sends the pick (or, with a note typed, the deny).
  const keysOn = usePromptKeys(cardRef, {
    onDigit: (n) => {
      const at = keys.indexOf(n);
      if (locked || at < 0) return false;
      // A typed note goes only with Deny: an Allow would drop it unsaid. The key is
      // taken and the hint says why, so a forgotten note never reads as a dead key.
      if (noteText && !choices[at].takesNote) { flashNoteBlock(); return true; }
      setPicked(at);
      // Focus goes with the pick, so Enter (the focused button's own click) sends what is lit.
      cardRef.current?.querySelector<HTMLButtonElement>(`button[data-choice-index="${at}"]`)?.focus({ preventScroll: true });
      cardRef.current?.scrollIntoView?.({ block: 'nearest' });
      return true;
    },
    onEnter: () => {
      if (locked) return false;
      // A typed note goes only with Deny: Enter sends it, as the hint says.
      if ((picked === null || !choices[picked]) && noteText && noteChoice) { send(noteChoice); return true; }
      if (picked === null || !choices[picked]) { flashPickFirst(); return true; }
      send(choices[picked]);
      return true;
    },
  }, pending && !askQuestions && !phone);
  const keyFocus = usePromptKeyFocus(cardRef, keysOn);
  const keyTarget = usePromptKeyTarget(cardRef, keysOn);

  if (askQuestions) {
    return (
      <AskUserQuestionCard
        questions={askQuestions}
        status={face}
        busy={busy || holding}
        {...(stored?.answers ? { answered: stored.answers } : {})}
        onSubmit={(answers, images) => handleResponse(true, undefined, undefined, answers, images)}
        onDismiss={() => handleResponse(false, undefined, 'User dismissed the questions')}
      />
    );
  }

  // On a desktop every set reads as one numbered list (a solid green Allow beside a lone
  // Deny looked chosen before anything was); a phone keeps its big pair unless rules ride along.
  const asRows = !phone || choices.some((c) => c.detail);
  const label = (c: PromptChoice) => (c.takesNote && noteText ? `${c.label} with note` : c.label);

  return (
    <div
      ref={setCardRef}
      onClickCapture={arm.guard}
      // Esc takes back a pick made with a digit (the panel's own Esc runs only when nothing is picked).
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || picked === null || !keysOn) return;
        e.preventDefault();
        e.stopPropagation();
        setPicked(null);
        cardRef.current?.focus({ preventScroll: true });
      }}
      // A click on the card's own face takes focus, so its keys answer it.
      tabIndex={keysOn ? -1 : undefined}
      className={`permission-request-card${settledCardClass(face)}${pending ? ' is-pending' : ''}${pending && !arm.armed ? ' is-arming' : ''}${keysOn && keyTarget.several && keyTarget.target ? ' is-key-target' : ''}`}
      data-prompt-pending={pending && !holding ? 'true' : undefined}
      data-prompt-tool={toolName}
      data-request-id={requestId}
    >
      <div className="permission-request-header">
        {/* The toast's and the panel's warning sign while it waits, so all three read as one ask. */}
        <span className="permission-request-icon">{face === 'allowed' ? '\u2713' : face === 'denied' ? '\u2298' : ICON_WARNING}</span>
        <span className="permission-request-tool">{toolName}</span>
        {/* Once answered, "requires approval" is no longer true: the outcome below says what happened. */}
        {reason && pending && <span className="permission-request-reason">{reason}</span>}
      </div>
      {/* The agent's own words for what the call does, as the toast and the panel show them. */}
      {description && <div className="permission-request-description">{description}</div>}
      {phone && command && <PhoneCommandPreview command={command} />}
      {phone && planText !== null && <PhonePlanPreview plan={planText} id={requestId} />}
      {/* What a remembering choice would allow is judged against the command itself: show it,
          and keep it once answered, so the card still says what was allowed or denied. */}
      {!phone && command && (
        <pre className={`permission-request-command${pending ? '' : ' is-settled'}`} data-testid="permission-request-command" title={pending ? undefined : command}>
          {/* Answered: two whole lines; the clamp sits inside the padding, so no third line peeks out. */}
          {pending ? command : <span className="permission-request-command-clamp">{command}</span>}
        </pre>
      )}
      {filePath && (
        <div className="permission-request-file" data-testid="permission-request-file">
          <code className="permission-request-file-path">{filePath}</code>
          {writtenLines !== null && <span className="permission-request-file-meta">{writtenLines === 1 ? '1 line' : `${writtenLines} lines`}</span>}
        </div>
      )}
      {inputPreview && (
        <div className="permission-request-input">
          <button className="permission-request-input-toggle" onClick={() => setInputExpanded(p => !p)}>
            <span className={`permission-request-input-chevron${inputExpanded ? ' is-open' : ''}`} aria-hidden="true"><ChevronRightIcon size={10} /></span> Input
          </button>
          {inputExpanded && <pre className="permission-request-input-preview">{inputPreview}</pre>}
        </div>
      )}
      {pending && promptHint && <div className="perm-prompt-hint">{promptHint}</div>}
      {pending && (
        <div
          className={`permission-request-actions${validAcpOptions.length > 0 ? ' permission-request-actions--options' : ''}${asRows ? ' permission-request-actions--rows' : ''}`}
          role="group"
          aria-label="Answer"
        >
          {choices.map((c, i) => (
            <button
              key={c.key}
              type="button"
              className={`permission-request-btn ${c.allow ? 'permission-request-btn--allow' : 'permission-request-btn--deny'}${asRows ? ' permission-request-choice' : ''}${c.remembers ? ' is-remembering' : ''}${picked === i ? ' is-picked' : ''}${noteText ? (c.takesNote ? ' is-noted' : ' is-muted') : ''}${heldChoice === c.optionId && picked !== i ? ' is-failed' : ''}${btnBusy(c.key)}`}
              data-choice={c.optionId ?? c.key}
              data-choice-index={i}
              aria-keyshortcuts={keysOn && keys[i] <= 9 ? String(keys[i]) : undefined}
              title={noteText && !c.takesNote ? 'Clear the note to allow; a note goes with Deny' : c.detail}
              disabled={locked || (!!noteText && !c.takesNote)}
              onClick={() => {
                // Kept in a settings file: the first click picks it (as its digit would), the second keeps the rule.
                if (c.savedTo && picked !== i) {
                  setPicked(i);
                  cardRef.current?.querySelector<HTMLButtonElement>(`button[data-choice-index="${i}"]`)?.focus({ preventScroll: true });
                  return;
                }
                send(c);
              }}
            >
              {keysOn && keys[i] <= 9 && <kbd className="prompt-key" aria-hidden="true">{keys[i]}</kbd>}
              {asRows ? (
                <span className="permission-choice-text">
                  <span className="permission-choice-label">{label(c)}</span>
                  {/* Every rule the choice adds, one per line, in full: the grant is read before it is given. */}
                  {c.detail && <span className="permission-choice-detail"><RuleDetail text={c.detail} /></span>}
                  {/* The server held this choice: why, where it was picked. */}
                  {heldChoice === c.optionId && picked !== i ? <span className="permission-choice-failed" role="alert">{failReason}</span>
                    : c.savedTo && <span className={`permission-choice-saved${picked === i ? ' perm-option-confirm' : ''}`} title={`Saves to ${c.savedTo}`}>{picked === i ? <>Click again or press Enter to save to <span className="perm-saved-file">{c.savedTo}</span></> : <>Saves to <span className="perm-saved-file">{c.savedTo}</span></>}</span>}
                </span>
              ) : (
                <span className="permission-choice-label">{label(c)}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {pending && noteChoice && (
        <PermissionNoteBox
          value={note}
          draftKey={noteDraft.key}
          disabled={locked}
          denyLabel={noteChoice.label}
          onChange={setNote}
          onSubmit={() => send(noteChoice)}
        />
      )}
      {/* A typed note goes only with Deny: said in words, as the toast and the panel say it. */}
      {pending && noteText && choices.some((c) => c.allow) && (
        <div className={`permission-request-note-off${noteBlocked ? ' is-blocked' : ''}`}>Allow is off while a note is typed. Clear it to allow.</div>
      )}
      {keysOn && (
        <div className={`permission-request-keyhint${noteBlocked || enterEarly ? ' is-blocked' : ''}`} aria-hidden="true">
          {promptKeyHint(keyFocus, picked !== null && choices[picked]
            // A pick made: say what Enter sends, and how to take it back.
            ? `Enter: ${choices[picked].savedTo ? `save to ${choices[picked].savedTo}` : label(choices[picked])} \u00b7 Esc: undo`
            // A note waiting (perhaps one left from earlier): only its Deny is open.
            : noteText && noteChoice
              ? `Enter: ${label(noteChoice)}`
              : enterEarly ? `Pick ${promptKeyList(keys)} first, then Enter` : `${promptKeyList(keys)} to choose, Enter to send`,
            noteText ? `Enter sends this note with ${noteChoice?.label ?? 'Deny'}` : 'Type what the agent should do instead',
            keyTarget.several && !keyTarget.target)}
        </div>
      )}
      {face === 'allowed' && (() => {
        const chosen = choices.find((c) => c.optionId && c.optionId === stored?.optionId)
        // A card this page did not answer (a reload, another device, the toast) still names
        // the choice: the server's line for the call says which one it was.
        const fromServer = !chosen && serverLine && /^(Allowed|Always allowed)/.test(serverLine) ? callAnswerText(serverLine, command ?? undefined) : null
        return (
          <div className="permission-request-resolved permission-request-resolved--allowed">
            {fromServer ?? settledLabel(face, chosen)}
            {/* The rule it kept stays readable after the card settles. */}
            {chosen?.remembers && chosen.detail && <span className="permission-request-resolved-detail">{chosen.detail}</span>}
            {/* Where a kept rule went, so it can be found to take back. */}
            {chosen?.savedTo && <span className="permission-request-resolved-detail">Saved to {chosen.savedTo}</span>}
          </div>
        )
      })()}
      {/* 'stale' and 'expired' are NOT the user's Deny: the first means the ask
          settled somewhere else and we never learned which way, the second that
          the server withdrew it. Naming them as such is the whole point of the
          shared store: this card used to print "Denied" for both. */}
      {(face === 'denied' || face === 'stale' || face === 'expired') && (
        <div className={`permission-request-resolved permission-request-resolved--${face === 'denied' ? 'denied' : 'stale'}`}>
          <AnswerText text={settledLabel(face, undefined, stored?.message, stored?.byMessage || !!serverLine?.startsWith('Denied by your message'))} />
        </div>
      )}
      {/* A transient failure rolled the status back to pending, so the buttons
          above are armed again: say why they are still there. */}
      {pending && !holding && stored?.failed && !heldChoice && (
        <div className="permission-request-resolved permission-request-resolved--failed" role="alert">{stored.failReason ?? 'Could not send that. Try again.'}</div>
      )}
    </div>
  );
}

/** The command a phone reads before it allows it: the end is never cut off (C84). */
function PhoneCommandPreview({ command }: { command: string }) {
  const [all, setAll] = useState(false);
  const fold = foldLongCommand(command);
  return (
    <div className="permission-command-preview" data-testid="permission-command-preview">
      <pre className="permission-command-text">
        {all || !fold.folded ? command : `${fold.head.join('\n')}\n...\n${fold.tail.join('\n')}`}
      </pre>
      {fold.folded && (
        <button type="button" className="permission-command-showall" data-arm-exempt onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all (${fold.total} lines)`}
        </button>
      )}
    </div>
  );
}

/** What a settled card says. 'stale'/'expired' deliberately avoid claiming an
 *  outcome nobody in this browser witnessed. */
const SETTLED_LABEL: Record<PermissionRequestStatus, string> = {
  pending: '',
  allowed: 'Allowed',
  denied: 'Denied',
  stale: 'Already answered',
  expired: 'Session ended',
};

/** Card tint for a settled request. Only allowed/denied have a colour: a
 *  stale/expired card keeps the neutral frame rather than borrowing the red one
 *  and reading as a denial. */
function settledCardClass(status: PermissionRequestStatus): string {
  return status === 'allowed' || status === 'denied'
    ? ` permission-request-card--${status}`
    : '';
}

export const PLAN_PREVIEW_LINES = 12;

/** The plan's first 12 lines; `Show all` opens it as its own layer (back closes it). */
function PhonePlanPreview({ plan, id }: { plan: string; id: string }) {
  const [all, setAll] = useState(false);
  const lines = plan.replace(/\n+$/, '').split('\n');
  const more = lines.length > PLAN_PREVIEW_LINES;
  const { close } = usePhoneLayerWithBar({
    id: `plan:${id}`, kind: 'plan', active: all, title: 'Plan', withAction: false,
    onClose: () => setAll(false),
  });
  return (
    <div className="phone-plan-preview" data-testid="phone-plan-preview">
      <pre className="phone-plan-preview-text">{lines.slice(0, PLAN_PREVIEW_LINES).join('\n')}</pre>
      {more && (
        <button type="button" className="permission-command-showall" data-arm-exempt onClick={() => setAll(true)}>Show all</button>
      )}
      {all && createPortal(
        <div className="phone-plan-layer" data-testid="phone-plan-layer" onPointerDown={(e) => e.stopPropagation()}>
          <pre className="phone-plan-layer-text">{plan}</pre>
          <button type="button" className="permission-command-showall" onClick={close}>Close</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
