/**
 * A card's open prompt, answered in place (spec 6, G3): the red status line
 * expands into the SAME controls the notification panel's permission card uses
 * (PermissionPromptControls.tsx, no copy): the command or plan at 2 lines with
 * its full text in the tooltip, Allow / Deny through the one permission store,
 * PermissionAnswerForm for an AskUserQuestion. A nested worker's prompt rolled
 * into its parent names it first (`From <title>`) and answers ITS request.
 *
 * The request comes from the notification feed (the permission record the
 * server keeps, with its tool input and request id); when the feed does not
 * hold it, the session's own pending prompt is read once. A failed answer says
 * so in the card with a Retry of the same answer. Success is not drawn here:
 * the card turns when the next session status arrives (no optimistic tone).
 */
import '@/styles/board-kanban-controls.css';
import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/api/client';
import { requestIdOf, useNotifications, type Notification } from '@/contexts/notifications';
import { PermissionAnswerButtons, PermissionAskDetail, usePermissionAnswer } from '@/components/common/PermissionPromptControls';
import type { RespondOptions } from '@/stores/permission-request-store';
import { log } from '@/utils/log';
import type { KanbanCardPromptProps, KanbanPromptRequest } from './kanban-contract';

interface PendingFromSession {
  requestId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  reason?: string;
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}

/** The open permission record of this request's session (the one with its request id when known, else the newest). */
export function pickPromptNotification(feed: readonly Notification[], request: Pick<KanbanPromptRequest, 'sessionId' | 'requestId'>): Notification | null {
  let best: Notification | null = null;
  for (const n of feed) {
    if (n.kind !== 'permission' || n.resolved || n.sessionId !== request.sessionId) continue;
    const id = requestIdOf(n);
    if (request.requestId && id === request.requestId) return n;
    if (!request.requestId && (!best || n.timestamp > best.timestamp)) best = n;
  }
  return best;
}

/** A permission record built from what the card knows (or the session's own pending prompt). */
export function promptNotification(request: KanbanPromptRequest, pending?: PendingFromSession | null): Notification {
  const requestId = pending?.requestId ?? request.requestId;
  const tool = pending?.toolName ?? request.toolName;
  const input = pending?.input ?? (request.detail ? (tool === 'Bash' ? { command: request.detail } : { preview: request.detail }) : undefined);
  return {
    id: `kanban-prompt:${request.sessionId}:${requestId ?? ''}`, kind: 'permission', severity: 'warning', title: tool,
    timestamp: 0, persistent: false, dedupKey: requestId ? `perm:${requestId}` : `kanban-prompt:${request.sessionId}`,
    sessionId: request.sessionId, toolName: tool,
    ...(requestId ? { requestId } : {}), ...(input ? { input } : {}), ...(pending?.reason ? { reason: pending.reason } : {}),
    ...(pending?.acpOptions ? { acpOptions: pending.acpOptions } : {}),
  };
}

export function KanbanCardPrompt({ request, onAnswered }: KanbanCardPromptProps) {
  const { feed } = useNotifications();
  const fromFeed = useMemo(() => pickPromptNotification(feed, request), [feed, request]);
  const [pending, setPending] = useState<PendingFromSession | null>(null);
  const [lastTry, setLastTry] = useState<{ allow: boolean; opts?: RespondOptions } | null>(null);
  const [stale, setStale] = useState(false);

  // Not in the feed: read the session's own pending prompt once (its request id and input).
  const sid = request.sessionId;
  useEffect(() => {
    if (fromFeed || !sid) return;
    let alive = true;
    apiGet<{ pendingPermissions?: PendingFromSession[] }>(`/api/sessions/${encodeURIComponent(sid)}`).then((res) => {
      if (!alive) return;
      const list = res.pendingPermissions ?? [];
      setPending(list.find((p) => p.requestId === request.requestId) ?? list[0] ?? null);
    }).catch((err: unknown) => log.warn('board', 'kanban prompt read failed', { sessionId: sid, error: String(err) }));
    return () => { alive = false; };
  }, [fromFeed, sid, request.requestId]);

  const n = fromFeed ?? promptNotification(request, pending);
  const answer = usePermissionAnswer(n);
  const failed = answer.failed && !answer.resolved && !!lastTry;

  const onAttempt = (allow: boolean, opts: RespondOptions | undefined, outcome: string) => {
    setLastTry({ allow, ...(opts ? { opts } : {}) });
    log.info('board', 'kanban prompt answered', { sessionId: sid, requestId: answer.requestId ?? '', allow, outcome, fromTaskId: request.fromTaskId ?? '' });
    if (outcome === 'stale') setStale(true);
    if (outcome !== 'failed') onAnswered();
  };
  const retry = () => {
    if (!lastTry) return;
    void answer.respond(lastTry.allow, lastTry.opts).then((outcome) => onAttempt(lastTry.allow, lastTry.opts, outcome));
  };

  return (
    <div className="kanban-prompt" data-testid="kanban-card-prompt-body" data-request-id={answer.requestId ?? ''} data-session-id={sid}>
      {request.fromTitle && (
        <div className="kanban-prompt-from" data-testid="kanban-prompt-from" title={request.fromTitle}>From {request.fromTitle}</div>
      )}
      <PermissionAskDetail n={n} detail={answer.detail} clamp />
      {answer.busy && (
        <div className="kanban-prompt-busy" data-testid="kanban-prompt-busy" role="status">
          <span className="kanban-spinner" aria-hidden /> Answering...
        </div>
      )}
      {(answer.resolved || stale) && !answer.busy && (
        <div className="kanban-prompt-resolved" data-testid="kanban-prompt-resolved">
          {stale || answer.resolved === 'stale' ? 'Already answered' : answer.resolved === 'denied' ? 'Denied' : answer.resolved === 'expired' ? 'Session ended' : 'Allowed'}
        </div>
      )}
      <PermissionAnswerButtons
        answer={answer}
        allowLabel="Allow"
        // N24: say what refusing does; `Dismiss` read like closing the panel.
        dismissLabel="Skip question"
        dismissTitle="Answer nothing: the worker is told you skipped its question and carries on"
        testIdPrefix="kanban-prompt"
        onAttempt={onAttempt}
        fallback={<div className="kanban-prompt-note">Open the session to answer this.</div>}
      />
      {failed && (
        <div className="kanban-prompt-error" data-testid="kanban-prompt-error" role="alert">
          Couldn't answer: the session did not take the answer.{' '}
          <button type="button" className="kanban-text-btn" data-testid="kanban-prompt-retry" onClick={retry}>Retry</button>
        </div>
      )}
    </div>
  );
}
