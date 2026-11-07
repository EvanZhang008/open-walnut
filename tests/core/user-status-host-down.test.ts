/**
 * A task whose live session's host nothing reaches reads Waiting on its machine at once
 * (2026-11-06: a host's sign-in expired; its tasks read Working while a person's messages
 * to them went nowhere). The status is the one every surface reads: task rows, the Org page,
 * the phone. Its own ask to the user still speaks.
 */
import { describe, it, expect } from 'vitest';
import { deriveUserStatus, hostDownWords } from '../../src/core/user-status.js';

describe('a task whose host is unreachable now', () => {
  it('a running turn reads Waiting on its machine, naming the host', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', hostDown: 'devbox' });
    expect(s).toMatchObject({ state: 'waiting', kind: 'machine', waitingOn: hostDownWords('devbox') });
    expect(s.waitingOn).toContain('devbox');
  });

  it('an idle session too', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', hostDown: 'devbox' });
    expect(s).toMatchObject({ state: 'waiting', kind: 'machine' });
  });

  it('its own latest ask to the user still speaks', () => {
    const turnEnd = new Date(Date.now() - 60_000).toISOString();
    const s = deriveUserStatus({
      phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', hostDown: 'devbox',
      report: { state: 'needs', ask: 'Pick the staging account to use', at: turnEnd, user_kind: 'user_info', user_kind_why: 'only the user knows which account' } as never,
      lastTurnEndAt: turnEnd,
    } as never);
    expect(s.state).not.toBe('waiting');
  });

  it('a host that is up changes nothing', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', hostDown: null });
    expect(s.state).toBe('working');
  });
});

describe('a stopped session on an unreachable host', () => {
  it('a task whose work is under way waits on its machine', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped', hostDown: 'devbox' });
    expect(s).toMatchObject({ state: 'waiting', kind: 'machine' });
  });

  it('a finished turn to read is not hidden behind the host', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', hostDown: 'devbox' });
    expect(s.kind).not.toBe('machine');
  });
});

describe('every real ask of the user, and an escalation, stays over the host outage', () => {
  const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle' } as const;
  for (const [what, extra] of [
    ['a live permission prompt', { pendingPermissionTool: 'Bash' }],
    ['an open decision letter', { openLetter: 'Approve the mail send' }],
    ['an open Board choice', { openChoice: 'Pick a layout' }],
  ] as const) {
    it(what, () => {
      const without = deriveUserStatus({ ...base, ...extra } as never);
      const withDown = deriveUserStatus({ ...base, ...extra, hostDown: 'devbox' } as never);
      expect(without.state).toBe('needs');
      expect(withDown).toEqual(without);
    });
  }

  it('a host stop a day old still goes to its lead, or to the user', () => {
    const since = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const stop = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'error', errorReason: 'remote_unreachable', errorKind: 'infra', statusSince: since } as const;
    for (const lead of [false, true]) {
      const without = deriveUserStatus({ ...stop, hasLeader: lead } as never);
      const withDown = deriveUserStatus({ ...stop, hasLeader: lead, hostDown: 'devbox' } as never);
      expect(without.kind === 'machine', `lead=${lead}`).toBe(false);
      expect(withDown).toEqual(without);
    }
  });

  it('a short machine wait names the host', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'error', errorReason: 'remote_unreachable', errorKind: 'infra', statusSince: new Date().toISOString(), hostDown: 'devbox' } as never);
    expect(s).toMatchObject({ state: 'waiting', kind: 'machine', waitingOn: hostDownWords('devbox') });
  });
});
