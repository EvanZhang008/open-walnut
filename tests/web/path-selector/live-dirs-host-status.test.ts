/**
 * The rules that let the pushed host status drive the folder picker.
 *
 * Two are load-bearing and invisible from the DOM. First, WHO MAY SPEAK: the
 * pushed status may turn a waiting host into a failure card seconds before the
 * next poll would, and it may sharpen the phase sentence of a wait, but it must
 * never withdraw directories that were actually listed (a status push arrives for
 * reasons that have nothing to do with the listing, and a panel that empties
 * itself under the user is worse than stale rows). Second, IDENTITY: the picker
 * re-derives every candidate from this map, so a merge that changes nothing must
 * return the very same objects, or a host that pushes once a second re-ranks the
 * list once a second.
 */
import { describe, it, expect } from 'vitest';
import type { HostStatus } from '@/api/hosts';
import {
  decidePollDelay, isRetriedFailure, mergeHostStateWithStatus, mergeHostStatesWithStore,
  PENDING_POLL_NO_WS_MS, PENDING_POLL_WS_MS,
} from '@/components/sessions/path-selector/host-status-merge';
import type { HostLiveState } from '@/components/sessions/path-selector/useLiveDirs';
import {
  CONNECT_STEPS, FIRST_CONNECT_NOTE, connectNote, connectSteps, elapsedNow, formatElapsed,
  hostDotAriaLabel, hostDotKind, hostDotTitle, hostIndicatorStatus, hostStatusText,
  isConnectingPhase, stepsFromPhase,
} from '@/utils/host-connect';

const AT = 1_800_000_000_000;

function hostStatus(o: Partial<HostStatus> & { host: string }): HostStatus {
  return {
    label: o.host,
    hostname: `${o.host}.example.com`,
    connected: false,
    phase: 'ssh',
    phaseLabel: `Opening an SSH connection to ${o.host}…`,
    steps: [],
    phaseElapsedMs: 0,
    connectElapsedMs: 0,
    at: AT,
    ...o,
  };
}

const loading = (pending?: HostLiveState['pending']): HostLiveState =>
  ({ status: 'loading', parent: '', exists: true, dirs: [], pending });
const listed = (dirs: string[]): HostLiveState =>
  ({ status: 'done', parent: '/home/dev/', exists: true, dirs });

describe('decidePollDelay', () => {
  it('only goes lazy when the socket is up AND this host is really being pushed', () => {
    expect(decidePollDelay(true, true)).toBe(PENDING_POLL_WS_MS);
    // A dead socket, or a host the status endpoint says nothing about (an older
    // server, a host missing from the answer), keeps the old cadence: the poll is
    // then the ONLY mechanism, and slowing it would make the wait worse than before.
    expect(decidePollDelay(false, true)).toBe(PENDING_POLL_NO_WS_MS);
    expect(decidePollDelay(true, false)).toBe(PENDING_POLL_NO_WS_MS);
    expect(decidePollDelay(false, false)).toBe(PENDING_POLL_NO_WS_MS);
    expect(PENDING_POLL_WS_MS).toBeGreaterThan(PENDING_POLL_NO_WS_MS);
    expect(PENDING_POLL_NO_WS_MS).toBe(1500);
  });
});

describe('mergeHostStateWithStatus — who may speak', () => {
  it('leaves the state untouched when the store knows nothing about the host', () => {
    const state = loading();
    expect(mergeHostStateWithStatus(state, undefined)).toBe(state);
  });

  it('never withdraws directories that were listed, even when the host later fails', () => {
    const state = listed(['/home/dev/a', '/home/dev/b']);
    const merged = mergeHostStateWithStatus(state, hostStatus({ host: 'devbox', phase: 'failed', error: 'ssh: connection closed' }));
    expect(merged).toBe(state);
    expect(merged.dirs).toHaveLength(2);
  });

  it('turns a waiting host into the failure card with the store cause, kind and hint', () => {
    const merged = mergeHostStateWithStatus(loading(), hostStatus({
      host: 'devbox', phase: 'failed',
      error: 'ssh: connect to host devbox port 22: Operation timed out',
      kind: 'ssh-timeout',
      hint: 'Check the VPN, then retry.',
    }));
    expect(merged.status).toBe('error');
    expect(merged.dirs).toEqual([]);
    expect(merged.hostError).toEqual({
      message: 'ssh: connect to host devbox port 22: Operation timed out',
      kind: 'ssh-timeout',
      hint: 'Check the VPN, then retry.',
    });
  });

  it('always leaves a next step: a failure with no hint gets the standing one', () => {
    const merged = mergeHostStateWithStatus(loading(), hostStatus({ host: 'devbox', phase: 'failed' }));
    expect(merged.hostError?.message).toBe('Could not connect');
    expect(merged.hostError?.kind).toBe('connect-failed');
    expect(merged.hostError?.hint).toBeTruthy();
  });

  it('keeps the listing own cause but fills the gaps from the store', () => {
    const transportFailure: HostLiveState = {
      status: 'error', parent: '', exists: true, dirs: [],
      error: 'Request timed out after 15000ms',
    };
    const merged = mergeHostStateWithStatus(transportFailure, hostStatus({
      host: 'devbox', phase: 'failed', error: 'daemon exited with code 127', kind: 'runtime-missing',
      hint: 'The host has no usable node runtime.',
    }));
    // The transport error is kept as-is; the store supplies the structured card.
    expect(merged.error).toBe('Request timed out after 15000ms');
    expect(merged.hostError).toEqual({
      message: 'daemon exited with code 127',
      kind: 'runtime-missing',
      hint: 'The host has no usable node runtime.',
    });

    const listingCause: HostLiveState = {
      status: 'error', parent: '', exists: true, dirs: [],
      hostError: { message: 'list-dirs refused: host disabled', kind: 'disabled', hint: '' },
    };
    const merged2 = mergeHostStateWithStatus(listingCause, hostStatus({
      host: 'devbox', phase: 'failed', error: 'not connected', kind: 'unknown', hint: 'Enable the host in Settings.',
    }));
    expect(merged2.hostError?.message).toBe('list-dirs refused: host disabled');
    expect(merged2.hostError?.kind).toBe('disabled');
    expect(merged2.hostError?.hint).toBe('Enable the host in Settings.');
  });

  it('is idempotent on an already-shown failure card', () => {
    const status = hostStatus({ host: 'devbox', phase: 'failed', error: 'boom', kind: 'k', hint: 'h' });
    const first = mergeHostStateWithStatus(loading(), status);
    expect(mergeHostStateWithStatus(first, status)).toBe(first);
  });
});

describe('mergeHostStateWithStatus — the phase sentence of a wait', () => {
  it('fills the connect phase from the push before the poll answers', () => {
    const merged = mergeHostStateWithStatus(loading(), hostStatus({
      host: 'marina', phase: 'install-runtime',
      phaseLabel: 'Installing the session daemon runtime on marina…',
      phaseElapsedMs: 12_000,
    }));
    expect(merged.status).toBe('loading');
    expect(merged.pending).toEqual({
      phase: 'install-runtime',
      label: 'Installing the session daemon runtime on marina…',
      elapsedMs: 12_000,
    });
  });

  it('returns the SAME state when only the elapsed clock moved', () => {
    const first = mergeHostStateWithStatus(loading(), hostStatus({ host: 'marina', phase: 'upload', phaseLabel: 'Uploading…', phaseElapsedMs: 1_000 }));
    const second = mergeHostStateWithStatus(first, hostStatus({ host: 'marina', phase: 'upload', phaseLabel: 'Uploading…', phaseElapsedMs: 9_000 }));
    // The step row ticks its own clock from the store; folding a new elapsed value
    // in here would hand the picker a new object on every push.
    expect(second).toBe(first);
  });

  it('falls back to the active step label when the server sent no sentence', () => {
    const merged = mergeHostStateWithStatus(loading(), hostStatus({ host: 'marina', phase: 'tunnel', phaseLabel: '' }));
    expect(merged.pending?.label).toBe('Tunnel…');
  });

  it('leaves a connected host loading — the caller re-lists it instead', () => {
    const state = loading({ phase: 'handshake', label: 'Handshaking…', elapsedMs: 500 });
    const merged = mergeHostStateWithStatus(state, hostStatus({ host: 'devbox', connected: true, phase: 'connected', phaseLabel: 'Connected' }));
    expect(merged).toBe(state);
    expect(merged.status).toBe('loading');
  });

  it('treats a reconnect as a wait, not as a failure, even with the last error still attached', () => {
    const merged = mergeHostStateWithStatus(loading(), hostStatus({
      host: 'devbox', phase: 'reconnecting', phaseLabel: 'Reconnecting to devbox…', error: 'tunnel closed',
    }));
    expect(merged.status).toBe('loading');
    expect(merged.pending?.phase).toBe('reconnecting');
  });
});

describe('isRetriedFailure — the card the user already dismissed', () => {
  const failed = (at: number) => hostStatus({ host: 'devbox', phase: 'failed', error: 'Permission denied (publickey).', at });

  it('suppresses the failure snapshot held when Retry was pressed, and only that one', () => {
    const held = failed(AT);
    // Retry captured the `at` of the snapshot it replaced.
    expect(isRetriedFailure(held, held.at)).toBe(true);
    // The reconnect's own failure is newer, so the card comes back.
    expect(isRetriedFailure(failed(AT + 1), held.at)).toBe(false);
    // Never suppresses a wait or a success.
    expect(isRetriedFailure(hostStatus({ host: 'devbox', phase: 'ssh', at: AT }), held.at)).toBe(false);
    expect(isRetriedFailure(hostStatus({ host: 'devbox', connected: true, phase: 'connected', at: AT }), held.at)).toBe(false);
  });

  it('suppresses nothing when no retry happened, or when nothing was held', () => {
    expect(isRetriedFailure(failed(AT), undefined)).toBe(false);
    expect(isRetriedFailure(undefined, AT)).toBe(false);
    // A host with no stored status at retry time records 0, which can suppress nothing.
    expect(isRetriedFailure(failed(AT), 0)).toBe(false);
  });
});

describe('mergeHostStatesWithStore', () => {
  it('keeps the map identity when no host changed and skips local entirely', () => {
    const byHost = new Map<string, HostLiveState>([
      ['__local__', loading()],
      ['devbox', listed(['/home/dev/a'])],
    ]);
    // A status for '__local__' would be nonsense (no SSH chain) and is ignored.
    const merged = mergeHostStatesWithStore(byHost, (host) => (host === '__local__'
      ? hostStatus({ host: '__local__', phase: 'failed', error: 'never happens' })
      : undefined));
    expect(merged).toBe(byHost);
    expect(merged.get('__local__')?.status).toBe('loading');
  });

  it('rebuilds the map when one host changed, leaving the others by identity', () => {
    const localState = loading();
    const devboxState = loading();
    const marinaState = listed(['/srv/x']);
    const byHost = new Map<string, HostLiveState>([
      ['__local__', localState], ['devbox', devboxState], ['marina', marinaState],
    ]);
    const merged = mergeHostStatesWithStore(byHost, (host) => (host === 'devbox'
      ? hostStatus({ host, phase: 'failed', error: 'ssh: no route to host', kind: 'network', hint: 'Check the network.' })
      : undefined));

    expect(merged).not.toBe(byHost);
    expect(merged.get('devbox')?.status).toBe('error');
    expect(merged.get('devbox')?.hostError?.message).toBe('ssh: no route to host');
    expect(merged.get('__local__')).toBe(localState);
    expect(merged.get('marina')).toBe(marinaState);
    expect([...merged.keys()]).toEqual(['__local__', 'devbox', 'marina']);
  });
});

describe('connect steps', () => {
  it('is the 7-link chain, in order', () => {
    expect(CONNECT_STEPS.map((s) => s.phase)).toEqual([
      'ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake',
    ]);
  });

  it('marks everything before the phase done, the phase active, the rest todo', () => {
    const steps = stepsFromPhase('upload');
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'active', 'todo', 'todo', 'todo']);
    expect(steps.find((s) => s.status === 'active')?.label).toBe('Upload daemon');
  });

  it('shows a whole done chain for connected, and never a chain with no active step mid-connect', () => {
    expect(stepsFromPhase('connected').every((s) => s.status === 'done')).toBe(true);
    // An unknown/older phase name still has to look alive: the first step is active.
    for (const phase of ['reconnecting', 'idle', 'some-new-phase', undefined]) {
      const steps = stepsFromPhase(phase);
      expect(steps.filter((s) => s.status === 'active')).toHaveLength(1);
      expect(steps[0].status).toBe('active');
    }
  });

  it('prefers the server steps, and derives from the pending phase when there is no status', () => {
    const serverSteps = [{ phase: 'ssh' as const, label: 'Reach the host', status: 'active' as const }];
    expect(connectSteps(hostStatus({ host: 'devbox', steps: serverSteps }))).toBe(serverSteps);
    expect(connectSteps(undefined, 'start').find((s) => s.status === 'active')?.phase).toBe('start');
  });

  it('explains the one-time work only while it is happening', () => {
    expect(connectNote(undefined, stepsFromPhase('install-runtime'))).toBe(FIRST_CONNECT_NOTE);
    expect(connectNote(undefined, stepsFromPhase('upload'))).toBe(FIRST_CONNECT_NOTE);
    expect(connectNote(undefined, stepsFromPhase('handshake'))).toBeUndefined();
    // A server-sent note always wins.
    expect(connectNote(hostStatus({ host: 'x', note: 'Building bun for this arch' }), stepsFromPhase('handshake')))
      .toBe('Building bun for this arch');
  });

  it('knows which phases mean work is in flight', () => {
    for (const p of ['ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake', 'reconnecting', 'queued']) {
      expect(isConnectingPhase(p)).toBe(true);
    }
    for (const p of ['idle', 'connected', 'failed', '', undefined]) {
      expect(isConnectingPhase(p)).toBe(false);
    }
  });

  it('a queued host is a live wait with NO active step: nothing has started for it', () => {
    const queued = hostStatus({
      host: 'marina', phase: 'queued',
      phaseLabel: 'Waiting for another host to finish connecting, then marina',
      steps: stepsFromPhase('queued'),
    });
    expect(stepsFromPhase('queued').every((s) => s.status === 'todo')).toBe(true);
    expect(hostDotKind(queued)).toBe('connecting');          // pulsing, not grey "unknown"
    expect(hostIndicatorStatus(queued)).toBe('testing');
    expect(hostStatusText(queued)).toBe('Waiting for another host to finish connecting, then marina');
    // No sentence from the server (older build): still says what it is waiting for.
    expect(hostStatusText(hostStatus({ host: 'marina', phase: 'queued', phaseLabel: '' }))).toBe('Waiting for another host…');
    // In the picker it is a wait, never a failure card.
    const merged = mergeHostStateWithStatus(loading(), queued);
    expect(merged.status).toBe('loading');
    expect(merged.pending?.phase).toBe('queued');
  });
});

describe('host verdicts and text', () => {
  it('maps a status to one dot and one indicator', () => {
    expect(hostDotKind(undefined)).toBe('unknown');
    expect(hostDotKind(hostStatus({ host: 'a', phase: 'idle' }))).toBe('unknown');
    expect(hostDotKind(hostStatus({ host: 'a', connected: true, phase: 'connected' }))).toBe('connected');
    expect(hostDotKind(hostStatus({ host: 'a', phase: 'probe' }))).toBe('connecting');
    expect(hostDotKind(hostStatus({ host: 'a', phase: 'reconnecting', error: 'tunnel closed' }))).toBe('connecting');
    expect(hostDotKind(hostStatus({ host: 'a', phase: 'failed', error: 'boom' }))).toBe('failed');
    // An error with no phase to explain it still reads as a failure.
    expect(hostDotKind(hostStatus({ host: 'a', phase: 'idle', error: 'ssh key rejected' }))).toBe('failed');

    expect(hostIndicatorStatus(hostStatus({ host: 'a', phase: 'upload' }))).toBe('testing');
    expect(hostIndicatorStatus(hostStatus({ host: 'a', phase: 'failed', error: 'x' }))).toBe('error');
    expect(hostIndicatorStatus(hostStatus({ host: 'a', connected: true, phase: 'connected' }))).toBe('connected');
    expect(hostIndicatorStatus(undefined)).toBe('unknown');
  });

  it('titles the tab dot with the bare phase sentence and names it briefly', () => {
    const connecting = hostStatus({ host: 'devbox', label: 'Big dev box', phase: 'ssh' });
    // The server's sentence already names the host, so the tooltip must not prefix it.
    expect(hostDotTitle('Big dev box', connecting)).toBe('Opening an SSH connection to devbox…');
    expect(hostDotTitle('Big dev box', undefined)).toContain('Big dev box');
    // Short name: the dot lives INSIDE the tab button, whose name already has the host.
    expect(hostDotAriaLabel(connecting)).toBe('connecting');
    expect(hostDotAriaLabel(hostStatus({ host: 'devbox', connected: true, phase: 'connected' }))).toBe('connected');
    expect(hostDotAriaLabel(hostStatus({ host: 'devbox', phase: 'failed', error: 'x' }))).toBe('connect failed');
    expect(hostDotAriaLabel(undefined)).toBe('status unknown');
  });

  it('says "checking" while the first read is in flight, "unknown" only once the server has answered', () => {
    // Settings mounts behind dozens of queued requests; for those seconds a
    // missing status is a pending answer, not a verdict.
    expect(hostStatusText(undefined, 'never')).toBe('Checking status…');
    expect(hostStatusText(undefined, 'pending')).toBe('Checking status…');
    expect(hostIndicatorStatus(undefined, 'pending')).toBe('testing');
    expect(hostDotTitle('Big dev box', undefined, 'pending')).toBe('Big dev box: checking status…');
    expect(hostDotAriaLabel(undefined, 'pending')).toBe('checking status');
    // The server answered and this host was not in it.
    expect(hostStatusText(undefined, 'done')).toBe('Status unknown');
    expect(hostIndicatorStatus(undefined, 'done')).toBe('unknown');
    expect(hostDotAriaLabel(undefined, 'done')).toBe('status unknown');
    // A read that failed outright is unknown too (no false "checking" forever).
    expect(hostStatusText(undefined, 'failed')).toBe('Status unknown');
    // An older server without the route: say so, rather than "unknown".
    expect(hostStatusText(undefined, 'unsupported')).toBe('Status not available from this server');
    // A real status ignores the hydration hint entirely.
    expect(hostStatusText(hostStatus({ host: 'a', connected: true, phase: 'connected' }), 'pending')).toBe('Connected');
    expect(hostIndicatorStatus(hostStatus({ host: 'a', phase: 'failed', error: 'x' }), 'pending')).toBe('error');
  });

  it('never renders an empty status line', () => {
    expect(hostStatusText(undefined)).toBeTruthy();
    expect(hostStatusText(hostStatus({ host: 'a', connected: true, phase: 'connected' }))).toBe('Connected');
    expect(hostStatusText(hostStatus({ host: 'a', phase: 'idle' }))).toBe('Not connected');
    expect(hostStatusText(hostStatus({ host: 'a', phase: 'failed', error: 'ssh: permission denied' }))).toBe('ssh: permission denied');
    // A failure the server could not name still says something actionable.
    expect(hostStatusText(hostStatus({ host: 'a', phase: 'failed' }))).toBe('Could not connect');
    expect(hostStatusText(hostStatus({ host: 'a', phase: 'start', phaseLabel: '' }))).toBe('Start daemon…');
  });
});

describe('elapsed clock', () => {
  it('keeps counting from the server stamp and never counts backwards', () => {
    expect(elapsedNow(12_000, AT, AT + 3_000)).toBe(15_000);
    // Client clock behind the server's: hold the server's number, never a countdown.
    expect(elapsedNow(12_000, AT, AT - 30_000)).toBe(12_000);
    expect(elapsedNow(-5, AT, AT)).toBe(0);
    expect(elapsedNow(1_000, Number.NaN, AT)).toBe(1_000);
  });

  it('formats a duration a person can read', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(-1)).toBe('0s');
    expect(formatElapsed(900)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});
