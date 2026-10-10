/**
 * Send-time check: a push row whose device is no longer paired here is never sent.
 *
 * Revoking a device removes its rows (device-auth.ts `revokePairing`), but a row
 * can outlive its pairing in ways no revoke path sees: a revoke on a replica
 * whose relay to this box failed, a `walnut device revoke` racing another config
 * write, an auth.json restored from an older copy, a hand edit. Every such row
 * is a phone that can no longer log in and still gets letter subjects on its
 * lock screen, so the sender checks each row again right before it sends.
 *
 * A row is judged only when this box can judge it:
 *  - origin `local` (registered here). A `relay` row was paired on the
 *    companion, whose pairings this box does not hold; its revoke relays here
 *    (device-revoke.ts).
 *  - a real device name. The anonymous trusted-LAN placeholder and a row with no
 *    name belong to no pairing, so there is nothing to revoke.
 * Paired means a device record in auth.json or an API key in config.yaml, the
 * two credentials whose name a registration carries (web/routes/push.ts
 * `deviceOf`). When auth.json cannot be read, its sidecar (auth.json.bak)
 * judges instead, but a row it finds unpaired is only held back, never
 * deleted: the sidecar can lag the real file, and a phone paired since would
 * lose its row. When neither file can be read, or config.yaml cannot be (its
 * API keys are unknown then, and getConfig would answer "none"), nothing is
 * judged: a broken read must never silence, or prune, every phone at once.
 *
 * Cost: one async read of auth.json and one of config.yaml per push, and only
 * when some row is judgeable. Pushes are letters, a few an hour.
 */

import { readStoredConfig, updatePushTokens } from '../config-manager.js'
import { readPairedDevices } from '../device-auth.js'
import { log } from '../../logging/index.js'
import type { PushTokenEntry } from '../types.js'
import { ANON_DEVICE_KEY_NAME, parsePushOrigin } from './registry.js'
import { tokenTag } from './send.js'

export interface PairingPartition {
  /** Rows to send to. */
  live: PushTokenEntry[]
  /** Rows of a device that is no longer paired: not sent. */
  unpaired: PushTokenEntry[]
  /** `unpaired` may be deleted: judged from auth.json itself, not its sidecar. */
  prune: boolean
}

const UNJUDGED_WARN_EVERY_MS = 10 * 60_000
let lastUnjudgedWarnAt = 0
let lastBackupWarnAt = 0

function judgeable(entry: PushTokenEntry): entry is PushTokenEntry & { key_name: string } {
  return parsePushOrigin(entry.origin) === 'local'
    && typeof entry.key_name === 'string'
    && entry.key_name.length > 0
    && entry.key_name !== ANON_DEVICE_KEY_NAME
}

export async function partitionByPairing(entries: PushTokenEntry[]): Promise<PairingPartition> {
  if (!entries.some(judgeable)) return { live: entries, unpaired: [], prune: false }
  let devices: Awaited<ReturnType<typeof readPairedDevices>> = null
  let apiKeys: Set<string> | null = null
  try {
    devices = await readPairedDevices()
    const stored = await readStoredConfig()
    if (stored) apiKeys = new Set((stored.api_keys ?? []).map((k) => k.name))
  } catch { /* judge nothing, below */ }
  const now = Date.now()
  if (!devices || !apiKeys) {
    if (now - lastUnjudgedWarnAt >= UNJUDGED_WARN_EVERY_MS) {
      lastUnjudgedWarnAt = now
      log.notif.warn('push: device registry unreadable, sending without the paired-device check', {
        authReadable: !!devices, configReadable: !!apiKeys,
      })
    }
    return { live: entries, unpaired: [], prune: false }
  }
  if (devices.from === 'backup' && now - lastBackupWarnAt >= UNJUDGED_WARN_EVERY_MS) {
    lastBackupWarnAt = now
    log.notif.warn('push: auth.json unreadable, judging rows by auth.json.bak (rows it finds unpaired are held back, not removed)')
  }
  const live: PushTokenEntry[] = []
  const unpaired: PushTokenEntry[] = []
  for (const entry of entries) {
    if (judgeable(entry) && !devices.names.has(entry.key_name) && !apiKeys.has(entry.key_name)) unpaired.push(entry)
    else live.push(entry)
  }
  return { live, unpaired, prune: devices.from === 'auth' }
}

/**
 * Remove the unpaired rows found at send time. Each is matched by token, name
 * and `registered_at`, so a phone that re-paired and registered again in the
 * meantime (a new `registered_at`) keeps its fresh row.
 */
export async function pruneUnpairedRows(rows: PushTokenEntry[]): Promise<void> {
  if (rows.length === 0) return
  const key = (t: PushTokenEntry): string => `${t.token}\u0000${t.key_name ?? ''}\u0000${t.registered_at ?? ''}`
  const stale = new Set(rows.map(key))
  try {
    let removed = 0
    await updatePushTokens((tokens) => {
      const keep = tokens.filter((t) => !(parsePushOrigin(t.origin) === 'local' && stale.has(key(t))))
      removed = tokens.length - keep.length
      return removed === 0 ? null : keep
    })
    if (removed > 0) {
      log.notif.warn('push: removed rows of devices that are no longer paired', {
        removed, tokenTags: rows.map((r) => tokenTag(r.token)),
      })
    }
  } catch (err) {
    log.notif.warn('push: could not remove rows of unpaired devices (they stay unsent)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
