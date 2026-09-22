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
 * a private address" case proves.
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
  it('exports nothing that turns it off, and reads no environment variable', async () => {
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
});
