/**
 * Disk-full write guard — 507 Insufficient Storage instead of ENOSPC crashes.
 *
 * When the disk watermark monitor (src/core/disk-watermark.ts) reports the
 * data-dir filesystem critically full, every MUTATING /api request is refused
 * up front with a clear, machine-readable 507. Without this, the request
 * proceeds into a JSON-store write and dies halfway through a lock/tmp-file
 * dance with a raw ENOSPC — the 2026-08-12 cloud outage surfaced to the phone
 * as an opaque 500 on "mark task done", and the half-written lock file it left
 * behind is exactly the corruption shape the stores guard against.
 *
 * Scope: request METHOD is the gate (POST/PUT/PATCH/DELETE). GET/HEAD stay
 * fully available — reading tasks, notes, sessions must keep working while
 * the disk is full, and the notification center needs to deliver the "disk
 * critically full" alert itself.
 *
 * Carve-outs (allowed even while blocked):
 *  - /browser-logs      — crash forensics; tiny, and losing them blinds triage.
 *  - /v1/client-logs    — the MOBILE half of the same forensics channel. Left out
 *    originally, which inverted the intent above: a full disk silently 507'd every
 *    flight-recorder upload, and the client only gives up compression on a 4xx, so
 *    a 507 makes it retry the same batch forever while the phone's evidence of
 *    whatever the full disk broke never lands.
 *  - /notifications/*   — mark-read/dismiss on the very alert this guard fires.
 *  - /system/*          — health/diagnostics; a stuck box must stay inspectable.
 *  - /config/test-connection — read-only probe despite being a POST.
 *  - /files/delete      — deleting is how a full disk gets fixed. It was blocked
 *    with everything else, so the guard refused the one action that ends the
 *    outage; every other file mutation stays blocked (all of them consume space).
 *  - a host_exec run or stop (POST /v1/hosts/:host/exec, its /:jobId/stop, and
 *    /v1/host-exec/grants/:id/exec) — a command on a host is how a task frees
 *    that host's disk. 2026-11-08: the Mac fell to 5.4 GB free while a task was
 *    freeing it through host_exec, and every next command got this 507, so the
 *    cleanup stopped itself; only /files/delete was left to free enough by hand.
 *
 * A write this box only carries to the Mac (the companion's v1-forward) is not this disk's to
 * refuse: it writes nothing here. 2026-11-14: the companion's disk reached 95%, and a phone's
 * signed Face ID answer to an approval got this 507 three times, never reaching the Mac, while
 * the Mac had room. The forward registers which writes it takes (deferDiskGuardTo), and applies
 * this same refusal itself whenever it answers one here instead (refuseWhenDiskFull).
 */

import type { Request, Response, NextFunction } from 'express';
import { isDiskWriteBlocked, getDiskWatermarkState } from '../../core/disk-watermark.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mount-relative path prefixes exempt from the block (see header). */
const EXEMPT_PREFIXES = [
  '/browser-logs', '/v1/client-logs', '/notifications', '/system', '/config/test-connection',
  '/files/delete',
];

/** Mount-relative routes exempt by shape (see header): a host command run or stop. */
const EXEMPT_ROUTES = [
  /^\/v1\/hosts\/[^/]+\/exec\/?$/,
  /^\/v1\/hosts\/[^/]+\/exec\/[^/]+\/stop\/?$/,
  /^\/v1\/host-exec\/grants\/[^/]+\/exec\/?$/,
];

/** Which writes the forward takes to the Mac (it guards the ones it answers here); null: none. */
let forwardTakes: ((req: Request) => boolean) | null = null;

/** The companion's v1-forward names the writes it carries to the Mac (server.ts, bootPolicy 'v1-forward'). */
export function deferDiskGuardTo(takes: ((req: Request) => boolean) | null): void {
  forwardTakes = takes;
}

/** Sends the 507 and returns true when this write would land on a critically full disk here. */
export function refuseWhenDiskFull(req: Request, res: Response): boolean {
  if (!MUTATING_METHODS.has(req.method.toUpperCase()) || !isDiskWriteBlocked()) return false;
  const rel = (req.originalUrl.split('?')[0] ?? '').replace(/^\/api(?=\/)/, '');
  if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p)) || EXEMPT_ROUTES.some((r) => r.test(rel))) return false;
  sendDiskFull(res);
  return true;
}

export function diskGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method) || !isDiskWriteBlocked()) {
    next();
    return;
  }
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p)) || EXEMPT_ROUTES.some((r) => r.test(req.path))) {
    next();
    return;
  }
  // Carried to the Mac, it writes nothing here; answered here instead, the forward refuses it.
  if (forwardTakes?.(req)) {
    next();
    return;
  }
  sendDiskFull(res);
}

function sendDiskFull(res: Response): void {
  const { usedPct } = getDiskWatermarkState();
  res.status(507).json({
    error: `Data disk is critically full (${usedPct}% used) — writes are paused to protect data integrity. `
      + 'Free disk space on the server, then retry.',
    code: 'disk_full',
    usedPct,
  });
}
