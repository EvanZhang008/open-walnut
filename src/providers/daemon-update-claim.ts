/**
 * One daemon update at a time per daemon, whichever of its host names starts it.
 *
 * Two host entries can reach one daemon (a machine on the host network and an SSH entry for
 * the same machine: `sameDaemonHosts`). Each entry's connection used to update that daemon on
 * its own after a deploy, the host network one by uploading this build over its link (35 to
 * 45 MB) and the SSH one by its own service update. 2026-11-22: the two raced on one machine
 * 99 + 195 times in a day; 4.66 GB went up for updates that then failed on the other's lock,
 * and each swap dropped both links.
 *
 * Every update path (daemon-update-paths.ts, a ratchet holds it) claims the update before its
 * first upload byte. A claim is kept under the name that took it; a name asking for one looks
 * for a claim under any name of its daemon (the pairing is symmetric: either side knows it). A
 * claim held by another name is "not now": that connection asks again later, and by then its
 * daemon runs the new build. A claim that ended well stays a short settle window, so a
 * connection whose hello still names the old build (its link not dialled again yet) does not
 * start the same update again.
 *
 * The names are asked for only while some other claim exists: reading them may read a profile
 * or resolve an SSH row, and the common case (nothing claimed) must cost no I/O on the update path.
 *
 * Turns (2026-11-24): a busy daemon refuses every plain swap, and the name whose try was refused
 * asks again in a minute or two. Its claim was kept for the settle window after each refusal and
 * the name took it again at its next try, so the other name of the same daemon read "updating it,
 * or just did" for hours (clouddev 68 times by 03:01Z while newdev's tries were all refused) and
 * its own overdue bound never counted for anything. Now only an update really under way (claimed,
 * not released, at most UPDATE_CLAIM_MAX_MS) holds the other names for sure. After a refusal the
 * settle window holds them only while they have deferred less than UPDATE_CLAIM_TURN_MS in a row,
 * and never a name whose update is overdue (daemon-update-behind.ts): then that name takes its turn.
 * So a name waits at most UPDATE_CLAIM_TURN_MS plus one try under way.
 *
 * Whose side said no (2026-11-24): a try that changed nothing ends 'held' only when the HOST refused
 * it (its daemon busy, a probation still watching, another runner there, launchd deferring): any
 * other name would meet the same refusal. A try that failed on this name's own way there (its SSH
 * login refused, its upload or staging failed, its artifact missing, its own cooldown) ends
 * 'own-path' and frees the claim at once, so another name of the daemon goes at its next try:
 * newdev's SSH login was refused at every try for hours, and each try held clouddev as "just refused".
 *
 * Claims live in this process's memory: a leader restart (every deploy) forgets them, and both
 * names may try once right after it. The turn count does not: it is a hold clock on disk
 * (acp-upgrade-hold.ts, as the overdue clock of daemon-update-behind.ts), so restarts every few
 * minutes no longer start a name's turn over and the turn bound holds across them.
 */
import { upgradeHoldClock, dropHoldClocks } from './acp-upgrade-hold.js'

/** A claim no path released (a server stopped in the middle) lets go after this long. */
export const UPDATE_CLAIM_MAX_MS = 15 * 60_000
/** After an update that went through: the other names wait this long for their links to see it. */
export const UPDATE_CLAIM_SETTLE_MS = 3 * 60_000
/** A name that deferred this long in a row to tries that were refused takes its own turn. */
export const UPDATE_CLAIM_TURN_MS = 15 * 60_000

/** 'running': under way; 'settled': went through (or may still run there); 'held': refused by the host before it changed anything. */
type ClaimState = 'running' | 'settled' | 'held'
interface Claim { by: string; until: number; state: ClaimState }

const claims = new Map<string, Claim>()

/**
 * Since when each name has deferred to another name's claim, in a row (a row ends when it claims,
 * or after a quiet UPDATE_CLAIM_MAX_MS): a hold clock on disk, so it survives a leader restart.
 */
const TURN_PREFIX = 'update-turn:'
const turnKey = (host: string) => `${TURN_PREFIX}${host}`
/** Touch `host`'s row; true while it has deferred less than UPDATE_CLAIM_TURN_MS. */
const turnHolds = (host: string, now: number) => upgradeHoldClock(turnKey(host), true, UPDATE_CLAIM_TURN_MS, now, UPDATE_CLAIM_MAX_MS).holds
/** End `host`'s row (no write when it has none). */
const endTurn = (host: string, now: number) => { upgradeHoldClock(turnKey(host), false, UPDATE_CLAIM_TURN_MS, now) }

/**
 * A try that changed nothing on the host, and this name asks again later, by whose side said no
 * (module doc): 'held' the host refused it, so the claim holds the other names within their turn;
 * 'own-path' this name's own way there failed, so the claim is freed at once.
 */
export type NothingChanged = 'held' | 'own-path'

/** How a claim ends: true went through (or may still run), a NothingChanged, or false failed (frees it, as 'own-path'). */
export type ClaimEnd = boolean | NothingChanged

/** Options of the ask: `overdue`, this name's update is past its bound and a refused try of another name no longer holds it. */
export interface ClaimAsk { overdue?: boolean }

export interface UpdateClaim {
  /**
   * true: the update went through; 'held': the host refused it before it changed anything and this
   * name asks again (2026-11-23: newdev's update refused for a busy daemon freed the claim, and
   * clouddev started a second upload of the same build); the settle window holds the others. A
   * failure, or a try that failed on this name's own way there ('own-path'), frees them at once.
   */
  release(end: ClaimEnd): void
}

/** Every host name of the daemon, asked only when some other claim exists. */
export type DaemonNames = () => Promise<readonly string[]>

function prune(now: number): void {
  for (const [name, c] of claims) if (c.until <= now) claims.delete(name)
}

function othersClaimed(host: string): boolean {
  for (const name of claims.keys()) if (name !== host) return true
  return false
}

/** The other name whose claim holds `host` now, or null; a refused try's holds only within the turn bound (module doc). */
function holder(host: string, names: readonly string[], ask: ClaimAsk, now: number): string | null {
  for (const name of names) {
    const c = name === host ? undefined : claims.get(name)
    if (!c) continue
    const within = turnHolds(host, now)
    if (c.state === 'held' && (ask.overdue || !within)) continue
    return c.by
  }
  return null
}

/** The other name holding the update of the daemon `host` reaches, or null. */
export async function daemonUpdateHeldBy(host: string, names: DaemonNames, now = Date.now(), ask: ClaimAsk = {}): Promise<string | null> {
  prune(now)
  if (!othersClaimed(host)) { endTurn(host, now); return null }
  // A name whose turn came keeps its count until it claims: the claim right after asks the same.
  return holder(host, await names().catch(() => [host]), ask, now)
}

/** Claim the update of the daemon `host` reaches. Returns the claim, or the name holding it now. */
export async function claimDaemonUpdate(host: string, names: DaemonNames, now = Date.now(), ask: ClaimAsk = {}): Promise<UpdateClaim | { heldBy: string }> {
  prune(now)
  if (othersClaimed(host)) {
    const asked = Date.now()
    const all = await names().catch(() => [host])
    // Asked again after the await (on the caller's clock): another name may have claimed meanwhile.
    const at = now + (Date.now() - asked)
    prune(at)
    const heldBy = holder(host, all, ask, at)
    if (heldBy) return { heldBy }
  }
  endTurn(host, now)
  const claim: Claim = { by: host, until: now + UPDATE_CLAIM_MAX_MS, state: 'running' }
  claims.set(host, claim)
  let done = false
  return {
    release(end: ClaimEnd) {
      if (done) return
      done = true
      if (claims.get(host) !== claim) return
      if (!end || end === 'own-path') { claims.delete(host); return }
      claim.state = end === 'held' ? 'held' : 'settled'
      claim.until = Math.min(claim.until, Date.now() + UPDATE_CLAIM_SETTLE_MS)
    },
  }
}

/** The one wording for "not now" when another name of this daemon holds its update, by what that claim is now. */
export function peerUpdatingWhy(heldBy: string): string {
  const state = claims.get(heldBy)?.state
  if (state === 'running') return `${heldBy} reaches the same daemon and is updating it now`
  if (state === 'held') return `${heldBy} reaches the same daemon and its update there was just refused; this name takes its turn within ${Math.round(UPDATE_CLAIM_TURN_MS / 60_000)} min`
  return `${heldBy} reaches the same daemon and is updating it, or just did`
}

/** Tests only. `restart`: forget the claims as a leader restart does, and keep the turns on disk. */
export function resetDaemonUpdateClaims(opts: { restart?: boolean } = {}): void {
  claims.clear()
  if (!opts.restart) dropHoldClocks(TURN_PREFIX, '')
}
