/**
 * A host server's copy of the leader's signed-in devices
 * (docs/plan/walnut-servers-everywhere.md, "Host server, leader away").
 *
 * While the Mac answers, every browser request rides to it and the Mac checks
 * the device token. While nobody answers, this server answers some requests
 * itself (alone-api.ts), so it must check the same tokens: the Mac sends the
 * HASH of each device's token (core/replication/device-replica.ts, kind
 * 'devices' on /bridge/replica), never a token. A device removed on the Mac
 * leaves this copy on the Mac's next round; one removed while the Mac is away
 * keeps working here until the Mac is back, as on the companion.
 *
 * Machine credentials are never in it: the Mac sends phones and browsers only.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HASH_RE = /^[0-9a-f]{64}$/
const NAME_MAX = 64
const MAX_DEVICES = 500

/**
 * `id` is the device's record id on the Mac (stable across its own rotations,
 * device-store.ts), sent by newer Macs; a row from an older Mac has none. The
 * list hash stays over `name:tokenHash`, so an older host server and a newer
 * Mac still agree on it.
 */
export interface DeviceCopyEntry { name: string; tokenHash: string; id?: string }

const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/

/** Whether `id` is a record id this copy keeps (the Mac sends only these, device-replica.ts). */
export function isDeviceCopyId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export interface DeviceCopy {
  /** A step of the Mac's round: `{op:'put', kind:'devices', devices, hash}`. */
  put(body: Record<string, unknown>): { ok: true; hash: string; devices: number } | { ok: false; status: 400; error: string }
  /** The device a Bearer token belongs to, or null. Constant time over the list. */
  verify(token: string): string | null
  /** The same, with the device's record id when the Mac sent one. */
  verifyDevice(token: string): { name: string; id: string | null } | null
  /** Whether the Mac ever sent one: without it no token can be checked here. */
  held(): boolean
  hash(): string | null
  /**
   * A device revoked on this host while the Mac is away (replica/away-writes.ts,
   * section 7): its row goes at once, and its token stays refused through every
   * later list the Mac sends until one no longer names it (the Mac applied the
   * revoke). False: no row of that id.
   */
  revoke(id: string): boolean
  /**
   * Whether the Mac's last list (in this process) still names the device of `id`, or
   * no list came since this process started (unknown counts as named): a revoke made
   * here is applied on the Mac once a later list no longer names it.
   */
  namedByMac(id: string): boolean
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

function listHash(devices: DeviceCopyEntry[]): string {
  return sha256Hex(devices.map((d) => `${d.name}:${d.tokenHash}`).sort().join('\n')).slice(0, 16)
}

function clean(raw: unknown): DeviceCopyEntry[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_DEVICES) return null
  const out: DeviceCopyEntry[] = []
  for (const d of raw) {
    const r = d as { name?: unknown; tokenHash?: unknown; id?: unknown } | null
    if (!r || typeof r.name !== 'string' || !r.name || r.name.length > NAME_MAX) return null
    if (typeof r.tokenHash !== 'string' || !HASH_RE.test(r.tokenHash)) return null
    // A bad id (a hand-edited or older auth.json on the Mac) drops from its row
    // only: refusing the list for it would stop every revoke reaching this copy.
    out.push(isDeviceCopyId(r.id) ? { id: r.id, name: r.name, tokenHash: r.tokenHash } : { name: r.name, tokenHash: r.tokenHash })
  }
  return out
}

export function createDeviceCopy(file: string): DeviceCopy {
  let devices: DeviceCopyEntry[] | null = null
  let hash: string | null = null
  // What is on disk, ids included: a list the Mac resends with ids it did not
  // send before is written although its hash is the same.
  let stored = ''
  // Token hashes revoked here and still named by the Mac's last list (none on a host server).
  let revoked: string[] = []
  // The ids the Mac's last list named (null: no list since this process started).
  let lastSentIds: Set<string> | null = null
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: unknown; revoked?: unknown }
    const list = clean(onDisk.devices)
    if (list) { devices = list; hash = listHash(list); stored = JSON.stringify(list) }
    if (Array.isArray(onDisk.revoked)) revoked = onDisk.revoked.filter((h): h is string => typeof h === 'string' && HASH_RE.test(h))
  } catch { /* none yet: the Mac's first round brings it */ }

  function write(list: DeviceCopyEntry[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: new Date().toISOString(), devices: list, ...(revoked.length ? { revoked } : {}) }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function verifyDevice(token: string): { name: string; id: string | null } | null {
    if (!devices || typeof token !== 'string' || !token) return null
    const candidate = Buffer.from(sha256Hex(token), 'hex')
    let matched: DeviceCopyEntry | null = null
    for (const d of devices) {
      if (crypto.timingSafeEqual(candidate, Buffer.from(d.tokenHash, 'hex'))) matched = d
    }
    return matched ? { name: matched.name, id: matched.id ?? null } : null
  }

  return {
    put(body) {
      const sent = clean(body.devices)
      if (!sent) return { ok: false, status: 400, error: 'devices must be a list of {name, tokenHash}' }
      lastSentIds = new Set(sent.map((d) => d.id).filter((x): x is string => typeof x === 'string'))
      // A revoke made here holds until the Mac's list drops that token (it applied the revoke).
      const before = revoked.length
      revoked = revoked.filter((h) => sent.some((d) => d.tokenHash === h))
      const list = revoked.length ? sent.filter((d) => !revoked.includes(d.tokenHash)) : sent
      if (revoked.length !== before) stored = ''
      const next = listHash(list)
      const content = JSON.stringify(list)
      if (next !== hash || content !== stored) {
        write(list)
        devices = list
        hash = next
        stored = content
      }
      return { ok: true, hash: next, devices: list.length }
    },
    verify(token) {
      return verifyDevice(token)?.name ?? null
    },
    verifyDevice,
    held: () => devices !== null,
    hash: () => hash,
    namedByMac: (id) => lastSentIds === null || lastSentIds.has(id),
    revoke(id) {
      const row = devices?.find((d) => d.id === id)
      if (!devices || !row) return false
      if (!revoked.includes(row.tokenHash)) revoked = [...revoked, row.tokenHash]
      const list = devices.filter((d) => d !== row)
      write(list)
      devices = list
      hash = listHash(list)
      stored = JSON.stringify(list)
      return true
    },
  }
}
