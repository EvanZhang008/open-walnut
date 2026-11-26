/**
 * What a session daemon in the home dir leaves in /tmp/open-walnut for a release from before its
 * files moved there (lib/daemon-dir.ts, 2026-11-26).
 *
 * Such a release knows the home dir only as the place of a daemon that RUNS (a pid file with a
 * live pid). When it sees none it starts its own daemon in /tmp/open-walnut: after a downgrade,
 * or when one of its servers starts beside a newer one. That daemon knew nothing of the sessions
 * the home daemon had started, yet shares their streams dir: it removed their stdin FIFOs (its
 * startup sweep) and then adopted their CLIs by pid, and those sessions never took a line again
 * (rehearsed against the published 0.6.37). Two things keep it the one daemon it always was:
 *
 *   - the home daemon also holds the instance lock of /tmp/open-walnut, with its own banner: an
 *     older daemon started there while this one runs gives way to it as to any daemon of that dir
 *     (and its server is handed this daemon's port), instead of running beside it on the same
 *     sessions;
 *   - `sessions.json` there is a symlink to the home daemon's registry: an older daemon started
 *     after this one stopped reads through it, adopts the sessions that still run as any
 *     restarted daemon does, and writes its own file over the link at its first change. The dir
 *     rule never counts a link as a daemon's file, so the link never moves a newer daemon back.
 *
 * Only for the account's own production daemon (by the passwd home: a daemon under a faked HOME,
 * a test's or a demo's, never touches the real shared dir), and only in a shared dir that is a
 * real directory of this user, which is also the only case an older release uses it: when it is
 * another user's, the older release goes to the home dir by itself. A login service's daemon is
 * found by its unit instead.
 *
 * Remove once no supported release starts its daemon in /tmp/open-walnut by default.
 */

/** Is this the daemon older releases must still find: the account's own, in its home dir, not a login service's. */
export function servesOlderReleases(io: {
  daemonDir: string
  /** The passwd entry's home, or null when there is none. */
  accountHome: string | null
  serviceMode: boolean
  platform: string
  resolve: (...parts: string[]) => string
}): boolean {
  if (io.serviceMode || io.platform === 'win32' || !io.accountHome) return false
  return io.resolve(io.daemonDir) === io.resolve(io.accountHome, '.cache', 'open-walnut')
}

interface DirStat { uid: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }

/**
 * True when the shared dir is a real directory of this user. One that is not there is made
 * (owner only) when `mayCreate`: a host no server runs on has none, and an older daemon would
 * make it itself. Never when another account's system unit runs its daemon there (the caller's
 * `mayCreate`): that service must find it free.
 */
export function ownSharedDir(io: {
  fs: { lstatSync(p: string): DirStat; mkdirSync(p: string, o: { mode: number }): unknown }
  sharedDir: string
  uid: number
  mayCreate: boolean
}): boolean {
  const ours = (): boolean => {
    const st = io.fs.lstatSync(io.sharedDir)
    return st.isDirectory() && st.uid === io.uid
  }
  try { return ours() } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT' || !io.mayCreate) return false
  }
  try { io.fs.mkdirSync(io.sharedDir, { mode: 0o700 }) } catch { /* made by someone else meanwhile: judged below */ }
  try { return ours() } catch { return false }
}

/**
 * Leaves `<sharedDir>/sessions.json` as a symlink to this daemon's registry. What is at the name
 * decides: nothing, or a link to somewhere else, gets the link; a real file is left alone unless
 * it is from before this machine booted (a registry of sessions that ended with the boot).
 * The caller has checked the dir (ownSharedDir). Returns what it did.
 */
export function linkRegistryForOlderReleases(io: {
  fs: {
    lstatSync(p: string): DirStat
    readlinkSync(p: string): string
    symlinkSync(target: string, p: string): void
    renameSync(from: string, to: string): void
    unlinkSync(p: string): void
  }
  sharedDir: string
  registryFile: string
  pid: number
  /** When this machine booted (ms), or null when it cannot be read: then a real file is never replaced. */
  bootMs: number | null
}): 'linked' | 'kept' | 'skipped' {
  const link = io.sharedDir + '/sessions.json'
  try {
    const st = io.fs.lstatSync(link)
    if (st.isSymbolicLink()) {
      if (io.fs.readlinkSync(link) === io.registryFile) return 'kept'
    } else if (!st.isFile() || io.bootMs === null || st.mtimeMs >= io.bootMs - 5_000) {
      return 'skipped'
    }
  } catch (err) { if ((err as { code?: string } | null)?.code !== 'ENOENT') return 'skipped' }
  // Made beside it and renamed over: the name is never missing, and never half a link.
  const next = `${link}.${io.pid}.link`
  try {
    try { io.fs.unlinkSync(next) } catch { /* none left from an earlier try */ }
    io.fs.symlinkSync(io.registryFile, next)
    io.fs.renameSync(next, link)
    return 'linked'
  } catch {
    try { io.fs.unlinkSync(next) } catch { /* never made */ }
    return 'skipped'
  }
}
