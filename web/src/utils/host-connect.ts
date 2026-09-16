/**
 * Pure presentation rules for a host's connect status — no React, no network.
 *
 * Shared by the folder picker (tab dot + step row), Settings › Remote hosts and
 * the notification System pane, so all three say the same thing about the same
 * host. Kept side-effect-free on purpose: these are the parts worth pinning in a
 * node test, and the surfaces that need them are in three different trees.
 */
import type { DaemonConnectPhase, HostConnectStep, HostStatus } from '@/api/hosts';

/**
 * The 7 user-visible links in the first-connect chain, in order.
 *
 * The server sends its own `steps` (with its own labels) and that wins; this list
 * is the fallback for the older list-dirs `pending` shape, which reports a phase
 * and nothing else.
 */
export const CONNECT_STEPS: ReadonlyArray<{ phase: DaemonConnectPhase; label: string }> = [
  { phase: 'ssh', label: 'SSH' },
  { phase: 'probe', label: 'Probe' },
  { phase: 'install-runtime', label: 'Install runtime' },
  { phase: 'upload', label: 'Upload daemon' },
  { phase: 'start', label: 'Start daemon' },
  { phase: 'tunnel', label: 'Tunnel' },
  { phase: 'handshake', label: 'Handshake' },
];

/** Phases that mean "work is happening, wait" (as opposed to done/failed/never-tried). */
export function isConnectingPhase(phase: string | undefined): boolean {
  if (!phase) return false;
  if (phase === 'reconnecting' || phase === 'queued') return true;
  return CONNECT_STEPS.some((s) => s.phase === phase);
}

/** True when the store's snapshot says this host is mid-connect. */
export function isHostConnecting(status: HostStatus | undefined): boolean {
  return !!status && !status.connected && isConnectingPhase(status.phase);
}

/** True when the last attempt ended in a failure the user should see. */
export function isHostFailed(status: HostStatus | undefined): boolean {
  return !!status && !status.connected && (status.phase === 'failed' || (!!status.error && !isConnectingPhase(status.phase)));
}

/**
 * Derive the step list from a bare phase — the fallback when only the list-dirs
 * `pending.phase` is known. An unrecognised phase lands on the first step rather
 * than an all-todo list: something IS happening, and a list with no active row
 * reads as "stuck before it started".
 */
export function stepsFromPhase(phase: string | undefined): HostConnectStep[] {
  if (phase === 'connected') {
    return CONNECT_STEPS.map((s) => ({ ...s, status: 'done' as const }));
  }
  if (phase === 'queued') {
    // Truthfully nothing yet: the sentence ("waiting for another host") carries
    // the liveness, an active first step would claim ssh is running.
    return CONNECT_STEPS.map((s) => ({ ...s, status: 'todo' as const }));
  }
  const activeIdx = CONNECT_STEPS.findIndex((s) => s.phase === phase);
  const active = activeIdx >= 0 ? activeIdx : 0;
  return CONNECT_STEPS.map((s, i) => ({
    ...s,
    status: i < active ? 'done' : i === active ? 'active' : 'todo',
  }));
}

/** The steps to render: the server's when it sent them, else derived from a phase. */
export function connectSteps(
  status: HostStatus | undefined,
  fallbackPhase?: string,
): HostConnectStep[] {
  if (status?.steps?.length) return status.steps;
  return stepsFromPhase(status?.phase ?? fallbackPhase);
}

export type HostDotKind = 'connecting' | 'connected' | 'failed' | 'unknown';

/** Which dot a host wears. `unknown` covers "never reported" and "never tried". */
export function hostDotKind(status: HostStatus | undefined): HostDotKind {
  if (!status) return 'unknown';
  if (isHostFailed(status)) return 'failed';
  if (isHostConnecting(status)) return 'connecting';
  if (status.connected) return 'connected';
  return 'unknown';
}

/**
 * The store's hydration state, as the text rules see it. `undefined` (a caller
 * that does not track it) behaves like 'done': a missing status is then unknown.
 */
export type HostStatusHydrationHint = 'never' | 'pending' | 'done' | 'failed' | 'unsupported' | undefined;

/** True while a first answer from the server is still on its way. */
export function isCheckingHostStatus(status: HostStatus | undefined, hydration: HostStatusHydrationHint): boolean {
  return !status && (hydration === 'never' || hydration === 'pending');
}

/** StatusIndicator's vocabulary for the same verdict (Settings reuses that dot). */
export function hostIndicatorStatus(
  status: HostStatus | undefined,
  hydration?: HostStatusHydrationHint,
): 'connected' | 'error' | 'unknown' | 'testing' {
  if (isCheckingHostStatus(status, hydration)) return 'testing';
  const kind = hostDotKind(status);
  return kind === 'connecting' ? 'testing' : kind === 'failed' ? 'error' : kind === 'connected' ? 'connected' : 'unknown';
}

/**
 * One line of text for a host, in every surface's voice: the phase sentence while
 * connecting, the cause when it failed, plain words otherwise.
 *
 * Never returns an empty string — a blank status line reads as a rendering bug
 * (the "not responding at 0.55 opacity" report is the same class of miss). And
 * "unknown" is reserved for a server that answered without this host: while the
 * first read is still in flight the honest word is "checking", not "unknown".
 */
export function hostStatusText(status: HostStatus | undefined, hydration?: HostStatusHydrationHint): string {
  if (!status) {
    if (isCheckingHostStatus(status, hydration)) return 'Checking status…';
    if (hydration === 'unsupported') return 'Status not available from this server';
    return 'Status unknown';
  }
  if (isHostFailed(status)) return status.error || 'Could not connect';
  if (isHostConnecting(status)) return status.phaseLabel || `${activeStepLabel(status)}…`;
  if (status.connected) return 'Connected';
  return 'Not connected';
}

/**
 * Why the wait is long the first time. Used when the server sent no `note` of its
 * own: a minute of silence on "Install runtime" reads as a hang unless the UI says
 * this is one-time work.
 */
export const FIRST_CONNECT_NOTE = 'First connect to this host installs the session daemon; it only happens once.';

/** The explainer to show under the steps, if any. */
export function connectNote(status: HostStatus | undefined, steps: HostConnectStep[]): string | undefined {
  if (status?.note) return status.note;
  const active = steps.find((s) => s.status === 'active')?.phase;
  return active === 'install-runtime' || active === 'upload' ? FIRST_CONNECT_NOTE : undefined;
}

/** Short label of the step in flight (for a tooltip / a phase-less fallback). */
export function activeStepLabel(status: HostStatus | undefined): string {
  if (status?.phase === 'queued') return 'Waiting for another host';
  const steps = connectSteps(status);
  return steps.find((s) => s.status === 'active')?.label ?? 'Connecting';
}

/**
 * Tooltip for the tab dot: the cause when failed, the phase sentence otherwise.
 *
 * Deliberately the bare sentence, not "<host>: <sentence>" — the server's phase
 * labels already name the host ("Opening an SSH connection to Big dev box"), so
 * prefixing would say it twice. The accessible name below is where the label
 * earns its place, because a screen reader has no tab text next to the dot.
 */
export function hostDotTitle(label: string, status: HostStatus | undefined, hydration?: HostStatusHydrationHint): string {
  if (status) return hostStatusText(status);
  return isCheckingHostStatus(status, hydration) ? `${label}: checking status…` : `${label}: status unknown`;
}

/**
 * Accessible name for the tab dot. Deliberately SHORT: the dot sits inside the host
 * tab button, so its name is concatenated into that button's accessible name. The
 * full sentence there would read the host twice ("Big dev box: Connected Big dev
 * box"); "connected Big dev box" is what a person would say.
 */
export function hostDotAriaLabel(status: HostStatus | undefined, hydration?: HostStatusHydrationHint): string {
  if (isCheckingHostStatus(status, hydration)) return 'checking status';
  const kind = hostDotKind(status);
  return kind === 'connected' ? 'connected'
    : kind === 'connecting' ? 'connecting'
    : kind === 'failed' ? 'connect failed'
    : 'status unknown';
}

/**
 * Elapsed time to display now, from a server-stamped baseline.
 *
 * The server sends `phaseElapsedMs` measured at `at` (its own clock); the client
 * keeps counting from there so a 40-second install visibly ticks without a poll.
 * Both deltas are clamped at 0 — a client clock behind the server's would
 * otherwise render a countdown.
 */
export function elapsedNow(baseMs: number, at: number, now: number): number {
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
  if (!Number.isFinite(at) || !Number.isFinite(now)) return base;
  return base + Math.max(0, now - at);
}

/** "0s" · "12s" · "1m 05s" · "1h 02m". Never a bare millisecond count. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${String(totalSec % 60).padStart(2, '0')}s`;
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
}
