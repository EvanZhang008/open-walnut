/**
 * buildHostStatus / listStatusHosts — the ONE shape every host-status surface
 * renders. Pure, so every phase is pinned here rather than being re-derived
 * (differently) by the HTTP route, the WS push and the folder picker.
 */
import { describe, it, expect } from 'vitest';
import { buildHostStatus, listStatusHosts, type HostDef } from '../../../src/core/hosts/host-status.js';
import { DAEMON_CONNECT_STEPS, describeConnectPhase } from '../../../src/core/sessions/host-connect-hint.js';
import type { DaemonConnectPhase, DaemonConnectState } from '../../../src/providers/daemon-connection.js';
import type { Config } from '../../../src/core/types.js';

const AT = new Date('2026-09-14T09:00:00Z').getTime();

const devbox: HostDef = { hostname: 'devbox.example.test', user: 'builder', label: 'Big dev box' };

function state(phase: DaemonConnectPhase, extra: Partial<DaemonConnectState> = {}): DaemonConnectState {
  return {
    host: 'devbox',
    connected: phase === 'connected',
    phase,
    phaseElapsedMs: 1_200,
    connectElapsedMs: 42_000,
    ...extra,
  };
}

describe('buildHostStatus — steps and wording per phase', () => {
  it('marks everything before the active step done and everything after todo', () => {
    for (const [i, phase] of DAEMON_CONNECT_STEPS.entries()) {
      const s = buildHostStatus('devbox', devbox, state(phase), undefined, AT);
      expect(s.steps.map((x) => x.status)).toEqual(
        DAEMON_CONNECT_STEPS.map((_, j) => (j < i ? 'done' : j === i ? 'active' : 'todo')),
      );
      expect(s.steps.map((x) => x.phase)).toEqual([...DAEMON_CONNECT_STEPS]);
      expect(s.phaseLabel).toBe(describeConnectPhase(phase, 'Big dev box'));
      expect(s.phase).toBe(phase);
    }
  });

  it('marks every step done once connected, and nothing active for idle/failed/reconnecting', () => {
    const connected = buildHostStatus('devbox', devbox, state('connected'), undefined, AT);
    expect(connected.connected).toBe(true);
    expect(connected.steps.every((x) => x.status === 'done')).toBe(true);

    // Not a position in the sequence: guessing one is how a progress bar lies.
    for (const phase of ['idle', 'failed', 'reconnecting'] as DaemonConnectPhase[]) {
      const s = buildHostStatus('devbox', devbox, state(phase), undefined, AT);
      expect(s.steps.every((x) => x.status === 'todo')).toBe(true);
    }
  });

  it('adds the first-connect note ONLY on the two slow steps', () => {
    for (const phase of DAEMON_CONNECT_STEPS) {
      const s = buildHostStatus('devbox', devbox, state(phase), undefined, AT);
      if (phase === 'install-runtime' || phase === 'upload') {
        expect(s.note).toContain('Big dev box');
        expect(s.note).toContain('minute');
      } else {
        expect(s.note).toBeUndefined();
      }
    }
    expect(buildHostStatus('devbox', devbox, state('connected'), undefined, AT).note).toBeUndefined();
  });

  it('carries the elapsed clocks and the snapshot time through', () => {
    const s = buildHostStatus('devbox', devbox, state('upload'), undefined, AT);
    expect(s).toMatchObject({
      host: 'devbox', label: 'Big dev box', hostname: 'devbox.example.test', user: 'builder',
      phaseElapsedMs: 1_200, connectElapsedMs: 42_000, at: AT,
    });
  });
});

describe('buildHostStatus — a failed connect becomes a next step', () => {
  it('classifies an auth failure and quotes the ssh target the user would type', () => {
    const s = buildHostStatus('devbox', devbox, state('failed', {
      error: 'Permission denied (publickey)', retryInMs: 47_000,
    }), undefined, AT);
    expect(s.error).toBe('Permission denied (publickey)');
    expect(s.kind).toBe('auth');
    expect(s.hint).toContain('ssh builder@devbox.example.test');
    expect(s.retryInMs).toBe(47_000);
  });

  it('does not classify anything when the phase is failed but no error is cached', () => {
    const s = buildHostStatus('devbox', devbox, state('failed'), undefined, AT);
    expect(s.error).toBeUndefined();
    expect(s.kind).toBeUndefined();
    expect(s.hint).toBeUndefined();
  });

  it('never reads the host or user name itself as the cause', () => {
    // A host literally named after a runtime must not be reported as a runtime
    // problem (the classifier blanks the user's own names first).
    const nodeBox: HostDef = { hostname: 'node-box.example.test', user: 'node', label: 'node-box' };
    const s = buildHostStatus('node-box', nodeBox, state('failed', {
      error: 'ssh: connect to host node-box.example.test port 22: Connection refused',
    }), undefined, AT);
    expect(s.kind).toBe('refused');
  });
});

describe('buildHostStatus — queued behind another host', () => {
  it('turns "idle + queued" into a wait with a sentence, no active step and no clock', () => {
    const s = buildHostStatus('marina', { hostname: 'marina.example.test' }, state('idle'), 'queued', AT);
    expect(s.phase).toBe('queued');
    expect(s.phaseLabel).toBe('Waiting for another host to finish connecting, then marina');
    expect(s.steps.every((step) => step.status === 'todo')).toBe(true);   // nothing has started
    expect(s.phaseElapsedMs).toBe(0);
    expect(s.warmup).toBe('queued');
  });

  it('a retried failure (cleared cause, back in line) reads as queued, not as a bare failure', () => {
    // The human hit Retry: the failure cache is gone, the warmup has the host,
    // but a stale 'failed' phase with no error can still be what the pool reports.
    const s = buildHostStatus('marina', { hostname: 'marina.example.test' }, state('failed'), 'queued', AT);
    expect(s.phase).toBe('queued');
    expect(s.error).toBeUndefined();
  });

  it('never hides real progress or a real failure behind "queued"', () => {
    expect(buildHostStatus('m', { hostname: 'm.example.test' }, state('ssh'), 'queued', AT).phase).toBe('ssh');
    expect(buildHostStatus('m', { hostname: 'm.example.test' }, state('connected', { connected: true }), 'queued', AT).phase).toBe('connected');
    const failed = buildHostStatus('m', { hostname: 'm.example.test' },
      state('failed', { error: 'Permission denied (publickey)' }), 'queued', AT);
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('Permission denied (publickey)');
    // Running / done / skipped never rewrite the phase either.
    expect(buildHostStatus('m', { hostname: 'm.example.test' }, state('idle'), 'running', AT).phase).toBe('idle');
    expect(buildHostStatus('m', { hostname: 'm.example.test' }, state('idle'), 'skipped', AT).phase).toBe('idle');
  });
});

describe('buildHostStatus — label, warmup and discovered', () => {
  it('falls back to the alias when the host has no label', () => {
    const s = buildHostStatus('marina', { hostname: 'marina.example.test' }, state('ssh'), undefined, AT);
    expect(s.label).toBe('marina');
    expect(s.phaseLabel).toContain('marina');
    expect(s.user).toBeUndefined();
  });

  it('passes the warmup state through, and flags a discovered host', () => {
    const s = buildHostStatus('marina', { hostname: 'marina.example.test', discovered: true },
      state('idle'), 'skipped', AT);
    expect(s.warmup).toBe('skipped');
    expect(s.discovered).toBe(true);

    const plain = buildHostStatus('marina', { hostname: 'marina.example.test' }, state('idle'), undefined, AT);
    expect(plain.warmup).toBeUndefined();
    expect(plain.discovered).toBeUndefined();
  });
});

describe('listStatusHosts', () => {
  const config = {
    hosts: {
      devbox: { hostname: 'devbox.example.test' },
      off: { hostname: 'off.example.test', enabled: false },
      'from-ssh-config': { hostname: 'acme-1.example.test', discovered: true, enabled: true },
      __local__: { hostname: 'localhost' },
    },
  } as unknown as Config;

  it('matches the folder picker: enabled hosts only, discovered included, never __local__', () => {
    expect(listStatusHosts(config).map((h) => h.key)).toEqual(['devbox', 'from-ssh-config']);
  });

  it('answers empty for a config with no hosts at all', () => {
    expect(listStatusHosts({} as Config)).toEqual([]);
  });
});

describe('buildHostStatus: first-connect facts (runtime, daemon dir, credential kinds)', () => {
  const readiness = { checkedAt: AT, problems: [], fixes: [] } as unknown as import('../../../src/core/hosts/host-readiness.js').HostReadiness;
  const fallbackDir = { path: '/home/builder/.cache/open-walnut', fallback: true, reason: '/tmp is read-only', freeMb: 4_000, home: '/home/builder' };

  it('says which runtime the daemon ended up on and where its files live', () => {
    const s = buildHostStatus('devbox', devbox, state('connected', { runtime: 'binary', daemonDir: fallbackDir }), undefined, AT, readiness);
    expect(s.runtime).toBe('binary');
    expect(s.daemonDir).toEqual({ path: '/home/builder/.cache/open-walnut', display: '~/.cache/open-walnut', fallback: true, reason: '/tmp is read-only', freeMb: 4_000 });
    expect(s.warnings).toEqual(['Using `~/.cache/open-walnut` for the session daemon because `/tmp` is read-only.']);
    expect(s.readiness?.problems).toEqual([{
      kind: 'daemon_dir_fallback',
      message: 'Big dev box: Using `~/.cache/open-walnut` for the session daemon because `/tmp` is read-only.',
      commands: [],
    }]);
  });

  it('a disk below 200 MB is a readiness problem with the number and the command that shows where it went', () => {
    const tmpDir = { path: '/tmp/open-walnut', fallback: false, freeMb: 120, home: '/home/builder' };
    const s = buildHostStatus('devbox', devbox, state('connected', { runtime: 'bun', daemonDir: tmpDir }), undefined, AT, readiness);
    expect(s.warnings).toBeUndefined();
    expect(s.readiness?.problems).toEqual([{
      kind: 'disk_low',
      message: 'Big dev box has only 120 MB free where the session daemon keeps its files (`/tmp/open-walnut`); sessions need at least 200 MB. Free some space there (`df -h /tmp` shows where it went).',
      commands: ['df -h /tmp'],
    }]);
  });

  it('a healthy /tmp adds nothing, and while disconnected the connect error stays the story', () => {
    const ok = { path: '/tmp/open-walnut', fallback: false, freeMb: 9_000, home: '/home/builder' };
    const up = buildHostStatus('devbox', devbox, state('connected', { daemonDir: ok }), undefined, AT, readiness);
    expect(up.readiness).toBe(readiness);
    expect(up.warnings).toBeUndefined();
    const down = buildHostStatus('devbox', devbox, state('failed', { daemonDir: fallbackDir, error: 'x' }), undefined, AT, readiness);
    expect(down.readiness).toBeUndefined();
  });

  it.each([
    ['Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-14 08:00)', 'cert_expired', false],
    ['Could not open a connection to your authentication agent.', 'agent_missing', false],
    ['@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.', 'host_key', false],
    ['kex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535', 'proxy', true],
    // The cached one-line summary of a proxy whose own login expired (the tag keeps the kind).
    ['Error: Acme SSH Client returned an error when reaching to Acme SSH Proxy: An error… [walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]', 'proxy_login', false],
  ] as const)('classifies %j as %s (retryable %s)', (error, kind, retryable) => {
    const s = buildHostStatus('devbox', devbox, state('failed', { error }), undefined, AT);
    expect(s.kind).toBe(kind);
    expect(s.retryable).toBe(retryable);
    expect(s.hint).not.toMatch(/[\u2013\u2014]/);
  });

  it('a host key hint names the exact ssh-keygen -R line, with the port when there is one', () => {
    const s = buildHostStatus('devbox', { ...devbox, port: 2222 }, state('failed', { error: 'Host key verification failed.' }), undefined, AT);
    expect(s.hint).toContain("`ssh-keygen -R '[devbox.example.test]:2222'`");
  });
});

describe('buildHostStatus: the wire contract the banner, picker and Settings read', () => {
  it('an ephemeral server says off: grey, no error, no hint, no readiness', () => {
    const s = buildHostStatus('devbox', devbox, state('failed', { error: 'ephemeral server: remote host is off' }), undefined, AT, undefined, { off: true });
    expect(s).toMatchObject({ phase: 'off', phaseLabel: 'Off on this test server', connected: false, serverNow: AT, at: AT });
    expect(s.error).toBeUndefined();
    expect(s.kind).toBeUndefined();
    expect(s.hint).toBeUndefined();
    expect(s.readiness).toBeUndefined();
  });

  it('a failed frame carries retryable, and retryAt only when a re-dial is really scheduled', () => {
    const cert = buildHostStatus('devbox', devbox, state('failed', { error: 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (x)' }),
      undefined, AT, undefined, { credentialRetryAt: AT + 192_000 });
    expect(cert).toMatchObject({ kind: 'cert_expired', retryable: false, retryAt: AT + 192_000 });
    const net = buildHostStatus('devbox', devbox, state('failed', { error: 'ssh: connect to host devbox.example.test port 22: No route to host' }),
      undefined, AT, undefined, { credentialRetryAt: AT + 1 });
    expect(net).toMatchObject({ kind: 'unreachable', retryable: true });
    expect(net.retryAt).toBeUndefined();
  });

  it('a standing reconnect cause keeps its own kind and slow-probe retryAt', () => {
    const s = buildHostStatus('devbox', devbox, state('failed', { error: 'Permission denied (publickey).', kind: 'auth', retryAt: AT + 600_000, reconnectSince: AT - 5_000 }), undefined, AT);
    expect(s).toMatchObject({ kind: 'auth', retryAt: AT + 600_000, reconnectSince: AT - 5_000, retryable: false });
    expect(s.hint).toContain('ssh builder@devbox.example.test');
  });

  it('reconnecting carries lastError / lastKind / lastHint and reconnectSince, never an error', () => {
    const s = buildHostStatus('devbox', devbox, state('reconnecting', { lastError: 'Operation timed out', lastKind: 'timeout', reconnectSince: AT - 60_000, attemptStartedAt: AT - 1_000 }), undefined, AT);
    expect(s).toMatchObject({ phase: 'reconnecting', lastKind: 'timeout', lastError: 'Operation timed out', reconnectSince: AT - 60_000, attemptStartedAt: AT - 1_000 });
    expect(s.lastHint).toBeTruthy();
    expect(s.error).toBeUndefined();
  });

  it('connected frames carry connectedAt; the host_key hint names the port (C37 connect half)', () => {
    const c = buildHostStatus('devbox', devbox, state('connected', { connectedAt: AT - 3_000 }), undefined, AT);
    expect(c.connectedAt).toBe(AT - 3_000);
    const k = buildHostStatus('devbox', { ...devbox, port: 2222 }, state('failed', { error: 'Host key verification failed.' }), undefined, AT);
    expect(k.kind).toBe('host_key');
    expect(k.hint).toContain("'[devbox.example.test]:2222'");
  });
});
