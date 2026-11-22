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
 * Doors: pushDoors tells every host this issuer knows on its daemon link the new door list
 * (`POST /host-api/doors`, under this leader's standing; the host keeps it only from a standing
 * not below what it holds). Hosts linked over a dialed socket hear it as a `doors` frame instead
 * (host-door.ts pushDoorsToDialed); leader-boot.ts pushHostDoors does both.
 */
import { HOST_CREDENTIAL_PATH, HOST_DOORS_PATH, HOST_DOOR_CAP, cleanDoorUrls } from './door-wire.js'
import { credentialDue, dropHostCredential, hostCredentialOf, mintHostCredential } from './host-credentials.js'
import { requestOverStream, type HostCallAnswer } from './leader-links.js'
import { assertOutwardDoor, leaderPermitActive } from '../leader/switch/doors.js'
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
  openStream(hostKey: string, purpose: string): Promise<Duplex>
  standing(hostKey: string): PermitPair
  /** One standby batch now (null: no standby, nothing to wait for). */
  syncStandby(): Promise<unknown>
  now?: () => number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export type IssueOutcome = 'issued' | 'held' | 'skipped' | 'failed'

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
  const rec = await hostCredentialOf(machineId)
  const held = await askCredential(d, hostKey, { check: true, walnutId, machineId })
  if (held.ok !== true) {
    d.log('warn', 'host door: the host did not say what credential it holds', { host: hostKey, error: String(held.error ?? 'refused') })
    return 'failed'
  }
  const due = credentialDue(rec, (d.now ?? Date.now)()) || held.holds !== true || held.tokenHash !== rec?.tokenHash
    || !sameDoors(held.doors, doors) || rec?.hostKey !== hostKey || rec?.walnutId !== walnutId
  if (!due) return 'held'
  // A configure of a host: only the machine that holds the write permission sends it.
  if (leaderPermitActive()) assertOutwardDoor('host-credential', `host-credential:${machineId}`)
  const minted = await mintHostCredential({ machineId, walnutId, hostKey, now: d.now?.() })
  const { permitNumber, epoch } = d.standing(hostKey)
  const a = await sendCredential(d, hostKey, { walnutId, machineId, token: minted.token, verifyKey: minted.verifyKey, doors: [...doors], permitNumber, epoch })
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
      await Promise.all([...known].filter(([k]) => !skip?.has(k)).map(async ([hostKey, machineId]) => {
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
 * Revoke `machineId`'s door credential: the record goes (its hashes tombstoned), its live door
 * sockets in this process close at once (host-door.ts), and one standby batch runs before this
 * resolves. True when there was one.
 */
export async function revokeHostCredential(machineId: string): Promise<boolean> {
  const gone = await dropHostCredential(machineId)
  if (gone) {
    const sync = syncStandbyNow ?? (async () => (await import('../standby/runner.js')).standbyRunner()?.runOnce() ?? null)
    await sync()
  }
  return gone
}
