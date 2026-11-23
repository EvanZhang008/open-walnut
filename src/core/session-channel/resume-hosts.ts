/**
 * What a delivery to a legacy session asks, sync, before it may hand the session to its host
 * (providers/host-resume.ts resumeHostOf): is the switch on for that host (leader-side.ts switchOn,
 * and for any host at all, leader-boot.ts), and does its running service take a resume (switch.ts
 * SESSION_RESUME_CAP, as its last report says: leader-boot.ts look). A module of its own and sync,
 * so a delivery with the switch off for every host reads no row.
 */
const resumers = new Set<string>()
let switchAny = false
let switchFor: ((host: string) => boolean) | null = null

/** Is the switch on for any host now (leader-boot.ts, at boot and every config write)? */
export function noteSwitchAnyHost(on: boolean): void {
  switchAny = on
}

/** The leader side's per-host switch (leader-side.ts switchOn); null when no leader side runs. */
export function setHostSwitchProbe(probe: ((host: string) => boolean) | null): void {
  switchFor = probe
}

/** Is the switch on for some host? False: no delivery reads a row to ask more. */
export function anyHostSwitchOn(): boolean {
  return switchAny && switchFor !== null
}

/** Is the switch on for `host` (a new start there would go to its service, given it judges)? */
export function hostSwitchOnFor(host: string): boolean {
  if (!anyHostSwitchOn()) return false
  try { return switchFor!(host) } catch { return false }
}

/** Does `host`'s service take a resume (its last report names SESSION_RESUME_CAP)? */
export function hostResumesSessions(host: string): boolean {
  return resumers.has(host)
}

/** Does any host's service take one now? False: no delivery looks further. */
export function anyHostResumesSessions(): boolean {
  return resumers.size > 0
}

/** A host's report said (or stopped saying) that it takes a resume. */
export function noteHostResumes(host: string, on: boolean): void {
  if (on) resumers.add(host)
  else resumers.delete(host)
}

/** The leader side stopped: no host is asked to resume anything. */
export function forgetHostResumes(): void {
  resumers.clear()
  switchAny = false
  switchFor = null
}

/** Tests: say whether `host`'s service takes a resume, as its report would. */
export function _setHostResumesForTesting(host: string, on: boolean): void {
  noteHostResumes(host, on)
}

/** Tests: the switch on for the hosts `forHost` says (null: off for every host). */
export function _setHostSwitchForTesting(forHost: ((host: string) => boolean) | null): void {
  switchFor = forHost
  switchAny = forHost !== null
}
