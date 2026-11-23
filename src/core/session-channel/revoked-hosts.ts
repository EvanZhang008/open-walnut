/**
 * The hosts whose door is revoked now (leader-issue.ts revokeHostDoorNow keeps the ban with the
 * credential records; refreshRevokedHosts reads it into here). A sync read, zero imports, for every
 * path that would use a host: its session channel (leader-side.ts), a start aimed at it, on either
 * path (claude-code-session.ts assertStartRouting), its sessions' relayed calls
 * (peers/capability-router.ts) and its journal (offline-merge, held until it is allowed). Only the
 * leader fills it; elsewhere nothing is revoked.
 */

let revoked: ReadonlySet<string> = new Set()

/** Is `hostKey` revoked here? */
export function hostRevokedNow(hostKey: string | undefined | null): boolean {
  return !!hostKey && revoked.has(hostKey)
}

/** The hosts revoked now (the records' last read); the hosts whose standing changed. */
export function setRevokedHosts(hosts: Iterable<string>): string[] {
  const next = new Set(hosts)
  const changed = [...next].filter((h) => !revoked.has(h)).concat([...revoked].filter((h) => !next.has(h)))
  revoked = next
  return changed
}

/** What a start, a call or a drain of a revoked host answers. */
export class HostRevokedError extends Error {
  readonly why = 'host_revoked'
  readonly status = 403
  constructor(readonly hostKey: string, what: string) {
    super(`${what}: the host ${hostKey} is revoked. Allow it again (POST /api/host-doors/${hostKey}/allow) or use another host.`)
  }
}

/** Throw HostRevokedError when `hostKey` is revoked. */
export function assertHostNotRevoked(hostKey: string | undefined | null, what: string): void {
  if (hostKey && revoked.has(hostKey)) throw new HostRevokedError(hostKey, what)
}
