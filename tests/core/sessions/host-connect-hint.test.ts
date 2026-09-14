/**
 * host-connect-hint — connect phases and failures become sentences a first-time
 * user can act on. Pure mapping, so every kind is pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHostConnectError,
  describeConnectPhase,
  describeListingError,
  IN_PROGRESS_PHASES,
} from '../../../src/core/sessions/host-connect-hint.js';
import type { DaemonConnectPhase } from '../../../src/providers/daemon-connection.js';

const T = 'me@devbox.example.test';

describe('classifyHostConnectError', () => {
  it.each([
    ['me@h: Permission denied (publickey).', 'auth'],
    ['Connection to devbox failed 12s ago: Permission denied (publickey,keyboard-interactive)', 'auth'],
    ['Host key verification failed.', 'auth'],
    ['ssh: Could not resolve hostname devbox.example.test: nodename nor servname provided, or not known', 'dns'],
    ['ssh: Could not resolve hostname x: Name or service not known', 'dns'],
    ['ssh: connect to host 10.0.0.9 port 22: Connection refused', 'refused'],
    ['ssh: connect to host 10.0.0.9 port 22: No route to host', 'unreachable'],
    ['Connection closed by UNKNOWN port 65535', 'unreachable'],
    ['ssh: connect to host h port 22: Operation timed out', 'timeout'],
    ['Remote connection to devbox timed out', 'timeout'],
    ['bun: command not found', 'runtime'],
    ['GLIBC_2.28 not found', 'runtime'],
    ['Daemon failed to start within 20s', 'daemon'],
    ['capability handshake failed', 'daemon'],
    ['ephemeral server: no daemon running on devbox and ephemeral sandboxes do not deploy/start remote daemons (attach-only)', 'ephemeral'],
    ['something nobody has seen before', 'unknown'],
  ])('%s → %s', (message, kind) => {
    expect(classifyHostConnectError(message, T).kind).toBe(kind);
  });

  it("the host's own names are not evidence: an alias like `nodedev` is not a runtime problem", () => {
    const names = ['nodedev', 'Bun box', 'nodedev.example.test', 'me'];
    const closed = 'Connection to nodedev failed 8s ago: kex_exchange_identification: Connection closed by remote host';
    expect(classifyHostConnectError(closed, 'me@nodedev.example.test', names).kind).toBe('unreachable');
    // Without the names the alias would have matched /node/ first.
    expect(classifyHostConnectError('Connection to nodedev failed 8s ago: exit 255', 'me@nodedev.example.test').kind).toBe('runtime');
    expect(classifyHostConnectError('Connection to nodedev failed 8s ago: exit 255', 'me@nodedev.example.test', names).kind).toBe('unknown');
    // Whole tokens only: the user `me` must not punch a hole in "permission".
    expect(classifyHostConnectError('me@nodedev.example.test: Permission denied (publickey).', 'me@nodedev.example.test', names).kind).toBe('auth');
    // A real runtime failure still reads as one.
    expect(classifyHostConnectError('bun: command not found', 'me@nodedev.example.test', names).kind).toBe('runtime');
  });

  it('a directory that cannot be listed on a CONNECTED host is a listing problem, not an SSH one', () => {
    const { kind, hint } = describeListingError('Big dev box');
    expect(kind).toBe('listing');
    expect(hint).toContain('Big dev box is connected');
    expect(hint).not.toMatch(/ssh/i);
  });

  it('the auth hint names the exact ssh command the user should test by hand', () => {
    const { hint } = classifyHostConnectError('Permission denied (publickey).', T);
    expect(hint).toContain(`ssh ${T}`);
    expect(hint).toMatch(/without a password prompt/);
  });

  it('the dns hint names the hostname and points at Settings › Hosts', () => {
    const { hint } = classifyHostConnectError('Could not resolve hostname', T);
    expect(hint).toContain(T);
    expect(hint).toMatch(/Settings › Hosts/);
  });

  it('every hint is one actionable sentence, never empty', () => {
    for (const m of ['Permission denied', 'Could not resolve hostname', 'Connection refused', 'No route to host', 'timed out', 'bun missing', 'handshake', 'attach-only', 'zzz']) {
      const { hint } = classifyHostConnectError(m, T);
      expect(hint.length).toBeGreaterThan(20);
      expect(hint.trim()).toBe(hint);
    }
  });
});

describe('describeConnectPhase', () => {
  const phases: DaemonConnectPhase[] = ['idle', 'ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake', 'connected', 'reconnecting', 'failed'];

  it('names the host in every phase', () => {
    for (const p of phases) expect(describeConnectPhase(p, 'Big dev box')).toContain('Big dev box');
  });

  it('the install phase warns that a first connect takes a while', () => {
    expect(describeConnectPhase('install-runtime', 'X')).toMatch(/first connect/);
  });

  it('IN_PROGRESS_PHASES excludes only the terminal states', () => {
    for (const p of phases) {
      expect(IN_PROGRESS_PHASES.has(p)).toBe(p !== 'connected' && p !== 'failed');
    }
  });
});
