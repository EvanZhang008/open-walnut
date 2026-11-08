/**
 * A daemon's `status` or `getState` reply read as the liveness of a session's CLI.
 *
 * Only an answer counts: `true` when the daemon holds the session and its process runs,
 * `false` when it says it does not, and `null` for an error reply. A daemon that is shutting
 * down answers every command with an error (`Daemon is shutting down; retry after
 * reconnecting`, daemon-command-drain.ts), and a reader that took that `ok: false` for
 * `alive: false` wrote a live CLI `stopped` (2026-11-08: a deploy's daemon restart did, the
 * next daemon adopted the CLI mid-turn, and a move then trusted the record). An error reply
 * is no answer: the caller keeps what it knew. Every error, not only the drain's: a daemon
 * reports a death as `ok: true` (`exists: false`, or `alive: false` after its reap), and its
 * only error replies are a malformed command and an internal failure, neither of which says
 * anything about the process (cmdStatus in both daemon twins). A death still reaches the
 * server through the daemon's exit event and the health monitor's own checks.
 * tests/providers/daemon-status-reply-guard.test.ts
 * lists every reader.
 */
export function statusReplyAlive(reply: { ok?: unknown; exists?: unknown; alive?: unknown } | null | undefined): boolean | null {
  if (!reply || reply.ok !== true) return null
  return reply.exists !== false && reply.alive === true
}
