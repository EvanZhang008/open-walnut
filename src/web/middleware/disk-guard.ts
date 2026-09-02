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
 */

import type { Request, Response, NextFunction } from 'express';
import { isDiskWriteBlocked, getDiskWatermarkState } from '../../core/disk-watermark.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mount-relative path prefixes exempt from the block (see header). */
const EXEMPT_PREFIXES = [
  '/browser-logs', '/v1/client-logs', '/notifications', '/system', '/config/test-connection',
  '/files/delete',
];

export function diskGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method) || !isDiskWriteBlocked()) {
    next();
    return;
  }
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  const { usedPct } = getDiskWatermarkState();
  res.status(507).json({
    error: `Data disk is critically full (${usedPct}% used) — writes are paused to protect data integrity. `
      + 'Free disk space on the server, then retry.',
    code: 'disk_full',
    usedPct,
  });
}
