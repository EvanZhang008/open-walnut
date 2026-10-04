/**
 * Device adoption: one pairing, usable on both boxes.
 *
 * auth.json never syncs, so a phone paired with the Mac holds a token only the
 * Mac knows, and one paired with the cloud companion a token only the companion
 * knows. To let the same phone reach the other box too (the Mac over the LAN or
 * a tailnet, the companion from anywhere), the box it is paired with copies the
 * pairing's HASH into the other box's registry. The token itself never travels.
 *
 * Rules, all inside the auth.json lock:
 *  - a record with the same hash already here: nothing changes (idempotent);
 *  - the name free: a new record, marked `adoptedFrom`;
 *  - the name taken by another pairing: the copy gets the first free `name-2`,
 *    `name-3`, ... (the device-name rule allows no spaces or brackets). An
 *    existing record is never replaced, rotated or renamed;
 *  - never a machine credential, and a phone cannot adopt (the same rule as
 *    pairing a new device: deviceChangeDecision 'create').
 *
 * Revoking works by hash in the other direction: a revoke on one box removes
 * the twin on the other, so "remove this phone" holds everywhere.
 */

import { CLOUD_MODE } from '../constants.js'
import { log } from '../logging/index.js'
import {
  listDeviceRecords, mutateDeviceRecords, revokeDevice, validateDeviceName,
  type DeviceRecord, type DeviceSelfInfo,
} from './device-auth.js'
import {
  LOCAL_ACTOR, deviceChangeDecision, newDeviceId, ownsMachineCredentials, platformFromInfo,
  type DeviceActor, type DevicePlatform,
} from './device-actor.js'

/** A request the adoption rules cannot take as given. */
export class AdoptionError extends Error {
  readonly status = 400
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'AdoptionError'
  }
}

const HASH_RE = /^[0-9a-f]{64}$/
/** The shape newDeviceId() mints. */
const ID_RE = /^d[0-9a-f]{16}$/
/** Same clamp as setDeviceInfo: these strings are another box's, so untrusted here. */
const INFO_FIELD_MAX = 120
const NAME_MAX = 64

export interface AdoptInput {
  name: unknown
  tokenHash: unknown
  id?: unknown
  platform?: unknown
  info?: unknown
  /** Which box the pairing came from. */
  adoptedFrom: 'cloud' | 'primary'
}

export function isTokenHash(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v)
}

function cleanInfo(raw: unknown): DeviceSelfInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim().slice(0, INFO_FIELD_MAX)
    return t || undefined
  }
  const reportedAt = clean(r.reportedAt)
  const info: DeviceSelfInfo = {
    model: clean(r.model),
    os: clean(r.os),
    deviceName: clean(r.deviceName),
    appVersion: clean(r.appVersion),
    ...(reportedAt && !Number.isNaN(Date.parse(reportedAt)) ? { reportedAt } : {}),
  }
  for (const k of Object.keys(info) as Array<keyof DeviceSelfInfo>) if (info[k] === undefined) delete info[k]
  return Object.keys(info).length > 0 ? info : undefined
}

function cleanPlatform(raw: unknown): DevicePlatform | undefined {
  return raw === 'ios' || raw === 'other' ? raw : undefined
}

/** `name` when free, else the first free `name-N`, kept within the 64-char name rule. */
function freeName(devices: readonly DeviceRecord[], name: string): string {
  const taken = new Set(devices.map((d) => d.name))
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Copy another box's pairing into this registry (see the file comment).
 * `by` = who asks over HTTP; absent = this box itself (a relayed request from
 * the companion, whose caller already authenticated as that very pairing).
 * Throws AdoptionError on bad input, DeviceChangeRefused when `by` may not.
 */
export async function adoptDeviceRecord(
  input: AdoptInput,
  opts: { by?: DeviceActor } = {},
): Promise<{ name: string; adopted: boolean }> {
  if (!isTokenHash(input.tokenHash)) throw new AdoptionError('token_hash must be 64 lowercase hex characters')
  const tokenHash = input.tokenHash
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  try {
    validateDeviceName(name)
  } catch (err) {
    throw new AdoptionError(err instanceof Error ? err.message : String(err))
  }
  const info = cleanInfo(input.info)
  // The source's platform, else what its report says: a phone stays a phone here.
  const platform = cleanPlatform(input.platform) ?? platformFromInfo(info)

  const out = await mutateDeviceRecords((devices) => {
    if (opts.by) {
      const decision = deviceChangeDecision(devices, opts.by, 'create', name, CLOUD_MODE)
      if (!decision.ok) throw decision.refusal
    }
    const existing = devices.find((d) => d.tokenHash === tokenHash)
    if (existing) return { result: { name: existing.name, adopted: false } }
    const finalName = freeName(devices, name)
    // Keep the source's id only while no record here uses it as its own or as
    // an owner: ownership of machine credentials is keyed by id.
    const wanted = typeof input.id === 'string' && ID_RE.test(input.id) ? input.id : undefined
    const idFree = wanted !== undefined && !devices.some((d) => d.id === wanted || d.ownerId === wanted)
    const record: DeviceRecord = {
      name: finalName,
      id: idFree ? wanted : newDeviceId(),
      tokenHash,
      createdAt: new Date().toISOString(),
      ...(platform ? { platform } : {}),
      ...(info ? { info } : {}),
      adoptedFrom: input.adoptedFrom,
    }
    return { devices: [...devices, record], result: { name: finalName, adopted: true } }
  })
  if (out.adopted) {
    log.web.info('device-adoption: pairing adopted', { name: out.name, requested: name, from: input.adoptedFrom, platform: platform ?? null })
  }
  return out
}

/**
 * Revoke the pairing whose token hashes to `tokenHash`, the way any revoke
 * does (revokeDevice: its listeners run). Never a machine credential, and
 * never the pairing that owns them (on a companion that is the Mac itself:
 * removing it would cut the Mac's git sync and bridge). Returns the revoked
 * name, or null when no such pairing is here (already gone counts as done).
 */
export async function revokeAdoptedByHash(tokenHash: unknown): Promise<string | null> {
  if (!isTokenHash(tokenHash)) throw new AdoptionError('token_hash must be 64 lowercase hex characters')
  const devices = await listDeviceRecords()
  const record = devices.find((d) => d.tokenHash === tokenHash)
  if (!record || record.kind === 'machine' || ownsMachineCredentials(devices, record)) return null
  // Hash-guarded: a re-pairing of the same name in between is a different pairing.
  const removed = await revokeDevice(record.name, { by: LOCAL_ACTOR, tokenHash })
  if (removed) log.web.info('device-adoption: twin pairing revoked', { name: record.name, adoptedFrom: record.adoptedFrom ?? null })
  return removed ? record.name : null
}
