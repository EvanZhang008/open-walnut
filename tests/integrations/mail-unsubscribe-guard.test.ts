/**
 * The SSRF guard in front of every unsubscribe request.
 *
 * The property this file exists to defend is not "the guard returns the right word". It is that a
 * refused url costs ZERO SOCKETS: every case below asserts the injected transport was never called,
 * because a guard that answers `blocked-host` after connecting has already done the damage.
 *
 * The second property is the one naive implementations get wrong: the guard re-runs on every
 * redirect. A public url that 302s to `http://`, to `192.168.x.x`, or to a name that resolves into
 * the user's own network must fail AT THAT HOP, and the hop count is capped so a redirect loop cannot
 * hold the ladder.
 *
 * Both the socket and the resolver are injected here, and neither is a way past the guard: whatever
 * the resolver answers is still run through the blocklist, which is what the "evil name resolving to
 * a private address" case proves. They are injected AS A PAIR, which is the third property: a test
 * that could replace only the resolver would be scoring one answer while the real `fetch` resolved the
 * name itself and connected somewhere else.
 *
 * Every address below is fed through `new URL(...).hostname` first, i.e. through the serializer a real
 * url goes through, because writing a form by hand is what hid a wide-open NAT64 range: the guard's
 * pattern required `64:ff9b::169.254.169.254`, the only form the test used, while everything real
 * produces `64:ff9b::a9fe:a9fe`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchUnsubscribe,
  guardUnsubscribeUrl,
  unsubscribeAddressBlocked,
  unsubscribeUserAgent,
  UNSUBSCRIBE_MAX_REDIRECTS,
  type UnsubscribeHttpSeam,
} from '../../src/integrations/mail/unsubscribe-http.js';

/** A resolver that answers with exactly what a test says, and a socket that records every call. */
function seamOf(options: {
  addresses?: Record<string, string[]>;
  respond?: (url: string, init: RequestInit) => Response;
  fail?: Error;
} = {}): { seam: Partial<UnsubscribeHttpSeam>; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const seam: Partial<UnsubscribeHttpSeam> = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.fail) throw options.fail;
      return options.respond?.(url, init) ?? new Response('ok', { status: 200 });
    },
    lookup: async (hostname) => {
      const addresses = options.addresses?.[hostname];
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  };
  return { seam, calls };
}

const PUBLIC = { 'lists.example.invalid': ['203.0.113.10'] };

/**
 * The address as the pipeline really hands it over: through the WHATWG serializer, which is what
 * `guardUnsubscribeUrl` reads out of `url.hostname`, and the same canonical form `dns.lookup` returns.
 */
function asProduced(literal: string): string {
  return new URL(`https://[${literal}]/`).hostname.replace(/^\[|\]$/g, '');
}

describe('addresses the server must never be pointed at', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.13.9.4', true],
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['172.16.0.9', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.5', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['198.18.0.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['203.0.113.10', false],
    ['8.8.8.8', false],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:192.168.0.1', true],
    ['::ffff:7f00:1', true],
    ['64:ff9b::10.0.0.1', true],
    ['2606:4700::1111', false],
    ['not-an-address', true],
  ])('%s is blocked: %s', (address, blocked) => {
    expect(unsubscribeAddressBlocked(address)).toBe(blocked);
  });
});

describe('an IPv6 address judged in the form a real url produces', () => {
  it.each([
    // NAT64. On an IPv6-only network (IPv6 Wi-Fi, cellular 464XLAT, an IPv6-only subnet) DNS64 answers
    // for an IPv4-only host with one of these and the gateway translates it back, so the embedded v4 IS
    // the destination. The pattern this replaces demanded a dotted tail nothing produces.
    ['64:ff9b::169.254.169.254', true],
    ['64:ff9b::10.0.0.1', true],
    ['64:ff9b::127.0.0.1', true],
    // …and it has to keep WORKING for a public one, which is the whole point of DNS64. A blanket
    // block of the prefix would silently break unsubscribing on every IPv6-only network.
    ['64:ff9b::203.0.113.10', false],
    // RFC 8215's local-use prefix. The embedded v4's offset depends on a prefix length the address
    // does not carry, so the range is refused rather than guessed at.
    ['64:ff9b:1::169.254.169.254', true],
    ['64:ff9b:1::203.0.113.10', true],
    // IPv4-compatible: what `https://[::127.0.0.1]/` turns into, which no pattern here used to match.
    ['::127.0.0.1', true],
    ['::ffff:169.254.169.254', true],
    // 6to4: the tunnel's destination is the embedded v4.
    ['2002:a00:1::1', true],
    ['2002:a9fe:a9fe::1', true],
    ['2002:cb00:710a::1', false],
    // Teredo: the relay in bytes 4-7, the client bit-flipped in the last four.
    ['2001:0:a00:1:8:6e5b:b0f5:f5ff', true],
    ['2001:0:5ef5:79fb:8:6e5b:f5ff:fffe', true],
    // Site-local, which a `fc|fd` pattern cannot see, and the discard prefix.
    ['fec0::1', true],
    ['feff::1', true],
    ['100::1', true],
    // Real public addresses stay public.
    ['2606:4700::1111', false],
    ['2001:4860:4860::8888', false],
  ])('%s is blocked: %s', (literal, blocked) => {
    const produced = asProduced(literal);
    expect(unsubscribeAddressBlocked(produced), `produced form ${produced}`).toBe(blocked);
    // And as written, so a hand-written form and a produced one can never disagree again.
    expect(unsubscribeAddressBlocked(literal), `written form ${literal}`).toBe(blocked);
  });

  it('is never handed the dotted tail the old NAT64 pattern required', () => {
    // The measurement that explains the hole: this is the form the test used, and this is the form
    // everything real produces instead.
    expect(asProduced('64:ff9b::169.254.169.254')).toBe('64:ff9b::a9fe:a9fe');
    expect(asProduced('::127.0.0.1')).toBe('::7f00:1');
  });

  it.each([
    ['0:0:0:0:0:ffff:7f00:1', '::ffff:127.0.0.1'],
    ['0064:ff9b:0000:0000:0000:0000:a9fe:a9fe', '64:ff9b::169.254.169.254'],
    ['::FFFF:127.0.0.1', '::ffff:127.0.0.1'],
    ['fe80::1%en0', 'fe80::1'],
    [' ::1 ', '::1'],
  ])('reads %s exactly as %s, so the predicate cannot be misused by its next caller', (written, canonical) => {
    // `unsubscribeAddressBlocked` is exported. It used to be correct only for compressed canonical
    // text, so an uncompressed answer would have been called public.
    expect(unsubscribeAddressBlocked(written)).toBe(unsubscribeAddressBlocked(canonical));
    expect(unsubscribeAddressBlocked(written)).toBe(true);
  });
});

describe('the guard refuses before any socket is opened', () => {
  it.each([
    ['http://lists.example.invalid/u/1', 'blocked-scheme'],
    ['mailto:leave@lists.example.invalid', 'blocked-scheme'],
    ['data:text/html,<p>gone</p>', 'blocked-scheme'],
    ['file:///etc/hosts', 'blocked-scheme'],
    ['ftp://lists.example.invalid/u', 'blocked-scheme'],
    ['https://localhost/u', 'blocked-host'],
    ['https://walnut.local/u', 'blocked-host'],
    ['https://box.internal/u', 'blocked-host'],
    ['https://thing.home.arpa/u', 'blocked-host'],
    // A trailing dot is the root, not a different host. `new URL` keeps it in `hostname`, so the
    // `$`-anchored name list missed every one of these until the host was normalised first.
    ['https://box.internal./u', 'blocked-host'],
    ['https://box.internal../u', 'blocked-host'],
    ['https://BOX.INTERNAL./u', 'blocked-host'],
    // Names a home router or a corporate DHCP hands out as the search domain.
    ['https://printer.lan/u', 'blocked-host'],
    ['https://wiki.corp/u', 'blocked-host'],
    ['https://portal.intranet/u', 'blocked-host'],
    ['https://[64:ff9b::169.254.169.254]/u', 'blocked-host'],
    ['https://[::127.0.0.1]/u', 'blocked-host'],
    ['https://[fec0::1]/u', 'blocked-host'],
    ['https://127.0.0.1/u', 'blocked-host'],
    ['https://10.1.2.3/u', 'blocked-host'],
    ['https://169.254.169.254/latest/meta-data/', 'blocked-host'],
    ['https://[::1]/u', 'blocked-host'],
    ['https://user:secret@lists.example.invalid/u', 'blocked-url'],
    ['https://lists.example.invalid:8443/u', 'blocked-url'],
    ['not a url at all', 'blocked-url'],
  ])('%s → %s, with no request', async (url, reason) => {
    const { seam, calls } = seamOf({ addresses: PUBLIC });
    const guarded = await guardUnsubscribeUrl(url, seam);
    expect(guarded.ok).toBe(false);
    expect(guarded.ok === false && guarded.reason).toBe(reason);

    // The whole point: the same url through the fetching path opens nothing either.
    const answered = await fetchUnsubscribe(url, { method: 'GET', deadlineAt: Date.now() + 5_000, seam });
    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.reason).toBe(reason);
    expect(calls, 'a refused url must not reach a socket').toHaveLength(0);
  });

  it('refuses a public NAME that resolves into the private network, still with no request', async () => {
    const { seam, calls } = seamOf({ addresses: { 'evil.example.invalid': ['192.168.1.5'] } });
    const answered = await fetchUnsubscribe('https://evil.example.invalid/u', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(answered.ok === false && answered.detail).toContain('192.168.1.5');
    expect(calls).toHaveLength(0);
  });

  it('refuses a name whose AAAA is a NAT64 translation of a private address', async () => {
    // The attack: `List-Unsubscribe: <https://leave.attacker.example/x>` plus the one-click companion,
    // and that host's AAAA points at 64:ff9b::a9fe:a9fe. On any network with NAT64/DNS64 the gateway
    // turns the request into one to 169.254.169.254.
    const { seam, calls } = seamOf({
      addresses: { 'leave.attacker.invalid': [asProduced('64:ff9b::169.254.169.254')] },
    });
    const answered = await fetchUnsubscribe('https://leave.attacker.invalid/x', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(answered.ok === false && answered.detail).toContain('64:ff9b::a9fe:a9fe');
    expect(calls).toHaveLength(0);
  });

  it('still fetches a name whose AAAA is a NAT64 translation of a PUBLIC address', async () => {
    // The other half of that rule, and the reason it cannot be a blanket block of the prefix: on an
    // IPv6-only network this is the ordinary answer for every IPv4-only newsletter host.
    const { seam, calls } = seamOf({
      addresses: { 'lists.example.invalid': [asProduced('64:ff9b::203.0.113.10')] },
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
  });

  it('refuses a name where only ONE of several answers is private', async () => {
    // The ordinary shape of this attack: the stack picks whichever address it prefers, so every
    // answer has to be clean, not just the first.
    const { seam, calls } = seamOf({
      addresses: { 'split.example.invalid': ['203.0.113.10', '10.0.0.7'] },
    });
    const guarded = await guardUnsubscribeUrl('https://split.example.invalid/u', seam);
    expect(guarded).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a name that resolves to nothing rather than assuming it is fine', async () => {
    const { seam } = seamOf({ addresses: { 'empty.example.invalid': [] } });
    const guarded = await guardUnsubscribeUrl('https://empty.example.invalid/u', seam);
    expect(guarded).toMatchObject({ ok: false, reason: 'blocked-host' });
  });

  it('reports a DNS failure as unreachable, which is a transport fault and not a refusal', async () => {
    const { seam, calls } = seamOf({ addresses: {} });
    const answered = await fetchUnsubscribe('https://gone.example.invalid/u', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(calls).toHaveLength(0);
  });

  it('allows an explicit :443 and a public literal address', async () => {
    const { seam } = seamOf({ addresses: PUBLIC });
    await expect(guardUnsubscribeUrl('https://lists.example.invalid:443/u', seam))
      .resolves.toMatchObject({ ok: true, host: 'lists.example.invalid' });
    await expect(guardUnsubscribeUrl('https://203.0.113.10/u', seam))
      .resolves.toMatchObject({ ok: true, addresses: ['203.0.113.10'] });
  });
});

describe('what the request itself carries', () => {
  it('sends the Walnut unsubscribe agent, no cookie, no authorization, no referer', async () => {
    const { seam, calls } = seamOf({ addresses: PUBLIC });
    await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      deadlineAt: Date.now() + 5_000,
      seam,
    });
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('List-Unsubscribe=One-Click');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['user-agent']).toBe(unsubscribeUserAgent());
    expect(headers['user-agent']).toMatch(/^Walnut\/.+ \(unsubscribe; one request per click\)$/);
    for (const name of Object.keys(headers)) {
      expect(name.toLowerCase()).not.toBe('cookie');
      expect(name.toLowerCase()).not.toBe('authorization');
      expect(name.toLowerCase()).not.toBe('referer');
    }
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.redirect).toBe('manual');
  });

  it('reads at most 256 KB of a five-megabyte page and stops the download', async () => {
    let cancelled = false;
    const { seam } = seamOf({
      addresses: PUBLIC,
      respond: () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // 64 KB at a time, forever, so only a reader that stops reading ever finishes.
            controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)));
          },
          cancel() { cancelled = true; },
        }),
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered.ok).toBe(true);
    expect(answered.ok && answered.body.length).toBe(256 * 1024);
    expect(cancelled, 'the rest of the download must be abandoned').toBe(true);
  });
});

describe('redirects are followed by hand, re-guarded at every hop', () => {
  function chain(hops: Record<string, string>, final = 'You have been unsubscribed.') {
    return seamOf({
      addresses: {
        'lists.example.invalid': ['203.0.113.10'],
        'a.example.invalid': ['203.0.113.11'],
        'b.example.invalid': ['203.0.113.12'],
        'c.example.invalid': ['203.0.113.13'],
        'd.example.invalid': ['203.0.113.14'],
        'inside.example.invalid': ['10.9.9.9'],
      },
      respond: (url) => {
        const next = hops[url];
        if (next) return new Response('', { status: 302, headers: { location: next } });
        return new Response(final, { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
  }

  it('follows three hops to a page', async () => {
    const { seam, calls } = chain({
      'https://lists.example.invalid/u/1': 'https://a.example.invalid/1',
      'https://a.example.invalid/1': 'https://b.example.invalid/2',
      'https://b.example.invalid/2': 'https://c.example.invalid/3',
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: true, status: 200, hops: 3, url: 'https://c.example.invalid/3' });
    expect(calls).toHaveLength(4);
  });

  it('gives up on the fourth', async () => {
    const { seam, calls } = chain({
      'https://lists.example.invalid/u/1': 'https://a.example.invalid/1',
      'https://a.example.invalid/1': 'https://b.example.invalid/2',
      'https://b.example.invalid/2': 'https://c.example.invalid/3',
      'https://c.example.invalid/3': 'https://d.example.invalid/4',
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'too-many-redirects' });
    expect(calls).toHaveLength(UNSUBSCRIBE_MAX_REDIRECTS + 1);
  });

  it.each([
    ['http://a.example.invalid/1', 'blocked-scheme'],
    ['https://inside.example.invalid/1', 'blocked-host'],
    ['https://192.168.4.4/1', 'blocked-host'],
    ['https://localhost/1', 'blocked-host'],
    ['https://a.example.invalid:9443/1', 'blocked-url'],
  ])('refuses a Location of %s at that hop', async (location, reason) => {
    const { seam, calls } = chain({ 'https://lists.example.invalid/u/1': location });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: false, reason });
    // The first hop was legitimate, so exactly one request happened and the second never did.
    expect(calls).toHaveLength(1);
  });

  it('resolves a relative Location against the hop it came from', async () => {
    const { seam, calls } = chain({ 'https://lists.example.invalid/u/1': '/done?token=abc' });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: true, url: 'https://lists.example.invalid/done?token=abc' });
    expect(calls.map((one) => one.url)).toEqual([
      'https://lists.example.invalid/u/1',
      'https://lists.example.invalid/done?token=abc',
    ]);
  });

  it('never repeats the one-click POST body at the redirect target', async () => {
    // RFC 8058 invited ONE post to the url the sender named. A 307 asking for it again somewhere else
    // is more than was invited, so the hop is a plain GET.
    const { seam, calls } = seamOf({
      addresses: { 'lists.example.invalid': ['203.0.113.10'], 'a.example.invalid': ['203.0.113.11'] },
      respond: (url) => (url.includes('lists.')
        ? new Response('', { status: 307, headers: { location: 'https://a.example.invalid/1' } })
        : new Response('You have been unsubscribed.', { status: 200 })),
    });
    await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'POST', body: 'List-Unsubscribe=One-Click', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[1]!.init.method).toBe('GET');
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('answers the redirect itself when it carries no Location to follow', async () => {
    const { seam } = seamOf({
      addresses: PUBLIC,
      respond: () => new Response('', { status: 302 }),
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: true, status: 302, body: '' });
  });
});

describe('the deadline is shared across every hop', () => {
  it('refuses to start a hop once the budget is gone', async () => {
    const clock = { at: 1_000 };
    const { seam, calls } = seamOf({
      addresses: { 'lists.example.invalid': ['203.0.113.10'], 'a.example.invalid': ['203.0.113.11'] },
      respond: (url) => {
        // The first hop alone uses more than the whole budget, so the second must not start.
        clock.at += 6_000;
        return url.includes('lists.')
          ? new Response('', { status: 302, headers: { location: 'https://a.example.invalid/1' } })
          : new Response('nothing to see', { status: 200 });
      },
    });
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: 6_000, seam, now: () => clock.at,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'timeout' });
    expect(calls).toHaveLength(1);
  });

  it('reports an aborted request as a timeout and a refused one as unreachable', async () => {
    const aborted = new Error('This operation was aborted');
    const slow = seamOf({
      addresses: PUBLIC,
      respond: () => new Response('never', { status: 200 }),
    });
    slow.seam.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(aborted));
    });
    const timedOut = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 40, seam: slow.seam,
    });
    expect(timedOut).toMatchObject({ ok: false, reason: 'timeout' });

    const dead = seamOf({ addresses: PUBLIC, fail: new Error('ECONNREFUSED') });
    // (the refused-socket half is asserted below)
    const refused = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam: dead.seam,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(refused.ok === false && refused.detail).toContain('ECONNREFUSED');
  });

  it('covers the BODY too: a page that answers its headers and then stalls still times out', async () => {
    // The easy version of this bug is to clear the abort timer as soon as the response object exists.
    // Then a 200 whose body never arrives leaves the read waiting forever, the ladder's promise never
    // settles, and the ledger row sits `in-flight` until something reclaims it an hour later.
    const stalling = seamOf({ addresses: PUBLIC });
    stalling.seam.fetch = async (_url, init) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // What a real transport does with the signal, so the fake is not kinder than undici.
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
    const answered = await fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 60, seam: stalling.seam,
    });
    expect(answered).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('the guard has no bypass', () => {
  /** A complete, legitimate test seam: a socket and the resolver whose answers it belongs to. */
  function pair() {
    return {
      fetch: vi.fn(async () => new Response('ok')),
      lookup: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]),
    };
  }

  it('exports nothing that turns it off, and reads no environment variable that weakens it', async () => {
    // A name grep is NOT the guarantee — `setUnsubscribeHttpForTesting` sails past this pattern, which
    // is exactly how a half-seam bypass lived here. The cases below are the guarantee.
    const module = await import('../../src/integrations/mail/unsubscribe-http.js');
    const names = Object.keys(module);
    expect(names.filter((name) => /allow|bypass|disable|insecure|unsafe/i.test(name))).toEqual([]);
    // The installed seam replaces the socket and the resolver. It cannot make a blocked address pass.
    module.setUnsubscribeHttpForTesting({
      fetch: vi.fn(async () => new Response('ok')),
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    try {
      const guarded = await module.guardUnsubscribeUrl('https://lies.example.invalid/u');
      expect(guarded).toMatchObject({ ok: false, reason: 'blocked-host' });
    } finally {
      module.setUnsubscribeHttpForTesting(null);
    }
  });

  it('refuses HALF a seam, which is the shape that really was a bypass', async () => {
    // What used to work: replace only `lookup`, leave `fetch` real. The guard then scored this fake
    // 203.0.113.10 while `globalThis.fetch` resolved the name itself and connected wherever it points.
    const module = await import('../../src/integrations/mail/unsubscribe-http.js');
    const lying = pair();
    expect(() => module.setUnsubscribeHttpForTesting({ lookup: lying.lookup }))
      .toThrow(/BOTH fetch and lookup/);
    expect(() => module.setUnsubscribeHttpForTesting({ fetch: lying.fetch }))
      .toThrow(/BOTH fetch and lookup/);
    // The per-call override is the same rule, and the same throw.
    await expect(module.guardUnsubscribeUrl('https://lists.example.invalid/u', { lookup: lying.lookup }))
      .rejects.toThrow(/BOTH fetch and lookup/);
    // A refused install leaves whatever was installed alone rather than half-replacing it.
    const whole = pair();
    module.setUnsubscribeHttpForTesting(whole);
    try {
      expect(() => module.setUnsubscribeHttpForTesting({ lookup: lying.lookup })).toThrow();
      expect(module.unsubscribeHttpSeam().lookup).toBe(whole.lookup);
      expect(module.unsubscribeHttpSeam().fetch).toBe(whole.fetch);
      expect(lying.lookup).not.toHaveBeenCalled();
    } finally {
      module.setUnsubscribeHttpForTesting(null);
    }
  });

  it('is the pair that answered the lookup which opens the socket, on every hop', async () => {
    // The property the pairing buys: one object does both, so there is no way to grade one resolver's
    // answer and then let a different one decide what is actually connected to.
    const module = await import('../../src/integrations/mail/unsubscribe-http.js');
    const asked: string[] = [];
    const opened: string[] = [];
    const seam = {
      lookup: async (hostname: string) => { asked.push(hostname); return [{ address: '203.0.113.10', family: 4 }]; },
      fetch: async (url: string) => {
        opened.push(url);
        return url.includes('/u/1')
          ? new Response('', { status: 302, headers: { location: 'https://second.example.invalid/done' } })
          : new Response('You have been unsubscribed.', { status: 200 });
      },
    };
    const answered = await module.fetchUnsubscribe('https://lists.example.invalid/u/1', {
      method: 'GET', deadlineAt: Date.now() + 5_000, seam,
    });
    expect(answered).toMatchObject({ ok: true, status: 200 });
    expect(asked).toEqual(['lists.example.invalid', 'second.example.invalid']);
    expect(opened).toEqual(['https://lists.example.invalid/u/1', 'https://second.example.invalid/done']);
  });

  it('refuses to install a seam at all when this is not a test runner', async () => {
    // Walnut loads plugins from ~/.open-walnut/plugins/ INTO the server process, so an ungated setter
    // is reachable by plugin code. Same three signals the rest of the repo reads for "am I a test".
    const module = await import('../../src/integrations/mail/unsubscribe-http.js');
    const held = {
      vitest: process.env.VITEST,
      worker: process.env.VITEST_WORKER_ID,
      nodeEnv: process.env.NODE_ENV,
    };
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.NODE_ENV;
    try {
      expect(() => module.setUnsubscribeHttpForTesting(pair())).toThrow(/outside a test runner/);
      // Un-installing is always allowed: it can only make the guard stricter.
      expect(() => module.setUnsubscribeHttpForTesting(null)).not.toThrow();
    } finally {
      if (held.vitest !== undefined) process.env.VITEST = held.vitest;
      if (held.worker !== undefined) process.env.VITEST_WORKER_ID = held.worker;
      if (held.nodeEnv !== undefined) process.env.NODE_ENV = held.nodeEnv;
      module.setUnsubscribeHttpForTesting(null);
    }
  });
});
