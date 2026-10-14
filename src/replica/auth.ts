/**
 * Who may call a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 1, auth).
 *
 * A host replica holds no pairings of its own: the Mac sends it the hash of
 * each phone's and browser's token (the device copy, host-server/device-copy.ts,
 * through the leader door). So a Bearer token is good here when, and only when,
 * it hashes to a row of that copy. Nothing else counts: no loopback waiver (every
 * port is a tunnel port, local-trust.ts), no config.yaml API key, no machine
 * token (the copy never holds one), no first-boot claim. `GET /api/v1/instance`
 * stays public and answers the Mac's walnutId (device-store.ts getInstanceId).
 */

import path from 'node:path'
import type { Request, Response, NextFunction } from 'express'
import { WALNUT_HOME } from '../constants.js'
import { createDeviceCopy, type DeviceCopy } from '../host-server/device-copy.js'
import { log } from '../logging/index.js'

let copy: DeviceCopy | null = null

/** The device copy file of this replica's data dir (the same file the host server keeps). */
export function replicaDeviceCopyFile(home: string = WALNUT_HOME): string {
  return path.join(home, 'replica', 'devices.json')
}

/** The one device copy of this process: the leader door writes it, the auth reads it. */
export function replicaDeviceCopy(): DeviceCopy {
  copy ??= createDeviceCopy(replicaDeviceCopyFile())
  return copy
}

export function _resetReplicaAuthForTesting(): void {
  copy = null
}

/** The device a Bearer token belongs to on a host replica, or null. */
export function verifyReplicaToken(token: string): { name: string; kind: 'device' } | null {
  const name = replicaDeviceCopy().verify(token)
  return name ? { name, kind: 'device' } : null
}

// GETs (relative to the /api mount) that stay public: which box this is.
const PUBLIC_GET_PATHS = new Set(['/v1/instance'])

/**
 * The one failure bucket of a host replica. Every caller reaches it through
 * the tunnel over loopback, so neither the socket address (the same for all)
 * nor X-Forwarded-For (whatever the caller wrote, when the tunnel adds none)
 * tells callers apart: keyed on either, a stranger could dodge the limit or
 * lock the user's phone out. So wrong tokens share one bucket, and a token in
 * the device copy is checked first and never refused for anyone's failures.
 */
export const REPLICA_FAILURE_KEY = 'host-replica'

/** A wrong token: 429 once the bucket is full, else counted and 401. */
async function refuseWrongToken(): Promise<401 | 429> {
  const { isAuthRateLimited, recordAuthFailure } = await import('../web/middleware/auth-rate-limit.js')
  if (isAuthRateLimited(REPLICA_FAILURE_KEY)) return 429
  recordAuthFailure(REPLICA_FAILURE_KEY)
  return 401
}

/** The /ws upgrade of a host replica: the same rule as its /api auth. */
export async function verifyReplicaUpgrade(token: string): Promise<'ok' | 401 | 429> {
  if (verifyReplicaToken(token)) return 'ok'
  const status = await refuseWrongToken()
  log.ws.warn('replica ws upgrade refused: token not in the device copy', { status })
  return status
}

/**
 * The /api auth of a host replica. Only a wrong token counts toward the
 * limit; an absent one is a browser's normal first contact, and a good one
 * always passes.
 */
export async function replicaAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === 'GET' && PUBLIC_GET_PATHS.has(req.path)) { next(); return }
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Pair this device on your Mac and send Authorization: Bearer <token>', code: 'not_paired' })
    return
  }
  const cred = verifyReplicaToken(header.slice(7))
  if (!cred) {
    const status = await refuseWrongToken()
    log.web.warn('replica auth: token not in the device copy', { status, deviceCopy: replicaDeviceCopy().hash() })
    if (status === 429) res.status(429).json({ error: 'Too many authentication failures. Try again later.' })
    else res.status(401).json({ error: 'Invalid or revoked token', code: 'token_refused' })
    return
  }
  ;(req as Request & { apiKeyName?: string; deviceName?: string }).apiKeyName = cred.name
  ;(req as Request & { deviceName?: string }).deviceName = cred.name
  next()
}
