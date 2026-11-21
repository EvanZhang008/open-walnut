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

  it('groups the start-failure wordings the live feed held ungrouped (2026-09-29)', () => {
    // The WebSocket connect path says "timeout", the socket layer "timed out";
    // seven transport-start cards for one frozen daemon shared no group.
    expect(causeKeyForError({ text: 'transport start failed\nWebSocket connection timeout.', host: 'clouddev' }))
      .toBe('host:clouddev');
    // The remote daemon-dir probe names the host in its own sentence.
    expect(causeKeyForError({
      text: 'daemon dir check on clouddev did not finish ( [0m [0m); Walnut will not guess where the daemon lives, and retries the connect',
    })).toBe('host:clouddev');
    expect(causeKeyForError({ text: 'daemon dir check on devbox-2 answered without its result lines' }))
      .toBe('host:devbox-2');
    // A DNS failure out of the ssh ProxyCommand, with the host from the hint.
    expect(causeKeyForError({ text: 'getaddrinfo ENOTFOUND proxy.example.invalid', host: 'clouddev' }))
      .toBe('host:clouddev');
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

/**
 * Every sentence the host network's dial explainer can say about a host is a
 * link-down cause naming that host. Driven through every answer the link gives
 * (offline, online, unknown), so a new sentence there that this file does not
 * know fails here (2026-11-21: "Host network: clouddev is reachable, but the
 * Walnut daemon there did not answer" became its own start-failure card).
 */
describe('the host network dial sentences are host outages', () => {
  it('each answer of the link names the host as the cause', async () => {
    const { explainNetDialFailure } = await import('../../../src/core/hosts/net-link.js');
    const { namesLinkDown } = await import('../../../src/core/notifications/error-cause.js');
    const raw = new Error('WebSocket connection failed: ECONNRESET (host=devbox-2, url=ws://127.0.0.1:59116)');
    for (const up of [true, false, null]) {
      const err = await explainNetDialFailure(raw, 'devbox-2', 'devbox-2', async () => up);
      // Unknown (null) hands back the socket's own words, which name no host: the
      // log line's host hint carries it then, as the start-failure log gives it.
      const input = up === null ? { text: err.message, host: 'devbox-2' } : { text: err.message };
      expect(causeKeyForError(input), `${up}: ${err.message}`).toBe('host:devbox-2');
      if (up !== null) expect(namesLinkDown(err.message), `${up}: ${err.message}`).toBe(true);
    }
  });

  it('every sentence net-link.ts throws about a host is a host outage, or listed here with why not', async () => {
    // Read from the source, so a new sentence there fails here until it is decided.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { namesLinkDown } = await import('../../../src/core/notifications/error-cause.js');
    const src = fs.readFileSync(path.resolve('src/core/hosts/net-link.ts'), 'utf8');
    const sentences = [...src.matchAll(/new Error\(`([^`]+)`\)/g)].map((m) => m[1]!);
    expect(sentences.length).toBeGreaterThanOrEqual(4);
    // This machine's own daemon needs a restart: not the host's outage.
    const notAnOutage = [/has no host network yet/];
    for (const tpl of sentences) {
      const text = tpl.replace(/\$\{host\}/g, 'devbox-2').replace(/\$\{[^}]+\}/g, 'x');
      if (notAnOutage.some((re) => re.test(text))) continue;
      expect(causeKeyForError({ text }), text).toBe('host:devbox-2');
      expect(namesLinkDown(text), text).toBe(true);
    }
  });

  it('the cause survives the sentence being quoted inside another', () => {
    expect(causeKeyForError({
      text: 'Could not reach clouddev: walnut: Walnut cannot reach New big clouddev right now (Host network: devbox is reachable, but the Walnut daemon there did not answer (is Walnut running there?))',
    })).toBe('host:devbox');
  });
});
