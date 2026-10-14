/**
 * auth.json: this server's device registry. Storage only: the record shapes,
 * the file and its .bak sidecar, the cross-process lock every writer takes, and
 * bringing a file from an older build up to date. Who may change what lives in
 * device-actor.ts and machine-credentials.ts; the operations in device-auth.ts.
 *
 * (<OPEN_WALNUT_HOME>/auth.json, mode 0600) holds SHA-256 hashes of 128-bit
 * random Bearer tokens; a plaintext token is shown exactly once and never
 * stored. On a cloud companion the file also records its OWNER: the paired
 * device that is the Mac this companion belongs to (see `owner` below).
 *
 * IMPORTANT: auth.json must NEVER enter the OPEN_WALNUT_HOME git-sync repo
 * (see CRITICAL_IGNORES in src/integrations/git-sync.ts).
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { withFileLock } from '../utils/file-lock.js'
import { log } from '../logging/index.js'
import { isHostReplica } from './server-role.js'

export type DevicePlatform = 'ios' | 'other'

export interface DeviceRecord {
  name: string
  /**
   * Minted at pairing and never changed: a rotation the device makes itself
   * keeps it, any other re-pairing of the name gets a new one. Ownership is
   * keyed by it, never by the name. Records from before it existed get one
   * derived from their token hash (the same on every read), written with the
   * next real change.
   */
  id?: string
  /** sha256 hex of the plaintext token; the token itself is never stored. */
  tokenHash: string
  createdAt: string
  lastUsedAt?: string
  /**
   * 'machine' = daemon bridge credential: accepted ONLY for the /bridge WS
   * upgrade, rejected on every REST route. Absent = normal paired device.
   */
  kind?: 'machine'
  bridgeScope?: 'status-only'
  /**
   * What the device is, recorded once: at its first self-report (the setup
   * claim's, when it carried one), or from the report it had when this field
   * was introduced. A later report never changes it. It decides wording, that a
   * phone pairs nothing, and that a phone is never the owner; it never makes a
   * device an owner (`owner` below).
   */
  platform?: DevicePlatform
  /**
   * Machine credentials only: the `id` of the companion's owner that minted it.
   * Absent on a credential minted before ownership was recorded.
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
   * The owner only: the tunnel daemon its machine credentials get
   * (machine-credentials.ts; {} = the unkeyed one it took over, `key` = its own).
   * Kept on the device, so a credential revoked and minted again lands on the
   * same daemon.
   */
  tunnelDaemon?: { key?: string }
  /**
   * Self-reported hardware/app identity, refreshed by the client on every
   * launch (POST /api/v1/devices/self). Absent for devices paired before the
   * reporting build shipped: they backfill on their next launch, and the
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
  /** Server-stamped receipt time (ISO), never client-supplied. */
  reportedAt?: string
}

/**
 * How the owner came to be one. Only what proves it counts, never a
 * self-report and never which record is oldest (a report can only keep a
 * device from being the owner: a phone never is one):
 *  - 'claim': it claimed the companion with the setup token, saying in the
 *    claim that it is a computer (device-claim.ts);
 *  - 'operator': `walnut device owner <name>` (or `device add --owner`) on the box;
 *  - 'proof': it presented the token of the companion's first `bridge-local`
 *    credential, which only that Mac's own daemon ever held;
 *  - 'mint': with no owner recorded, it was the first paired device that is not
 *    a phone to mint a machine credential here (the first come rule of builds
 *    from before owners were recorded, now written down when it happens).
 * A file from before owners were recorded has none; until one of these happens
 * the rules there are the ones those builds had (device-actor.ts hasOwnerRights).
 */
export type OwnerVia = 'claim' | 'operator' | 'proof' | 'mint'

export interface CompanionOwner {
  /** The owner's DeviceRecord.id. */
  id: string
  via: OwnerVia
}

export interface AuthFile {
  devices: DeviceRecord[]
  /**
   * The companion's owner (meaningful in cloud mode only). Absent (or `null`)
   * = none recorded: a file from before owners were recorded, or the owner's
   * pairing was removed. Never inferred (OwnerVia says what records one).
   */
  owner?: CompanionOwner | null
  /** This box's identity (getInstanceId). Here because auth.json is machine-local and never synced. */
  instanceId?: string
  /**
   * Token hashes of every pairing revoked or replaced here, written in the same
   * locked write that removes it. Such a token never authenticates here again,
   * and the other box's copy of it is never adopted back (device-adoption.ts):
   * that box may still hold it when its removal was refused or given up on.
   */
  revokedHashes?: string[]
}

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/
const keptInstanceId = (raw: unknown) => (typeof raw === 'string' && INSTANCE_ID_RE.test(raw) ? { instanceId: raw } : {})
const keptRevoked = (raw: unknown) => {
  const hashes = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string' && TOKEN_HASH_RE.test(h)) : []
  return hashes.length > 0 ? { revokedHashes: hashes } : {}
}

/** Record `hashes` as revoked here, inside the locked write that removes their pairings. */
export function tombstone(auth: LockedAuth, hashes: readonly string[]): void {
  const known = new Set(auth.revokedHashes ?? [])
  const added = hashes.filter((h) => TOKEN_HASH_RE.test(h) && !known.has(h))
  if (added.length > 0) auth.revokedHashes = [...(auth.revokedHashes ?? []), ...added]
}

/** auth.json as every rule reads it: brought up to date, owner decided. */
export type DeviceRegistry = { devices: readonly DeviceRecord[]; owner: CompanionOwner | null }

function authFilePath(): string {
  return path.join(WALNUT_HOME, 'auth.json')
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex')
}

/** Constant-time compare of two sha256 hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== 32 || bufB.length !== 32) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** Does `token` hash to `tokenHash`? Constant time. */
export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  return hashesEqual(sha256Hex(token), tokenHash)
}

/** The record `token` authenticates as. Every record is compared (no early exit). */
export function recordForToken(devices: readonly DeviceRecord[], token: string): DeviceRecord | undefined {
  const hash = sha256Hex(token)
  let found: DeviceRecord | undefined
  for (const d of devices) if (hashesEqual(hash, d.tokenHash)) found = d
  return found
}

/** A fresh device id: minted once, at pairing. */
export function newDeviceId(): string {
  return `d${crypto.randomBytes(8).toString('hex')}`
}

/**
 * The id of a record from before ids were minted: derived from its token hash,
 * so every read gives the same one (it is written with the next real change,
 * never on its own) and a rule comparing ids across two reads agrees.
 */
function legacyDeviceId(tokenHash: string): string {
  return `d${sha256Hex(`walnut-device-id:${tokenHash}`).slice(0, 16)}`
}

/** What a self-report says about the platform; undefined when it says nothing. */
export function platformFromInfo(info: DeviceSelfInfo | undefined): DevicePlatform | undefined {
  const model = info?.model ?? ''
  const os = info?.os ?? ''
  if (/^(iPhone|iPad|iPod)/.test(model) || /^(iOS|iPadOS)\b/i.test(os)) return 'ios'
  return model || os ? 'other' : undefined
}

/** A device recorded as a phone (or tablet): at its first report, never changed after. */
export function isPhoneRecord(d: Pick<DeviceRecord, 'platform'>): boolean {
  return d.platform === 'ios'
}

/** Does a self-report say a Mac? Wording only (which sentence a refusal says), never a right. */
export function isMacReport(info: DeviceSelfInfo | undefined): boolean {
  return /^Mac/.test(info?.model ?? '') || /^macOS\b/i.test(info?.os ?? '')
}

/** Max accepted length per self-reported string: these are untrusted input. */
const INFO_FIELD_MAX = 120

/**
 * A self-report as it is stored: strings only, clamped, the time stamped here
 * (a client must not bloat auth.json or forge a report time).
 */
export function cleanSelfInfo(info: unknown): DeviceSelfInfo {
  const raw = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const trimmed = v.trim().slice(0, INFO_FIELD_MAX)
    return trimmed.length > 0 ? trimmed : undefined
  }
  return {
    model: clean(raw.model),
    os: clean(raw.os),
    deviceName: clean(raw.deviceName),
    appVersion: clean(raw.appVersion),
    reportedAt: new Date().toISOString(),
  }
}

function parseOwner(v: unknown): CompanionOwner | null | undefined {
  if (v === null) return null
  if (!v || typeof v !== 'object') return undefined
  const o = v as { id?: unknown; via?: unknown }
  const vias: readonly string[] = ['claim', 'operator', 'proof', 'mint']
  return typeof o.id === 'string' && typeof o.via === 'string' && vias.includes(o.via) ? { id: o.id, via: o.via as OwnerVia } : undefined
}

function parseAuth(raw: string): AuthFile {
  const parsed = JSON.parse(raw) as { devices?: unknown; owner?: unknown; instanceId?: unknown; revokedHashes?: unknown }
  if (!Array.isArray(parsed.devices)) throw new Error('devices is not an array')
  const devices = (parsed.devices as DeviceRecord[]).filter((d) => d && typeof d.name === 'string' && typeof d.tokenHash === 'string')
  const owner = parseOwner(parsed.owner)
  return { ...keptInstanceId(parsed.instanceId), ...keptRevoked(parsed.revokedHashes), devices, ...(owner === undefined ? {} : { owner }) }
}

/**
 * A file that holds something: a pairing, or a revoked hash. One with revoked
 * hashes alone (every pairing on this box was revoked) still counts: losing it
 * would let the other box's copy of a revoked pairing be adopted back
 * (device-adoption.ts).
 */
function holdsSomething(auth: AuthFile): boolean {
  return auth.devices.length > 0 || auth.revokedHashes !== undefined
}

/**
 * Loads that stand in for a file this process could not read: auth.json does
 * not parse and auth.json.bak holds no readable records, or auth.json is
 * missing and auth.json.bak does not parse. Zero devices, so the claim flow
 * reopens (a corrupt file silently locking everyone IN would be worse than a
 * re-pair), but nothing is ever written over what an operator recovers from
 * (saveAuth moves an unreadable file aside first).
 */
const unreadableLoads = new WeakSet<AuthFile>()
/** Loads read from auth.json.bak because auth.json does not parse (the main file is left as it is). */
const backupLoads = new WeakSet<AuthFile>()

type FileRead = { kind: 'absent' } | { kind: 'unreadable'; error: string } | { kind: 'ok'; auth: AuthFile }

async function readAuthFile(file: string): Promise<FileRead> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', error: code ?? String(err) }
  }
  try {
    return { kind: 'ok', auth: parseAuth(raw) }
  } catch (err) {
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Load auth.json, raw (upgrade() brings it up to date in memory).
 *  - missing, .bak with records: the .bak, put back as auth.json (2026-07-26:
 *    a merge carrying a remote deletion removed auth.json on both boxes, every
 *    token stopped validating and git sync died on a bare 401 for six hours;
 *    git-sync now keeps auth.json untracked so that cannot reach disk again);
 *  - missing, no .bak (or an empty one): zero devices, a genuine first boot;
 *  - missing, a .bak that does not parse: zero devices, unreadable;
 *  - does not parse, .bak with records: the .bak's records, and auth.json is
 *    left as it is (an operator may still recover it);
 * ("With records" = holdsSomething: revoked hashes alone count too.)
 *  - does not parse, nothing readable beside it: zero devices, unreadable.
 * A readable auth.json is the registry, and the .bak is never merged into it:
 * saveAuth renames auth.json into place before it writes the .bak, so a crash
 * between the two leaves the .bak one write behind, and a record only the
 * .bak holds is one that write removed (taking it would bring a revoked token
 * back).
 */
async function loadAuth(): Promise<AuthFile> {
  const file = authFilePath()
  const main = await readAuthFile(file)
  if (main.kind === 'ok') return main.auth
  const bak = await readAuthFile(authBackupPath())
  const bakRecords = bak.kind === 'ok' && holdsSomething(bak.auth) ? bak.auth : null
  if (main.kind === 'absent') {
    if (bakRecords) {
      log.web.error('auth.json missing: recovered the device registry from auth.json.bak. Every device token would otherwise have stopped validating.', {
        file,
        devices: bakRecords.devices.length,
      })
      // Put the primary back so the next read is a plain hit (the .bak's own bytes, not an upgrade).
      try { await saveAuth(bakRecords) } catch { /* read-only FS / racing writer */ }
      return bakRecords
    }
    if (bak.kind !== 'unreadable') return { devices: [] } // genuine first boot
    log.web.error('auth.json missing and auth.json.bak does not parse: treating as zero devices, and leaving auth.json.bak as it is', {
      file, error: bak.error,
    })
    const empty: AuthFile = { devices: [] }
    unreadableLoads.add(empty)
    return empty
  }
  if (bakRecords) {
    log.web.error('auth.json does not parse: using the device registry in auth.json.bak, and leaving auth.json as it is', {
      file, error: main.error, devices: bakRecords.devices.length,
    })
    backupLoads.add(bakRecords)
    return bakRecords
  }
  log.web.error('auth.json is corrupt: treating as zero devices (claim flow reopens)', { file, error: main.error })
  const empty: AuthFile = { devices: [] }
  unreadableLoads.add(empty)
  return empty
}

/**
 * Sidecar copy of the device registry, for the same reason config.yaml has one:
 * losing it is unrecoverable from anywhere else and presents as a blanket 401.
 * Gitignored + kept untracked by git-sync's CRITICAL_IGNORES, never synced
 * (each box pairs its own devices).
 */
function authBackupPath(): string {
  return `${authFilePath()}.bak`
}

/**
 * Before a write: a file there that does not parse is renamed aside
 * (`<name>.unreadable-<time>`), never overwritten. It is what an operator
 * recovers from when every token stopped working.
 */
async function setAsideUnreadable(): Promise<void> {
  for (const file of [authFilePath(), authBackupPath()]) {
    const read = await readAuthFile(file)
    if (read.kind !== 'unreadable') continue
    const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await fs.rename(file, aside)
      log.web.warn('auth.json: a file that does not parse was set aside before the write, not overwritten', { file, aside, error: read.error })
    } catch (err) {
      // Never write over it: fail the write instead.
      throw new Error(`${path.basename(file)} does not parse and could not be set aside (${err instanceof Error ? err.message : String(err)}); nothing was written.`)
    }
  }
}

/** Write auth.json atomically with mode 0600, mirroring to the sidecar. */
async function saveAuth(auth: AuthFile): Promise<void> {
  const file = authFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await setAsideUnreadable()
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
 * Bring a file from an older build up to date before any rule reads it: every
 * record gets an id (legacyDeviceId), a device that reported itself gets the platform that
 * report said (fixed from then on), the name-keyed `owner` an earlier build put
 * on credentials is dropped, and an owner whose record is gone is no owner. In
 * memory only: it reaches disk with the next real change (updateAuth), never
 * on its own, so a read or a no-op writes nothing.
 */
function upgrade(auth: AuthFile): void {
  for (const d of auth.devices) {
    if (!d.id) d.id = legacyDeviceId(d.tokenHash)
    if (!d.platform && d.kind !== 'machine') {
      const p = platformFromInfo(d.info)
      if (p) d.platform = p
    }
    if ('owner' in d) delete (d as { owner?: unknown }).owner
  }
  if (auth.owner && !auth.devices.some((d) => d.kind !== 'machine' && d.id === auth.owner!.id)) auth.owner = null
}

/** auth.json for reading: up to date in memory, nothing written. */
export async function readRegistry(): Promise<DeviceRegistry> {
  const auth = await loadAuth()
  upgrade(auth)
  return { devices: auth.devices, owner: auth.owner ?? null }
}

/** auth.json for reading, with the token hashes revoked here (AuthFile.revokedHashes). */
export async function readRegistryAndRevoked(): Promise<DeviceRegistry & { revoked: ReadonlySet<string> }> {
  const auth = await loadAuth()
  upgrade(auth)
  return { devices: auth.devices, owner: auth.owner ?? null, revoked: new Set(auth.revokedHashes ?? []) }
}

/** The locked view a mutation gets: the records, the owner and the revoked hashes, all writable. */
export type LockedAuth = { devices: DeviceRecord[]; owner: CompanionOwner | null; instanceId?: string; revokedHashes?: string[] }

/** What a write puts on disk. */
function fileOf(auth: LockedAuth): AuthFile {
  return { ...keptInstanceId(auth.instanceId), ...keptRevoked(auth.revokedHashes), devices: auth.devices, ...(auth.owner ? { owner: auth.owner } : {}) }
}

/**
 * Locked read-modify-write over auth.json. The file is written by BOTH the
 * server process and the `walnut device` CLI (a separate process), so a blind
 * save-after-load can revert the other writer's changes. We keep the bespoke
 * saveAuth (mode 0600 + .bak sidecar) instead of the generic updateJsonFile,
 * but take the same cross-process file lock around the read→mutate→write
 * cycle. Only `persist: true` writes (the upgrade rides along with it); a
 * no-op outcome writes nothing, and a write never replaces a file that does
 * not parse (saveAuth sets it aside).
 * `afterSave` runs after a persisted write, still inside the lock, so nobody
 * else reads auth.json before it is done. It must not throw.
 * `onFailure` runs when `mutate` or the write throws, also still inside the
 * lock, before the error goes on: what `mutate` wrote ahead is taken back
 * before another writer can reuse it. It must not throw.
 */
export async function updateAuth<R>(
  mutate: (auth: LockedAuth) => { persist: boolean; result: R } | Promise<{ persist: boolean; result: R }>,
  afterSave?: () => Promise<void>,
  onFailure?: () => Promise<void>,
): Promise<R> {
  return withFileLock(authFilePath(), async () => {
    let outcome: { persist: boolean; result: R }
    try {
      const loaded = await loadAuth()
      upgrade(loaded)
      const auth: LockedAuth = { ...keptInstanceId(loaded.instanceId), ...keptRevoked(loaded.revokedHashes), devices: loaded.devices, owner: loaded.owner ?? null }
      outcome = await mutate(auth)
      if (outcome.persist) await saveAuth(fileOf(auth))
    } catch (err) {
      if (onFailure) await onFailure()
      throw err
    }
    if (outcome.persist && afterSave) await afterSave()
    return outcome.result
  })
}

/**
 * auth.json as a check that must not mistake a bad read for "no devices"
 * reads it (device-pairings.ts): auth.json itself, else its .bak when auth.json
 * is missing or does not parse and the .bak holds something. Null when neither
 * can be read: loadAuth reads that as zero devices, a caller judging push rows
 * must not, or one bad read would silence every phone. Read-only: nothing is
 * restored or written.
 */
export async function readAuthForCheck(): Promise<{ auth: AuthFile; from: 'auth' | 'backup' } | null> {
  const main = await readAuthFile(authFilePath())
  if (main.kind === 'ok') return { auth: main.auth, from: 'auth' }
  const bak = await readAuthFile(authBackupPath())
  return bak.kind === 'ok' && holdsSomething(bak.auth) ? { auth: bak.auth, from: 'backup' } : null
}

/** Run `fn` holding the auth.json lock (every writer takes it). `timeoutMs`: as withFileLock. */
export function withAuthLock<R>(fn: () => Promise<R>, opts: { timeoutMs?: number } = {}): Promise<R> {
  return withFileLock(authFilePath(), fn, opts)
}

/**
 * `owner` proved itself with the unowned bridge-local's token (device-actor.ts
 * proofClaim): record it, and make the credentials from before ownership was
 * recorded its own, so the proof is spent. They keep their daemon, and the
 * owner records that daemon as its own (the bridge-local's, the unkeyed one),
 * as the builds before did when a proof adopted them.
 */
export function ownByProof(auth: LockedAuth, owner: CompanionOwner): void {
  const me = auth.devices.find((d) => d.kind !== 'machine' && d.id === owner.id)
  const paired = (id: string | undefined) => id !== undefined && auth.devices.some((d) => d.kind !== 'machine' && d.id === id)
  const legacy = auth.devices.filter((d) => d.kind === 'machine' && !paired(d.ownerId))
  const local = legacy.find((d) => d.name === 'bridge-local')
  if (me && legacy.length > 0 && !me.tunnelDaemon) me.tunnelDaemon = local?.daemonKey ? { key: local.daemonKey } : {}
  auth.owner = owner
  for (const d of legacy) d.ownerId = owner.id
}

/** The tunnel daemon key a new machine credential of `me` gets (undefined: the unkeyed daemon). */
export function daemonKeyFor(me: DeviceRecord): string | undefined {
  return me.tunnelDaemon ? me.tunnelDaemon.key : me.id
}

export function validateDeviceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error('Invalid device name: use 1-64 chars of letters, digits, dot, dash, underscore')
  }
}

let volatileInstanceId: string | null = null

/**
 * This box's identity, so a client can tell whether an address leads to the
 * box it expects (GET /api/v1/instance). 16 random bytes in hex, minted once in
 * the locked write. Minting writes auth.json, so it happens only over a file
 * that reads (or none at all): while auth.json does not parse, or only its .bak
 * reads, this process answers with an id it keeps in memory instead.
 */
export async function getInstanceId(): Promise<string> {
  // A host replica is the Walnut it follows: it answers the Mac's id and never
  // mints one of its own into an auth.json (replica/boot-guard.ts requires the id).
  if (isHostReplica()) {
    const leader = (process.env.WALNUT_WALNUT_ID ?? '').trim()
    if (leader) return leader
    throw new Error('a host replica has no WALNUT_WALNUT_ID: it never mints an id of its own')
  }
  const known = await loadAuth()
  if (known.instanceId) return known.instanceId
  return withFileLock(authFilePath(), async () => {
    const auth = await loadAuth()
    if (auth.instanceId) return auth.instanceId
    if (unreadableLoads.has(auth) || backupLoads.has(auth)) {
      volatileInstanceId ??= crypto.randomBytes(16).toString('hex')
      return volatileInstanceId
    }
    upgrade(auth)
    const instanceId = crypto.randomBytes(16).toString('hex')
    await saveAuth(fileOf({ instanceId, devices: auth.devices, owner: auth.owner ?? null, ...keptRevoked(auth.revokedHashes) }))
    return instanceId
  })
}

/** Test-only: forget the in-memory instance id (device-auth.ts _resetDeviceAuthForTesting). */
export function resetInstanceIdForTesting(): void {
  volatileInstanceId = null
}

/** A new pairing's record and its plaintext token (returned once, never stored). */
export function freshRecord(name: string, kind?: 'machine'): { record: DeviceRecord; token: string } {
  const token = crypto.randomBytes(16).toString('hex')
  return {
    token,
    record: { name, id: newDeviceId(), tokenHash: sha256Hex(token), createdAt: new Date().toISOString(), ...(kind ? { kind } : {}) },
  }
}
