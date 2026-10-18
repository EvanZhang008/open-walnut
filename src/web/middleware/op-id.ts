/**
 * Client op ids on this server's write routes (docs/plan/walnut-replica-servers-impl.md
 * section 3, "Op ids").
 *
 * Every client write carries `x-walnut-op-id` (one per user action). A write route
 * applies an op id once per `(hostKey, home, opId)`:
 *   - an id the applied-ops ledger already holds answers the stored answer again
 *     (header `x-walnut-op-replayed: 1`), so a forward and a journaled retry of the
 *     same action, or a client's retry after a lost answer, apply once; a host drain's
 *     row counts as well (any rev; any host for this server's own clients, since a client
 *     that sent the action through a replica may retry it straight here);
 *   - an id a request is still running for waits for that request's answer and returns
 *     it (the web client retries a timed-out write about 300 ms after it aborts, while
 *     the first attempt usually still runs here), and is never refused on age;
 *   - a write forwarded by a replica carries `x-walnut-forwarded-at` (the host's clock
 *     when the replica opened the stream); one older than STALE_FORWARD_MS on this
 *     server's clock (judged with the host's measured offset) answers
 *     `409 stale_forward` and applies nothing: it sat in the buffers of a frozen Mac,
 *     and the replica may already have journaled its retry. With no measured offset for
 *     that host it is never refused on age (the ledger still dedupes). The ledger is read
 *     first: a late copy of a write already applied answers its first answer;
 *   - the same id on another route answers `409 op_id_reused` and runs nothing there.
 *
 * The host a request came through is known from its socket, never from a header a
 * client could send: the forward lane registers the loopback connection it splices a
 * replica's stream into under the daemon connection's `hostKey` (the key the drain
 * records that host's journal under; forward-lane-ports.ts, daemon-connection.ts
 * plugFollowerStream), and a socket may also carry a tag (`tagForwardedSocket`); this
 * server's own clients are LOCAL_HOST. The drain still also looks under LOCAL_HOST
 * (ledger.ts `journaledKeys`) for a forward that reached this server another way.
 * A request without an op id passes through unchanged.
 *
 * A forward's age is judged from when its HEADERS arrived (`stampArrival`, mounted
 * before every body parser), never after its body was read: a large body on a slow link
 * would otherwise be refused on every retry although the Mac was never frozen.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { LOCAL_HOST, lookupApplied, lookupDrained, opInFlight, recordApplied, reserveOp, type LedgerEntry, type LedgerKey, type LedgerOutcome } from '../../core/offline-merge/ledger.js';
import { hostClockOffset } from '../../core/offline-merge/host-clock.js';
import { forwardHostOfPeer } from '../../lib/forward-lane-ports.js';

export const OP_ID_HEADER = 'x-walnut-op-id';
export const FORWARDED_AT_HEADER = 'x-walnut-forwarded-at';
/** A forwarded write older than this is refused (section 3). */
export const STALE_FORWARD_MS = 20_000;
/** Same shape the daemon accepts (offline-host-core.ts OP_ID_RE). */
const OP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Largest answer kept for a duplicate; a longer one keeps its status and a short body. */
const MAX_CAPTURE = 64 * 1024;
/** A handler whose client went away and that never answers frees its id after this. */
const ORPHAN_RELEASE_MS = 120_000;

const FORWARD_HOST = Symbol.for('walnut.forwardHost');
const ARRIVED_AT = Symbol.for('walnut.arrivedAt');

/**
 * Stamp when a request's headers arrived. Mounted first, before every body parser, so the
 * stale-forward age never counts the time its body took to stream in.
 */
export function stampArrival(now: () => number = Date.now): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as unknown as Record<symbol, unknown>)[ARRIVED_AT] = now();
    next();
  };
}

function arrivedAt(req: Request): number | undefined {
  const at = (req as unknown as Record<symbol, unknown>)[ARRIVED_AT];
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

/** The forward lane marks a socket it serves a replica's requests on with that host's key. */
export function tagForwardedSocket(socket: object, hostKey: string): void {
  (socket as Record<symbol, unknown>)[FORWARD_HOST] = hostKey;
}

/**
 * The host a request came through: the socket's forward tag, else the forward lane that
 * opened this loopback connection (forward-lane-ports.ts), else this server's own client.
 */
export function forwardHostOf(req: Request): string {
  const socket = req.socket as (Request['socket'] & Record<symbol, unknown>) | undefined;
  const tag = socket ? socket[FORWARD_HOST] : undefined;
  if (typeof tag === 'string' && tag) return tag;
  return (socket && forwardHostOfPeer(socket.remoteAddress, socket.remotePort)) || LOCAL_HOST;
}

export interface OpIdOptions {
  home?: string;
  now?: () => number;
  hostKeyOf?: (req: Request) => string;
  offsetOf?: (hostKey: string) => number | null;
}

function refuse(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

/** Answer a duplicate with the first attempt's answer. */
function replay(res: Response, entry: LedgerOutcome | LedgerEntry, opId: string): void {
  res.setHeader('x-walnut-op-replayed', '1');
  // A write the drain refused or gave up (no HTTP answer stored) did not land: never a 200.
  const notLanded = entry.outcome === 'refused' || entry.outcome === 'given-up';
  res.status(entry.status ?? (notLanded ? 409 : 200));
  if (entry.body === undefined && notLanded) {
    res.json({ ok: false, duplicate: true, opId, error: { code: entry.outcome === 'refused' ? 'op_refused' : 'op_given_up', message: entry.detail ?? 'this write was not applied' } });
    return;
  }
  if (entry.body !== undefined) {
    if (entry.contentType) res.setHeader('Content-Type', entry.contentType);
    res.send(entry.body);
    return;
  }
  res.json({ ok: entry.outcome === 'applied' || entry.outcome === 'noop', duplicate: true, opId });
}

/**
 * The same op id on another route: a client bug (one id per user action, one write each).
 * Answered loudly and applied nowhere, never with the other route's answer.
 */
function reused(res: Response, opId: string, first: string, now: string, hostKey: string): void {
  log.web.warn('op id: the same id arrived on another route; not applied', { opId, firstRoute: first, route: now, hostKey });
  refuse(res, 409, 'op_id_reused', `${OP_ID_HEADER} ${opId} was already used for ${first}; send a new id for this write`);
}

/** A status a duplicate must get again (applied or refused by this server); 5xx, 408 and 429 may apply on retry. */
function settles(status: number): boolean {
  return status >= 200 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Wrap the response so its answer is captured when the handler ends it (also when the
 * client already went away: the handler's own end is what says it finished).
 */
function captureAnswer(res: Response, onEnd: (answer: LedgerOutcome) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const take = (chunk: unknown, encoding?: unknown): void => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function' || overflow) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
    size += buf.length;
    if (size > MAX_CAPTURE) { overflow = true; chunks.length = 0; return; }
    chunks.push(buf);
  };
  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
  let ended = false;
  (res as unknown as { write: (...a: unknown[]) => boolean }).write = (...args: unknown[]) => {
    take(args[0], args[1]);
    return origWrite(...args);
  };
  (res as unknown as { end: (...a: unknown[]) => Response }).end = (...args: unknown[]) => {
    if (!ended) {
      ended = true;
      take(args[0], args[1]);
      const status = res.statusCode;
      const contentType = res.getHeader('content-type');
      onEnd({
        outcome: status < 400 ? 'applied' : 'refused',
        status,
        ...(overflow ? {} : { body: Buffer.concat(chunks).toString('utf8') }),
        ...(typeof contentType === 'string' ? { contentType } : {}),
      });
    }
    return origEnd(...args);
  };
}

/** The op-id middleware. Mounted on `/api` after auth (an unauthenticated call never takes an id). */
export function opIdMiddleware(opts: OpIdOptions = {}): RequestHandler {
  const now = opts.now ?? Date.now;
  const hostKeyOf = opts.hostKeyOf ?? forwardHostOf;
  const offsetOf = opts.offsetOf ?? hostClockOffset;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!WRITE_METHODS.has(req.method)) return next();
    const rawId = req.headers[OP_ID_HEADER];
    const rawAt = req.headers[FORWARDED_AT_HEADER];
    if (rawId === undefined && rawAt === undefined) return next();
    const hostKey = hostKeyOf(req);
    const opId = typeof rawId === 'string' ? rawId.trim() : '';
    if (rawId !== undefined && !OP_ID_RE.test(opId)) {
      return refuse(res, 400, 'bad_op_id', `${OP_ID_HEADER} must be 1 to 80 letters, digits, "-" or "_"`);
    }
    const home = opts.home ?? WALNUT_HOME;
    const key: LedgerKey = { hostKey, home, opId, rev: 1 };
    const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
    // An op this server already answered answers the same again, however late this copy
    // arrives: a stale forward of an APPLIED write must not read as "not applied".
    // A host drain that applied this op counts too (any rev): under the request's own host
    // when it came through a tagged forward, under ANY host when it is this server's own
    // client, which is how a client that sent the action through a replica (journaled,
    // drained) retries it straight at this Mac.
    const seen = opId
      ? lookupApplied(key, now()) ?? lookupDrained(home, opId, hostKey === LOCAL_HOST ? undefined : hostKey, now())
      : null;
    if (seen) {
      if (seen.route && seen.route !== route) return reused(res, opId, seen.route, route, hostKey);
      log.web.info('op id: a write already applied answers its first answer', { method: req.method, path: req.originalUrl, hostKey, opId, status: seen.status, outcome: seen.outcome });
      return replay(res, seen, opId);
    }
    // A copy of a write whose first copy is still running waits for that answer below, never
    // refused on age: the first copy applies, and a "send it again" would apply it twice.
    if (typeof rawAt === 'string' && rawAt && !(opId && opInFlight(key))) {
      const forwardedAt = Number(rawAt);
      const offset = Number.isFinite(forwardedAt) ? offsetOf(hostKey) : null;
      if (offset !== null) {
        const ageMs = (arrivedAt(req) ?? now()) - (forwardedAt + offset);
        if (ageMs > STALE_FORWARD_MS) {
          log.web.warn('forward stale refused', {
            method: req.method, path: req.originalUrl, hostKey, opId, ageMs, offsetMs: offset,
          });
          return refuse(res, 409, 'stale_forward', 'this write waited too long on its way to the Mac and was not applied; send it again', { ageMs });
        }
      }
    }
    if (!opId) return next();
    const held = reserveOp(key);
    if (!held.owner) {
      log.web.info('op id: the same write is still running; waiting for its answer', { method: req.method, path: req.originalUrl, hostKey, opId });
      void held.wait.then((first) => {
        if (res.writableEnded || res.destroyed) return;
        if (first?.route && first.route !== route) return reused(res, opId, first.route, route, hostKey);
        if (first) return replay(res, first, opId);
        // The first attempt never answered (its handler was dropped): this one may run.
        opIdMiddleware(opts)(req, res, next);
      });
      return;
    }
    let orphan: ReturnType<typeof setTimeout> | undefined;
    captureAnswer(res, (answer) => {
      if (orphan) clearTimeout(orphan);
      const status = answer.status ?? 0;
      const recorded: LedgerOutcome = { ...answer, source: 'http', route };
      if (settles(status)) recordApplied(key, recorded, now());
      // A waiter gets this answer either way; only a settled one is kept for later retries.
      held.finish(recorded);
    });
    res.once('close', () => {
      if (res.writableEnded) return;
      orphan = setTimeout(() => held.finish(null), ORPHAN_RELEASE_MS);
      orphan.unref?.();
    });
    next();
  };
}
