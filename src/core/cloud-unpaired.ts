/**
 * "This Mac unpaired itself from the cloud companion", remembered on this Mac.
 *
 * Unpairing this Mac (Settings, Phones & Cloud) revokes, on the companion, the
 * token the data repo's cloud remote carries. The remote itself stays: removing
 * it is the operator's call, as the setup wizard already says. Without a record,
 * every surface kept reading that remote as a live pairing: Cloud Companion said
 * "Connected", the Pairing target still offered Cloud, and the device list turned
 * the companion's 401 into a red, hedged "may have been unpaired".
 *
 * The record names the token it was made for (a fingerprint, never the token):
 * once the remote carries a different token (the Mac was paired again) it no
 * longer applies. It lives in sync/ (git-ignored), so it never reaches the
 * companion. Only a 401 the companion gives right after our own removal writes
 * it (routes/devices.ts): a 401 for any other reason keeps the old warning.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SYNC_DIR } from '../constants.js'

/** The pairing as the routes see it: the companion's origin and this Mac's token there. */
export interface CloudEndpoint { origin: string; token: string }

interface UnpairedRecord {
  origin: string
  /** sha256 of the token this Mac unpaired, first 24 hex chars. */
  tokenFingerprint: string
  at: string
}

/** Said wherever the pairing would otherwise show. */
export const CLOUD_UNPAIRED_SENTENCE = 'This Mac is no longer paired with the cloud companion.'

const recordPath = () => path.join(SYNC_DIR, 'cloud-unpaired.json')

let cached: UnpairedRecord | null | undefined

function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 24)
}

function load(): UnpairedRecord | null {
  if (cached !== undefined) return cached
  try {
    // A few dozen bytes, read once per process; writes update the copy in memory.
    const parsed = JSON.parse(fs.readFileSync(recordPath(), 'utf-8')) as Partial<UnpairedRecord>
    cached = typeof parsed.tokenFingerprint === 'string' && typeof parsed.origin === 'string'
      ? { origin: parsed.origin, tokenFingerprint: parsed.tokenFingerprint, at: String(parsed.at ?? '') }
      : null
  } catch {
    cached = null
  }
  return cached
}

/** True when this Mac unpaired itself from exactly this pairing (same companion, same token). */
export function isCloudUnpaired(endpoint: CloudEndpoint | null): boolean {
  if (!endpoint) return false
  const record = load()
  return record !== null && record.origin === endpoint.origin && record.tokenFingerprint === fingerprint(endpoint.token)
}

/** Remember that this Mac's own pairing is gone. */
export async function markCloudUnpaired(endpoint: CloudEndpoint): Promise<void> {
  const record: UnpairedRecord = { origin: endpoint.origin, tokenFingerprint: fingerprint(endpoint.token), at: new Date().toISOString() }
  await fs.promises.mkdir(SYNC_DIR, { recursive: true })
  await fs.promises.writeFile(recordPath(), JSON.stringify(record), { mode: 0o600 })
  cached = record
}

/** Test seam: forget the copy in memory (the file stays). */
export function resetCloudUnpairedForTest(): void {
  cached = undefined
}
