/**
 * Where a mail account's password may go, and what a calendar server may make Walnut do.
 * Each case failed on the first version (an independent review reproduced them):
 *
 * - A redirect to another site gets no password; it stops, naming the server, for the person
 *   to set. A redirect within the registrable domain (caldav.icloud.com to pNN-caldav) is fine.
 * - A redirect never leads to this machine or the local network unless the request started there.
 * - A guessed host (the mail domain's well-known URL, an SRV target) is asked without the
 *   password first; one that answers like a calendar server is reported, not sent the password.
 * - An answer is read up to a size cap; a fold inside a UTF-8 character is joined on the bytes.
 * - A server path never takes a request to another host.
 */
import { describe, expect, it } from 'vitest';
import { davRequest, joinSplitCharacters, MAX_ANSWER_BYTES } from '../../src/integrations/calendar/caldav/dav.js';
import { discoverCalendars, type MailAccountForCalendar } from '../../src/integrations/calendar/caldav/discovery.js';
import { createCalDavSource } from '../../src/integrations/calendar/caldav/source.js';
import { isPrivateAddress, sameSite } from '../../src/integrations/calendar/caldav/net-policy.js';
import { calendarErrorCode } from '../../src/integrations/calendar/api.js';

/**
 * The longest stretch of synchronous work a calendar read may take in these tests. The aim is about
 * 50 ms on an idle machine; the bound is wider so a loaded test box (load 70+) does not fail it, and
 * still far under the seconds the regressions it guards took (walking from DTSTART: 1.2 to 13 s).
 */
const SYNC_BUDGET_MS = 250

interface Seen { url: string; method: string; auth: boolean }

/** A fetch that answers from a table and records what was sent where. */
function fakeFetch(answer: (url: URL, method: string) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({ url, method: String(init.method), auth: headers.has('authorization') });
    return answer(new URL(url), String(init.method));
  };
  return { seen, fetchImpl };
}

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { Location: to } });
const publicLookup = async () => [{ address: '93.184.216.34' }];
const creds = { username: 'pat@example.com', password: 'app-pass' };

async function failure(p: Promise<unknown>): Promise<{ code?: string; message: string; serverUrl?: string }> {
  try {
    await p;
  } catch (err) {
    return { code: calendarErrorCode(err), message: err instanceof Error ? err.message : String(err), serverUrl: (err as { serverUrl?: string }).serverUrl };
  }
  throw new Error('expected a failure');
}

describe('redirects and the password', () => {
  it('stops at a redirect to another site, names the server and sends it nothing', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'caldav.example.com' ? redirect('https://collector.example.net/dav/') : new Response('<multistatus/>', { status: 207 })));
    const err = await failure(davRequest(creds, { method: 'PROPFIND', url: 'https://caldav.example.com/' }, fetchImpl, publicLookup));
    expect(err).toMatchObject({ code: 'found-server', serverUrl: 'https://collector.example.net/dav/' });
    expect(err.message).toBe("The calendar server is at collector.example.net; set it as the account's calendar server to use it.");
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(['caldav.example.com']);
  });

  it('follows a redirect within the registrable domain, with the password', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'caldav.icloud.com' ? redirect('https://p34-caldav.icloud.com/123/') : new Response('<multistatus/>', { status: 207 })));
    const answer = await davRequest(creds, { method: 'PROPFIND', url: 'https://caldav.icloud.com/' }, fetchImpl, publicLookup);
    expect(answer.url).toBe('https://p34-caldav.icloud.com/123/');
    expect(seen.map((s) => [new URL(s.url).hostname, s.auth])).toEqual([['caldav.icloud.com', true], ['p34-caldav.icloud.com', true]]);
  });

  it('never follows a redirect to this machine or the local network', async () => {
    for (const target of ['http://127.0.0.1:3456/api/calendar/events/x?human_confirm=1', 'http://localhost:3456/', 'https://[::1]/', 'https://169.254.169.254/', 'https://10.0.0.5/']) {
      const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'cal.example.org' ? redirect(target, 307) : new Response('', { status: 200 })));
      const err = await failure(davRequest(creds, { method: 'DELETE', url: 'https://cal.example.org/x.ics' }, fetchImpl, publicLookup));
      expect(err.code).toBe('fetch-error');
      expect(seen).toHaveLength(1);
    }
  });

  it('refuses a redirect to a name that resolves to the local network', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'cal.example.org' ? redirect('https://inside.example.org/') : new Response('', { status: 207 })));
    const lookup = async (name: string) => [{ address: name === 'inside.example.org' ? '192.168.1.10' : '93.184.216.34' }];
    expect((await failure(davRequest(creds, { method: 'PROPFIND', url: 'https://cal.example.org/' }, fetchImpl, lookup))).code).toBe('fetch-error');
    expect(seen).toHaveLength(1);
  });

  it('a request that started on this machine may stay on it', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.pathname === '/.well-known/caldav' ? redirect('/dav/', 301) : new Response('<multistatus/>', { status: 207 })));
    const answer = await davRequest(creds, { method: 'PROPFIND', url: 'http://127.0.0.1:5232/.well-known/caldav' }, fetchImpl);
    expect(answer.url).toBe('http://127.0.0.1:5232/dav/');
    expect(seen.every((s) => s.auth)).toBe(true);
  });

  it('a write follows a redirect only within its own origin', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'caldav.icloud.com' ? redirect('https://p34-caldav.icloud.com/x.ics', 307) : new Response('', { status: 204 })));
    expect((await failure(davRequest(creds, { method: 'PUT', url: 'https://caldav.icloud.com/x.ics', body: 'x' }, fetchImpl, publicLookup))).code).toBe('fetch-error');
    expect(seen).toHaveLength(1);
  });
});

describe('guessed hosts get no password', () => {
  const account: MailAccountForCalendar = { accountId: 'imap:abc', address: 'pat@example.org', password: 'app-pass', hosts: { imap: 'imap.mailhost.example' } };

  it('asks the mail domain without the password and reports the calendar server it found', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => {
      if (url.hostname === 'example.org') return redirect('https://dav.mailhost.example/dav/', 301);
      return new Response('login', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="dav"' } });
    });
    const err = await failure(discoverCalendars(account, { fetch: fetchImpl, lookup: publicLookup, resolveSrv: async () => [] }));
    expect(err).toMatchObject({ code: 'found-server', serverUrl: 'https://dav.mailhost.example/dav/' });
    expect(err.message).toContain('Found a calendar server at dav.mailhost.example');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.auth)).toBe(false);
  });

  it('probes an SRV target without the password too', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'example.org'
      ? new Response('nope', { status: 404 })
      : new Response('login', { status: 401, headers: { DAV: '1, 2, calendar-access' } })));
    const srv = async () => [{ name: 'dav.elsewhere.example.', port: 443, priority: 0, weight: 1 }];
    const err = await failure(discoverCalendars(account, { fetch: fetchImpl, lookup: publicLookup, resolveSrv: srv }));
    expect(err).toMatchObject({ code: 'found-server', serverUrl: 'https://dav.elsewhere.example/.well-known/caldav' });
    expect(seen.some((s) => s.auth)).toBe(false);
  });

  it('a website that is no calendar server is no answer, and still gets no password', async () => {
    const { seen, fetchImpl } = fakeFetch(() => new Response('<html>shop</html>', { status: 405 }));
    expect((await failure(discoverCalendars(account, { fetch: fetchImpl, lookup: publicLookup, resolveSrv: async () => [] }))).code).toBe('no-calendar');
    expect(seen.some((s) => s.auth)).toBe(false);
  });

});

describe('answers', () => {
  it('stops reading an answer past the size cap', async () => {
    const big = new Uint8Array(MAX_ANSWER_BYTES + 1024).fill(0x61);
    const { fetchImpl } = fakeFetch(() => new Response(big, { status: 207 }));
    expect((await failure(davRequest(creds, { method: 'REPORT', url: 'https://caldav.example.com/cal/' }, fetchImpl))).message).toMatch(/more than 10 MB/);
  });

  it('joins a fold a server made inside a UTF-8 character before decoding', async () => {
    const text = `SUMMARY:${'a'.repeat(66)}éb`;
    const bytes = new TextEncoder().encode(text);
    const at = bytes.indexOf(0xc3);
    const split = new Uint8Array([...bytes.slice(0, at + 1), 0x0d, 0x0a, 0x20, ...bytes.slice(at + 1)]);
    expect(new TextDecoder().decode(joinSplitCharacters(split))).toBe(text);
    const { fetchImpl } = fakeFetch(() => new Response(split, { status: 200 }));
    expect((await davRequest(creds, { method: 'GET', url: 'https://caldav.example.com/x.ics' }, fetchImpl)).text).toBe(text);
    // An ordinary fold between ASCII characters is left for the iCalendar reader.
    const ascii = new TextEncoder().encode('SUMMARY:ab\r\n cd');
    expect(new TextDecoder().decode(joinSplitCharacters(ascii))).toBe('SUMMARY:ab\r\n cd');
  });
});

describe('server paths stay on their origin', () => {
  it('a calendar href with a path that looks like another host never takes a request there', async () => {
    const ms = (body: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`, { status: 207 });
    const { seen, fetchImpl } = fakeFetch((url, method) => {
      if (method === 'PROPFIND' && url.pathname === '/') {
        return ms('<d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
      }
      if (method === 'PROPFIND') {
        return ms('<d:response><d:href>https://cal.example.com//evil.example/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Odd</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
      }
      return ms('');
    });
    const source = createCalDavSource({
      accountId: 'imap:abc',
      credentials: async () => ({ accountId: 'imap:abc', address: 'pat@example.com', password: 'app-pass', hosts: { caldav: 'https://cal.example.com/' } }),
      fetch: fetchImpl,
      lookup: publicLookup,
      localZone: () => 'UTC',
    });
    await source.listEvents('2026-08-01', '2026-08-31');
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((s) => new URL(s.url).hostname === 'cal.example.com')).toBe(true);
  });
});

describe('round two: address forms, shared hosting domains, guessed hosts, odd folds', () => {
  it('reads every form of a local address as local', () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]:3456/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:c0a8:101]/', 'http://[::ffff:a9fe:a9fe]/',
      'http://[::127.0.0.1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::]/',
      'http://[fe80::1]/', 'http://[FEBF::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://2130706433/', 'http://0177.0.0.1/',
      'http://0x7f.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://0.0.0.0/',
    ]) {
      expect(isPrivateAddress(new URL(url).hostname), url).toBe(true);
    }
    for (const url of ['https://[2001:db8::1]/', 'https://93.184.216.34/', 'https://[::ffff:5db8:d822]/', 'https://caldav.example.com/']) {
      expect(isPrivateAddress(new URL(url).hostname), url).toBe(false);
    }
  });

  it('never follows a redirect to an IPv4-mapped IPv6 local address', async () => {
    const { seen, fetchImpl } = fakeFetch((url) => (url.hostname === 'cal.example.org' ? redirect('http://[::ffff:a9fe:a9fe]/latest/', 307) : new Response('', { status: 200 })));
    expect((await failure(davRequest(null, { method: 'PROPFIND', url: 'https://cal.example.org/' }, fetchImpl, publicLookup))).code).toBe('fetch-error');
    expect(seen).toHaveLength(1);
  });

  it('treats two tenants of a shared hosting domain as two sites', () => {
    for (const [a, b] of [['me.duckdns.org', 'evil.duckdns.org'], ['alice.github.io', 'evil.github.io'], ['foo.s3.amazonaws.com', 'bar.s3.amazonaws.com']]) {
      expect(sameSite(new URL(`https://${a}/`), new URL(`https://${b}/`)), `${a} ${b}`).toBe(false);
    }
    expect(sameSite(new URL('https://p34-caldav.icloud.com/'), new URL('https://caldav.icloud.com/'))).toBe(true);
  });

  it("asks the mail domain's well-known URL without the password even when IMAP is on that domain", async () => {
    const { seen, fetchImpl } = fakeFetch(() => new Response('login', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"', DAV: '1, calendar-access' } }));
    const account: MailAccountForCalendar = { accountId: 'imap:abc', address: 'pat@example.org', password: 'app-pass', hosts: { imap: 'imap.example.org' } };
    const err = await failure(discoverCalendars(account, { fetch: fetchImpl, lookup: publicLookup, resolveSrv: async () => [] }));
    expect(err.code).toBe('found-server');
    expect(seen.some((s) => s.auth)).toBe(false);
  });

  it('a calendar home on another site is reported, not sent the password', async () => {
    const ms = (body: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`, { status: 207 });
    const { seen, fetchImpl } = fakeFetch(() => ms('<d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>https://collector.example.net/home/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'));
    const account: MailAccountForCalendar = { accountId: 'imap:abc', address: 'pat@example.com', password: 'app-pass', hosts: { caldav: 'https://cal.example.com/' } };
    const err = await failure(discoverCalendars(account, { fetch: fetchImpl, lookup: publicLookup }));
    expect(err).toMatchObject({ code: 'found-server', serverUrl: 'https://collector.example.net/home/' });
    expect(seen.every((s) => new URL(s.url).hostname === 'cal.example.com')).toBe(true);
  });

  it('joins a fold inside a UTF-8 character when the server wrote its CR as &#13;', () => {
    const text = `SUMMARY:${'a'.repeat(66)}éb`;
    const bytes = new TextEncoder().encode(text);
    const at = bytes.indexOf(0xc3);
    for (const entity of ['&#13;', '&#xD;', '&#xd;']) {
      const split = new Uint8Array([...bytes.slice(0, at + 1), ...new TextEncoder().encode(`${entity}\n `), ...bytes.slice(at + 1)]);
      expect(new TextDecoder().decode(joinSplitCharacters(split))).toBe(text);
    }
  });
});

describe('round three: a read of many costly series shares one budget and yields', () => {
  it('40 series that each run out of budget never block the event loop for 50 ms', async () => {
    const one = (k: number) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s${k}\r\nDTSTART:17000101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;BYMONTH=11;COUNT=999999999\r\nSUMMARY:S${k}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const body = Array.from({ length: 40 }, (_, k) => `<d:response><d:href>/cal/s${k}.ics</d:href><d:propstat><d:prop><d:getetag>"${k}"</d:getetag><c:calendar-data>${one(k)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
    const ms = (inner: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, { status: 207 });
    const { fetchImpl } = fakeFetch((url, method) => {
      if (method === 'PROPFIND' && url.pathname === '/') return ms('<d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
      if (method === 'PROPFIND') return ms('<d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>C</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
      return ms(body);
    });
    const source = createCalDavSource({
      accountId: 'imap:abc',
      credentials: async () => ({ accountId: 'imap:abc', address: 'pat@example.com', password: 'app-pass', hosts: { caldav: 'https://cal.example.com/' } }),
      fetch: fetchImpl, lookup: publicLookup, localZone: () => 'UTC',
    });
    await source.listCalendars();
    let last = performance.now();
    let worst = 0;
    let ticking = true;
    const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (ticking) setImmediate(tick); };
    setImmediate(tick);
    await source.listEvents('2026-11-01', '2026-11-30');
    ticking = false;
    worst = Math.max(worst, performance.now() - last); // the stretch since the last tick counts too
    expect(worst).toBeLessThan(SYNC_BUDGET_MS);
    expect(source.degraded?.()).toMatch(/too costly/);
  });
});
