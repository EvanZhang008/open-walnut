/**
 * What the monitor keeps about addresses and networks: as little as the
 * classifier needs, which is "did it change". The public IP and the bridge
 * host's DNS answer become a keyed fingerprint (HMAC-SHA256 under a per-install
 * key, cut to 4 hex digits): enough to see a change, useless for finding out
 * the address (65536 values, and 2^16 addresses share each one). Wi-Fi names
 * and BSSIDs are dropped at parse time (parse-net.mjs) and never reach here.
 *
 * scrubRecord / scrubState remove what older versions wrote, in place.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_RECORD_KEYS, daemonMsg, hostKind } from './parse-bridge.mjs'

// 1: addresses and Wi-Fi names. 2: also the Wi-Fi key names older versions
// listed in a net record's `changed` (no value, but no trace either).
// 3: daemon records down to the parser's allowlist (older versions copied
// every field, a session id and a working directory included), their message
// text down to its fixed name, and SSH host aliases down to local or remote.
export const SCRUB_VERSION = 3
const KEY_FILE = 'privacy.key'
const WIFI_KEYS = ['wifiSsid', 'wifiBssid']

/** The per-install key: 32 random bytes in `<stateDir>/privacy.key` (0600), made on first use. */
export function loadKey(stateDir) {
  const file = path.join(stateDir, KEY_FILE)
  try {
    const hex = fs.readFileSync(file, 'utf-8').trim()
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  } catch { /* first run */ }
  const key = crypto.randomBytes(32)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  return key
}

/** 4 hex digits of HMAC-SHA256(key, value); null for no value. */
export function fingerprint(key, value) {
  if (value == null || value === '') return null
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 4)
}

/**
 * One record without the fields older versions stored. Returns the record
 * (a copy when anything went) and the names of what was removed.
 */
export function scrubRecord(rec, key) {
  const removed = []
  let out = rec
  const drop = (field) => {
    if (out[field] === undefined) return
    if (out === rec) out = { ...rec }
    delete out[field]
    removed.push(`${rec.kind}.${field}`)
  }
  if (rec.kind === 'pubip') drop('ip')
  if (rec.kind === 'net') {
    for (const k of WIFI_KEYS) drop(k)
    if (Array.isArray(rec.changed) && rec.changed.some((k) => WIFI_KEYS.includes(k))) {
      if (out === rec) out = { ...rec }
      for (const k of WIFI_KEYS) if (rec.changed.includes(k)) removed.push(`net.changed.${k}`)
      out.changed = rec.changed.filter((k) => !WIFI_KEYS.includes(k))
    }
  }
  if (rec.kind === 'wifi') drop('network')
  if (rec.kind === 'daemon') {
    for (const k of Object.keys(rec)) if (!DAEMON_RECORD_KEYS.includes(k)) drop(k)
    const msg = daemonMsg(rec.ev, rec.msg)
    if (rec.msg !== undefined && rec.msg !== msg) {
      if (out === rec) out = { ...rec }
      out.msg = msg
      removed.push('daemon.msg text')
    }
  }
  if (rec.kind === 'server' && rec.host != null && hostKind(rec.host) !== rec.host) {
    if (out === rec) out = { ...rec }
    out.host = hostKind(rec.host)
    removed.push('server.host alias')
  }
  if (rec.kind === 'dns' && Array.isArray(rec.addrs)) {
    const addrs = rec.addrs
    drop('addrs')
    out.count = addrs.length
    out.fp = key ? fingerprint(key, [...addrs].sort().join(',')) : null
  }
  return { rec: out, removed }
}

/** The collector state without stored addresses or network names (mutates). */
export function scrubState(state, key) {
  const removed = []
  for (const n of Array.isArray(state?.recentNet) ? state.recentNet : []) {
    if (!Array.isArray(n?.changed) || !n.changed.some((k) => WIFI_KEYS.includes(k))) continue
    n.changed = n.changed.filter((k) => !WIFI_KEYS.includes(k))
    if (!removed.includes('recentNet.changed')) removed.push('recentNet.changed')
  }
  // The live-alert buffers hold daemon and server records too.
  const cleaned = (list, name) => {
    let n = 0
    const next = list.map((r) => { const x = scrubRecord({ kind: name, ...r }, null); if (x.removed.length) n++; return x.removed.length ? x.rec : r })
    return { next, n }
  }
  for (const [field, kind] of [['recent', 'daemon'], ['recentServer', 'server']]) {
    if (!Array.isArray(state?.[field])) continue
    const { next, n } = cleaned(state[field], kind)
    if (n) { state[field] = next; removed.push(`${field} (${n})`) }
  }
  const last = state?.last
  if (!last) return removed
  if (last.pubip && last.pubip.ip !== undefined) {
    last.pubip = { fp: key ? fingerprint(key, last.pubip.ip) : null, ms: last.pubip.ms ?? null, ...(last.pubip.error ? { error: last.pubip.error } : {}) }
    removed.push('last.pubip.ip')
  }
  for (const k of WIFI_KEYS) if (last.net && last.net[k] !== undefined) { delete last.net[k]; removed.push(`last.net.${k}`) }
  if (last.radio && last.radio.network !== undefined) { delete last.radio.network; removed.push('last.radio.network') }
  if (last.dnsAddrs !== undefined) {
    last.dnsFp = key ? fingerprint(key, [...(last.dnsAddrs ?? [])].sort().join(',')) : null
    delete last.dnsAddrs
    removed.push('last.dnsAddrs')
  }
  if (last.egressTo !== undefined) { delete last.egressTo; removed.push('last.egressTo') }
  return removed
}

/**
 * Rewrite one NDJSON file without the removed fields (atomic: temp file +
 * rename). A file with nothing to remove is left untouched. Adds to `totals`.
 */
export async function scrubFile(file, key, totals = { files: 0, records: 0, fields: {} }) {
  const text = await fsp.readFile(file, 'utf-8')
  let touched = 0
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line
    let rec
    try { rec = JSON.parse(line) } catch { return line }
    const { rec: next, removed } = scrubRecord(rec, key)
    if (!removed.length) return line
    touched++
    for (const f of removed) totals.fields[f] = (totals.fields[f] ?? 0) + 1
    return JSON.stringify(next)
  })
  if (!touched) return totals
  const tmp = `${file}.scrub-tmp`
  await fsp.writeFile(tmp, lines.join('\n'), { mode: 0o600 })
  await fsp.rename(tmp, file)
  totals.files++
  totals.records += touched
  return totals
}

/** scrubFile for every `*.ndjson` in `dir`. Returns {files, records, fields: {name: count}}. */
export async function scrubStoreDir(dir, key, totals = { files: 0, records: 0, fields: {} }) {
  let names = []
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.ndjson')) } catch { return totals }
  for (const name of names.sort()) await scrubFile(path.join(dir, name), key, totals)
  return totals
}
