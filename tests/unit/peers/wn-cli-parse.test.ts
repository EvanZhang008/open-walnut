/**
 * Unit test: walnut CLI pure surface — argv parsing, error-code → exit-code
 * mapping, wait-result evaluation, help text. No socket involved.
 *
 * The `peers` subcommand is GONE: listing and messaging sessions are ordinary
 * registry ops (`session_list` / `session_send`) reached through `tools call`,
 * so the only thing left of `peers` is a usage error that points at the
 * replacement. `walnut wait <id>` is the new blocking primitive.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWalnutCliArgs,
  errorToExitCode,
  evaluateWaitResult,
  formatErrorLines,
  formatToolsTable,
  helpText,
  WAIT_DEFAULT_TIMEOUT_SECS,
  WAIT_MAX_TIMEOUT_SECS,
} from '../../../src/providers/wn-cli.js';

describe('parseWalnutCliArgs — retired peers surface', () => {
  it('answers every `peers …` form with a usage error that names the replacement', () => {
    for (const argv of [
      ['peers'],
      ['peers', 'list'],
      ['peers', 'list', '--json'],
      ['peers', 'send', '9f3a', 'build', 'is', 'ready'],
      ['peers', 'kill'],
      ['peers', '--help'],
    ]) {
      const res = parseWalnutCliArgs(argv);
      expect(res.kind, argv.join(' ')).toBe('usage-error');
      if (res.kind !== 'usage-error') continue;
      // The pointer is the whole value of keeping the branch — an agent that
      // learned `walnut peers send` must be told the exact new command.
      expect(res.message).toContain('peers was replaced');
      expect(res.message).toContain('session_list');
      expect(res.message).toContain('session_send');
    }
  });
});

describe('parseWalnutCliArgs — tools + guide', () => {
  it('parses the tools subcommands', () => {
    expect(parseWalnutCliArgs(['tools', 'list'])).toEqual({ kind: 'tools.list', json: false });
    expect(parseWalnutCliArgs(['tools', 'list', '--json'])).toEqual({ kind: 'tools.list', json: true });
    expect(parseWalnutCliArgs(['tools', 'help', 'session_send'])).toEqual({ kind: 'tools.help', name: 'session_send' });
    expect(parseWalnutCliArgs(['tools', 'call', 'session_send', '{"to":"9f3a","text":"hi"}'])).toEqual({
      kind: 'tools.call', name: 'session_send', rawJson: '{"to":"9f3a","text":"hi"}',
    });
    expect(parseWalnutCliArgs(['tools', 'call', 'task_list'])).toEqual({
      kind: 'tools.call', name: 'task_list', rawJson: undefined,
    });
  });

  it('rejects bad tools usage', () => {
    expect(parseWalnutCliArgs(['tools', 'list', '--verbose']).kind).toBe('usage-error');
    expect(parseWalnutCliArgs(['tools', 'help']).kind).toBe('usage-error');
    expect(parseWalnutCliArgs(['tools', 'call']).kind).toBe('usage-error');
    expect(parseWalnutCliArgs(['tools', 'nope']).kind).toBe('usage-error');
  });

  it('`tools call <op> --help` asks for the SCHEMA, never the JSON parser', () => {
    // 2026-09-01: --help arrived as the args payload, so the answer to "what
    // does this op take?" was 'invalid JSON arguments: JSON Parse error'.
    for (const flag of ['--help', '-h']) {
      expect(parseWalnutCliArgs(['tools', 'call', 'note_read', flag])).toEqual({
        kind: 'tools.help', name: 'note_read',
      });
    }
    // A payload that merely CONTAINS the word stays a call.
    expect(parseWalnutCliArgs(['tools', 'call', 'session_send', '{"text":"--help"}'])).toEqual({
      kind: 'tools.call', name: 'session_send', rawJson: '{"text":"--help"}',
    });
  });

  it('`tools help <op> --json` still names the op (flags are not the op name)', () => {
    expect(parseWalnutCliArgs(['tools', 'help', '--json', 'note_edit'])).toEqual({
      kind: 'tools.help', name: 'note_edit',
    });
  });

  it('parses guide and rejects extra guide arguments', () => {
    expect(parseWalnutCliArgs(['guide'])).toEqual({ kind: 'guide' });
    expect(parseWalnutCliArgs(['guide', 'extra']).kind).toBe('usage-error');
    expect(parseWalnutCliArgs(['guide', '--json']).kind).toBe('usage-error');
  });

  it('maps --help / -h / help to help, and only two topics exist', () => {
    expect(parseWalnutCliArgs(['--help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWalnutCliArgs(['-h'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWalnutCliArgs(['help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWalnutCliArgs(['tools', '--help'])).toEqual({ kind: 'help', topic: 'tools' });
    expect(parseWalnutCliArgs(['tools'])).toEqual({ kind: 'help', topic: 'tools' });
  });

  it('rejects missing command / unknown command', () => {
    expect(parseWalnutCliArgs([]).kind).toBe('usage-error');
    expect(parseWalnutCliArgs(['tasks']).kind).toBe('usage-error');
  });
});

describe('parseWalnutCliArgs — wait', () => {
  it('parses a bare id with the default budget', () => {
    expect(parseWalnutCliArgs(['wait', 't-abc123'])).toEqual({
      kind: 'wait', id: 't-abc123', timeoutSecs: WAIT_DEFAULT_TIMEOUT_SECS, json: false,
    });
  });

  it('accepts --json in any position', () => {
    expect(parseWalnutCliArgs(['wait', 'rq-abc123', '--json'])).toEqual({
      kind: 'wait', id: 'rq-abc123', timeoutSecs: WAIT_DEFAULT_TIMEOUT_SECS, json: true,
    });
    expect(parseWalnutCliArgs(['wait', '--json', 'rq-abc123'])).toEqual({
      kind: 'wait', id: 'rq-abc123', timeoutSecs: WAIT_DEFAULT_TIMEOUT_SECS, json: true,
    });
  });

  it('requires an id', () => {
    const res = parseWalnutCliArgs(['wait']);
    expect(res.kind).toBe('usage-error');
    if (res.kind === 'usage-error') expect(res.message).toContain('wait requires');
    expect(parseWalnutCliArgs(['wait', '--json']).kind).toBe('usage-error');
  });

  it('validates --timeout and clamps it to the 24h ceiling', () => {
    expect(parseWalnutCliArgs(['wait', 't-1', '--timeout', '60'])).toEqual({
      kind: 'wait', id: 't-1', timeoutSecs: 60, json: false,
    });
    // Above the ceiling is clamped, not refused — a long wait is still a wait.
    expect(parseWalnutCliArgs(['wait', 't-1', '--timeout', '999999'])).toEqual({
      kind: 'wait', id: 't-1', timeoutSecs: WAIT_MAX_TIMEOUT_SECS, json: false,
    });
    for (const bad of ['0', '-5', 'abc', undefined]) {
      const argv = ['wait', 't-1', '--timeout', ...(bad === undefined ? [] : [bad])];
      const res = parseWalnutCliArgs(argv);
      expect(res.kind, argv.join(' ')).toBe('usage-error');
      if (res.kind === 'usage-error') expect(res.message).toContain('--timeout needs seconds > 0');
    }
  });

  it('rejects unknown flags and a second positional argument', () => {
    expect(parseWalnutCliArgs(['wait', 't-1', '--verbose']).kind).toBe('usage-error');
    const extra = parseWalnutCliArgs(['wait', 't-1', 't-2']);
    expect(extra.kind).toBe('usage-error');
    if (extra.kind === 'usage-error') expect(extra.message).toContain('unexpected argument');
  });

  it('treats --help inside wait as the root help', () => {
    expect(parseWalnutCliArgs(['wait', '--help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWalnutCliArgs(['wait', 't-1', '-h'])).toEqual({ kind: 'help', topic: 'root' });
  });
});

describe('evaluateWaitResult', () => {
  it('rq- ids settle when the request leaves pending', () => {
    const pending = evaluateWaitResult('rq-abc123', { request: { status: 'pending' } });
    expect(pending.done).toBe(false);
    expect(pending.summary).toEqual({ request: 'rq-abc123', status: 'pending' });

    const replied = evaluateWaitResult('rq-abc123', { request: { status: 'replied', outcome: 'answered' } });
    expect(replied.done).toBe(true);
    expect(replied.summary).toEqual({ request: 'rq-abc123', status: 'replied', outcome: 'answered' });

    for (const status of ['notified', 'expired']) {
      expect(evaluateWaitResult('rq-abc123', { request: { status } }).done).toBe(true);
    }
  });

  it('rq- ids accept a flat body and never settle on a missing status', () => {
    expect(evaluateWaitResult('rq-abc123', { status: 'replied' }).done).toBe(true);
    const unknown = evaluateWaitResult('rq-abc123', {});
    expect(unknown.done).toBe(false);
    expect(unknown.summary).toEqual({ request: 'rq-abc123', status: 'unknown' });
  });

  it('task ids settle at AGENT_COMPLETE / COMPLETE only', () => {
    const running = evaluateWaitResult('t-abc123', { task: { id: 't-abc123', title: 'Fix it', phase: 'IN_PROGRESS' } });
    expect(running.done).toBe(false);
    expect(running.summary).toEqual({ task: 't-abc123', title: 'Fix it', phase: 'IN_PROGRESS' });

    for (const phase of ['AGENT_COMPLETE', 'COMPLETE']) {
      const r = evaluateWaitResult('t-abc123', { task: { id: 't-abc123', title: 'Fix it', phase } });
      expect(r.done, phase).toBe(true);
    }
    for (const phase of ['TODO', 'IN_PROGRESS']) {
      expect(evaluateWaitResult('t-abc123', { task: { phase } }).done, phase).toBe(false);
    }
  });

  it('task ids accept a flat body and fall back to the requested id', () => {
    const flat = evaluateWaitResult('t-abc123', { phase: 'COMPLETE', title: 'Flat' });
    expect(flat.done).toBe(true);
    expect(flat.summary).toEqual({ task: 't-abc123', title: 'Flat', phase: 'COMPLETE' });

    const empty = evaluateWaitResult('t-abc123', {});
    expect(empty.done).toBe(false);
    expect(empty.summary).toEqual({ task: 't-abc123', title: undefined, phase: 'unknown' });
  });
});

describe('errorToExitCode', () => {
  it('maps the full error table', () => {
    expect(errorToExitCode('unknown_peer')).toBe(3);
    expect(errorToExitCode('ambiguous_peer')).toBe(3);
    expect(errorToExitCode('self_send')).toBe(3);
    expect(errorToExitCode('throttled')).toBe(4);
    expect(errorToExitCode('queue_full')).toBe(4);
    expect(errorToExitCode('hub_unreachable')).toBe(5);
    expect(errorToExitCode('hub_timeout')).toBe(5);
    expect(errorToExitCode('unknown_caller')).toBe(6);
    // catch-all bucket → 1
    expect(errorToExitCode('internal')).toBe(1);
    expect(errorToExitCode('unsupported_replica')).toBe(1);
    expect(errorToExitCode('target_archived')).toBe(1);
    expect(errorToExitCode('target_awaiting_permission')).toBe(1);
    expect(errorToExitCode('bad_request')).toBe(1);
    expect(errorToExitCode('unsupported_version')).toBe(1);
    expect(errorToExitCode('never-heard-of-it')).toBe(1);
  });
});

describe('formatErrorLines', () => {
  it('renders walnut: <code>: <message>', () => {
    const lines = formatErrorLines({ code: 'unknown_peer', message: 'no such peer' });
    expect(lines).toEqual(['walnut: unknown_peer: no such peer']);
  });

  it('appends a candidates table for ambiguous_peer', () => {
    const lines = formatErrorLines({
      code: 'ambiguous_peer',
      message: 'multiple peers match',
      detail: {
        candidates: [
          { id: '1', shortId: 'aaaa1111', title: 'Session one', host: 'local' },
          { id: '2', shortId: 'bbbb2222', title: 'Session two', host: 'devbox' },
        ],
      },
    });
    expect(lines[0]).toBe('walnut: ambiguous_peer: multiple peers match');
    expect(lines[1]).toBe('candidates:');
    expect(lines[2]).toContain('aaaa1111');
    expect(lines[3]).toContain('devbox');
  });

  it('appends retry guidance on throttled', () => {
    const lines = formatErrorLines({
      code: 'throttled',
      message: 'peer send throttled',
      retryAfterMs: 41000,
    });
    expect(lines[1]).toContain('retry after 41s');
    expect(lines[1]).toContain('do not retry in a loop');
  });
});

describe('formatToolsTable', () => {
  it('marks read/write and local-only ops, and handles an empty catalog', () => {
    const out = formatToolsTable([
      { name: 'task_list', title: 'List tasks', readonly: true, remote: 'allow' },
      { name: 'session_send', title: 'Send a message to a session', readonly: false, remote: 'allow' },
      { name: 'task_delete', title: 'Delete a task', readonly: false, remote: 'deny' },
    ]);
    expect(out).toContain('task_list');
    expect(out).toContain('(read)');
    expect(out).toContain('session_send');
    expect(out).toContain('(write)');
    expect(out).toContain('write, local-only');
    expect(formatToolsTable([])).toBe('(no operations)');
  });

  it('shows the argument signature the hub sends (the whole point of the catalog)', () => {
    const out = formatToolsTable([
      { name: 'note_read', title: 'Read a note', readonly: true, signature: 'path?, id?' },
    ]);
    expect(out).toContain('args: path?, id?');
  });
});

describe('helpText', () => {
  it('root help embeds the three verbs, wait, exit codes, and safety semantics', () => {
    const h = helpText('root');
    expect(h).toContain('walnut guide');
    expect(h).toContain('walnut tools list|help|call ...');
    expect(h).toContain('walnut wait <id> [--timeout secs] [--json]');
    // The retired peers commands must not come back into the advertised surface.
    expect(h).not.toContain('walnut peers list');
    expect(h).not.toContain('walnut peers send');
    expect(h).toContain('does NOT carry user authorization');
    // Exit 6 is "nothing to talk to on this host": with no env, walnut falls
    // back to the host daemon's well-known socket.
    expect(h).toContain('6  no reachable Walnut daemon socket on this host');
    expect(h).toContain('7  wait timed out');
    expect(h).toContain('WALNUT_AGENT_SOCKET');
    expect(h).toContain('falls back to this host');
  });

  it('tools help has examples and the big-payload warning', () => {
    const h = helpText('tools');
    expect(h).toContain("walnut tools call task_list '{\"status\":\"todo\"}'");
    expect(h).toContain('walnut tools call <op> @<file>');
    expect(h).toContain('MAX_ARG_STRLEN');
  });
});
