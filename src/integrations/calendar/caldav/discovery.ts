/**
 * Finding a mail account's calendars: where its CalDAV server is, who the account is there
 * (its principal), where its calendars live (the calendar home), and which calendars those are.
 *
 * Where the server is, in order:
 *   1. the account's own `caldav_url`, when its mail settings name one;
 *   2. a known provider: iCloud, Fastmail and Yahoo (by the address's domain or the IMAP host);
 *   3. RFC 6764: https://<domain>/.well-known/caldav, then the `_caldavs._tcp.<domain>` SRV record.
 * Google and Microsoft accept only their own sign-in (OAuth) for calendars, never a mail
 * password, so their accounts are reported as needing one and the password is never tried. A
 * Google account signed in that way (sign-in/) comes here with its `bearer` and Google's CalDAV
 * address as its `caldav_url`, and is found like any other.
 *
 * The password goes only where the account itself points (RFC 6764 section 8): its `caldav_url`
 * (typed in its settings, or a found server the person picked) or a known provider. Every other
 * candidate (the mail domain's well-known URL, even on the IMAP server's own domain, whose website
 * is often hosted by someone else; an SRV target, which DNS does not vouch for) is asked WITHOUT
 * the password; one that answers like a calendar server is reported as `found-server`, and the
 * person decides whether it becomes the account's `caldav_url`. A principal or calendar home the
 * server names on another site is reported the same way, never sent the password.
 *
 * Every request has its own deadline and the whole search a budget (`DISCOVERY_BUDGET_MS`),
 * so "Add its calendar" always answers.
 */
import { promises as dns } from 'node:dns';
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import { signInNeededText, signInProvider } from '../sign-in-provider.js';

export { signInProvider } from '../sign-in-provider.js';
import {
  CalendarServerElsewhere,
  DAV_TIMEOUT_MS,
  child,
  davRequest,
  descendants,
  hrefIn,
  parseMultistatus,
  textOf,
  type DavBearer,
  type DavCredentials,
  type DavResponse,
  type FetchLike,
} from './dav.js';
import { sameSite, type LookupAll } from './net-policy.js';

export const DISCOVERY_BUDGET_MS = 40_000;
const SRV_TIMEOUT_MS = 4_000;

/** What the calendar gets from a mail account (the mail plugin's credential service). */
export interface MailAccountForCalendar {
  accountId: string;
  address: string;
  /** The login name, when it is not the address. */
  username?: string;
  password: string;
  hosts: { imap?: string; smtp?: string; caldav?: string };
  /** A provider's sign-in instead of the password (a Google account signed in for calendars). */
  bearer?: DavBearer;
}

export interface DiscoveredCalendar {
  /** The collection's path on `origin`, as the server wrote it. */
  path: string;
  title: string;
  color?: string;
  readonly: boolean;
}

export interface Discovery {
  /** Scheme, host and port the calendars are on (the home's, after any redirect). */
  origin: string;
  homeUrl: string;
  calendars: DiscoveredCalendar[];
}

export interface DiscoveryDeps {
  fetch?: FetchLike;
  lookup?: LookupAll;
  resolveSrv?: (name: string) => Promise<Array<{ name: string; port: number; priority: number; weight: number }>>;
}

function domainOf(address: string): string {
  return address.split('@').pop()?.trim().toLowerCase() ?? '';
}

function hostMatches(host: string | undefined, patterns: RegExp[]): boolean {
  const h = host?.trim().toLowerCase();
  return !!h && patterns.some((p) => p.test(h));
}

const PRESETS: ReadonlyArray<{ domains: RegExp; hosts: RegExp[]; url: string }> = [
  { domains: /^(icloud|me|mac)\.com$/, hosts: [/(^|\.)mail\.me\.com$/, /(^|\.)icloud\.com$/], url: 'https://caldav.icloud.com/' },
  { domains: /^(fastmail\.(com|fm)|messagingengine\.com)$/, hosts: [/(^|\.)fastmail\.com$/, /(^|\.)messagingengine\.com$/], url: 'https://caldav.fastmail.com/' },
  { domains: /^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/, hosts: [/(^|\.)yahoo\.com$/], url: 'https://caldav.calendar.yahoo.com/' },
];

export interface StartUrl {
  url: string;
  /** Looked up from the address, so it may simply not exist. */
  guessed: boolean;
  /** The account points here (its own setting, a known provider, its IMAP server's domain): the password may go. */
  trusted: boolean;
}

/** Where to start looking, best first. */
export async function startUrls(account: MailAccountForCalendar, deps: DiscoveryDeps = {}): Promise<StartUrl[]> {
  if (account.hosts.caldav?.trim()) return [{ url: account.hosts.caldav.trim(), guessed: false, trusted: true }];
  const domain = domainOf(account.address);
  const preset = PRESETS.find((p) => p.domains.test(domain) || p.hosts.some((h) => hostMatches(account.hosts.imap, [h])));
  if (preset) return [{ url: preset.url, guessed: false, trusted: true }];
  if (!domain) return [];
  const guess = (url: string): StartUrl => ({ url, guessed: true, trusted: false });
  const out = [guess(`https://${domain}/.well-known/caldav`)];
  const resolveSrv = deps.resolveSrv ?? ((name: string) => dns.resolveSrv(name));
  try {
    const records = await Promise.race([
      resolveSrv(`_caldavs._tcp.${domain}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('srv timeout')), SRV_TIMEOUT_MS).unref?.()),
    ]);
    const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (best?.name && best.name !== '.') {
      const port = best.port && best.port !== 443 ? `:${best.port}` : '';
      out.push(guess(`https://${best.name.replace(/\.$/, '')}${port}/.well-known/caldav`));
    }
  } catch {
    // No SRV record (the usual case) or no answer in time: the well-known URL is all there is.
  }
  return out;
}

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop>
</d:propfind>`;

const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const LIST_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/><d:displayname/><a:calendar-color/>
    <d:current-user-privilege-set/><c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

class Budget {
  private readonly endsAt: number;
  constructor(ms: number) { this.endsAt = Date.now() + ms; }
  timeout(): number {
    const left = this.endsAt - Date.now();
    if (left <= 250) throw new CalendarHelperError('The calendar server took too long to answer.', 'fetch-error');
    return Math.min(DAV_TIMEOUT_MS, left);
  }
}

/** What a request for this account carries: its sign-in, else its saved password. */
export function credsOf(account: MailAccountForCalendar): DavCredentials {
  return account.bearer ?? { username: account.username || account.address, password: account.password };
}

/** The server's own words, short (Google says which API is not enabled). */
function serverWords(text: string): string {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain ? `: ${plain.slice(0, 200)}` : '';
}

function failStatus(status: number, host: string, account: MailAccountForCalendar, text = ''): CalendarHelperError {
  if (account.bearer && status === 403) {
    return new CalendarHelperError(`${host} refused Walnut's calendar request (403)${serverWords(text)}. If it names an API that is not enabled, enable it for your ${account.bearer.provider} client and try again.`, 'auth-failed');
  }
  if (status === 401 || status === 403) {
    return new CalendarHelperError(`${host} refused the saved mail password for calendars. Some providers want an app password made for calendars; set one on the mail account and try again.`, 'auth-failed');
  }
  return new CalendarHelperError(`${host} answered ${status} when Walnut asked for its calendars.`, 'fetch-error');
}

function isCalendar(r: DavResponse): boolean {
  const types = r.props.get('resourcetype');
  if (!types || !child(types, 'calendar')) return false;
  const comps = r.props.get('supported-calendar-component-set');
  if (!comps || comps.children.length === 0) return true;
  return comps.children.some((c) => c.name === 'comp' && (c.attrs.name ?? '').toUpperCase() === 'VEVENT');
}

function writable(r: DavResponse): boolean {
  const set = r.props.get('current-user-privilege-set');
  if (!set) return true;
  return descendants(set, 'privilege').some((p) => p.children.some((c) => ['write', 'write-content', 'bind', 'all'].includes(c.name)));
}

function colorOf(r: DavResponse): string | undefined {
  const raw = textOf(r.props.get('calendar-color'));
  const m = /^#([0-9a-f]{6})/i.exec(raw);
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

/** The calendars at a calendar home (PROPFIND depth 1). */
export async function listHome(account: MailAccountForCalendar, homeUrl: string, deps: DiscoveryDeps = {}, timeoutMs = DAV_TIMEOUT_MS): Promise<DiscoveredCalendar[]> {
  const answer = await davRequest(credsOf(account), { method: 'PROPFIND', url: homeUrl, depth: '1', body: LIST_BODY, timeoutMs }, deps.fetch, deps.lookup);
  if (answer.status !== 207) throw failStatus(answer.status, new URL(answer.url).host, account, answer.text);
  const homePath = new URL(answer.url).pathname.replace(/\/?$/, '/');
  return parseMultistatus(answer.text)
    .filter((r) => isCalendar(r) && new URL(r.href, answer.url).pathname.replace(/\/?$/, '/') !== homePath)
    .map((r) => {
      const path = new URL(r.href, answer.url).pathname;
      const name = textOf(r.props.get('displayname'));
      return {
        path,
        title: name || decodeURIComponent(path.replace(/\/$/, '').split('/').pop() ?? '') || 'Calendar',
        ...(colorOf(r) ? { color: colorOf(r) } : {}),
        readonly: !writable(r),
      };
    });
}

/** An href a server answered, made absolute; one on another site is the person's call, not the password's. */
function onSameSite(href: string, base: string): string {
  const at = new URL(href, base);
  if (!sameSite(at, new URL(base))) {
    throw new CalendarServerElsewhere(`The calendar server is at ${at.host}; set it as the account's calendar server to use it.`, at.toString());
  }
  return at.toString();
}

/** The calendar home of the account, starting from one URL; null when nothing CalDAV is there. */
async function homeFrom(account: MailAccountForCalendar, start: string, budget: Budget, deps: DiscoveryDeps): Promise<string | null> {
  const creds = credsOf(account);
  const first = await davRequest(creds, { method: 'PROPFIND', url: start, depth: '0', body: PRINCIPAL_BODY, timeoutMs: budget.timeout() }, deps.fetch, deps.lookup);
  if ([404, 405, 501].includes(first.status)) return null;
  if (first.status !== 207) throw failStatus(first.status, new URL(first.url).host, account, first.text);
  const answer = parseMultistatus(first.text)[0];
  const home = hrefIn(answer?.props.get('calendar-home-set'));
  if (home) return onSameSite(home, first.url);
  const principal = hrefIn(answer?.props.get('current-user-principal'));
  if (!principal) return null;
  const principalUrl = onSameSite(principal, first.url);
  const second = await davRequest(creds, { method: 'PROPFIND', url: principalUrl, depth: '0', body: HOME_BODY, timeoutMs: budget.timeout() }, deps.fetch, deps.lookup);
  if (second.status !== 207) throw failStatus(second.status, new URL(second.url).host, account, second.text);
  const found = hrefIn(parseMultistatus(second.text)[0]?.props.get('calendar-home-set'));
  return found ? onSameSite(found, second.url) : null;
}

/**
 * Ask a guessed host, without the password, whether it is a calendar server. It is when it
 * answers the PROPFIND with a multistatus, or asks for a login while saying it speaks CalDAV
 * (`DAV: calendar-access`) or after its well-known URL sent Walnut somewhere. Returns the URL
 * it answered at, or null.
 */
async function probe(start: string, budget: Budget, deps: DiscoveryDeps): Promise<string | null> {
  const answer = await davRequest(null, { method: 'PROPFIND', url: start, depth: '0', body: PRINCIPAL_BODY, timeoutMs: budget.timeout() }, deps.fetch, deps.lookup);
  const speaksCalDav = /calendar-access/i.test(answer.headers.get('dav') ?? '');
  const redirected = new URL(answer.url).toString() !== new URL(start).toString();
  if (answer.status === 207 && /multistatus/i.test(answer.text)) return answer.url;
  if ((answer.status === 401 || answer.status === 403) && (speaksCalDav || (redirected && answer.headers.has('www-authenticate')))) return answer.url;
  return null;
}

/**
 * Find the account's calendars, or throw a CalendarHelperError whose code says why not:
 * `needs-sign-in`, `auth-failed`, `found-server` (a CalendarServerElsewhere naming its URL),
 * `no-calendar`, or `fetch-error` (unreachable, or the
 * server's own error, in its message).
 */
export async function discoverCalendars(account: MailAccountForCalendar, deps: DiscoveryDeps = {}): Promise<Discovery> {
  const provider = signInProvider(account);
  if (provider && !account.bearer) {
    throw new CalendarHelperError(signInNeededText(provider), 'needs-sign-in');
  }
  const budget = new Budget(DISCOVERY_BUDGET_MS);
  let failure: CalendarHelperError | null = null;
  for (const start of await startUrls(account, deps)) {
    try {
      if (!start.trusted) {
        const at = await probe(start.url, budget, deps);
        if (at) throw new CalendarServerElsewhere(`Found a calendar server at ${new URL(at).host}. Walnut sends the mail password there only once you say it is this account's calendar server.`, at);
        continue;
      }
      const homeUrl = await homeFrom(account, start.url, budget, deps);
      if (!homeUrl) continue;
      const calendars = await listHome(account, homeUrl, deps, budget.timeout());
      if (calendars.length === 0) continue;
      return { origin: new URL(homeUrl).origin, homeUrl, calendars };
    } catch (err) {
      const error = err instanceof CalendarHelperError ? err : new CalendarHelperError(String(err), 'fetch-error');
      // A refused password ends the search: every other URL would refuse it as well. A server
      // found elsewhere is the user's call, so it is the answer.
      if (error.code === 'auth-failed' || error.code === 'found-server') throw error;
      // A guessed URL that does not answer only means the domain hosts no calendar there.
      if (!start.guessed) failure = error;
    }
  }
  if (failure) throw failure;
  throw new CalendarHelperError(`${domainOf(account.address) || 'This server'} offers no calendar for ${account.address}.`, 'no-calendar');
}
