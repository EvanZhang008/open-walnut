/**
 * The hosts whose running service takes a resume of a session the leader ran until now (switch.ts
 * SESSION_RESUME_CAP), as their last reports say (leader-boot.ts look). A module of its own and
 * sync, so every delivery asks it before any row read (providers/host-resume.ts resumeHostOf).
 */
const resumers = new Set<string>()

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
}

/** Tests: say whether `host`'s service takes a resume, as its report would. */
export function _setHostResumesForTesting(host: string, on: boolean): void {
  noteHostResumes(host, on)
}
