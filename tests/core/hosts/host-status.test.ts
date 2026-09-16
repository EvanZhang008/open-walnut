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
