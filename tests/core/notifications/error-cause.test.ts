/**
 * causeKeyForError — the ROOT-CAUSE identity behind an error notification.
 *
 * `recoveryKey` names the CONDITION a card is about (`task:…`, `route:…`,
 * `session:…`), but one host outage fans out into many conditions, each waiting
 * for its own success signal that may never re-fire. `causeKey` is the second
 * identity that cuts across them, so ONE daemon reconnect retires the whole wall.
 *
 * The load-bearing rule here is that BOTH gates must pass: a connectivity
 * signature in the text AND a resolvable non-local host. A confident wrong
 * grouping would stamp 'recovered' on a card whose cause was something else
 * entirely, so everything ambiguous must stay keyless.
 *
 * Pure functions — no store, no temp dir, no clock.
 */
import { describe, it, expect } from 'vitest';
import {
  hostCauseKey, hostOfCauseKey, causeKeyForError,
} from '../../../src/core/notifications/error-cause.js';

describe('causeKeyForError — host connectivity signatures', () => {
  it('reads the host out of a deploy failure (source and binary), stopping at the colon', () => {
    // daemon-connection.ts deploySource/deployBinary wording. The trailing colon
    // delimits the host from the nested command error — capturing it would make
    // 'host:devbox:' and never match the recovery signal's 'host:devbox'.
    expect(causeKeyForError({
      text: 'Failed to deploy daemon source to devbox: Command failed: ssh -o BatchMode=yes devbox true',
    })).toBe('host:devbox');
    expect(causeKeyForError({
      text: 'Failed to deploy daemon binary to devbox: chunk 3/7 refused',
    })).toBe('host:devbox');
  });

  it('reads the host out of the failure-cache retry shape', () => {
    expect(causeKeyForError({
      text: 'Connection to devbox failed 12s ago: kex_exchange_identification',
    })).toBe('host:devbox');
  });

  it('reads the host out of a send() on a dead pool entry', () => {
    expect(causeKeyForError({ text: 'DaemonConnection not connected to devbox' }))
      .toBe('host:devbox');
  });

  it('does NOT capture prose after a bare "not connected to"', () => {
    // Only the full producer wording names a host; the bare phrase in prose
    // would otherwise mint a junk `host:the` group nothing can ever recover.
    expect(causeKeyForError({ text: 'send failed: not connected to the daemon' }))
      .toBeUndefined();
  });

  it('prefers the STRUCTURED host hint over whatever the text names', () => {
    // The hint comes from log meta / the session record, which is the layer that
    // actually knows which connection failed; the text may quote an older cached
    // failure for a different box.
    expect(causeKeyForError({
      text: 'Connection to otherbox failed 3s ago: connection refused',
      host: 'devbox',
    })).toBe('host:devbox');
  });

  it('a timeout signature needs the hint — its text names no host', () => {
    const text = 'daemon command timeout: start (10000ms)';
    expect(causeKeyForError({ text, host: 'devbox' })).toBe('host:devbox');
    // Same signature, no hint: nothing identifies WHICH host, so grouping it
    // would fold unrelated outages into one card.
    expect(causeKeyForError({ text })).toBeUndefined();
  });

  it('a connectivity signature with NO resolvable host stays keyless', () => {
    // A plugin's socket error against some external API matches the errno
    // signature but names no host of ours.
    expect(causeKeyForError({ text: 'read ECONNRESET' })).toBeUndefined();
    expect(causeKeyForError({ text: 'write EPIPE' })).toBeUndefined();
  });

  it('a host with NO connectivity signature stays keyless', () => {
    // A missing-cwd spawn failure carries a host, but a daemon reconnect proves
    // nothing about it — the folder is still gone.
    expect(causeKeyForError({
      text: 'The working folder no longer exists: /a/b',
      host: 'devbox',
    })).toBeUndefined();
  });

  it('never keys the LOCAL transport, whatever the hint spells it', () => {
    // The local transport has no SSH link, and `host:__local__` would "recover"
    // on every boot's daemon warm-up, stamping cards whose cause was elsewhere.
    for (const host of ['local', '__local__', 'localhost']) {
      expect(causeKeyForError({ text: 'read ECONNRESET', host })).toBeUndefined();
    }
    // Blank / whitespace hints are not hosts either.
    expect(causeKeyForError({ text: 'write EPIPE', host: '   ' })).toBeUndefined();
  });

  it('does not key a text that only names a local-ish host', () => {
    expect(causeKeyForError({ text: 'Connection to localhost failed 2s ago: ECONNREFUSED' }))
      .toBeUndefined();
  });

  it('accepts dotted and hyphenated aliases as one token', () => {
    expect(causeKeyForError({ text: 'DaemonConnection not connected to build-host.internal' }))
      .toBe('host:build-host.internal');
  });
});

describe('hostCauseKey / hostOfCauseKey', () => {
  it('round-trips a host alias', () => {
    for (const host of ['devbox', 'buildhost', 'marina', 'build-host.internal']) {
      expect(hostOfCauseKey(hostCauseKey(host))).toBe(host);
    }
    expect(hostCauseKey('devbox')).toBe('host:devbox');
  });

  it('returns null for any non-host shape', () => {
    // The reader is used to decide whether a recovery signal is a host one, so a
    // condition key must never look like a host.
    expect(hostOfCauseKey('task:t1')).toBeNull();
    expect(hostOfCauseKey('route:GET /api/x')).toBeNull();
    expect(hostOfCauseKey('session:s1')).toBeNull();
    expect(hostOfCauseKey('')).toBeNull();
    // `host:` with nothing after it is a malformed key, not a host named ''.
    expect(hostOfCauseKey('host:')).toBeNull();
  });
});
