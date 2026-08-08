/**
 * Unit test: wn CLI pure surface (plan §8) — argv parsing, error-code →
 * exit-code mapping, --json vs table formatting. No socket involved.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWnArgs,
  errorToExitCode,
  formatPeersTable,
  formatErrorLines,
  helpText,
  type PeerRow,
} from '../../../src/providers/wn-cli.js';

describe('parseWnArgs', () => {
  it('parses peers list', () => {
    expect(parseWnArgs(['peers', 'list'])).toEqual({ kind: 'peers.list', json: false });
  });

  it('parses peers list --json', () => {
    expect(parseWnArgs(['peers', 'list', '--json'])).toEqual({ kind: 'peers.list', json: true });
  });

  it('parses peers send with multi-word text', () => {
    expect(parseWnArgs(['peers', 'send', '9f3a', 'build', 'is', 'ready'])).toEqual({
      kind: 'peers.send',
      target: '9f3a',
      text: 'build is ready',
      json: false,
    });
  });

  it('parses peers send with a quoted title target', () => {
    expect(parseWnArgs(['peers', 'send', 'flaky auth test', 'root cause found'])).toEqual({
      kind: 'peers.send',
      target: 'flaky auth test',
      text: 'root cause found',
      json: false,
    });
  });

  it('accepts --json before the target on send', () => {
    expect(parseWnArgs(['peers', 'send', '--json', '9f3a', 'hi'])).toEqual({
      kind: 'peers.send',
      target: '9f3a',
      text: 'hi',
      json: true,
    });
  });

  it('does not eat "--json" appearing inside the message text', () => {
    const res = parseWnArgs(['peers', 'send', '9f3a', 'use', '--json', 'for', 'output']);
    expect(res).toEqual({
      kind: 'peers.send',
      target: '9f3a',
      text: 'use --json for output',
      json: false,
    });
  });

  it('maps --help / -h / help to help', () => {
    expect(parseWnArgs(['--help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWnArgs(['-h'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWnArgs(['help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseWnArgs(['peers', '--help'])).toEqual({ kind: 'help', topic: 'peers' });
  });

  it('rejects missing command / unknown command / unknown subcommand', () => {
    expect(parseWnArgs([]).kind).toBe('usage-error');
    expect(parseWnArgs(['tasks']).kind).toBe('usage-error');
    expect(parseWnArgs(['peers']).kind).toBe('usage-error');
    expect(parseWnArgs(['peers', 'kill']).kind).toBe('usage-error');
  });

  it('rejects send without target or without text', () => {
    expect(parseWnArgs(['peers', 'send']).kind).toBe('usage-error');
    expect(parseWnArgs(['peers', 'send', '9f3a']).kind).toBe('usage-error');
    expect(parseWnArgs(['peers', 'send', '9f3a', '   ']).kind).toBe('usage-error');
  });

  it('rejects unknown flags on list and send', () => {
    expect(parseWnArgs(['peers', 'list', '--verbose']).kind).toBe('usage-error');
    expect(parseWnArgs(['peers', 'send', '--verbose', '9f3a', 'hi']).kind).toBe('usage-error');
  });
});

describe('errorToExitCode', () => {
  it('maps the full plan §4 table', () => {
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

const peers: PeerRow[] = [
  {
    id: 'f00dcafe-1111-2222-3333-444455556666',
    shortId: 'f00dcafe',
    title: 'Fix flaky auth test',
    host: 'local',
    status: 'running',
    taskSummary: 'Stabilize CI auth suite',
    self: false,
  },
  {
    id: 'a1b2c3d4-5555-6666-7777-888899990000',
    shortId: 'a1b2c3d4',
    title: null,
    host: null,
    status: 'idle',
    taskSummary: null,
    self: true,
  },
];

describe('formatPeersTable', () => {
  it('renders header + one row per peer, self marked with *', () => {
    const out = formatPeersTable(peers);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/SHORT-ID\s+TITLE\s+HOST\s+STATUS\s+TASK/);
    expect(lines[1]).toContain('f00dcafe');
    expect(lines[1]).toContain('Fix flaky auth test');
    expect(lines[1].startsWith(' ')).toBe(true); // not self
    expect(lines[2].startsWith('*')).toBe(true); // self
  });

  it('fills nullable fields with placeholders', () => {
    const out = formatPeersTable(peers);
    expect(out).toContain('(untitled)');
    expect(out).toContain('local'); // null host → local
    expect(out).toMatch(/\s-(\s|$)/); // null taskSummary → -
  });

  it('clips long titles', () => {
    const long = formatPeersTable([{ ...peers[0], title: 'x'.repeat(100) }]);
    expect(long).toContain('x'.repeat(39) + '…');
    expect(long).not.toContain('x'.repeat(41));
  });

  it('handles an empty list', () => {
    expect(formatPeersTable([])).toBe('(no peer sessions)');
  });
});

describe('formatErrorLines', () => {
  it('renders wn: <code>: <message>', () => {
    const lines = formatErrorLines({ code: 'unknown_peer', message: 'no such peer' });
    expect(lines).toEqual(['wn: unknown_peer: no such peer']);
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
    expect(lines[0]).toBe('wn: ambiguous_peer: multiple peers match');
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

describe('helpText', () => {
  it('root help embeds usage, exit codes, and safety semantics', () => {
    const h = helpText('root');
    expect(h).toContain('wn peers list [--json]');
    expect(h).toContain('wn peers send <target> <text...>');
    expect(h).toContain('does NOT carry user authorization');
    expect(h).toContain('6  not running inside a Walnut-managed session');
    expect(h).toContain('WALNUT_AGENT_SOCKET');
  });

  it('peers help has examples', () => {
    const h = helpText('peers');
    expect(h).toContain('wn peers send 9f3a');
  });
});
