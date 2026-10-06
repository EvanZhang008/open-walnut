/**
 * Who may reach Apple Health data on the primary (Mac).
 *
 * The global /api auth (auth.ts) waives a credential only for this machine and
 * lets any caller with a device token or an API key through. Health is narrower:
 * the phone contract (/api/v1/health/*) is for this Mac and a paired phone's
 * DEVICE token only (an API key is a script's credential and has no business
 * reading or deleting the store; a daemon's machine token is refused by auth.ts
 * before any route), and the internal agent reads (/api/health/*: nights, days,
 * series) are for agents on this machine only. A device token is not enough
 * there: a paired phone has no use for them, and a leaked token must not turn
 * into a remote read of every night on record.
 *
 * "This machine" is the request's ORIGIN (request-origin.ts), not only its
 * socket. The server calls itself over loopback on behalf of callers that are
 * NOT here (a remote host's `walnut tools call api`, an action card from a paired
 * phone, the cloud bridge), and every such self-call says so in x-walnut-origin.
 * Trusting the loopback socket alone let a remote host read the store and delete
 * it (2026-09 gate). So:
 *
 *   /api/health/*     only a caller whose origin is this Mac (requireThisMachine)
 *   /api/v1/health/*  this Mac, or a request carrying a paired device token, and
 *                     never a self-call made for someone off this Mac
 *                     (requirePhoneOrThisMachine)
 *
 * On a cloud replica the internal reads answer 501 (nothing is stored there), so
 * requireThisMachine steps aside there; the phone contract still takes a device
 * token only (cloud auth has no local waiver).
 *
 * Places (the visits the iPhone records, src/core/places/) takes the same two
 * guards with its own messages.
 */

import type { Request, Response, NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { HEALTH_LOCAL_ONLY_MESSAGE, LOCAL_ORIGIN } from '../../lib/caller-origin.js'

/** The refusal an API key (or any credential that is not a device token) gets on the phone contract. */
export const HEALTH_DEVICE_ONLY_MESSAGE =
  "Apple Health accepts only this Mac and a paired phone's device token. An API key cannot read or change it."

import { classifyLocalRequest } from './local-trust.js'
import { isOnBehalfOfRemote, requestOrigin } from './request-origin.js'

/**
 * A guard for internal reads: a caller on this Mac only, whatever credential it
 * holds. `area` names the store in the log; `message` is the refusal.
 */
export function thisMachineGuard(area: string, message: string) {
  return function requireThisMachine(req: Request, res: Response, next: NextFunction): void {
    if (CLOUD_MODE) { next(); return }
    const origin = requestOrigin(req)
    if (origin === LOCAL_ORIGIN) { next(); return }
    const trust = classifyLocalRequest(req)
    log.web.warn(`${area} request refused: not this Mac`, { path: req.path, reason: trust.trusted ? 'on-behalf-of' : trust.reason, origin })
    res.status(403).json({ error: 'forbidden', message })
  }
}

/**
 * A guard for a phone contract: this Mac, or a paired device token (auth.ts sets
 * `deviceName` only for one), and never a loopback self-call made for a caller
 * off this Mac. Refusals use the v1 error shape (docs/reference/api-v1.md).
 */
export function phoneOrThisMachineGuard(area: string, localOnlyMessage: string, deviceOnlyMessage: string) {
  const refuseV1 = (req: Request, res: Response, reason: string, message: string): void => {
    log.web.warn(`v1 ${area} request refused`, { path: req.path, reason, origin: requestOrigin(req) })
    res.status(403).json({ error: { code: 'forbidden', message } })
  }
  return function requirePhoneOrThisMachine(req: Request, res: Response, next: NextFunction): void {
    if (isOnBehalfOfRemote(req)) { refuseV1(req, res, 'on-behalf-of', localOnlyMessage); return }
    if (!CLOUD_MODE && classifyLocalRequest(req).trusted) { next(); return }
    if ((req as Request & { deviceName?: string }).deviceName) { next(); return }
    refuseV1(req, res, 'not-a-device-token', deviceOnlyMessage)
  }
}

/** Guard for /api/health/*. */
export const requireThisMachine = thisMachineGuard('health', HEALTH_LOCAL_ONLY_MESSAGE)

/** Guard for /api/v1/health/*. */
export const requirePhoneOrThisMachine = phoneOrThisMachineGuard('health', HEALTH_LOCAL_ONLY_MESSAGE, HEALTH_DEVICE_ONLY_MESSAGE)
