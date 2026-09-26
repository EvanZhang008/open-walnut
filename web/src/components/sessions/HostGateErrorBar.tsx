/**
 * Why the last Start did not start, inside the restored draft (spec 6, G24).
 * The server refused with 409 (host_not_ready / host_unreachable / host_off /
 * host_removed) and created nothing; the draft came back with everything the
 * user typed, and this bar says the same sentence the banner, the picker and
 * Settings say, with the same buttons (hostActionsFor surface 'errorbar').
 *
 * It follows the host live: on the frame that clears the problem it reads the
 * one success sentence for 3s and goes; a different host on the draft clears it at once.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { log } from '@/utils/log';
import { useNavigate } from 'react-router-dom';
import {
  HOST_READY_HOLD_MS, REMOTE_OFF_NOTE, STANDING_FAILURE_KINDS, hostActionsFor, hostDotOf, hostProblemOf, hostReadySentence,
  type HostGateBody, type HostGateCode, type HostProblem,
} from '@open-walnut/host-problem';
import { serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { markGateBarShown } from '@/utils/host-gate-shown';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT } from '@/hooks/useHostActions';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { StableButton } from '@/components/common/HostProblemRows';
import { openHostSettings } from '@/utils/host-settings-nav';
import '@/styles/attention-banner.css';

export interface DraftGateError {
  code: HostGateCode;
  body: HostGateBody;
  /** Client time the refusal landed (a repeat refusal replaces the bar). */
  at: number;
}

/**
 * The problem the bar shows: the LIVE one whenever the store has one (any
 * kind: a host refused as not ready that has since dropped its connection says
 * so, with that problem's buttons), else the refusal's own words. A removed
 * host has no live status and no buttons.
 */
export function gateProblem(gate: DraftGateError, live: HostProblem | null): HostProblem | null {
  if (gate.code === 'host_removed') return null;
  if (live && live.type !== 'listing') return live;
  if (gate.code === 'host_off') return null;
  if (gate.code === 'host_unreachable') {
    const kind = gate.body.kind ?? 'unknown';
    return { type: 'connect', kind, headline: gate.body.headline, hint: gate.body.hint, summary: '', retryable: !STANDING_FAILURE_KINDS.includes(kind), dismissKey: '' };
  }
  return {
    type: 'readiness', blocking: true, dismissKey: '',
    problem: { kind: gate.body.kind ?? 'claude_error', message: gate.body.error, commands: [] },
  };
}

export function HostGateErrorBar({ gate, draftHost, label, onClear, onStartAnyway }: {
  gate: DraftGateError;
  draftHost: string | null | undefined;
  label: string;
  onClear: () => void;
  onStartAnyway: () => void;
}) {
  const navigate = useNavigate();
  const onOpenSettings = (a: string) => openHostSettings(navigate, a);
  const alias = gate.body.host;
  const status = useHostStatus(alias);
  const actions = useHostActions(alias);
  const replica = useIsCloudReplica();
  const [readyUntil, setReadyUntil] = useState<number | null>(null);
  // While this bar speaks for the host, the compact banner above it stays quiet about it.
  useEffect(() => markGateBarShown(alias), [alias]);

  // A different host on the draft: this refusal no longer applies.
  useEffect(() => { if ((draftHost ?? '') !== alias) onClear(); }, [draftHost, alias, onClear]);

  const live = hostProblemOf(status);
  const blocking = gate.code === 'host_not_ready' || gate.code === 'host_unreachable';
  const cleared = blocking && !!status?.connected && !live && hostDotOf(status, { now: serverNow() }).kind === 'connected';
  useEffect(() => {
    if (!cleared || readyUntil !== null) return;
    setReadyUntil(Date.now() + HOST_READY_HOLD_MS);
  }, [cleared, readyUntil]);
  useEffect(() => {
    if (readyUntil === null) return;
    const t = setTimeout(onClear, Math.max(0, readyUntil - Date.now()));
    return () => clearTimeout(t);
  }, [readyUntil, onClear]);

  if (readyUntil !== null) {
    return (
      <div className="session-error-banner session-error-banner--idle host-gate-bar" role="status" data-testid="host-gate-ready">
        <span className="hpb-ready-text">{hostReadySentence(label, status?.readiness?.claude?.version)}</span>
      </div>
    );
  }
  const problem = gateProblem(gate, live);
  // A replica cannot dial ssh: no Retry there (Check again relays to the Mac).
  const ids = problem ? hostActionsFor(problem, { surface: 'errorbar', replica, allowOverride: !!gate.body.allowOverride }) : [];
  return (
    <div className="session-error-banner host-gate-bar" role="alert" data-testid="host-gate-bar" data-code={gate.code} data-host={alias}>
      <div className="host-gate-body">
        {!problem && <span className="session-error-banner-text">{gate.body.error}</span>}
        {problem?.type === 'off' && <span className="session-error-banner-text">{REMOTE_OFF_NOTE}</span>}
        {problem?.type === 'reconnecting' && (
          <>
            <span className="session-error-banner-text">{`Reconnecting to ${status?.label || label}`}</span>
            {problem.headline && <div className="hpb-last">Last attempt: {problem.headline}</div>}
          </>
        )}
        {problem?.type === 'connect' && (
          <HostFailureText headline={problem.headline} hint={problem.hint} summary={problem.summary} kind={problem.kind} retryAt={problem.retryAt} />
        )}
        {problem?.type === 'readiness' && (
          <>
            <span className="session-error-banner-text"><InlineCodeText text={problem.problem.message} /></span>
            {problem.problem.commands.length > 0 && <HostCommands commands={problem.problem.commands} />}
          </>
        )}
        {actions.receipt && <div className="hpb-receipt">{actions.receipt}</div>}
        {actions.failed === 'retry' && <div className="host-connect-retry-msg" role="alert">{RETRY_FAILED_TEXT}</div>}
      </div>
      {ids.length > 0 && (
        <div className="host-gate-actions">
          {ids.map((id) => {
            if (id === 'retry') return <StableButton key={id} label={actions.pending === 'retry' ? 'Retrying...' : 'Retry'} labels={['Retry', 'Retrying...']} disabled={actions.pending !== null} onClick={() => { void actions.retry(); }} testId="host-gate-retry" />;
            if (id === 'checkAgain') {
              const l = actions.pending === 'check' ? 'Checking...' : actions.failed === 'check' ? CHECK_FAILED_TEXT : 'Check again';
              return <StableButton key={id} label={l} labels={['Check again', 'Checking...', CHECK_FAILED_TEXT]} disabled={actions.pending !== null} onClick={() => { void actions.checkAgain(); }} testId="host-gate-check" />;
            }
            if (id === 'startAnyway') return <StableButton key={id} label="Start anyway" labels={['Start anyway']} onClick={onStartAnyway} testId="host-gate-start-anyway" />;
            if (id === 'openSettings') return <StableButton key={id} label="Open Settings" labels={['Open Settings']} secondary onClick={() => onOpenSettings(alias)} testId="host-gate-open-settings" />;
            return null;
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Put a refused Start's images back into the restored composer, once. The
 * composer keeps images in its own state (only text is persisted), so they go
 * back in the way a user adds one: through its file input.
 */
export function useRestoreImages(rootRef: RefObject<HTMLElement | null>, images: ImageAttachment[] | undefined): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !images?.length || typeof DataTransfer === 'undefined') return;
    const input = rootRef.current?.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    done.current = true;
    try {
      const dt = new DataTransfer();
      for (const img of images) {
        const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], img.name || 'pasted-image', { type: img.mediaType }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      log.warn('draft', 'could not restore images after a refused start', { error: String(err) });
    }
  }, [rootRef, images]);
}
