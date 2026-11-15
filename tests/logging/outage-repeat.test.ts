/**
 * One host outage is told once per kind of line (src/logging/outage-repeat.ts).
 *
 * 2026-11-14: an expired SSH proxy login on one host made 27 sessions log the
 * pool's cached failure again on every start, 280 "session: transport start
 * failed" errors in four hours, and the log-spike alarm rang. The guard runs
 * through the real logger with the health monitor's tap and the notification
 * sink installed, so ANY line (this one, or a new kind added later) that only
 * repeats a host's link-down reaches them once per window, not once per session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../src/logging/logger.js', () => ({ writeLogEntry: vi.fn() }));

import { createSubsystemLogger, setLogLevelTap, setErrorNotificationSink } from '../../src/logging/subsystem.js';
import { writeLogEntry } from '../../src/logging/logger.js';
import { OUTAGE_REPEAT_WINDOW_MS, releaseOutageRepeats, resetOutageRepeatsForTests } from '../../src/logging/outage-repeat.js';

const written = vi.mocked(writeLogEntry);
const tapped: Array<{ level: string; subsystem: string; message: string }> = [];
const sunk: Array<{ subsystem: string; message: string }> = [];

// The incident's own line, word for word (host alias neutral).
const CACHED = 'Connection to devbox failed 0s ago: Error: proxy client returned an error … [walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]';

let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetOutageRepeatsForTests();
  written.mockClear();
  tapped.length = 0;
  sunk.length = 0;
  setLogLevelTap((level, subsystem, message) => { tapped.push({ level, subsystem, message }); });
  setErrorNotificationSink((p) => { sunk.push({ subsystem: p.subsystem, message: p.message }); });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  setLogLevelTap(null);
  setErrorNotificationSink(null);
  stderrSpy.mockRestore();
  vi.useRealTimers();
});

function startFailed(taskId: string, host = 'devbox', error = CACHED): void {
  createSubsystemLogger('session').error('transport start failed', { taskId, host, cwd: '/w', isRemote: true, error });
}

describe('a host outage repeated by many sessions', () => {
  it('reaches the health tap and the notification sink once, the rest are written at info saying why', () => {
    for (let i = 0; i < 27; i++) startFailed(`task-${i}`);
    expect(tapped).toEqual([{ level: 'error', subsystem: 'session', message: 'transport start failed' }]);
    expect(sunk).toHaveLength(1);
    // Every line is still in the log, for forensics: the first as error, the repeats at info.
    expect(written).toHaveBeenCalledTimes(27);
    const levels = written.mock.calls.map((c) => c[0].level);
    expect(levels[0]).toBe('error');
    expect(levels.slice(1).every((l) => l === 'info')).toBe(true);
    expect(written.mock.calls[0][0].outageRepeat).toBeUndefined();
    expect(written.mock.calls[1][0].outageRepeat).toBe('host:devbox');
    expect(written.mock.calls[1][0].taskId).toBe('task-1');
  });

  it('holds for any kind of line and level, each kind told once (a new kind is covered by construction)', () => {
    const lines: Array<[string, 'warn' | 'error', string]> = [
      ['session', 'warn', 'resume spawn failed — reverting batch to pending'],
      ['session', 'warn', 'transport attach failed, session may not stream'],
      ['web', 'warn', 'some route a later change adds'],
      ['obs', 'error', 'a session line a later change adds'],
    ];
    for (let round = 0; round < 5; round++) {
      for (const [sub, level, msg] of lines) createSubsystemLogger(sub)[level](msg, { host: 'devbox', sessionId: `s${round}`, error: CACHED });
    }
    expect(tapped.map((t) => t.message)).toEqual(lines.map((l) => l[2]));
  });

  it('tells each host and each kind of line on its own', () => {
    startFailed('a', 'devbox', CACHED);
    startFailed('b', 'otherbox', CACHED.replace('devbox', 'otherbox'));
    createSubsystemLogger('session').error('another kind', { host: 'devbox', taskId: 'c', error: CACHED });
    expect(tapped).toHaveLength(3);
  });

  it('a quiet warn told first never quiets the error that raises the host card', () => {
    createSubsystemLogger('session').warn('transport start failed', { taskId: 'a', host: 'devbox', error: CACHED });
    startFailed('b');
    startFailed('c');
    expect(tapped.map((t) => t.level)).toEqual(['warn', 'error']);
    expect(sunk).toHaveLength(1);
  });

  it('tells it again once the host recovered (a new outage), and only for that host', () => {
    startFailed('a');
    startFailed('b', 'otherbox', CACHED.replace('devbox', 'otherbox'));
    releaseOutageRepeats(['host:devbox']);
    startFailed('c');
    startFailed('d', 'otherbox', CACHED.replace('devbox', 'otherbox'));
    expect(tapped).toHaveLength(3);
  });

  it('tells it again once the window has passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T15:00:00Z'));
    startFailed('a');
    startFailed('b');
    vi.setSystemTime(new Date(Date.now() + OUTAGE_REPEAT_WINDOW_MS + 1));
    startFailed('c');
    expect(tapped).toHaveLength(2);
  });
});

describe('a host link dialled again for the same failure (linkFailure)', () => {
  // The 2026-11-14 line, word for word but for the host: an expired SSH certificate,
  // dialled again every minute as the pool's 60s failure cache ran out.
  const RAW = 'Command failed: ssh dev@devbox.example sh -s\ndev@devbox.example: Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-11-14 22:30)';
  const SUMMARY = 'dev@devbox.example: Permission denied (publickey). [walnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-11-14 22:30)]';
  const MSG = 'DaemonConnection: connect failed (full error logged once, summary cached)';
  const dial = (host = 'devbox', linkFailure = SUMMARY) =>
    createSubsystemLogger('session').warn(MSG, { host, error: RAW, linkFailure });

  it('is warned once per outage, the repeats written at info saying why (50 an hour before)', () => {
    for (let i = 0; i < 50; i++) dial();
    expect(tapped).toEqual([{ level: 'warn', subsystem: 'session', message: MSG }]);
    expect(written).toHaveBeenCalledTimes(50);
    expect(written.mock.calls[0][0].level).toBe('warn');
    expect(written.mock.calls.slice(1).every((c) => c[0].level === 'info' && c[0].outageRepeat === 'host:devbox')).toBe(true);
  });

  it('a new cause is told at once; digits alone (a port, a timeout) are not a new cause', () => {
    dial('devbox', 'timed out after 15000ms');
    dial('devbox', 'timed out after 15001ms');
    dial('devbox', 'Connection closed by UNKNOWN port 65535');
    dial();
    expect(tapped).toHaveLength(3);
  });

  it('each host on its own, told again after the host recovered or the window passed, never for the local host', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T15:00:00Z'));
    dial(); dial('otherbox'); dial(); dial('otherbox');
    expect(tapped).toHaveLength(2);
    releaseOutageRepeats(['host:devbox']);
    dial(); dial('otherbox');
    expect(tapped).toHaveLength(3);
    vi.setSystemTime(new Date(Date.now() + OUTAGE_REPEAT_WINDOW_MS + 1));
    dial('otherbox');
    expect(tapped).toHaveLength(4);
    for (let i = 0; i < 3; i++) dial('__local__');
    expect(tapped).toHaveLength(7);
  });
});

/**
 * The class: a warn about a host's link that would not come up, written on every dial.
 * Each such line in src/ names its failure in `linkFailure`, or the logger cannot fold
 * it and one standing outage (an expired login, a machine offline) rings the log-spike
 * alarm again. A new member (a new "... connect failed" / "dial failed" warn) fails here
 * until it carries the field, or is listed below with why it is not about a host link.
 */
describe('every dial-failure warn names its failure for the fold', () => {
  const NOT_A_HOST_LINK = new Set([
    'backup: google drive connect failed', // a cloud drive's API, no host link
  ]);
  const DIAL_FAILED = /\b(?:connect|reconnect|ControlMaster|dial) failed\b/;

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  /** The argument text of the call whose `(` is at `open`, to its matching `)` (strings skipped). */
  function callArgs(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  }

  it('finds the known members, and each carries linkFailure', () => {
    const root = path.resolve(__dirname, '../..');
    const found: string[] = [];
    const missing: string[] = [];
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      const call = /\.(?:warn|error)\(/g;
      for (let m = call.exec(text); m; m = call.exec(text)) {
        const args = callArgs(text, m.index + m[0].length - 1);
        // The message: every string literal before the meta object (a ternary picks one of two).
        const head = args.split('{')[0];
        const messages = [...head.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((x) => x[2]).filter((x) => DIAL_FAILED.test(x) && !NOT_A_HOST_LINK.has(x));
        if (messages.length === 0) continue;
        const where = `${path.relative(root, file)}: ${messages.join(' | ')}`;
        found.push(where);
        if (!/\blinkFailure\b/.test(args)) missing.push(where);
      }
    }
    expect(missing).toEqual([]);
    // The scan itself still sees the members this guard was written for.
    for (const known of ['connect failed (full error logged once', 'ControlMaster failed', 'reconnect failed, will retry', 'host warmup: connect failed', 'stream lane: dial failed']) {
      expect(found.some((f) => f.includes(known))).toBe(true);
    }
  });
});

describe('lines that are not a host outage keep their level', () => {
  it('a repeated error that names no link failure', () => {
    for (let i = 0; i < 3; i++) createSubsystemLogger('session').error('transport start failed', { taskId: `t${i}`, host: 'devbox', error: 'folder is gone' });
    expect(tapped).toHaveLength(3);
    expect(sunk).toHaveLength(3);
  });

  it('a link failure on the local host', () => {
    for (let i = 0; i < 3; i++) createSubsystemLogger('session').error('transport start failed', { host: 'local', taskId: 'L', error: 'WebSocket connection failed: ECONNREFUSED (host=__local__)' });
    expect(tapped).toHaveLength(3);
  });

  it('an error the bridge keeps as its own card (not the host card) is never folded', () => {
    for (let i = 0; i < 3; i++) {
      createSubsystemLogger('web').error('GET /api/x → 500', { host: 'devbox', error: CACHED });
      createSubsystemLogger('plugin/sync').error('push failed', { pluginId: 'sync', taskId: `t${i}`, error: CACHED });
      createSubsystemLogger('session').error('route-keyed', { recoveryKey: 'route:GET /x', taskId: `t${i}`, error: CACHED });
      createSubsystemLogger('session').error('no ids', { host: 'devbox', error: CACHED });
    }
    expect(sunk).toHaveLength(12);
  });

  it('fatal is never folded', () => {
    for (let i = 0; i < 3; i++) createSubsystemLogger('session').fatal('transport start failed', { host: 'devbox', taskId: 't', error: CACHED });
    expect(tapped).toHaveLength(3);
  });
});

describe('every test starts with no outage told', () => {
  it('every vitest config that loads byte-equality.ts loads outage-repeat-reset.ts too', () => {
    const root = path.resolve(__dirname, '../..');
    const configs = fs.readdirSync(root).filter((name) => /^vitest(\..+)?\.config\.ts$/.test(name));
    expect(configs).toContain('vitest.config.ts');
    const missing = configs.filter((name) => {
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      return text.includes('tests/setup/byte-equality.ts') && !text.includes('tests/setup/outage-repeat-reset.ts');
    });
    expect(missing).toEqual([]);
  });
});
