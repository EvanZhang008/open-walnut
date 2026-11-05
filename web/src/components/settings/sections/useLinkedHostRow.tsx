/**
 * What one saved host's row in Remote Hosts says from its live status (the WS host frames,
 * useHostStatus) and its last reading (useHostFleet): the dot, the one state line, the lines
 * under it (the one warning, a fix running, what a press found), and its one action:
 *
 *   not connected      Retry SSH (Retry on a joined machine) after a failed try, else Connect now
 *                      (Connecting... while it runs, and while a Turn on or a found host's Connect
 *                      waits for its save before it dials)
 *   connected          Install / Update Claude Code when it needs one, else Set up (start after a
 *                      reboot) when its reading asks for it, else none
 *   off                Turn on (the caller's: it is a config change)
 *
 * A connected host has a green dot; what it still needs is its own warning line (2026-11-04
 * review: a "Connected" row drew an orange square). Each row reads its own status, so a push
 * re-renders one row, never the section (which holds the auto-saving editor).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  autofixProgressText, autofixVerbFor, BLOCKING_READINESS_KINDS, firstSentence, hostDotOf, hostProblemOf, isClaudeFixAction, isConnectingPhaseWire, OFF_PHASE_LABEL,
} from '@open-walnut/host-problem';
import type { FleetHost } from '@/api/hosts-fleet';
import { serverNow, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useHostActions } from '@/hooks/useHostActions';
import { useServerTick } from '@/hooks/useServerTick';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { formatElapsed, hostStatusText } from '@/utils/host-connect';
import { FIX_NOTE_MS, hostReadinessProblems } from '@/utils/host-readiness';
import { useFixNotes } from '@/hooks/useFixNotes';
import { getHostDismissed, hostHiddenFromBanner, restoreHost, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { problemsOf } from './host-fleet-dashboard-model';
import { connectAction, liveLine, needsLook as cardNeedsLook } from './host-row-model';
import type { ActionState } from './useHostFleet';
import { RowLine as Line, type RowPrimary } from './HostRow';

const plain = (text: string) => text.replace(/\u2026/g, '...');

/**
 * The reading's problem a connected host's row names (its warning line), so Details does not say
 * it again: none while Claude Code needs a fix there (the row names that instead).
 */
export function rowProblemKey(card: FleetHost, now: number, status: ReturnType<typeof useHostStatus>): string | null {
  if (!status?.connected) return null;
  if (hostReadinessProblems(status).some((p) => BLOCKING_READINESS_KINDS.includes(p.kind))) return null;
  return problemsOf(card, now).find((p) => p.tone === 'warn' || p.tone === 'bad')?.key ?? null;
}
/** A host that came up within this long of a press here says so, for CONNECTED_NOTE_MS. */
const CONNECT_WATCH_MS = 60_000;
const CONNECTED_NOTE_MS = 8_000;
/** How long a finished fix's result stays on the row (Details keep it longer). */
export const ROW_FIX_NOTE_MS = 20_000;

/**
 * The words a failed connect request gets on its row: what the press was, why it failed, and the
 * one next step (2026-11-05 review: "Could not retry right now." after a Turn on).
 */
export function connectFailedLine(as: 'turn-on' | 'add' | 'connect', reason: string | null, next: string | null): string {
  const lead = as === 'turn-on' ? 'Turned on, but Walnut could not connect' : as === 'add' ? 'Added, but Walnut could not connect' : 'Could not connect';
  return `${lead}: ${reason ?? 'Walnut gave no reason'}.${next ? ` ${next} tries again.` : ''}`;
}

export interface LinkedRowInput {
  alias: string;
  name: string;
  enabled: boolean;
  /** In config.yaml (a new row is not, and the server cannot dial it yet). */
  saved: boolean;
  card?: FleetHost;
  now: number;
  boot?: ActionState;
  onBootStart?: () => void;
  /** How this Mac reaches it: an SSH host's retry says "Retry SSH". */
  via?: 'ssh' | 'net';
  /** A Turn on or a found host's Connect whose dial has not started yet (it waits for its save). */
  connecting?: boolean;
  /** When this page last asked it to connect outside the Retry button (a found host's Connect). */
  pressedAt?: number;
  /** The last Turn on or Add and connect, and when: the words of a failure that follows it. */
  askedAs?: { as: 'turn-on' | 'add'; at: number };
}

export interface LinkedRow {
  dot: ReactNode;
  /** Connected now (the live status push), for the summary and the map. */
  online: boolean;
  state: string;
  stateTitle?: string;
  lines: ReactNode[];
  primary: RowPrimary | null;
  needsLook: boolean;
  /** The user hid this host's problem on the home page's banner. */
  hidden: boolean;
  showOnBanner: () => void;
}

export function useLinkedHostRow({ alias, name, enabled, saved, card, now, boot, onBootStart, via = 'ssh', connecting: asked = false, pressedAt, askedAs }: LinkedRowInput): LinkedRow {
  const status = useHostStatus(alias);
  const hydration = useHostStatusHydration();
  const actions = useHostActions(alias);
  const replica = useIsCloudReplica();
  const label = status?.label || name;
  const hydrating = hydration === 'never' || hydration === 'pending';
  const problem = hostProblemOf(status, { replica });
  const connecting = !!status && !status.connected && isConnectingPhaseWire(status.phase) && status.phase !== 'reconnecting';
  const busy = actions.pending === 'retry' || asked;
  const tick = useServerTick(connecting || !!actions.fixing);
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed, getHostDismissed);
  const hidden = !!status && hostHiddenFromBanner(alias, [status], dismissed);

  // "Connected." for a moment, when a press here brought the host up.
  const [justUp, setJustUp] = useState(false);
  const wasUp = useRef(!!status?.connected);
  useEffect(() => {
    const up = !!status?.connected;
    const last = Math.max(actions.lastTriedAt ?? 0, pressedAt ?? 0);
    const pressed = last > 0 && Date.now() - last < CONNECT_WATCH_MS;
    const rose = up && !wasUp.current && pressed;
    wasUp.current = up;
    if (!rose) return;
    setJustUp(true);
    const t = window.setTimeout(() => setJustUp(false), CONNECTED_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [status?.connected, actions.lastTriedAt, pressedAt]);

  // What Claude Code still needs there, and a fix running or just finished.
  const problems = hostReadinessProblems(status);
  const blocking = problems.find((p) => BLOCKING_READINESS_KINDS.includes(p.kind));
  const verb = blocking && !replica ? autofixVerbFor(blocking, status?.readiness?.claude?.installMethod) : null;
  const claudeFix = !!actions.fixing && (actions.fixing.asked || isClaudeFixAction(actions.fixing.action));
  const fixRunning = !!blocking && (blocking.fix?.state === 'running' || claudeFix);
  // What a finished fix did, on the row for ROW_FIX_NOTE_MS (Details keep it longer).
  const notes = useFixNotes(status).filter((n) => n.kind !== 'running' && FIX_NOTE_MS - (n.expiresInMs ?? FIX_NOTE_MS) < ROW_FIX_NOTE_MS);
  const [, rowNoteTick] = useState(0);
  const youngest = notes.reduce<number | null>((min, n) => {
    const left = ROW_FIX_NOTE_MS - (FIX_NOTE_MS - (n.expiresInMs ?? FIX_NOTE_MS));
    return min === null ? left : Math.min(min, left);
  }, null);
  useEffect(() => {
    if (youngest === null) return;
    const t = window.setTimeout(() => rowNoteTick((n) => n + 1), Math.max(0, youngest) + 50);
    return () => window.clearTimeout(t);
  }, [youngest]);
  // A Claude Code fix that just finished: its result replaces the progress line, the warning it
  // fixed and its button until the next reading (2026-11-05 review: "Installing..." and
  // "Installed Claude Code 2.1.281." showed at once, under a button still reading Installing...).
  const justFixed = notes.find((n) => n.kind === 'done' && isClaudeFixAction(n.key.replace(/^done-/, '')));
  // The row's own Connect now / Retry, for the words of a failure (a Turn on and an Add have theirs).
  const [pressed, setPressed] = useState(0);

  const lines: ReactNode[] = [];
  let state: string;
  let stateTitle: string | undefined;
  let primary: RowPrimary | null = null;
  let dot = hostDotOf(status, { hydrating, now: serverNow(), label });
  const connect = (failed: boolean, kind: 'retry' | 'connectNow') => {
    const a = connectAction(failed, busy, via);
    return { label: a.label, reserve: a.reserve, disabled: busy, testId: 'rh-row-connect', ariaLabel: `${a.label.replace(/\.\.\.$/, '')}: ${label}`, onClick: () => { setPressed(Date.now()); void (kind === 'retry' ? actions.retry() : actions.connectNow()); } };
  };

  if (!enabled) {
    state = 'Off: Walnut does not connect to it.';
    dot = { kind: 'off', title: `${label}: Off` };
  } else if (!saved) {
    // Nothing to connect yet; an alias the server already has frames for still shows its dot (C42).
    state = 'Not saved yet.';
    if (!status) dot = { kind: 'unknown', title: `${label}: Not saved yet` };
  } else if (!status) {
    // A dial this page started reads as one until it answers, also before the host's first
    // status frame (2026-11-05 review: a new host read "Not connected" beside "Connecting...").
    state = busy ? `Connecting to ${label}...` : hydrating ? 'Checking...' : 'Not connected';
    if (!hydrating || busy) primary = connect(false, 'connectNow');
  } else if (problem?.type === 'off') {
    state = OFF_PHASE_LABEL;
    stateTitle = 'This test server never dials remote hosts. Start it with WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to test one.';
  } else if (problem?.type === 'connect') {
    state = problem.headline;
    primary = connect(true, 'retry');
  } else if (problem?.type === 'reconnecting') {
    state = `Reconnecting to ${label}`;
    primary = connect(false, 'connectNow');
  } else if (connecting) {
    const started = status.attemptStartedAt;
    state = `${plain(hostStatusText(status, hydration))}${typeof started === 'number' ? ` ${formatElapsed(Math.max(0, tick - started))}` : ''}`;
    primary = { label: 'Connecting...', disabled: true, reserve: ['Connect now', 'Connecting...'], onClick: () => {}, testId: 'rh-row-connect' };
  } else if (status.connected) {
    state = liveLine(card);
    // Green: connected. What it still needs is the warning line under it.
    if (dot.kind === 'warn') dot = { kind: 'connected', title: `${label}: Connected` };
    const fleetProblem = card ? problemsOf(card, now).find((p) => p.tone === 'warn' || p.tone === 'bad') : undefined;
    // The fix's result, then the next thing the host needs (its Set up), never the fixed warning.
    if (justFixed) lines.push(<Line key="fixed" tone="good" testId="rh-row-fix-note">{`${justFixed.text}.`}</Line>);
    if (fixRunning && verb && !justFixed) {
      const own = actions.fixing && isClaudeFixAction(actions.fixing.action) ? actions.fixing.verb : verb;
      lines.push(<Line key="fix" tone="note" testId="rh-row-fixing">{autofixProgressText(own, label, actions.fixing?.startedAt ?? status.readiness?.fixing?.startedAt, tick).text}</Line>);
      primary = { label: verb === 'install' ? 'Installing...' : 'Updating...', disabled: true, reserve: ['Install', 'Installing...', 'Try again'], onClick: () => {}, testId: `rh-readiness-fix-${blocking!.kind}` };
    } else if (blocking && !justFixed) {
      lines.push(<Line key="ready" tone="warn" testId="rh-row-warning">{firstSentence(blocking.message)}</Line>);
      if (verb) {
        const failedFix = blocking.fix?.state === 'failed';
        primary = {
          label: failedFix ? 'Try again' : verb === 'install' ? 'Install' : 'Update',
          reserve: ['Install', 'Installing...', 'Try again'],
          testId: `rh-readiness-fix-${blocking.kind}`,
          ariaLabel: `${verb === 'install' ? 'Install' : 'Update'} Claude Code on ${label}`,
          onClick: () => { void actions.update(verb); },
        };
      }
    } else if (fleetProblem) {
      lines.push(<Line key="fleet" tone={fleetProblem.tone === 'bad' ? 'bad' : 'warn'} testId="rh-row-warning">{fleetProblem.text}</Line>);
      if (fleetProblem.action && onBootStart) {
        primary = {
          label: boot?.busy ? 'Setting up...' : fleetProblem.action.label,
          disabled: !!boot?.busy,
          reserve: ['Set up', 'Setting up...', 'Check again'],
          testId: 'host-fleet-fix',
          onClick: onBootStart,
        };
      }
    }
  } else {
    state = busy ? `Connecting to ${label}...` : 'Not connected';
    primary = connect(false, 'connectNow');
  }
  if (replica && primary?.testId === 'rh-row-connect') primary = null;

  // At most one line says what a press did, newest kind first: the failure, the result, a receipt.
  if (!enabled) {
    // A host turned off says only that (2026-11-05 review: an Off row kept an old Set up note).
  } else if (justUp && status?.connected) lines.push(<Line key="up" tone="good" testId="host-fleet-action-note">Connected.</Line>);
  else if (actions.failed === 'retry') {
    const as = askedAs && askedAs.at > pressed ? askedAs.as : 'connect';
    lines.push(<Line key="rf" tone="bad" testId="host-fleet-action-error">{connectFailedLine(as, actions.failedReason, primary?.testId === 'rh-row-connect' ? primary.label : null)}</Line>);
  } else if (boot?.error) lines.push(<Line key="be" tone="bad" testId="host-fleet-action-error">{boot.error}</Line>);
  else if (boot?.note) lines.push(<Line key="bn" tone="note" testId="host-fleet-action-note">{boot.note}</Line>);
  else if (actions.receipt) lines.push(<Line key="rc" tone="note">{actions.receipt}</Line>);
  else {
    const failedFix = notes.find((n) => n.kind === 'failed');
    if (failedFix) lines.push(<Line key={failedFix.key} tone="bad" testId="rh-row-fix-note">{`${failedFix.text}.`}</Line>);
    else if (!justFixed) for (const n of notes.slice(0, 1)) lines.push(<Line key={n.key} tone="note" testId="rh-row-fix-note">{`${n.text}.`}</Line>);
  }
  // The home page's banner leaves this host out: said once, with the way back beside it.
  if (hidden) {
    lines.push(
      <Line key="hidden" tone="note" testId="rh-banner-hidden">
        Hidden from the home page.{' '}
        <button type="button" className="rh-inline-link rh-show-again-btn" data-testid="rh-show-again" onClick={() => restoreHost(alias)}>Show it there again</button>
      </Line>,
    );
  }

  // Not while it connects, and never before anyone tried it (2026-11-05 review: a new host read
  // "Needs a look" and counted before the person had tried anything).
  const trying = busy || connecting || (asked && !status?.connected);
  const look = !trying && (enabled && saved && (card ? cardNeedsLook(card, now) : !status?.connected) || (!!blocking && !justFixed));
  return {
    dot: <HostStatusDot dot={dot} host={alias} />,
    online: enabled && saved && !!status?.connected,
    state,
    stateTitle,
    lines,
    primary,
    needsLook: look,
    hidden,
    showOnBanner: () => restoreHost(alias),
  };
}
