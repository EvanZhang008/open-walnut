/**
 * OPEN_WALNUT_EXIT_ON_ORPHAN, set by the Mac app for the server it starts
 * (desktop/main.swift): when the app dies without stopping the server (a crash,
 * a force quit, a logout), the server must go too, or it holds the port with no
 * app to show it. The process is then handed to launchd (or a subreaper), so its
 * parent pid changes.
 *
 * The npm launcher (scripts/npm-launcher/launch.js) does the same for the file it
 * runs, since there the app's child is the launcher. Node's server once went by
 * accident (its first log line into the closed pipe crashed it); bun keeps
 * running, so the watch is explicit.
 */

/**
 * Read the request once, first thing, and remove it from `env`: it says how THIS
 * process was started, and every child built from process.env (the daemon,
 * sessions, the in-app terminal) would carry it, so a `walnut web` started from
 * one of them would stop when its own starter exits. Returns the parent pid to
 * watch (read now, so an app that dies during startup is not missed), or null.
 */
export function takeExitOnOrphanRequest(env: NodeJS.ProcessEnv = process.env, ppid: () => number = () => process.ppid): number | null {
  if (env.OPEN_WALNUT_EXIT_ON_ORPHAN !== '1') return null
  delete env.OPEN_WALNUT_EXIT_ON_ORPHAN
  return ppid()
}

/**
 * Run `onOrphan` once the parent is gone: at once when it already went (or the
 * process was launchd's at the first look, which the Mac app never asks for),
 * else when the parent pid next changes. Returns the timer, or null.
 */
export function watchForOrphan(
  parent: number | null,
  onOrphan: () => void,
  opts: { ppid?: () => number; everyMs?: number } = {},
): ReturnType<typeof setInterval> | null {
  if (parent === null) return null
  const ppid = opts.ppid ?? (() => process.ppid)
  if (!(parent > 1) || ppid() !== parent) {
    onOrphan()
    return null
  }
  const timer = setInterval(() => {
    if (ppid() === parent) return
    clearInterval(timer)
    onOrphan()
  }, opts.everyMs ?? 1000)
  timer.unref?.()
  return timer
}
