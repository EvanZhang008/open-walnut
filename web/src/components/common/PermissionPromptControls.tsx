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
  acpOptions: Array<{ optionId: string; kind?: string; name?: string }>;
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
  const respond = async (allow: boolean, opts?: RespondOptions) => {
    if (!n.sessionId || !requestId) return 'failed' as const;
    return respondToPermissionRequest(n.sessionId, requestId, allow, {
      ...(opts?.optionId ? { optionId: opts.optionId } : {}),
      ...(opts?.answers ? { answers: opts.answers } : {}),
      ...(opts?.message ? { message: opts.message } : {}),
    });
  };
  return {
    detail, requestId, stored, busy, resolved, failed: stored?.failed ?? false, answerable,
    askWithoutInput: isUnanswerableAsk(n, detail), acpOptions: validAcpOptions(n), respond,
  };
}

/** What is being asked. `clamp`: the command or plan at 2 lines, its full text in the tooltip. */
export function PermissionAskDetail({ n, detail, clamp = false }: { n: Notification; detail: PermissionDetail; clamp?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cmdClass = `nfc-card-cmd${expanded ? ' nfc-expanded' : ''}${clamp && !expanded ? ' is-clamped' : ''}`;
  const toggleTitle = (full: string) => (clamp ? full : expanded ? 'Collapse' : 'Expand');
  return (
    <>
      {detail.type === 'bash' && (
        <>
          {detail.description && <div className="nfc-card-sub">{detail.description}</div>}
          <code className={cmdClass} data-testid="permission-detail-command" onClick={() => setExpanded((v) => !v)} title={toggleTitle(detail.command)}>
            {detail.command}
          </code>
        </>
      )}
      {detail.type === 'plan' && (
        <div className="nfc-card-plan">
          {/* No plan text (dropped over the size ceiling): no toggle, a toggle that reveals nothing is a dead end. */}
          {detail.plan ? (
            clamp ? (
              <div className={`nfc-card-sub${expanded ? '' : ' is-clamped'}`} data-testid="permission-detail-plan" title={detail.plan} onClick={() => setExpanded((v) => !v)}>
                {detail.plan}
              </div>
            ) : (
              <>
                <button className="nfc-card-toggle" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? '▼' : '▶'} Plan ready for review
                </button>
                {expanded && <pre className="nfc-card-pre">{detail.plan}</pre>}
              </>
            )
          ) : (
            <div className="nfc-card-sub">Plan ready for review</div>
          )}
        </div>
      )}
      {detail.type === 'file' && <div className="nfc-card-path" title={detail.filePath}>{detail.filePath}</div>}
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
      {n.reason && <div className="nfc-card-sub">{n.reason}</div>}
    </>
  );
}

export interface PermissionAnswerButtonsProps {
  answer: PermissionAnswer;
  /** The allow button's word ('Approve' in the notification panel, 'Allow' on a kanban card). */
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
export function PermissionAnswerButtons({ answer, allowLabel = 'Approve', dismissLabel, dismissTitle, fallback = null, onAttempt, testIdPrefix }: PermissionAnswerButtonsProps) {
  const { detail, answerable, askWithoutInput, acpOptions, busy, resolved } = answer;
  const tid = (s: string) => (testIdPrefix ? `${testIdPrefix}-${s}` : undefined);
  const go = (allow: boolean, opts?: RespondOptions) => {
    void answer.respond(allow, opts).then((outcome) => onAttempt?.(allow, opts, outcome));
  };
  if (detail.type === 'question') {
    return (
      <PermissionAnswerForm
        questions={detail.questions}
        disabled={!answerable || busy}
        resolved={!!resolved}
        onSubmit={(answers) => go(true, { answers })}
        onDismissQuestions={() => go(false, { message: 'User dismissed the questions' })}
        {...(dismissLabel ? { dismissLabel } : {})}
        {...(dismissTitle ? { dismissTitle } : {})}
      />
    );
  }
  // Two reasons a surface cannot answer, one affordance: nothing to answer WITH,
  // or an AskUserQuestion whose questions were lost (an allow would say "answered nothing").
  if (!answerable || askWithoutInput) return resolved ? null : <>{fallback}</>;
  if (acpOptions.length > 0) {
    return (
      <div className="notification-feed-item-actions">
        {acpOptions.map((o) => {
          const reject = isRejectOption(o);
          return (
            <button
              key={o.optionId}
              className={`notification-perm-btn${reject ? '' : ' approve'}`}
              data-testid={tid(reject ? 'deny' : 'allow')}
              disabled={busy}
              onClick={() => go(!reject, { optionId: o.optionId })}
            >
              {o.name ?? o.optionId}
            </button>
          );
        })}
        {/* The adapter's own reject option may be absent: keep a plain Deny. */}
        {!acpOptions.some(isRejectOption) && (
          <button className="notification-perm-btn" data-testid={tid('deny')} disabled={busy} onClick={() => go(false)}>Deny</button>
        )}
      </div>
    );
  }
  return (
    <div className="notification-feed-item-actions">
      <button className="notification-perm-btn approve" data-testid={tid('allow')} disabled={busy} onClick={() => go(true)}>{allowLabel}</button>
      <button className="notification-perm-btn" data-testid={tid('deny')} disabled={busy} onClick={() => go(false)}>Deny</button>
    </div>
  );
}
