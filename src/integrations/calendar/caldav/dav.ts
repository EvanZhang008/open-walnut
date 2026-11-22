/**
 * WebDAV/CalDAV over HTTP: one request with a deadline, redirects followed by hand, and the
 * 207 multistatus answer read into plain objects.
 *
 * Every call has a deadline (`AbortSignal.timeout`), because the calendar's routes answer the
 * web UI and a server that never answers must not hold a request open (CLAUDE.md: "Never block
 * the web server"), and an answer is read up to `MAX_ANSWER_BYTES`, no further.
 *
 * Redirects are followed here rather than by fetch, under net-policy.ts:
 * - the password goes only over https (or to this machine for a server set up here), and only
 *   to the origin the request started at or another host of its registrable domain; a redirect
 *   anywhere else stops with `found-server` (CalendarServerElsewhere), naming where it pointed;
 * - a redirect to this machine or the local network is refused unless the request started there;
 * - a write (PUT, DELETE) follows a redirect only within its own origin.
 * A request without credentials (a probe of a guessed host) may follow a redirect to another
 * site, as nothing secret rides on it.
 *
 * Hrefs are kept as the server wrote them (percent-encoded) and only resolved against a base.
 *
 * XML is read with htmlparser2's streaming parser (already a dependency) into a small tree.
 * Names are compared by their local part, lower case: CalDAV servers disagree on prefixes
 * (d:, D:, none), and the few names read here do not collide across the namespaces in use.
 */
import { Parser } from 'htmlparser2';
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import { isLoopbackHost, isPrivateAddress, resolvesPrivate, sameSite, type LookupAll } from './net-policy.js';

export const DAV_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** No calendar answer Walnut reads is near this; a bigger one is refused, not buffered. */
export const MAX_ANSWER_BYTES = 10 * 1024 * 1024;

export interface DavCredentials { username: string; password: string }

export interface DavRequest {
  method: 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE';
  url: string;
  depth?: '0' | '1';
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface DavAnswer { status: number; url: string; headers: Headers; text: string }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The calendar server is somewhere the password may not go on its own; the user can name it. */
export class CalendarServerElsewhere extends CalendarHelperError {
  constructor(message: string, public readonly serverUrl: string) {
    super(message, 'found-server');
  }
}

/** Only https carries the password, except to this machine (a local server, a test). */
export function mayCarryPassword(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function basic(c: DavCredentials): string {
  return `Basic ${Buffer.from(`${c.username}:${c.password}`, 'utf8').toString('base64')}`;
}

const READS = new Set(['PROPFIND', 'REPORT', 'GET']);

/** Whether a redirect from `start` to `next` may be followed; throws when it may not. */
async function checkRedirect(start: URL, next: URL, withPassword: boolean, method: string, lookup?: LookupAll): Promise<void> {
  const startLocal = isPrivateAddress(start.hostname);
  if (!startLocal && (next.protocol !== 'https:' && next.protocol !== 'http:')) {
    throw new CalendarHelperError(`${start.host} redirected to a ${next.protocol} address; Walnut does not follow that.`, 'fetch-error');
  }
  if (!startLocal && next.hostname !== start.hostname && await resolvesPrivate(next.hostname, lookup)) {
    throw new CalendarHelperError(`${start.host} redirected to an address on this machine or its local network (${next.host}); Walnut does not follow that.`, 'fetch-error');
  }
  if (next.origin === start.origin) return;
  if (!READS.has(method)) {
    throw new CalendarHelperError(`${start.host} redirected a change to ${next.host}; Walnut saves only to the server it read the event from.`, 'fetch-error');
  }
  if (withPassword && !sameSite(start, next)) {
    throw new CalendarServerElsewhere(`The calendar server is at ${next.host}; set it as the account's calendar server to use it.`, next.toString());
  }
}

/** The answer's bytes up to the cap, a fold that split a UTF-8 character joined back first. */
async function readAnswer(res: Response, host: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CalendarHelperError(`${host} sent more than ${MAX_ANSWER_BYTES / 1024 / 1024} MB for one answer; Walnut stopped reading it.`, 'fetch-error');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(joinSplitCharacters(bytes));
}

/** The length of a CR written as an XML character reference (&#13; &#xD;) at `i`, else 0. */
function crEntityAt(bytes: Uint8Array, i: number): number {
  if (bytes[i] !== 0x26 || bytes[i + 1] !== 0x23) return 0; // "&#"
  const dec = [0x31, 0x33, 0x3b]; // "13;"
  if (dec.every((c, k) => bytes[i + 2 + k] === c)) return 5;
  const hex = bytes[i + 2] === 0x78 || bytes[i + 2] === 0x58; // x / X
  if (hex && (bytes[i + 3] === 0x44 || bytes[i + 3] === 0x64) && bytes[i + 4] === 0x3b) return 5; // D / d ;
  return 0;
}

/**
 * iCalendar folds lines at 75 octets, and some servers fold inside a multi-byte UTF-8
 * character. Decoding first would turn both halves into U+FFFD for good, so a line break plus
 * one space or tab that sits between a UTF-8 lead or continuation byte and a continuation byte
 * (where no text can ever have one) is removed on the bytes; its CR may be an XML character
 * reference (`&#13;`), as servers that escape it inside calendar-data write it. Every other fold
 * is left to the iCalendar reader.
 */
export function joinSplitCharacters(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (n > 0 && out[n - 1] >= 0x80 && (b === 0x0d || b === 0x0a || b === 0x26)) {
      let j = i + crEntityAt(bytes, i);
      const lineAt = j;
      if (bytes[j] === 0x0d) j++;
      if (bytes[j] === 0x0a) j++;
      const ws = bytes[j];
      const after = bytes[j + 1];
      if (j > lineAt && (ws === 0x20 || ws === 0x09) && after !== undefined && after >= 0x80 && after <= 0xbf) {
        i = j;
        continue;
      }
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/**
 * One request, redirects followed, within its deadline. Network failures become `fetch-error`.
 * `creds` null sends no password at all (a probe of a host the account never named).
 */
export async function davRequest(creds: DavCredentials | null, req: DavRequest, fetchImpl: FetchLike = fetch, lookup?: LookupAll): Promise<DavAnswer> {
  const start = new URL(req.url);
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (creds && !mayCarryPassword(url)) {
      throw new CalendarHelperError(`Walnut sends a mail password only over https; ${url.origin} is not https.`, 'fetch-error');
    }
    const headers: Record<string, string> = {
      ...(creds ? { Authorization: basic(creds) } : {}),
      ...(req.depth !== undefined ? { Depth: req.depth } : {}),
      ...(req.body !== undefined ? { 'Content-Type': req.contentType ?? 'application/xml; charset=utf-8' } : {}),
      ...req.headers,
    };
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(req.timeoutMs ?? DAV_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new CalendarHelperError(
        timedOut ? `${url.host} did not answer within ${Math.round((req.timeoutMs ?? DAV_TIMEOUT_MS) / 1000)} seconds.` : `Could not reach ${url.host}: ${err instanceof Error ? err.message : String(err)}`,
        'fetch-error',
      );
    }
    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      await res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new CalendarHelperError(`${url.host} redirected to an address that is not one (${location.slice(0, 80)}).`, 'fetch-error');
      }
      await checkRedirect(start, next, !!creds, req.method, lookup);
      url = next;
      continue;
    }
    let text = '';
    try {
      text = await readAnswer(res, url.host);
    } catch (err) {
      if (err instanceof CalendarHelperError) throw err;
      throw new CalendarHelperError(`${url.host} broke off its answer: ${err instanceof Error ? err.message : String(err)}`, 'fetch-error');
    }
    return { status: res.status, url: url.toString(), headers: res.headers, text };
  }
  throw new CalendarHelperError(`${start.host} redirected more than ${MAX_REDIRECTS} times.`, 'fetch-error');
}

// ── XML ──────────────────────────────────────────────────────────────────────

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const parser = new Parser({
    onopentag(name, attrs) {
      const node: XmlNode = { name: localName(name), attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    ontext(text) {
      stack[stack.length - 1].text += text;
    },
    onclosetag() {
      if (stack.length > 1) stack.pop();
    },
  }, { xmlMode: true, decodeEntities: true, recognizeCDATA: true });
  parser.write(xml);
  parser.end();
  return root;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  return (node.text + node.children.map(textOf).join('')).trim();
}

export interface DavResponse {
  href: string;
  /** The properties the server answered with 200, by local name. */
  props: Map<string, XmlNode>;
}

/** The responses of a 207 multistatus; a response's properties are those of its 200 propstat. */
export function parseMultistatus(xml: string): DavResponse[] {
  const root = parseXml(xml);
  return descendants(root, 'response').map((r) => {
    const props = new Map<string, XmlNode>();
    for (const ps of r.children.filter((c) => c.name === 'propstat')) {
      const status = textOf(child(ps, 'status'));
      if (status && !/\s2\d\d\s/.test(` ${status} `)) continue;
      for (const p of child(ps, 'prop')?.children ?? []) props.set(p.name, p);
    }
    return { href: textOf(child(r, 'href')), props };
  });
}

/** The first <href> inside a property (current-user-principal, calendar-home-set). */
export function hrefIn(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const h = descendants(node, 'href')[0];
  const value = h ? textOf(h) : '';
  return value || undefined;
}

/** An href (kept as the server wrote it, still percent-encoded) made absolute against `base`. */
export function absolute(href: string, base: string): string {
  return new URL(href, base).toString();
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
