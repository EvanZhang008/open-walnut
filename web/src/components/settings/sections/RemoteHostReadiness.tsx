/**
 * Settings › Remote Hosts: what a CONNECTED host still needs (spec 5.3), inside
 * that host's own row (never stacked above the list).
 *
 * - A problem reads the server's message verbatim (it already names the host:
 *   no `{alias}: ` prefix), its command as a chip with Copy, then its buttons.
 * - An automatic fix reads 'Updating Claude Code on {L}...' and HOLDS that text
 *   until the re-check answers (useHostActions.fixing), so the old warning never
 *   flashes back for the ~14s between the fix ending and the new answer. After
 *   5s it shows how long; after 3 minutes 'Still updating ...' and Check again.
 * - A cleared problem says '✓ {L} is ready (Claude Code {version})' for 3s.
 * - Informational lines (daemon_dir_fallback, status.warnings) are grey notes
 *   with no button: nothing to do.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HOST_READY_HOLD_MS, autofixProgressText, autofixVerbFor, BLOCKING_READINESS_KINDS, hostReadySentence,
} from '@open-walnut/host-problem';
import type { HostStatus } from '@/api/hosts';
import { useServerTick } from '@/hooks/useServerTick';
import { CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { hostReadinessInfoNotes, hostReadinessNotes, hostReadinessProblems, type HostReadinessProblem } from '@/utils/host-readiness';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { SettingsButton } from '../inputs/SettingsButton';
import '@/styles/host-picker-settings.css';

/** 'just now', '2m ago', '1h ago'. */
export function agoText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** A blocking problem that clears says so for 3s. */
function useReadyLine(status: HostStatus | undefined, label: string): string | null {
  const blocking = hostReadinessProblems(status).some((p) => BLOCKING_READINESS_KINDS.includes(p.kind));
  const [ready, setReady] = useState<string | null>(null);
  const was = useRef(false);
  const connected = !!status?.connected;
  const version = status?.readiness?.claude?.version;
  // Layout, not passive: the problem line leaves in this commit, so the ready
  // line must arrive before the paint (never a frame with neither).
  useLayoutEffect(() => {
    if (was.current && !blocking && connected) setReady(hostReadySentence(label, version));
    if (blocking) setReady(null);
    was.current = blocking;
  }, [blocking, connected, label, version]);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setReady(null), HOST_READY_HOLD_MS);
    return () => clearTimeout(t);
  }, [ready]);
  return ready;
}

interface LineProps {
  problem: HostReadinessProblem;
  alias: string;
  label: string;
  installMethod?: string;
  actions: HostActions;
  replica: boolean;
  /** 'Check again' rides the first line that still asks the user for something. */
  withRecheck: boolean;
  now: number;
  /** When the server says the running fix began (for the elapsed timer). */
  fixStartedAt?: number;
}

function CheckAgainButton({ actions }: { actions: HostActions }) {
  const checking = actions.pending === 'check';
  return (
    <SettingsButton
      variant="text" disabled={checking} reserve={['Check again', 'Checking...']}
      onClick={() => { void actions.checkAgain(); }} data-testid="rh-readiness-recheck"
    >
      {checking ? 'Checking...' : 'Check again'}
    </SettingsButton>
  );
}

function ProblemLine({ problem, alias, label, installMethod, actions, replica, withRecheck, now, fixStartedAt }: LineProps) {
  const blocking = BLOCKING_READINESS_KINDS.includes(problem.kind);
  const verb = blocking ? autofixVerbFor(problem, installMethod) : null;
  const serverRunning = problem.fix?.state === 'running';
  const common = { 'data-host': alias, 'data-problem': problem.kind };
  if (verb && (actions.fixing || serverRunning)) {
    const p = autofixProgressText(actions.fixing?.verb ?? verb, label, actions.fixing?.startedAt ?? fixStartedAt, now);
    return (
      <div className="rh-readiness-line" data-tone="info">
        <span className="rh-readiness" {...common} data-fix="running">
          {p.base}{p.elapsed && <span aria-hidden="true">{` ${p.elapsed}`}</span>}
        </span>
        {p.showCheckAgain && <span className="rh-readiness-actions"><CheckAgainButton actions={actions} /></span>}
      </div>
    );
  }
  if (serverRunning && problem.fix) {
    return (
      <div className="rh-readiness-line" data-tone="info">
        <span className="rh-readiness" {...common} data-fix="running">{`${problem.fix.text} on ${label}...`}</span>
      </div>
    );
  }
  const failedFix = problem.fix?.state === 'failed' ? problem.fix : undefined;
  const canFix = !!verb && !replica;
  return (
    <div className="rh-readiness-line" data-tone="warn">
      <span className="rh-readiness" {...common} data-fix={failedFix ? 'failed' : undefined} title={failedFix?.detail}>
        {failedFix ? `Update failed: ${failedFix.text}` : <InlineCodeText text={problem.message} />}
      </span>
      <HostCommands commands={problem.commands} testId={`rh-readiness-commands-${problem.kind}`} />
      <span className="rh-readiness-actions">
        {canFix && (
          <SettingsButton
            variant="text" reserve={['Try again', 'Install', 'Update']}
            onClick={() => { void actions.update(verb ?? 'update'); }} data-testid={`rh-readiness-fix-${problem.kind}`}
          >
            {failedFix ? 'Try again' : verb === 'install' ? 'Install' : 'Update'}
          </SettingsButton>
        )}
        {withRecheck && <CheckAgainButton actions={actions} />}
      </span>
    </div>
  );
}

export interface RemoteHostReadinessProps {
  alias: string;
  /** The host's display label (the server's messages already carry it). */
  label: string;
  status: HostStatus | undefined;
  actions: HostActions;
  replica: boolean;
}

export function RemoteHostReadiness({ alias, label, status, actions, replica }: RemoteHostReadinessProps) {
  const problems = hostReadinessProblems(status);
  const info = hostReadinessInfoNotes(status);
  // When THIS status arrived, on this browser's clock: a finished-fix note's age is
  // the server's `ageMs` plus how long we held the snapshot (no clock comparison).
  const receivedAt = useMemo(() => Date.now(), [status]);
  const [, setExpiryTick] = useState(0);
  const fixNotes = hostReadinessNotes(status, Date.now() - receivedAt);
  const nextExpiry = fixNotes.reduce<number | null>(
    (min, n) => (n.expiresInMs === undefined ? min : min === null ? n.expiresInMs : Math.min(min, n.expiresInMs)), null);
  // A finished-fix note disappears on its own, even when no push arrives.
  useEffect(() => {
    if (nextExpiry === null) return;
    const t = setTimeout(() => setExpiryTick((n) => n + 1), nextExpiry + 50);
    return () => clearTimeout(t);
  }, [nextExpiry, receivedAt]);
  const ready = useReadyLine(status, label);
  const running = !!actions.fixing || problems.some((p) => p.fix?.state === 'running');
  const now = useServerTick(running);
  const minute = useServerTick(problems.length > 0 || actions.lastTriedAt !== null, 60_000);
  const checkedAt = status?.connected ? status.readiness?.checkedAt : undefined;
  const fixStartedAt = status?.readiness?.fixing?.startedAt;
  const installMethod = status?.readiness?.claude?.installMethod;
  const recheckAt = problems.findIndex((p) => p.fix?.state !== 'running');
  const showLastChecked = typeof checkedAt === 'number' && (problems.length > 0 || actions.lastTriedAt !== null);

  if (problems.length === 0 && info.length === 0 && fixNotes.length === 0 && !ready && !actions.receipt && actions.failed !== 'check') {
    return null;
  }
  return (
    <div className="rh-readiness-block" data-host={alias}>
      {problems.map((problem, idx) => (
        <ProblemLine
          key={problem.kind} problem={problem} alias={alias} label={label} installMethod={installMethod}
          actions={actions} replica={replica} withRecheck={idx === recheckAt} now={now} fixStartedAt={fixStartedAt}
        />
      ))}
      {ready && (
        <div className="rh-readiness-line" data-tone="success">
          <span className="rh-readiness rh-readiness-ready" data-host={alias} role="status">{ready}</span>
        </div>
      )}
      {actions.failed === 'check' && <span className="rh-action-failed" role="status">{CHECK_FAILED_TEXT}</span>}
      {actions.receipt && <span className="rh-receipt" role="status">{actions.receipt}</span>}
      {showLastChecked && !actions.receipt && (
        <span className="rh-last-checked">{`Last checked ${agoText(minute - (checkedAt as number))}`}</span>
      )}
      {info.map((text) => (
        <span key={text} className="rh-readiness-note" data-host={alias}><InlineCodeText text={text} /></span>
      ))}
      {fixNotes.map((note) => (
        <span key={note.key} className="rh-readiness-note" data-host={alias} data-fix={note.kind} title={note.detail}>
          {note.kind === 'running' ? `${note.text} on ${label}...` : `${note.text}.`}
        </span>
      ))}
    </div>
  );
}
