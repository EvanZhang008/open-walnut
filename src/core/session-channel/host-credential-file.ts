/**
 * A host's door credential for one Walnut (door-wire.ts): what its leader issued over the
 * authenticated daemon link (`POST /host-api/credential`, host-routes.ts), kept in
 * `~/.local/state/open-walnut/host-credentials/<walnutId>.json` next to the machine id
 * (machine-id.ts; the home manifest's `state.host-credentials`, a machine's place, sensitive). The
 * dir is 0700, the file 0600, written whole (a temp file, then a rename). It is this machine's,
 * never copied: no copy kind and no config copy carries it.
 *
 * The leader's request is refused unless it names this host's own Walnut (WALNUT_WALNUT_ID) and
 * this machine (its stable id): a credential for another machine or Walnut is never written here.
 * The leader's door list can change later (a welcome, a `doors` frame, `POST /host-api/doors`):
 * kept only from a standing not below the highest this host holds (updateHostCredentialDoors).
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { machineIdFile, readMachineId } from '../machine-id.js'
import { cleanDoorUrls, doorKeyId, doorUrlRefusal, DOOR_SECRET_RE } from './door-wire.js'
import { comparePermit, isPermitPair, type PermitPair } from './channel.js'

const WALNUT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/

export interface HostCredential {
  v: 2
  walnutId: string
  machineId: string
  /** S, the key this host and its leader prove themselves with at the door (door-wire.ts). */
  verifyKey: string
  /** The door URLs to dial, in order (door-wire.ts doorUrlRefusal: each one allowed). */
  doors: string[]
  /** The leader's standing when it issued this: a door welcome below it is refused. */
  permit: PermitPair
  issuedAt: string
}

/** Where this machine keeps its door credentials (beside its machine id). */
export function hostCredentialsDir(): string {
  return path.join(path.dirname(machineIdFile()), 'host-credentials')
}

export function hostCredentialFile(walnutId: string): string {
  if (!WALNUT_ID_RE.test(walnutId)) throw new Error('not a Walnut id')
  return path.join(hostCredentialsDir(), `${walnutId}.json`)
}

function parse(raw: unknown): HostCredential | null {
  const c = raw as Partial<HostCredential> | null
  // A v1 file (a bearer token, before the nonce handshake) does not read: the leader issues again.
  if (!c || typeof c !== 'object' || c.v !== 2) return null
  if (typeof c.walnutId !== 'string' || typeof c.machineId !== 'string') return null
  if (typeof c.verifyKey !== 'string' || !DOOR_SECRET_RE.test(c.verifyKey)) return null
  if (!isPermitPair(c.permit)) return null
  return { v: 2, walnutId: c.walnutId, machineId: c.machineId, verifyKey: c.verifyKey, doors: cleanDoorUrls(c.doors), permit: c.permit, issuedAt: typeof c.issuedAt === 'string' ? c.issuedAt : '' }
}

/** This machine's credential for `walnutId`, or null (none, or one that does not read). */
export async function readHostCredential(walnutId: string): Promise<HostCredential | null> {
  try {
    return parse(JSON.parse(await fsp.readFile(hostCredentialFile(walnutId), 'utf8')))
  } catch {
    return null
  }
}

/** Keep `c` (0700 dir, 0600 file, whole: a temp file renamed over the last one). */
async function keep(c: HostCredential): Promise<void> {
  const file = hostCredentialFile(c.walnutId)
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await fsp.chmod(dir, 0o700).catch(() => {})
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(c), { mode: 0o600 })
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export type CredentialWrite = { ok: true; credential: HostCredential } | { ok: false; error: string; why?: string }

/** Why `doors` is not a door list a host keeps, or null (1 to 8 URLs, each one doorUrlRefusal allows). */
function doorsRefusal(doors: unknown): { error: string; why?: string } | null {
  if (!Array.isArray(doors) || doors.length === 0 || doors.length > 8) return { error: 'bad_doors' }
  for (const u of doors) {
    const why = doorUrlRefusal(u)
    if (why) return { error: 'bad_door', why }
  }
  return null
}

/**
 * Keep a door credential the leader minted (host-credentials.ts mintHostCredential) for this very
 * machine: the credential route's write and any other caller take this one function. Refused, and
 * nothing written, for another machine, a key of the wrong shape, a door no host may dial, a
 * standing that does not read, or one below the highest this host holds (the credential's and
 * `seen`, its fact log's: a stale leader never replaces the newer one's credential).
 */
export async function writeHostCredentialFile(
  input: { walnutId: string; machineId: string; verifyKey: string; doors: readonly string[]; permitNumber: number; epoch: number },
  o: { thisMachine?: () => Promise<string>; seen?: PermitPair | null; now?: () => number } = {},
): Promise<CredentialWrite> {
  const b = input as Record<string, unknown>
  if (typeof b.walnutId !== 'string' || !WALNUT_ID_RE.test(b.walnutId)) return { ok: false, error: 'walnut_mismatch' }
  const mine = await (o.thisMachine ?? readMachineId)()
  if (b.machineId !== mine) return { ok: false, error: 'machine_mismatch' }
  if (typeof b.verifyKey !== 'string' || !DOOR_SECRET_RE.test(b.verifyKey)) return { ok: false, error: 'bad_secret' }
  const bad = doorsRefusal(b.doors)
  if (bad) return { ok: false, ...bad }
  const permit = { permitNumber: b.permitNumber, epoch: b.epoch }
  if (!isPermitPair(permit)) return { ok: false, error: 'bad_permit' }
  const held = await readHostCredential(b.walnutId)
  const floor = [held?.permit, o.seen].reduce<PermitPair | null>((hi, p) => (p && (!hi || comparePermit(p, hi) > 0) ? p : hi), null)
  if (floor && comparePermit(permit, floor) < 0) return { ok: false, error: 'stale_permit' }
  const credential: HostCredential = {
    v: 2, walnutId: b.walnutId, machineId: mine, verifyKey: b.verifyKey, doors: cleanDoorUrls(b.doors), permit,
    issuedAt: new Date((o.now ?? Date.now)()).toISOString(),
  }
  await keep(credential)
  return { ok: true, credential }
}

export type DoorsUpdate = 'updated' | 'same' | 'stale' | 'none' | 'bad_doors'

/**
 * The leader's door list, told by a welcome, a `doors` frame or `POST /host-api/doors`: kept in the
 * credential when `pair` is not below the highest standing this host holds (the credential's and
 * `seen`, its fact log's) and the list differs; the credential's standing rises to `pair`. An empty
 * or refused list is never kept (the host keeps dialing what it has).
 */
export async function updateHostCredentialDoors(walnutId: string, doors: unknown, pair: PermitPair, seen: PermitPair | null = null): Promise<DoorsUpdate> {
  if (doorsRefusal(doors)) return 'bad_doors'
  const clean = cleanDoorUrls(doors)
  if (clean.length === 0) return 'bad_doors'
  const held = await readHostCredential(walnutId)
  if (!held) return 'none'
  const floor = seen && comparePermit(seen, held.permit) > 0 ? seen : held.permit
  if (comparePermit(pair, floor) < 0) return 'stale'
  const same = clean.length === held.doors.length && clean.every((u, i) => u === held.doors[i])
  if (same && comparePermit(pair, held.permit) <= 0) return 'same'
  await keep({ ...held, doors: clean, permit: comparePermit(pair, held.permit) > 0 ? { permitNumber: pair.permitNumber, epoch: pair.epoch } : held.permit })
  return same ? 'same' : 'updated'
}

export interface CredentialRouteOptions {
  /** This host's Walnut (WALNUT_WALNUT_ID). */
  walnutId: string
  /** This machine's stable id (machine-id.ts readMachineId; tests pass their own). */
  machineId?: () => Promise<string>
  /** The highest leader standing this host has seen (its fact log's), for a doors update. */
  seenPermit?: () => PermitPair | null
  /** A credential was written: the dialer reads it again. */
  onIssued?(c: HostCredential): void
  /** The door list changed: the dialer dials the new one at its next try. */
  onDoors?(): void
  now?: () => number
}

/** The checks both routes share: only for this host's own Walnut and this very machine. */
async function routeRefusal(b: Record<string, unknown>, o: CredentialRouteOptions): Promise<{ status: number; body: unknown } | string> {
  const mine = await (o.machineId ?? readMachineId)()
  // Nothing of what was sent is echoed.
  if (!o.walnutId || b.walnutId !== o.walnutId) return { status: 403, body: { ok: false, error: 'walnut_mismatch' } }
  if (b.machineId !== mine) return { status: 403, body: { ok: false, error: 'machine_mismatch' } }
  return mine
}

/** `POST /host-api/credential` (door-wire.ts): a write of the leader's credential, or a check of what is kept. */
export async function answerCredentialRoute(body: unknown, o: CredentialRouteOptions): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>
  const mine = await routeRefusal(b, o)
  if (typeof mine !== 'string') return mine
  if (b.check === true) {
    const held = await readHostCredential(o.walnutId)
    if (!held || held.machineId !== mine) return { status: 200, body: { ok: true, holds: false } }
    return { status: 200, body: { ok: true, holds: true, keyId: doorKeyId(held.verifyKey), doors: held.doors, issuedAt: held.issuedAt } }
  }
  const w = await writeHostCredentialFile(b as Parameters<typeof writeHostCredentialFile>[0], { thisMachine: async () => mine, seen: o.seenPermit?.() ?? null, now: o.now })
  if (!w.ok) {
    const status = w.error.endsWith('_mismatch') ? 403 : w.error === 'stale_permit' ? 409 : 400
    return { status, body: { ok: false, error: w.error, ...(w.why ? { why: w.why } : {}) } }
  }
  try { o.onIssued?.(w.credential) } catch { /* the dialer reads the file again at its next try */ }
  return { status: 200, body: { ok: true } }
}

/** `POST /host-api/doors` (door-wire.ts): the leader's door list, kept under the standing rule (updateHostCredentialDoors). */
export async function answerDoorsRoute(body: unknown, o: CredentialRouteOptions): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>
  const mine = await routeRefusal(b, o)
  if (typeof mine !== 'string') return mine
  const pair = { permitNumber: b.permitNumber, epoch: b.epoch }
  if (!isPermitPair(pair)) return { status: 400, body: { ok: false, error: 'bad_permit' } }
  const out = await updateHostCredentialDoors(o.walnutId, b.doors, pair, o.seenPermit?.() ?? null)
  if (out === 'bad_doors') return { status: 400, body: { ok: false, error: 'bad_doors' } }
  if (out === 'none') return { status: 409, body: { ok: false, error: 'no_credential' } }
  if (out === 'stale') return { status: 409, body: { ok: false, error: 'stale_permit' } }
  if (out === 'updated') { try { o.onDoors?.() } catch { /* read again at the next try */ } }
  return { status: 200, body: { ok: true, updated: out === 'updated' } }
}
