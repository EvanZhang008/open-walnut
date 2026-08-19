import { describe, it, expect } from 'vitest';
import {
  dtachSocketPath,
  dtachOwnerMarkerPath,
  dtachOwnerClaimScript,
  buildDtachArgs,
  buildRemoteDtachCommand,
  buildRemoteSshArgs,
  DTACH_SOCKET_DIR,
} from '../../../src/web/terminal/spawn.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import type { SshTarget } from '../../../src/providers/session-io.js';

describe('dtachSocketPath', () => {
  it('derives a stable socket path under the dedicated dir from the session id', () => {
    expect(dtachSocketPath('abc-123')).toBe(`${DTACH_SOCKET_DIR}/walnut-abc-123.dsock`);
  });

  it('is stable across calls — guarantees idempotent re-attach after server restart', () => {
    const sid = 'sess-xyz';
    expect(dtachSocketPath(sid)).toBe(dtachSocketPath(sid));
  });

  it('rejects ids with shell metacharacters (fail fast, no injectable command)', () => {
    expect(() => dtachSocketPath('test$(whoami)')).toThrow(/Unsafe session id/);
    expect(() => dtachSocketPath('test;id')).toThrow(/Unsafe session id/);
    expect(() => dtachSocketPath('a b')).toThrow(/Unsafe session id/);
    // Real Claude session IDs (UUID form) are accepted.
    expect(dtachSocketPath('7b370f7c-c1bd-4961-b7cf-2a69d34d5854')).toBe(
      `${DTACH_SOCKET_DIR}/walnut-7b370f7c-c1bd-4961-b7cf-2a69d34d5854.dsock`,
    );
  });
});

describe('buildDtachArgs (local)', () => {
  it('uses -A (attach-or-create) + native-friendly flags + LOGIN shell (-l)', () => {
    // -A: idempotent attach-or-create (like tmux new-session -A).
    // -z: Ctrl-Z reaches the shell. -E: Ctrl-\ reaches the program (we detach by
    // closing the connection, not a keystroke). -r winch: redraw on reattach.
    // Trailing `-l`: launch the shell as a LOGIN shell so the full startup chain
    // (PATH + aliases) loads — the embedded terminal matches tmux, not a bare
    // aliasless shell.
    const args = buildDtachArgs('/path/dtach', 'sid1', '/bin/zsh');
    expect(args).toEqual([
      '/path/dtach', '-A', `${DTACH_SOCKET_DIR}/walnut-sid1.dsock`, '-z', '-E', '-r', 'winch', '/bin/zsh', '-l',
    ]);
  });
});

describe('buildRemoteDtachCommand', () => {
  // Default remote shell expr, expanded BY the remote shell (unquoted on
  // purpose) so the login user's actual $SHELL (zsh on our dev hosts) is used,
  // launched as a login shell (`-l`) — matching tmux.
  const DEFAULT_SHELL = '"${SHELL:-/bin/bash}"';

  it('defaults to the remote $SHELL as a LOGIN shell, cds to cwd', () => {
    expect(buildRemoteDtachCommand('/home/u/.local/bin/walnut-dtach', 'sid2', undefined, '/var/data')).toBe(
      `${dtachOwnerClaimScript()}; cd '/var/data' && exec '/home/u/.local/bin/walnut-dtach' -A '${DTACH_SOCKET_DIR}/walnut-sid2.dsock' -z -E -r winch ${DEFAULT_SHELL} -l`,
    );
  });

  it('leaves the $SHELL expression UNQUOTED so it expands on the remote host', () => {
    // If we shell-quoted it, the remote would try to exec a file literally named
    // `${SHELL:-/bin/bash}` instead of expanding it — the bug we are avoiding.
    const cmd = buildRemoteDtachCommand('dtach', 'sid2', undefined, '/x');
    expect(cmd).toContain('-r winch "${SHELL:-/bin/bash}" -l');
    expect(cmd).not.toContain(`'"\${SHELL`); // not single-quoted
  });

  it('shell-quotes a cwd containing single quotes safely', () => {
    const cmd = buildRemoteDtachCommand('dtach', 'sid2', undefined, "/weird/it's here");
    expect(cmd).toContain("cd '/weird/it'\\''s here' &&");
  });

  it('omits the cd prefix when no cwd (still makes the socket dir + execs login shell)', () => {
    expect(buildRemoteDtachCommand('dtach', 'sid2')).toBe(
      `${dtachOwnerClaimScript()}; exec 'dtach' -A '${DTACH_SOCKET_DIR}/walnut-sid2.dsock' -z -E -r winch ${DEFAULT_SHELL} -l`,
    );
  });
});

describe('dtachOwnerClaimScript (socket-dir ownership marker)', () => {
  it('mkdirs the socket dir and writes MY data dir into .owner', () => {
    const script = dtachOwnerClaimScript();
    expect(script).toContain(`mkdir -p '${DTACH_SOCKET_DIR}'`);
    expect(script).toContain(`'${DTACH_SOCKET_DIR}/.owner'`);
    expect(script).toContain(`'${WALNUT_HOME}'`);
  });

  it('never overwrites an existing claim (guarded by [ -e marker ])', () => {
    // First-writer-wins: a misconfigured second instance spawning into someone
    // else's socket dir must not steal ownership.
    expect(dtachOwnerClaimScript()).toContain(`[ -e '${dtachOwnerMarkerPath()}' ] ||`);
  });

  it('marker path lives inside the socket dir', () => {
    expect(dtachOwnerMarkerPath()).toBe(`${DTACH_SOCKET_DIR}/.owner`);
  });
});

describe('buildRemoteSshArgs', () => {
  const target: SshTarget = { hostname: 'dev.example.com', user: 'alice' };

  it('forces a remote PTY (-tt) and enables keepalive', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, undefined, '/home/alice/x');
    expect(args).toContain('-tt');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args).toContain('BatchMode=yes');
  });

  it('targets user@hostname and ends with the login-shell dtach command', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, undefined, '/home/alice/x');
    expect(args).toContain('alice@dev.example.com');
    const last = args[args.length - 1];
    expect(last).toContain(`mkdir -p '${DTACH_SOCKET_DIR}'`);
    expect(last).toContain("cd '/home/alice/x' && exec 'dtach' -A");
    expect(last).toContain('walnut-sid3.dsock');
    // default → remote $SHELL launched as a login shell
    expect(last).toContain('"${SHELL:-/bin/bash}" -l');
  });

  it('adds -p when a port is configured', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', { hostname: 'h', port: 2222 }, undefined, undefined);
    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('omits user prefix when no user is set', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', { hostname: 'h' }, undefined, undefined);
    expect(args).toContain('h');
    expect(args).not.toContain('@h');
  });

  it('includes the ControlMaster socket args when a host alias is given', () => {
    const args = buildRemoteSshArgs('dtach', 'sid3', target, undefined, '/x', 'devbox');
    expect(args).toContain('ControlMaster=auto');
    expect(args.some((a) => a.includes('walnut-term-ssh-devbox'))).toBe(true);
  });
});
