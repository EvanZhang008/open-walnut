/**
 * The leader issues each host its door credential (host-credentials.ts) over the host's own
 * authenticated daemon link: `POST /host-api/credential` (door-wire.ts) through the same
 * `openStream('follower', ...)` + requestOver every host-api call takes. Leader only, only while
 * the experiment host_runs_sessions is on, only to a host whose service names HOST_DOOR_CAP and
 * whose daemon said its machine id in its hello, and only while `session.host_door_urls` names a
 * door (empty: hosts do not dial, the leader dials them as before).
 *
 * When: at a host's link (each view of it, at most once per CHECK_EVERY_MS unless the doors
 * changed), the leader asks the host what it holds; it issues when it keeps no record for that
 * machine, the record is older than 30 days (a rotation: the old token stays good 10 minutes),
 * the host holds none or another token, or the doors changed. With the write permission's system
 * on, an issue is an outward configure of a host: it passes its door (assertOutwardDoor). After
 * an issue or a revoke, one standby batch runs before it reports done (standby/runner.ts), so a
 * standby that takes over knows the credential its hosts hold.
 *
 * A host whose door was revoked (revokeHostDoorNow) is issued nothing until it is allowed again
 * (allowHostDoorNow), whatever its link says, and its session channel is cut on every link: the
 * leader side neither keeps nor takes one, and applies nothing such a link sent (leader-apply.ts),
 * read from hostRevokedNow, under any name of its machine. Every way it reaches this leader is a row
 * of revoked-reach.ts REVOKED_REACH, refused (a start, its relays, its journal held on it, its
 * streams) or still reaching with the reason (the leader's own aims at it). The cache is read again at boot, at each act here, on a revoke event and
 * every minute (leader-boot.ts), so a ban another process writes holds here within a minute.
 * After an allow the host's kept records come in as they are: its channel log was never acked,
 * so its next link sends it again, judged by the rules of then. Going back to a release older than the ban lifts it: that release
 * reads a revoked record as one never issued and issues it a fresh key (its mint knows no ban).
 *
 * Doors: pushDoors tells every host this issuer knows on its daemon link the new door list
 * (`POST /host-api/doors`, under this leader's standing; the host keeps it only from a standing
 * not below what it holds). Hosts linked over a dialed socket hear it as a `doors` frame instead
 * (host-door.ts pushDoorsToDialed); leader-boot.ts pushHostDoors does both.
 */
import { HOST_CREDENTIAL_PATH, HOST_DOORS_PATH, HOST_DOOR_CAP, cleanDoorUrls, doorKeyId } from './door-wire.js'
import { allowHostDoor, credentialDue, dropHostCredential, hostCredentialOf, hostCredentials, hostDoorRevoked, HostDoorRevoked, keepBannedAliases, mintHostCredential, revokedRecordsOf, revokeHostDoor } from './host-credentials.js'
import { requestOverStream, type HostCallAnswer } from './leader-links.js'
import { assertOutwardDoor, leaderPermitActive } from '../leader/switch/doors.js'
import { foundHostUnadopted, type FoundFlags } from '../hosts/found-hosts.js'
import { hostSwitchNow } from './switch.js'
import { anyHostRevoked, hostAliasesNow, hostRevokedNow, revokedAsIn, setRevokedHosts, stickyAliasesOf } from './revoked-hosts.js'
import type { Duplex } from 'node:stream'
import type { PermitPair } from './channel.js'

/** A host already checked is asked again at most this often (its doors unchanged). */
export const CHECK_EVERY_MS = 10 * 60_000
const CALL_TIMEOUT_MS = 30_000

export interface IssuerDeps {
  walnutId(): Promise<string>
  flagOn(): Promise<boolean>
  /** `session.host_door_urls`, read now. */
  doorUrls(): Promise<unknown>
  /** The machine id `hostKey`'s daemon said in its hello, or null. */
  machineIdOf(hostKey: string): string | null
  /** Is `hostKey` a host in this leader's config (absent: every host is)? Only those are issued. */
  configured?(hostKey: string): boolean
  openStream(hostKey: string, purpose: string): Promise<Duplex>
  standing(hostKey: string): PermitPair
  /** One standby batch now (null: no standby, nothing to wait for). */
  syncStandby(): Promise<unknown>
  now?: () => number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export type IssueOutcome = 'issued' | 'held' | 'skipped' | 'refused' | 'failed'

/** Does a host's last report name the door capability? */
export function reportDials(report: { capabilities?: unknown } | null | undefined): boolean {
  return Array.isArray(report?.capabilities) && (report!.capabilities as unknown[]).includes(HOST_DOOR_CAP)
}

/** The read-only question: what does the host hold? Not an act (nothing on the host changes). */
async function askCredential(d: IssuerDeps, hostKey: string, body: Record<string, unknown>): Promise<HostCallAnswer> {
  return requestOverStream(d.openStream, hostKey, HOST_CREDENTIAL_PATH, body, CALL_TIMEOUT_MS)
}

/** The write: the host keeps this credential. Behind the outward door (issueOnce). */
async function sendCredential(d: IssuerDeps, hostKey: string, body: Record<string, unknown>): Promise<HostCallAnswer> {
  return requestOverStream(d.openStream, hostKey, HOST_CREDENTIAL_PATH, body, CALL_TIMEOUT_MS)
}

const sameDoors = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((u, i) => u === b[i])

/** One check of `hostKey`, and an issue when one is due (the header). */
export async function issueOnce(d: IssuerDeps, hostKey: string, machineId: string, doors: readonly string[]): Promise<IssueOutcome> {
  const walnutId = await d.walnutId()
  if (d.configured && !d.configured(hostKey)) return 'skipped'
  // Revoked: nothing for it until someone allows it again (the header).
  if (await hostDoorRevoked(hostKey)) return 'refused'
  const rec = await hostCredentialOf(machineId)
  // One record per machine, bound to its host key: another key that reports the same machine is
  // refused (no rotation fight, no socket adopted under the wrong key), and says so.
  if (rec?.hostKey && rec.hostKey !== hostKey) {
    d.log('warn', 'host door: two hosts report one machine id; the credential stays with the first, the other is not issued', { host: hostKey, heldBy: rec.hostKey, machineId })
    return 'refused'
  }
  const held = await askCredential(d, hostKey, { check: true, walnutId, machineId })
  if (held.ok !== true) {
    d.log('warn', 'host door: the host did not say what credential it holds', { host: hostKey, error: String(held.error ?? 'refused') })
    return 'failed'
  }
  const due = credentialDue(rec, (d.now ?? Date.now)()) || held.holds !== true || !rec?.verifyKey || held.keyId !== doorKeyId(rec.verifyKey)
    || !sameDoors(held.doors, doors) || rec.walnutId !== walnutId
  if (!due) return 'held'
  // A configure of a host: only the machine that holds the write permission sends it.
  if (leaderPermitActive()) assertOutwardDoor('host-credential', `host-credential:${machineId}`)
  let minted: Awaited<ReturnType<typeof mintHostCredential>>
  try {
    minted = await mintHostCredential({ machineId, walnutId, hostKey, now: d.now?.() })
  } catch (err) {
    // Revoked between the check and the mint.
    if (err instanceof HostDoorRevoked) return 'refused'
    throw err
  }
  const { permitNumber, epoch } = d.standing(hostKey)
  const a = await sendCredential(d, hostKey, { walnutId, machineId, verifyKey: minted.verifyKey, doors: [...doors], permitNumber, epoch })
  if (a.ok !== true) {
    d.log('warn', 'host door: the host did not keep its credential; asked again at its next link', { host: hostKey, error: String(a.error ?? 'refused') })
    return 'failed'
  }
  await d.syncStandby()
  d.log('info', rec ? 'host door: the host\'s credential was rotated' : 'host door: the host was issued its credential', { host: hostKey, machineId, doors: doors.length })
  return 'issued'
}

export interface CredentialIssuer {
  /** A host's view changed (its link, its report): check it when due. */
  noteHost(hostKey: string, o: { connected: boolean; dials: boolean }): void
  /** The config may have changed: hosts are checked again at their next view. */
  refresh(): void
  /** Tell every known host on its daemon link, but `skip`, the door list `doors` (the header). */
  pushDoors(doors: readonly string[], skip?: ReadonlySet<string>): Promise<{ told: string[]; failed: string[] }>
  /** Tests: the check of `hostKey` in flight, if any. */
  idle(hostKey: string): Promise<IssueOutcome | null>
  stop(): void
}

export function startCredentialIssuer(d: IssuerDeps): CredentialIssuer {
  let stopped = false
  const inFlight = new Map<string, Promise<IssueOutcome>>()
  const checkedAt = new Map<string, { at: number; doors: string }>()
  /** Hosts on their daemon link that name the door capability, with their machine id. */
  const known = new Map<string, string>()
  return {
    noteHost(hostKey, o) {
      const machineId = o.connected && o.dials ? d.machineIdOf(hostKey) : null
      if (machineId) known.set(hostKey, machineId)
      else known.delete(hostKey)
      if (stopped || !machineId || inFlight.has(hostKey)) return
      const run = (async (): Promise<IssueOutcome> => {
        if (!(await d.flagOn().catch(() => false))) return 'skipped'
        const doors = cleanDoorUrls(await d.doorUrls().catch(() => []))
        if (doors.length === 0) return 'skipped'
        const key = doors.join('\n')
        const last = checkedAt.get(hostKey)
        const now = (d.now ?? Date.now)()
        if (last && last.doors === key && now - last.at < CHECK_EVERY_MS) return 'skipped'
        const out = await issueOnce(d, hostKey, machineId, doors)
        if (out !== 'failed') checkedAt.set(hostKey, { at: now, doors: key })
        return out
      })().catch((err: unknown): IssueOutcome => {
        d.log('warn', 'host door: issuing the host\'s credential failed; asked again at its next link', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
        return 'failed'
      }).finally(() => { inFlight.delete(hostKey) })
      inFlight.set(hostKey, run)
    },
    refresh() { checkedAt.clear() },
    async pushDoors(doors, skip) {
      const out = { told: [] as string[], failed: [] as string[] }
      const clean = cleanDoorUrls(doors)
      if (stopped || clean.length === 0 || !(await d.flagOn().catch(() => false))) return out
      const walnutId = await d.walnutId()
      await Promise.all([...known].filter(([k]) => !skip?.has(k) && (d.configured?.(k) ?? true)).map(async ([hostKey, machineId]) => {
        const { permitNumber, epoch } = d.standing(hostKey)
        const a = await requestOverStream(d.openStream, hostKey, HOST_DOORS_PATH, { walnutId, machineId, doors: clean, permitNumber, epoch }, CALL_TIMEOUT_MS)
          .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as HostCallAnswer)
        if (a.ok === true) out.told.push(hostKey)
        else { out.failed.push(hostKey); d.log('warn', 'host door: a host did not take the new door list', { host: hostKey, error: String(a.error ?? 'refused') }) }
      }))
      return out
    },
    idle: (hostKey) => inFlight.get(hostKey) ?? Promise.resolve(null),
    stop() { stopped = true },
  }
}

let syncStandbyNow: (() => Promise<unknown>) | null = null

/** Tests and the boot wiring: how a revoke takes its standby batch (null: none). */
export function setRevokeStandbySync(fn: (() => Promise<unknown>) | null): void {
  syncStandbyNow = fn
}

/**
 * Revoke `machineId`'s door credential: the record goes, its door sockets in this process close at
 * once (host-door.ts), and one standby batch runs before this resolves. True when there was one.
 *
 * For a host still in the config this is a rotation, not a ban: its key is dead at once, and the
 * next check of its link issues it a new one. To cut a host off, revoke it (revokeHostDoorNow,
 * below: nothing is issued to it until it is allowed again) or remove it from the config
 * (revokeHostsGone): either way the door lets it in no more.
 */
export async function revokeHostCredential(machineId: string): Promise<boolean> {
  const gone = await dropHostCredential(machineId)
  if (gone) {
    const sync = syncStandbyNow ?? (async () => (await import('../standby/runner.js')).standbyRunner()?.runOnce() ?? null)
    await sync()
  }
  return gone
}

/**
 * The hosts the user removed from this leader's config (or turned off) lose their door credential:
 * every record whose host key is not in `configured` is revoked (revokeHostCredential: its sockets
 * close at once, one standby batch). The machine ids revoked.
 */
export async function revokeHostsGone(configured: ReadonlySet<string>): Promise<string[]> {
  // A host revoked by hand keeps its mark (it holds no key): removing it is no allow.
  const gone = (await hostCredentials()).filter((r) => r.machineId && !r.revoked && (!r.hostKey || !configured.has(r.hostKey)))
  const out: string[] = []
  for (const r of gone) if (await revokeHostCredential(r.machineId!)) out.push(r.machineId!)
  return out
}

/**
 * The host keys of this leader's config a credential may be issued to: a host not turned off, and,
 * for a host found in ~/.ssh/config, only once the person said yes to it (found-hosts.ts
 * foundHostUnadopted, the rule the follower default and the host status use).
 */
export function configuredHostKeys(hosts: Record<string, ({ enabled?: boolean } & FoundFlags) | null | undefined> | undefined): Set<string> {
  return new Set(Object.entries(hosts ?? {}).filter(([, h]) => !!h && h.enabled !== false && !foundHostUnadopted(h)).map(([k]) => k))
}

/** What the leader's boot gives a revoke and an allow made from a route (null: no leader side runs). */
export interface DoorHostHooks {
  /** The machine id `hostKey`'s daemon link named, or null. */
  machineIdOf(hostKey: string): string | null
  /** Check `hostKey` again now (an allow: it is issued at once when its link is up). */
  recheck(hostKey: string): void
  /** `hostKey` was revoked or allowed: its session channel is cut now, or may link again (leader-side.ts noteRevoked). */
  cut?(hostKey: string): void
}
let hooks: DoorHostHooks | null = null

export function setDoorHostHooks(h: DoorHostHooks | null): void {
  hooks = h
}

export { hostRevokedNow } from './revoked-hosts.js'

/** Read the revoked hosts from the credential records again (at boot, at each act, a revoke event, a recheck): the hosts whose standing changed. */
export async function refreshRevokedHosts(): Promise<string[]> {
  const records = await hostCredentials()
  const revoked = revokedRecordsOf(records)
  // A ban holds for every alias of the machine: the twin snapshot (core/hosts/daemon-twins.ts) is read before it is judged.
  if (revoked.length > 0) await import('../hosts/daemon-twins.js').then((m) => m.daemonTwinsReady()).catch(() => { /* its key and machine id still hold */ })
  const changed = setRevokedHosts(revoked)
  // A machine token the companion did not delete at the revoke: again now, while its key is still banned.
  // The first read after a boot tries every banned name (a delete the companion already did answers
  // 404, counted as done), so a failure a restart forgot is never left valid there (R3-S2).
  if (!bridgeSwept && revoked.length > 0) {
    bridgeSwept = true
    for (const r of revoked) for (const k of await bannedNamesOf(r.hostKey)) bridgeRetry.add(k)
  }
  const retry = [...bridgeRetry].filter((k) => hostRevokedNow(k))
  bridgeRetry.clear()
  if (retry.length) void revokeBridge(retry).catch(() => { retry.forEach((k) => bridgeRetry.add(k)) })
  // A key judged an alias of a ban since it was made is written into the ban's record: a restart keeps it banned (S1).
  for (const r of revoked) {
    const more = stickyAliasesOf(r.hostKey).filter((k) => !(r.keys ?? []).includes(k))
    if (more.length > 0) await keepBannedAliases(r.hostKey, more).catch(() => { /* the next recheck writes it */ })
  }
  return changed
}

/**
 * Keep the revoked-host cache current: read now, on a revoke event in this process, and every
 * `everyMs` (a ban another process wrote holds here within it). `onChanged` gets the hosts whose
 * standing changed (leader-boot.ts cuts them). The returned function stops it; `recheck` reads now.
 */
export async function watchRevokedHosts(onChanged: (hostKeys: string[]) => void, everyMs: number, onError: (err: unknown) => void): Promise<{ stop(): void; recheck(): Promise<void> }> {
  const recheck = async (): Promise<void> => {
    let changed: string[]
    try { changed = await refreshRevokedHosts() } catch (err) { onError(err); return }
    // While any ban stands every link is judged again (an alias learned since: N2), not only on a change.
    if (changed.length > 0 || anyHostRevoked()) onChanged(changed)
  }
  await recheck()
  const timer = setInterval(() => { void recheck() }, everyMs)
  timer.unref?.()
  const unlisten = (await import('../device-auth.js')).onCredentialsRevoked(() => { void recheck() })
  return { recheck, stop: () => { clearInterval(timer); unlisten() } }
}

/** The standby batch an act takes, bounded: false when it did not finish in time (the answer says so). */
const STANDBY_SYNC_MS = 20_000
async function syncStandbyBounded(): Promise<boolean> {
  const sync = syncStandbyNow ?? (async () => (await import('../standby/runner.js')).standbyRunner()?.runOnce() ?? null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = await Promise.race([
    sync().then(() => true, () => false),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), STANDBY_SYNC_MS); timer.unref?.() }),
  ])
  if (timer) clearTimeout(timer)
  return done
}

/** The records changed: the cache first, then the leader side (a cut closes the host's channel now). */
async function noteDoorActed(hostKey: string): Promise<void> {
  await refreshRevokedHosts().catch(() => { /* the last read stands until the next */ })
  try { hooks?.cut?.(hostKey) } catch { /* the next view of the host does it */ }
  // A tunnel placed on a revoked host comes back here (core/expose/placement.ts reads the ban).
  void import('../../web/expose-runtime.js').then((m) => m.getExposeRuntime()?.reconcile()).catch(() => { /* its next check places it */ })
}

/** Did the tunnel run on `hostKey`'s machine (the revoke's answer says it comes back here)? */
async function tunnelRanOn(hostKey: string): Promise<boolean> {
  try {
    const on = (await import('../../web/expose-runtime.js')).getExposeRuntime()?.status().runsOn?.hostKey
    return !!on && (on === hostKey || hostAliasesNow(hostKey).aliases.includes(on))
  } catch { return false }
}

/**
 * Revoke `hostKey`'s door, a ban (host-credentials.ts revokeHostDoor): its key is dropped, its
 * door sockets close at once, its session channel is cut on every link (nothing it sends is
 * applied), and the issuer issues it nothing until allowHostDoorNow. `by` is who did it (a person,
 * or the task of the session that asked). What stays is the leader's daemon link of a host in its
 * config, as for any host whose service does not run its sessions: removing the host from the
 * config, or turning it off, ends that. `standbySynced`: false when the standby batch did not end
 * in time (a leader switch right after could still hold the old record there).
 */
export async function revokeHostDoorNow(hostKey: string, by: string): Promise<{ revoked: boolean; closed: number; standbySynced: boolean; skipped: string[]; tunnelBack: boolean; bridgeTokens: BridgeRevoke }> {
  // With the switch off nothing is issued anyway: only the records there are get the mark (no new one).
  const on = (await hostSwitchNow())(hostKey)
  // The aliases the ban names are read from the twin snapshot: read it first, even with no ban yet (R2-N1).
  await import('../hosts/daemon-twins.js').then((m) => m.daemonTwinsReady()).catch(() => { /* its key and links still name them */ })
  const out = await revokeHostDoor(hostKey, { by, machineId: on ? hooks?.machineIdOf(hostKey) ?? null : null })
  if (!out.revoked) return { revoked: false, closed: 0, standbySynced: true, skipped: out.skipped, tunnelBack: false, bridgeTokens: { revoked: [], failed: [] } }
  const tunnelBack = await tunnelRanOn(hostKey)
  await noteDoorActed(hostKey)
  const bridgeTokens = await revokeBridge(await bannedNamesOf(hostKey))
  return { revoked: true, closed: out.closed.length, standbySynced: await syncStandbyBounded(), skipped: out.skipped, tunnelBack, bridgeTokens }
}

type BridgeRevoke = { revoked: string[]; failed: string[] }
/** Keys whose companion machine token is still to be deleted (refreshRevokedHosts retries them). */
const bridgeRetry = new Set<string>()
/** The first ban read of this process tried every banned name's token (refreshRevokedHosts). */
let bridgeSwept = false
/** Tests: as after a boot. */
export function _resetBridgeSweepForTesting(): void { bridgeSwept = false; bridgeRetry.clear() }

/** Every name the ban on `hostKey` covers now: itself, its ban's key and the keys it named, its aliases. */
async function bannedNamesOf(hostKey: string): Promise<string[]> {
  const records = revokedRecordsOf(await hostCredentials())
  const as = revokedAsIn(records, hostKey)
  const named = records.filter((r) => r.hostKey === as).flatMap((r) => r.keys ?? [])
  return [...new Set([hostKey, ...(as ? [as] : []), ...named, ...hostAliasesNow(hostKey).aliases])]
}

/** Delete the companion's machine tokens of these names (cloud-bridge-config.ts revokeBridgeTokens); a failure is retried. */
async function revokeBridge(keys: readonly string[]): Promise<BridgeRevoke> {
  const out = await (await import('../../integrations/cloud-bridge-config.js')).revokeBridgeTokens(keys)
    .catch(() => ({ revoked: [] as string[], failed: [...keys] }))
  for (const k of out.failed) bridgeRetry.add(k)
  return out
}

/** Allow `hostKey` again after a revoke: it is checked now, so a host on its link is issued a fresh key at once. */
export async function allowHostDoorNow(hostKey: string, by: string): Promise<{ allowed: boolean; standbySynced: boolean }> {
  const was = await allowHostDoor(hostKey, { by })
  if (!was) return { allowed: false, standbySynced: true }
  await noteDoorActed(hostKey)
  const standbySynced = await syncStandbyBounded()
  // Every name of its machine: the allow lifted the machine's ban (host-credentials.ts hostRecordsIn).
  const names = [hostKey, ...hostAliasesNow(hostKey).aliases]
  for (const k of names) { try { if (k !== hostKey) hooks?.cut?.(k); hooks?.recheck(k) } catch { /* checked at its next view */ } }
  // The journal its link held while it was revoked (offline-handover.ts) drains now, not at the next copy.
  const daemons = await import('../../providers/daemon-connection.js')
  const secrets = await import('../secrets/fleet-secrets.js')
  for (const k of names) {
    // Its secrets were withheld while it was revoked (fleet-secrets.ts reconcileHost): brought in line now.
    void secrets.reconcileHost(k).catch(() => { /* its next connect reconciles */ })
    try {
      const link = daemons.getConnectedDaemonConnection(k)
      link?.drainJournalSoon()
      // And the copies it was refused (revoked-reach.ts `copy:` rows): its replica, skills, triggers and bridge.
      link?.pushCopiesAgain()
    } catch { /* the next connect drains and copies */ }
  }
  return { allowed: true, standbySynced }
}
