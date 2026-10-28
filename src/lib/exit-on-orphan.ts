/**
 * OPEN_WALNUT_EXIT_ON_ORPHAN, set by the Mac app for the server it starts
 * (desktop/main.swift): when the app dies without stopping the server (a crash,
 * a force quit, a logout), the server must go too, or it holds the port with no
 * app to show it. The process is then handed to launchd (or a subreaper), so its
 * parent pid changes: `onOrphan` runs once when it does.
 *
 * The npm launcher (scripts/npm-launcher/launch.js) does the same for the file it
 * runs, since there the app's child is the launcher. Node's server once went by
 * accident (its first log line into the closed pipe crashed it); bun keeps
 * running, so the watch is explicit.
 */
export function watchForOrphan(
  onOrphan: () => void,
  opts: { env?: NodeJS.ProcessEnv; ppid?: () => number; everyMs?: number } = {},
): ReturnType<typeof setInterval> | null {
  const env = opts.env ?? process.env
  const ppid = opts.ppid ?? (() => process.ppid)
  if (env.OPEN_WALNUT_EXIT_ON_ORPHAN !== '1') return null
  const parent = ppid()
  // Already launchd's (or no parent to read): nothing to outlive.
  if (!(parent > 1)) return null
  const timer = setInterval(() => {
    if (ppid() === parent) return
    clearInterval(timer)
    onOrphan()
  }, opts.everyMs ?? 1000)
  timer.unref?.()
  return timer
}
