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
 */

/** A claim no path released (a server stopped in the middle) lets go after this long. */
export const UPDATE_CLAIM_MAX_MS = 15 * 60_000
/** After an update that went through: the other names wait this long for their links to see it. */
export const UPDATE_CLAIM_SETTLE_MS = 3 * 60_000

interface Claim { by: string; until: number }

const claims = new Map<string, Claim>()

export interface UpdateClaim {
  /**
   * `kept`: the update went through, or was refused on the host before it changed anything and this
   * name asks again (2026-11-23: newdev's update refused for a busy daemon freed the claim, and
   * clouddev started a second upload of the same build); the settle window holds the others. A
   * failure frees them at once.
   */
  release(kept: boolean): void
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

function holder(host: string, names: readonly string[]): string | null {
  for (const name of names) {
    const c = name === host ? undefined : claims.get(name)
    if (c) return c.by
  }
  return null
}

/** The other name holding the update of the daemon `host` reaches, or null. */
export async function daemonUpdateHeldBy(host: string, names: DaemonNames, now = Date.now()): Promise<string | null> {
  prune(now)
  if (!othersClaimed(host)) return null
  return holder(host, await names().catch(() => [host]))
}

/** Claim the update of the daemon `host` reaches. Returns the claim, or the name holding it now. */
export async function claimDaemonUpdate(host: string, names: DaemonNames, now = Date.now()): Promise<UpdateClaim | { heldBy: string }> {
  prune(now)
  if (othersClaimed(host)) {
    const asked = Date.now()
    const all = await names().catch(() => [host])
    // Asked again after the await (on the caller's clock): another name may have claimed meanwhile.
    prune(now + (Date.now() - asked))
    const heldBy = holder(host, all)
    if (heldBy) return { heldBy }
  }
  const claim: Claim = { by: host, until: now + UPDATE_CLAIM_MAX_MS }
  claims.set(host, claim)
  let done = false
  return {
    release(kept: boolean) {
      if (done) return
      done = true
      if (claims.get(host) !== claim) return
      if (kept) claim.until = Math.min(claim.until, Date.now() + UPDATE_CLAIM_SETTLE_MS)
      else claims.delete(host)
    },
  }
}

/** The one wording for "not now" when another name of this daemon holds its update. */
export function peerUpdatingWhy(heldBy: string): string {
  return `${heldBy} reaches the same daemon and is updating it, or just did`
}

/** Tests only. */
export function resetDaemonUpdateClaims(): void {
  claims.clear()
}
