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
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePhoneLayerWithBar } from './phone-session-layer';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useArmAfterAppear, useHoldSettled } from '@/hooks/useArmAfterAppear';
import { foldLongCommand } from './tool-call-grouping';
import { ChevronRightIcon, QuestionCircleIcon } from '@/components/common/PhoneIcons';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import { BoxMic } from '@/components/common/BoxMic';
import { useDraftValue } from '@/hooks/useDraft';
import { askAnswerDraftKey } from '@/utils/drafts';
import {
  isSettledPermission, respondToPermissionRequest, usePermissionRequest,
  type PermissionRequestStatus,
} from '@/stores/permission-request-store';
import { parseAskUserQuestionInput, buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection, type AskQuestion } from './ask-user-question';

/** One question's own-words answer, with the composer's mic. A submit settles the
 *  card and unmounts this, which discards a recording still on its way. */
function AskOtherInput({ placeholder, value, disabled, onChange, draftKey }: {
  placeholder: string; value: string; disabled: boolean; onChange: (v: string) => void; draftKey: string | null;
}) {
  const box = useRef<HTMLInputElement | null>(null);
  return (
    <div className="qp-input-row">
      <input
        ref={box}
        className="qp-input"
        data-draft-key={draftKey ?? undefined}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        {...NO_AUTOFILL_PROPS}
      />
      <BoxMic boxRef={box} text={value} setText={onChange} disabled={disabled} />
    </div>
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
  onSubmit: (answers: Record<string, string>) => void;
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
  // Settled (answered or dismissed, here or on another surface): the words are spent.
  const settledNow = isSettledPermission(status);
  const clearOther = otherDraft.clear;
  useEffect(() => { if (settledNow) clearOther(); }, [settledNow, clearOther]);
  const phone = usePhoneLayout();
  const arm = useArmAfterAppear<HTMLDivElement>(undefined, phone && !isSettledPermission(status));
  const locked = !!busy || !arm.armed;

  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);
  const resolvedAnswers = answered ?? buildAskUserAnswers(questions, selections, otherText);

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
                <div key={q} className="ask-user-answer-line">{'\u00B7'} {q} {'\u2192'} {a}</div>
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
      ref={arm.ref}
      onClickCapture={arm.guard}
      className={`permission-request-card ask-user-question-card is-pending${arm.armed ? '' : ' is-arming'}`}
      data-prompt-pending={busy ? undefined : 'true'}
      data-prompt-tool="AskUserQuestion"
    >
      <div className="permission-request-header">
        <span className="permission-request-icon" aria-hidden="true"><QuestionCircleIcon size={14} /></span>
        <span className="permission-request-tool">Agent has a question</span>
      </div>
      {questions.map((q) => {
        const picked = selections[q.question] ?? [];
        return (
          <div key={q.question} className="ask-user-question">
            {q.header && <div className="qp-chip">{q.header}</div>}
            <div className="qp-question">{q.question}</div>
            {q.options.length > 0 && (
              <div className={`qp-options${phone ? ' qp-options--rows' : ''}`} role={phone ? (q.multiSelect ? 'group' : 'radiogroup') : undefined}>
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`qp-option ${picked.includes(opt.label) ? 'qp-option-selected' : ''}${phone ? (q.multiSelect ? ' qp-option--check' : ' qp-option--radio') : ''}`}
                    title={opt.description}
                    disabled={locked}
                    {...(phone ? { role: q.multiSelect ? 'checkbox' : 'radio', 'aria-checked': picked.includes(opt.label) } : {})}
                    onClick={() => setSelections(prev => ({
                      ...prev,
                      [q.question]: toggleAskUserSelection(prev[q.question], opt.label, q.multiSelect),
                    }))}
                  >
                    {phone && <span className="qp-option-mark" aria-hidden="true" />}
                    {phone ? <span className="qp-option-label">{opt.label}</span> : opt.label}
                    {opt.description && <span className="qp-option-desc">{opt.description}</span>}
                  </button>
                ))}
              </div>
            )}
            <AskOtherInput
              placeholder={q.options.length > 0 ? 'Other (type your own answer)...' : 'Type your answer...'}
              value={otherText[q.question] ?? ''}
              disabled={locked}
              onChange={(v) => setOtherText(prev => ({ ...prev, [q.question]: v }))}
              draftKey={otherDraft.key}
            />
          </div>
        );
      })}
      {phone && !complete && <div className="ask-user-submit-hint">Answer every question to submit.</div>}
      <div className="permission-request-actions">
        <button
          className="permission-request-btn permission-request-btn--allow"
          disabled={!complete || locked}
          onClick={() => onSubmit(buildAskUserAnswers(questions, selections, otherText))}
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

/** Inline permission request card: Allow/Deny buttons for sensitive operations.
 * ACP (codex) requests carry provider options (Allow Once / Allow for Session /
 * prefix amendment / Reject): render those as the real buttons so "always
 * allow" is actually reachable; the bare Allow/Deny pair could only ever send
 * allow_once, which made codex re-prompt on every retry of the same command. */
export function PermissionRequestCard({ sessionId, requestId, toolName, input, reason, initialStatus, acpOptions }: {
  sessionId: string; requestId: string; toolName: string;
  input?: Record<string, unknown>; reason?: string;
  initialStatus?: 'pending' | 'allowed' | 'denied';
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}) {
  // ONE store per request id, shared with the notification rail card and the
  // toast (web/src/stores/permission-request-store.ts). This card used to seed a
  // private useState ONCE from `initialStatus` and never re-read it: blocks
  // render under index keys, so nothing remounted it: which is why answering
  // from the rail left Approve/Deny armed here, and clicking them 404'd and
  // stamped "Denied" on a request the user had just approved.
  const stored = usePermissionRequest(requestId);
  // Fallback for a card the store has never seen: a reloaded page, or an entry
  // trimmed by the store's cap. The stream block's own status is the record.
  const status: PermissionRequestStatus = stored?.status
    ?? (initialStatus && initialStatus !== 'pending' ? initialStatus : 'pending');
  const busy = stored?.inFlight ?? false;
  const [inputExpanded, setInputExpanded] = useState(false);
  const phone = usePhoneLayout();
  const settled = isSettledPermission(status);
  // Phone: the answered card keeps its pending face (buttons off) for 300 ms.
  const holding = useHoldSettled(settled, 300, phone);
  // AskUserQuestion answers ARE the permission response (see AskUserQuestionCard),
  // and that card arms its own controls: this card's arm is for Allow / Deny.
  const askQuestions = toolName === 'AskUserQuestion' ? parseAskUserQuestionInput(input) : null;
  const arm = useArmAfterAppear<HTMLDivElement>(undefined, phone && !settled && !askQuestions);
  const [tapped, setTapped] = useState<string | null>(null);
  const face: PermissionRequestStatus = holding ? 'pending' : status;
  const locked = busy || holding || !arm.armed;

  const handleResponse = (allow: boolean, optionId?: string, message?: string, answers?: Record<string, string>) => {
    if (locked) return;
    setTapped(optionId ?? (allow ? 'allow' : 'deny'));
    void respondToPermissionRequest(sessionId, requestId, allow, {
      ...(optionId ? { optionId } : {}),
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {}),
    });
  };
  const btnBusy = (key: string) => ((busy || holding) && tapped === key ? ' is-busy' : '');

  if (askQuestions) {
    return (
      <AskUserQuestionCard
        questions={askQuestions}
        status={face}
        busy={busy || holding}
        {...(stored?.answers ? { answered: stored.answers } : {})}
        onSubmit={(answers) => handleResponse(true, undefined, undefined, answers)}
        onDismiss={() => handleResponse(false, undefined, 'User dismissed the questions')}
      />
    );
  }

  const inputPreview = input ? JSON.stringify(input, null, 2) : null;
  const command = typeof input?.command === 'string' ? input.command : null;
  // Plan approval reads as one on a phone: the plan's head, Approve / Keep planning (C83).
  const planText = toolName === 'ExitPlanMode' && typeof input?.plan === 'string' ? input.plan : null;
  const allowLabel = phone && planText !== null ? 'Approve' : 'Allow';
  const denyLabel = phone && planText !== null ? 'Keep planning' : 'Deny';
  const validAcpOptions = (acpOptions ?? []).filter(
    (o): o is { optionId: string; kind?: string; name?: string } => !!o.optionId,
  );
  const pending = face === 'pending';

  return (
    <div
      ref={arm.ref}
      onClickCapture={arm.guard}
      className={`permission-request-card${settledCardClass(face)}${pending ? ' is-pending' : ''}${pending && !arm.armed ? ' is-arming' : ''}`}
      data-prompt-pending={pending && !holding ? 'true' : undefined}
      data-prompt-tool={toolName}
      data-request-id={requestId}
    >
      <div className="permission-request-header">
        <span className="permission-request-icon">{face === 'allowed' ? '\u2713' : face === 'denied' ? '\u2717' : '!'}</span>
        <span className="permission-request-tool">{toolName}</span>
        {reason && <span className="permission-request-reason">{reason}</span>}
      </div>
      {phone && command && <PhoneCommandPreview command={command} />}
      {phone && planText !== null && <PhonePlanPreview plan={planText} id={requestId} />}
      {inputPreview && (
        <div className="permission-request-input">
          <button className="permission-request-input-toggle" onClick={() => setInputExpanded(p => !p)}>
            {inputExpanded ? '\u25BC' : <ChevronRightIcon size={10} />} Input
          </button>
          {inputExpanded && <pre className="permission-request-input-preview">{inputPreview}</pre>}
        </div>
      )}
      {pending && validAcpOptions.length > 0 && (
        <div className="permission-request-actions permission-request-actions--options">
          {validAcpOptions.map((o) => {
            const isReject = o.kind?.startsWith('reject') ?? false;
            return (
              <button
                key={o.optionId}
                className={`permission-request-btn ${isReject ? 'permission-request-btn--deny' : 'permission-request-btn--allow'}${btnBusy(o.optionId)}`}
                disabled={locked}
                onClick={() => handleResponse(!isReject, o.optionId)}
              >
                {o.name ?? o.optionId}
              </button>
            );
          })}
        </div>
      )}
      {pending && validAcpOptions.length === 0 && (
        <div className="permission-request-actions">
          <button className={`permission-request-btn permission-request-btn--allow${btnBusy('allow')}`} disabled={locked} onClick={() => handleResponse(true)}>{allowLabel}</button>
          <button className={`permission-request-btn permission-request-btn--deny${btnBusy('deny')}`} disabled={locked} onClick={() => handleResponse(false)}>{denyLabel}</button>
        </div>
      )}
      {face === 'allowed' && (
        <div className="permission-request-resolved permission-request-resolved--allowed">{SETTLED_LABEL.allowed}</div>
      )}
      {/* 'stale' and 'expired' are NOT the user's Deny: the first means the ask
          settled somewhere else and we never learned which way, the second that
          the server withdrew it. Naming them as such is the whole point of the
          shared store: this card used to print "Denied" for both. */}
      {(face === 'denied' || face === 'stale' || face === 'expired') && (
        <div className={`permission-request-resolved permission-request-resolved--${face === 'denied' ? 'denied' : 'stale'}`}>
          {SETTLED_LABEL[face]}
        </div>
      )}
      {/* A transient failure rolled the status back to pending, so the buttons
          above are armed again: say why they are still there. */}
      {pending && !holding && stored?.failed && (
        <div className="permission-request-resolved">Could not send that. Try again.</div>
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
