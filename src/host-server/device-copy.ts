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

export interface DeviceCopyEntry { name: string; tokenHash: string }

export interface DeviceCopy {
  /** A step of the Mac's round: `{op:'put', kind:'devices', devices, hash}`. */
  put(body: Record<string, unknown>): { ok: true; hash: string; devices: number } | { ok: false; status: 400; error: string }
  /** The device a Bearer token belongs to, or null. Constant time over the list. */
  verify(token: string): string | null
  /** Whether the Mac ever sent one: without it no token can be checked here. */
  held(): boolean
  hash(): string | null
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
    const r = d as { name?: unknown; tokenHash?: unknown } | null
    if (!r || typeof r.name !== 'string' || !r.name || r.name.length > NAME_MAX) return null
    if (typeof r.tokenHash !== 'string' || !HASH_RE.test(r.tokenHash)) return null
    out.push({ name: r.name, tokenHash: r.tokenHash })
  }
  return out
}

export function createDeviceCopy(file: string): DeviceCopy {
  let devices: DeviceCopyEntry[] | null = null
  let hash: string | null = null
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: unknown }
    const list = clean(stored.devices)
    if (list) { devices = list; hash = listHash(list) }
  } catch { /* none yet: the Mac's first round brings it */ }

  function write(list: DeviceCopyEntry[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: new Date().toISOString(), devices: list }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  return {
    put(body) {
      const list = clean(body.devices)
      if (!list) return { ok: false, status: 400, error: 'devices must be a list of {name, tokenHash}' }
      const next = listHash(list)
      if (next !== hash) {
        write(list)
        devices = list
        hash = next
      }
      return { ok: true, hash: next, devices: list.length }
    },
    verify(token) {
      if (!devices || typeof token !== 'string' || !token) return null
      const candidate = Buffer.from(sha256Hex(token), 'hex')
      let matched: string | null = null
      for (const d of devices) {
        if (crypto.timingSafeEqual(candidate, Buffer.from(d.tokenHash, 'hex'))) matched = d.name
      }
      return matched
    },
    held: () => devices !== null,
    hash: () => hash,
  }
}
