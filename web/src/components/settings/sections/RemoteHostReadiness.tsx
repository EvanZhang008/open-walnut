/**
 * Settings › Remote Hosts: what a CONNECTED host still needs (spec 5.3), in that
 * host's Details. The fix itself (Install, Update, Try again) is the row's one action, and the
 * row's warning line says the problem: here such a problem is only "Install by hand", folded,
 * with its command to copy and Check again (2026-11-04 review: Details said "Claude Code is not
 * installed" a second time with a second fix beside the row's Install). A problem the row does
 * not fix reads in full here.
 *
 * - A problem reads the server's message verbatim (it already names the host:
 *   no `{alias}: ` prefix), its command as a chip with Copy, then Check again.
 * - An automatic fix reads 'Updating Claude Code on {L}...' and HOLDS that text
 *   until the re-check answers (useHostActions.fixing), so the old warning never
 *   flashes back for the ~14s between the fix ending and the new answer. After
 *   5s it shows how long; after 3 minutes 'Still updating ...' and Check again.
 * - A cleared problem says '✓ {L} is ready (Claude Code {version})' for 3s, unless the row
 *   already says what the fix did ('Updated Claude Code to 2.1.281.').
 * - Informational lines (daemon_dir_fallback, status.warnings) are grey notes
 *   with no button: nothing to do.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  HOST_READY_HOLD_MS, autofixProgressText, autofixVerbFor, BLOCKING_READINESS_KINDS, hostReadySentence, isClaudeFixAction,
} from '@open-walnut/host-problem';
import type { HostStatus } from '@/api/hosts';
import { useServerTick } from '@/hooks/useServerTick';
import { CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { hostReadinessInfoNotes, hostReadinessProblems, type HostReadinessProblem } from '@/utils/host-readiness';
import { useFixNotes } from '@/hooks/useFixNotes';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { SettingsButton } from '../inputs/SettingsButton';
import { ChevronGlyph } from '../settings-glyphs';
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
  /** 'Check again' rides the first line that still asks the user for something. */
  withRecheck: boolean;
  now: number;
  /** When the server says the running fix began (for the elapsed timer). */
  fixStartedAt?: number;
  /** The host's row offers the fix and says the problem (not on a replica, which fixes nothing). */
  rowFixes: boolean;
}

function CheckAgainButton({ actions }: { actions: HostActions }) {
  const checking = actions.pending === 'check';
  return (
    <SettingsButton
      variant="text" disabled={checking} holdFocus reserve={['Check again', 'Checking...']}
      onClick={() => { void actions.checkAgain(); }} data-testid="rh-readiness-recheck"
    >
      {checking ? 'Checking...' : 'Check again'}
    </SettingsButton>
  );
}

/** The command for a problem the row fixes, folded: the fix by hand, then Check again. */
function ByHand({ problem, verb, alias, actions, failed }: { problem: HostReadinessProblem; verb: 'install' | 'update'; alias: string; actions: HostActions; failed?: { text: string; detail?: string } }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rh-readiness-line rh-by-hand" data-tone={failed ? 'warn' : 'info'} data-host={alias} data-problem={problem.kind}>
      {failed && <span className="rh-readiness" data-fix="failed" title={failed.detail}>{`The ${verb} did not work: ${failed.text}`}</span>}
      <button type="button" tabIndex={0} className="rh-by-hand-toggle" aria-expanded={open} aria-controls={id} data-testid="rh-by-hand" onClick={() => setOpen(!open)}>
        <ChevronGlyph size={10} className="settings-disclosure-chevron" />
        {verb === 'install' ? 'Install by hand' : 'Update by hand'}
      </button>
      <div id={id} className="rh-by-hand-body" hidden={!open}>
        <HostCommands commands={problem.commands} testId={`rh-readiness-commands-${problem.kind}`} />
        <span className="rh-readiness-actions"><CheckAgainButton actions={actions} /></span>
      </div>
    </div>
  );
}

function ProblemLine({ problem, alias, label, installMethod, actions, withRecheck, now, fixStartedAt, rowFixes }: LineProps) {
  const blocking = BLOCKING_READINESS_KINDS.includes(problem.kind);
  const verb = blocking && rowFixes ? autofixVerbFor(problem, installMethod) : null;
  const serverRunning = problem.fix?.state === 'running';
  const common = { 'data-host': alias, 'data-problem': problem.kind };
  // A Claude line shows progress only for a Claude fix, or a person's Install / Update whose round
  // sets up gcc or dtach first: those set up by themselves are not it.
  const claudeFix = !!actions.fixing && (actions.fixing.asked || isClaudeFixAction(actions.fixing.action));
  // The row offers this fix and says its progress: here only Check again, once it takes long.
  if (verb && (serverRunning || claudeFix)) {
    const p = autofixProgressText(verb, label, actions.fixing?.startedAt ?? fixStartedAt, now);
    return p.showCheckAgain ? <div className="rh-readiness-line" data-tone="info"><span className="rh-readiness-actions"><CheckAgainButton actions={actions} /></span></div> : null;
  }
  if (verb) {
    const failedFix = problem.fix?.state === 'failed' ? problem.fix : undefined;
    return <ByHand problem={problem} verb={verb} alias={alias} actions={actions} failed={failedFix ? { text: failedFix.text, detail: failedFix.detail } : undefined} />;
  }
  if (serverRunning && problem.fix) {
    return (
      <div className="rh-readiness-line" data-tone="info">
        <span className="rh-readiness" {...common} data-fix="running">{`${problem.fix.text} on ${label}...`}</span>
      </div>
    );
  }
  const failedFix = problem.fix?.state === 'failed' ? problem.fix : undefined;
  return (
    <div className="rh-readiness-line" data-tone="warn">
      <span className="rh-readiness" {...common} data-fix={failedFix ? 'failed' : undefined} title={failedFix?.detail}>
        {failedFix ? `Update failed: ${failedFix.text}` : <InlineCodeText text={problem.message} />}
      </span>
      <HostCommands commands={problem.commands} testId={`rh-readiness-commands-${problem.kind}`} />
      {withRecheck && <span className="rh-readiness-actions"><CheckAgainButton actions={actions} /></span>}
    </div>
  );
}

export interface RemoteHostReadinessProps {
  alias: string;
  /** The host's display label (the server's messages already carry it). */
  label: string;
  status: HostStatus | undefined;
  actions: HostActions;
  /** The row offers the fix (Install, Update): Details folds it to "Install by hand". */
  rowFixes?: boolean;
}

export function RemoteHostReadiness({ alias, label, status, actions, rowFixes = true }: RemoteHostReadinessProps) {
  const problems = hostReadinessProblems(status);
  const info = hostReadinessInfoNotes(status);
  const fixNotes = useFixNotes(status);
  const ready = useReadyLine(status, label);
  const running = !!actions.fixing || problems.some((p) => p.fix?.state === 'running');
  const now = useServerTick(running);
  const minute = useServerTick(problems.length > 0 || actions.lastTriedAt !== null, 60_000);
  const checkedAt = status?.connected ? status.readiness?.checkedAt : undefined;
  const fixStartedAt = status?.readiness?.fixing?.startedAt;
  const installMethod = status?.readiness?.claude?.installMethod;
  // A problem the row fixes carries its own Check again, folded with its command.
  const recheckAt = problems.findIndex((p) => p.fix?.state !== 'running' && !(rowFixes && BLOCKING_READINESS_KINDS.includes(p.kind) && autofixVerbFor(p, installMethod)));
  const showLastChecked = typeof checkedAt === 'number' && (problems.length > 0 || actions.lastTriedAt !== null);

  if (problems.length === 0 && info.length === 0 && fixNotes.length === 0 && !ready && !actions.receipt && actions.failed !== 'check') {
    return null;
  }
  return (
    <div className="rh-readiness-block" data-host={alias}>
      {problems.map((problem, idx) => (
        <ProblemLine
          key={problem.kind} problem={problem} alias={alias} label={label} installMethod={installMethod}
          actions={actions} withRecheck={idx === recheckAt} now={now} fixStartedAt={fixStartedAt} rowFixes={rowFixes}
        />
      ))}
      {ready && !fixNotes.some((n) => n.kind === 'done') && (
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
      {/* What a finished fix did is the row's line (useLinkedHostRow); only one running here. */}
      {fixNotes.filter((note) => note.kind === 'running').map((note) => (
        <span key={note.key} className="rh-readiness-note" data-host={alias} data-fix={note.kind} title={note.detail}>
          {`${note.text} on ${label}...`}
        </span>
      ))}
    </div>
  );
}
