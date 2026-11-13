/**
 * A transcript read that fails because the host has no link now is not a warn
 * on every read (2026-11-13 health alarm "JSONL read via daemon failed": 2,500
 * to 4,000 warns a day, more than half of them a host whose SSH dial was refused
 * or cached as failed). The byte-ceiling half of that alarm is guarded by
 * tests/core/byte-ceiling-log-ratchet.test.ts.
 *
 * The guard covers the class by kind: every LinkFailureKind is listed below, so
 * a new kind fails here until someone decides whether it is host-level news.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFailureLogLevel } from '../../src/core/session-file-reader.js';
import { markLinkFailure, type LinkFailureKind } from '../../src/providers/link-failure.js';
import { assertDaemonDialsOpen, closeDaemonDials, reopenDaemonDials } from '../../src/providers/daemon-dial-gate.js';

afterEach(() => reopenDaemonDials());

describe('readFailureLogLevel', () => {
  // Every kind, with the level a failed read of that kind logs at.
  const expected: Record<LinkFailureKind, 'debug' | 'warn'> = {
    'no-link': 'debug', // never reached the host; the pool logged the dial
    lost: 'warn', // the link went away mid-read: may have run, a real failure
    'no-answer': 'warn', // the host did not answer in time
  };

  for (const [kind, level] of Object.entries(expected) as [LinkFailureKind, 'debug' | 'warn'][]) {
    it(`a ${kind} failure logs at ${level}`, () => {
      expect(readFailureLogLevel(markLinkFailure(new Error(`read failed (${kind})`), kind))).toBe(level);
    });
  }

  it('the pool tags exactly the kinds listed above', async () => {
    const src = await import('node:fs/promises').then(fs => fs.readFile(new URL('../../src/providers/link-failure.ts', import.meta.url), 'utf8'));
    const declared = src.match(/export type LinkFailureKind = ([^\n]+)/)![1].match(/'([^']+)'/g)!.map(s => s.slice(1, -1));
    expect(declared.sort()).toEqual(Object.keys(expected).sort());
  });

  it('this server shutting down is no-link, so debug', () => {
    closeDaemonDials();
    let gate: unknown;
    try { assertDaemonDialsOpen('h'); } catch (err) { gate = err; }
    expect(gate).toBeInstanceOf(Error);
    expect(readFailureLogLevel(gate)).toBe('debug');
  });

  it('an untagged error (a timeout, a daemon error) stays warn', () => {
    expect(readFailureLogLevel(new Error('Session file read timeout (no data for 120s)'))).toBe('warn');
    expect(readFailureLogLevel(new Error('fs.readRange transport failure: EIO'))).toBe('warn');
    expect(readFailureLogLevel('plain string')).toBe('warn');
  });
});
