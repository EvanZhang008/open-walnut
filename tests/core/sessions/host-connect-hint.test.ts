/**
 * host-connect-hint — connect phases and failures become sentences a first-time
 * user can act on. Pure mapping, so every kind is pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHostConnectError,
  hintForKind,
  hintSubject,
  RETRYABLE,
  credentialRetryDelayMs,
  CREDENTIAL_WAIT_KINDS,
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
    ['Host key verification failed.', 'host_key'],
    ['ssh: Could not resolve hostname devbox.example.test: nodename nor servname provided, or not known', 'dns'],
    ['ssh: Could not resolve hostname x: Name or service not known', 'dns'],
    ['ssh: connect to host 10.0.0.9 port 22: Connection refused', 'refused'],
    ['ssh: connect to host 10.0.0.9 port 22: No route to host', 'unreachable'],
    ['Connection closed by UNKNOWN port 65535', 'proxy'],
    ['Connection closed by 10.0.0.9 port 22', 'unreachable'],
    ['ssh: connect to host h port 22: Operation timed out', 'timeout'],
    ['Remote connection to devbox timed out', 'timeout'],
    ['bun: command not found', 'runtime'],
    ['GLIBC_2.28 not found', 'runtime'],
    ['Daemon failed to start within 20s', 'daemon'],
    ['capability handshake failed', 'daemon'],
    ['ephemeral server: no daemon running on devbox and ephemeral sandboxes do not deploy/start remote daemons (attach-only)', 'ephemeral'],
    ["ephemeral server: remote host 'devbox' is off for test servers (set WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to attach anyway)", 'ephemeral'],
    ['something nobody has seen before', 'unknown'],
  ])('%s → %s', (message, kind) => {
    expect(classifyHostConnectError(message, T).kind).toBe(kind);
  });

  it("the host's own names are not evidence: an alias like `nodedev` is not a runtime problem", () => {
    const names = ['nodedev', 'Bun box', 'nodedev.example.test', 'me'];
    const closed = 'Connection to nodedev failed 8s ago: kex_exchange_identification: Connection closed by remote host';
    expect(classifyHostConnectError(closed, 'me@nodedev.example.test', names).kind).toBe('proxy');
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

  it('C36: the dns hint quotes the bare hostname (never user@host) and points at Settings › Remote Hosts', () => {
    const { hint } = classifyHostConnectError('Could not resolve hostname', T);
    expect(hint).toContain('"devbox.example.test"');
    expect(hint).toMatch(/Settings › Remote Hosts/);
    const quoted = hint.match(/"([^"]+)"/)![1];
    expect(quoted).not.toContain('@');
    const withTarget = classifyHostConnectError('Could not resolve hostname', T, [], { hostname: 'devbox.example.com', label: 'Dev box' });
    expect(withTarget.hint).toBe('The hostname "devbox.example.com" does not resolve from this machine. Check the hostname in Settings › Remote Hosts (or your VPN / SSH config).');
  });

  it('every hint is one actionable sentence, never empty', () => {
    for (const m of ['Permission denied', 'Could not resolve hostname', 'Connection refused', 'No route to host', 'timed out', 'bun missing', 'handshake', 'attach-only', 'zzz',
      'Host key verification failed.', 'walnut-ssh-evidence: cert-expired (x)', 'Could not open a connection to your authentication agent.',
      'kex_exchange_identification: read: Connection reset by peer', 'shell_noise: no markers']) {
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

/**
 * Captured ssh stderr, one real shape per new kind. Each carries the text ssh
 * actually prints (OpenSSH 9/10), including the echoed command Walnut's own
 * error adds in front, because the classifier sees the whole message.
 */
const ECHO = 'Command failed: ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ControlPath=/tmp/walnut-ssh-devbox-1 me@devbox.example.test sh -s';

const CAPTURED: Array<[string, string, string]> = [
  ['host_key', 'changed key, strict checking', [
    ECHO,
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Offending ED25519 key in /home/me/.ssh/known_hosts:12',
    'Host key for devbox.example.test has changed and you have requested strict checking.',
    'Host key verification failed.',
  ].join('\n')],
  ['host_key', 'changed key under StrictHostKeyChecking=no (the tunnel loses port forwarding)', [
    'SSH tunnel created but port 51234 not accepting connections after 10s',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    'Password authentication is disabled to avoid man-in-the-middle attacks.',
    'Port forwarding is disabled to avoid man-in-the-middle attacks.',
  ].join('\n')],
  ['cert_expired', 'publickey refusal plus the local agent evidence', [
    ECHO, 'me@devbox.example.test: Permission denied (publickey).',
    'walnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-24 08:00)',
  ].join('\n')],
  ['cert_expired', 'the one-line cached summary keeps the evidence', 'Permission denied (publickey). [walnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-24 08:00)]'],
  ['agent_missing', 'ssh-add style agent refusal', 'Could not open a connection to your authentication agent.'],
  ['agent_missing', 'dead agent socket', [ECHO, 'Error connecting to agent: No such file or directory', 'me@devbox.example.test: Permission denied (publickey).'].join('\n')],
  ['agent_missing', 'publickey refusal with SSH_AUTH_SOCK unset', [
    ECHO, 'me@devbox.example.test: Permission denied (publickey).',
    'walnut-ssh-evidence: agent-missing (SSH_AUTH_SOCK is not set for Walnut)',
  ].join('\n')],
  ['proxy', 'ProxyCommand that died', [
    ECHO, '/bin/sh: line 1: jump-helper: command not found',
    'kex_exchange_identification: Connection closed by remote host',
    'Connection closed by UNKNOWN port 65535',
  ].join('\n')],
  ['proxy', 'ProxyJump bastion that cannot reach the target', [
    ECHO, 'channel 0: open failed: connect failed: No route to host',
    'stdio forwarding failed',
    'Connection closed by UNKNOWN port 65535',
  ].join('\n')],
  ['shell_noise', 'login shell that never ran sh -s', "shell_noise: the login shell on me@devbox.example.test answered without Walnut's output markers (it did not run `sh -s` as written). It printed: This account is restricted."],
];

describe('classifyHostConnectError: captured ssh stderr for each new kind', () => {
  it.each(CAPTURED)('%s: %s', (kind, _label, message) => {
    const r = classifyHostConnectError(message, T, ['devbox', 'devbox.example.test', 'me'], { hostname: 'devbox.example.test' });
    expect(r.kind).toBe(kind);
    expect(r.hint.trim()).toBe(r.hint);
    expect(r.hint).not.toMatch(/\n/);
  });

  it("Walnut's own echoed `-o StrictHostKeyChecking=no` is never host key evidence", () => {
    const m = `${ECHO}\nme@devbox.example.test: Permission denied (publickey).`;
    expect(classifyHostConnectError(m, T).kind).toBe('auth');
  });

  it('the host_key hint names the exact ssh-keygen -R command and why not to run it blindly', () => {
    const { hint } = classifyHostConnectError('Host key verification failed.', T, [], { hostname: 'devbox.example.test' });
    expect(hint).toContain('`ssh-keygen -R devbox.example.test`');
    expect(hint).toMatch(/intercepting/);
    // A non-default port is stored as [host]:port in known_hosts.
    const ported = classifyHostConnectError('Host key verification failed.', T, [], { hostname: 'devbox.example.test', port: 2222 });
    expect(ported.hint).toContain("`ssh-keygen -R '[devbox.example.test]:2222'`");
  });

  it('the cert_expired hint names no product, only "your organization\'s login command"', () => {
    const { hint } = classifyHostConnectError('walnut-ssh-evidence: cert-expired (x)', T);
    expect(hint).toMatch(/SSH certificate expired/);
    expect(hint).toMatch(/organization's login command/);
    expect(hint).toMatch(/Retry/);
  });

  it('retryable: a plain retry can work for network-shaped kinds, not for ones a person must fix', () => {
    const r = (m: string) => classifyHostConnectError(m, T).retryable;
    expect(r('Connection closed by UNKNOWN port 65535')).toBe(true);
    expect(r('ssh: connect to host h port 22: Operation timed out')).toBe(true);
    expect(r('No route to host')).toBe(true);
    expect(r('Host key verification failed.')).toBe(false);
    expect(r('Permission denied (publickey).')).toBe(false);
    expect(r('walnut-ssh-evidence: cert-expired (x)')).toBe(false);
    expect(r('shell_noise: x')).toBe(false);
    expect(describeListingError('X').retryable).toBe(true);
  });

  it('the credential kinds are the ones the warmup re-dials on 1, 2, 5, 10 minutes, then hourly', () => {
    expect([...CREDENTIAL_WAIT_KINDS].sort()).toEqual(['agent_missing', 'cert_expired']);
    expect([0, 1, 2, 3, 4, 9].map(credentialRetryDelayMs)).toEqual([60_000, 120_000, 300_000, 600_000, 3_600_000, 3_600_000]);
  });
});

/** Text outside `backticks`: the prose a person reads. */
const prose = (hint: string) => hint.split('`').filter((_, i) => i % 2 === 0).join(' ');

describe('C87: the hint calls the host by its label; user@host only inside a command', () => {
  const target = { label: 'Dev box', hostname: 'devbox.example.com', user: 'alice' };
  const ssh = 'alice@devbox.example.com';
  it.each(['unreachable', 'timeout', 'proxy', 'refused', 'dns', 'shell_noise', 'host_key', 'auth', 'listing', 'unknown'] as const)('%s', (kind) => {
    const hint = hintForKind(kind, ssh, target);
    expect(prose(hint)).not.toContain('@');
    if (kind !== 'dns' && kind !== 'auth' && kind !== 'unknown') expect(hint).toContain('Dev box');
  });
  it('the subject falls back to the hostname when there is no label', () => {
    expect(hintSubject(ssh, { hostname: 'devbox.example.com' })).toBe('devbox.example.com');
    expect(hintSubject('-p 2222 alice@devbox.example.com')).toBe('devbox.example.com');
    const hint = hintForKind('unreachable', ssh, { hostname: 'devbox.example.com' });
    expect(hint.startsWith('devbox.example.com is not reachable')).toBe(true);
    expect(prose(hintForKind('timeout', ssh)).includes('@')).toBe(false);
  });
  it('the command inside backticks keeps the full ssh target', () => {
    expect(hintForKind('proxy', ssh, target)).toContain('`ssh alice@devbox.example.com`');
  });
  it('C60: no hint promises a retry by itself (the countdown is the promise)', () => {
    for (const kind of Object.keys(RETRYABLE) as Array<keyof typeof RETRYABLE>) {
      expect(hintForKind(kind, ssh, target)).not.toMatch(/retries by itself/);
    }
  });
  it('host_key names [host]:port for a non-default port', () => {
    expect(hintForKind('host_key', ssh, { ...target, port: 2222 })).toContain("`ssh-keygen -R '[devbox.example.com]:2222'`");
    expect(hintForKind('host_key', ssh, { ...target, port: 22 })).toContain('`ssh-keygen -R devbox.example.com`');
  });
});
