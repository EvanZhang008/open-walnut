/**
 * Device-token authentication for cloud mode.
 *
 * auth.json (<OPEN_WALNUT_HOME>/auth.json, mode 0600) holds a device list with
 * SHA-256 hashes of 128-bit random Bearer tokens. Plaintext tokens are shown
 * exactly once (CLI `walnut device add` output / first-boot setup banner) and
 * are never persisted or logged anywhere else.
 *
 * First-boot claim flow (Home Assistant/Gitea pattern): while auth.json has
 * ZERO devices, a one-time setup token (15-min validity, regenerated on
 * restart/expiry) is printed to stdout. POST /api/v1/setup/claim exchanges it
 * for the first device token, after which the claim path closes permanently.
 *
 * IMPORTANT: auth.json must NEVER enter the OPEN_WALNUT_HOME git-sync repo —
 * see CRITICAL_IGNORES in src/integrations/git-sync.ts.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { withFileLock } from '../utils/file-lock.js'
import { log } from '../logging/index.js'
import { CLOUD_MODE } from '../constants.js'
import {
  DeviceChangeRefused, LOCAL_ACTOR, deviceChangeDecision, liveOwnerOf, newDeviceId, platformFromInfo,
  type DeviceActor, type DevicePlatform,
} from './device-actor.js'

export interface DeviceRecord {
  name: string
  /**
   * Minted at pairing and never changed: a rotation the device makes itself
   * keeps it, any other re-pairing of the name gets a new one. Ownership of
   * machine credentials is keyed by it, never by the name (device-actor.ts).
   * Records from before it existed get one in their first locked write.
   */
  id?: string
  /** sha256 hex of the plaintext token — the token itself is never stored. */
  tokenHash: string
  createdAt: string
  lastUsedAt?: string
  /**
   * 'machine' = daemon bridge credential: accepted ONLY for the /bridge WS
   * upgrade, rejected on every REST route. Absent = normal paired device.
   */
  kind?: 'machine'
  /**
   * What the device is, recorded once: at its first self-report (its claim),
   * or from the report it had when this field was introduced. A later report
   * never changes it, so a phone cannot report its way out of being one.
   */
  platform?: DevicePlatform
  /**
   * Machine credentials only: the `id` of the paired device whose token minted
   * it (the Mac). Only that device may replace or revoke it, and while it holds
   * one no other device may mint any (machine-credentials.ts). Absent on a
   * credential minted before ownership was recorded.
   */
  ownerId?: string
  /**
   * Machine credentials only: which of the companion's tunnel daemons serves
   * it (cloud-tunnel-daemon.ts), kept across the owner's rotations. Absent =
   * the unkeyed daemon, which a credential from before ownership was recorded
   * has always used.
   */
  daemonKey?: string
  /**
   * Owning devices only: the tunnel daemon its machine credentials get when it
   * mints one ({} = the unkeyed one it adopted, `key` = its own). Kept on the
   * device, so a credential revoked and minted again lands on the same daemon.
   */
  tunnelDaemon?: { key?: string }
  /**
   * Self-reported hardware/app identity, refreshed by the client on every
   * launch (POST /api/v1/devices/self). Absent for devices paired before the
   * reporting build shipped — they backfill on their next launch, and the
   * console falls back to the pairing name until then.
   */
  info?: DeviceSelfInfo
  /** Copied here from the other box's registry so the same token works on both (device-adoption.ts). */
  adoptedFrom?: 'cloud' | 'primary'
}

/** What a paired client tells us about itself. All fields optional/untrusted. */
export interface DeviceSelfInfo {
  /** Raw hardware identifier, e.g. 'iPhone17,1' (hw.machine). */
  model?: string
  /** e.g. 'iOS 26.1'. */
  os?: string
  /** Marketing/user-assigned name when the OS grants it, e.g. 'Evan's iPhone'. */
  deviceName?: string
  /** e.g. '1.0 (26)'. */
  appVersion?: string
  /** Server-stamped receipt time (ISO) — never client-supplied. */
  reportedAt?: string
}

interface AuthFile {
  devices: DeviceRecord[]
  /** This box's identity (getInstanceId). Here because auth.json is machine-local and never synced. */
  instanceId?: string
}

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/
const keptInstanceId = (raw: unknown) => (typeof raw === 'string' && INSTANCE_ID_RE.test(raw) ? { instanceId: raw } : {})

/** Public device info — never includes hashes. */
export interface DeviceInfo {
  name: string
  createdAt: string
  lastUsedAt?: string
  /** 'machine' = daemon bridge credential, not a user device (never QR-paired). */
  kind?: 'machine'
  /** Self-reported model/OS/app — absent until the client reports once. */
  info?: DeviceSelfInfo
  /** Set when this row is the other box's pairing, copied here (the console shows it once). */
  adoptedFrom?: 'cloud' | 'primary'
}

const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000
/**
 * A provisioned token (a pairing code burned into the VM's cloud-init) gets a
 * far longer window than a printed one: the operator generated it BEFORE the
 * box existed, and first boot — image pull, npm ci, a full build, Let's Encrypt
 * — routinely outlives 15 minutes.
 */
const PROVISIONED_SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** Persist lastUsedAt at most once per device per this window (avoid write amplification). */
const LAST_USED_WRITE_THROTTLE_MS = 60_000

// Module-level setup-token state. Regenerated on process restart (module reload)
// and on expiry. Only meaningful while the device list is empty.
let setupToken: { token: string; expiresAt: number; provisioned: boolean } | null = null
// Per-device throttle for lastUsedAt disk writes.
const lastUsedWriteAt = new Map<string, number>()

function authFilePath(): string {
  return path.join(WALNUT_HOME, 'auth.json')
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex')
}

/** Constant-time compare of two sha256 hex digests. */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== 32 || bufB.length !== 32) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Load auth.json. Missing file → zero devices (normal first boot).
 * Corrupt file → zero devices (claim flow reopens) but log an error so the
 * operator notices — a corrupt file silently locking everyone IN would be
 * worse than requiring a re-pair.
 */
async function loadAuth(): Promise<AuthFile> {
  const file = authFilePath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    // Missing is normal before first pairing — but it is ALSO what a lost
    // auth.json looks like, and the two are indistinguishable here. On
    // 2026-07-26 a merge carrying a remote deletion removed auth.json on both
    // the primary and the cloud box; every device token silently stopped
    // validating and git sync died on a bare 401 for six hours. The sidecar
    // makes that recoverable; git-sync now also keeps auth.json untracked so
    // the deletion cannot reach disk in the first place.
    const recovered = await readAuthBackup()
    if (recovered) {
      log.web.error('auth.json missing — recovered the device registry from auth.json.bak. Every device token would otherwise have stopped validating.', {
        file,
        devices: recovered.devices.length,
      })
      // Put the primary back so the next read is a plain hit.
      try { await saveAuth(recovered) } catch { /* read-only FS / racing writer */ }
      return recovered
    }
    return { devices: [] } // missing with no backup — genuine first boot
  }
  try {
    const parsed = JSON.parse(raw) as AuthFile
    if (!Array.isArray(parsed.devices)) throw new Error('devices is not an array')
    return { ...keptInstanceId(parsed.instanceId), devices: parsed.devices.filter((d) => d && typeof d.name === 'string' && typeof d.tokenHash === 'string') }
  } catch (err) {
    log.web.error('auth.json is corrupt — treating as zero devices (claim flow reopens)', {
      file,
      error: err instanceof Error ? err.message : String(err),
    })
    return { devices: [] }
  }
}

/**
 * Sidecar copy of the device registry, for the same reason config.yaml has one:
 * losing it is unrecoverable from anywhere else and presents as a blanket 401.
 * Gitignored + kept untracked by git-sync's CRITICAL_IGNORES — never synced
 * (each box pairs its own devices).
 */
function authBackupPath(): string {
  return `${authFilePath()}.bak`
}

/** Read the sidecar. Returns null when absent, empty, or unparseable. */
async function readAuthBackup(): Promise<AuthFile | null> {
  try {
    const raw = await fs.readFile(authBackupPath(), 'utf-8')
    const parsed = JSON.parse(raw) as AuthFile
    if (!Array.isArray(parsed.devices)) return null
    const devices = parsed.devices.filter((d) => d && typeof d.name === 'string' && typeof d.tokenHash === 'string')
    return devices.length > 0 ? { ...keptInstanceId(parsed.instanceId), devices } : null
  } catch {
    return null
  }
}

/** Write auth.json atomically with mode 0600, mirroring to the sidecar. */
async function saveAuth(auth: AuthFile): Promise<void> {
  const file = authFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(tmp, file)
  // Mirror AFTER the primary lands, so the sidecar never leads the real file.
  // Never throws: a failed backup must not fail a device pairing.
  try {
    const btmp = `${authBackupPath()}.tmp-${process.pid}`
    await fs.writeFile(btmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(btmp, authBackupPath())
  } catch (err) {
    log.web.warn('failed to update auth.json.bak', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Locked read-modify-write over auth.json. The file is written by BOTH the
 * server process and the `walnut device` CLI (a separate process), so a blind
 * save-after-load can revert the other writer's changes. We keep the bespoke
 * saveAuth (mode 0600 + .bak sidecar) instead of the generic updateJsonFile,
 * but take the same cross-process file lock around the read→mutate→write
 * cycle. `mutate` returns `persist: false` to skip the write (no-op outcome).
 */
async function updateAuth<R>(
  mutate: (auth: AuthFile) => { persist: boolean; result: R } | Promise<{ persist: boolean; result: R }>,
): Promise<R> {
  return withFileLock(authFilePath(), async () => {
    const auth = await loadAuth()
    const normalized = normalizeDevices(auth.devices)
    const { persist, result } = await mutate(auth)
    if (persist || normalized) await saveAuth(auth)
    return result
  })
}

/**
 * Bring records from older builds up to date, in the locked write, before any
 * rule reads them: every record gets an id, a device that reported itself gets
 * the platform that report said (from then on it is fixed), and the name-keyed
 * `owner` of an earlier build is dropped (such a credential counts as one from
 * before ownership, which the Mac adopts again with proof). True = changed.
 */
function normalizeDevices(devices: DeviceRecord[]): boolean {
  let changed = false
  for (const d of devices) {
    if (!d.id) { d.id = newDeviceId(); changed = true }
    if (!d.platform && d.kind !== 'machine') {
      const p = platformFromInfo(d.info)
      if (p) { d.platform = p; changed = true }
    }
    if ('owner' in d) { delete (d as { owner?: unknown }).owner; changed = true }
  }
  return changed
}

export function validateDeviceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error('Invalid device name: use 1-64 chars of letters, digits, dot, dash, underscore')
  }
}

/**
 * Create a new device. Returns the plaintext token ONCE — it is never stored
 * or shown again. 128-bit random → 32 hex chars.
 */
export async function createDevice(
  name: string,
  opts?: { kind?: 'machine'; by?: DeviceActor },
): Promise<{ name: string; token: string; createdAt: string }> {
  validateDeviceName(name)
  return updateAuth((auth) => {
    if (auth.devices.some((d) => d.name === name)) {
      throw new Error(`Device "${name}" already exists`)
    }
    const decision = deviceChangeDecision(auth.devices, opts?.by ?? LOCAL_ACTOR, 'create', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    const { record, token } = freshRecord(name, opts?.kind)
    auth.devices.push(record)
    log.web.info('device-auth: device created', { name, kind: opts?.kind ?? 'device' })
    return { persist: true, result: { name, token, createdAt: record.createdAt } }
  })
}

/** A new pairing's record and its plaintext token (returned once, never stored). */
function freshRecord(name: string, kind?: 'machine'): { record: DeviceRecord; token: string } {
  const token = crypto.randomBytes(16).toString('hex')
  return {
    token,
    record: { name, id: newDeviceId(), tokenHash: sha256Hex(token), createdAt: new Date().toISOString(), ...(kind ? { kind } : {}) },
  }
}

/**
 * "Show a new QR" for `name`: a new token, the old one stops working (its
 * open sockets are told). A device rotating its OWN token stays the same
 * device (id, platform, what it owns). A rotation by anyone else allowed to
 * (the Mac this companion serves, a local caller) is a new pairing of the
 * name: a new id, and whatever the old pairing owned goes as with a revoke.
 * No record yet: a plain pairing.
 */
export async function rotateDevice(
  name: string,
  opts: { by: DeviceActor },
): Promise<{ name: string; token: string; createdAt: string; replaced: boolean }> {
  validateDeviceName(name)
  const out = await updateAuth((auth) => {
    const target = auth.devices.find((d) => d.name === name)
    const decision = deviceChangeDecision(auth.devices, opts.by, target ? 'rotate' : 'create', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    if (target?.kind === 'machine') throw new Error(`Device "${name}" is a machine credential`)
    const fresh = freshRecord(name)
    if (target && decision.by === 'self') {
      target.tokenHash = fresh.record.tokenHash
      delete target.lastUsedAt
      return { persist: true, result: { name, token: fresh.token, createdAt: target.createdAt, replaced: true, gone: [name], by: decision.by } }
    }
    const gone = target ? revokedWith(auth.devices, target) : []
    auth.devices = [...auth.devices.filter((d) => !gone.includes(d)), fresh.record]
    return { persist: true, result: { name, token: fresh.token, createdAt: fresh.record.createdAt, replaced: !!target, gone: gone.map((d) => d.name), by: decision.by } }
  })
  for (const n of out.gone) lastUsedWriteAt.delete(n)
  notifyRevoked(out.gone)
  log.web.info('device-auth: device rotated', { name, by: out.by, replaced: out.replaced, ...(out.gone.length > 1 ? { ownedCredentials: out.gone.filter((n) => n !== name) } : {}) })
  return { name: out.name, token: out.token, createdAt: out.createdAt, replaced: out.replaced }
}

/**
 * The records that go when `target` does: itself, and when it owns machine
 * credentials here, those and the unowned ones from before ownership was
 * recorded (one companion serves one Mac, so they were its too, and leaving
 * them would keep the next Mac out).
 */
function revokedWith(devices: DeviceRecord[], target: DeviceRecord): DeviceRecord[] {
  const owner = target.kind !== 'machine' && devices.some((d) => d.kind === 'machine' && liveOwnerOf(d, devices) === target)
  return devices.filter((d) => d === target
    || (owner && d.kind === 'machine' && (liveOwnerOf(d, devices) === target || liveOwnerOf(d, devices) === undefined)))
}

/**
 * Verify a Bearer token against the device list (constant-time hash compare).
 * On success, updates the device's lastUsedAt — throttled to at most one disk
 * write per device per minute.
 */
export async function verifyDeviceToken(token: string): Promise<{ name: string; kind?: 'machine' } | null> {
  if (!token || typeof token !== 'string') return null
  const auth = await loadAuth()
  const candidateHash = sha256Hex(token)
  // Compare against every device (no early exit) so timing doesn't reveal
  // which position matched.
  let matched: DeviceRecord | null = null
  for (const device of auth.devices) {
    if (hashesEqual(candidateHash, device.tokenHash)) matched = device
  }
  if (!matched) return null

  const now = Date.now()
  const lastWrite = lastUsedWriteAt.get(matched.name) ?? 0
  if (now - lastWrite >= LAST_USED_WRITE_THROTTLE_MS) {
    lastUsedWriteAt.set(matched.name, now)
    const name = matched.name
    // Best-effort — a failed lastUsedAt write must never fail auth. Locked RMW
    // on a FRESH read: persisting the snapshot loaded above could revert a
    // concurrent CLI device add/revoke (auth.json has two writer processes).
    try {
      await updateAuth((fresh) => {
        const device = fresh.devices.find((d) => d.name === name)
        if (!device) return { persist: false, result: undefined }
        device.lastUsedAt = new Date(now).toISOString()
        return { persist: true, result: undefined }
      })
    } catch (err) {
      log.web.warn('device-auth: failed to persist lastUsedAt', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return matched.kind ? { name: matched.name, kind: matched.kind } : { name: matched.name }
}

/**
 * Revoke a device by name. Returns true if it existed.
 *
 * `by` is who asks (device-actor.ts); absent = this machine itself (the
 * `walnut device` CLI). A paired device may revoke only itself, unless it is
 * the Mac that owns this companion's machine credentials.
 *
 * The machine credentials it owns go with it (a Mac's pairing revoked is that
 * Mac disconnected from this companion), and so do the unowned ones from
 * before ownership was recorded (revokedWith).
 */
export async function revokeDevice(name: string, opts: { by?: DeviceActor; tokenHash?: string } = {}): Promise<boolean> {
  const removed = await updateAuth((auth) => {
    // `tokenHash`: only this pairing of the name, never one that replaced it meanwhile.
    const target = auth.devices.find((d) => d.name === name && (opts.tokenHash === undefined || d.tokenHash === opts.tokenHash))
    if (!target) return { persist: false, result: [] as string[] }
    const by = opts.by ?? LOCAL_ACTOR
    // A machine credential through this path: only this machine itself (the
    // routes send a paired device's request to machine-credentials.ts).
    const decision = target.kind === 'machine' && !('local' in by)
      ? { ok: false as const, refusal: new DeviceChangeRefused(403, 'device_change_refused', `${name} is a machine credential`) }
      : deviceChangeDecision(auth.devices, by, 'revoke', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    const gone = revokedWith(auth.devices, target)
    auth.devices = auth.devices.filter((d) => !gone.includes(d))
    return { persist: true, result: gone.map((d) => d.name) }
  })
  if (!removed.includes(name)) return false
  for (const n of removed) lastUsedWriteAt.delete(n)
  log.web.info('device-auth: device revoked', { name, ...(removed.length > 1 ? { ownedCredentials: removed.filter((n) => n !== name) } : {}) })
  notifyRevoked(removed)
  return true
}

type RevokeListener = (names: string[]) => void
const revokeListeners = new Set<RevokeListener>()

/**
 * Hear every credential this process revokes (a device and the machine
 * credentials that went with it), so a socket opened with one can be closed at
 * once. A revoke by the `walnut device` CLI (another process) is not heard:
 * holders re-verify on their own clock as well.
 */
export function onCredentialsRevoked(listener: RevokeListener): () => void {
  revokeListeners.add(listener)
  return () => { revokeListeners.delete(listener) }
}

export function notifyRevoked(names: string[]): void {
  if (names.length === 0) return
  for (const l of revokeListeners) {
    try { l(names) } catch { /* a listener must never fail a revoke */ }
  }
}

/** Locked read-modify-write for machine-credentials.ts (same lock as every other auth.json writer). */
export async function mutateDeviceRecords<R>(
  mutate: (devices: DeviceRecord[]) => { devices?: DeviceRecord[]; result: R },
): Promise<R> {
  return updateAuth((auth) => {
    const { devices, result } = mutate(auth.devices)
    if (devices) auth.devices = devices
    return { persist: devices !== undefined, result }
  })
}

/** A fresh token and its record, for machine-credentials.ts (plaintext returned once, never stored). */
export function newMachineRecord(name: string, ownerId: string, daemonKey: string | undefined): { record: DeviceRecord; token: string } {
  validateDeviceName(name)
  const { record, token } = freshRecord(name, 'machine')
  return { token, record: { ...record, ownerId, ...(daemonKey ? { daemonKey } : {}) } }
}

/** Does `token` hash to `tokenHash`? Constant time. */
export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  return hashesEqual(sha256Hex(token), tokenHash)
}

/** List devices — never exposes token hashes. */
export async function listDevices(): Promise<DeviceInfo[]> {
  const auth = await loadAuth()
  return auth.devices.map(({ name, createdAt, lastUsedAt, kind, info, adoptedFrom }) => ({ name, createdAt, lastUsedAt, kind, info, ...(adoptedFrom ? { adoptedFrom } : {}) }))
}

/** Max accepted length per self-reported string — these are untrusted input. */
const INFO_FIELD_MAX = 120

/**
 * Record a paired client's self-reported identity. Called on every client
 * launch, so it doubles as the backfill path for devices paired before the
 * reporting build existed. Returns false when the device is unknown.
 *
 * Values are clamped and the timestamp is stamped server-side — a client must
 * not be able to bloat auth.json or forge a report time.
 */
export async function setDeviceInfo(name: string, info: DeviceSelfInfo): Promise<boolean> {
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const trimmed = v.trim().slice(0, INFO_FIELD_MAX)
    return trimmed.length > 0 ? trimmed : undefined
  }
  const next: DeviceSelfInfo = {
    model: clean(info.model),
    os: clean(info.os),
    deviceName: clean(info.deviceName),
    appVersion: clean(info.appVersion),
    reportedAt: new Date().toISOString(),
  }
  const outcome = await updateAuth((auth) => {
    const device = auth.devices.find((d) => d.name === name)
    if (!device) return { persist: false, result: 'unknown' as const }
    // The first report is the device's claim of what it is, and the platform it
    // says is kept for good: no later report (a cleared one, a Mac model sent by
    // a phone) changes it. The report itself is display only.
    const claimed = !device.platform && device.kind !== 'machine' ? platformFromInfo(next) : undefined
    if (claimed) device.platform = claimed
    // Don't churn the file when nothing meaningful changed — clients report on
    // every launch, and each auth.json write also rewrites the .bak sidecar.
    const prev = device.info
    if (prev
      && prev.model === next.model && prev.os === next.os
      && prev.deviceName === next.deviceName && prev.appVersion === next.appVersion) {
      return { persist: claimed !== undefined, result: 'unchanged' as const }
    }
    device.info = next
    return { persist: true, result: 'updated' as const }
  })
  if (outcome === 'unknown') return false
  if (outcome === 'updated') {
    log.web.info('device-auth: device info reported', {
      name, model: next.model, os: next.os, appVersion: next.appVersion,
    })
  }
  return true
}

/**
 * Full records INCLUDING token hashes. Internal use only — callers must never
 * send these to a client. Used to recognize a credential we already hold (e.g.
 * "which device record is this Mac's own cloud token?").
 */
export async function listDeviceRecords(): Promise<DeviceRecord[]> {
  return (await loadAuth()).devices
}

let volatileInstanceId: string | null = null

/**
 * This box's identity, so a client can tell whether an address leads to the
 * box it expects (GET /api/v1/instance). 16 random bytes in hex, minted once in
 * the locked write. A file that exists but does not parse is left alone (the
 * write would replace it and its .bak, which is what an operator recovers from):
 * this process answers with an id it keeps in memory instead.
 */
export async function getInstanceId(): Promise<string> {
  const known = (await loadAuth()).instanceId
  if (known) return known
  return updateAuth(async (auth) => {
    if (auth.instanceId) return { persist: false, result: auth.instanceId }
    const raw = await fs.readFile(authFilePath(), 'utf-8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : ''))
    let readable = raw === null
    try { readable ||= Array.isArray((JSON.parse(raw ?? '') as AuthFile).devices) } catch { /* unreadable */ }
    if (!readable) {
      volatileInstanceId ??= crypto.randomBytes(16).toString('hex')
      return { persist: false, result: volatileInstanceId }
    }
    auth.instanceId = crypto.randomBytes(16).toString('hex')
    return { persist: true, result: auth.instanceId }
  })
}

/** True once at least one device is paired (claim path closed). */
export async function isClaimed(): Promise<boolean> {
  const auth = await loadAuth()
  return auth.devices.length > 0
}

/**
 * Read a setup token supplied by provisioning (the "pairing code" the operator's
 * Walnut generated locally and burned into this box's cloud-init), instead of
 * having the box mint one and print it to the journal.
 *
 * Two shapes, env wins: `WALNUT_SETUP_TOKEN` (value) or `WALNUT_SETUP_TOKEN_FILE`
 * (path). The file path is NEVER defaulted in code — it always arrives via the
 * env var that scripts/cloud/setup.sh sets, so a dev Mac never reads a stray
 * file and tests stay hermetic.
 */
async function readProvisionedSetupToken(): Promise<{ token: string; source: 'env' | 'file' } | null> {
  let candidate: string | undefined
  let source: 'env' | 'file' = 'env'
  const fromEnv = process.env.WALNUT_SETUP_TOKEN
  if (fromEnv) {
    candidate = fromEnv
  } else {
    const file = process.env.WALNUT_SETUP_TOKEN_FILE
    if (file) {
      source = 'file'
      try {
        candidate = await fs.readFile(file, 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          // Only ENOENT is the normal "this box wasn't provisioned" case. EACCES
          // in particular means the file IS there and the operator's pairing
          // code is dead — that failure was invisible for a whole release.
          log.web.error('device-auth: provisioned setup token file exists but could not be read — falling back to a random setup token, so the pairing code will NOT claim this instance', {
            file,
            code,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return null
      }
    }
  }
  if (candidate === undefined) return null
  const token = candidate.trim()
  if (!/^[0-9a-f]{32}$/.test(token)) {
    // The operator holds a pairing code that will NEVER work — say so loudly
    // rather than silently falling back to a token only the journal knows.
    log.web.error('device-auth: provisioned setup token is malformed (expected 32 lowercase hex chars) — falling back to a random setup token, so the pairing code will NOT claim this instance', {
      source,
      length: token.length,
    })
    return null
  }
  return { token, source }
}

/**
 * Get the current setup token — ONLY while zero devices exist. Lazily generates
 * (and regenerates on expiry). Returns null once the instance is claimed.
 * Callers that surface it to the operator should use printSetupTokenBanner()
 * — but only when `provisioned` is false; a provisioned token must never be
 * echoed, the operator already has it.
 */
export async function getSetupTokenIfUnclaimed(): Promise<{ token: string; expiresAt: number; provisioned: boolean } | null> {
  if (await isClaimed()) {
    setupToken = null
    return null
  }
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    const provisioned = await readProvisionedSetupToken()
    if (provisioned) {
      setupToken = {
        token: provisioned.token,
        expiresAt: Date.now() + PROVISIONED_SETUP_TOKEN_TTL_MS,
        provisioned: true,
      }
      // Deliberately omits the token value, like the random-path log below.
      log.web.warn('device-auth: adopted provisioned setup token', {
        source: provisioned.source,
        expiresAt: new Date(setupToken.expiresAt).toISOString(),
      })
    } else {
      setupToken = {
        token: crypto.randomBytes(16).toString('hex'),
        expiresAt: Date.now() + SETUP_TOKEN_TTL_MS,
        provisioned: false,
      }
      log.web.warn('device-auth: setup token generated (instance unclaimed)', {
        expiresAt: new Date(setupToken.expiresAt).toISOString(),
      })
    }
  }
  return setupToken
}

/**
 * Print the setup-token banner to stdout (greppable via journalctl on a cloud
 * box). This is one of the two intentional plaintext-token prints — the
 * structured logger above deliberately omits the token itself.
 */
export function printSetupTokenBanner(token: string, expiresAt: number): void {
  const lines = [
    '',
    '==============================================================',
    '  WALNUT CLOUD SETUP — instance is UNCLAIMED',
    '',
    `  Setup token: ${token}`,
    `  Valid until: ${new Date(expiresAt).toISOString()} (15 min)`,
    '',
    '  Claim it with:',
    '    curl -X POST https://<host>/api/v1/setup/claim \\',
    `      -H 'Content-Type: application/json' \\`,
    `      -d '{"setupToken":"${token}","deviceName":"my-phone"}'`,
    '',
    '  The response contains your device token (shown once).',
    '  This path closes permanently after the first device is paired.',
    '==============================================================',
    '',
  ]
  process.stdout.write(lines.join('\n'))
}

/**
 * Claim an unclaimed instance: validate the setup token, create the first
 * device, and permanently close the claim path (devices > 0 → claim rejected).
 */
export async function claimInstance(candidateToken: string, deviceName: string): Promise<{ name: string; token: string }> {
  if (await isClaimed()) {
    throw new Error('Instance already claimed')
  }
  // Validate against the CURRENT setup token only — never regenerate here.
  // An expired token means the operator must restart the server for a fresh
  // banner; silently rotating during a failed claim would strand the printed one.
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    throw new Error('Invalid or expired setup token')
  }
  // Constant-time compare on hashes (uniform-length buffers).
  if (!hashesEqual(sha256Hex(candidateToken ?? ''), sha256Hex(setupToken.token))) {
    throw new Error('Invalid or expired setup token')
  }
  const { name, token } = await createDevice(deviceName)
  setupToken = null // closed — createDevice made isClaimed() true anyway
  // A provisioned pairing code must not linger on disk once it has been spent.
  // Best-effort: the claim already succeeded, so a failed unlink is not an error
  // worth failing on. (Any env-var copy of the token in the systemd unit is inert
  // from here on — the claim path is closed forever.)
  const tokenFile = process.env.WALNUT_SETUP_TOKEN_FILE
  if (tokenFile) {
    try { await fs.unlink(tokenFile) } catch { /* already gone / read-only FS */ }
  }
  log.web.info('device-auth: instance claimed', { deviceName: name })
  return { name, token }
}

/** Test-only: clear module-level state (setup token + write throttle). */
export function _resetDeviceAuthForTesting(): void {
  setupToken = null
  lastUsedWriteAt.clear()
  volatileInstanceId = null
}
