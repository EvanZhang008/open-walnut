/**
 * The words a gone working folder is reported in (folder-gone.ts), in a module of its own
 * so the server, the notification copy and the web build can read them without loading
 * the session machinery.
 *
 * Sources: the server's pre-flight (providers/cwd-check.ts: "Working directory no longer
 * exists[ on <host>]: <cwd>") and a daemon's own start check (both twins: "start: cwd does
 * not exist on this host (<host>): <cwd>"). "Working directory not set" is not a gone folder.
 */
export const FOLDER_GONE_RE = /working directory (no longer exists|not available)|cwd does not exist on this host/i

/** Whether an error or park reason says the session's folder is gone. */
export function isFolderGoneReason(text: unknown): boolean {
  return typeof text === 'string' && FOLDER_GONE_RE.test(text)
}
