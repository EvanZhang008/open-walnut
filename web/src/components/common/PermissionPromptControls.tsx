/**
 * The controls that answer a session's permission prompt, shared by every
 * surface that answers one in place: the notification panel's permission card
 * and the kanban card's prompt (KanbanCardPrompt). ONE implementation, so both
 * send exactly the same thing on the wire:
 *
 * - usePermissionAnswer: the request's state from the one permission store
 *   (permission-request-store.ts), what can be answered and the respond call.
 * - PermissionAskDetail: what is being asked (the command, the plan, the file,
 *   the generic preview), from the server's compacted tool input.
 * - PermissionAnswerButtons: the AskUserQuestion form (PermissionAnswerForm),
 *   the ACP option list, or Allow / Deny.
 *
 * Each surface keeps its own frame: header, settled label, error line.
 */
import { useState, type ReactNode } from 'react';
import {
  isRejectOption, isUnanswerableAsk, permissionDetail, requestIdOf, validAcpOptions, type Notification,
} from '@/contexts/notifications';
import type { PermissionDetail } from '@/contexts/notifications/notification-model';
import {
  isSettledPermission, respondToPermissionRequest, usePermissionRequest,
  type PermissionRequestState, type PermissionRequestStatus, type RespondOptions,
} from '@/stores/permission-request-store';
import { PermissionAnswerForm } from './PermissionAnswerForm';
import { DenyWithNote, denyMessageOf, usePermissionNote } from '@/components/sessions/PermissionNoteBox';
import { noteOfDenyMessage, splitPromptHint, useSecondClick } from '@/components/sessions/prompt-keys';
import { RuleDetail, SavedFileMark } from '@/components/sessions/RuleDetail';

export interface PermissionAnswer {
  detail: PermissionDetail;
  requestId: string | null;
  stored: PermissionRequestState | undefined;
  /** A response is in flight. */
  busy: boolean;
  /** The record's own outcome, else the store's settled status. */
  resolved: NonNullable<Notification['resolved']> | PermissionRequestStatus | null;
  /** The last attempt failed and can be retried. */
  failed: boolean;
  /** There is a session and a request id, and nothing settled it yet. */
  answerable: boolean;
  /** An AskUserQuestion whose questions could not be recovered: never a blanket allow. */
  askWithoutInput: boolean;
  acpOptions: Array<{ optionId: string; kind?: string; name?: string; detail?: string; takesNote?: boolean; savedTo?: string }>;
  /** Said above the choices (splitPromptHint): why nothing here can be remembered. */
  promptHint: string | null;
  respond(allow: boolean, opts?: RespondOptions): Promise<PermissionRequestStatus | 'failed'>;
}

export function usePermissionAnswer(n: Notification): PermissionAnswer {
  const detail = permissionDetail(n);
  const requestId = requestIdOf(n);
  const stored = usePermissionRequest(requestId ?? undefined);
  const busy = stored?.inFlight ?? false;
  const sent = stored && isSettledPermission(stored.status) ? stored.status : null;
  // The record's own outcome wins: it survives a reload, the store's entry does not.
  const resolved = n.resolved ?? sent;
  const answerable = !resolved && !!n.sessionId && !!requestId;
  const hinted = splitPromptHint(validAcpOptions(n));
  const respond = async (allow: boolean, opts?: RespondOptions) => {
    if (!n.sessionId || !requestId) return 'failed' as const;
    return respondToPermissionRequest(n.sessionId, requestId, allow, {
      ...(opts?.optionId ? { optionId: opts.optionId } : {}),
      ...(opts?.answers ? { answers: opts.answers } : {}),
      ...(opts?.message ? { message: opts.message } : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    });
  };
  return {
    detail, requestId, stored, busy, resolved, failed: stored?.failed ?? false, answerable,
    askWithoutInput: isUnanswerableAsk(n, detail), acpOptions: hinted.options, promptHint: hinted.hint, respond,
  };
}

/**
 * An answered ask lets go of the focus it held (its note box, a choice), so the ask
 * that takes its place in the list never wears a focus ring nobody put there.
 */
export function releaseAnswerFocus(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.closest('.nfc-perm-card, .nfc-perm-toast')) return;
  // In the panel the focus goes back to the panel itself (Esc and the arrow keys still work there).
  const panel = el.closest<HTMLElement>('.notification-panel');
  if (!panel) { el.blur(); return; }
  if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
  panel.focus({ preventScroll: true });
}

/**
 * An answered prompt's last words in a toast or the panel: which choice went, in the
 * session card's words ("Allowed once", "Denied with note “use pnpm”", "Answered: Green"). Null leaves the
 * record's own label (resolvedLabelOf: an outcome learned from elsewhere).
 */
export function permissionOutcomeLabel(
  settled: string, stored: { optionId?: string; message?: string; byMessage?: boolean; answers?: Record<string, string> } | undefined,
  options: ReadonlyArray<{ optionId: string; name?: string; detail?: string }>, isQuestion: boolean, questionCount = 0,
): string | null {
  // What was said, whole as it went (a note is read back to check it), cut only when very long.
  const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 239)}\u2026` : text);
  if (isQuestion) {
    const said = Object.values(stored?.answers ?? {}).filter(Boolean).join('; ');
    if (settled === 'allowed') return said ? `Answered: ${clip(said)}` : 'Answered';
    if (settled !== 'denied') return null;
    return stored?.byMessage ? 'Dismissed by your message' : questionCount === 1 ? 'Question dismissed' : 'Questions dismissed';
  }
  if (!stored) return null;
  if (settled === 'allowed') {
    // A remembering choice says which rule it kept, as the session card does.
    const rule = (id: string) => {
      const detail = options.find((o) => o.optionId === id)?.detail;
      if (!detail) return '';
      // The rule that is the command itself reads as that, not "...: Bash: this exact command".
      return detail === 'Bash: this exact command' ? ' (this exact command)' : `: ${detail.split('\n').join('; ')}`;
    };
    if (stored.optionId === 'allow_session') return `Allowed for this session${rule('allow_session')}`;
    if (stored.optionId === 'allow_always') return `${options.find((o) => o.optionId === 'allow_always')?.name === 'Always allow' ? 'Always allowed' : 'Always allowed in this project'}${rule('allow_always')}`;
    return stored.optionId === 'allow_once' ? 'Allowed once' : 'Allowed';
  }
  if (settled === 'denied') {
    const note = noteOfDenyMessage(stored.message);
    return note ? `Denied with note \u201C${clip(note)}\u201D` : stored.byMessage ? 'Denied by your message' : 'Denied';
  }
  return null;
}

/** A rule too long to sit beside its choice's name in a toast or the panel: it takes its own line. */
export function isLongRule(detail: string | undefined): boolean {
  return !!detail && (detail.includes('\n') || detail.length > 34);
}

/** The CLI's stock reason for a Bash ask (CLI 2.1.312). */
const GENERIC_REASON = /^This command requires approval\.?$/;

/** More than two lines in a narrow card: it opens with a visible Show all. */
export function isLongCommand(command: string): boolean {
  return command.split('\n').length > 2 || command.length > 110;
}

/** What is being asked. `clamp`: the command or plan at 2 lines, its full text in the tooltip. */
export function PermissionAskDetail({ n, detail, clamp = false }: { n: Notification; detail: PermissionDetail; clamp?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cmdClass = `nfc-card-cmd${expanded ? ' nfc-expanded' : ''}${clamp && !expanded ? ' is-clamped' : ''}`;
  const toggleTitle = (full: string) => (clamp ? full : expanded ? 'Collapse' : 'Expand');
  // Why it asked, above what it asks, as the card has it in its header. The CLI's
  // stock line for a command says nothing the command does not.
  const reason = n.reason && !GENERIC_REASON.test(n.reason) ? n.reason : null;
  return (
    <>
      {reason && <div className="nfc-card-sub">{reason}</div>}
      {detail.type === 'bash' && (
        <>
          {detail.description && <div className="nfc-card-sub">{detail.description}</div>}
          <code className={cmdClass} data-testid="permission-detail-command" onClick={() => setExpanded((v) => !v)} title={toggleTitle(detail.command)}>
            {/* The clamp sits inside the padding, so a third line never peeks out. */}
            <span className="nfc-cmd-text">{detail.command}</span>
          </code>
          {/* A long command is read whole before a remembering choice: the way to open it is visible. */}
          {!clamp && isLongCommand(detail.command) && (
            <button type="button" className="nfc-cmd-more" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Show less' : 'Show all'}</button>
          )}
        </>
      )}
      {detail.type === 'plan' && (
        <div className="nfc-card-plan">
          {/* No plan text (dropped over the size ceiling): no toggle, a toggle that reveals nothing is a dead end. */}
          {detail.plan ? (
            clamp ? (
              <div className={`nfc-card-sub${expanded ? '' : ' is-clamped'}`} data-testid="permission-detail-plan" onClick={() => setExpanded((v) => !v)}>
                {detail.plan}
              </div>
            ) : (
              <>
                <button className="nfc-card-toggle" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? '▼' : '▶︎'} Plan ready for review
                </button>
                {expanded && <pre className="nfc-card-pre">{detail.plan}</pre>}
              </>
            )
          ) : (
            <div className="nfc-card-sub">Plan ready for review</div>
          )}
        </div>
      )}
      {detail.type === 'file' && <div className="nfc-card-path">{detail.filePath}</div>}
      {detail.type === 'generic' && (
        // Over the ceiling, `preview` is all that is left of the input: render it.
        detail.preview ? (
          <code className={cmdClass} onClick={() => setExpanded((v) => !v)} title={toggleTitle(detail.preview)}>
            {detail.preview}
          </code>
        ) : n.body ? (
          <div className="notification-feed-item-body">{n.body}</div>
        ) : null
      )}
    </>
  );
}

export interface PermissionAnswerButtonsProps {
  answer: PermissionAnswer;
  /** The allow button's word: 'Allow', as the session card says it. */
  allowLabel?: string;
  /** The question form's refuse button (word + tooltip); default `Dismiss`. */
  dismissLabel?: string;
  dismissTitle?: string;
  /** Shown instead of the buttons when this surface cannot answer (no request id, or an ask with no questions). */
  fallback?: ReactNode;
  /** Called with each attempt, so the surface can offer a Retry of the same answer. */
  onAttempt?(allow: boolean, opts: RespondOptions | undefined, outcome: PermissionRequestStatus | 'failed'): void;
  testIdPrefix?: string;
}

/** The answer: the AskUserQuestion form, the ACP options, or Allow / Deny. */
export function PermissionAnswerButtons({ answer, allowLabel = 'Allow', dismissLabel, dismissTitle, fallback = null, onAttempt, testIdPrefix }: PermissionAnswerButtonsProps) {
  const { detail, answerable, askWithoutInput, acpOptions, busy, resolved } = answer;
  const note = usePermissionNote(answer.requestId);
  const second = useSecondClick();
  // A note typed turns the Allow choices off: nothing stays armed under it.
  const kept = { armed: note.text ? null : second.armed, confirm: second.confirm };
  const tid = (s: string) => (testIdPrefix ? `${testIdPrefix}-${s}` : undefined);
  const go = (allow: boolean, opts?: RespondOptions) => {
    releaseAnswerFocus();
    void answer.respond(allow, opts).then((outcome) => onAttempt?.(allow, opts, outcome));
  };
  if (detail.type === 'question') {
    return (
      <PermissionAnswerForm
        questions={detail.questions}
        disabled={!answerable || busy}
        resolved={!!resolved}
        inFlight={busy}
        onSubmit={(answers, images) => go(true, { answers, ...(images?.length ? { images } : {}) })}
        onDismissQuestions={() => go(false, { message: 'User dismissed the questions' })}
        {...(dismissLabel ? { dismissLabel } : {})}
        {...(dismissTitle ? { dismissTitle } : {})}
      />
    );
  }
  // Two reasons a surface cannot answer, one affordance: nothing to answer WITH,
  // or an AskUserQuestion whose questions were lost (an allow would say "answered nothing").
  if (!answerable || askWithoutInput) return resolved ? null : <>{fallback}</>;
  // A Claude prompt's Deny takes a note (claude-permission-options.ts takesNote).
  const noteReject = acpOptions.find((o) => isRejectOption(o) && o.takesNote);
  // The server held this choice (its rule's file cannot be written): why, under it.
  const held = answer.stored?.failed && answer.stored.failReason ? answer.stored.optionId : undefined;
  if (acpOptions.length > 0) {
    return (
      <>
      {answer.promptHint && <div className="perm-prompt-hint">{answer.promptHint}</div>}
      <div className={`notification-feed-item-actions${acpOptions.some((o) => o.detail || o.takesNote) ? ' perm-options-stack' : ''}`}>
        {acpOptions.map((o) => {
          const reject = isRejectOption(o);
          return (
            <button
              key={o.optionId}
              // A list that names rules stays neutral: no choice looks picked or recommended
              // before the person picks (a Claude prompt's list, whose Deny takes a note). A plain list keeps its strong yes.
              className={`notification-perm-btn${kept.armed === o.optionId ? ' is-armed' : ''}${isLongRule(o.detail) ? ' perm-option--long-rule' : ''}${reject || o.kind === 'allow_always' || acpOptions.some((x) => x.detail || x.takesNote) ? '' : ' approve'}${reject && o.takesNote && note.text ? ' perm-deny-with-note' : ''}${held === o.optionId ? ' is-failed' : ''}`}
              data-testid={tid(reject ? 'deny' : 'allow')}
              data-choice={o.optionId}
              title={!reject && note.text ? 'Clear the note to allow; a note goes with Deny' : [o.detail, o.savedTo && `Saves to ${o.savedTo}`].filter(Boolean).join('\n') || undefined}
              disabled={busy || (!reject && !!note.text)}
              onClick={() => (o.savedTo && !kept.confirm(o.optionId)) || go(!reject, { optionId: o.optionId, ...(reject && o.takesNote && note.text ? { message: denyMessageOf(note) } : {}) })}
            >
              {kept.armed === o.optionId && o.savedTo ? (
                /* Armed: what the second click does takes the choice's own line, so the item keeps its height. */
                <>
                  <span className="perm-option-name perm-option-confirm-name"><SavedFileMark />Click again to save</span>
                  <span className="perm-option-sub perm-option-confirm-sub">to <span className="perm-saved-file">{o.savedTo}</span></span>
                </>
              ) : (
                <>
                  <span className="perm-option-name">{o.savedTo && <SavedFileMark />}{reject && o.takesNote && note.text ? `${o.name ?? o.optionId} with note` : (o.name ?? o.optionId)}</span>
                  {/* What a remembering choice allows, read before it is chosen. */}
                  {o.detail && <span className="perm-option-sub"><span className="perm-option-detail"><RuleDetail text={o.detail} /></span></span>}
                  {/* The server held this choice: why, under it. Otherwise where the rule is kept. */}
                  {held === o.optionId ? <span className="perm-option-failed" role="alert">{answer.stored?.failReason}</span>
                    : o.savedTo && <span className="perm-option-saved" title={`Saves to ${o.savedTo}`}>Saves to <span className="perm-saved-file">{o.savedTo}</span></span>}
                </>
              )}
            </button>
          );
        })}
        {/* The adapter's own reject option may be absent: keep a plain Deny. */}
        {!acpOptions.some(isRejectOption) && (
          <button className="notification-perm-btn" data-testid={tid('deny')} disabled={busy} onClick={() => go(false)}>Deny</button>
        )}
        {noteReject && answer.requestId && (
          <DenyWithNote note={note} disabled={busy} onDeny={(message) => go(false, { optionId: noteReject.optionId, message })} />
        )}
      </div>
      {/* Said, not only greyed: why the Allow choices went off. Under the note, as on the
          session card, so no choice moves under the pointer while the note is typed. */}
      {note.text && <div className="perm-prompt-hint perm-note-off">Allow is off while a note is typed. Clear it to allow.</div>}
      </>
    );
  }
  return (
    <div className="notification-feed-item-actions">
      <button className="notification-perm-btn approve" data-testid={tid('allow')} disabled={busy || !!note.text} title={note.text ? 'Clear the note to allow; a note goes with Deny' : undefined} onClick={() => go(true)}>{allowLabel}</button>
      <button className={`notification-perm-btn${note.text ? ' perm-deny-with-note' : ''}`} data-testid={tid('deny')} disabled={busy} onClick={() => go(false, note.text ? { message: denyMessageOf(note) } : undefined)}>{note.text ? 'Deny with note' : 'Deny'}</button>
      {/* The plain pair is a Claude prompt's: its deny takes a note, as on the session card. */}
      {answer.requestId && <DenyWithNote note={note} disabled={busy} onDeny={(message) => go(false, { message })} />}
    </div>
  );
}
