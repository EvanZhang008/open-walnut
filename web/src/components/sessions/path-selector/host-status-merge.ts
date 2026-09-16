/**
 * How the pushed host-status store folds into the picker's per-host listing state.
 *
 * The listing state answers "do I have directories for this host"; the store
 * answers "is the host even up, and where in the connect chain". They are two
 * different clocks on the same host, so the rules here are about which one may
 * speak: the store may TURN a waiting host into a failure (its push beats the
 * next poll by seconds), and it may enrich the phase text of a wait, but it may
 * never erase directories that were actually listed.
 */
import type { HostStatus } from '@/api/hosts';
import { activeStepLabel, isHostConnecting, isHostFailed } from '@/utils/host-connect';
import type { HostLiveState } from './useLiveDirs';

/** Poll gap while a host answers `pending` and its status is being pushed. */
export const PENDING_POLL_WS_MS = 5000;
/** Poll gap when the push cannot be relied on — the poll is the only signal left. */
export const PENDING_POLL_NO_WS_MS = 1500;

/**
 * How long to wait before re-asking a pending host.
 *
 * Lazy only when BOTH things are true: the socket is up, and pushes are actually
 * arriving (a host:status frame has been seen on this socket, and this host has a
 * status). An open socket alone is not evidence — a server without the status
 * endpoint, a host missing from it, or a cloud replica (which answers the GET but
 * has no phase machine to push from) all leave the poll as the only mechanism,
 * and slowing it down there would make the wait feel worse than before this
 * feature existed.
 */
export function decidePollDelay(wsConnected: boolean, hasPushedStatus: boolean): number {
  return wsConnected && hasPushedStatus ? PENDING_POLL_WS_MS : PENDING_POLL_NO_WS_MS;
}

/**
 * Is this stored status the very failure the user already answered with Retry?
 *
 * A retry starts a fresh connect, but the store keeps the old failed snapshot until
 * the server pushes the new attempt. Without this the card the user just dismissed
 * re-appears immediately, and against a server too old to push `host:status` it
 * would never clear at all.
 *
 * `suppressedAt` is the `at` of the snapshot held AT retry time, so both sides of
 * the comparison are the server's own clock — never the browser's.
 */
export function isRetriedFailure(status: HostStatus | undefined, suppressedAt: number | undefined): boolean {
  if (!status || suppressedAt === undefined) return false;
  return isHostFailed(status) && status.at <= suppressedAt;
}

const DEFAULT_FAIL_HINT = 'Check this host in Settings › Remote hosts, then retry.';

/** Fold one host's pushed status into its listing state. */
export function mergeHostStateWithStatus(
  state: HostLiveState,
  status: HostStatus | undefined,
): HostLiveState {
  if (!status) return state;
  // Directories that were really listed are never withdrawn by a status push:
  // stale rows beat an empty panel, and the user's next keystroke re-lists anyway.
  if (state.status === 'done') return state;

  if (isHostFailed(status)) {
    // The listing's own hostError is the most specific text (it came from the
    // request the user made), so it wins on message/kind; the store fills the
    // gaps, which is how a bare transport error gets a usable hint.
    const message = state.hostError?.message || status.error || 'Could not connect';
    const kind = state.hostError?.kind || status.kind || 'connect-failed';
    const hint = state.hostError?.hint || status.hint || DEFAULT_FAIL_HINT;
    if (state.status === 'error' && state.hostError
      && state.hostError.message === message && state.hostError.kind === kind && state.hostError.hint === hint) {
      return state;
    }
    return {
      status: 'error', parent: '', exists: true, dirs: [],
      error: state.error,
      hostError: { message, kind, hint },
    };
  }

  if (state.status === 'loading' && isHostConnecting(status)) {
    const label = status.phaseLabel || `${activeStepLabel(status)}…`;
    // Compare on phase+label only: elapsedMs changes constantly and the step row
    // ticks its own clock from the store, so folding it in here would hand the
    // picker a new object (and a re-render) on every push.
    if (state.pending?.phase === status.phase && state.pending.label === label) return state;
    return { ...state, pending: { phase: status.phase, label, elapsedMs: status.phaseElapsedMs } };
  }

  return state;
}

/**
 * Fold the store over every host in a listing snapshot, preserving identity when
 * nothing changed (the picker re-derives candidates from this map).
 */
export function mergeHostStatesWithStore(
  byHost: Map<string, HostLiveState>,
  getStatus: (host: string) => HostStatus | undefined,
): Map<string, HostLiveState> {
  let changed = false;
  const next = new Map<string, HostLiveState>();
  for (const [key, state] of byHost) {
    // '__local__' has no SSH connect chain — nothing to merge.
    const merged = key === '__local__' ? state : mergeHostStateWithStatus(state, getStatus(key));
    if (merged !== state) changed = true;
    next.set(key, merged);
  }
  return changed ? next : byHost;
}
